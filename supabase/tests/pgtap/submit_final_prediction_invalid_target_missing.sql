-- Slice 004 / T012 / contracts/final-predictions.write.md § Test surface. RED until T016 ships submit_final_prediction SP at slot 0044.
--
-- Invalid-target-missing path: submit_final_prediction MUST raise an
-- EXCEPTION with ERRCODE='WFP04' when p_target_team_id references a team
-- that does not exist in public.teams. Per § Stored procedure semantics
-- step 3: validate target existence; if missing, write
-- 'final_prediction.rejected_invalid_target' audit row and RAISE
-- ERRCODE='WFP04'.
--
-- Fixture choice: charlie (eligible) + item_kind=champion + a
-- gen_random_uuid()-generated target_team_id that is guaranteed not to exist
-- in the teams table (slice-002 fixture uses the 'aaaa0000-...' prefix).
--
-- Pattern: BEGIN / plan(3) / throws_ok + count-invariant / finish / ROLLBACK.

BEGIN;

SELECT plan(3);

-- Snapshot total final_predictions count BEFORE the SP call.
CREATE TEMP TABLE _before AS
SELECT count(*) AS fp_count FROM public.final_predictions;

-- Generate a random uuid for the missing team. Pinned via set_config so the
-- post-call existence check can reference it without re-generating.
SELECT set_config('test.missing_team_id', gen_random_uuid()::text, false);

-- A1: SP raises ERRCODE WFP04 when p_target_team_id does not match any
-- teams row. The throws_ok body interpolates the captured uuid.
SELECT throws_ok(
  format($q$ SELECT public.submit_final_prediction(
       '33333333-3333-3333-3333-333333333333'::uuid,
       'champion',
       %L::uuid,
       NULL,
       'ui'
     ) $q$, current_setting('test.missing_team_id')),
  'WFP04',
  NULL,
  'A1 submit_final_prediction raises ERRCODE=WFP04 when p_target_team_id does not exist in public.teams'
);

-- A2: final_predictions count unchanged.
SELECT is(
  (SELECT count(*) FROM public.final_predictions),
  (SELECT fp_count FROM _before),
  'A2 final_predictions row count is unchanged after the rejected SP call'
);

-- A3: no row was inserted referencing the missing team uuid (active or
-- superseded).
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.final_predictions
     WHERE target_team_id = current_setting('test.missing_team_id')::uuid
  ),
  'A3 no final_predictions row references the missing target_team_id'
);

SELECT * FROM finish();

ROLLBACK;
