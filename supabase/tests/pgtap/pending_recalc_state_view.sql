-- Slice 006 / T018 / US2 / contracts/admin-rpcs.write.md + data-model.md § Pending Recalc State VIEW. RED until T022 (slot 0071) ships public.pending_recalc_state.
--
-- View contract (data-model.md § Pending Recalc State VIEW):
--
--   recalc_pending = TRUE  iff there exists an audit_log row with
--                            action LIKE 'tournament_config.scoring%' AND
--                            occurred_at > COALESCE(max(score_calculation_runs.completed_at)
--                                                       WHERE status='succeeded', '1970-01-01')
--
--   Column shape:
--     - last_scoring_config_change_at         timestamptz
--     - last_successful_recalc_completed_at   timestamptz
--     - pending_config_changes_count          bigint (count(*))
--     - recalc_pending                        boolean
--
-- Cross-slice contract: Slice 008's tournament_config audit MUST emit
--   action='tournament_config.scoring.<key>' for scoring-relevant keys so this view's
--   LIKE filter matches. Slice 006 ships the view; Slice 008 ships the producer.
--
-- This test simulates Slice 008's eventual emission shape by directly INSERTing
-- the audit row (the view is the only thing under test here). admin_rpc is a
-- valid source value post-slot-0064 (CHECK relaxed by migration 0064 to admit
-- 'admin_rpc'); we use it because the spec's Clarifications 2026-05-17 Q3 say
-- scoring-config changes go through the admin RPC family.
--
-- Fixture refs:
--   * admin1.participants.id = 77777777-7777-7777-7777-777777777777

BEGIN;

SELECT plan(4);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs / timestamps.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t018_view.admin_pid',  '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t018_view.config_at',  (now() - INTERVAL '10 minutes')::text, false);
SELECT set_config('test.t018_view.recalc_at',  (now() - INTERVAL '1 minute')::text, false);

-- ---------------------------------------------------------------------------
-- Phase 1 setup: emit a tournament_config.scoring.* audit row. No successful
-- score_calculation_runs row yet exists for any tournament -- so the view's
-- "is there a scoring-config change since the last successful recalc?" answer
-- MUST be TRUE.
-- ---------------------------------------------------------------------------
INSERT INTO public.audit_log (
  actor,
  action,
  entity_type,
  entity_id,
  previous_value,
  new_value,
  reason,
  source_citation,
  source,
  occurred_at
) VALUES (
  current_setting('test.t018_view.admin_pid')::uuid,
  'tournament_config.scoring.match_points.exact',
  'tournament_config',
  NULL,
  '{"value": 10}'::jsonb,
  '{"value": 15}'::jsonb,
  'phase 1: scoring config bumped 10 -> 15',
  'https://internal.example/scoring-policy-update',
  'admin_rpc',
  current_setting('test.t018_view.config_at')::timestamptz
);

-- ---------------------------------------------------------------------------
-- A1: View column shape. recalc_pending IS boolean, last_scoring_config_change_at
-- IS timestamptz, last_successful_recalc_completed_at IS timestamptz. We assert
-- the per-column observable type via pg_typeof.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT pg_typeof(recalc_pending)::text FROM public.pending_recalc_state LIMIT 1),
  'boolean',
  'A1 pending_recalc_state.recalc_pending is BOOLEAN per data-model VIEW contract'
);

-- ---------------------------------------------------------------------------
-- A2: recalc_pending = TRUE after Phase 1 setup. The audit row (occurred 10
-- minutes ago) post-dates the COALESCE-fallback epoch ('1970-01-01') because
-- no succeeded score_calculation_runs row exists.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT recalc_pending FROM public.pending_recalc_state),
  TRUE,
  'A2 recalc_pending=TRUE when a tournament_config.scoring.* audit row exists and no successful recalc has completed since'
);

-- ---------------------------------------------------------------------------
-- Phase 2 setup: simulate a successful recalc that COMPLETED 1 minute ago --
-- AFTER the scoring-config change (10 min ago). The view should now treat the
-- config change as "covered" and report recalc_pending=FALSE.
--
-- score_calculation_runs CHECK score_calculation_runs_succeeded_completeness
-- requires completed_at, affected_record_count, and calculation_version_written
-- when status='succeeded'. We populate all three.
-- ---------------------------------------------------------------------------
INSERT INTO public.score_calculation_runs (
  id,
  scope,
  target_id,
  "trigger",
  triggered_by,
  reason,
  started_at,
  completed_at,
  status,
  affected_record_count,
  calculation_version_written
) VALUES (
  gen_random_uuid(),
  'all'::public.score_run_scope,
  NULL,
  'admin_recalc'::public.score_run_trigger,
  current_setting('test.t018_view.admin_pid')::uuid,
  'phase 2: recalc covers the scoring config change',
  current_setting('test.t018_view.recalc_at')::timestamptz - INTERVAL '30 seconds',
  current_setting('test.t018_view.recalc_at')::timestamptz,
  'succeeded'::public.score_run_status,
  42,
  2
);

-- ---------------------------------------------------------------------------
-- A3: recalc_pending = FALSE after the successful recalc supersedes the config
-- change. The view's logic:
--   max(audit.occurred_at WHERE action LIKE 'tournament_config.scoring%') = -10 min
--   max(score_calculation_runs.completed_at WHERE status='succeeded')      = -1 min
--   -10 min > -1 min  =>  FALSE  =>  recalc_pending = FALSE.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT recalc_pending FROM public.pending_recalc_state),
  FALSE,
  'A3 recalc_pending=FALSE when the last successful recalc completed AFTER the last scoring-config change'
);

-- ---------------------------------------------------------------------------
-- A4: The two timestamp columns surface the correct values post-Phase-2.
-- last_scoring_config_change_at MUST equal the Phase 1 audit row's occurred_at.
-- last_successful_recalc_completed_at MUST equal the Phase 2 run's completed_at.
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.pending_recalc_state
     WHERE last_scoring_config_change_at       = current_setting('test.t018_view.config_at')::timestamptz
       AND last_successful_recalc_completed_at = current_setting('test.t018_view.recalc_at')::timestamptz
  ),
  'A4 view surfaces last_scoring_config_change_at and last_successful_recalc_completed_at with the correct values'
);

SELECT * FROM finish();
ROLLBACK;
