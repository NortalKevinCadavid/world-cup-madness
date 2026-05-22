-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 3. Calibrated to now() so the test is location-independent.
--
-- Just OUTSIDE the strict boundary: kickoff = now() + 60min + 1s. The
-- 1-second buffer absorbs the few microseconds now() advances between the
-- INSERT and the predicate's evaluation, so the predicate sees remaining
-- time > 60min -> editable (FALSE).

BEGIN;

SELECT plan(1);

INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status)
SELECT
  'dddd0000-0000-0000-0000-000000000001'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '60 minutes 1 seconds',
  'scheduled'::public.match_status
ON CONFLICT (id) DO UPDATE SET kickoff_utc = EXCLUDED.kickoff_utc, status = EXCLUDED.status;

SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  false,
  'strict_boundary_just_outside: kickoff = now() + 60min + 1s, lock_window=60min -> predicate FALSE'
);

SELECT * FROM finish();

ROLLBACK;
