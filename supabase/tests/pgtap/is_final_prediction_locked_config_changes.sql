-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- SC-005 responsiveness: when an admin mutates tournament_config.first_kickoff_utc
-- via Slice 008's UI, the predicate's verdict MUST observe the new value on
-- the very next call. The predicate is declared STABLE so memoization is
-- query-scoped, NOT transaction-scoped — separate SELECT statements re-read
-- tournament_config and re-evaluate.
--
-- This test drives two state transitions inside one txn:
--   1. first_kickoff_utc → future (now + 1 day): predicate FALSE (editable).
--   2. first_kickoff_utc → past (now - 1 day): predicate TRUE (locked).
--
-- The outer ROLLBACK restores the slice-004 fixture's seeded row.
--
-- Pattern: BEGIN / plan(2) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- State A: future kickoff → predicate FALSE.
UPDATE public.tournament_config
   SET value = to_jsonb((now() + interval '1 day')::text)
 WHERE key = 'first_kickoff_utc';

SELECT is(
  public.is_final_prediction_locked(),
  false,
  'A1 config_changes: first_kickoff_utc = now() + 1 day → predicate FALSE (editable)'
);

-- State B: flip to past kickoff in the same txn → predicate TRUE.
UPDATE public.tournament_config
   SET value = to_jsonb((now() - interval '1 day')::text)
 WHERE key = 'first_kickoff_utc';

SELECT is(
  public.is_final_prediction_locked(),
  true,
  'A2 config_changes: first_kickoff_utc flipped to now() - 1 day → predicate TRUE (locked); same txn, no caching'
);

SELECT * FROM finish();

ROLLBACK;
