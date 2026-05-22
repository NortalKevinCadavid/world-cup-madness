-- Slice 003 / T010 / contracts/predictions.write.md § Test surface. RED until T013 ships submit_prediction SP at slot 0034.
--
-- Happy-path exercise of the not-yet-implemented public.submit_prediction
-- SECURITY DEFINER stored procedure. Per the contract the SP signature is:
--
--   submit_prediction(
--     p_participant_id uuid,
--     p_match_id       uuid,
--     p_home           int,
--     p_away           int,
--     p_source         text                  -- 'ui' | 'api' | 'admin_override'
--   ) RETURNS uuid
--
-- Fixture choice: alpha (11111111-...-1) has NO existing prediction for M4
-- (MEX-POL scheduled, bbbb0000-...-4) in slice-003-fixture.sql -- alpha's M4
-- pre-seeded row is M5 (api source) + M3 (active+superseded chain) + M4 (1-1).
-- Wait -- Row 5 in the fixture IS alpha's M4 (1-1, ui). We can't use M4 for a
-- "create happy path" without first removing that row. Re-pick: alpha has NO
-- prediction for M2 (CAN-POL in_progress) or M-anything-fresh. But M2 is
-- in_progress -> would trigger lock check and raise WCM02. The only scheduled
-- match where alpha has no active prediction is... none in the slice-003
-- fixture. We delete the pre-seeded M4 row inside the txn so M4 becomes a
-- fresh slot for alpha, then call the SP, then ROLLBACK at the end. The
-- DELETE is safe because we're in an outer txn that is unconditionally rolled
-- back.
--
-- The audit trigger from migration 0033 will write a 'prediction.created'
-- row when the SP's INSERT fires; we assert that side-effect.
--
-- Pattern: BEGIN / plan(N) / asserts / finish / ROLLBACK. ROLLBACK guarantees
-- no residue in either predictions or audit_log.

BEGIN;

SELECT plan(6);

-- ---------------------------------------------------------------------------
-- Pre-state: ensure alpha has no active prediction for M4. The slice-003
-- fixture seeds one (Row 5: 1-1, ui) -- delete it so the SP's INSERT path
-- creates a NEW row from scratch.
-- ---------------------------------------------------------------------------
DELETE FROM public.predictions
 WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
   AND match_id       = 'bbbb0000-0000-0000-0000-000000000004'::uuid;

-- Snapshot counts BEFORE the SP call so we can assert exactly-one-new for
-- both predictions and audit_log.
CREATE TEMP TABLE _before AS
SELECT
  (SELECT count(*) FROM public.predictions)                                   AS pred_count,
  (SELECT count(*) FROM public.audit_log WHERE action = 'prediction.created') AS audit_count;

-- ---------------------------------------------------------------------------
-- Invoke the SP with happy-path arguments. The returned UUID is pinned into
-- a temp table so subsequent assertions can read it without re-invoking.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE sp_result (new_prediction_id uuid);

INSERT INTO sp_result (new_prediction_id)
SELECT public.submit_prediction(
  '11111111-1111-1111-1111-111111111111'::uuid,  -- alpha
  'bbbb0000-0000-0000-0000-000000000004'::uuid,  -- M4 MEX-POL scheduled
  2,
  1,
  'ui'
);

-- A1: SP returned a non-null uuid.
SELECT isnt(
  (SELECT new_prediction_id FROM sp_result),
  NULL,
  'A1 submit_prediction returned a non-null uuid for alpha + M4'
);

-- A2: exactly one NEW predictions row exists overall (count delta = 1).
SELECT is(
  (SELECT count(*) FROM public.predictions) - (SELECT pred_count FROM _before),
  1::bigint,
  'A2 exactly one new predictions row was inserted'
);

-- A3: exactly one ACTIVE row for (alpha, M4) with the submitted scores +
-- source + created_by.
SELECT is(
  (SELECT (predicted_home, predicted_away, source, created_by, superseded_at IS NULL)
     FROM public.predictions
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND match_id       = 'bbbb0000-0000-0000-0000-000000000004'::uuid
      AND superseded_at IS NULL),
  (2, 1, 'ui'::text, '11111111-1111-1111-1111-111111111111'::uuid, true),
  'A3 the active row for (alpha, M4) has predicted_home=2, predicted_away=1, source=ui, created_by=alpha, superseded_at IS NULL'
);

-- A4: the row's id matches the SP's return value.
SELECT is(
  (SELECT id FROM public.predictions
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND match_id       = 'bbbb0000-0000-0000-0000-000000000004'::uuid
      AND superseded_at IS NULL),
  (SELECT new_prediction_id FROM sp_result),
  'A4 the active predictions.id equals the uuid returned by submit_prediction'
);

-- A5: exactly one NEW prediction.created audit row exists (count delta = 1).
SELECT is(
  (SELECT count(*) FROM public.audit_log WHERE action = 'prediction.created')
    - (SELECT audit_count FROM _before),
  1::bigint,
  'A5 exactly one new audit_log row with action=prediction.created was written'
);

-- A6: that audit row points at the new prediction with entity_type='prediction'
-- and source='trigger' (per the slot-0033 trigger).
SELECT is(
  (SELECT (entity_type, source)
     FROM public.audit_log
    WHERE action    = 'prediction.created'
      AND entity_id = (SELECT new_prediction_id FROM sp_result)),
  ('prediction'::text, 'trigger'::text),
  'A6 the new audit row has entity_type=prediction, source=trigger, entity_id=new prediction uuid'
);

SELECT * FROM finish();

ROLLBACK;
