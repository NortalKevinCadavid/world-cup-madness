-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- Far-after case (BR-LOCK-005). Steady-state mid-tournament condition where
-- first_kickoff_utc is well in the past (7 days). The predicate MUST return
-- TRUE (locked). This complements the just_after sibling: the just_after
-- test bracket the strict-inclusive boundary; this test guarantees that the
-- TRUE verdict is durable as the delta grows, not just at the boundary.
--
-- Pattern: BEGIN / plan(1) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(1);

-- Mutate first_kickoff_utc to 7 days in the past.
UPDATE public.tournament_config
   SET value = to_jsonb((now() - interval '7 days')::text)
 WHERE key = 'first_kickoff_utc';

-- A1: first_kickoff_utc 7 days in the past → TRUE (locked).
SELECT is(
  public.is_final_prediction_locked(),
  true,
  'A1 is_final_prediction_locked() returns TRUE when first_kickoff_utc = now() - 7 days (far past)'
);

SELECT * FROM finish();

ROLLBACK;
