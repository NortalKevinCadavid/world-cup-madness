-- Slice 004 / T012 / contracts/final-predictions.write.md § Test surface. RED until T016 ships submit_final_prediction SP at slot 0044.
--
-- Invalid-target-removed-player path: submit_final_prediction MUST raise an
-- EXCEPTION with ERRCODE='WFP04' when p_target_player_id references a player
-- whose removed_at IS NOT NULL. Per § Stored procedure semantics step 3 the
-- player existence check is "SELECT 1 FROM players WHERE id = ... AND
-- removed_at IS NULL"; zero rows -> RAISE ERRCODE='WFP04' with audit row
-- 'final_prediction.rejected_invalid_target'.
--
-- Pre-state synthesis: pick an existing fixture player (Pedri,
-- dddd1000-...-9) and UPDATE removed_at = now() inside the BEGIN block.
-- The outer ROLLBACK restores Pedri's active state when the test ends.
-- Pedri is referenced by Row 6 of the slice-004 fixture (charlie's
-- best_player) but that fixture row is independent of this SP call -- the
-- SP simply rejects new submissions referencing the now-removed player.
--
-- Pattern: BEGIN / plan(3) / UPDATE-then-throws_ok / finish / ROLLBACK.

BEGIN;

SELECT plan(3);

-- ---------------------------------------------------------------------------
-- Pre-state: mark Pedri removed within this txn (rolled back at finish).
-- ---------------------------------------------------------------------------
UPDATE public.players
   SET removed_at = now()
 WHERE id = 'dddd1000-0000-0000-0000-000000000009'::uuid;

-- Snapshot total final_predictions count BEFORE the SP call so we can
-- assert nothing was inserted.
CREATE TEMP TABLE _before AS
SELECT count(*) AS fp_count FROM public.final_predictions;

-- A1: SP raises ERRCODE WFP04 when p_target_player_id references a player
-- with removed_at IS NOT NULL.
SELECT throws_ok(
  $$ SELECT public.submit_final_prediction(
       '33333333-3333-3333-3333-333333333333'::uuid,
       'top_scorer',
       NULL,
       'dddd1000-0000-0000-0000-000000000009'::uuid,
       'ui'
     ) $$,
  'WFP04',
  NULL,
  'A1 submit_final_prediction raises ERRCODE=WFP04 when p_target_player_id references a player whose removed_at IS NOT NULL'
);

-- A2: final_predictions count unchanged after the failed SP call.
SELECT is(
  (SELECT count(*) FROM public.final_predictions),
  (SELECT fp_count FROM _before),
  'A2 final_predictions row count is unchanged after the rejected SP call'
);

-- A3: charlie has no NEW active 'top_scorer' row referencing the removed
-- player. (The pre-existing Row 6 fixture is best_player -> Pedri, NOT
-- top_scorer, so it must not appear in this filter.)
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.final_predictions
     WHERE participant_id   = '33333333-3333-3333-3333-333333333333'::uuid
       AND item_kind        = 'top_scorer'
       AND target_player_id = 'dddd1000-0000-0000-0000-000000000009'::uuid
  ),
  'A3 no top_scorer row was inserted for charlie referencing the removed player'
);

SELECT * FROM finish();

ROLLBACK;
