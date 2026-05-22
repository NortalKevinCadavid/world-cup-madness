-- Slice 005 / T010 / US1 / scoring-model.md § 7.2. RED until T013 ships score_match at slot 0052 per D-023.
--
-- Asserts the §7.2 award truth table (exact=10 / outcome=5 / incorrect=0 / none=0)
-- by invoking the not-yet-implemented public.score_match(match_id uuid, run_id uuid)
-- SP across all three finished matches (M1=2-1, M2=0-0, M3=1-2) in the slice-005
-- fixture and checking the (points, reason_code) pair on each emitted score_records
-- row.
--
-- Per the contract (research § R-001 + R-002), score_match:
--   1. INSERTs/UPSERTs a row into score_calculation_runs with the caller-supplied
--      run_id (idempotency key).
--   2. Re-issues (delete-then-insert at the new calculation_version) one
--      score_records row per (participant, target=match_id) pair, including
--      participants who have NO active prediction (reason_code='none', points=0).
--
-- Fixture references (supabase/seed/slice-005-fixture.sql, hand-verified truth table
-- at the bottom of that file):
--   M1 ARG vs MEX official 2-1, eeee0050-0000-0000-0000-000000000001
--   M2 ESP vs BRA official 0-0, eeee0050-0000-0000-0000-000000000002
--   M3 CAN vs USA official 1-2, eeee0050-0000-0000-0000-000000000003
--   alpha   = 11111111-1111-1111-1111-111111111111 (M1 2-1 exact, M2 0-0 exact, M3 1-2 exact)
--   bravo   = 22222222-2222-2222-2222-222222222222 (M1 2-1 exact, M2 1-1 outcome, M3 0-1 outcome)
--   charlie = 33333333-3333-3333-3333-333333333333 (M1 2-1 exact, M2 1-0 incorrect, M3 1-2 exact)
--   delta   = 44444444-4444-4444-4444-444444444444 (M1 3-1 outcome, M2 2-2 outcome, M3 0-0 incorrect)
--   epsilon = 55555555-5555-5555-5555-555555555555 (M1 0-2 incorrect, M2 1-0 incorrect, M3 1-2 exact)
--   zeta    = 66666666-6666-6666-6666-666666666666 (all three finished matches incorrect)
--
-- Twelve assertions cover four reason codes (exact, outcome, incorrect, none) across
-- three distinct matches and six distinct participants. The twelfth assertion exercises
-- the "no valid prediction" path (Acceptance Scenario US1.4) by DELETEing delta's M2
-- prediction inside the test transaction and rescoring M2 under a fresh run_id; the
-- ROLLBACK at the end restores the prediction.
--
-- Pattern: BEGIN / plan(12) / asserts / finish / ROLLBACK. ROLLBACK guarantees no
-- residue in score_records, score_calculation_runs, predictions, or audit_log.
-- Assumes the slice-005 fixture has been seeded by the test harness via
-- `supabase db reset` (constitution Principle IX -- tests check in fixture seeding
-- separately from the assertion file).

BEGIN;

SELECT plan(12);

-- ---------------------------------------------------------------------------
-- Stable run_id per scored match, captured so each assertion can filter
-- score_records by the run that produced it. set_config(..., false) pins the
-- value to the surrounding transaction (which the harness's BEGIN/ROLLBACK
-- envelopes), so subsequent statements in this file read it cleanly.
-- ---------------------------------------------------------------------------
SELECT set_config('test.run_id_m1', gen_random_uuid()::text, false);
SELECT set_config('test.run_id_m3', gen_random_uuid()::text, false);
SELECT set_config('test.run_id_m2_initial', gen_random_uuid()::text, false);
SELECT set_config('test.run_id_m2_after_delete', gen_random_uuid()::text, false);

-- ---------------------------------------------------------------------------
-- Invoke score_match for M1 (2-1) and M3 (1-2) under stable run_ids. M2 gets
-- its own scoring pass below, then a DELETE + re-score for the
-- "no valid prediction" assertion.
--
-- These two SELECTs are RED until T013 ships score_match at slot 0052
-- per D-023: invoking a function that does not yet exist will raise
-- "function score_match(uuid, uuid) does not exist", which pgTAP surfaces
-- as a test failure (not an infrastructure error).
-- ---------------------------------------------------------------------------
SELECT public.score_match(
  'eeee0050-0000-0000-0000-000000000001'::uuid,            -- M1
  current_setting('test.run_id_m1')::uuid
);

SELECT public.score_match(
  'eeee0050-0000-0000-0000-000000000003'::uuid,            -- M3
  current_setting('test.run_id_m3')::uuid
);

SELECT public.score_match(
  'eeee0050-0000-0000-0000-000000000002'::uuid,            -- M2 (initial pass, all 6 participants have predictions)
  current_setting('test.run_id_m2_initial')::uuid
);

-- ===========================================================================
-- Group A -- exact-score awards (10 / 'exact')
-- §7.2 row 1: predicted home AND predicted away both equal official scores.
-- ===========================================================================

-- A1: alpha vs M1 -- predicted 2-1 / official 2-1 -> 10 points.
SELECT is(
  (SELECT points
     FROM public.score_records
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000001'::uuid
      AND run_id         = current_setting('test.run_id_m1')::uuid),
  10,
  'A1 alpha + M1 (pred 2-1, official 2-1) -> 10 points (exact)'
);

-- A2: alpha vs M1 -- reason_code='exact'.
SELECT is(
  (SELECT reason_code::text
     FROM public.score_records
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000001'::uuid
      AND run_id         = current_setting('test.run_id_m1')::uuid),
  'exact',
  'A2 alpha + M1 reason_code = exact'
);

-- A3: charlie vs M1 -- predicted 2-1 / official 2-1 -> 10 points + reason='exact'.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000001'::uuid
      AND run_id         = current_setting('test.run_id_m1')::uuid),
  (10, 'exact'),
  'A3 charlie + M1 (pred 2-1, official 2-1) -> 10 / exact'
);

-- A4: charlie vs M3 -- predicted 1-2 / official 1-2 -> 10 points + reason='exact'.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000003'::uuid
      AND run_id         = current_setting('test.run_id_m3')::uuid),
  (10, 'exact'),
  'A4 charlie + M3 (pred 1-2, official 1-2) -> 10 / exact'
);

-- A5: epsilon vs M3 -- predicted 1-2 / official 1-2 -> 10 points + reason='exact'.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id = '55555555-5555-5555-5555-555555555555'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000003'::uuid
      AND run_id         = current_setting('test.run_id_m3')::uuid),
  (10, 'exact'),
  'A5 epsilon + M3 (pred 1-2, official 1-2) -> 10 / exact'
);

-- ===========================================================================
-- Group B -- correct-outcome-only awards (5 / 'outcome')
-- §7.2 row 2: predicted outcome (home / draw / away) matches but exact score
-- differs.
-- ===========================================================================

-- A6: bravo vs M2 -- predicted 1-1 (draw) / official 0-0 (draw) -> 5 points.
SELECT is(
  (SELECT points
     FROM public.score_records
    WHERE participant_id = '22222222-2222-2222-2222-222222222222'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000002'::uuid
      AND run_id         = current_setting('test.run_id_m2_initial')::uuid),
  5,
  'A6 bravo + M2 (pred 1-1 draw, official 0-0 draw) -> 5 points (outcome)'
);

-- A7: bravo vs M2 -- reason_code='outcome'.
SELECT is(
  (SELECT reason_code::text
     FROM public.score_records
    WHERE participant_id = '22222222-2222-2222-2222-222222222222'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000002'::uuid
      AND run_id         = current_setting('test.run_id_m2_initial')::uuid),
  'outcome',
  'A7 bravo + M2 reason_code = outcome'
);

-- A8: delta vs M1 -- predicted 3-1 (home win) / official 2-1 (home win) -> 5 / outcome.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id = '44444444-4444-4444-4444-444444444444'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000001'::uuid
      AND run_id         = current_setting('test.run_id_m1')::uuid),
  (5, 'outcome'),
  'A8 delta + M1 (pred 3-1 home win, official 2-1 home win) -> 5 / outcome'
);

-- ===========================================================================
-- Group C -- incorrect-outcome awards (0 / 'incorrect')
-- §7.2 row 3: predicted outcome does NOT match official outcome.
-- ===========================================================================

-- A9: zeta vs M1 -- predicted 1-2 (away win) / official 2-1 (home win) -> 0 points.
SELECT is(
  (SELECT points
     FROM public.score_records
    WHERE participant_id = '66666666-6666-6666-6666-666666666666'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000001'::uuid
      AND run_id         = current_setting('test.run_id_m1')::uuid),
  0,
  'A9 zeta + M1 (pred 1-2 away win, official 2-1 home win) -> 0 points (incorrect)'
);

-- A10: zeta vs M1 -- reason_code='incorrect'.
SELECT is(
  (SELECT reason_code::text
     FROM public.score_records
    WHERE participant_id = '66666666-6666-6666-6666-666666666666'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000001'::uuid
      AND run_id         = current_setting('test.run_id_m1')::uuid),
  'incorrect',
  'A10 zeta + M1 reason_code = incorrect'
);

-- A11: delta vs M3 -- predicted 0-0 (draw) / official 1-2 (away win) -> 0 / incorrect.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id = '44444444-4444-4444-4444-444444444444'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000003'::uuid
      AND run_id         = current_setting('test.run_id_m3')::uuid),
  (0, 'incorrect'),
  'A11 delta + M3 (pred 0-0 draw, official 1-2 away win) -> 0 / incorrect'
);

-- ===========================================================================
-- Group D -- no-valid-prediction awards (0 / 'none')
-- §7.2 row 4: participant had no valid prediction at lock time.
-- Acceptance Scenario US1.4: "Given a finished match and a participant with
-- no valid prediction ... the participant MUST be awarded exactly 0 points."
--
-- We DELETE delta's M2 prediction inside this transaction (ROLLBACK restores
-- it at the end of the test), then re-invoke score_match for M2 under a
-- fresh run_id. The SP must emit a row for delta with reason_code='none'
-- and points=0 -- the "MUST emit one row per participant per match" branch
-- of the §7.2 contract (data-model § Entity 1: score_records covers every
-- (participant, match) pair, not only those with active predictions).
-- ===========================================================================

DELETE FROM public.predictions
 WHERE id = 'eeee0051-000d-0002-0000-000000000000'::uuid;  -- delta's M2 prediction

SELECT public.score_match(
  'eeee0050-0000-0000-0000-000000000002'::uuid,  -- M2
  current_setting('test.run_id_m2_after_delete')::uuid
);

-- A12: delta vs M2 after DELETE -- reason_code='none' AND points=0.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id = '44444444-4444-4444-4444-444444444444'::uuid
      AND target_kind    = 'match'
      AND target_id      = 'eeee0050-0000-0000-0000-000000000002'::uuid
      AND run_id         = current_setting('test.run_id_m2_after_delete')::uuid),
  (0, 'none'),
  'A12 delta + M2 (no active prediction after DELETE) -> 0 / none (US1.4 no-valid-prediction)'
);

SELECT * FROM finish();

ROLLBACK;
