-- Slice 003 / T035 / Phase 7 — admin_override SP path coverage.
--
-- Reserves the `source='admin_override'` path in submit_prediction for
-- Slice 006's admin wrapping RPC. The SP itself does NOT distinguish admin
-- vs participant calls — it accepts `p_source='admin_override'` as a valid
-- source enum value (T013, T021), inserts the row with
-- `created_by = p_participant_id` (the TARGET participant, per T013 body),
-- and the slot-0033 audit trigger emits `prediction.created` with
-- `actor = COALESCE(NEW.created_by, NEW.participant_id)`.
--
-- The Slice 006 admin wrapper RPC is expected to set `created_by` to the
-- admin's participant id BEFORE calling submit_prediction (or pass the
-- admin context via a separate parameter in a later SP signature
-- extension). That layered design is out of scope for this slice; T035
-- only proves the SP accepts the source enum and produces an auditable row.
--
-- RED expectation: NONE — the SP already supports this path. T035 verifies
-- the path stays GREEN as the SP evolves.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Setup: pick a scheduled match the target has no existing prediction for.
-- M6 USA-JPN (`bbbb0000-0000-0000-0000-000000000006`) — no slice-003 fixture
-- rows for charlie. Use charlie as the TARGET participant.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_target  uuid := '33333333-3333-3333-3333-333333333333'::uuid;  -- charlie
  v_match   uuid := 'bbbb0000-0000-0000-0000-000000000006'::uuid;  -- M6
  v_new_id  uuid;
BEGIN
  -- Defensive: clear any leftover row from a prior failed test run.
  DELETE FROM public.predictions
   WHERE participant_id = v_target AND match_id = v_match;

  -- Admin override invocation: target=charlie, source='admin_override'.
  -- The SP raises no error; returns the new row's uuid.
  v_new_id := public.submit_prediction(v_target, v_match, 3, 1, 'admin_override');

  PERFORM set_config('test.new_id', v_new_id::text, false);
  PERFORM set_config('test.target', v_target::text, false);
END $$;

-- A1: SP returned a non-null uuid.
SELECT isnt(
  current_setting('test.new_id'),
  '',
  'SP returned a new prediction uuid for admin_override path'
);

-- A2: the new row exists with the expected fields.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.predictions
     WHERE id = current_setting('test.new_id')::uuid
       AND participant_id = current_setting('test.target')::uuid
       AND match_id       = 'bbbb0000-0000-0000-0000-000000000006'::uuid
       AND predicted_home = 3
       AND predicted_away = 1
       AND source         = 'admin_override'
       AND superseded_at IS NULL
  ),
  'new row has target participant_id + scores (3,1) + source=admin_override + active'
);

-- A3: exactly one active row for (target, M6).
SELECT is(
  (SELECT count(*)::int FROM public.predictions
    WHERE participant_id = current_setting('test.target')::uuid
      AND match_id = 'bbbb0000-0000-0000-0000-000000000006'::uuid
      AND superseded_at IS NULL),
  1,
  'exactly one active row for (target, M6) after admin_override insert'
);

-- A4: audit trigger emitted one prediction.created row scoped by entity_id.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'prediction.created'
      AND entity_type = 'prediction'
      AND entity_id = current_setting('test.new_id')::uuid
      AND source = 'trigger'),
  1,
  'one prediction.created audit row for the new admin_override prediction'
);

-- A5: audit actor resolves via COALESCE(created_by, participant_id) — both
-- equal the target's id in T013's current SP body. Slice 006's admin wrapper
-- may layer in `created_by = admin_id` later, at which point the actor
-- flips to the admin; this assertion deliberately checks "target wins"
-- to lock the current SP body's behavior (D-013-resolved baseline).
SELECT is(
  (SELECT actor FROM public.audit_log
    WHERE action = 'prediction.created'
      AND entity_id = current_setting('test.new_id')::uuid
      AND source = 'trigger'
    LIMIT 1),
  current_setting('test.target')::uuid,
  'audit actor = target participant.id (SP body sets created_by = p_participant_id)'
);

SELECT * FROM finish();
ROLLBACK;
