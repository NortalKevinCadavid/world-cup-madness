-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 12. Calibrated to now() so the test is location-independent.
--
-- Performance budget: p95 < 5 ms over 1,000 invocations against a 100-
-- match dataset. The predicate is called inline by submit_prediction, by
-- every catalog row's lock_state computation, and by every row of
-- Slice 005's peer_pick_v filter -- it cannot dominate query plans.
--
-- Approach: synthesize 100 scheduled matches with varied kickoffs, then
-- loop 1,000 times picking a random match and timing a single predicate
-- invocation with clock_timestamp() (which is non-STABLE -- different
-- from now() -- giving real wall-clock deltas per iteration). Push each
-- sample into a temp table and assert percentile_cont(0.95) < 5 ms.

BEGIN;

SELECT plan(1);

-- Bulk-insert 100 matches with the eeee-prefix so they cannot collide
-- with any seeded fixture.
INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status)
SELECT
  ('eeee0000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + (i || ' hours')::interval,
  'scheduled'::public.match_status
FROM generate_series(1, 100) AS i
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE perf_samples (sample_ms double precision) ON COMMIT DROP;

DO $$
DECLARE
  v_id     uuid;
  v_start  timestamptz;
  v_end    timestamptz;
  v_result boolean;
  v_i      int;
BEGIN
  FOR v_i IN 1..1000 LOOP
    SELECT id INTO v_id
      FROM public.matches
     WHERE id::text LIKE 'eeee0000-0000-0000-0000-%'
     ORDER BY random()
     LIMIT 1;
    v_start := clock_timestamp();
    SELECT public.is_prediction_locked(v_id) INTO v_result;
    v_end := clock_timestamp();
    INSERT INTO perf_samples (sample_ms)
    VALUES (EXTRACT(EPOCH FROM (v_end - v_start)) * 1000.0);
  END LOOP;
END $$;

SELECT ok(
  (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms) FROM perf_samples) < 5.0,
  format(
    'is_prediction_locked p95 < 5 ms over 1000 samples (observed: %s ms)',
    (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms)::numeric, 2)
       FROM perf_samples)
  )
);

SELECT * FROM finish();

ROLLBACK;
