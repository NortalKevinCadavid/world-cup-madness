-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- Performance budget: p95 < 5 ms over 1,000 invocations. The predicate is
-- called inline by submit_final_prediction (slot 0044), by every
-- /api/me/final-predictions response's lock_state computation, and by every
-- row of Slice 005's peer_final_pick_v filter — it cannot dominate query
-- plans.
--
-- Methodology: setup first_kickoff_utc to a future timestamp (so the
-- predicate exercises both the SELECT-from-tournament_config branch and the
-- comparison branch, not the early-return fail-CLOSED branch). Loop 1,000
-- iterations, each timing a single predicate invocation via
-- clock_timestamp() deltas. clock_timestamp() (unlike now()) is VOLATILE and
-- returns real wall-clock, giving honest per-iteration deltas. Push samples
-- into a temp table, then assert percentile_cont(0.95) < 5 ms.
--
-- Caveat: the predicate is STABLE, which means the query planner is allowed
-- to memoize within a single statement. Each iteration runs a fresh
-- statement (`SELECT public.is_final_prediction_locked() INTO v_result`),
-- so memoization does not unfairly inflate samples — each iteration pays
-- the real lookup cost.
--
-- Pattern: BEGIN / plan(1) / DO loop / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(1);

-- Setup: future kickoff so the predicate exercises the read + comparison.
UPDATE public.tournament_config
   SET value = to_jsonb((now() + interval '1 day')::text)
 WHERE key = 'first_kickoff_utc';

CREATE TEMP TABLE perf_samples (sample_ms double precision) ON COMMIT DROP;

DO $$
DECLARE
  v_start  timestamptz;
  v_end    timestamptz;
  v_result boolean;
  v_i      int;
BEGIN
  FOR v_i IN 1..1000 LOOP
    v_start := clock_timestamp();
    SELECT public.is_final_prediction_locked() INTO v_result;
    v_end := clock_timestamp();
    INSERT INTO perf_samples (sample_ms)
    VALUES (EXTRACT(EPOCH FROM (v_end - v_start)) * 1000.0);
  END LOOP;
END $$;

SELECT ok(
  (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms) FROM perf_samples) < 5.0,
  format(
    'is_final_prediction_locked p95 < 5 ms over 1000 samples (observed: %s ms)',
    (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms)::numeric, 2)
       FROM perf_samples)
  )
);

SELECT * FROM finish();

ROLLBACK;
