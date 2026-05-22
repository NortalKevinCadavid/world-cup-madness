# Contract: `admin_config_*` SECURITY DEFINER RPC family

**Feature**: 008-configuration
**Date**: 2026-05-17
**Status**: Contract (locked)
**Vendor-neutral**: Postgres SECURITY DEFINER + RPC pattern (final shipping target).

## Purpose

Single SP family powering every administrator write operation against `tournament_config`. Every RPC body audits its own access, gates on `is_admin`, validates inputs against per-key rules, and emits BOTH a `tournament_config_versions` row AND an `audit_log` row in the same transaction.

## Signatures (LOCKED)

### `admin_config_upsert`

```sql
CREATE OR REPLACE FUNCTION public.admin_config_upsert(
  p_key                  text,
  p_value                jsonb,
  p_expected_version_id  bigint,
  p_reason               text,
  p_source_citation      text DEFAULT NULL,
  p_acknowledge_token    uuid DEFAULT NULL
)
RETURNS bigint   -- new version_id
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public;
```

### `admin_config_preview`

```sql
CREATE OR REPLACE FUNCTION public.admin_config_preview(
  p_key    text,
  p_value  jsonb
)
RETURNS jsonb   -- { affecting: bool, summary: text, sample: jsonb, acknowledge_token: uuid }
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public;
```

### `admin_config_rollback`

```sql
CREATE OR REPLACE FUNCTION public.admin_config_rollback(
  p_target_version_id  bigint,
  p_reason             text,
  p_source_citation    text DEFAULT NULL
)
RETURNS bigint   -- new version_id (the rollback's own version)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public;
```

### `admin_config_get_secret`

```sql
CREATE OR REPLACE FUNCTION public.admin_config_get_secret(p_key text)
RETURNS jsonb   -- the actual {secret: true, value: <plain>} object
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public;
```

### `admin_config_grant_admin_role`

```sql
CREATE OR REPLACE FUNCTION public.admin_config_grant_admin_role(
  p_participant_id   uuid,
  p_reason           text,
  p_source_citation  text
)
RETURNS uuid   -- the admin_roles row id
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public;
```

Calls Slice 006's `admin_grant_admin_role(p_participant_id, p_reason, p_source_citation)` internally; appends a row to `tournament_config_versions` with `key = 'admin_roles.<participant_id>'`.

### `admin_config_revoke_admin_role`

```sql
CREATE OR REPLACE FUNCTION public.admin_config_revoke_admin_role(
  p_participant_id   uuid,
  p_reason           text,
  p_source_citation  text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public;
```

All signatures are LOCKED. Future slices must not reorder, rename, or change parameter types.

## Behavior — `admin_config_upsert`

### Authorization (top of body)

```sql
IF NOT public.is_admin(auth.uid()) THEN
  INSERT INTO public.audit_log (actor, action, entity_type, source, new_value)
  VALUES (auth.uid(), 'admin.access_denied', 'admin_config_upsert', 'api_guard',
          jsonb_build_object('rpc','admin_config_upsert','key',p_key));
  RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
END IF;
```

### Required-input validation

| Condition | Behavior |
|---|---|
| `p_key IS NULL` OR not in catalog | RAISE `WCG03` (`Unknown configuration key %`) |
| `p_value` fails per-key validator (range/type/format) | RAISE `WCG02` (`Invalid value for key %: <reason>`) |
| `p_reason IS NULL` OR `length(trim(p_reason)) = 0` | RAISE `WCG02` (`Reason is required for configuration writes`) |
| `p_source_citation IS NULL` AND key in security-sensitive list (`eligibility.*`, `locking.*`, `scoring.*`, `providers.active`, `admin_roles.*`) | RAISE `WCG02` (`Source citation required for security-sensitive key`) |

### Concurrency check

```sql
-- Acquire advisory xact lock keyed by p_key (R-003)
PERFORM pg_advisory_xact_lock(hashtext(p_key));

-- Verify expected version
DECLARE
  v_current_version bigint;
  v_previous_value  jsonb;
BEGIN
  SELECT version_id, value
    INTO v_current_version, v_previous_value
    FROM public.tournament_config
    WHERE key = p_key
    FOR UPDATE;

  IF v_current_version IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'Concurrent edit detected: expected version_id %, current %', p_expected_version_id, v_current_version
      USING ERRCODE = 'WCG01';
  END IF;
END;
```

### Acknowledge-token check (FR-005 + R-010)

```sql
-- Re-run admin_config_preview internally to determine if this is affecting
DECLARE
  v_preview jsonb := public.admin_config_preview(p_key, p_value);
BEGIN
  IF (v_preview ->> 'affecting')::boolean THEN
    IF p_acknowledge_token IS NULL THEN
      RAISE EXCEPTION 'This change affects existing data; acknowledge token required'
        USING ERRCODE = 'WCG05';
    END IF;
    -- Verify token matches the one issued by the preview within last 5 minutes
    IF NOT public.verify_acknowledge_token(p_acknowledge_token, p_key, p_value) THEN
      RAISE EXCEPTION 'Acknowledge token invalid or expired'
        USING ERRCODE = 'WCG05';
    END IF;
  END IF;
END;
```

`verify_acknowledge_token` is a SECURITY DEFINER helper that checks the token's HMAC signature and timestamp.

### Atomic write (versions + config + audit)

```sql
DECLARE
  v_audit_id      uuid;
  v_new_version   bigint;
  v_action_label  text := 'tournament_config.' || p_key;
BEGIN
  -- 1. Audit row first (gets sequence_id)
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id, source,
    previous_value, new_value, reason, source_citation
  )
  VALUES (
    auth.uid(), v_action_label, 'tournament_config', NULL, 'admin_rpc',
    v_previous_value, p_value, p_reason, p_source_citation
  )
  RETURNING id INTO v_audit_id;

  -- 2. Version log row
  INSERT INTO public.tournament_config_versions (
    key, previous_value, new_value, change_kind,
    actor, reason, source_citation, audit_log_id,
    acknowledge_token_used
  )
  VALUES (
    p_key, v_previous_value, p_value, 'admin_upsert',
    auth.uid(), p_reason, p_source_citation, v_audit_id,
    p_acknowledge_token
  )
  RETURNING version_id INTO v_new_version;

  -- 3. Update current state
  UPDATE public.tournament_config
    SET value      = p_value,
        updated_at = now(),
        updated_by = auth.uid(),
        version_id = v_new_version
    WHERE key = p_key;

  RETURN v_new_version;
END;
```

## Behavior — `admin_config_preview`

Returns a jsonb of shape `{ affecting: bool, summary: text, sample: jsonb, acknowledge_token: uuid }`.

| `p_key` matches | Logic |
|---|---|
| `eligibility.allowed_domains` (removal of an existing domain) | Count + sample 5 participants whose `email` domain matches the to-be-removed entry |
| `locking.match_prediction_window_minutes` (any change) | Count matches whose `lock_at_old IS BETWEEN now() AND lock_at_new` (re-opens locked) OR `lock_at_new IS BETWEEN now() AND lock_at_old` (closes earlier) |
| `scoring.score_upper_bound` (decrease) | Count predictions where `home_score > new_bound OR away_score > new_bound` |
| `scoring.match_points.*` OR `scoring.final_pick_points` OR `scoring.tie_breaker_order` (any change) | Count `score_records` rows that would be recomputed (= total participants × total decided matches) |
| `providers.active` (change) | Count of matches with un-confirmed results that would be re-fetched by new provider |
| `admin_roles.<participant_id>` revocation | If participant has open admin sessions, list count |
| Anything else | `affecting = false` |

If `affecting = true`, issue an acknowledge token via `public.issue_acknowledge_token(p_key, p_value)` (HMAC-signed; 5-minute TTL) and include it in the response.

If `affecting = false`, return `acknowledge_token = null`. The caller of `admin_config_upsert` MAY pass null in that case.

Authorization: same `is_admin` check + `WCG07` denial path as `admin_config_upsert`.

## Behavior — `admin_config_rollback`

Authorization: same `is_admin` check.

Validation:
- `p_target_version_id` MUST exist in `tournament_config_versions`; else `WCG03`.
- Retention check: `p_target_version_id`'s `created_at >= retention_horizon()` (configurable; defaults to "all history kept" per Slice 007 retention policy). Else `WCG04`.

Logic:
1. SELECT the target version's `key` and `new_value` (= the value we want to restore).
2. Acquire advisory xact lock on `hashtext(key)`.
3. Read current state of `tournament_config` for that key.
4. Insert audit row with `action = 'tournament_config.<key>'`, `previous_value = <current>`, `new_value = <target's new_value>`, `reason = 'Rollback to version ' || p_target_version_id || ': ' || p_reason`.
5. Insert versions row with `change_kind = 'admin_rollback'`, `parent_version_id = p_target_version_id`.
6. Update `tournament_config` to the target value.
7. Return the new version_id.

The rollback is a NEW write (not a delete). The target version remains in history.

## Behavior — `admin_config_get_secret`

Authorization: same `is_admin` check.

Validation: `p_key` MUST match `key_is_secret(p_key)`; else `WCG03`.

Logic:
1. Write `admin.config_secret_accessed` audit row with `entity_type = 'tournament_config'`, `entity_id` derived from the key (or NULL), `new_value` = `jsonb_build_object('key', p_key)` (does NOT include the secret value in the audit row).
2. Return the actual `tournament_config.value` (the `{secret: true, value: <plain>}` jsonb).

Every secret read produces an audit row — full forensic trail.

## Behavior — admin role wrappers

These are thin wrappers around Slice 006's locked SPs. They exist to keep all admin config writes flowing through a uniform RPC family and to ensure the `tournament_config_versions` history captures role changes.

```sql
-- admin_config_grant_admin_role
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    -- audit + raise WCG07
  END IF;

  PERFORM public.admin_grant_admin_role(p_participant_id, p_reason, p_source_citation);
  -- Slice 006's SP writes its own audit row (admin.role_granted) and inserts/updates admin_roles.

  INSERT INTO public.tournament_config_versions (
    key, previous_value, new_value, change_kind,
    actor, reason, source_citation, audit_log_id
  )
  VALUES (
    'admin_roles.' || p_participant_id::text,
    jsonb_build_object('admin', false),
    jsonb_build_object('admin', true),
    'admin_upsert',
    auth.uid(), p_reason, p_source_citation,
    (SELECT id FROM public.audit_log
      WHERE action = 'admin.role_granted'
        AND entity_id = p_participant_id
        AND actor = auth.uid()
      ORDER BY sequence_id DESC LIMIT 1)
  );

  RETURN p_participant_id;
END;
```

`admin_config_revoke_admin_role` mirrors but flips the values and calls Slice 006's `admin_revoke_admin_role`.

## ERRCODE namespace (LOCKED)

| Code | Meaning |
|---|---|
| `WCG01` | Concurrent edit; expected_version_id stale |
| `WCG02` | Invalid configuration value (validation failure) |
| `WCG03` | Unknown configuration key |
| `WCG04` | Rollback target version exceeds retention horizon |
| `WCG05` | Affecting-data warning unacknowledged or token invalid |
| `WCG06` | Configuration store unreachable (raised by `config_read`) |
| `WCG07` | Caller is not admin |
| `WCG08` | Bulk import validation aggregate failure |

## Privilege model

```sql
GRANT EXECUTE ON FUNCTION public.admin_config_upsert(text, jsonb, bigint, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_config_preview(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_config_rollback(bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_config_get_secret(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_config_grant_admin_role(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_config_revoke_admin_role(uuid, text, text) TO authenticated;
-- (NOT granted to anon)
```

Each RPC body's `is_admin` check makes them effectively admin-only.

## Performance contract

- `admin_config_upsert` p95 ≤ 200 ms (single-key write + advisory lock + 3 inserts).
- `admin_config_preview` p95 ≤ 2 s (impact computation may scan large tables; UI shows spinner).
- `admin_config_rollback` p95 ≤ 200 ms.
- `admin_config_get_secret` p95 ≤ 50 ms (single PK lookup + audit insert).

## Audit posture summary

Every RPC writes ONE row to `audit_log` per invocation:
- Success: `tournament_config.<key>` for upsert/rollback/import; `admin.role_granted`/`admin.role_revoked` for role wrappers; `admin.config_secret_accessed` for get_secret.
- Authorization failure: `admin.access_denied` with `entity_type = '<rpc_name>'`.
- Validation failure: NO audit row (validation failures are client-side errors, not security signals).

## Cross-slice contract

- Calls Slice 006's `is_admin(uuid)` and `admin_grant_admin_role` / `admin_revoke_admin_role` SPs (locked).
- Writes via Slice 007's `audit_log` (sequence_id auto-allocated, source_citation carried).
- Reads from Slice 008's `tournament_config` and `tournament_config_versions`.
- After this slice ships, no further slice may alter or rename these RPC signatures.
