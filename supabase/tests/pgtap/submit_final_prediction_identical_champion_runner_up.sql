-- Slice 004 / T026 / US3 / contracts/final-predictions.write.md WFP06 + config toggle. GREEN now (T016 already implements WFP06 + config read); supersede branch in T029 doesn't affect this test.
--
-- FR-007 disjoint-rule exercise: with the default config
-- (tournament_config.predictions.allow_identical_champion_runner_up = false,
-- seeded at slot 0047), submitting the same team for both champion and
-- runner_up MUST be rejected with ERRCODE='WFP06'. Flipping the config flag
-- to TRUE MUST permit the second submission.
--
-- Fixture choice: charlie (33333333-...-3) has NO active champion or
-- runner_up row in slice-004-fixture (Row 6 is best_player -> Pedri only),
-- so we can submit fresh champion/runner_up picks without colliding with
-- the create-only SP semantics. Target: POL (aaaa0000-...-4).
--
-- The slice-004 fixture seeds first_kickoff_utc to 2026-06-16, comfortably
-- in the future; lock predicate is FALSE without extra setup.
--
-- Note on T029 interaction: this test never re-submits the same item_kind
-- twice (no supersede invoked). Step 4 succeeds by populating runner_up,
-- which is a fresh-create on a different item_kind than champion. So the
-- create-only SP from T016 satisfies all assertions today, and the T029
-- supersede branch (different item_kind path) does not affect this test.
--
-- Pattern: BEGIN / plan(5) / throws_ok + asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Step 1: submit champion = POL via the SP. Sanity-pin the returned uuid in
-- case we need it later (currently used only to set up the disjoint state).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_champion_id uuid;
BEGIN
  v_champion_id := public.submit_final_prediction(
    '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
    'champion',
    'aaaa0000-0000-0000-0000-000000000004'::uuid,  -- POL
    NULL,
    'ui'
  );
  PERFORM set_config('test.champion_id', v_champion_id::text, false);
END
$$;

-- A1 (rejection): with the default config (allow_identical=false),
-- submitting runner_up=POL when champion=POL is already active MUST raise
-- ERRCODE='WFP06'. The matching message is "runner_up cannot equal champion"
-- per the SP body (slot 0044), but we anchor on the ERRCODE only -- the
-- message string is not load-bearing in the contract.
SELECT throws_ok(
  $$ SELECT public.submit_final_prediction(
       '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
       'runner_up',
       'aaaa0000-0000-0000-0000-000000000004'::uuid,  -- POL (same as champion)
       NULL,
       'ui'
     ) $$,
  'WFP06',
  NULL,
  'A1 SP raises ERRCODE=WFP06 when runner_up = active champion AND allow_identical_champion_runner_up=false'
);

-- ---------------------------------------------------------------------------
-- Step 3: flip the config flag to TRUE. The SP reads this on every call,
-- so the next submission MUST succeed.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = 'true'::jsonb
 WHERE key = 'predictions.allow_identical_champion_runner_up';

-- ---------------------------------------------------------------------------
-- Step 4: re-submit runner_up = POL. With the flag flipped TRUE, the SP MUST
-- accept the submission and return a non-null uuid.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_runner_up_id uuid;
BEGIN
  v_runner_up_id := public.submit_final_prediction(
    '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
    'runner_up',
    'aaaa0000-0000-0000-0000-000000000004'::uuid,  -- POL
    NULL,
    'ui'
  );
  PERFORM set_config('test.runner_up_id', v_runner_up_id::text, false);
END
$$;

-- A2: after step 4, the SP returned a non-null uuid for the runner_up call.
SELECT isnt(
  current_setting('test.runner_up_id')::uuid,
  NULL,
  'A2 SP returns non-null uuid for runner_up=POL after config flip to TRUE'
);

-- A3: exactly one active row for (charlie, runner_up) with target_team_id=POL.
SELECT is(
  (SELECT (count(*)::int, bool_and(target_team_id = 'aaaa0000-0000-0000-0000-000000000004'::uuid))
     FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'runner_up'
      AND superseded_at IS NULL),
  (1, true),
  'A3 exactly one active runner_up row for charlie with target_team_id=POL'
);

-- A4: champion row for charlie is UNTOUCHED by the runner_up flow -- still
-- exactly one active champion row with target_team_id=POL.
SELECT is(
  (SELECT (count(*)::int, bool_and(target_team_id = 'aaaa0000-0000-0000-0000-000000000004'::uuid))
     FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'champion'
      AND superseded_at IS NULL),
  (1, true),
  'A4 champion row for charlie unchanged: 1 active row with target_team_id=POL'
);

-- A5: cross-check the two ids differ (champion and runner_up are independent
-- supersede chains; the SP must not have written the same id under both
-- kinds).
SELECT isnt(
  current_setting('test.runner_up_id')::uuid,
  current_setting('test.champion_id')::uuid,
  'A5 champion id and runner_up id are distinct (independent supersede chains per item_kind)'
);

SELECT * FROM finish();

ROLLBACK;
