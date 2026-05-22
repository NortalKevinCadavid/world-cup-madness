-- Slice 005 / T018 / US2 / scoring-model.md § 7.3 / research.md § R-007 + R-008.
-- RED until T019 ships score_finals at on-disk slot 0053 per D-023.
--
-- Asserts the §7.3 final-tournament truth table (20 / 0 per item) across the
-- four item kinds (champion, runner_up, top_scorer, best_player) by invoking
-- the not-yet-implemented public.score_finals(p_run_id uuid) SP against the
-- slice-005 fixture's tournament_award + (slice-004 + slice-005) active
-- final_predictions, and checking (points, reason_code, official_team_or_player_id)
-- on each emitted score_records row.
--
-- Three branches of §7.3 / R-007 / R-008 are exercised:
--   * final_correct  -- participant picked the officially-named (champion / runner_up /
--                       top_scorer / best_player) value AND the award is 'confirmed'
--                       -> +20 points, reason_code='final_correct'.
--   * final_incorrect -- participant picked any other value AND the award is 'confirmed'
--                       -> 0 points, reason_code='final_incorrect'. This covers the
--                       OD-004 Golden Boot resolution: a top-scorer pick that "tied on
--                       raw goals" but is NOT the officially-named Golden Boot winner
--                       scores 0 -- only the single officially-named winner scores.
--                       Slice-005 fixture: bravo picked Vinícius for top_scorer; the
--                       award names Messi as the officially-named top_scorer. Vinícius
--                       and Messi may have tied on raw goals in the upstream raw data,
--                       but the Golden Boot tiebreaker chain (resolved upstream per
--                       R-007) named Messi -- bravo gets 0, not 20.
--   * final_pending  -- participant's pick is against an award item whose *_status is
--                       still 'pending' (R-008 Golden Ball delay). score_finals emits
--                       a row with points=0, reason_code='final_pending',
--                       official_team_or_player_id=NULL. The slice-005 fixture leaves
--                       best_player_status='pending' (best_player_player_id NULL); three
--                       participants picked best_player=Pedri (alpha, charlie, zeta).
--
-- Assertion #10 ALSO exercises the "award flip from pending -> confirmed" path:
-- inside the same transaction, the test UPDATEs tournament_award to confirm
-- best_player=Pedri and invokes score_finals under a fresh run_id. alpha's new
-- best_player row MUST flip from (0,'final_pending',NULL) to (20,'final_correct',
-- Pedri) AND alpha's total under the new run MUST equal 80 (20 champion + 20
-- runner_up + 20 top_scorer + 20 best_player). The outer ROLLBACK restores the
-- tournament_award row at the end of the test.
--
-- Fixture references (supabase/seed/slice-004-fixture.sql + slice-005-fixture.sql,
-- hand-verified leaderboard at the bottom of slice-005-fixture.sql):
--   tournament_id = 00000000-0000-0000-0000-000000000001
--   award: champion=ARG/confirmed, runner_up=ESP/confirmed, top_scorer=Messi/confirmed,
--          best_player=NULL/pending
--   ARG (champion) = aaaa0000-0000-0000-0000-000000000001
--   ESP (runner_up)= aaaa0000-0000-0000-0000-000000000005
--   BRA (wrong)    = aaaa0000-0000-0000-0000-000000000006
--   Messi (top)    = dddd1000-0000-0000-0000-000000000001
--   Vinícius (wrong/OD-004) = dddd1000-0000-0000-0000-000000000011
--   Pedri          = dddd1000-0000-0000-0000-000000000009
--   alpha   = 11111111-1111-1111-1111-111111111111  (4 active picks; all-correct once Pedri confirmed -> 80)
--   bravo   = 22222222-2222-2222-2222-222222222222  (champion=BRA wrong, runner_up=ESP correct, top_scorer=Vinícius wrong)
--   charlie = 33333333-3333-3333-3333-333333333333  (champion=ARG correct, best_player=Pedri pending)
--   delta   = 44444444-4444-4444-4444-444444444444  (top_scorer=Messi correct)
--   epsilon = 55555555-5555-5555-5555-555555555555  (champion=BRA wrong)
--   zeta    = 66666666-6666-6666-6666-666666666666  (best_player=Pedri pending)
--
-- Ten assertions cover all three reason codes (final_correct, final_incorrect,
-- final_pending) AND the per-participant total (assertion #9) AND the
-- pending->confirmed award flip (assertion #10, single is() that checks both
-- the flipped row's (points, reason_code) AND alpha's new SUM = 80).
--
-- Pattern: BEGIN / plan(10) / asserts / finish / ROLLBACK. ROLLBACK guarantees
-- no residue in score_records, score_calculation_runs, audit_log, OR
-- tournament_award (the assertion-10 award mutation is rolled back).

BEGIN;

SELECT plan(10);

-- ---------------------------------------------------------------------------
-- Stable run_ids per scoring pass, captured so each assertion can filter
-- score_records by the run that produced it. set_config(..., false) pins the
-- value to the surrounding transaction (which the harness's BEGIN/ROLLBACK
-- envelopes), so subsequent statements in this file read it cleanly.
--   * run_id_v1 -- initial pass against the fixture's award (best_player pending).
--   * run_id_v2 -- second pass after the assertion-10 award mutation flips
--                  best_player to 'confirmed' with player_id=Pedri.
-- ---------------------------------------------------------------------------
SELECT set_config('test.run_id_v1', gen_random_uuid()::text, false);
SELECT set_config('test.run_id_v2', gen_random_uuid()::text, false);

-- ---------------------------------------------------------------------------
-- Invoke score_finals under the v1 run_id (against the fixture's pending
-- best_player_status). RED until T019 ships score_finals at slot 0053 per
-- D-023: invoking a function that does not yet exist will raise
-- "function score_finals(uuid) does not exist", which pgTAP surfaces as a
-- test failure (not an infrastructure error).
-- ---------------------------------------------------------------------------
SELECT public.score_finals(current_setting('test.run_id_v1')::uuid);

-- ===========================================================================
-- Group A -- final_correct awards (20 / 'final_correct')
-- §7.3: predicted item matches confirmed tournament_award value.
-- ===========================================================================

-- A1: charlie + champion (slice-005 fixture: charlie picked ARG, award says ARG, confirmed) -> 20 / final_correct.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id   = '33333333-3333-3333-3333-333333333333'::uuid
      AND target_kind      = 'final'
      AND final_item_kind  = 'champion'
      AND run_id           = current_setting('test.run_id_v1')::uuid),
  (20, 'final_correct'),
  'A1 charlie + champion (pick ARG, award ARG confirmed) -> 20 / final_correct'
);

-- A2: bravo + champion (slice-004 fixture: bravo picked BRA, award says ARG, confirmed) -> 0 / final_incorrect.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id   = '22222222-2222-2222-2222-222222222222'::uuid
      AND target_kind      = 'final'
      AND final_item_kind  = 'champion'
      AND run_id           = current_setting('test.run_id_v1')::uuid),
  (0, 'final_incorrect'),
  'A2 bravo + champion (pick BRA, award ARG confirmed) -> 0 / final_incorrect'
);

-- A3: bravo + runner_up (slice-005 fixture: bravo picked ESP, award says ESP, confirmed) -> 20 / final_correct.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id   = '22222222-2222-2222-2222-222222222222'::uuid
      AND target_kind      = 'final'
      AND final_item_kind  = 'runner_up'
      AND run_id           = current_setting('test.run_id_v1')::uuid),
  (20, 'final_correct'),
  'A3 bravo + runner_up (pick ESP, award ESP confirmed) -> 20 / final_correct'
);

-- A4: delta + top_scorer (slice-005 fixture: delta picked Messi, award says Messi, confirmed) -> 20 / final_correct.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id   = '44444444-4444-4444-4444-444444444444'::uuid
      AND target_kind      = 'final'
      AND final_item_kind  = 'top_scorer'
      AND run_id           = current_setting('test.run_id_v1')::uuid),
  (20, 'final_correct'),
  'A4 delta + top_scorer (pick Messi, award Messi confirmed) -> 20 / final_correct'
);

-- ===========================================================================
-- Group B -- OD-004 Golden Boot officially-named-only branch
-- §7.3 + research.md § R-007: only the SINGLE officially-named Golden Boot
-- winner scores. A participant who picked a player who "tied on raw goals"
-- but is NOT the officially-named winner gets 0 / 'final_incorrect' (NOT a
-- partial credit, NOT a tie-share). The slice-005 fixture exercises this by
-- letting bravo pick Vinícius for top_scorer while the award names Messi --
-- the OD-004 resolution (clarified 2026-05-15) means bravo scores 0.
-- ===========================================================================

-- A5: bravo + top_scorer (slice-004 fixture: bravo picked Vinícius; award names Messi as the officially-named Golden Boot winner; Vinícius is NOT the officially-named winner per OD-004) -> 0 / final_incorrect.
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id   = '22222222-2222-2222-2222-222222222222'::uuid
      AND target_kind      = 'final'
      AND final_item_kind  = 'top_scorer'
      AND run_id           = current_setting('test.run_id_v1')::uuid),
  (0, 'final_incorrect'),
  'A5 bravo + top_scorer (pick Vinícius, officially-named winner is Messi per OD-004) -> 0 / final_incorrect'
);

-- ===========================================================================
-- Group C -- R-008 Golden Ball pending branch (final_pending / 0 / NULL)
-- §7.3 + research.md § R-008: when tournament_award.best_player_status='pending'
-- (the FIFA Golden Ball announcement is delayed), score_finals emits a row
-- with points=0, reason_code='final_pending', official_team_or_player_id=NULL.
-- The score_records CHECK score_records_final_official_required permits
-- NULL official_team_or_player_id specifically for the 'final_pending' branch.
-- Three participants in the fixture picked best_player=Pedri (alpha, charlie,
-- zeta); all three rows MUST be (0, 'final_pending', NULL).
--
-- This is the "row written, NOT skipped" interpretation, mirroring the
-- 0049_score_records.sql enum value 'final_pending' which exists precisely
-- for this case (see the enum comment in that migration). The 'final_pending'
-- branch is the audit-visible signal that a confirmed re-score is pending;
-- T019 owns the choice but the migration's enum + CHECK shape are designed
-- around row-written semantics, and the personal-breakdown UI reads these
-- rows to surface "best-player scoring pending" per spec.md § Edge Cases.
-- ===========================================================================

-- A6: alpha + best_player (slice-005 fixture: alpha picked Pedri; award.best_player_status='pending') -> (0, 'final_pending', NULL).
SELECT is(
  (SELECT (points, reason_code::text, official_team_or_player_id::text)
     FROM public.score_records
    WHERE participant_id   = '11111111-1111-1111-1111-111111111111'::uuid
      AND target_kind      = 'final'
      AND final_item_kind  = 'best_player'
      AND run_id           = current_setting('test.run_id_v1')::uuid),
  (0, 'final_pending', NULL::text),
  'A6 alpha + best_player (pick Pedri, award best_player_status=pending) -> 0 / final_pending / NULL official id'
);

-- A7: charlie + best_player (slice-004 fixture: charlie picked Pedri; award pending) -> (0, 'final_pending').
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id   = '33333333-3333-3333-3333-333333333333'::uuid
      AND target_kind      = 'final'
      AND final_item_kind  = 'best_player'
      AND run_id           = current_setting('test.run_id_v1')::uuid),
  (0, 'final_pending'),
  'A7 charlie + best_player (pick Pedri, award pending) -> 0 / final_pending'
);

-- A8: zeta + best_player (slice-005 fixture: zeta picked Pedri; award pending) -> (0, 'final_pending').
SELECT is(
  (SELECT (points, reason_code::text)
     FROM public.score_records
    WHERE participant_id   = '66666666-6666-6666-6666-666666666666'::uuid
      AND target_kind      = 'final'
      AND final_item_kind  = 'best_player'
      AND run_id           = current_setting('test.run_id_v1')::uuid),
  (0, 'final_pending'),
  'A8 zeta + best_player (pick Pedri, award pending) -> 0 / final_pending'
);

-- ===========================================================================
-- Group D -- per-participant final-points roll-up
-- spec.md § US2 AS-3: "Given all four items correct, ... the participant MUST
-- receive exactly 80 points from final scoring." alpha is the rolled-up
-- example: 3 confirmed-correct items (champion ARG, runner_up ESP, top_scorer
-- Messi) + 1 pending best_player (Pedri / 0 / final_pending) = 60 under v1.
-- Once the award flips (assertion #10 below), alpha rises to 80.
-- ===========================================================================

-- A9: alpha total final-points under v1 = 60 (20 + 20 + 20 + 0 pending).
SELECT is(
  (SELECT COALESCE(SUM(points), 0)::int
     FROM public.score_records
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND target_kind    = 'final'
      AND run_id         = current_setting('test.run_id_v1')::uuid),
  60,
  'A9 alpha total final-points under v1 (champion 20 + runner_up 20 + top_scorer 20 + best_player 0 pending) = 60'
);

-- ===========================================================================
-- Group E -- award flip from pending -> confirmed (R-008 happy-path completion)
-- spec.md § Edge Cases (Golden Ball delayed): "admin holds best-player scoring
-- until FIFA's announcement is captured and confirmed". Once the admin flips
-- best_player_status to 'confirmed' (with best_player_player_id=Pedri), a new
-- scoring run under a fresh run_id MUST emit alpha's best_player row as
-- (20, 'final_correct') AND alpha's total under the new run MUST equal 80.
--
-- The UPDATE is intentionally inside the BEGIN/ROLLBACK envelope: the outer
-- ROLLBACK at the end of this file restores the fixture's pending best_player
-- row, so this assertion does NOT pollute the database for other tests.
-- ===========================================================================

UPDATE public.tournament_award
   SET best_player_player_id = 'dddd1000-0000-0000-0000-000000000009'::uuid,  -- Pedri
       best_player_status    = 'confirmed'
 WHERE tournament_id = '00000000-0000-0000-0000-000000000001'::uuid;

SELECT public.score_finals(current_setting('test.run_id_v2')::uuid);

-- A10: alpha's NEW best_player row (under run_id_v2 after the award flip) is
-- (20, 'final_correct') AND alpha's NEW total under run_id_v2 = 80.
-- Combined into a single is() so the assertion count remains exactly 10.
SELECT is(
  (
    SELECT ARRAY[
      -- subscript 1: alpha's best_player row -- points
      (SELECT points::text
         FROM public.score_records
        WHERE participant_id   = '11111111-1111-1111-1111-111111111111'::uuid
          AND target_kind      = 'final'
          AND final_item_kind  = 'best_player'
          AND run_id           = current_setting('test.run_id_v2')::uuid),
      -- subscript 2: alpha's best_player row -- reason_code
      (SELECT reason_code::text
         FROM public.score_records
        WHERE participant_id   = '11111111-1111-1111-1111-111111111111'::uuid
          AND target_kind      = 'final'
          AND final_item_kind  = 'best_player'
          AND run_id           = current_setting('test.run_id_v2')::uuid),
      -- subscript 3: alpha's total final-points under v2
      (SELECT COALESCE(SUM(points), 0)::text
         FROM public.score_records
        WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
          AND target_kind    = 'final'
          AND run_id         = current_setting('test.run_id_v2')::uuid)
    ]
  ),
  ARRAY['20', 'final_correct', '80'],
  'A10 award flip pending->confirmed: alpha best_player row -> 20 / final_correct AND alpha total -> 80'
);

SELECT * FROM finish();

ROLLBACK;
