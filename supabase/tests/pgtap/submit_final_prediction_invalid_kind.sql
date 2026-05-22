-- Slice 004 / T012 / contracts/final-predictions.write.md § Test surface. RED until T016 ships submit_final_prediction SP at slot 0044.
--
-- Invalid-kind path: submit_final_prediction MUST raise an EXCEPTION with
-- ERRCODE='WFP03' when p_item_kind is not one of the four enum strings:
-- 'champion', 'runner_up', 'top_scorer', 'best_player'. Per § Stored
-- procedure semantics step 2: validate enum + kind/target shape; on failure
-- write a 'final_prediction.rejected_invalid_input' audit row and
-- RAISE ... ERRCODE='WFP03'. This test asserts the ERRCODE + no-row-inserted
-- invariants only; audit-row shape is covered by the audit_format sibling.
--
-- Fixture choice: charlie + 'nonsense' as p_item_kind, with a valid POL
-- target_team_id. The SP MUST raise on the enum-validation step BEFORE
-- reaching any INSERT.
--
-- Pattern: BEGIN / plan(2) / throws_ok + count-invariant / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- Snapshot total final_predictions count BEFORE the SP call so we can assert
-- nothing was inserted by the failed call.
CREATE TEMP TABLE _before AS
SELECT count(*) AS fp_count FROM public.final_predictions;

-- A1: SP raises ERRCODE WFP03 when p_item_kind='nonsense'.
SELECT throws_ok(
  $$ SELECT public.submit_final_prediction(
       '33333333-3333-3333-3333-333333333333'::uuid,
       'nonsense',
       'aaaa0000-0000-0000-0000-000000000004'::uuid,
       NULL,
       'ui'
     ) $$,
  'WFP03',
  NULL,
  'A1 submit_final_prediction raises ERRCODE=WFP03 when p_item_kind is not in {champion,runner_up,top_scorer,best_player}'
);

-- A2: final_predictions row count unchanged -- the failed SP call inserted
-- nothing.
SELECT is(
  (SELECT count(*) FROM public.final_predictions),
  (SELECT fp_count FROM _before),
  'A2 final_predictions row count is unchanged after the rejected SP call'
);

SELECT * FROM finish();

ROLLBACK;
