-- Slice 003 / T010 / contracts/predictions.write.md § Test surface. RED until T013 ships submit_prediction SP at slot 0034.
--
-- Invalid-score path: submit_prediction MUST raise an EXCEPTION with
-- ERRCODE='WCM03' when either p_home or p_away violates the bounds:
--   * negative
--   * > tournament_config.score_upper_bound (seeded to 20 at slot 0035)
--
-- Per § Stored procedure semantics step 3 the SP additionally writes a
-- prediction.rejected_invalid_score audit row, but this test does NOT assert
-- that side-effect -- the prompt scope is the ERRCODE + non-creation
-- invariant only. The audit-row shape is covered by
-- submit_prediction_audit_format.sql (a sibling pgTAP test owned by T012).
--
-- Fixture choice: alpha + M4 (MEX-POL scheduled). alpha has Row 5 in the
-- slice-003 fixture (1-1, ui) for (alpha, M4). The throws_ok invocations
-- below would collide with that pre-existing active row, but the SP MUST
-- raise on the score-validation step BEFORE reaching the UPDATE-supersede
-- step, so the existing row is irrelevant -- the SP never touches it.
--
-- Pattern: BEGIN / plan(3) / throws_ok + count-invariant / finish / ROLLBACK.

BEGIN;

SELECT plan(3);

-- Snapshot the active-prediction row id for (alpha, M4) so we can assert
-- afterwards that it is unchanged.
CREATE TEMP TABLE _before AS
SELECT id AS active_id
  FROM public.predictions
 WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
   AND match_id       = 'bbbb0000-0000-0000-0000-000000000004'::uuid
   AND superseded_at IS NULL;

-- A1: p_home above score_upper_bound (21 > 20) raises ERRCODE WCM03.
SELECT throws_ok(
  $$ SELECT public.submit_prediction(
       '11111111-1111-1111-1111-111111111111'::uuid,
       'bbbb0000-0000-0000-0000-000000000004'::uuid,
       21,
       1,
       'ui'
     ) $$,
  'WCM03',
  NULL,
  'A1 submit_prediction raises ERRCODE=WCM03 when p_home > tournament_config.score_upper_bound (21 > 20)'
);

-- A2: negative score also raises ERRCODE WCM03.
SELECT throws_ok(
  $$ SELECT public.submit_prediction(
       '11111111-1111-1111-1111-111111111111'::uuid,
       'bbbb0000-0000-0000-0000-000000000004'::uuid,
       -1,
       1,
       'ui'
     ) $$,
  'WCM03',
  NULL,
  'A2 submit_prediction raises ERRCODE=WCM03 when p_home is negative (-1)'
);

-- A3: the active row for (alpha, M4) is unchanged -- no new INSERT, no
-- supersede. throws_ok aborts the SP's transaction on the exception so the
-- pre-existing fixture row from Row 5 (1-1 ui) is still the active row, and
-- no new active row exists with the rejected scores. We assert two things:
-- (a) the active id is unchanged (no supersede); (b) no row exists with the
-- rejected scores.
SELECT ok(
  (
    -- (a) active id still equals the one captured in _before
    (SELECT id FROM public.predictions
      WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
        AND match_id       = 'bbbb0000-0000-0000-0000-000000000004'::uuid
        AND superseded_at IS NULL)
    IS NOT DISTINCT FROM
    (SELECT active_id FROM _before)
  ) AND (
    -- (b) no row -- active or superseded -- exists for (alpha, M4) with the
    -- rejected score 21 or -1.
    NOT EXISTS (
      SELECT 1 FROM public.predictions
       WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND match_id       = 'bbbb0000-0000-0000-0000-000000000004'::uuid
         AND (predicted_home = 21 OR predicted_home = -1)
    )
  ),
  'A3 no predictions row was inserted for (alpha, M4) with the rejected scores; the pre-existing active row is unchanged'
);

SELECT * FROM finish();

ROLLBACK;
