-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 4. Calibrated to now() so the test is location-independent.
--
-- Just INSIDE the strict boundary: kickoff = now() + 59min 59s. Remaining
-- time is strictly less than 60min, so the predicate computes
-- now() >= kickoff - 60min = now() >= now() - 1s -> TRUE.

BEGIN;

SELECT plan(1);

INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status)
SELECT
  'dddd0000-0000-0000-0000-000000000001'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '59 minutes 59 seconds',
  'scheduled'::public.match_status
ON CONFLICT (id) DO UPDATE SET kickoff_utc = EXCLUDED.kickoff_utc, status = EXCLUDED.status;

SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  true,
  'strict_boundary_just_inside: kickoff = now() + 59min 59s, lock_window=60min -> predicate TRUE'
);

SELECT * FROM finish();

ROLLBACK;
