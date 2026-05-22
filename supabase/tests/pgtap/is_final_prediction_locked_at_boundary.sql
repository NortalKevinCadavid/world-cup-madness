-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- BR-LOCK-005 strict-INCLUSIVE boundary: at exactly first_kickoff_utc the
-- predicate MUST return TRUE (locked). The contract body uses
-- `now() >= v_first_kickoff` — the `>=` is the load-bearing operator. This
-- test pins now() into a snapshot variable, sets first_kickoff_utc to that
-- exact instant, and asserts the predicate returns TRUE.
--
-- A2 verifies STABLE memoization within the txn: a second call to the
-- predicate at the same boundary value still returns TRUE (i.e. the verdict
-- did not flip mid-txn).
--
-- Note on now() inside a transaction: now() is FIXED at txn start (it is
-- transaction_timestamp()). So snapshotting v_now := now() at the top of the
-- DO block and then re-evaluating now() inside the predicate yields the same
-- timestamp — that is precisely what makes the equality case testable.
--
-- Pattern: BEGIN / plan(2) / DO setup + asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- Snapshot now() and UPDATE first_kickoff_utc to that exact value so the
-- predicate's now() >= v_first_kickoff comparison hits the strict-inclusive
-- equality branch.
DO $$
DECLARE
  v_now timestamptz := now();
BEGIN
  UPDATE public.tournament_config
     SET value = to_jsonb(v_now::text)
   WHERE key = 'first_kickoff_utc';
END $$;

-- A1: at exactly first_kickoff_utc, the predicate returns TRUE (BR-LOCK-005
-- strict-inclusive: now() >= first_kickoff_utc fires the lock).
SELECT is(
  public.is_final_prediction_locked(),
  true,
  'A1 is_final_prediction_locked() returns TRUE at the boundary (now() = first_kickoff_utc, >= inclusive)'
);

-- A2: a follow-up call in the SAME transaction still returns TRUE — now() is
-- transaction_timestamp() (fixed for the txn), so the boundary verdict is
-- stable within the txn.
SELECT is(
  public.is_final_prediction_locked(),
  true,
  'A2 second invocation in the same txn still returns TRUE (now() = txn_timestamp, verdict stable)'
);

SELECT * FROM finish();

ROLLBACK;
