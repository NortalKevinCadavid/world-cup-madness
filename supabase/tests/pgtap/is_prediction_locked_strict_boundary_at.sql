-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 2. Calibrated to now() so the test is location-independent.
--
-- BR-LOCK-002 strict boundary: at exactly kickoff_utc - lock_window the
-- match IS locked (the rule is >=, not >). Kickoff set to now() + 60min
-- with lock_window=60. Between INSERT and SELECT now() advances a few
-- microseconds, so now()_at_select >= (now()_at_insert + 60min) - 60min
-- = now()_at_insert -> TRUE robustly.

BEGIN;

SELECT plan(1);

INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status)
SELECT
  'dddd0000-0000-0000-0000-000000000001'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '60 minutes',
  'scheduled'::public.match_status
ON CONFLICT (id) DO UPDATE SET kickoff_utc = EXCLUDED.kickoff_utc, status = EXCLUDED.status;

SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  true,
  'strict_boundary_at: kickoff = now() + 60min, lock_window=60min -> predicate TRUE (BR-LOCK-002 >=)'
);

SELECT * FROM finish();

ROLLBACK;
