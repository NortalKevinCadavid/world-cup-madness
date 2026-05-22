-- Slice 002 / T003 / FR-001 / data-model.md § Entity 1 (Team) + § Entity 4 (provider mapping).
-- Cross-slice locked: teams.id is the FK target for matches.home_team_id / away_team_id (this
-- slice), Slice 004 final_predictions.champion_team_id / runner_up_team_id, and Slice 005
-- tournament_award.champion_team_id. The locked column set is (id, name, short_code, flag_url,
-- created_at, updated_at). Adding columns is forward-compatible; renaming or removing them
-- requires coordinated regression updates across Slices 003-008 (Constitution Principle XI).
--
-- Migration 0019: create public.teams + public.team_provider_external_ids (R-003 idempotent
-- UPSERT mapping table, internal-only — never exposed to participant clients).
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS, NO RLS policies, NO GRANT/REVOKE beyond default ownership.
--       T009 owns the full Slice 002 RLS surface (migration 0026).
--   * NO audit trigger. T008 owns the AFTER INSERT/UPDATE triggers that emit
--       audit_log rows for sync.* / match.* / team.* actions (migration 0025).
--   * NO seed inserts. The 32-team fixture lives in supabase/seed/slice-002-fixture.sql
--       and is loaded by T012.
--   * The provider_team_id mapping lives in team_provider_external_ids, NOT as a
--       column on teams (Principle IV: provider IDs in mapping tables, not on the entity).
--
-- updated_at maintenance reuses Slice 001's public.set_updated_at() function established in
-- migration 0001_participants.sql. No new function created here — sharing the trigger function
-- keeps a single source of truth for the updated_at convention across slices.

BEGIN;

-- ---------------------------------------------------------------------------
-- public.teams
-- ---------------------------------------------------------------------------
CREATE TABLE public.teams (
  -- data-model.md § Entity 1: internal stable identifier. The cross-slice FK target.
  -- gen_random_uuid() is available via the pgcrypto extension already enabled by
  -- migration 0001.
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- data-model.md § Entity 1: canonical display name, e.g. "Argentina".
  name            text NOT NULL,

  -- data-model.md § Entity 1: FIFA three-letter code, e.g. "ARG". Locked UNIQUE so
  -- the sync coordinator's adapter UPSERT can resolve "did we see this team before"
  -- by code in addition to the provider external-id mapping.
  short_code      text NOT NULL,

  -- data-model.md § Entity 1: optional CDN flag URL for display. NULL-allowed because
  -- not every team in seed data may have a flag asset on day 1.
  flag_url        text NULL,

  -- Row-create timestamp. Set once by the sync coordinator on first observation.
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Trigger-maintained on every UPDATE (see trigger below). Never set by application
  -- code directly.
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- ---- CHECK constraints (data-model.md § Entity 1 validation rules) ----

  -- name MUST NOT be empty after trim.
  CONSTRAINT teams_name_not_blank
    CHECK (length(trim(name)) > 0),

  -- short_code MUST be exactly three uppercase ASCII letters (FIFA convention).
  CONSTRAINT teams_short_code_format
    CHECK (short_code ~ '^[A-Z]{3}$')
);

-- ---------------------------------------------------------------------------
-- UNIQUE constraint (data-model.md § Entity 1 → indexes)
-- ---------------------------------------------------------------------------

-- Sync coordinator UPSERT lookup + participant-facing display joins. UNIQUE on
-- short_code prevents two team rows from sharing a FIFA code (R-003 idempotency
-- safeguard layered on top of the provider-mapping uniqueness).
ALTER TABLE public.teams
  ADD CONSTRAINT teams_short_code_uk UNIQUE (short_code);

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger (reuses Slice 001's public.set_updated_at())
-- ---------------------------------------------------------------------------
CREATE TRIGGER teams_set_updated_at
  BEFORE UPDATE ON public.teams
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- public.team_provider_external_ids
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 4 (Match Provider External IDs) explicitly notes:
--   "A parallel table team_provider_external_ids follows the same shape for teams"
-- so this table mirrors the match-side mapping: surrogate UUID PK, FK to teams
-- with ON DELETE CASCADE, UNIQUE on (provider_name, provider_team_id) as the
-- sync coordinator's idempotency key.
CREATE TABLE public.team_provider_external_ids (
  -- Surrogate PK for parallel structure with match_provider_external_ids (T004).
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: deleting a team row is rare (admin path; never sync), but
  -- when it happens the mapping rows are internal plumbing and have no
  -- independent meaning.
  team_id            uuid NOT NULL
                       REFERENCES public.teams (id) ON DELETE CASCADE,

  -- Provider identifier, e.g. 'footballdata' or 'stub'. Free-form text rather
  -- than an enum so Slice 008's OD-007 resolution can add providers without a
  -- schema migration.
  provider_name      text NOT NULL,

  -- The provider's native team identifier (often a numeric string in
  -- football-data's API; kept as text for vendor neutrality per Principle I).
  provider_team_id   text NOT NULL,

  -- Set on first INSERT and refreshed on every sync that re-confirms the mapping
  -- (R-003). Operations use this to detect stale mappings post-incident.
  mapped_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- UNIQUE constraint — the sync coordinator's idempotency key (R-003)
-- ---------------------------------------------------------------------------
-- A given (provider, external_id) maps to at most one internal team. The UNIQUE
-- index is what makes the catalog sync UPSERT deterministic and replay-safe.
ALTER TABLE public.team_provider_external_ids
  ADD CONSTRAINT team_provider_external_ids_provider_uk
    UNIQUE (provider_name, provider_team_id);

-- ---------------------------------------------------------------------------
-- Non-unique index — reverse lookup (admin debug, conflict-quarantine forensics)
-- ---------------------------------------------------------------------------
CREATE INDEX team_provider_external_ids_team_idx
  ON public.team_provider_external_ids (team_id);

-- ---------------------------------------------------------------------------
-- Table + column documentation (visible via \d+ and pg_description).
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.teams IS
  'Slice 002 / FR-001 / data-model.md § Entity 1: participating national team. '
  'Locked cross-slice contract — Slices 003-008 FK to teams(id). '
  'Sync coordinator writes via SECURITY DEFINER path; no direct client writes.';

COMMENT ON COLUMN public.teams.id           IS 'data-model.md § Entity 1: internal stable identifier (PK). Cross-slice FK target.';
COMMENT ON COLUMN public.teams.name         IS 'data-model.md § Entity 1: canonical display name, e.g. "Argentina".';
COMMENT ON COLUMN public.teams.short_code   IS 'data-model.md § Entity 1: FIFA three-letter code, e.g. "ARG". UNIQUE.';
COMMENT ON COLUMN public.teams.flag_url     IS 'data-model.md § Entity 1: optional CDN flag URL for display; NULL allowed.';
COMMENT ON COLUMN public.teams.created_at   IS 'Row-create timestamp; set once by the sync coordinator on first observation.';
COMMENT ON COLUMN public.teams.updated_at   IS 'Trigger-maintained on every UPDATE via public.set_updated_at(); never set by application code.';

COMMENT ON TABLE public.team_provider_external_ids IS
  'Slice 002 / data-model.md § Entity 4 (parallel team variant): internal mapping of '
  'team_id to provider-specific identifiers (R-003 idempotency key). Internal-only — '
  'never exposed to participant clients. Sync coordinator writes via SECURITY DEFINER.';

COMMENT ON COLUMN public.team_provider_external_ids.id               IS 'Surrogate PK; parallels match_provider_external_ids.id.';
COMMENT ON COLUMN public.team_provider_external_ids.team_id          IS 'FK to teams(id) ON DELETE CASCADE — mapping rows are internal plumbing without independent meaning.';
COMMENT ON COLUMN public.team_provider_external_ids.provider_name    IS 'Provider identifier (e.g. ''footballdata'', ''stub''). Free-form text for vendor-neutral extensibility (Principle I).';
COMMENT ON COLUMN public.team_provider_external_ids.provider_team_id IS 'Provider''s native team identifier; text for vendor neutrality.';
COMMENT ON COLUMN public.team_provider_external_ids.mapped_at        IS 'Set on first INSERT and refreshed on every confirming sync (R-003 staleness detection).';

COMMIT;
