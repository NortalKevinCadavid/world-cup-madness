-- Slice 002 / T004 / FR-001 / FR-002 / data-model.md § Entity 2 (Match).
-- Canonical cross-slice contract for the fixture catalog. Reconciled to data-model.md
-- after T004 first authoring: enum values, column names, and stage enum are the locked
-- cross-slice surface that Slice 003 (locking), Slice 005 (scoring trigger), and Slice
-- 006 (admin overrides) consume by name. NO RLS (T009), NO audit (T008), NO seed (T012).

BEGIN;

-- ---------------------------------------------------------------------------
-- public.match_stage enum
-- ---------------------------------------------------------------------------
-- Canonical short codes per data-model.md § Entity 2 and
-- contracts/provider-adapter.contract.md (NormalizedFixture.stage).
-- Group stage uses 'group' + a non-null matches.group_id; knockout rounds use
-- the short codes r16/qf/sf/final/third_place with matches.group_id NULL.
CREATE TYPE public.match_stage AS ENUM (
  'group',
  'r16',
  'qf',
  'sf',
  'final',
  'third_place'
);

-- ---------------------------------------------------------------------------
-- public.match_status enum
-- ---------------------------------------------------------------------------
-- FR-001 lifecycle. Slice 003 reads 'scheduled' vs 'in_progress' for lock
-- decisions. Slice 005's score-trigger fires on transition to 'finished'.
-- Backward transitions in sync paths fall into the conflict-quarantine path
-- (R-005); the trigger in T008 enforces the allowed transition graph.
CREATE TYPE public.match_status AS ENUM (
  'scheduled',
  'in_progress',
  'finished',
  'postponed',
  'cancelled'
);

-- ---------------------------------------------------------------------------
-- public.matches
-- ---------------------------------------------------------------------------
CREATE TABLE public.matches (
  -- FR-001: internal stable identifier — cross-slice FK target.
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FR-001: home/away team refs. ON DELETE RESTRICT so teams cannot be
  -- silently removed while fixtures point at them.
  home_team_id    uuid NOT NULL REFERENCES public.teams (id) ON DELETE RESTRICT,
  away_team_id    uuid NOT NULL REFERENCES public.teams (id) ON DELETE RESTRICT,

  -- FR-001: tournament stage (canonical enum per data-model.md § Entity 2).
  stage           public.match_stage NOT NULL,

  -- FR-001: group letter 'A'..'L' for group-stage fixtures; NULL otherwise.
  -- Constraint below enforces (stage='group') <=> (group_id IS NOT NULL).
  group_id        text NULL,

  -- FR-002 / Principle VI: canonical UTC kickoff. Every downstream slice
  -- (locking, /api/matches sort+filter, scoring trigger) reads this column.
  -- Clients localize via Intl.DateTimeFormat; the column itself is UTC.
  kickoff_utc     timestamptz NOT NULL,

  -- FR-001: optional human-readable venue label. Display-only.
  venue           text NULL,

  -- FR-001: current lifecycle state. Default 'scheduled' on first sync;
  -- T008's audit trigger records every transition.
  status          public.match_status NOT NULL DEFAULT 'scheduled',

  -- Updated by every sync run that touches this row. Distinct from
  -- updated_at (server-internal mutation timestamp) so the coordinator can
  -- detect rows the provider has stopped reporting.
  last_synced_at  timestamptz NOT NULL DEFAULT now(),

  -- Standard row timestamps. updated_at is trigger-maintained below.
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Cross-slice locked invariant: a fixture cannot pit a team against itself.
  CONSTRAINT matches_distinct_teams
    CHECK (home_team_id <> away_team_id),

  -- Cross-slice locked invariant per data-model.md § Entity 2: group_id is
  -- exactly populated for group-stage fixtures.
  CONSTRAINT matches_group_id_consistency
    CHECK ((stage = 'group') = (group_id IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Indexes on public.matches (names per data-model.md § Entity 2 Indexes table)
-- ---------------------------------------------------------------------------
CREATE INDEX matches_kickoff_utc_idx
  ON public.matches (kickoff_utc);

CREATE INDEX matches_stage_group_idx
  ON public.matches (stage, group_id);

CREATE INDEX matches_status_kickoff_idx
  ON public.matches (status, kickoff_utc);

CREATE INDEX matches_home_team_idx
  ON public.matches (home_team_id, kickoff_utc DESC);

CREATE INDEX matches_away_team_idx
  ON public.matches (away_team_id, kickoff_utc DESC);

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuses slice 001's public.set_updated_at())
-- ---------------------------------------------------------------------------
CREATE TRIGGER matches_set_updated_at
  BEFORE UPDATE ON public.matches
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- public.match_provider_external_ids (parallels team_provider_external_ids)
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 4. Maps internal match_id ↔ provider-specific ids.
-- Coordinator's idempotency key is UNIQUE (provider_name, provider_match_id).
-- Surrogate UUID PK mirrors team_provider_external_ids from T003 (parallel
-- shape per data-model.md § Entity 4 final paragraph). Internal-only —
-- never surfaced to participant clients.
CREATE TABLE public.match_provider_external_ids (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id            uuid NOT NULL REFERENCES public.matches (id) ON DELETE CASCADE,
  provider_name       text NOT NULL,
  provider_match_id   text NOT NULL,
  mapped_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.match_provider_external_ids
  ADD CONSTRAINT match_provider_external_ids_provider_uk
    UNIQUE (provider_name, provider_match_id);

CREATE INDEX match_provider_external_ids_match_idx
  ON public.match_provider_external_ids (match_id);

COMMIT;
