-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 10. Calibrated to now() so the test is location-independent.
--
-- SC-005: 1-minute config responsiveness. The predicate always reads
-- tournament_config.lock_window_minutes fresh, so flipping the value mid-
-- transaction changes the next call's verdict.
--
-- Setup: a scheduled match with kickoff = now() + 90min. With the default
-- lock_window=60 the match is editable (90 > 60); with lock_window=120 it
-- is locked (90 < 120). Restore the config back to 60 and re-assert FALSE
-- to prove the predicate respects the live value, not a cached snapshot.
-- The outer ROLLBACK reverts the tournament_config UPDATE.

BEGIN;

SELECT plan(3);

-- Synthesize the match (kickoff 90 minutes out, scheduled).
INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status)
SELECT
  'dddd0000-0000-0000-0000-000000000001'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '90 minutes',
  'scheduled'::public.match_status
ON CONFLICT (id) DO UPDATE SET kickoff_utc = EXCLUDED.kickoff_utc, status = EXCLUDED.status;

-- Ensure starting config = 60 (the slot-0035 seed default).
UPDATE public.tournament_config
   SET value = '60'::jsonb
 WHERE key = 'lock_window_minutes';

-- A1: with lock_window=60 and kickoff 90 min out, predicate = FALSE.
SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  false,
  'config_changes A1: lock_window=60, kickoff = now() + 90min -> predicate FALSE'
);

-- Flip config to 120; the next call must observe the new value.
UPDATE public.tournament_config
   SET value = '120'::jsonb
 WHERE key = 'lock_window_minutes';

-- A2: with lock_window=120 and kickoff 90 min out, predicate = TRUE.
SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  true,
  'config_changes A2: lock_window=120, kickoff = now() + 90min -> predicate TRUE'
);

-- Restore config to 60 and re-verify: predicate must flip back to FALSE.
UPDATE public.tournament_config
   SET value = '60'::jsonb
 WHERE key = 'lock_window_minutes';

-- A3: restored lock_window=60, kickoff still 90 min out -> predicate FALSE.
SELECT is(
  public.is_prediction_locked('dddd0000-0000-0000-0000-000000000001'::uuid),
  false,
  'config_changes A3: lock_window restored to 60 -> predicate FALSE (no caching)'
);

SELECT * FROM finish();

ROLLBACK;
