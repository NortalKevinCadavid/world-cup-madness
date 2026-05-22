# Contract: `GET /api/admin/audit/export` — CSV streaming export

**Feature**: 007-audit-trail
**Date**: 2026-05-17
**Status**: Contract (locked)
**Vendor-neutral**: HTTP capability term (Next.js Route Handler is the shipping form).

## Purpose

Admin-only CSV export of `audit_log` rows. Built on top of `audit_search` RPC paging. Streams the response (no full in-memory buffering) so very large exports do not OOM the Edge runtime.

## Route signature

| Property | Value |
|---|---|
| Method | `GET` |
| Path | `/api/admin/audit/export` |
| Auth | Supabase session cookie (required, must resolve to admin) |
| Runtime | Node.js (NOT Edge) — uses `ReadableStream` + `pipe`; Edge has memory limits unsuitable for large exports |
| Response content-type | `text/csv; charset=utf-8` |
| Response content-disposition | `attachment; filename="audit-export-YYYYMMDD-HHmmss.csv"` |

## Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `actor` | uuid | — | optional, maps to `audit_search.p_actor` |
| `entity_type` | string | — | optional |
| `entity_id` | uuid | — | optional |
| `action_pattern` | string | — | optional, must contain `%` or be a literal label |
| `source` | string | — | optional, must be in canonical 7-value list |
| `from` | ISO timestamp | — | optional |
| `to` | ISO timestamp | — | optional |
| `max_rows` | int | 100000 | hard ceiling; raise 422 if `> 1_000_000` |

At least ONE of `from`, `to`, `actor`, `entity_id`, `action_pattern` MUST be provided (mirrors `WAT03`'s spirit — refuse unbounded exports).

## Authorization flow

```ts
// apps/web/app/api/admin/audit/export/route.ts (sketch)
export async function GET(req: NextRequest) {
  const supabase = createServerClient(...);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const isAdmin = await supabase.rpc('is_admin', { p_user: user.id });
  if (!isAdmin.data) {
    // Audit the denial through the existing narrow INSERT policy path:
    await supabase.from('audit_log').insert({
      actor: user.id,
      action: 'admin.access_denied',
      entity_type: 'audit_export',
      source: 'api_guard',
      new_value: { route: '/api/admin/audit/export', params: searchParamsObject },
    });
    return new Response('Forbidden', { status: 403 });
  }
  // ... validate params, then stream
}
```

## Streaming behavior

The route does **not** load all rows into memory. It pages through `audit_search` with `p_limit=1000`, writes each row immediately to the response stream, and continues until either:
- `max_rows` reached → stream a final line `# truncated at <max_rows> rows` then close.
- Fewer than `p_limit` rows returned → close stream.
- Server-side abort (client disconnect) → break loop.

### Pseudo-code

```ts
const stream = new ReadableStream({
  async start(controller) {
    controller.enqueue(encoder.encode(CSV_HEADER + '\n'));
    let offset = 0;
    const limit = 1000;
    while (offset < maxRows) {
      const { data, error } = await supabase.rpc('audit_search', {
        ...filters,
        p_limit: Math.min(limit, maxRows - offset),
        p_offset: offset,
      });
      if (error) {
        controller.error(error);
        return;
      }
      if (!data || data.length === 0) break;
      for (const row of data) {
        controller.enqueue(encoder.encode(toCsvLine(row) + '\n'));
      }
      offset += data.length;
      if (data.length < limit) break;
    }
    controller.close();
  },
});
return new Response(stream, {
  headers: {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  },
});
```

## CSV column order (LOCKED)

```
sequence_id,occurred_at,actor,action,entity_type,entity_id,source,reason,source_citation,previous_value,new_value,id
```

Rationale:
- `sequence_id` first — canonical ordering key per R-002.
- `occurred_at` second — primary human-readable timestamp.
- `id` last — useful for joins but not for human scanning.
- `previous_value` and `new_value` are JSON-serialized into single CSV cells (RFC 4180 double-quote escaping); consumers parse them back via JSON.parse.

## Audit posture

The route writes ONE audit row per request lifecycle:
- On 200 success after stream close: `admin.audit_export` with `new_value` = `{ filters: {...}, rows_exported: N, truncated: <bool> }` (written AFTER stream completion to avoid blocking the stream open).
- On 403: `admin.access_denied` (shown above).
- On 422 (validation failure): no audit row — purely client error, no security signal.

`admin.audit_export` is a NEW action label introduced by this slice. Add to the catalog under prefix `admin.*`.

## Performance contract

- Throughput: ≥ 5000 rows/second sustained (paging at 1000/batch, single network round-trip per page).
- Memory: O(1) — single batch in memory at a time.
- Max stream duration: bounded by client patience; route does not set a server-side timeout. Vercel platform timeout (300s for streaming routes on the appropriate plan) is the operational backstop.

## Error responses

| Status | Reason | Body |
|---|---|---|
| 401 | Not authenticated | `"Unauthorized"` |
| 403 | Not admin | `"Forbidden"` |
| 422 | Validation failure (no filters / max_rows out of range / bad pattern) | JSON `{ "error": "<reason>" }` |
| 500 | DB error mid-stream | terminated stream + audit row `admin.audit_export.failed` |

## Cross-slice contract

- Calls: `audit_search` RPC (this slice's locked signature).
- Authorization via: `is_admin(uuid)` (Slice 006's locked predicate body).
- Writes: `admin.audit_export` audit row on success; `admin.access_denied` on 403.
- Action label `admin.audit_export` is FROZEN at this slice — Slice 008 must not rename.

## Open ops items deferred to Slice 008

- Rate-limiting per admin (currently relies on Vercel platform throttle).
- Notification on large exports (e.g., > 100k rows) to ops channel — deferred to webhook integration in Slice 008.
