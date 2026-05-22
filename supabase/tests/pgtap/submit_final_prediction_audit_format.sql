-- Slice 004 / T012 / contracts/final-predictions.write.md § Test surface. RED until T016 ships submit_final_prediction SP at slot 0044.
--
-- FR-011 audit-row shape verification for the public.submit_final_prediction
-- SECURITY DEFINER stored procedure. On a happy-path INSERT the slot 0042
-- audit trigger MUST write one 'final_prediction.created' audit_log row
-- containing:
--   - action          = 'final_prediction.created'
--   - entity_type     = 'final_prediction'
--   - entity_id       = the new final_predictions.id
--   - actor           = the participant (NEW.created_by COALESCEd to
--                       participant_id)
--   - source          = 'trigger'
--   - previous_value  IS NULL (it's a create, not an update)
--   - new_value->>'item_kind'        = the item_kind submitted
--   - new_value->>'target_team_id'   = the team uuid (text) for team kinds
--
-- Fixture choice: charlie has no active 'runner_up' row in slice-004-fixture
-- (only best_player -> Pedri). Submit runner_up -> ESP (aaaa0000-...-5).
-- Note ESP is alpha's runner_up too -- per-participant supersede chains are
-- independent, so this does NOT collide.
--
-- Pattern: BEGIN / plan(5) / DO + asserts via set_config / finish / ROLLBACK.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Invoke the SP for charlie + runner_up=ESP. Pin the returned uuid into a
-- session variable for later assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_new_id uuid;
BEGIN
  v_new_id := public.submit_final_prediction(
    '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
    'runner_up',
    'aaaa0000-0000-0000-0000-000000000005'::uuid,  -- ESP
    NULL,
    'ui'
  );
  PERFORM set_config('test.new_id', v_new_id::text, false);
END
$$;

-- A1: A 'final_prediction.created' audit row exists with action +
-- entity_type + source set per the trigger contract.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action      = 'final_prediction.created'
       AND entity_type = 'final_prediction'
       AND entity_id   = current_setting('test.new_id')::uuid
       AND source      = 'trigger'
  ),
  'A1 final_prediction.created audit row: action+entity_type=final_prediction, entity_id=new id, source=trigger'
);

-- A2: actor = charlie's participants.id (the trigger COALESCEs NEW.created_by
-- onto participant_id; both are charlie here).
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action    = 'final_prediction.created'
       AND entity_id = current_setting('test.new_id')::uuid
       AND actor     = '33333333-3333-3333-3333-333333333333'::uuid
  ),
  'A2 final_prediction.created audit row actor = charlie participants.id'
);

-- A3: previous_value IS NULL (create, not update).
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action          = 'final_prediction.created'
       AND entity_id       = current_setting('test.new_id')::uuid
       AND previous_value IS NULL
  ),
  'A3 final_prediction.created audit row has previous_value IS NULL'
);

-- A4: new_value->>'item_kind' = 'runner_up'.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action                  = 'final_prediction.created'
       AND entity_id               = current_setting('test.new_id')::uuid
       AND new_value              IS NOT NULL
       AND new_value->>'item_kind' = 'runner_up'
  ),
  'A4 final_prediction.created audit row new_value->>''item_kind'' = ''runner_up'''
);

-- A5: new_value->>'target_team_id' = ESP uuid as text.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action                       = 'final_prediction.created'
       AND entity_id                    = current_setting('test.new_id')::uuid
       AND new_value->>'target_team_id' = 'aaaa0000-0000-0000-0000-000000000005'
  ),
  'A5 final_prediction.created audit row new_value->>''target_team_id'' = ESP uuid'
);

SELECT * FROM finish();

ROLLBACK;
