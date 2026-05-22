-- Slice 004 / T012 / contracts/final-predictions.write.md § Test surface. RED until T016 ships submit_final_prediction SP at slot 0044.
--
-- Happy-path exercise of the not-yet-implemented public.submit_final_prediction
-- for a PLAYER-kind item: top_scorer. Mirrors create_champion_happy.sql
-- structure but populates target_player_id (not target_team_id), satisfying
-- the CHECK final_predictions_target_xor_kind for player kinds.
--
-- Fixture choice: charlie (33333333-...-3) has only ONE pre-seeded final
-- prediction (Row 6: best_player -> Pedri). No active 'top_scorer' row exists
-- for charlie, so we can submit a top_scorer pick straight into a clean slot.
-- Target player: Messi (dddd1000-...-1) -- alpha already top_scorer=Messi but
-- top_scorer picks are independent per-participant; nothing prevents charlie
-- from selecting the same player.
--
-- Pattern: BEGIN / plan(N) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Snapshot counts BEFORE the SP call.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _before AS
SELECT
  (SELECT count(*) FROM public.final_predictions)                                  AS fp_count,
  (SELECT count(*) FROM public.audit_log WHERE action = 'final_prediction.created') AS audit_count;

CREATE TEMP TABLE sp_result (new_fp_id uuid);

INSERT INTO sp_result (new_fp_id)
SELECT public.submit_final_prediction(
  '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
  'top_scorer',
  NULL,
  'dddd1000-0000-0000-0000-000000000001'::uuid,  -- Messi
  'ui'
);

-- A1: SP returned a non-null uuid.
SELECT isnt(
  (SELECT new_fp_id FROM sp_result),
  NULL,
  'A1 submit_final_prediction returned a non-null uuid for charlie + top_scorer=Messi'
);

-- A2: exactly one NEW final_predictions row exists overall.
SELECT is(
  (SELECT count(*) FROM public.final_predictions) - (SELECT fp_count FROM _before),
  1::bigint,
  'A2 exactly one new final_predictions row was inserted'
);

-- A3: the active row for (charlie, top_scorer) has the expected shape -- a
-- player-kind row populates target_player_id only.
SELECT is(
  (SELECT (item_kind::text, target_team_id, target_player_id, source::text, created_by, superseded_at IS NULL)
     FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'top_scorer'
      AND superseded_at IS NULL),
  ('top_scorer',
   NULL::uuid,
   'dddd1000-0000-0000-0000-000000000001'::uuid,
   'ui',
   '33333333-3333-3333-3333-333333333333'::uuid,
   true),
  'A3 the active row for (charlie, top_scorer) has item_kind=top_scorer, target_team_id NULL, target_player_id=Messi, source=ui, created_by=charlie, superseded_at IS NULL'
);

-- A4: the row's id matches the SP's return value.
SELECT is(
  (SELECT id FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'top_scorer'
      AND superseded_at IS NULL),
  (SELECT new_fp_id FROM sp_result),
  'A4 the active final_predictions.id equals the uuid returned by submit_final_prediction'
);

-- A5: exactly one new final_prediction.created audit row points at the new
-- row with entity_type=final_prediction and source=trigger.
SELECT ok(
  (SELECT count(*) FROM public.audit_log WHERE action = 'final_prediction.created')
    - (SELECT audit_count FROM _before) = 1::bigint
  AND EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action      = 'final_prediction.created'
       AND entity_type = 'final_prediction'
       AND source      = 'trigger'
       AND entity_id   = (SELECT new_fp_id FROM sp_result)
  ),
  'A5 exactly one new final_prediction.created audit row exists for the new id with entity_type=final_prediction, source=trigger'
);

SELECT * FROM finish();

ROLLBACK;
