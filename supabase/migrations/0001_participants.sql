-- Slice 001 / FR-003 / data-model.md § Entity 1 / spec.md Clarifications 2026-05-15
--
-- Migration 0001: create the `public.participants` table, the `participation_status`
-- enum, the `citext` extension required by case-insensitive email storage, the
-- generated `domain` column, all UNIQUE constraints + indexes from
-- data-model.md § Entity 1, and a BEFORE UPDATE trigger that maintains
-- `updated_at` on every row mutation.
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS, NO RLS policies, NO GRANT/REVOKE beyond default ownership.
--       Slice 001 task T012 owns the full RLS surface.
--   * NO audit trigger. Slice 001 task T013 owns the `AFTER INSERT OR UPDATE`
--       trigger that emits `audit_log` rows.
--   * NO seed inserts. Fixtures live in `supabase/seed/slice-001-fixture.sql`.
--
-- Locked cross-slice contracts established here (Constitution Principle XI):
--   * `public.participants(id uuid PK)`            — every downstream slice FKs to this column.
--   * `public.participants.auth_user_id`           — 1:1 link to `auth.users(id)`.
--   * `public.participation_status` enum values    — exactly {active, deactivated}
--                                                    per spec Clarifications 2026-05-15.

BEGIN;

-- citext for case-insensitive email storage (data-model.md § Entity 1: email).
-- Idempotent: safe to re-run via `supabase db reset`.
CREATE EXTENSION IF NOT EXISTS citext;

-- pgcrypto provides `gen_random_uuid()` used as the default for `id`.
-- Supabase ships this enabled by default, but we declare it explicitly so the
-- migration is self-contained and `supabase db reset` is deterministic.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- participation_status enum — LOCKED to exactly two values per spec
-- Clarifications 2026-05-15. Adding values "for the future" violates
-- Principle IX (testable scenarios) — do not extend without a spec change.
CREATE TYPE public.participation_status AS ENUM ('active', 'deactivated');

-- `updated_at` maintenance function. Generic enough that future slices may
-- reuse it (e.g. tournament_config, audit_log if it ever takes updates) — but
-- since no convention file exists in the repo yet, this slice establishes it.
-- The function is intentionally minimal: trigger callers attach it to their
-- own tables via `BEFORE UPDATE ... EXECUTE FUNCTION public.set_updated_at()`.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- public.participants
-- ---------------------------------------------------------------------------
CREATE TABLE public.participants (
  -- FR-003 / data-model.md § Entity 1: application-side participant identifier.
  -- Decoupled from auth.users.id so the IdP can be replaced (research § R-003).
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FR-003: 1:1 link to Supabase Auth identity. ON DELETE RESTRICT so deleting
  -- an auth user cannot silently drop tournament data (data-model.md § Entity 1).
  -- Provisioning happens via the AFTER INSERT trigger on auth.users (slot 0009),
  -- which fires AFTER the auth.users row exists, so this FK can be satisfied
  -- immediately without DEFERRABLE.
  auth_user_id    uuid NOT NULL
                    REFERENCES auth.users (id) ON DELETE RESTRICT,

  -- FR-003 / FR-004: case-insensitive email stored at provisioning time.
  -- Refreshed only via admin intervention (research § R-010).
  email           citext NOT NULL,

  -- FR-003: refreshable on every login (research § R-010).
  display_name    text NOT NULL,

  -- FR-002 / FR-007: domain derived from email; lets RLS and analytics filter
  -- on domain without re-parsing. STORED so it is indexable and visible to
  -- query planners; the expression mirrors `is_approved_domain` (research § R-007).
  domain          citext
                    GENERATED ALWAYS AS (lower(split_part(email::text, '@', 2)))
                    STORED
                    NOT NULL,

  -- FR-003: optional IdP claim, refreshable on every login (research § R-010).
  region          text NULL,

  -- FR-003 / Slice 006 contract: Slice 001 only writes 'active'.
  -- 'deactivated' transitions are owned by Slice 006 admin overrides.
  status          public.participation_status NOT NULL DEFAULT 'active',

  -- FR-003: set once at provisioning; never updated by Slice 001 paths.
  first_login_at  timestamptz NOT NULL DEFAULT now(),

  -- FR-003: updated by every `before_user_signed_in` auth-hook firing (T0XX).
  last_login_at   timestamptz NOT NULL DEFAULT now(),

  -- Row-create timestamp; identical to `first_login_at` for this slice but
  -- separated for symmetry with every other table in the system.
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Trigger-maintained on every UPDATE (see trigger below). Never set by
  -- application code directly.
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- ---- CHECK constraints (data-model.md § Entity 1 validation rules) ----

  -- email MUST contain exactly one '@'. The LIKE check is the cheap version
  -- mandated by tasks.md T009 step 6; deeper RFC 5322 validation is out of
  -- scope (the IdP is the authority on syntactic validity).
  CONSTRAINT participants_email_has_at
    CHECK (email::text LIKE '%@%'),

  -- display_name MUST NOT be empty after trim (data-model.md § Entity 1).
  CONSTRAINT participants_display_name_not_blank
    CHECK (length(trim(display_name)) > 0)
);

-- ---------------------------------------------------------------------------
-- UNIQUE constraints (FR-004 anti-duplication, spec Acceptance Scenario US1.2)
-- ---------------------------------------------------------------------------

-- One participant per Supabase Auth identity. Also the lookup index used by
-- the auth hook on every login (research § R-004) and by every RLS predicate
-- (research § R-006).
ALTER TABLE public.participants
  ADD CONSTRAINT participants_auth_user_id_uk UNIQUE (auth_user_id);

-- Case-insensitive (citext) uniqueness on email. Guards against the same
-- person being provisioned under two `auth.users.id` rows (FR-004).
ALTER TABLE public.participants
  ADD CONSTRAINT participants_email_uk UNIQUE (email);

-- ---------------------------------------------------------------------------
-- Non-unique indexes (data-model.md § Entity 1 → Indexes and access patterns)
-- ---------------------------------------------------------------------------

-- Admin queries "all active @nortal.com participants"; analytics dashboards.
CREATE INDEX participants_domain_status_idx
  ON public.participants (domain, status);

-- Operations: identify dormant accounts. DESC matches the natural query
-- "most recently logged-in first" / "oldest dormant last".
CREATE INDEX participants_last_login_at_idx
  ON public.participants (last_login_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger
-- ---------------------------------------------------------------------------
CREATE TRIGGER participants_set_updated_at
  BEFORE UPDATE ON public.participants
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Table documentation (visible via \d+ and pg_description; supports future
-- generated docs).
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.participants IS
  'Slice 001 / FR-003: application-side identity of an eligible Nortal collaborator. '
  'Locked cross-slice contract — every downstream slice FKs to participants(id).';

COMMENT ON COLUMN public.participants.id              IS 'FR-003: application-side participant identifier (PK).';
COMMENT ON COLUMN public.participants.auth_user_id    IS 'FR-003: 1:1 link to auth.users(id). ON DELETE RESTRICT.';
COMMENT ON COLUMN public.participants.email           IS 'FR-003 / FR-004: citext email captured at provisioning; refreshed only via admin (R-010).';
COMMENT ON COLUMN public.participants.display_name    IS 'FR-003: refreshable on every login (R-010).';
COMMENT ON COLUMN public.participants.domain          IS 'FR-002 / FR-007: generated from email; consumed by is_approved_domain.';
COMMENT ON COLUMN public.participants.region          IS 'FR-003: optional IdP claim, refreshable on every login (R-010).';
COMMENT ON COLUMN public.participants.status          IS 'FR-003: participation_status; Slice 001 writes only ''active''. Slice 006 owns transitions to ''deactivated''.';
COMMENT ON COLUMN public.participants.first_login_at  IS 'FR-003: set once at provisioning, never updated.';
COMMENT ON COLUMN public.participants.last_login_at   IS 'FR-003: updated by every before_user_signed_in auth-hook firing.';
COMMENT ON COLUMN public.participants.created_at      IS 'Row-create timestamp; equals first_login_at for this slice (symmetry with other tables).';
COMMENT ON COLUMN public.participants.updated_at      IS 'Trigger-maintained on every UPDATE; never set by application code.';

COMMIT;
