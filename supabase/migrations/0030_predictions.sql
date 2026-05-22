-- Slice 003 / FR-002 (one active per pair) / data-model.md § Entity 1 / cross-slice locked:
-- predictions.id is referenced by Slice 005 score_records and peer_pick_v. Migration slot
-- 0030 per D-012 (spec said 0029; slice 002's T032 already shipped
-- 0029_sync_lock_helpers.sql).
--
-- This migration creates the public.predictions table that backs the participant-facing
-- match prediction submissions, per research.md § R-002's append-only-with-supersede
-- design: edits never overwrite history. Each submit/edit INSERTs a new row and the
-- previous row's `superseded_at` + `superseded_by` are set to chain the history.
-- The active prediction for a (participant, match) pair is the unique row with
-- `superseded_at IS NULL`, enforced at the storage layer by the
-- `predictions_active_uk` unique partial index (FR-002 + SC-003 invariant).
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS, NO RLS policies, NO GRANT/REVOKE beyond default ownership.
--       T005 owns the full Slice 003 RLS surface (SELECT-only policies; writes go
--       exclusively through the submit_prediction SECURITY DEFINER SP owned by T007).
--   * NO INSERT/UPDATE/DELETE policies, by design (writes via SP only).
--   * NO audit trigger. T006 owns the AFTER INSERT/UPDATE trigger that emits
--       prediction.created / prediction.superseded audit_log rows.
--   * NO seed inserts. T009 owns the tournament_config seed extensions
--       (lock_window_minutes default 60, score_upper_bound default 20).
--
-- updated_at maintenance reuses Slice 001's public.set_updated_at() function established
-- in migration 0001_participants.sql. No new function created here — sharing the trigger
-- function keeps a single source of truth for the updated_at convention across slices.
--
-- The FK on superseded_by → predictions(id) is a self-reference. This is legal inside
-- the same CREATE TABLE because the table identifier is bound the moment CREATE TABLE
-- starts executing; the constraint resolves to the in-flight table.

BEGIN;

-- ---------------------------------------------------------------------------
-- public.prediction_source enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 1: the channel that produced this row. `ui` = Next.js form
-- submission by the participant themselves; `api` = direct POST against the route
-- handler (also participant-initiated, but bypasses the form); `admin_override` is
-- reserved for Slice 006's admin manual-entry path. The submit_prediction SP (T007)
-- branches on source to decide whether `created_by` MUST equal `participant_id`.
CREATE TYPE public.prediction_source AS ENUM ('ui', 'api', 'admin_override');

-- ---------------------------------------------------------------------------
-- public.predictions
-- ---------------------------------------------------------------------------
CREATE TABLE public.predictions (
  -- data-model.md § Entity 1: stable identifier. Referenced by the self-FK
  -- (superseded_by) and by Slice 005's score_records. gen_random_uuid() is
  -- available via pgcrypto, already enabled by migration 0001.
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- data-model.md § Entity 1: the participant whose prediction this is.
  -- ON DELETE RESTRICT so that auth-account deletion never silently drops
  -- prediction history (the append-only contract demands this).
  participant_id     uuid NOT NULL
                       REFERENCES public.participants (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 1: the match being predicted.
  -- ON DELETE RESTRICT to preserve scoring history if a match is ever
  -- administratively removed.
  match_id           uuid NOT NULL
                       REFERENCES public.matches (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 1: predicted home-side score. The non-negative
  -- CHECK is the table-level floor; the upper bound (score_upper_bound,
  -- config-driven per R-006) is enforced by the submit_prediction SP, not
  -- here, so admins can adjust it without a schema migration.
  predicted_home     int NOT NULL CHECK (predicted_home >= 0),

  -- data-model.md § Entity 1: predicted away-side score. Same posture as
  -- predicted_home.
  predicted_away     int NOT NULL CHECK (predicted_away >= 0),

  -- data-model.md § Entity 1: time the row was inserted. Immutable per row
  -- by convention (the supersede UPDATE does not touch this).
  submitted_at       timestamptz NOT NULL DEFAULT now(),

  -- data-model.md § Entity 1: which channel produced this row. See enum
  -- comments above.
  source             public.prediction_source NOT NULL,

  -- data-model.md § Entity 1: set by the supersede UPDATE on the previous
  -- active row when a new row arrives. NULL while the row is still active.
  superseded_at      timestamptz NULL,

  -- data-model.md § Entity 1: the predictions row that replaced this one.
  -- Self-FK (legal inside the same CREATE TABLE). NULL while the row is
  -- still active.
  superseded_by      uuid NULL
                       REFERENCES public.predictions (id),

  -- data-model.md § Entity 1: the participant who actually performed the
  -- write. Equals participant_id for source IN ('ui','api'); differs only
  -- when source='admin_override'. The submit_prediction SP populates this.
  -- NULL allowed because some legacy paths (admin override before Slice 006
  -- lands) may need to leave it unset.
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
  -- fully superseded (both set). Mixed states are forbidden — this is the
  -- structural integrity guard for the append-only chain.
  CONSTRAINT predictions_supersede_consistency
    CHECK ((superseded_at IS NULL) = (superseded_by IS NULL))
);

-- ---------------------------------------------------------------------------
-- UNIQUE PARTIAL INDEX — the FR-002 / SC-003 invariant (storage-layer guarantee)
-- ---------------------------------------------------------------------------
-- At most one active prediction row per (participant, match). This is the
-- exact guarantee FR-002 asks for: "exactly one current prediction per pair."
-- It is intentionally a UNIQUE PARTIAL INDEX (not a UNIQUE constraint) so that
-- the append-only history is unbounded — only active rows participate in the
-- uniqueness check. Constitution Principle VII: storage-layer enforcement is
-- the only way to guarantee SC-003 under concurrent submits.
CREATE UNIQUE INDEX predictions_active_uk
  ON public.predictions (participant_id, match_id)
  WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- Secondary indexes (data-model.md § Entity 1 → Indexes table)
-- ---------------------------------------------------------------------------

-- Slice 005's score_match scans active predictions per match. Partial index
-- keyed only on match_id keeps it tight.
CREATE INDEX predictions_match_active_idx
  ON public.predictions (match_id)
  WHERE superseded_at IS NULL;

-- Personal prediction-history feed: "show me my predictions, newest first."
-- DESC on submitted_at matches the read pattern.
CREATE INDEX predictions_participant_idx
  ON public.predictions (participant_id, submitted_at DESC);

-- Chain-walking ("which row replaced which") for admin forensics and the
-- audit-trail walkers in Slice 006 / Slice 007.
CREATE INDEX predictions_superseded_by_idx
  ON public.predictions (superseded_by);

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger (reuses Slice 001's public.set_updated_at())
-- ---------------------------------------------------------------------------
CREATE TRIGGER predictions_set_updated_at
  BEFORE UPDATE ON public.predictions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMIT;
