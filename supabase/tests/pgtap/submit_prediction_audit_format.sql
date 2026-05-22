-- Slice 003 / T018 / contracts/predictions.write.md § Test surface. RED until T021 ships the supersede branch (replaces D-013 WCM06).
--
-- FR-011 audit-row shape verification for the public.submit_prediction
-- SECURITY DEFINER stored procedure. Two call paths are exercised:
--   1. First call for a fresh (participant, match) -> the 0033 trigger
--      writes a 'prediction.created' row on the INSERT.
--   2. Second call for the same pair -> the SP supersedes the OLD row by
--      UPDATE; the 0033 trigger writes a 'prediction.superseded' row on the
--      UPDATE and a separate 'prediction.created' row on the new INSERT.
-- Per spec FR-011 + the 0033 trigger contract, the audit rows MUST have:
--   - entity_type = 'prediction'
--   - entity_id   = the row whose state changed (NEW row for created;
--     OLD row for superseded -- the trigger writes superseded for NEW with
--     entity_id = NEW.id which is the OLD row's id, because the UPDATE
--     fires on the OLD row)
--   - source      = 'trigger'
--   - previous_value / new_value populated per the trigger body
--   - actor       = the participant who owns the change. For created the
--     actor is NEW.created_by (the participant). For superseded the actor
--     is the NEW (replacement) prediction's created_by.
--
-- T021 (the supersede branch) is required for assertion 3+ to pass. Until
-- T021 lands the SP raises WCM06 on call 2 (D-013 provisional reject) and
-- assertions 3, 4, 5 will fail. Assertions 1, 2 may also fail depending on
-- whether the test harness short-circuits at the first FAIL.
--
-- Fixture choice: alpha + M6 (USA-JPN scheduled, bbbb0000-...-6 from
-- slice-002-fixture.sql) -- alpha has NO prediction for M6 in
-- slice-003-fixture.sql, so call 1 takes the CREATE branch with no
-- pre-existing row. M6 is 'scheduled' and well outside the lock window
-- (kickoff 2026-06-14T20:00:00Z) for the slice-003 simulated clock.
--
-- Pattern: BEGIN / plan(5) / DO + asserts / finish / ROLLBACK.
-- set_config/current_setting carry uuids across the two DO blocks within
-- the single outer transaction.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Step 1: first SP call for (alpha, M6) with (1, 0). Pre-state: no
-- prediction for this pair. Expected: SP INSERTs new row; trigger writes
-- one 'prediction.created' audit row.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_new_id uuid;
BEGIN
  v_new_id := public.submit_prediction(
    '11111111-1111-1111-1111-111111111111'::uuid,  -- alpha
    'bbbb0000-0000-0000-0000-000000000006'::uuid,  -- M6 USA-JPN scheduled
    1,
    0,
    'ui'
  );
  PERFORM set_config('test.first_id', v_new_id::text, false);
END
$$;

-- A1: prediction.created audit row has the FR-011 shape -- trigger source,
-- entity_type=prediction, previous_value NULL, new_value populated with
-- the submitted scores.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action                       = 'prediction.created'
       AND entity_type                  = 'prediction'
       AND entity_id                    = current_setting('test.first_id')::uuid
       AND source                       = 'trigger'
       AND previous_value              IS NULL
       AND new_value                   IS NOT NULL
       AND new_value->>'predicted_home' = '1'
       AND new_value->>'predicted_away' = '0'
  ),
  'A1 prediction.created audit row: entity_type=prediction, source=trigger, previous_value NULL, new_value carries (1,0)'
);

-- A2: actor on the prediction.created row is alpha's participants.id (the
-- created_by value the trigger COALESCEs onto).
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action    = 'prediction.created'
       AND entity_id = current_setting('test.first_id')::uuid
       AND actor     = '11111111-1111-1111-1111-111111111111'::uuid
  ),
  'A2 prediction.created audit row actor = alpha participants.id'
);

-- ---------------------------------------------------------------------------
-- Step 2: second SP call for the same (alpha, M6) with (3, 2). Pre-state:
-- the row from Step 1 is active. Expected (post-T021): SP INSERTs new row
-- AND UPDATEs OLD row setting superseded_at + superseded_by; trigger writes
-- one 'prediction.superseded' row (entity_id = OLD.id) AND one
-- 'prediction.created' row (entity_id = NEW.id).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_new_id uuid;
BEGIN
  v_new_id := public.submit_prediction(
    '11111111-1111-1111-1111-111111111111'::uuid,  -- alpha
    'bbbb0000-0000-0000-0000-000000000006'::uuid,  -- M6 USA-JPN scheduled
    3,
    2,
    'ui'
  );
  PERFORM set_config('test.second_id', v_new_id::text, false);
END
$$;

-- A3: prediction.superseded audit row references the OLD id, carries the
-- OLD scores in previous_value, and shows superseded_at populated in
-- new_value (the trigger sees the post-UPDATE row).
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action                              = 'prediction.superseded'
       AND entity_id                           = current_setting('test.first_id')::uuid
       AND source                              = 'trigger'
       AND previous_value                     IS NOT NULL
       AND new_value                          IS NOT NULL
       AND previous_value->>'predicted_home'   = '1'
       AND previous_value->>'predicted_away'   = '0'
       AND new_value->>'superseded_at'        IS NOT NULL
  ),
  'A3 prediction.superseded audit row carries previous_value (1,0) and new_value with superseded_at set'
);

-- A4: actor on the prediction.superseded row is the NEW prediction's
-- created_by (alpha here, because alpha submitted both). Per the 0033
-- trigger this resolves via SELECT created_by FROM predictions WHERE id =
-- NEW.superseded_by.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action    = 'prediction.superseded'
       AND entity_id = current_setting('test.first_id')::uuid
       AND actor     = '11111111-1111-1111-1111-111111111111'::uuid
  ),
  'A4 prediction.superseded audit row actor = NEW prediction.created_by (alpha)'
);

-- A5: exactly 3 audit rows total scoped to the two ids in this test --
-- prediction.created for the first id, prediction.superseded for the first
-- id, prediction.created for the second id.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE entity_type = 'prediction'
      AND entity_id IN (
        current_setting('test.first_id')::uuid,
        current_setting('test.second_id')::uuid
      )),
  3,
  'A5 exactly 3 audit rows for the two predictions: 2 prediction.created + 1 prediction.superseded'
);

SELECT * FROM finish();

ROLLBACK;
