-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 11. Calibrated to now() so the test is location-independent.
--
-- BR-LOCK-001 / Constitution Principle VI: the predicate uses the
-- database clock (now()) which is timezone-independent UTC inside
-- Postgres. SET LOCAL TIMEZONE alters the *display* of timestamptz values
-- but does NOT change the absolute instant returned by now(); therefore
-- the predicate verdict must be invariant under TIMEZONE changes.
--
-- Setup: a scheduled match at the strict boundary (kickoff = now() + 60min,
-- lock_window=60). Predicate must return TRUE both before and after a
-- timezone change.

BEGIN;

SELECT plan(2);

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

-- Baseline: default UTC timezone (server default).
SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  true,
  'uses_db_clock A1: predicate TRUE under default TIMEZONE'
);

-- Flip TIMEZONE to a far-offset zone; the predicate must be unchanged.
SET LOCAL TIMEZONE = 'America/Los_Angeles';

SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  true,
  'uses_db_clock A2: predicate TRUE under TIMEZONE=America/Los_Angeles (now() is UTC instant)'
);

SELECT * FROM finish();

ROLLBACK;
