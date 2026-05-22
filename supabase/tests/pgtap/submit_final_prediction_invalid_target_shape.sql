-- Slice 004 / T012 / contracts/final-predictions.write.md § Test surface. RED until T016 ships submit_final_prediction SP at slot 0044.
--
-- Invalid-target-shape path: submit_final_prediction MUST raise an EXCEPTION
-- with ERRCODE='WFP03' when the (p_item_kind, p_target_team_id,
-- p_target_player_id) triple violates the xor invariant:
--   * champion / runner_up MUST set target_team_id and NULL target_player_id.
--   * top_scorer / best_player MUST set target_player_id and NULL
--     target_team_id.
-- The SP MUST raise on the kind/target-shape validation BEFORE reaching the
-- INSERT (which would itself trip the table CHECK final_predictions_target_xor_kind).
--
-- Two sub-tests in one file, isolated via SAVEPOINTs so that the
-- exception-rollback semantics of throws_ok don't taint the second sub-test.
--
-- Pattern: BEGIN / plan(4) / SAVEPOINT-per-sub-test / finish / ROLLBACK.

BEGIN;

SELECT plan(4);

-- Snapshot total final_predictions count BEFORE either SP call.
CREATE TEMP TABLE _before AS
SELECT count(*) AS fp_count FROM public.final_predictions;

-- ---------------------------------------------------------------------------
-- Sub-test 1: 'champion' kind with target_player_id populated (and
-- target_team_id NULL) -> WFP03.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_champion_with_player;

SELECT throws_ok(
  $$ SELECT public.submit_final_prediction(
       '33333333-3333-3333-3333-333333333333'::uuid,
       'champion',
       NULL,
       'dddd1000-0000-0000-0000-000000000001'::uuid,
       'ui'
     ) $$,
  'WFP03',
  NULL,
  'A1 submit_final_prediction raises ERRCODE=WFP03 when item_kind=champion with target_player_id set (and target_team_id NULL)'
);

ROLLBACK TO SAVEPOINT sp_champion_with_player;

-- ---------------------------------------------------------------------------
-- Sub-test 2: 'top_scorer' kind with target_team_id populated (and
-- target_player_id NULL) -> WFP03.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_topscorer_with_team;

SELECT throws_ok(
  $$ SELECT public.submit_final_prediction(
       '33333333-3333-3333-3333-333333333333'::uuid,
       'top_scorer',
       'aaaa0000-0000-0000-0000-000000000004'::uuid,
       NULL,
       'ui'
     ) $$,
  'WFP03',
  NULL,
  'A2 submit_final_prediction raises ERRCODE=WFP03 when item_kind=top_scorer with target_team_id set (and target_player_id NULL)'
);

ROLLBACK TO SAVEPOINT sp_topscorer_with_team;

-- A3: final_predictions count unchanged after both rejected SP calls.
SELECT is(
  (SELECT count(*) FROM public.final_predictions),
  (SELECT fp_count FROM _before),
  'A3 final_predictions row count is unchanged after both rejected SP calls'
);

-- A4: charlie has no active 'champion' row inserted by sub-test 1, and no
-- active 'top_scorer' row inserted by sub-test 2. (charlie's only fixture
-- pick is best_player=Pedri.)
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.final_predictions
     WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
       AND item_kind IN ('champion', 'top_scorer')
  ),
  'A4 no charlie rows were inserted for item_kind champion or top_scorer'
);

SELECT * FROM finish();

ROLLBACK;
