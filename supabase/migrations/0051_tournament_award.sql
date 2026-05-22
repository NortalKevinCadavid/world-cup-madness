-- Slice 005 / T005 / data-model.md § Entity 3 / research.md § R-007 + R-008.
-- Migration slot 0051 per D-023 (slice 005 renumber).
-- Single-row-per-tournament admin-managed table for FIFA awards.
-- DO NOT call score-trigger from this trigger (T015 owns auto-recalc wiring).
--
-- Entity: tournament_award (data-model.md § Entity 3).
-- Purpose: hold the four final-tournament truth values per tournament:
--   * champion (team)
--   * runner_up (team)
--   * top_scorer (player) — the officially-named FIFA Golden Boot winner; the
--       tiebreaker chain is owned by Slice 002 sync / Slice 006 admin override,
--       not by this table (research.md § R-007).
--   * best_player (player) — the officially-named FIFA Golden Ball winner;
--       supports the "Golden Ball delayed" pending edge case via the
--       best_player_status='pending' branch (research.md § R-008).
-- Each item has an independent (id, status) pair. When *_status='confirmed',
-- the CHECK constraint requires the corresponding *_id to be NOT NULL. The
-- reverse direction is permitted ("we know the value but haven't confirmed it"
-- — used during the FIFA Golden Ball delay edge case in spec.md).
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS, NO RLS policies, NO GRANT/REVOKE beyond default ownership.
--       T007 owns the full Slice 005 RLS surface for score_records,
--       score_calculation_runs, and tournament_award.
--   * NO audit trigger here. T008 / Slice 007 own the AFTER INSERT/UPDATE
--       trigger that emits tournament_award.* audit_log rows.
--   * NO seed inserts. T006 (slot 0058) seeds tournament_config defaults; no
--       tournament_award rows are inserted by this slice's migrations.
--   * NO call to score-trigger Edge Function from the BEFORE UPDATE trigger.
--       T015 owns the AFTER UPDATE auto-recalc wiring (research.md § R-011).
--       The trigger in this migration ONLY maintains set_at.
--
-- Cross-slice references:
--   * teams(id) — Slice 002 (champion_team_id, runner_up_team_id FKs).
--   * players(id) — Slice 004 (top_scorer_player_id, best_player_player_id FKs).
--   * participants(id) — Slice 001 (set_by FK).
--   * tournaments table does NOT yet exist in this codebase; tournament_id
--       PRIMARY KEY is a uuid placeholder per task instructions and per the
--       data-model contract ("one row per tournament"). Slice 002 or a later
--       slice may add the tournaments table and a FK to it; that addition is
--       forward-compatible (an ALTER TABLE ... ADD CONSTRAINT can be added
--       once the upstream table lands).

BEGIN;

-- ---------------------------------------------------------------------------
-- public.award_status enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 3: each of the four award items independently moves
-- from 'pending' (no canonical value yet OR known-but-not-confirmed) to
-- 'confirmed' (canonical and used by score_finals). research.md § R-008: the
-- 'pending' branch is required to handle the FIFA Golden Ball delay edge case
-- without inserting bogus zero-point rows.
CREATE TYPE public.award_status AS ENUM (
  'pending',
  'confirmed'
);

-- ---------------------------------------------------------------------------
-- public.tournament_award
-- ---------------------------------------------------------------------------
CREATE TABLE public.tournament_award (
  -- data-model.md § Entity 3: PK. One row per tournament. No FK to a
  -- tournaments table because that table does not exist in this codebase yet;
  -- a forward-compatible ALTER TABLE ... ADD CONSTRAINT can be added once
  -- Slice 002 (or a later slice) introduces tournaments(id).
  tournament_id            uuid PRIMARY KEY,

  -- data-model.md § Entity 3: champion team id. NULL until the tournament
  -- concludes. ON DELETE RESTRICT to preserve scoring history if a team is
  -- ever administratively removed (parallel to slice 004 final_predictions).
  champion_team_id         uuid NULL
                             REFERENCES public.teams (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 3: confirmation state for the champion item.
  -- score_finals reads ONLY rows where the relevant *_status = 'confirmed'.
  champion_status          public.award_status NOT NULL DEFAULT 'pending',

  -- data-model.md § Entity 3: runner-up team id.
  runner_up_team_id        uuid NULL
                             REFERENCES public.teams (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 3: confirmation state for the runner-up item.
  runner_up_status         public.award_status NOT NULL DEFAULT 'pending',

  -- data-model.md § Entity 3: top scorer player id — the officially-named
  -- FIFA Golden Boot winner (single canonical winner per research.md § R-007;
  -- the goals/minutes/assists tiebreaker chain is resolved upstream and never
  -- stored as an array here).
  top_scorer_player_id     uuid NULL
                             REFERENCES public.players (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 3: confirmation state for the top scorer item.
  top_scorer_status        public.award_status NOT NULL DEFAULT 'pending',

  -- data-model.md § Entity 3: best player id — the officially-named FIFA
  -- Golden Ball winner (research.md § R-008). The 'pending' status is the
  -- explicit handle for the "Golden Ball delayed" edge case in spec.md;
  -- score_finals skips the best-player item while pending and emits a
  -- 'best_player_pending' note in score_calculation_runs.notes.
  best_player_player_id    uuid NULL
                             REFERENCES public.players (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 3: confirmation state for the best player item.
  best_player_status       public.award_status NOT NULL DEFAULT 'pending',

  -- data-model.md § Entity 3: last write timestamp. Maintained by the BEFORE
  -- UPDATE trigger below (set_at := now() when any of the 8 tracked columns
  -- changes). Defaulted to now() on INSERT.
  set_at                   timestamptz NOT NULL DEFAULT now(),

  -- data-model.md § Entity 3: the participant (admin or system identity) who
  -- performed the most recent write. NULL allowed for system-driven inserts
  -- before a participants row is associated with the system identity.
  set_by                   uuid NULL
                             REFERENCES public.participants (id),

  -- ---- CHECK constraints (data-model.md § Entity 3 validation rules) ----
  --
  -- For each of the four (id, status) pairs: when status='confirmed' the
  -- corresponding id MUST be NOT NULL. The reverse direction is permitted
  -- ("we know the value but haven't confirmed it" — used during the FIFA
  -- Golden Ball delay edge case described in research.md § R-008).
  --
  -- Each pair gets its own named CHECK so a violation message points
  -- directly at the offending pair (admin UX in Slice 006).

  CONSTRAINT tournament_award_champion_confirmed_requires_id
    CHECK (champion_status <> 'confirmed' OR champion_team_id IS NOT NULL),

  CONSTRAINT tournament_award_runner_up_confirmed_requires_id
    CHECK (runner_up_status <> 'confirmed' OR runner_up_team_id IS NOT NULL),

  CONSTRAINT tournament_award_top_scorer_confirmed_requires_id
    CHECK (top_scorer_status <> 'confirmed' OR top_scorer_player_id IS NOT NULL),

  CONSTRAINT tournament_award_best_player_confirmed_requires_id
    CHECK (best_player_status <> 'confirmed' OR best_player_player_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- BEFORE UPDATE trigger: maintain set_at on tracked-column changes
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 3: set_at is auto-updated on last write. The 8
-- tracked columns are the four *_id columns plus the four *_status columns;
-- changes to set_by alone (e.g. admin rotation bookkeeping) do NOT bump
-- set_at, matching the data-model's "last write of a tracked value" semantic.
--
-- The function is intentionally minimal: it ONLY assigns NEW.set_at and
-- returns NEW. No score-trigger Edge Function invocation, no audit_log write,
-- no recalculation kickoff. T015 owns the AFTER UPDATE wiring that fans
-- award changes out to score-trigger (research.md § R-011).
--
-- The IS DISTINCT FROM row-comparison pattern correctly handles NULLs (it
-- treats NULL ≠ value as a distinction, unlike plain =), so a transition
-- from (NULL, 'pending') to (team_id, 'pending') correctly bumps set_at.
CREATE OR REPLACE FUNCTION public.tournament_award_set_at_trigger()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.champion_team_id, NEW.runner_up_team_id, NEW.top_scorer_player_id, NEW.best_player_player_id,
      NEW.champion_status, NEW.runner_up_status, NEW.top_scorer_status, NEW.best_player_status)
     IS DISTINCT FROM
     (OLD.champion_team_id, OLD.runner_up_team_id, OLD.top_scorer_player_id, OLD.best_player_player_id,
      OLD.champion_status, OLD.runner_up_status, OLD.top_scorer_status, OLD.best_player_status) THEN
    NEW.set_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tournament_award_set_at_before_update
  BEFORE UPDATE ON public.tournament_award
  FOR EACH ROW
  EXECUTE FUNCTION public.tournament_award_set_at_trigger();

COMMIT;
