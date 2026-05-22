# Contract: `tournament_config` + `tournament_config_versions` schema

**Feature**: 008-configuration
**Date**: 2026-05-17
**Status**: Contract (locked at slice close)
**Vendor-neutral**: Postgres-specific syntax (final shipping target).

## Purpose

Final shape of the configuration data layer. Two tables: `tournament_config` (current state) and `tournament_config_versions` (append-only history). Plus `config_read` helper and `pg_notify` trigger.

## DDL

```sql
-- ============================================================
-- 1. tournament_config — current state (extends Slice 001 stub)
-- ============================================================
-- Slice 001 created: CREATE TABLE public.tournament_config (key text PRIMARY KEY, value jsonb NOT NULL, …);
-- Slice 002 added: first_kickoff_at_utc seed
-- Slice 007 added: audit.retention.* + notifications.audit_failure_webhook_url seeds
-- This slice (008): adds value_type, version_id, finalizes constraints

ALTER TABLE public.tournament_config
  ADD COLUMN IF NOT EXISTS value_type text NOT NULL DEFAULT 'jsonb',
  ADD COLUMN IF NOT EXISTS updated_by uuid NULL,
  ADD COLUMN IF NOT EXISTS version_id bigint NULL;

ALTER TABLE public.tournament_config
  ADD CONSTRAINT tournament_config_value_type_check
  CHECK (value_type IN (
    'text','integer','number','boolean','array','object',
    'duration_minutes','duration_seconds','timestamptz','uuid','jsonb'
  ));

CREATE INDEX IF NOT EXISTS tournament_config_updated_at_idx
  ON public.tournament_config (updated_at DESC);

REVOKE DELETE ON public.tournament_config FROM authenticated, anon, service_role;

-- ============================================================
-- 2. tournament_config_versions — append-only history
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tournament_config_versions (
  version_id              bigserial PRIMARY KEY,
  key                     text NOT NULL,
  previous_value          jsonb NULL,
  new_value               jsonb NOT NULL,
  change_kind             text NOT NULL,
  actor                   uuid NULL,
  reason                  text NULL,
  source_citation         text NULL,
  audit_log_id            uuid NULL REFERENCES public.audit_log(id) ON DELETE NO ACTION,
  parent_version_id       bigint NULL REFERENCES public.tournament_config_versions(version_id),
  acknowledge_token_used  uuid NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tournament_config_versions
  ADD CONSTRAINT tournament_config_versions_change_kind_check
  CHECK (change_kind IN ('initial_seed','admin_upsert','admin_rollback','import_bulk'));

ALTER TABLE public.tournament_config_versions
  ADD CONSTRAINT tournament_config_versions_previous_value_check
  CHECK (
    (change_kind = 'initial_seed') OR (previous_value IS NOT NULL)
  );

ALTER TABLE public.tournament_config_versions
  ADD CONSTRAINT tournament_config_versions_parent_version_check
  CHECK (
    (change_kind = 'admin_rollback') = (parent_version_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS tournament_config_versions_key_version_idx
  ON public.tournament_config_versions (key, version_id DESC);

CREATE INDEX IF NOT EXISTS tournament_config_versions_created_at_idx
  ON public.tournament_config_versions (created_at DESC);

CREATE INDEX IF NOT EXISTS tournament_config_versions_rollback_idx
  ON public.tournament_config_versions (change_kind, version_id DESC)
  WHERE change_kind = 'admin_rollback';

REVOKE UPDATE, DELETE ON public.tournament_config_versions FROM authenticated, anon, service_role;
GRANT USAGE ON SEQUENCE public.tournament_config_versions_version_id_seq TO authenticated, anon, service_role;

-- ============================================================
-- 3. RLS policies
-- ============================================================
ALTER TABLE public.tournament_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_config_versions ENABLE ROW LEVEL SECURITY;

-- Secret-key helper
CREATE OR REPLACE FUNCTION public.key_is_secret(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_key LIKE 'providers.%.credentials.%';
$$;

CREATE POLICY tournament_config_authenticated_read
  ON public.tournament_config
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()) OR NOT public.key_is_secret(key));

CREATE POLICY tournament_config_no_direct_write
  ON public.tournament_config
  FOR ALL
  TO authenticated
  USING (false);

CREATE POLICY tournament_config_versions_admin_read
  ON public.tournament_config_versions
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE POLICY tournament_config_versions_no_direct_write
  ON public.tournament_config_versions
  FOR ALL
  TO authenticated
  USING (false);

-- ============================================================
-- 4. config_read helper (fail-closed)
-- ============================================================
CREATE OR REPLACE FUNCTION public.config_read(p_key text, p_default jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT value INTO v FROM public.tournament_config WHERE key = p_key;
  IF v IS NULL THEN
    IF p_default IS NULL THEN
      RAISE EXCEPTION 'Configuration key % not found and no default provided', p_key
        USING ERRCODE = 'WCG06';
    END IF;
    RETURN p_default;
  END IF;
  RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.config_read(text, jsonb) TO authenticated, service_role;

-- ============================================================
-- 5. pg_notify trigger for live-config invalidation (R-009)
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_tournament_config_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('tournament_config_changed', NEW.key);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tournament_config_change_notify
  AFTER INSERT OR UPDATE ON public.tournament_config
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_tournament_config_change();
```

## Column reference

### `tournament_config`

| Column | Type | Nullability | Default | Owner slice |
|---|---|---|---|---|
| `key` | text | NOT NULL (PK) | — | 001 |
| `value` | jsonb | NOT NULL | — | 001 |
| `value_type` | text | NOT NULL | `'jsonb'` | **008** |
| `updated_at` | timestamptz | NOT NULL | `now()` | 001 |
| `updated_by` | uuid | NULL | — | **008** |
| `version_id` | bigint | NULL | — | **008** (links to versions log) |

### `tournament_config_versions`

| Column | Type | Nullability | Default | Owner slice |
|---|---|---|---|---|
| `version_id` | bigint (`bigserial`) | NOT NULL (PK) | sequence | **008** |
| `key` | text | NOT NULL | — | **008** |
| `previous_value` | jsonb | NULL | — | **008** |
| `new_value` | jsonb | NOT NULL | — | **008** |
| `change_kind` | text | NOT NULL (CHECK) | — | **008** |
| `actor` | uuid | NULL | — | **008** |
| `reason` | text | NULL | — | **008** |
| `source_citation` | text | NULL | — | **008** |
| `audit_log_id` | uuid | NULL (FK → audit_log) | — | **008** |
| `parent_version_id` | bigint | NULL (FK self) | — | **008** |
| `acknowledge_token_used` | uuid | NULL | — | **008** |
| `created_at` | timestamptz | NOT NULL | `now()` | **008** |

## Privilege posture (LOCKED)

| Object | authenticated | anon | service_role |
|---|---|---|---|
| `tournament_config` SELECT | per RLS (admin sees all; non-admin sees non-secret) | denied | yes |
| `tournament_config` INSERT/UPDATE | denied (RLS `false`) | denied | yes (RPC bodies only) |
| `tournament_config` DELETE | **REVOKED** | **REVOKED** | **REVOKED** |
| `tournament_config_versions` SELECT | admin only (RLS) | denied | yes |
| `tournament_config_versions` INSERT | denied (RLS `false`) | denied | yes (RPC bodies only) |
| `tournament_config_versions` UPDATE/DELETE | **REVOKED** | **REVOKED** | **REVOKED** |

The REVOKE statements mirror Slice 007's audit_log posture (append-only at DB level).

## Monotonic ordering invariant

`tournament_config_versions.version_id` is `bigserial`. Same guarantees as Slice 007's `audit_log.sequence_id`: monotonic, gap-allowed-on-abort, consistent across replicas. Per-key history uses `ORDER BY version_id ASC`.

## `pg_notify` channel contract

| Channel | Payload | Subscribers |
|---|---|---|
| `tournament_config_changed` | The changed `key` (text, no JSON wrapping) | Long-lived Next.js processes (per R-009 cache invalidation) |

Subscribers MUST be tolerant of:
- Notification loss during temporary disconnect (the 60-second LRU TTL is the backstop).
- Duplicate notifications (idempotent invalidation).
- Notification arrival before/after the corresponding read sees the new value (re-read on next access).

## Cross-slice writers/readers

| Writer (after this slice ships) | Action |
|---|---|
| `admin_config_upsert` SP | INSERT into `tournament_config_versions`; UPDATE `tournament_config`; INSERT into `audit_log` |
| `admin_config_rollback` SP | INSERT into `tournament_config_versions` (change_kind='admin_rollback'); UPDATE `tournament_config`; INSERT into `audit_log` |
| `admin_config_import` SP | Bulk INSERT into `tournament_config_versions` (change_kind='import_bulk'); UPDATE `tournament_config`; single INSERT into `audit_log` |

| Reader | Reads | Notes |
|---|---|---|
| `is_eligible_nortal_participant(uuid)` | `eligibility.allowed_domains` via `config_read` | Migrated by this slice |
| `is_prediction_locked(uuid)` | `locking.match_prediction_window_minutes` via `config_read` | Migrated by this slice |
| `compute_match_score(...)` | `scoring.match_points.*` via `config_read` | Migrated by this slice |
| Slice 005 leaderboard view | `scoring.tie_breaker_order` via `config_read` | Migrated by this slice |
| Slice 002 sync coordinator | `providers.active`, `providers.<id>.*` | Migrated by this slice (Edge Function code) |
| Slice 006's `is_admin(uuid)` | — | Reads `admin_roles` table; unaffected by this slice |
| Slice 007 admin UI | `audit.retention.*`, `notifications.audit_failure_webhook_url` | Display only; mutation via this slice's admin UI |
| `admin_config_get_secret` SP | secret keys via direct table SELECT (bypasses RLS via SECURITY DEFINER) | Audits every access |

## Migration ordering (LOCKED)

The migration file `supabase/migrations/008_configuration.sql` MUST execute steps in this order to avoid breaking prior slices mid-migration:

1. CREATE `tournament_config_versions` table + indexes + REVOKEs.
2. ALTER `tournament_config` to add new columns + constraints + indexes + REVOKE DELETE.
3. CREATE `key_is_secret`, `config_read`, `config_read_admin_bypass` helpers.
4. ENABLE RLS + CREATE policies on both tables.
5. CREATE `notify_tournament_config_change` trigger + function.
6. SEED defaults via `INSERT ... ON CONFLICT (key) DO NOTHING` for the full namespace catalog (data-model.md §catalog).
7. CREATE the `admin_config_*` RPC family bodies (covered in separate contracts).
8. ALTER FUNCTION bodies for consumer slices in dependency order:
   - Slice 001's `is_eligible_nortal_participant(uuid)`
   - Slice 003's `is_prediction_locked(uuid)`
   - Slice 005's `compute_match_score(...)` + leaderboard view
9. CREATE the `pg_cron` webhook-delivery job (covered in separate contract).

Each ALTER FUNCTION step in section 8 is preceded by a smoke-check `SELECT` against fixture data and followed by a rollback-safe transaction boundary. If any smoke check fails, the entire migration aborts and the DBA must intervene.

## Future-extension governance

Slice 008 is the final slice. Future configuration keys MAY be added by future product slices following this protocol:

1. Add the key to the catalog table in `data-model.md` with default, type, consumer.
2. Add an `INSERT ... ON CONFLICT DO NOTHING` migration seeding the default.
3. Extend the admin UI form section that owns the key.
4. Add a row to the regression-test fixture asserting the default value resolves correctly via `config_read`.

Renaming an existing key is breaking; requires a migration that writes both old and new keys for a deprecation window, then removes the old.
