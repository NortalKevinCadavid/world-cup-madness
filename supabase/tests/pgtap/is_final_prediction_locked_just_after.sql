-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- Strict-boundary "just after" case (BR-LOCK-005). With first_kickoff_utc
-- ONE MILLISECOND in the past of now(), the predicate's `now() >= v_first`
-- comparison MUST evaluate TRUE (locked). Pairs with the just_before sibling
-- to bracket the strict-inclusive boundary at ±1 ms; SC-001 safeguard.
--
-- Pattern: BEGIN / plan(1) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(1);

-- Mutate first_kickoff_utc to now() - 1 millisecond.
UPDATE public.tournament_config
   SET value = to_jsonb((now() - interval '1 millisecond')::text)
 WHERE key = 'first_kickoff_utc';

-- A1: first_kickoff_utc 1 ms in the past of txn now() → TRUE (locked).
SELECT is(
  public.is_final_prediction_locked(),
  true,
  'A1 is_final_prediction_locked() returns TRUE when first_kickoff_utc = now() - 1 ms (strict boundary just-after)'
);

SELECT * FROM finish();

ROLLBACK;
