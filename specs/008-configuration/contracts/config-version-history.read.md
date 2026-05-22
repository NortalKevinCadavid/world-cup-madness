# Contract: `config_version_history` + `admin_config_export` read paths

**Feature**: 008-configuration
**Date**: 2026-05-17
**Status**: Contract (locked)
**Vendor-neutral**: Postgres SECURITY DEFINER RPC pattern.

## Purpose

Admin-only read surfaces over `tournament_config_versions`. Powers User Story 5 (version history + rollback selection) and the JSON export half of FR-009.

## Signatures (LOCKED)

### `config_version_history(p_key, p_limit, p_offset) → SETOF row`

```sql
CREATE OR REPLACE FUNCTION public.config_version_history(
  p_key     text DEFAULT NULL,
  p_limit   int  DEFAULT 50,
  p_offset  int  DEFAULT 0
)
RETURNS TABLE (
  version_id              bigint,
  key                     text,
  previous_value          jsonb,
  new_value               jsonb,
  change_kind             text,
  actor                   uuid,
  reason                  text,
  source_citation         text,
  audit_log_id            uuid,
  parent_version_id       bigint,
  acknowledge_token_used  uuid,
  created_at              timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public;
```

### `admin_config_export() → jsonb envelope`

```sql
CREATE OR REPLACE FUNCTION public.admin_config_export()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public;
```

Both signatures are LOCKED.

## Behavior — `config_version_history`

Authorization: `is_admin(auth.uid())` check; `WCG07` denial path; audit row on denial.

Input validation:
- `p_limit < 1 OR p_limit > 500` → `WCG02`.
- `p_offset < 0` → `WCG02`.

Query:
```sql
RETURN QUERY
SELECT
  v.version_id, v.key, v.previous_value, v.new_value, v.change_kind,
  v.actor, v.reason, v.source_citation, v.audit_log_id,
  v.parent_version_id, v.acknowledge_token_used, v.created_at
FROM public.tournament_config_versions v
WHERE (p_key IS NULL OR v.key = p_key)
ORDER BY v.version_id DESC
LIMIT p_limit
OFFSET p_offset;
```

Notes:
- ORDER BY `version_id DESC` so most-recent appears first (UI default).
- For per-key history view (`/admin/config/history?key=<key>`), pass `p_key`.
- For global history view (`/admin/config/history`), pass `NULL`.

Performance contract: median ≤ 200 ms for typical config volume (≤ 10k rows total).

## Behavior — `admin_config_export`

Authorization: `is_admin(auth.uid())` check.

Logic:
1. Audit row: `admin.config_exported` with `new_value = jsonb_build_object('size', <bytes>, 'key_count', <count>)`.
2. Build envelope:

```sql
RETURN jsonb_build_object(
  'schema_version', '1.0.0',
  'exported_at',   now()::text,
  'exported_by',   auth.uid()::text,
  'environment',   COALESCE(current_setting('app.environment_label', true), 'unknown'),
  'current_config', (
    SELECT jsonb_object_agg(key,
      CASE WHEN public.key_is_secret(key)
           THEN jsonb_build_object('secret', true, 'value', null)
           ELSE value
      END
    )
    FROM public.tournament_config
  ),
  'version_history', (
    SELECT coalesce(jsonb_agg(to_jsonb(v.*) ORDER BY v.version_id ASC), '[]'::jsonb)
    FROM public.tournament_config_versions v
  ),
  'signature', encode(
    hmac(
      (...)::bytea,  -- body bytes
      current_setting('app.config_export_secret', false)::bytea,
      'sha256'
    ),
    'hex'
  )
);
```

The `signature` is computed over the canonical-JSON of the envelope EXCLUDING the `signature` field itself. The `app.config_export_secret` GUC is set at Supabase project level via env-var; the secret never appears in code or in the export body.

**Secret redaction**. Provider credential values are NOT included in the export body — the export records `{secret: true, value: null}` so the consumer knows the key exists but must obtain the actual credential out-of-band. Per Principle II + spec assumption "Sensitive provider credentials are admin-read-only."

## ERRCODE reuses

Both RPCs use `WCG07` for non-admin denial and `WCG02` for input validation.

## Privilege model

```sql
GRANT EXECUTE ON FUNCTION public.config_version_history(text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_config_export() TO authenticated;
```

## Audit posture

- `config_version_history`: NO audit row on success (read-only enumeration is high-volume; would create recursion-like noise — same logic as `audit_search`).
- `admin_config_export`: ONE `admin.config_exported` audit row per call.

## Client usage example

```ts
// apps/web/lib/config-history.ts
const { data, error } = await supabase.rpc('config_version_history', {
  p_key: 'scoring.match_points.exact',
  p_limit: 20,
});
if (error?.code === 'WCG07') router.push('/admin/access-denied');
```

```ts
// apps/web/app/api/admin/config/export/route.ts
const { data: envelope } = await supabase.rpc('admin_config_export');
const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
const url = URL.createObjectURL(blob);
// ... triggers download
```

## Cross-slice contract

- Reads from this slice's `tournament_config_versions` (locked at slice close).
- Reads from this slice's `tournament_config`.
- Calls `is_admin(uuid)` (Slice 006 locked predicate).
- Writes via Slice 007's `audit_log`.
