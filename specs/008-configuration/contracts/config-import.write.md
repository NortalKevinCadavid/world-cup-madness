# Contract: `admin_config_import` bulk-write RPC

**Feature**: 008-configuration
**Date**: 2026-05-17
**Status**: Contract (locked)

## Purpose

Bulk import of a previously-exported configuration envelope. Single transaction; single audit row; full version history appended (not merged).

## Signature (LOCKED)

```sql
CREATE OR REPLACE FUNCTION public.admin_config_import(
  p_envelope  jsonb,
  p_reason    text
)
RETURNS jsonb   -- { imported_keys: int, version_ids: int[], skipped_keys: text[] }
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public;
```

## Behavior

### Authorization

Same `is_admin` check; `WCG07` denial path; audit row on denial.

### Signature verification

```sql
DECLARE
  v_body jsonb := p_envelope - 'signature';
  v_signature_hex text := p_envelope ->> 'signature';
  v_secret bytea := current_setting('app.config_export_secret', false)::bytea;
  v_expected_signature_hex text;
BEGIN
  v_expected_signature_hex := encode(
    hmac(canonical_jsonb_to_bytea(v_body), v_secret, 'sha256'),
    'hex'
  );
  IF v_expected_signature_hex IS DISTINCT FROM v_signature_hex THEN
    RAISE EXCEPTION 'Import envelope signature invalid'
      USING ERRCODE = 'WCG08';
  END IF;
END;
```

Implementation note: `canonical_jsonb_to_bytea` is a helper that produces a deterministic byte representation of jsonb (key-sorted, whitespace-normalized) so the HMAC matches across re-serialization.

### Schema-version check

`p_envelope ->> 'schema_version'` MUST equal `'1.0.0'`. Future schema versions require a coordinated migration. Mismatch → `WCG08`.

### Per-key validation

For each `(key, value)` pair in `p_envelope -> 'current_config'`:
1. Skip if `key_is_secret(key)` AND the value is `{secret: true, value: null}` (the export redacted the credential; nothing to import).
2. Run the per-key validator (same as `admin_config_upsert`). Collect ALL failures.
3. If ANY key fails validation: roll back the entire import; raise `WCG08` with a jsonb error array listing each failed key + reason.

### Atomic write

```sql
DECLARE
  v_audit_id uuid;
  v_version_ids bigint[] := ARRAY[]::bigint[];
  v_keypair record;
  v_previous_value jsonb;
  v_new_version_id bigint;
BEGIN
  -- 1. Single audit row for the bulk import
  INSERT INTO public.audit_log (
    actor, action, entity_type, source,
    previous_value, new_value, reason, source_citation
  )
  VALUES (
    auth.uid(), 'admin.config_imported', 'tournament_config', 'admin_rpc',
    NULL, jsonb_build_object(
      'source_environment', p_envelope ->> 'environment',
      'exported_at',        p_envelope ->> 'exported_at',
      'exported_by',        p_envelope ->> 'exported_by',
      'schema_version',     p_envelope ->> 'schema_version',
      'key_count',          jsonb_object_keys_count(p_envelope -> 'current_config')
    ),
    p_reason,
    'config-import: ' || (p_envelope ->> 'environment')
  )
  RETURNING id INTO v_audit_id;

  -- 2. Iterate keys, upserting each into tournament_config + versions
  FOR v_keypair IN
    SELECT key, value
    FROM jsonb_each(p_envelope -> 'current_config')
  LOOP
    -- Skip secret redacted entries
    IF public.key_is_secret(v_keypair.key)
       AND (v_keypair.value ->> 'value') IS NULL
       AND (v_keypair.value ->> 'secret')::boolean = true
    THEN
      CONTINUE;
    END IF;

    -- Capture previous value (NULL if key is new)
    SELECT value INTO v_previous_value
      FROM public.tournament_config
      WHERE key = v_keypair.key;

    -- Insert version row
    INSERT INTO public.tournament_config_versions (
      key, previous_value, new_value, change_kind,
      actor, reason, source_citation, audit_log_id
    )
    VALUES (
      v_keypair.key, v_previous_value, v_keypair.value, 'import_bulk',
      auth.uid(), p_reason,
      'config-import: ' || (p_envelope ->> 'environment'),
      v_audit_id
    )
    RETURNING version_id INTO v_new_version_id;

    v_version_ids := array_append(v_version_ids, v_new_version_id);

    -- Upsert current state
    INSERT INTO public.tournament_config (key, value, value_type, updated_at, updated_by, version_id)
    VALUES (
      v_keypair.key, v_keypair.value, 'jsonb', now(), auth.uid(), v_new_version_id
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by,
          version_id = EXCLUDED.version_id;
  END LOOP;

  RETURN jsonb_build_object(
    'imported_keys', array_length(v_version_ids, 1),
    'version_ids',   to_jsonb(v_version_ids),
    'skipped_keys',  (
      SELECT coalesce(jsonb_agg(key), '[]'::jsonb)
      FROM jsonb_each(p_envelope -> 'current_config')
      WHERE public.key_is_secret(key)
        AND (value ->> 'value') IS NULL
    )
  );
END;
```

### Version history handling

The exported `version_history` is NOT replayed into the target environment's `tournament_config_versions` log. Doing so would corrupt the local version numbering and create duplicate audit_log_ids. Instead:
- The single `admin.config_imported` audit row carries the source environment label.
- Each key gets a fresh local `version_id` with `change_kind = 'import_bulk'`.
- The original `version_history` from the exporter is preserved AS-IS in the audit row's `new_value.original_history` field (optionally, for forensic chain-of-custody).

This is a deliberate design choice — local version numbering must remain monotonic and locally meaningful.

## ERRCODE namespace

| Code | Meaning |
|---|---|
| `WCG02` | Per-key validator failed (single key) |
| `WCG07` | Not admin |
| `WCG08` | Bulk import validation aggregate failure OR signature mismatch OR schema_version mismatch |

## Privilege model

```sql
GRANT EXECUTE ON FUNCTION public.admin_config_import(jsonb, text) TO authenticated;
```

## Audit posture

ONE `admin.config_imported` audit row per call. NOT per-key rows — the bulk import is conceptually a single atomic write.

If any post-import per-slice integration (e.g., scoring changes) would be affecting per R-010, the import path SKIPS the acknowledge token check — the rationale being that an admin running an import has already vetted the source. This is documented in the spec assumption "Configuration import / export is for operational use (environment promotion, disaster recovery)".

## Performance contract

- Median ≤ 1 s for a typical config size (~30 keys).
- Hard ceiling on envelope size: 10 MB (raise `WCG08` if exceeded).
- Locks: the body acquires advisory xact locks on each key being imported, in `ORDER BY key` lexicographic order, to avoid deadlocks with concurrent single-key writes.

## Cross-slice contract

- Reads from this slice's `tournament_config` (advisory locks on each key).
- Writes to this slice's `tournament_config` + `tournament_config_versions`.
- Writes via Slice 007's `audit_log` (one row).
- Calls `is_admin(uuid)` (Slice 006).

## Action label

`admin.config_imported` — added to the catalog in `data-model.md`. Slice 007's catalog assertion test recognizes this label.
