-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 5. Calibrated to now() so the test is location-independent.
--
-- BR-LOCK-004: any non-scheduled status locks the match regardless of
-- remaining time. Use a match whose kickoff is 24h away (far outside the
-- lock window) but status='in_progress' -- the status check fires before
-- the time check, so the predicate must return TRUE.

BEGIN;

SELECT plan(1);

INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status)
SELECT
  'dddd0000-0000-0000-0000-000000000001'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '24 hours',
  'in_progress'::public.match_status
ON CONFLICT (id) DO UPDATE SET kickoff_utc = EXCLUDED.kickoff_utc, status = EXCLUDED.status;

SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  true,
  'status_in_progress: status=in_progress with kickoff 24h out -> predicate TRUE (BR-LOCK-004 overrides time)'
);

SELECT * FROM finish();

ROLLBACK;
