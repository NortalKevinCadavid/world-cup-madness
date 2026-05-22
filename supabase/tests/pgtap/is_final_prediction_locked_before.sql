-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- BR-LOCK-005 strict-inclusive boundary, "before" case: when
-- tournament_config.first_kickoff_utc is firmly in the future, the predicate
-- MUST return FALSE (editable). This is the canonical pre-tournament state.
--
-- The slice-004 fixture seeds first_kickoff_utc='"2026-06-16T20:00:00Z"', so
-- we explicitly UPDATE to (now() + 1 day) to make the test location- and
-- date-independent. The outer ROLLBACK restores the seed value.
--
-- Volatility assertion (A2): the predicate MUST be declared STABLE per the
-- contract (memoization within a query; re-eval between txns).
--
-- Pattern: BEGIN / plan(2) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- Mutate first_kickoff_utc to one day in the future. to_jsonb(text) wraps in
-- a JSON string scalar so the predicate's (value::text)::timestamptz cast
-- (slot 0041) parses successfully.
UPDATE public.tournament_config
   SET value = to_jsonb((now() + interval '1 day')::text)
 WHERE key = 'first_kickoff_utc';

-- A1: first_kickoff_utc 1 day in the future → predicate FALSE (editable).
SELECT is(
  public.is_final_prediction_locked(),
  false,
  'A1 is_final_prediction_locked() returns FALSE when first_kickoff_utc = now() + 1 day'
);

-- A2: the function is declared STABLE per the locked cross-slice contract.
SELECT is(
  (SELECT provolatile FROM pg_proc
    WHERE oid = 'public.is_final_prediction_locked()'::regprocedure),
  's'::"char",
  'A2 is_final_prediction_locked() is declared STABLE (provolatile = s)'
);

SELECT * FROM finish();

ROLLBACK;
