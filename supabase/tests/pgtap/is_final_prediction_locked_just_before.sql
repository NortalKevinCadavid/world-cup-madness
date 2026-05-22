-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- Strict-boundary "just before" case (BR-LOCK-005). With first_kickoff_utc
-- ONE MILLISECOND in the future of now(), the predicate's `now() >= v_first`
-- comparison MUST evaluate FALSE (still editable). This is the
-- one-millisecond-from-locked test that safeguards SC-001 — the contract's
-- promise that the strict-inclusive boundary is exact (not fuzzy).
--
-- Note: now() is the transaction timestamp (fixed). After we evaluate
-- `now() + interval '1 millisecond'` once at UPDATE time, the predicate
-- re-evaluates now() to the SAME transaction_timestamp, so the stored
-- v_first_kickoff is reliably 1 ms greater than the predicate's now().
--
-- Pattern: BEGIN / plan(1) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(1);

-- Mutate first_kickoff_utc to now() + 1 millisecond.
UPDATE public.tournament_config
   SET value = to_jsonb((now() + interval '1 millisecond')::text)
 WHERE key = 'first_kickoff_utc';

-- A1: first_kickoff_utc 1 ms in the future of txn now() → FALSE (editable).
SELECT is(
  public.is_final_prediction_locked(),
  false,
  'A1 is_final_prediction_locked() returns FALSE when first_kickoff_utc = now() + 1 ms (strict boundary just-before)'
);

SELECT * FROM finish();

ROLLBACK;
