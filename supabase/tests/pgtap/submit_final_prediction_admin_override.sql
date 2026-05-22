-- Slice 004 / T026 / US3 / admin_override source label. GREEN now (T016 accepts admin_override as source).
--
-- The 'admin_override' source enum value is reserved for Slice 006's admin
-- wrapper (admin_submit_final_prediction). The submit_final_prediction SP at
-- slot 0044 already accepts 'admin_override' in its source validation (step
-- 2b), and the SP body unconditionally sets created_by = p_participant_id
-- regardless of source channel. The audit trigger at slot 0043 sources the
-- audit_log.actor as COALESCE(NEW.created_by, NEW.participant_id) -- so the
-- audit row's actor will be the participant uuid (charlie), NOT auth.uid().
--
-- This test asserts the contract pieces that T016 owns:
--   (1) admin_override is an accepted source value (no WFP03);
--   (2) the resulting row has source='admin_override';
--   (3) created_by = participant_id per the T016 SP body (always);
--   (4) the audit row records actor = participant_id via the trigger's
--       COALESCE(NEW.created_by, NEW.participant_id) expression.
--
-- pgTAP limitation note: the slot 0043 trigger derives actor from
-- NEW.created_by, NOT from auth.uid(). So this test does not need to
-- manipulate request.jwt.claims. If the audit trigger were ever rewritten
-- to read auth.uid() directly, a future test would need
-- `set_config('request.jwt.claims', '{"sub":"..."}', true)` to populate it
-- inside a pgTAP transaction (auth.uid() defaults to NULL otherwise).
--
-- Slice 006 will add a separate test against the admin wrapper that asserts
-- the actor diverges from participant_id when the admin path overrides
-- created_by; that's not in scope here -- this test verifies only the
-- baseline T016 SP behavior for the 'admin_override' enum value.
--
-- Fixture choice: charlie has NO active champion in slice-004-fixture, so a
-- fresh create lands cleanly. Target: POL.
--
-- Pattern: BEGIN / plan(4) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(4);

-- ---------------------------------------------------------------------------
-- Step 1: invoke the SP with p_source = 'admin_override'. Pin the returned
-- uuid into a session setting for the downstream assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_new_id uuid;
BEGIN
  v_new_id := public.submit_final_prediction(
    '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
    'champion',
    'aaaa0000-0000-0000-0000-000000000004'::uuid,  -- POL
    NULL,
    'admin_override'
  );
  PERFORM set_config('test.new_id', v_new_id::text, false);
END
$$;

-- A1: SP returned a non-null uuid (admin_override is accepted by step 2b's
-- source enum check; no WFP03 was raised).
SELECT isnt(
  current_setting('test.new_id')::uuid,
  NULL,
  'A1 submit_final_prediction with source=admin_override returns non-null uuid'
);

-- A2: new row carries source='admin_override' (the enum value made it
-- through the INSERT and survived the round-trip).
SELECT is(
  (SELECT source::text FROM public.final_predictions
    WHERE id = current_setting('test.new_id')::uuid),
  'admin_override',
  'A2 new row has source=admin_override'
);

-- A3: created_by = participant_id (charlie). T016's SP body always sets
-- created_by = p_participant_id; the source label does not change this.
-- Slice 006's admin wrapper is the layer that will diverge created_by from
-- participant_id (admin's own participants.id != target participant).
SELECT is(
  (SELECT created_by FROM public.final_predictions
    WHERE id = current_setting('test.new_id')::uuid),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'A3 new row.created_by = charlie participants.id (T016 SP always sets created_by = p_participant_id)'
);

-- A4: audit row carries action='final_prediction.created',
-- new_value->>'source' = 'admin_override', AND actor = charlie's
-- participants.id (the slot 0043 trigger sets actor =
-- COALESCE(NEW.created_by, NEW.participant_id) -- both are charlie here).
-- See file header for the pgTAP limitation note re: auth.uid().
SELECT is(
  (SELECT (action, new_value->>'source', actor)
     FROM public.audit_log
    WHERE entity_id = current_setting('test.new_id')::uuid
      AND action    = 'final_prediction.created'),
  ('final_prediction.created'::text,
   'admin_override',
   '33333333-3333-3333-3333-333333333333'::uuid),
  'A4 audit row: action=final_prediction.created, new_value->>''source''=admin_override, actor=charlie (per COALESCE(created_by, participant_id))'
);

SELECT * FROM finish();

ROLLBACK;
