# Contract: `audit_log` table — final consolidated shape

**Feature**: 007-audit-trail
**Date**: 2026-05-17
**Status**: Contract (locked at slice close)
**Vendor-neutral**: Postgres-specific syntax (final shipping target).

## Purpose

Defines the **final consolidated** schema for `public.audit_log` after this slice closes, including:
1. All columns owned by prior slices (Slice 001 base + Slice 006 `source_citation`).
2. The **additive** columns owned by this slice (`sequence_id`).
3. The DB-level **tamper-resistance posture** (REVOKE UPDATE/DELETE).
4. The final index set.
5. The frozen action label catalog.

After this slice, slice 008 may **add** columns/indexes but must not alter or drop existing.

## DDL (final, after Slice 007 migration)

```sql
-- The base table was created in Slice 001 with id, actor, action, entity_type, entity_id,
-- previous_value, new_value, reason, source, occurred_at, plus pk + occurred_at index.
-- Slice 006 added source_citation (nullable text).
-- Slice 007 (THIS SLICE) adds sequence_id and the remaining indexes, then REVOKEs tamper privileges.

ALTER TABLE public.audit_log
  ADD COLUMN sequence_id bigserial NOT NULL;

-- Postgres auto-creates a sequence (`audit_log_sequence_id_seq`) and a UNIQUE NOT NULL constraint
-- via bigserial. Explicit unique index named for clarity:
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_sequence_id_uk
  ON public.audit_log (sequence_id);

-- Indexes owned by Slice 001 (preserved):
-- CREATE INDEX audit_log_occurred_at_idx ON public.audit_log (occurred_at DESC);
-- CREATE INDEX audit_log_action_occurred_idx ON public.audit_log (action, occurred_at DESC);

-- Indexes owned by THIS slice (new):
CREATE INDEX IF NOT EXISTS audit_log_actor_occurred_idx
  ON public.audit_log (actor, occurred_at DESC)
  WHERE actor IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_target_idx
  ON public.audit_log (entity_type, entity_id, sequence_id ASC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_source_occurred_idx
  ON public.audit_log (source, occurred_at DESC);

-- Source check constraint (preserved from Slice 001 / extended by Slice 006):
-- CHECK (source IN ('auth_hook','trigger','rls','api_guard','admin_rpc','ui','system'))

-- ============================================================
-- TAMPER-RESISTANCE: revoke UPDATE and DELETE from all app roles
-- ============================================================
REVOKE UPDATE, DELETE ON public.audit_log FROM authenticated;
REVOKE UPDATE, DELETE ON public.audit_log FROM anon;
REVOKE UPDATE, DELETE ON public.audit_log FROM service_role;

-- Sequence object: writable by triggers/SPs that INSERT into audit_log.
GRANT USAGE ON SEQUENCE public.audit_log_sequence_id_seq TO authenticated, anon, service_role;
```

### Column reference (final consolidated)

| Column | Type | Nullability | Default | Owner slice |
|---|---|---|---|---|
| `id` | uuid | NOT NULL (PK) | `gen_random_uuid()` | 001 |
| `sequence_id` | bigint (`bigserial`) | NOT NULL UNIQUE | sequence default | **007** |
| `actor` | uuid | NULL | — | 001 |
| `action` | text | NOT NULL | — | 001 |
| `entity_type` | text | NULL | — | 001 |
| `entity_id` | uuid | NULL | — | 001 |
| `previous_value` | jsonb | NULL | — | 001 |
| `new_value` | jsonb | NULL | — | 001 |
| `reason` | text | NULL | — | 001 |
| `source_citation` | text | NULL | — | 006 |
| `source` | text | NOT NULL (check constraint) | — | 001 |
| `occurred_at` | timestamptz | NOT NULL | `now()` | 001 |

## RLS posture (final, not changed by this slice)

This slice does NOT add or modify RLS policies. All access for `audit_search` and CSV export goes through `SECURITY DEFINER` paths that bypass RLS. Existing narrow INSERT policies remain:

- `participant_access_denied_self_insert` (Slice 001)
- `audit_log_admin_access_denied_insert` (Slice 006)

The reason RLS is not used for admin read access: the `audit_search` RPC's `SECURITY DEFINER` body checks `is_admin(auth.uid())` and raises ERRCODE `WAT01` if not admin. This gives identical security with simpler reasoning (no row-policy enumeration risk).

## Tamper-resistance posture (LOCKED, never re-grant)

The following MUST NEVER be re-granted by any future slice:

- `GRANT UPDATE ON public.audit_log TO …`
- `GRANT DELETE ON public.audit_log TO …`

If a future requirement demands targeted modification of audit rows (e.g., GDPR redaction), it MUST be implemented as a NEW slice that:
1. Documents the lawful basis.
2. Defines a SECURITY DEFINER `redact_audit_row(uuid, text)` RPC owned by `postgres` role.
3. Writes a self-referential audit row recording the redaction.
4. Does **not** re-grant blanket UPDATE/DELETE.

## Monotonic ordering invariant

`sequence_id` is a `bigserial`-backed column. Postgres guarantees:
- Each successful INSERT receives a strictly-increasing `sequence_id`.
- The sequence is **not** rolled back on transaction abort (gaps may exist after failed transactions — this is expected and does NOT violate monotonicity).
- Across replicas, `sequence_id` is consistent because it is allocated server-side at INSERT time.

Per-target ordering: `ORDER BY sequence_id ASC` is the canonical history-replay order — it is unaffected by clock skew, timezone settings, or `occurred_at` re-use within the same millisecond.

`occurred_at` MAY have duplicate values across rows (e.g., a single bulk admin RPC writing 3 audit rows in the same statement). Consumers MUST sort by `sequence_id` when sub-second ordering matters.

## Action label catalog (frozen at this slice)

See `data-model.md` "Action label catalog" section for the full table. The catalog is **frozen**: existing labels MUST NOT be renamed. New labels MAY be added by future slices under their own namespace prefix (e.g., `tournament_config.<key>` added by Slice 008 — already reserved).

## Cross-slice contract

| Producer (writers) | Reads from | Locked behavior |
|---|---|---|
| Slice 001 auth-hook → INSERT | — | `sequence_id` auto-assigned |
| Slice 002 sync trigger → INSERT | — | `sequence_id` auto-assigned |
| Slice 003/004 prediction triggers → INSERT | — | `sequence_id` auto-assigned |
| Slice 005 score triggers → INSERT | — | `sequence_id` auto-assigned |
| Slice 006 admin RPCs → INSERT | — | `sequence_id` auto-assigned |
| Slice 007 `audit_search` RPC | reads | gated by `is_admin` |
| Slice 007 CSV export route | reads (via `audit_search`) | gated by `is_admin` |
| Slice 008 (future) | reads + INSERTs config-change rows | `sequence_id` auto-assigned |

## Migration guards

This slice's migration MUST verify:
1. `audit_log` has no rows with NULL `action` (sanity check before adding `sequence_id`).
2. The `bigserial`-implied sequence starts at 1 (or current max+1 if rows pre-exist).
3. REVOKE statements succeed (will raise on missing role; that is informational, not blocking).
