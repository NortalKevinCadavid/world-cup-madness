-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 1. Calibrated to now() so the test is location-independent.
--
-- Assertion: a scheduled match with kickoff far in the future (3 hours)
-- against a 60-minute lock_window is NOT locked. The predicate must return
-- FALSE because now() < kickoff_utc - 60min (remaining time > lock_window).

BEGIN;

SELECT plan(1);

-- Synthesize a fresh scheduled match with kickoff 3 hours from now().
-- Two distinct teams pulled from the slice-002 seed (ARG + MEX).
INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status)
SELECT
  'dddd0000-0000-0000-0000-000000000001'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '3 hours',
  'scheduled'::public.match_status
ON CONFLICT (id) DO UPDATE SET kickoff_utc = EXCLUDED.kickoff_utc, status = EXCLUDED.status;

SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  false,
  'far_before: kickoff 3h out, status=scheduled, lock_window=60min -> predicate FALSE'
);

SELECT * FROM finish();

ROLLBACK;
