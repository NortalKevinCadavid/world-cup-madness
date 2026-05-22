-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- Lock-rejection path: submit_final_prediction MUST raise EXCEPTION with
-- ERRCODE='WFP01' (lock_window_passed) when public.is_final_prediction_locked()
-- returns TRUE (per § Semantics step 5 of contracts/final-predictions.write.md).
-- This is the SP-layer enforcement of the global lock — defense-in-depth
-- against the route handler missing the lock check.
--
-- Fixture choice: charlie (33333333-...-3) + champion target POL
-- (aaaa0000-...-4). Slice-004 fixture seeds NO 'champion' row for charlie
-- (Row 6 is best_player=Pedri), so a successful path would create a fresh
-- row; instead, the lock fires and ZERO rows MUST be created.
--
-- Setup: first_kickoff_utc → now() - 1 hour, forcing the predicate TRUE.
-- The outer ROLLBACK restores the slice-004 fixture's seeded value.
--
-- Note on audit: the SP at slot 0044 writes a 'final_prediction.rejected_locked'
-- audit row BEFORE RAISE, per the contract; that assertion is covered by
-- submit_final_prediction_audit_format.sql (T012). This file asserts only
-- the two contract guarantees that THIS test is responsible for: ERRCODE
-- WFP01 + no-row-inserted invariant.
--
-- Pattern: BEGIN / plan(2) / throws_ok + count invariant / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- Force the predicate to return TRUE by pulling first_kickoff_utc into the past.
UPDATE public.tournament_config
   SET value = to_jsonb((now() - interval '1 hour')::text)
 WHERE key = 'first_kickoff_utc';

-- Snapshot count of charlie's champion rows BEFORE the SP call.
CREATE TEMP TABLE _before AS
SELECT count(*) AS fp_count
  FROM public.final_predictions
 WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
   AND item_kind      = 'champion';

-- A1: SP raises ERRCODE WFP01 when the lock predicate returns TRUE.
SELECT throws_ok(
  $$ SELECT public.submit_final_prediction(
       '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
       'champion',
       'aaaa0000-0000-0000-0000-000000000004'::uuid,  -- POL
       NULL,
       'ui'
     ) $$,
  'WFP01',
  NULL,
  'A1 submit_final_prediction raises ERRCODE=WFP01 (lock_window_passed) when is_final_prediction_locked() is TRUE'
);

-- A2: zero new final_predictions rows for (charlie, champion). The SP's
-- exception aborts before step 8's INSERT.
SELECT is(
  (SELECT count(*) FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'champion'),
  (SELECT fp_count FROM _before),
  'A2 no new final_predictions row for (charlie, champion) after the rejected SP call'
);

SELECT * FROM finish();

ROLLBACK;
