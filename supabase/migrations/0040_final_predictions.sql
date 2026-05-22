-- Slice 004 / T004 / FR-009 / data-model.md § Entity 1 (final_predictions).
-- One row per (participant, item_kind) -- 4 active rows max per participant.
-- Same append-only supersede pattern as slice 003 predictions. NO RLS (T007),
-- NO audit (T008), NO seed (T011). Migration slot 0040 per D-016 (spec said
-- 0037; slots 0037-0039 are already taken by Slice 003's submit_prediction
-- supersede, get_lock_states_bulk, and Slice 004's players table from T003).
--
-- Per data-model.md § Entity 1 + research.md § R-001: per-item storage model.
-- Each of the four final-tournament item kinds (champion, runner_up,
-- top_scorer, best_player) is its own row with its own independent supersede
-- chain. Editing the champion pick never touches the other three. The unique
-- partial index `final_predictions_active_uk` on (participant_id, item_kind)
-- WHERE superseded_at IS NULL is the storage-layer guarantee for SC-004
-- ("1,000 concurrent edits, exactly one active").
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS, NO RLS policies, NO GRANT/REVOKE beyond default ownership.
--       T007 owns the full Slice 004 RLS surface (SELECT-only policies; writes
--       go exclusively through the submit_final_prediction SECURITY DEFINER SP
--       owned by T016).
--   * NO INSERT/UPDATE/DELETE policies, by design (writes via SP only).
--   * NO audit trigger. T008 owns the AFTER INSERT/UPDATE trigger that emits
--       final_prediction.created / final_prediction.superseded audit_log rows.
--   * NO seed inserts. T011 owns the tournament_config seed extensions
--       (allow_identical_champion_runner_up default false).
--
-- updated_at maintenance reuses Slice 001's public.set_updated_at() function
-- established in migration 0001_participants.sql. No new function created
-- here -- sharing the trigger function keeps a single source of truth for the
-- updated_at convention across slices.
--
-- The FK on superseded_by -> final_predictions(id) is a self-reference. This
-- is legal inside the same CREATE TABLE because the table identifier is bound
-- the moment CREATE TABLE starts executing; the constraint resolves to the
-- in-flight table.

BEGIN;

-- ---------------------------------------------------------------------------
-- public.final_prediction_item_kind enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 1: the four final-tournament items a participant may
-- predict. Cross-slice locked: Slice 005's score_finals function and
-- peer_final_pick_v view branch on this enum to dispatch team-kind vs
-- player-kind scoring lookups.
CREATE TYPE public.final_prediction_item_kind AS ENUM (
  'champion',
  'runner_up',
  'top_scorer',
  'best_player'
);

-- ---------------------------------------------------------------------------
-- public.final_prediction_source enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 1: the channel that produced this row. `ui` = Next.js
-- form submission by the participant themselves; `api` = direct POST against
-- the route handler (also participant-initiated, but bypasses the form);
-- `admin_override` is reserved for Slice 006's admin manual-entry path. The
-- submit_final_prediction SP (T016) branches on source to decide whether
-- `created_by` MUST equal `participant_id`.
CREATE TYPE public.final_prediction_source AS ENUM (
  'ui',
  'api',
  'admin_override'
);

-- ---------------------------------------------------------------------------
-- public.final_predictions
-- ---------------------------------------------------------------------------
CREATE TABLE public.final_predictions (
  -- data-model.md § Entity 1: stable identifier. Referenced by the self-FK
  -- (superseded_by) and by Slice 005's score_records. gen_random_uuid() is
  -- available via pgcrypto, already enabled by migration 0001.
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- data-model.md § Entity 1: the participant whose final prediction this is.
  -- ON DELETE RESTRICT so that auth-account deletion never silently drops
  -- final-prediction history (the append-only contract demands this).
  participant_id     uuid NOT NULL
                       REFERENCES public.participants (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 1: which of the four final-tournament items this
  -- row predicts. Independent supersede chain per (participant_id, item_kind)
  -- pair -- the unique partial index below enforces "at most one active row
  -- per pair" (FR-010 / SC-004).
  item_kind          public.final_prediction_item_kind NOT NULL,

  -- data-model.md § Entity 1: target team for team-kind items (champion,
  -- runner_up). NULL for player-kind items. ON DELETE RESTRICT to preserve
  -- scoring history if a team is ever administratively removed. The CHECK
  -- constraint below enforces this column is populated iff item_kind is
  -- team-kind.
  target_team_id     uuid NULL
                       REFERENCES public.teams (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 1: target player for player-kind items
  -- (top_scorer, best_player). NULL for team-kind items. ON DELETE RESTRICT
  -- to preserve scoring history. Player soft-delete (removed_at) is the only
  -- supported removal path; see Slice 002 sync coordinator extension (R-004 /
  -- R-013). The CHECK constraint below enforces this column is populated iff
  -- item_kind is player-kind.
  target_player_id   uuid NULL
                       REFERENCES public.players (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 1: time the row was inserted. Immutable per row
  -- by convention (the supersede UPDATE does not touch this).
  submitted_at       timestamptz NOT NULL DEFAULT now(),

  -- data-model.md § Entity 1: which channel produced this row. See enum
  -- comments above.
  source             public.final_prediction_source NOT NULL,

  -- data-model.md § Entity 1: set by the supersede UPDATE on the previous
  -- active row when a new row for the same (participant, item_kind) pair
  -- arrives. NULL while the row is still active.
  superseded_at      timestamptz NULL,

  -- data-model.md § Entity 1: the final_predictions row that replaced this
  -- one. Self-FK (legal inside the same CREATE TABLE). NULL while the row is
  -- still active.
  superseded_by      uuid NULL
                       REFERENCES public.final_predictions (id),

  -- data-model.md § Entity 1: the participant who actually performed the
  -- write. Equals participant_id for source IN ('ui','api'); differs only
  -- when source='admin_override'. The submit_final_prediction SP populates
  -- this. NULL allowed because some legacy paths (admin override before
  -- Slice 006 lands) may need to leave it unset.
  created_by         uuid NULL
                       REFERENCES public.participants (id),

  -- Row-create timestamp; set once on INSERT.
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- Trigger-maintained on every UPDATE via public.set_updated_at(). Updates
  -- only on the supersede UPDATE in practice (no other UPDATE path exists,
  -- because the table has no UPDATE RLS policy).
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- ---- CHECK constraints (data-model.md § Entity 1 validation rules) ----

  -- A row is either fully active (both nullable supersede columns NULL) or
  -- fully superseded (both set). Mixed states are forbidden -- this is the
  -- structural integrity guard for the append-only chain. Same shape as
  -- Slice 003's predictions_supersede_consistency.
  CONSTRAINT final_predictions_supersede_consistency
    CHECK ((superseded_at IS NULL) = (superseded_by IS NULL)),

  -- Exactly ONE of target_team_id / target_player_id is populated per row,
  -- AND it matches the item_kind. team-kind items (champion, runner_up) must
  -- populate target_team_id and leave target_player_id NULL; player-kind
  -- items (top_scorer, best_player) must populate target_player_id and leave
  -- target_team_id NULL. research.md § R-001: this split with CHECK is a
  -- cleaner data model than a polymorphic target_id (which would lose FK
  -- enforcement and require runtime kind-dispatching).
  CONSTRAINT final_predictions_target_xor_kind
    CHECK (
      (item_kind IN ('champion', 'runner_up')
         AND target_team_id IS NOT NULL
         AND target_player_id IS NULL)
      OR
      (item_kind IN ('top_scorer', 'best_player')
         AND target_player_id IS NOT NULL
         AND target_team_id IS NULL)
    )
);

-- ---------------------------------------------------------------------------
-- UNIQUE PARTIAL INDEX -- the FR-010 / SC-004 invariant (storage-layer guarantee)
-- ---------------------------------------------------------------------------
-- At most one active final_predictions row per (participant, item_kind) pair.
-- Independent chain per item kind -- a participant may have up to four active
-- rows (one per kind). SC-004's "1,000 concurrent edits, exactly one active"
-- is a storage-layer guarantee here. UNIQUE PARTIAL (not UNIQUE constraint)
-- so the append-only history is unbounded -- only active rows participate in
-- uniqueness. Slice 005's score_finals reads exactly the active row per pair.
-- Constitution Principle VII: storage-layer enforcement is the only way to
-- guarantee SC-004 under concurrent submits.
CREATE UNIQUE INDEX final_predictions_active_uk
  ON public.final_predictions (participant_id, item_kind)
  WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- Secondary indexes (data-model.md § Entity 1 -> Indexes table)
-- ---------------------------------------------------------------------------

-- Personal final-prediction-history feed: "show me my final picks, newest
-- first." DESC on submitted_at matches the read pattern.
CREATE INDEX final_predictions_participant_idx
  ON public.final_predictions (participant_id, submitted_at DESC);

-- Slice 005 score_finals: "all picks for team X" (champion / runner_up
-- aggregation across participants). Partial index keyed only on team-kind
-- rows keeps it tight.
CREATE INDEX final_predictions_target_team_idx
  ON public.final_predictions (target_team_id)
  WHERE target_team_id IS NOT NULL;

-- Slice 005 score_finals: "all picks for player Y" (top_scorer / best_player
-- aggregation). Partial index keyed only on player-kind rows.
CREATE INDEX final_predictions_target_player_idx
  ON public.final_predictions (target_player_id)
  WHERE target_player_id IS NOT NULL;

-- Chain-walking ("which row replaced which") for admin forensics and the
-- audit-trail walkers in Slice 006 / Slice 007.
CREATE INDEX final_predictions_superseded_by_idx
  ON public.final_predictions (superseded_by);

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger (reuses Slice 001's public.set_updated_at())
-- ---------------------------------------------------------------------------
CREATE TRIGGER final_predictions_set_updated_at
  BEFORE UPDATE ON public.final_predictions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMIT;
