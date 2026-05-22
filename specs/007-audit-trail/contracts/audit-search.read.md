# Contract: `audit_search` + `count_audit_search` RPCs

**Feature**: 007-audit-trail
**Date**: 2026-05-17
**Status**: Contract (locked)
**Vendor-neutral**: Postgres SECURITY DEFINER pattern (final shipping target).

## Purpose

Single admin-only read path into `audit_log`. The Next.js admin UI calls these via the Supabase RPC interface; the CSV export route also calls `audit_search` repeatedly with paging.

## Signatures (LOCKED)

```sql
CREATE OR REPLACE FUNCTION public.audit_search(
  p_actor          uuid        DEFAULT NULL,
  p_entity_type    text        DEFAULT NULL,
  p_entity_id      uuid        DEFAULT NULL,
  p_action_pattern text        DEFAULT NULL,   -- LIKE pattern, e.g. 'admin.%'
  p_source         text        DEFAULT NULL,
  p_from           timestamptz DEFAULT NULL,
  p_to             timestamptz DEFAULT NULL,
  p_limit          int         DEFAULT 50,
  p_offset         int         DEFAULT 0
)
RETURNS TABLE (
  id              uuid,
  sequence_id     bigint,
  actor           uuid,
  action          text,
  entity_type     text,
  entity_id       uuid,
  previous_value  jsonb,
  new_value       jsonb,
  reason          text,
  source_citation text,
  source          text,
  occurred_at     timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public;

CREATE OR REPLACE FUNCTION public.count_audit_search(
  p_actor          uuid        DEFAULT NULL,
  p_entity_type    text        DEFAULT NULL,
  p_entity_id      uuid        DEFAULT NULL,
  p_action_pattern text        DEFAULT NULL,
  p_source         text        DEFAULT NULL,
  p_from           timestamptz DEFAULT NULL,
  p_to             timestamptz DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public;
```

Both signatures are LOCKED. Future slices must not reorder, rename, or change parameter types.

## Behavior

### Authorization

Both RPC bodies open with:
```sql
IF NOT public.is_admin(auth.uid()) THEN
  -- Write an admin.access_denied audit row first (use Slice 006's narrow INSERT policy path).
  INSERT INTO public.audit_log (actor, action, entity_type, source, new_value)
  VALUES (
    auth.uid(),
    'admin.access_denied',
    'audit_search',
    'api_guard',
    jsonb_build_object(
      'rpc', 'audit_search',
      'params', jsonb_build_object(
        'actor', p_actor, 'entity_type', p_entity_type, 'entity_id', p_entity_id,
        'action_pattern', p_action_pattern, 'source', p_source,
        'from', p_from, 'to', p_to, 'limit', p_limit, 'offset', p_offset
      )
    )
  );
  RAISE EXCEPTION 'Admin role required to read audit log'
    USING ERRCODE = 'WAT01';
END IF;
```

### Input validation

| Condition | Behavior |
|---|---|
| `p_limit` < 1 or > 500 | RAISE `WAT02` (`Invalid limit; must be 1..500`) |
| `p_offset` < 0 | RAISE `WAT02` |
| `p_from` > `p_to` (both non-NULL) | RAISE `WAT02` (`Invalid date range`) |
| `p_action_pattern` length > 200 | RAISE `WAT02` |
| `p_source` not in canonical 7-value list | RAISE `WAT02` |
| `count_audit_search` with no filters AND total rows > 100k | RAISE `WAT03` (`Unbounded count refused; narrow filters`) |

The intent of `WAT03`: prevent a casual admin from running an unbounded `count(*)` against a multi-million-row audit table. The UI MUST send at least one filter (date range or action pattern) to enable the row-count display.

### Filter composition

The body builds a parameterized predicate from the non-NULL parameters:

```sql
RETURN QUERY
SELECT
  a.id, a.sequence_id, a.actor, a.action, a.entity_type, a.entity_id,
  a.previous_value, a.new_value, a.reason, a.source_citation, a.source, a.occurred_at
FROM public.audit_log a
WHERE (p_actor          IS NULL OR a.actor = p_actor)
  AND (p_entity_type    IS NULL OR a.entity_type = p_entity_type)
  AND (p_entity_id      IS NULL OR a.entity_id = p_entity_id)
  AND (p_action_pattern IS NULL OR a.action LIKE p_action_pattern)
  AND (p_source         IS NULL OR a.source = p_source)
  AND (p_from           IS NULL OR a.occurred_at >= p_from)
  AND (p_to             IS NULL OR a.occurred_at < p_to)
ORDER BY a.sequence_id ASC
LIMIT p_limit
OFFSET p_offset;
```

`ORDER BY sequence_id ASC` is the canonical history-replay order (R-002).

### Privilege model

- `SECURITY DEFINER` — runs as table owner, bypasses RLS.
- `STABLE` — read-only within transaction; safe in `SELECT`.
- `SET search_path = public` — prevent schema-resolution attacks.
- `GRANT EXECUTE ON FUNCTION public.audit_search(...) TO authenticated;`
- `GRANT EXECUTE ON FUNCTION public.count_audit_search(...) TO authenticated;`
- (NOT granted to `anon`.)

Even though `authenticated` can call, the body's `is_admin` check makes it effectively admin-only.

## ERRCODE namespace (LOCKED)

| Code | Meaning |
|---|---|
| `WAT01` | Caller is not admin |
| `WAT02` | Invalid input (limit/offset/range/source/pattern length) |
| `WAT03` | Refusing unbounded count without filters |

## Audit posture for the RPCs themselves

The RPCs are READ-only on the audit table — they do NOT write audit rows for successful reads (that would be infinite recursion: every read of the audit log writes an audit row, which causes another row, etc.).

They DO write `admin.access_denied` rows on authorization failures only.

The Next.js route handler invoking `audit_search` MAY write a single coarser-grained `admin.audit_read` row at the API-layer for usage telemetry, but that is OPTIONAL and OUT OF SCOPE for this slice; deferred to ops decision.

## Performance contract

- Median query latency ≤ 500 ms for queries with at least one filter, ≤ 50k matching rows (NFR-Performance-Read).
- Worst-case latency ≤ 5 s for full-range queries with `LIMIT 500`, ≤ 1M rows total.
- The indexes (`audit_log_actor_occurred_idx`, `audit_log_target_idx`, `audit_log_action_occurred_idx`, `audit_log_source_occurred_idx`) cover all single-filter cases.

## Client usage (Next.js admin UI)

```ts
// apps/web/lib/audit-search.ts (simplified)
const { data, error } = await supabase.rpc('audit_search', {
  p_action_pattern: 'admin.%',
  p_from: from.toISOString(),
  p_to: to.toISOString(),
  p_limit: pageSize,
  p_offset: page * pageSize,
});
if (error) {
  if (error.code === 'WAT01') router.push('/admin/access-denied');
  else if (error.code === 'WAT02') showFormError(error.message);
  else if (error.code === 'WAT03') showHint('Narrow the date range to see counts.');
  else throw error;
}
```

## Cross-slice contract

- Reads from: `public.audit_log` (this slice's tamper-resistant final shape).
- Calls: `is_admin(uuid)` (Slice 006's locked predicate body).
- Called by:
  - Slice 007 admin UI `/admin/audit/search` (this slice).
  - Slice 007 CSV export route `/api/admin/audit/export` (this slice).
  - Slice 006 admin UI `/admin/audit` (incidental override-history view; existing call site).
- Locked after this slice ships. Slice 008 must not change signature.
