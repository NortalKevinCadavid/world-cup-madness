-- Slice 004 / T026 / US3 / contracts/final-predictions.write.md § Stored procedure semantics step 7. RED until T029 ships supersede branch at slot 0048.
--
-- Supersede-path exercise of the public.submit_final_prediction SECURITY
-- DEFINER stored procedure. Per the contract (§ Stored procedure semantics,
-- steps 7-10) when an active prediction already exists for (p_participant_id,
-- p_item_kind) the SP MUST:
--   - INSERT a NEW row with superseded_at = NULL (active);
--   - UPDATE the OLD row setting superseded_at = now() and superseded_by =
--     <new id> in the SAME transaction.
-- T016 shipped only the CREATE branch -- when an active row already exists,
-- the INSERT fails with 23505 against final_predictions_active_uk. T029
-- (this Phase 5) will REPLACE that 23505 path with this supersede
-- UPDATE+INSERT chain. Until T029 lands, every assertion below will fail
-- because the SP raises 23505 on call 2.
--
-- Fixture choice: charlie (33333333-...-3) has NO seeded 'champion' row
-- (Row 6 in slice-004-fixture is best_player -> Pedri). We INSERT the OLD
-- 'champion'=ARG row DIRECTLY (bypassing the SP) so we have a pre-existing
-- active row to supersede. The supersede target is BRA via SP call.
--
-- Audit side-effect: the 0043 trigger emits 'final_prediction.created' on the
-- INSERT (NEW.superseded_at IS NULL) AND 'final_prediction.superseded' on the
-- UPDATE (OLD.superseded_at IS NULL -> NEW.superseded_at IS NOT NULL).
--
-- The slice-004 fixture seeds first_kickoff_utc to 2026-06-16, which is
-- comfortably in the future relative to the test clock; the lock predicate
-- returns FALSE without any further setup.
--
-- Pattern: BEGIN / plan(8) / asserts / finish / ROLLBACK. set_config /
-- current_setting carry uuids across DO blocks within the single outer
-- transaction.

BEGIN;

SELECT plan(8);

-- ---------------------------------------------------------------------------
-- Step 1: pre-state. INSERT charlie's existing 'champion' -> ARG row directly
-- (NOT via the SP -- the SP's create-only branch would work here, but using
-- a direct INSERT keeps the test focused on the supersede branch under test
-- and avoids two SP invocations conflating audit-row counts). Pin the
-- inserted id into a session setting.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_old_id uuid;
BEGIN
  INSERT INTO public.final_predictions (
    participant_id,
    item_kind,
    target_team_id,
    target_player_id,
    source,
    created_by
  )
  VALUES (
    '33333333-3333-3333-3333-333333333333'::uuid,        -- charlie
    'champion',
    'aaaa0000-0000-0000-0000-000000000001'::uuid,        -- ARG
    NULL,
    'ui',
    '33333333-3333-3333-3333-333333333333'::uuid
  )
  RETURNING id INTO v_old_id;
  PERFORM set_config('test.old_id', v_old_id::text, false);
END
$$;

-- ---------------------------------------------------------------------------
-- Step 2: call the SP for the SAME (charlie, champion) pair with a different
-- target team (BRA). Per the contract this MUST supersede the OLD row and
-- return the NEW row's uuid. Until T029 ships the supersede branch, this
-- call raises 23505 against final_predictions_active_uk.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_new_id uuid;
BEGIN
  v_new_id := public.submit_final_prediction(
    '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
    'champion',
    'aaaa0000-0000-0000-0000-000000000002'::uuid,  -- BRA
    NULL,
    'ui'
  );
  PERFORM set_config('test.new_id', v_new_id::text, false);
END
$$;

-- A1: exactly one ACTIVE row for (charlie, champion). The supersede invariant
-- guaranteed by the partial unique index on (participant_id, item_kind)
-- WHERE superseded_at IS NULL.
SELECT is(
  (SELECT count(*)::int FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'champion'
      AND superseded_at IS NULL),
  1,
  'A1 exactly one active row for (charlie, champion) after supersede'
);

-- A2: the single active row has target_team_id = BRA and superseded_at IS NULL.
SELECT is(
  (SELECT (target_team_id, superseded_at IS NULL)
     FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'champion'
      AND superseded_at IS NULL),
  ('aaaa0000-0000-0000-0000-000000000002'::uuid, true),
  'A2 active row for (charlie, champion) has target_team_id=BRA and superseded_at IS NULL'
);

-- A3: the OLD row is now superseded (superseded_at IS NOT NULL).
SELECT ok(
  (SELECT superseded_at IS NOT NULL
     FROM public.final_predictions
    WHERE id = current_setting('test.old_id')::uuid),
  'A3 OLD row (champion=ARG) has superseded_at IS NOT NULL after supersede'
);

-- A4: the OLD row's superseded_by points at the NEW row's uuid.
SELECT is(
  (SELECT superseded_by
     FROM public.final_predictions
    WHERE id = current_setting('test.old_id')::uuid),
  current_setting('test.new_id')::uuid,
  'A4 OLD row.superseded_by = NEW row id'
);

-- A5: NEW id != OLD id (chain link, not in-place mutation).
SELECT isnt(
  current_setting('test.new_id')::uuid,
  current_setting('test.old_id')::uuid,
  'A5 NEW row id differs from OLD row id (append-only)'
);

-- A6: exactly one 'final_prediction.created' audit row references the NEW id.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action    = 'final_prediction.created'
      AND entity_id = current_setting('test.new_id')::uuid),
  1,
  'A6 one final_prediction.created audit row references the NEW row id'
);

-- A7: exactly one 'final_prediction.superseded' audit row references the OLD
-- id, AND its new_value->>''superseded_by'' equals the NEW row id.
SELECT is(
  (SELECT (count(*)::int, bool_and(new_value->>'superseded_by' = current_setting('test.new_id')))
     FROM public.audit_log
    WHERE action    = 'final_prediction.superseded'
      AND entity_id = current_setting('test.old_id')::uuid),
  (1, true),
  'A7 one final_prediction.superseded audit row references the OLD id with new_value->>''superseded_by'' = NEW id'
);

-- A8: post-supersede final state of the active row matches the latest SP
-- call (target_team_id = BRA). Belt-and-braces over A2 -- guards against a
-- buggy implementation that inverted the supersede direction.
SELECT is(
  (SELECT target_team_id FROM public.final_predictions
    WHERE id = current_setting('test.new_id')::uuid),
  'aaaa0000-0000-0000-0000-000000000002'::uuid,
  'A8 NEW row.target_team_id = BRA (final state matches latest SP call)'
);

SELECT * FROM finish();

ROLLBACK;
