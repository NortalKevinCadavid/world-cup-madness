-- Slice 005 / T004 / data-model.md § Entity 2 / research.md § R-002 (idempotency by run_id).
-- Migration slot 0050 per D-023.
-- Adds the FK from score_records.calculation_run_id (deferred from slot 0049 / T003).
-- PK is caller-supplied UUID -- no DEFAULT gen_random_uuid(). Re-inserting with same id raises 23505 (idempotency guard).
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS, NO policies, NO GRANT/REVOKE. T007 owns the RLS surface for this
--       table (admins-only read; service_role-only write).
--   * NO triggers. T014 owns the score_records AFTER INSERT/UPDATE audit
--       trigger; T015 owns the auto-trigger DB wiring that calls the
--       score-trigger Edge Function. This migration only defines storage shape.
--   * NO seed inserts. T011 owns the tournament_config seed; this table is
--       written exclusively by the score_match / score_finals SQL functions
--       (T013) at runtime.
--
-- Column-naming note: data-model.md § Entity 2 is the source of truth for the
-- column set: id, scope, target_id, trigger, triggered_by, reason, started_at,
-- completed_at, status, affected_record_count, calculation_version_written,
-- notes. The "trigger" column name is reserved-ish in SQL but legal as an
-- unquoted identifier (Postgres only reserves it in CREATE TRIGGER context);
-- still, every reference inside this migration double-quotes it for clarity.
--
-- Enum-value note: per data-model.md § Entity 2, score_run_status values are
-- 'running' | 'succeeded' | 'failed' (no 'pending'). New rows are inserted
-- with status='running' by score_match/score_finals; the transition to
-- 'succeeded' or 'failed' is terminal. No DEFAULT on status -- the producer
-- MUST set it explicitly so a forgotten status surfaces as a constraint
-- violation rather than silently landing as 'running'.
--
-- score_records FK installation (R-002): T003 (slot 0049) ships
-- score_records.calculation_run_id as a NOT NULL uuid WITHOUT a FK constraint
-- (the target table did not yet exist). This migration installs the FK via
-- ALTER TABLE at the end, after this table is in place. Same-transaction so
-- a partial migration cannot leave the FK missing.

BEGIN;

-- ---------------------------------------------------------------------------
-- public.score_run_scope enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 2: which subset of records a run scored.
--   * 'match'  -- exactly one match, identified by target_id
--   * 'finals' -- the four final-tournament items (champion, runner_up,
--                 top_scorer, best_player) in one pass
--   * 'all'    -- full re-score of every match plus the final items, used by
--                 the config_change recalculation path (FR-015)
CREATE TYPE public.score_run_scope AS ENUM (
  'match',
  'finals',
  'all'
);

-- ---------------------------------------------------------------------------
-- public.score_run_trigger enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 2: why this run was started.
--   * 'match_finish'    -- auto, fired when match_results lands a finished
--                           match (research.md § R-011 path 1)
--   * 'award_confirmed' -- auto, fired when tournament_award flips a
--                           *_status to 'confirmed' (research.md § R-011 path 2)
--   * 'admin_recalc'    -- admin-initiated, e.g. correction or override
--                           (Slice 006) -- reason text REQUIRED
--   * 'config_change'   -- tournament_config rule-value mutation (FR-015) --
--                           reason text REQUIRED
CREATE TYPE public.score_run_trigger AS ENUM (
  'match_finish',
  'award_confirmed',
  'admin_recalc',
  'config_change'
);

-- ---------------------------------------------------------------------------
-- public.score_run_status enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 2 state transitions:
--   INSERT with 'running' (no completed_at) -> UPDATE to terminal state.
--   'succeeded' sets completed_at + affected_record_count +
--   calculation_version_written. 'failed' sets completed_at + notes only;
--   no version bump.
CREATE TYPE public.score_run_status AS ENUM (
  'running',
  'succeeded',
  'failed'
);

-- ---------------------------------------------------------------------------
-- public.score_calculation_runs
-- ---------------------------------------------------------------------------
CREATE TABLE public.score_calculation_runs (
  -- data-model.md § Entity 2: caller-supplied UUID. The Edge Function (or
  -- admin recalc RPC) generates the run_id once and passes it on every retry
  -- -- a duplicate INSERT raises 23505 (unique_violation), which the caller
  -- treats as "this run already started, do nothing." This is the
  -- idempotency guard from research.md § R-002. DELIBERATELY no DEFAULT.
  id                            uuid PRIMARY KEY,

  -- data-model.md § Entity 2: which subset of records this run is scoring.
  -- See enum comment above.
  scope                         public.score_run_scope NOT NULL,

  -- data-model.md § Entity 2: for scope='match', the match being scored.
  -- NULL for scope IN ('finals','all'). The CHECK constraint below enforces
  -- the population pattern. ON DELETE RESTRICT preserves the run-history
  -- contract even if a match is administratively removed.
  target_id                     uuid NULL
                                  REFERENCES public.matches (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 2: why this run was started. See enum comment.
  -- Note: double-quoted because "trigger" can read ambiguously in DDL
  -- contexts, though Postgres does not reserve it as a column identifier.
  "trigger"                     public.score_run_trigger NOT NULL,

  -- data-model.md § Entity 2: who/what started the run.
  --   * For 'admin_recalc' / 'config_change': a participant id (the admin).
  --   * For 'match_finish' / 'award_confirmed': a synthetic 'system'
  --       participant id (seeded by T006 or a stub; not enforced here -- this
  --       column is NOT NULL only). ON DELETE RESTRICT to preserve the audit
  --       chain.
  triggered_by                  uuid NOT NULL
                                  REFERENCES public.participants (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 2: free-text justification. NULLable in general,
  -- but the CHECK constraint below makes it REQUIRED for 'admin_recalc' and
  -- 'config_change' triggers (FR-015 audit clarity).
  reason                        text NULL,

  -- data-model.md § Entity 2: timestamps. server-default on started_at; the
  -- completed_at remains NULL while status='running'.
  started_at                    timestamptz NOT NULL DEFAULT now(),
  completed_at                  timestamptz NULL,

  -- data-model.md § Entity 2: lifecycle status. See enum comment for state
  -- transitions. NO DEFAULT -- the producer (score_match/score_finals) MUST
  -- set status='running' explicitly so a forgotten status surfaces loudly.
  status                        public.score_run_status NOT NULL,

  -- data-model.md § Entity 2: result counters, populated only on terminal
  -- success transition. NULL until then. Non-negative when set.
  affected_record_count         int NULL,
  calculation_version_written   int NULL,

  -- data-model.md § Entity 2: free-text notes -- e.g. 'best_player_pending'
  -- (research.md § R-008) or a failure message tail. NULL allowed in any
  -- state.
  notes                         text NULL,

  -- ---- CHECK constraints (data-model.md § Entity 2 Validation rules) ----

  -- Lifecycle: completed_at must be at or after started_at when set.
  -- Allows completed_at = started_at (sub-millisecond runs round-trip).
  CONSTRAINT score_calculation_runs_completed_after_started
    CHECK (completed_at IS NULL OR completed_at >= started_at),

  -- Audit clarity: admin_recalc and config_change require a non-empty reason.
  -- Empty-string protection via length(trim(...)) keeps a stray '' from
  -- satisfying the NOT NULL guard with no information content.
  CONSTRAINT score_calculation_runs_reason_required_for_admin_and_config
    CHECK (
      "trigger" NOT IN ('admin_recalc', 'config_change')
      OR (reason IS NOT NULL AND length(trim(reason)) > 0)
    ),

  -- Scope/target consistency: scope='match' requires target_id; the other
  -- two scopes forbid it (a finals or all-scoped run has no single match
  -- focus).
  CONSTRAINT score_calculation_runs_target_xor_scope
    CHECK (
      (scope = 'match' AND target_id IS NOT NULL)
      OR (scope IN ('finals', 'all') AND target_id IS NULL)
    ),

  -- Terminal-success completeness: status='succeeded' MUST land with
  -- completed_at, affected_record_count, AND calculation_version_written all
  -- populated. This is the contract the leaderboard view relies on -- a
  -- successful run that did not record its version is a corruption risk.
  CONSTRAINT score_calculation_runs_succeeded_completeness
    CHECK (
      status <> 'succeeded'
      OR (
        completed_at IS NOT NULL
        AND affected_record_count IS NOT NULL
        AND affected_record_count >= 0
        AND calculation_version_written IS NOT NULL
      )
    ),

  -- Terminal-failure completeness: status='failed' MUST land with
  -- completed_at. notes is recommended but not structurally required (the
  -- failure surface may not always have a message to record).
  CONSTRAINT score_calculation_runs_failed_completeness
    CHECK (status <> 'failed' OR completed_at IS NOT NULL),

  -- Non-negative counter even outside the succeeded branch (defence in depth).
  CONSTRAINT score_calculation_runs_affected_count_non_negative
    CHECK (affected_record_count IS NULL OR affected_record_count >= 0)
);

-- ---------------------------------------------------------------------------
-- Secondary indexes (data-model.md § Entity 2 -- Access patterns)
-- ---------------------------------------------------------------------------

-- Admin investigation: "show me recent runs, newest first."
CREATE INDEX score_calculation_runs_started_at_idx
  ON public.score_calculation_runs (started_at DESC);

-- Admin investigation: "show me runs for a specific match" (scope='match').
-- Partial index keyed only on populated target_id values keeps it tight.
CREATE INDEX score_calculation_runs_target_id_idx
  ON public.score_calculation_runs (target_id)
  WHERE target_id IS NOT NULL;

-- Admin investigation: "show me all in-flight runs" -- partial index keyed
-- only on running rows is normally empty (terminal states dominate) and
-- supports the advisory-lock collision check from research.md § R-011 cheaply.
CREATE INDEX score_calculation_runs_running_idx
  ON public.score_calculation_runs (started_at DESC)
  WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- Install the deferred FK from score_records.run_id (T003 / 0049)
-- ---------------------------------------------------------------------------
-- D-T013-A: slot 0049 declared the column as `run_id` (not `calculation_run_id`).
-- The FK now references the actual on-disk column.
-- T003 (slot 0049) ships score_records.run_id as a NOT NULL uuid column with no
-- FK -- the target table did not yet exist at that point in the migration order.
-- Installing the FK here, in the same transaction as the target table's
-- creation, closes the integrity gap atomically.
-- ON DELETE RESTRICT: deleting a run row is forbidden as long as any
-- score_records reference it (append-only audit posture).
ALTER TABLE public.score_records
  ADD CONSTRAINT score_records_run_id_fk
  FOREIGN KEY (run_id)
  REFERENCES public.score_calculation_runs (id)
  ON DELETE RESTRICT;

COMMIT;
