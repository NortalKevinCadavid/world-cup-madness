-- Slice 006 / T018 / US2 / contracts/admin-rpcs.write.md + data-model.md. RED until T021/T022/T023/T024 ship.
--
-- Concurrent-trigger rejection: admin1 calls admin_trigger_recalc while a previous
-- 'running' row already exists in score_calculation_runs. Per
-- contracts/admin-rpcs.write.md § admin_trigger_recalc step 7 (and the FR-008
-- "only one recalculation per scope at a time" requirement), the SP MUST detect
-- the contention and RAISE EXCEPTION ERRCODE='WAR06' (concurrent admin action).
--
-- Approach: pgTAP runs in ONE transaction. pg_net's POST to score-trigger fires on
-- COMMIT, which this test never reaches -- so we cannot observe the score-trigger
-- 409 response. The contract therefore REQUIRES the SP to detect the concurrent
-- 'running' run SYNCHRONOUSLY at INSERT time (e.g. via a partial unique index on
-- (scope) WHERE status='running', OR an explicit SELECT FOR UPDATE pre-check, OR
-- the score_calculation_runs_running_idx partial index path). Either way, the
-- correctness boundary that THIS test asserts is: "if a 'running' row already
-- exists for this scope, the SP MUST NOT create a second running row, AND MUST
-- NOT emit a second admin.recalc_triggered audit row, AND MUST raise WAR06."
--
-- Pre-state: we INSERT one fake 'running' row directly (bypassing the SP) BEFORE
-- impersonating admin1. The CHECK score_calculation_runs_reason_required_for_admin_and_config
-- (slot 0050) requires a non-empty reason for trigger='admin_recalc', so the
-- pre-state row uses 'pre-existing fake running run' as its reason.
--
-- Fixture refs:
--   * admin1.participants.id = 77777777-7777-7777-7777-777777777777
--   * admin1.auth.users.id   = 00000000-0000-0000-0000-0000000000d3
--   * Tournament UUID        = 00000000-0000-0000-0000-000000000001 (single tournament; slice 005 fixture)

BEGIN;

SELECT plan(3);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t018_concurrent.admin_pid',  '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t018_concurrent.fake_run_id','11111111-aaaa-bbbb-cccc-dddddddddddd', false);

-- ---------------------------------------------------------------------------
-- Pre-state: a fake 'running' scope='all' run already exists. The SP MUST detect
-- this and raise WAR06 rather than INSERTing a second running row.
-- This INSERT runs as superuser (pgTAP default) -- it bypasses RLS and lets us
-- set up the contention condition independent of the SP.
-- ---------------------------------------------------------------------------
INSERT INTO public.score_calculation_runs (
  id,
  scope,
  target_id,
  "trigger",
  triggered_by,
  reason,
  started_at,
  status
) VALUES (
  current_setting('test.t018_concurrent.fake_run_id')::uuid,
  'all'::public.score_run_scope,
  NULL,
  'admin_recalc'::public.score_run_trigger,
  current_setting('test.t018_concurrent.admin_pid')::uuid,
  'pre-existing fake running run',
  now(),
  'running'::public.score_run_status
);

-- ---------------------------------------------------------------------------
-- Impersonate admin1 and attempt a SECOND admin_trigger_recalc('all', ...).
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub','00000000-0000-0000-0000-0000000000d3','role','authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: WAR06 raised by the SP. throws_ok asserts on SQLSTATE so the test is
-- robust against MESSAGE text drift. Per contract step 7, WAR06 fires on
-- score-trigger 409; the SP MUST detect the equivalent local contention
-- (existing running row for the same scope) and raise WAR06 synchronously.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.admin_trigger_recalc(
      'all',
      NULL,
      'concurrent test',
      NULL
    )$$,
  'WAR06',
  NULL,
  'A1 concurrent admin_trigger_recalc raises ERRCODE=WAR06 (concurrent admin action / scope lock contention)'
);

-- Drop back to superuser for post-state asserts.
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: no NEW score_calculation_runs row created (the pre-existing fake row is
-- the only 'admin_recalc' 'all' row). The SP's INSERT MUST roll back when WAR06
-- is raised (or never execute).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int
     FROM public.score_calculation_runs
    WHERE scope    = 'all'::public.score_run_scope
      AND "trigger" = 'admin_recalc'::public.score_run_trigger),
  1,
  'A2 no NEW score_calculation_runs row inserted by the rejected concurrent call (only the pre-existing fake row remains)'
);

-- ---------------------------------------------------------------------------
-- A3: no admin.recalc_triggered audit row was written by the rejected call.
-- The pre-existing fake run was inserted directly (no audit emission), so this
-- count MUST be zero.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int
     FROM public.audit_log
    WHERE action      = 'admin.recalc_triggered'
      AND entity_type = 'score_calculation_run'
      AND actor       = current_setting('test.t018_concurrent.admin_pid')::uuid),
  0,
  'A3 no admin.recalc_triggered audit row written by the rejected concurrent call'
);

SELECT * FROM finish();
ROLLBACK;
