-- Slice 003 / T018 / contracts/predictions.write.md § Test surface. RED until T021 ships the supersede branch (replaces D-013 WCM06).
--
-- Supersede-path exercise of the public.submit_prediction SECURITY DEFINER
-- stored procedure. Per the contract (§ Stored procedure semantics, steps
-- 6-10) when an active prediction already exists for (p_participant_id,
-- p_match_id) the SP MUST:
--   - INSERT a NEW row with superseded_at = NULL (active);
--   - UPDATE the OLD row setting superseded_at = now() and superseded_by =
--     <new id> in the SAME transaction.
-- T013 shipped only the CREATE branch + a provisional WCM06 reject for an
-- already-active duplicate (D-013); T021 will REPLACE that reject with this
-- supersede UPDATE+INSERT chain. Until T021 lands, every assertion below
-- will fail because the SP raises WCM06 on call 1.
--
-- Fixture choice: alpha + M4 (MEX-POL, scheduled) has Row 5 in
-- slice-003-fixture.sql (1-1, ui). That fixture row IS the "OLD" we want to
-- supersede -- we do NOT delete it (contrast T010's create-happy test which
-- DELETEs the same row to get a fresh slot). The SP is called with (2, 1)
-- and the post-state should show Row 5 superseded by the new row.
--
-- Audit side-effect: the 0033 trigger emits 'prediction.created' on the
-- INSERT (NEW.superseded_at IS NULL) AND 'prediction.superseded' on the
-- UPDATE (OLD.superseded_at IS NULL -> NEW.superseded_at IS NOT NULL).
--
-- Pattern: BEGIN / plan(6) / asserts / finish / ROLLBACK. ROLLBACK
-- guarantees no residue. set_config/current_setting carry the new uuid
-- across DO blocks within the single outer transaction.

BEGIN;

SELECT plan(6);

-- ---------------------------------------------------------------------------
-- Step 1: invoke the SP for (alpha, M4) with (2, 1). The slice-003 fixture
-- already has alpha's M4 row at id cccc...0005 (1-1, ui) -- that row IS the
-- supersede target. Pin the SP's returned uuid into a session setting so
-- subsequent assertions can resolve it without re-invoking.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_new_id uuid;
BEGIN
  v_new_id := public.submit_prediction(
    '11111111-1111-1111-1111-111111111111'::uuid,  -- alpha
    'bbbb0000-0000-0000-0000-000000000004'::uuid,  -- M4 MEX-POL scheduled
    2,
    1,
    'ui'
  );
  PERFORM set_config('test.new_id', v_new_id::text, false);
END
$$;

-- A1: OLD row (the fixture Row 5) is now superseded and superseded_by points
-- at the NEW row's uuid.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.predictions
     WHERE id              = 'cccc0000-0000-0000-0000-000000000005'::uuid
       AND superseded_at IS NOT NULL
       AND superseded_by   = current_setting('test.new_id')::uuid
  ),
  'A1 OLD row (cccc...0005) is superseded and superseded_by links to the NEW row'
);

-- A2: NEW row exists and is active (superseded_at IS NULL).
SELECT ok(
  (SELECT superseded_at IS NULL
     FROM public.predictions
    WHERE id = current_setting('test.new_id')::uuid),
  'A2 NEW row is active (superseded_at IS NULL)'
);

-- A3: exactly one active row for (alpha, M4) -- the supersede invariant
-- guaranteed by the partial unique index on
-- (participant_id, match_id) WHERE superseded_at IS NULL.
SELECT is(
  (SELECT count(*)::int FROM public.predictions
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND match_id       = 'bbbb0000-0000-0000-0000-000000000004'::uuid
      AND superseded_at IS NULL),
  1,
  'A3 exactly one active row for (alpha, M4) after supersede'
);

-- A4: NEW row has the submitted scores + source.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.predictions
     WHERE id              = current_setting('test.new_id')::uuid
       AND predicted_home  = 2
       AND predicted_away  = 1
       AND source          = 'ui'
  ),
  'A4 NEW row has predicted_home=2, predicted_away=1, source=ui'
);

-- A5: exactly one prediction.superseded audit row references the OLD id.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action    = 'prediction.superseded'
      AND entity_id = 'cccc0000-0000-0000-0000-000000000005'::uuid),
  1,
  'A5 one prediction.superseded audit row references the OLD prediction id'
);

-- A6: exactly one prediction.created audit row references the NEW id.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action    = 'prediction.created'
      AND entity_id = current_setting('test.new_id')::uuid),
  1,
  'A6 one prediction.created audit row references the NEW prediction id'
);

SELECT * FROM finish();

ROLLBACK;
