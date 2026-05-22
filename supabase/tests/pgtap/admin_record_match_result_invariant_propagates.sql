-- Slice 006 / T010 / US1 / contracts/admin-rpcs.write.md. RED until T013 ships admin_record_match_result at on-disk slot 0064 per D-026.
--
-- Underlying-invariant propagation path: admin1 (authorized, with non-empty
-- reason + source) submits a payload that violates slice 002's
-- `for_scoring <= official` invariant (here: p_home_score_for_scoring=5 with
-- p_home_score_official=2). Slice 002's record_match_result SP (migration
-- 0024) raises ERRCODE='22023' with MESSAGE 'for_scoring exceeds official
-- score (forbidden by contract)'. The admin RPC body MUST propagate the
-- underlying SP's exception as ERRCODE='WAR05' (contracts/admin-rpcs.write.md
-- § ERRCODE values: "invariant violation propagated from underlying SP").
--
-- The contract § admin_record_match_result step 5 says:
--   "On underlying SP exception: propagate (map to WAR05 with the original
--    ERRCODE preserved in MESSAGE)."
--
-- match_results MUST NOT be partially updated: the underlying SP raises
-- BEFORE the UPSERT, so the row stays at its 2-1 fixture pre-state. The
-- transaction-rollback of the admin RPC's failed call cleans up any audit
-- side-effects.
--
-- Audit-row policy on invariant-propagation failures: the contract § Audit
-- emission pattern documents that audit rows are written AFTER successful
-- delegation. By implication, an admin RPC call that fails inside the
-- underlying SP MUST NOT emit the `admin.match_result_corrected` audit row.
-- The admin.access_denied audit row (WAR01 path) is a different shape and
-- doesn't apply here. This file asserts: NO admin.match_result_corrected
-- audit row written for M1 by this call (i.e. the count is unchanged from
-- baseline).
--
-- Fixture refs:
--   * admin1 / M1 -- same as the happy-path file.

BEGIN;

SELECT plan(3);

SELECT set_config('test.t010_invariant.m1', 'eeee0050-0000-0000-0000-000000000001', false);

-- Pre-state snapshot.
SELECT set_config(
  'test.t010_invariant.m1_prestate',
  (SELECT ROW(home_score, away_score, home_score_for_scoring, away_score_for_scoring)::text
     FROM public.match_results
    WHERE match_id = current_setting('test.t010_invariant.m1')::uuid),
  false
);

-- Baseline audit count for the action this call MUST NOT emit.
SELECT set_config(
  'test.t010_invariant.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.match_result_corrected'
      AND entity_type = 'match_result'
      AND entity_id = current_setting('test.t010_invariant.m1')::uuid),
  false
);

-- ---------------------------------------------------------------------------
-- Impersonate admin1.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: WAR05 ERRCODE raised when slice 002's for_scoring <= official
-- invariant is violated. Slice 002's underlying SP raises 22023; the admin
-- RPC propagates it as WAR05 with the original 22023 preserved in MESSAGE.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.admin_record_match_result(
      'eeee0050-0000-0000-0000-000000000001'::uuid,
      2,                                       -- p_home_score_official
      2,                                       -- p_away_score_official
      5,                                       -- p_home_score_for_scoring (> official -> invariant violation)
      2,                                       -- p_away_score_for_scoring
      'regulation',
      'reproducing invariant',                 -- p_reason non-empty (passes WAR02)
      'https://fifa.example/repro'             -- p_source_citation non-empty (passes WAR03)
    )$$,
  'WAR05',
  NULL,
  'A1 for_scoring > official propagates as ERRCODE=WAR05 (invariant violation from slice 002 SP)'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: match_results UNCHANGED. The slice 002 SP raises BEFORE the UPSERT,
-- so the row stays at the 2-1 fixture pre-state.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT ROW(home_score, away_score, home_score_for_scoring, away_score_for_scoring)::text
     FROM public.match_results
    WHERE match_id = current_setting('test.t010_invariant.m1')::uuid),
  current_setting('test.t010_invariant.m1_prestate'),
  'A2 match_results row for M1 UNCHANGED by rejected invariant-violating call'
);

-- ---------------------------------------------------------------------------
-- A3: NO admin.match_result_corrected audit row emitted for this call. The
-- audit emission step (contract § Audit emission pattern) runs ONLY after
-- successful delegation; an underlying-SP exception MUST short-circuit
-- before that step. Count vs baseline -- a delta of zero proves no row was
-- written and survived.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.match_result_corrected'
      AND entity_type = 'match_result'
      AND entity_id = current_setting('test.t010_invariant.m1')::uuid),
  current_setting('test.t010_invariant.audit_baseline')::int,
  'A3 no admin.match_result_corrected audit row emitted for invariant-violating call (delta from baseline = 0)'
);

SELECT * FROM finish();
ROLLBACK;
