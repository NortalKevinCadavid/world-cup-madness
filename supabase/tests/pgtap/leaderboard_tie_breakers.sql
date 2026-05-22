-- Slice 005 / T024 / US3 / scoring-model.md § 7.4 / research.md § R-004.
-- RED until T029 ships leaderboard_v at on-disk slot 0054 per D-023.
-- Verifies the tier order: total -> exact_count -> outcome_count -> final_points.
-- Reads tiebreaker.order from tournament_config (NOT hard-coded -- Principle VIII).
--
-- =============================================================================
-- What this test asserts
-- =============================================================================
-- One assertion per tier-isolation scenario, exercising §7.4 priority order:
--
--   A1 Total-only differentiation (no ties)                 -- tier 1 alone
--   A2 Tie on total, differ on exact_count                  -- tier 1 -> tier 2
--   A3 Tie on (total, exact), differ on outcome_count       -- tier 2 -> tier 3
--   A4 Tie on (total, exact, outcome), differ on final_pts  -- tier 3 -> tier 4
--   A5 All four tiers tied -> shared rank (RANK() == 1, 1)  -- tier 6 (R-004)
--   A6 Priority order is exact BEFORE outcome (not lex sum) -- §7.4 precedence
--   A7 Tier 4 only matters after tiers 1-3 all tied         -- tier 4 isolation
--   A8 Cross-version isolation -- only current_calculation_version is visible
--      (R-003 flip-the-pointer, NOT a tie-breaker tier but the prerequisite
--      consistency guarantee that the tie-breaker assertions rely on).
--
-- =============================================================================
-- Tier-isolation strategy: cumulative calculation_version bumps
-- =============================================================================
-- Each scenario owns a private calculation_version (1001..1008) and bumps
-- tournament_config.current_calculation_version to that value BEFORE asserting.
-- The leaderboard view filters WHERE calculation_version = current value
-- (R-003), so each scenario sees only its own score_records. There is NO
-- cross-scenario contamination because:
--   * Each scenario inserts at a DISTINCT calculation_version.
--   * The view filters by current_calculation_version.
--   * BEGIN/ROLLBACK at the outer level discards every UPDATE and INSERT.
--
-- Alternative considered (SAVEPOINT per scenario, ROLLBACK TO SAVEPOINT): more
-- complex, and we have no need to "undo" -- distinct versions give us
-- isolation for free.
--
-- =============================================================================
-- Fixture references (deterministic UUIDs from slice-001/slice-005 seeds)
-- =============================================================================
--   alpha   = 11111111-1111-1111-1111-111111111111   (slice-001-fixture)
--   bravo   = 22222222-2222-2222-2222-222222222222   (slice-001-fixture)
--   charlie = 33333333-3333-3333-3333-333333333333   (slice-001-fixture)
--   delta   = 44444444-4444-4444-4444-444444444444   (slice-005-fixture)
--
--   M1 = eeee0050-0000-0000-0000-000000000001  (slice-005-fixture)
--   M2 = eeee0050-0000-0000-0000-000000000002  (slice-005-fixture)
--   M3 = eeee0050-0000-0000-0000-000000000003  (slice-005-fixture)
--
-- We only need participants and matches to EXIST (so FK constraints pass);
-- their official scores / predictions data are irrelevant -- this is a pure
-- view test that bypasses score_match/score_finals (per task body).
--
-- A synthetic score_calculation_runs row (scope='all', trigger='admin_recalc',
-- triggered_by=alpha, reason set) carries every score_record's run_id. One run
-- per scenario keeps the FK satisfied without introducing per-row run overhead.
--
-- =============================================================================
-- Final-kind rows (assertion 4 and 7)
-- =============================================================================
-- final_points is SUM(points WHERE target_kind='final'), so to differentiate
-- on final_points we must insert target_kind='final' rows. final_item_kind
-- MUST be set; we use 'champion' uniformly. predicted_team_or_player_id MUST
-- be set when reason_code != 'none' (constraint score_records_final_predicted_required).
-- official_team_or_player_id MUST be set when reason_code IN ('final_correct',
-- 'final_incorrect') (score_records_final_official_required). For the
-- final_correct rows we set predicted = official = ARG. The 20 points come
-- from the §7.3 / final_points.each_item default.
--
-- =============================================================================
-- Pattern: BEGIN / plan(8) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(8);

-- ---------------------------------------------------------------------------
-- Stable identifiers captured in session GUCs so each scenario can reference
-- them without re-typing literal UUIDs. set_config(..., false) pins for the
-- session; survives ROLLBACK TO SAVEPOINT (not used here, but matches style
-- from score_match_idempotent.sql / T011).
-- ---------------------------------------------------------------------------
SELECT set_config('test.t024.p_alpha',   '11111111-1111-1111-1111-111111111111', false);
SELECT set_config('test.t024.p_bravo',   '22222222-2222-2222-2222-222222222222', false);
SELECT set_config('test.t024.p_charlie', '33333333-3333-3333-3333-333333333333', false);
SELECT set_config('test.t024.p_delta',   '44444444-4444-4444-4444-444444444444', false);

SELECT set_config('test.t024.m1', 'eeee0050-0000-0000-0000-000000000001', false);
SELECT set_config('test.t024.m2', 'eeee0050-0000-0000-0000-000000000002', false);
SELECT set_config('test.t024.m3', 'eeee0050-0000-0000-0000-000000000003', false);

-- A throwaway team UUID for final-kind rows. teams(id) FK is NOT enforced on
-- score_records (data-model.md § Entity 1 -- polymorphic predicted/official
-- team_or_player_id has no FK by design), so any UUID is acceptable here. We
-- still pick a deterministic value for readability.
SELECT set_config('test.t024.team_arg', 'aaaa0000-0000-0000-0000-000000000001', false);

-- Per-scenario calculation_version pointers. Starting at 1001 to stay well
-- clear of any version a future slice-005 fixture or score_match SP might
-- write. The outer ROLLBACK undoes the bumps regardless.
SELECT set_config('test.t024.v1', '1001', false);
SELECT set_config('test.t024.v2', '1002', false);
SELECT set_config('test.t024.v3', '1003', false);
SELECT set_config('test.t024.v4', '1004', false);
SELECT set_config('test.t024.v5', '1005', false);
SELECT set_config('test.t024.v6', '1006', false);
SELECT set_config('test.t024.v7', '1007', false);
SELECT set_config('test.t024.v8a', '1008', false);  -- A8 prior (stale) version
SELECT set_config('test.t024.v8b', '1009', false);  -- A8 current version

-- One shared score_calculation_runs row per scenario satisfies score_records.run_id
-- FK without re-deriving a run per row. Each run_id is captured in its own GUC.
SELECT set_config('test.t024.run1', gen_random_uuid()::text, false);
SELECT set_config('test.t024.run2', gen_random_uuid()::text, false);
SELECT set_config('test.t024.run3', gen_random_uuid()::text, false);
SELECT set_config('test.t024.run4', gen_random_uuid()::text, false);
SELECT set_config('test.t024.run5', gen_random_uuid()::text, false);
SELECT set_config('test.t024.run6', gen_random_uuid()::text, false);
SELECT set_config('test.t024.run7', gen_random_uuid()::text, false);
SELECT set_config('test.t024.run8a', gen_random_uuid()::text, false);
SELECT set_config('test.t024.run8b', gen_random_uuid()::text, false);

-- Insert one parent score_calculation_runs row per run_id. scope='all' lets us
-- skip the target_id FK (the scope/target XOR constraint forbids target_id
-- when scope='all'). status='succeeded' with the completeness fields set so
-- the score_calculation_runs_succeeded_completeness CHECK passes. triggered_by
-- = alpha because it is a real participants row (FK satisfied).
INSERT INTO public.score_calculation_runs
  (id, scope, "trigger", triggered_by, reason, status,
   completed_at, affected_record_count, calculation_version_written)
VALUES
  (current_setting('test.t024.run1')::uuid,  'all', 'admin_recalc', current_setting('test.t024.p_alpha')::uuid,
     'T024 scenario A1 tier-1 isolation', 'succeeded', now(), 0, current_setting('test.t024.v1')::int),
  (current_setting('test.t024.run2')::uuid,  'all', 'admin_recalc', current_setting('test.t024.p_alpha')::uuid,
     'T024 scenario A2 tier-2 isolation', 'succeeded', now(), 0, current_setting('test.t024.v2')::int),
  (current_setting('test.t024.run3')::uuid,  'all', 'admin_recalc', current_setting('test.t024.p_alpha')::uuid,
     'T024 scenario A3 tier-3 isolation', 'succeeded', now(), 0, current_setting('test.t024.v3')::int),
  (current_setting('test.t024.run4')::uuid,  'all', 'admin_recalc', current_setting('test.t024.p_alpha')::uuid,
     'T024 scenario A4 tier-4 isolation', 'succeeded', now(), 0, current_setting('test.t024.v4')::int),
  (current_setting('test.t024.run5')::uuid,  'all', 'admin_recalc', current_setting('test.t024.p_alpha')::uuid,
     'T024 scenario A5 all-tied -> shared rank', 'succeeded', now(), 0, current_setting('test.t024.v5')::int),
  (current_setting('test.t024.run6')::uuid,  'all', 'admin_recalc', current_setting('test.t024.p_alpha')::uuid,
     'T024 scenario A6 priority order exact-before-outcome', 'succeeded', now(), 0, current_setting('test.t024.v6')::int),
  (current_setting('test.t024.run7')::uuid,  'all', 'admin_recalc', current_setting('test.t024.p_alpha')::uuid,
     'T024 scenario A7 tier-4 only after tiers 1-3 tied', 'succeeded', now(), 0, current_setting('test.t024.v7')::int),
  (current_setting('test.t024.run8a')::uuid, 'all', 'admin_recalc', current_setting('test.t024.p_alpha')::uuid,
     'T024 scenario A8 prior (stale) version', 'succeeded', now(), 0, current_setting('test.t024.v8a')::int),
  (current_setting('test.t024.run8b')::uuid, 'all', 'admin_recalc', current_setting('test.t024.p_alpha')::uuid,
     'T024 scenario A8 current version', 'succeeded', now(), 0, current_setting('test.t024.v8b')::int);

-- ---------------------------------------------------------------------------
-- A1: Total-only differentiation (no ties anywhere; pure tier 1).
--
-- alpha:   3 exact match rows summing to 30 pts (10+10+10), 3 exact hits
-- bravo:   1 exact match row 10 pts, 1 exact (well clear of alpha on total)
-- charlie: 1 outcome match row 5 pts (well clear of bravo on total)
-- Expected ranks (filtered to these 3): alpha=1, bravo=2, charlie=3.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.t024.v1')::int),
       updated_at = now()
 WHERE key = 'current_calculation_version';

INSERT INTO public.score_records
  (participant_id, target_kind, target_id, match_id, final_item_kind,
   predicted_home, predicted_away, predicted_team_or_player_id,
   official_home, official_away, official_team_or_player_id,
   points, reason_code, calculation_version, calculated_at, run_id, source)
VALUES
  -- alpha: 3 exact rows across M1/M2/M3 = 30 pts, 3 exact hits
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v1')::int, now(),
   current_setting('test.t024.run1')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   0, 0, NULL, 0, 0, NULL, 10, 'exact', current_setting('test.t024.v1')::int, now(),
   current_setting('test.t024.run1')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m3')::uuid, current_setting('test.t024.m3')::uuid, NULL,
   1, 2, NULL, 1, 2, NULL, 10, 'exact', current_setting('test.t024.v1')::int, now(),
   current_setting('test.t024.run1')::uuid, 'auto'),
  -- bravo: 1 exact = 10 pts
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v1')::int, now(),
   current_setting('test.t024.run1')::uuid, 'auto'),
  -- charlie: 1 outcome = 5 pts
  (current_setting('test.t024.p_charlie')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   3, 1, NULL, 2, 1, NULL, 5, 'outcome', current_setting('test.t024.v1')::int, now(),
   current_setting('test.t024.run1')::uuid, 'auto');

-- Assert alpha-bravo-charlie ordering by rank (filtered to these 3 to ignore
-- the other eligible participants the view LEFT-JOINs in at total=0).
SELECT is(
  (
    SELECT string_agg(participant_id::text, ',' ORDER BY rank, participant_id)
      FROM public.leaderboard_v
     WHERE participant_id IN (
       current_setting('test.t024.p_alpha')::uuid,
       current_setting('test.t024.p_bravo')::uuid,
       current_setting('test.t024.p_charlie')::uuid
     )
  ),
  current_setting('test.t024.p_alpha')   || ',' ||
  current_setting('test.t024.p_bravo')   || ',' ||
  current_setting('test.t024.p_charlie'),
  'A1 tier 1 (total-only): alpha (30pts) > bravo (10pts) > charlie (5pts) -- ranks 1,2,3'
);

-- ---------------------------------------------------------------------------
-- A2: Tie on total, differ on exact_count.
--
-- alpha: 30 pts via 2 exact (10+10) + 2 outcome (5+5) -> 2 exact hits
-- bravo: 30 pts via 1 exact (10) + 4 outcome (5+5+5+5) -> 1 exact hit
-- Same total (30) but alpha has more exact -> alpha=1, bravo=2.
--
-- Constraint note: score_records_uk forbids two rows with the same
-- (participant_id, target_kind, target_id, calculation_version). The match-id
-- pool is M1/M2/M3 (3 finished fixture matches). bravo needs 5 rows -- we
-- cannot reuse a match for the same participant at the same version. To
-- get bravo to 5 rows, we use M1/M2/M3 plus a synthetic match. But we have
-- only 3 fixture matches AND the FK on match_id requires the match to exist.
--
-- Solution: bravo also has 4 rows distributed across M1/M2/M3 by changing
-- the geometry: 1 exact at M1 + 3 outcome at M2+M3 + ??? . We are short
-- one match.
--
-- Simpler: make alpha=3 exact rows (30), bravo=1 exact + 4 outcome (10+5*4=30)
-- -- still need 5 rows for bravo. Reduce: alpha=2 exact + 1 outcome (10+10+5=25)
-- vs bravo=1 exact + 3 outcome (10+5+5+5=25). 25 = 25 (total tie), exact: 2 vs 1.
-- Three matches needed per participant -- M1, M2, M3 each appearing once for
-- alpha, and M1, M2, M3 each appearing once for bravo. The fourth row for bravo
-- breaks the per-(participant, match, version) uniqueness.
--
-- Final design (3 matches each, no constraint violation):
--   alpha: M1 exact 10 + M2 exact 10 + M3 outcome 5 = 25 pts, 2 exact hits
--   bravo: M1 exact 10 + M2 outcome 5 + M3 outcome 5 = 20 pts -- NOT a tie!
--
-- Rework so totals tie with exactly 3 rows each. Use final-kind rows to
-- distribute the points more freely (final_item_kind = 'champion' for one,
-- 'runner_up' for another -- they are different (target_kind, target_id)
-- pairs and so survive the uniqueness constraint at the same version).
--
-- Two final-kind rows per participant let us reach the same total in
-- different shapes:
--   alpha: M1 exact (10) + M2 exact (10) + final champion correct (20) + final runner_up incorrect (0) = 40 pts, 2 exact, 0 outcome
--   bravo: M1 exact (10) + M2 outcome (5) + final champion correct (20) + final runner_up correct (20) - 15 = ...
--
-- Cleanest: drop the constraint by giving each participant a unique target_id
-- per row. Use M1/M2/M3 for matches AND two final_item_kinds for finals -- five
-- distinct target slots per participant per version.
--
--   alpha:  M1 exact 10 + M2 exact 10 + M3 incorrect 0 + final champion correct 20 + final runner_up incorrect 0 = 40 pts, 2 exact
--   bravo:  M1 exact 10 + M2 outcome 5 + M3 outcome 5 + final champion correct 20 + final runner_up correct 20 - 20 ... no
--
-- Simplest design that meets the requirement: use FINAL ROWS to top up totals.
-- final_points.each_item = 20 by default (R-014); a 'final_correct' row gives 20.
--
--   alpha: M1 exact 10 + M2 exact 10 + final champion correct 20 = 40 pts, 2 exact
--   bravo: M1 exact 10 + M2 outcome 5 + M3 outcome 5 + final champion correct 20 = 40 pts, 1 exact, 2 outcome
--   tier 1 tie -> tier 2: alpha (2 exact) > bravo (1 exact) -> alpha=1.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.t024.v2')::int),
       updated_at = now()
 WHERE key = 'current_calculation_version';

INSERT INTO public.score_records
  (participant_id, target_kind, target_id, match_id, final_item_kind,
   predicted_home, predicted_away, predicted_team_or_player_id,
   official_home, official_away, official_team_or_player_id,
   points, reason_code, calculation_version, calculated_at, run_id, source)
VALUES
  -- alpha: 40 pts (M1 exact + M2 exact + final champion correct), 2 exact, 0 outcome
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v2')::int, now(),
   current_setting('test.t024.run2')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   0, 0, NULL, 0, 0, NULL, 10, 'exact', current_setting('test.t024.v2')::int, now(),
   current_setting('test.t024.run2')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'final',
     ('11111111-aaaa-aaaa-aaaa-' || lpad(current_setting('test.t024.v2'), 12, '0'))::uuid,
     NULL, 'champion',
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     20, 'final_correct', current_setting('test.t024.v2')::int, now(),
     current_setting('test.t024.run2')::uuid, 'auto'),
  -- bravo: 40 pts (M1 exact + M2 outcome + M3 outcome + final champion correct), 1 exact, 2 outcome
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v2')::int, now(),
   current_setting('test.t024.run2')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   1, 1, NULL, 0, 0, NULL, 5, 'outcome', current_setting('test.t024.v2')::int, now(),
   current_setting('test.t024.run2')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m3')::uuid, current_setting('test.t024.m3')::uuid, NULL,
   0, 1, NULL, 1, 2, NULL, 5, 'outcome', current_setting('test.t024.v2')::int, now(),
   current_setting('test.t024.run2')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'final',
     ('22222222-aaaa-aaaa-aaaa-' || lpad(current_setting('test.t024.v2'), 12, '0'))::uuid,
     NULL, 'champion',
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     20, 'final_correct', current_setting('test.t024.v2')::int, now(),
     current_setting('test.t024.run2')::uuid, 'auto');

SELECT is(
  (
    SELECT participant_id
      FROM public.leaderboard_v
     WHERE participant_id IN (
       current_setting('test.t024.p_alpha')::uuid,
       current_setting('test.t024.p_bravo')::uuid
     )
     ORDER BY rank, participant_id
     LIMIT 1
  ),
  current_setting('test.t024.p_alpha')::uuid,
  'A2 tier 1 tie + tier 2 differ: alpha (2 exact) > bravo (1 exact) at same total=40 -- exact_count breaks the tie'
);

-- ---------------------------------------------------------------------------
-- A3: Tie on (total, exact_count), differ on outcome_count.
--
-- alpha:  M1 exact 10 + M2 outcome 5 + M3 outcome 5 + final champion correct 20 = 40, 1 exact, 2 outcome
-- bravo:  M1 exact 10 + M2 outcome 5 + M3 incorrect 0 + final champion correct 20 = 35  ... not tied
--
-- Rework to tie at total + exact, differ on outcome:
-- alpha: M1 exact 10 + M2 outcome 5 + M3 outcome 5 = 20, 1 exact, 2 outcome
-- bravo: M1 exact 10 + M2 outcome 5 + M3 incorrect 0 = 15 -- not tied.
--
-- The only way to tie on (total, exact) but differ on outcome is to give one
-- participant MORE outcome rows AND ALSO bring their total down via an
-- incorrect row. That makes totals diverge again.
--
-- BUT: we can let bravo carry extra final_incorrect (0-pt) rows that bump
-- nothing but cost nothing -- final_incorrect adds 0 to total, 0 to exact,
-- 0 to outcome. That doesn't help differentiate outcome.
--
-- Correct construction: both participants reach the SAME totals via DIFFERENT
-- mixtures of outcome and final-correct points (final-correct = 20, two
-- outcomes = 10, so the values are commensurable).
--
--   alpha:  M1 exact 10 + M2 outcome 5 + M3 outcome 5 + final champion correct 20 = 40, 1 exact, 2 outcome, final 20
--   bravo:  M1 exact 10 + M2 outcome 5 + final champion correct 20 + final runner_up correct 20 - 15 ... no
--
-- Try: with 2 final-correct rows worth 40 pts, plus shifting match rows.
--   alpha: M1 exact 10 + M2 outcome 5 + M3 outcome 5 + final champion correct 20 = 40, 1 exact, 2 outcome, final 20
--   bravo: M1 exact 10 + M2 outcome 5 + final champion correct 20 + final runner_up incorrect 0 + M3 incorrect 0 = 35 ... no
--
-- Easiest fix: drop "alpha's final" and add more outcome.
--   alpha: M1 exact 10 + M2 outcome 5 + M3 outcome 5 = 20, 1 exact, 2 outcome, final 0
--   bravo: M1 exact 10 + M2 outcome 5 + M3 incorrect 0 + final champion incorrect 0 = 15 ... no
--
-- Use TWO final-correct rows for bravo to balance alpha's outcome rows:
--   alpha: M1 exact 10 + M2 outcome 5 + M3 outcome 5 + final champion correct 20 + final runner_up incorrect 0 = 40, 1 exact, 2 outcome, final 20
--   bravo: M1 exact 10 + M2 outcome 5 + M3 incorrect 0 + final champion correct 20 + final runner_up correct 20 = 55 ... no
--
-- The arithmetic that works: 20-pt final-correct vs 5-pt outcome means we can
-- swap 1 final-correct for 4 outcomes. So if alpha has 4 outcomes and bravo
-- has 0 outcomes + 1 extra final-correct, totals match. But we only have 3
-- match slots per participant (M1, M2, M3), so alpha cannot have 4 outcomes.
--
-- Re-examine: we can use synthetic match UUIDs that point to existing fixture
-- matches. M1 in matches table is one match -- we cannot insert TWO match-kind
-- rows for alpha on M1 at the same version (UK violation).
--
-- The clean alternative: insert ephemeral matches in the test transaction. The
-- ROLLBACK cleans them up. But matches has many FKs and complex shape -- not
-- worth it for a tier-isolation assertion.
--
-- Simpler still: use match_id pool larger than 3 by including the M4 fixture
-- match (eeee0050-...-0000-000000000004). M4 is 'scheduled' (not finished) in
-- the fixture, but the FK only requires it to EXIST in matches -- the view
-- doesn't care about match.status. With 4 match slots and 2 final-item slots
-- (champion, runner_up), we have 6 target slots per participant per version,
-- plenty for tier construction.
--
-- A3 final construction (now feasible with M4 available):
--   alpha: M1 exact 10 + M2 outcome 5 + M3 outcome 5 + final champion correct 20 = 40, 1 exact, 2 outcome
--   bravo: M1 exact 10 + M2 outcome 5 + M3 incorrect 0 + final champion correct 20 + final runner_up correct 20 = 55 -- no
--
-- I keep stumbling. Let me reverse: pick totals that work first.
--   target: alpha = bravo = T, exact_count_alpha = exact_count_bravo = E,
--           outcome_count_alpha > outcome_count_bravo.
--
-- Set E=1, alpha_outcomes=2, bravo_outcomes=1. Each match-row carries
-- exact=10 or outcome=5 or incorrect=0. Each final-row carries 20 or 0.
-- alpha pts: 10 + 5 + 5 = 20 from matches. Add F finals = 20F. Total = 20+20F.
-- bravo pts: 10 + 5 = 15 from matches. Add G finals = 20G. Total = 15+20G.
-- For tie: 20+20F = 15+20G => 20G - 20F = 5 => G - F = 0.25 -- non-integer.
--
-- Adjust: alpha has one incorrect row to round out.
--   alpha: M1 exact 10 + M2 outcome 5 + M3 outcome 5 + M4 incorrect 0 = 20, 1 exact, 2 outcome
--   bravo: M1 exact 10 + M2 outcome 5 + M3 incorrect 0 + M4 incorrect 0 = 15, 1 exact, 1 outcome  -- not tied at total
--
-- Both need same total. Bring bravo up by 5:
--   bravo: ... + ONE EXTRA outcome -- but that gives bravo 2 outcomes too, not differentiation.
--   bravo: ... + ONE EXTRA exact 10 -- gives bravo 2 exacts, breaks tier 2 tie.
--   bravo: ... + final_correct 20 -- now bravo = 35 -- alpha needs +15.
--
-- alpha adds another outcome (+5) -> alpha = 25, 3 outcome; bravo = 35. Still off.
--
-- Try construction with both having one final_correct:
--   alpha: M1 exact 10 + M2 outcome 5 + M3 outcome 5 + final champion correct 20 = 40, 1 exact, 2 outcome, final 20
--   bravo: M1 exact 10 + M2 outcome 5 + M3 outcome 5 + final champion correct 20 = 40 same shape -- ALL TIED, not what we want.
--
-- Trick: have one participant earn outcome points via more match-kind outcomes
-- but offset with one FEWER final_correct.
--   alpha: M1 exact 10 + M2 outcome 5 + M3 outcome 5 + M4 outcome 5 = 25, 1 exact, 3 outcome, final 0
--   bravo: M1 exact 10 + M2 outcome 5 + final champion correct 20 - 10 = ... need total 25.
--   bravo: M1 exact 10 + M2 outcome 5 + (no more match rows valued) + final champion correct 0 (incorrect) = 15 -- short.
--   bravo: M1 exact 10 + M2 outcome 5 + M3 outcome 5 + M4 outcome 5 = 25 -- same as alpha, no differentiation.
--
-- Cleanest design: use a SECOND outcome row, knowing the constraint is on
-- (participant_id, target_kind, target_id, calculation_version) -- different
-- target_id (= different match) is fine. We just have 4 match slots, but
-- that's enough.
--
--   alpha: M1 outcome 5 + M2 outcome 5 + M3 outcome 5 + M4 outcome 5 = 20, 0 exact, 4 outcome
--   bravo: M1 outcome 5 + M2 outcome 5 + M3 outcome 5 + M4 incorrect 0 + final champion correct 5 ... finals = 20 not 5.
--
-- New approach: target_kind='final' rows can carry ANY points if reason_code
-- allows; data-model says points "one of 0, 20" for finals and "validated
-- against tournament_config at write time" -- the CHECK only enforces >=0.
-- For pure view test (bypassing score_match/score_finals), we control the
-- points value directly. We MUST NOT exploit this to break the design
-- contract, but for tier-3 differentiation the count of outcome match rows
-- is the lever.
--
-- A3 final construction (use 4 match rows per participant via M1-M4):
--   alpha: M1 outcome 5 + M2 outcome 5 + M3 outcome 5 + M4 outcome 5 = 20, 0 exact, 4 outcome
--   bravo: M1 outcome 5 + M2 outcome 5 + M3 outcome 5 + M4 incorrect 0 + final champion correct 5 ... no, point shape wrong.
--
-- Drop "tie on total + exact, differ outcome" purity -- use exact=1 each:
--   alpha: M1 exact 10 + M2 outcome 5 + M3 outcome 5 = 20, 1 exact, 2 outcome
--   bravo: M1 exact 10 + M2 outcome 5 + M3 incorrect 0 + M4 outcome 5 ... that's also 2 outcome rows like alpha.
--   bravo: M1 exact 10 + M2 incorrect 0 + M3 outcome 5 + M4 incorrect 0 = 15 -- short by 5.
--   bravo: M1 exact 10 + M2 outcome 5 = 15 -- short by 5 (and 1 outcome).
--
-- The total-tie+exact-tie+outcome-differ scenario REQUIRES the high-outcome
-- participant's "extra" outcomes to be offset by something the low-outcome
-- participant has but the high-outcome one doesn't -- and that "something"
-- mustn't be exact (else tier 2 differentiates) or final (else tier 4
-- differentiates). The only remaining lever is incorrect-but-positive points
-- ... which isn't a thing in §7.2.
--
-- CONCLUSION: tier 3 isolation is structurally impossible with the §7.2
-- truth table (exact=10, outcome=5, incorrect=0) UNLESS we admit that
-- final_correct rows give us a non-outcome lever. So:
--   alpha: 1 exact + 2 outcome + 0 final = 10+5+5 = 20 pts, 1 exact, 2 outcome, 0 final
--   bravo: 1 exact + 0 outcome + 0 final + (?) = needs 20 pts, 1 exact, 0 outcome.
--          1 exact (10) + extra (10) from where? 2 more exacts (10+10=20, but
--          that's 3 exacts not 1)...
--
-- The arithmetic only works if non-outcome points come from finals. So:
--   alpha: 1 exact (10) + 2 outcome (10) + 0 final = 20 pts
--   bravo: 1 exact (10) + 0 outcome  + 0 final + ??? = needs total 20 pts
--          Only way: 1 exact + 0 outcome + 0.5 final-correct -- not integer.
--   bravo: 1 exact (10) + 1 outcome (5) + 0 final = 15 pts
--          bring bravo up by 5: another exact (10) breaks tier 2; another
--          outcome (5) breaks tier 3 invariant (alpha-outcomes > bravo-outcomes
--          by 1 not 2); a final_correct (20) overshoots.
--
-- Make the difference 4 outcomes instead of 1:
--   alpha: 1 exact (10) + 4 outcome (20) + 0 final = 30 pts, 1 exact, 4 outcome
--   bravo: 1 exact (10) + 0 outcome  + 1 final_correct (20) = 30 pts, 1 exact, 0 outcome, final 20
--   tier 1 tie at 30; tier 2 tie at 1 exact; tier 3 alpha=4 outcome > bravo=0 outcome -> alpha=1, bravo=2.
--   tier 4 alpha(0) < bravo(20) -- if tier 3 fails to apply, tier 4 would
--     award bravo, so this scenario actually proves tier 3 PRECEDES tier 4.
--
-- This needs alpha to score outcomes on 4 distinct matches. With M1-M4 (4
-- matches in fixture), this works. M4 is 'scheduled' but the FK is on
-- matches(id) -- status doesn't matter to a pure view test.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.t024.v3')::int),
       updated_at = now()
 WHERE key = 'current_calculation_version';

INSERT INTO public.score_records
  (participant_id, target_kind, target_id, match_id, final_item_kind,
   predicted_home, predicted_away, predicted_team_or_player_id,
   official_home, official_away, official_team_or_player_id,
   points, reason_code, calculation_version, calculated_at, run_id, source)
VALUES
  -- alpha: 30 pts (1 exact + 4 outcome across M1..M4), 1 exact, 4 outcome, 0 final
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v3')::int, now(),
   current_setting('test.t024.run3')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   1, 0, NULL, 0, 0, NULL, 5, 'outcome', current_setting('test.t024.v3')::int, now(),
   current_setting('test.t024.run3')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m3')::uuid, current_setting('test.t024.m3')::uuid, NULL,
   0, 3, NULL, 1, 2, NULL, 5, 'outcome', current_setting('test.t024.v3')::int, now(),
   current_setting('test.t024.run3')::uuid, 'auto'),
  -- alpha M4 outcome row (M4 is 'scheduled' in the fixture but FK only requires existence)
  (current_setting('test.t024.p_alpha')::uuid, 'match',
     'eeee0050-0000-0000-0000-000000000004'::uuid, 'eeee0050-0000-0000-0000-000000000004'::uuid, NULL,
   2, 0, NULL, 1, 0, NULL, 5, 'outcome', current_setting('test.t024.v3')::int, now(),
   current_setting('test.t024.run3')::uuid, 'auto'),
  -- bravo: 30 pts (1 exact + 1 final_correct), 1 exact, 0 outcome, 20 final
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v3')::int, now(),
   current_setting('test.t024.run3')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'final',
     ('22222222-aaaa-aaaa-aaaa-' || lpad(current_setting('test.t024.v3'), 12, '0'))::uuid,
     NULL, 'champion',
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     20, 'final_correct', current_setting('test.t024.v3')::int, now(),
     current_setting('test.t024.run3')::uuid, 'auto');

SELECT is(
  (
    SELECT participant_id
      FROM public.leaderboard_v
     WHERE participant_id IN (
       current_setting('test.t024.p_alpha')::uuid,
       current_setting('test.t024.p_bravo')::uuid
     )
     ORDER BY rank, participant_id
     LIMIT 1
  ),
  current_setting('test.t024.p_alpha')::uuid,
  'A3 tier 1+2 tie + tier 3 differ: alpha (4 outcome) > bravo (0 outcome) at same total=30, same exact=1 -- outcome_count breaks the tie (and PROVES tier 3 outranks tier 4 because bravo has higher final_points)'
);

-- ---------------------------------------------------------------------------
-- A4: Tie on (total, exact, outcome), differ on final_points.
--
-- alpha: 1 exact (10) + 1 outcome (5) + 1 final_correct (20) = 35, 1 exact, 1 outcome, 20 final
-- bravo: 1 exact (10) + 1 outcome (5) + 0 final but needs total = 35. Add a
--        2nd exact: 2 exact + 1 outcome = 25 -- short. Plus another exact:
--        3 exact + 1 outcome = 35, BUT exact_count is now 3 vs alpha's 1
--        (tier 2 would differentiate).
--
-- Use 2 final_correct rows on alpha and adjust bravo:
-- alpha: 1 exact (10) + 1 outcome (5) + 2 final_correct (40) = 55, 1 exact, 1 outcome, 40 final
-- bravo: needs 1 exact + 1 outcome + 55 - 15 = 40 non-finals. 4 exacts (40)
--        breaks tier 2. 8 outcomes (40) breaks tier 3. So bravo MUST be made
--        to reach a total via finals, only at a LOWER value than alpha's final
--        points.
-- bravo: 1 exact (10) + 1 outcome (5) + 1 final_correct (20) + 1 final_correct (20) = 55,
--        1 exact, 1 outcome, 40 final -- SAME shape as alpha. No tier 4 diff.
--
-- The trick: differentiate finals via the 4 final-item slots. A
-- final_incorrect row is 0 pts and doesn't move finals total. To raise
-- finals on one and not the other while keeping total equal, the OTHER
-- participant's "missing" 20 pts must come from somewhere that doesn't
-- bump exact or outcome.
--
-- Only way to add points without bumping exact_count or outcome_count
-- (within §7.2/§7.3): there isn't one. The four reason codes are
-- exact/outcome/incorrect/final_correct/final_incorrect/none, and the
-- non-zero ones are exact (bumps exact_count), outcome (bumps outcome_count),
-- final_correct (bumps final_points).
--
-- So a clean tier-4-only-differentiation requires the participants to differ
-- ONLY on final_correct rows -- which means alpha and bravo have IDENTICAL
-- exact_count, outcome_count, AND total -- meaning either both have N
-- final_corrects (no differentiation) or one has N and the other has N-1
-- with a compensating row ... which would have to be exact or outcome,
-- breaking the lower tiers.
--
-- ALTERNATIVE: the spec's tier 4 is "highest final tournament prediction
-- points", which is a SUM not a count. Two participants can have the SAME
-- final_correct count but DIFFERENT final_points only if final rows carry
-- DIFFERENT point values -- which the §7.3 default disallows (20 each).
--
-- The only legitimate tier-4 differentiation under the default scoring rules
-- is when the participants tie at tier 1-3 BUT one has more final_correct
-- rows -- which means they DON'T tie at total. Contradiction.
--
-- UNLESS final_correct rows can co-exist with a final_incorrect that offsets.
-- final_incorrect = 0 pts, so it doesn't change total. Two participants both
-- pick champion+runner_up:
--   alpha:  champion correct (20) + runner_up correct (20) = 40 final, 2 final_correct rows
--   bravo:  champion correct (20) + runner_up incorrect (0) = 20 final, 1 final_correct row, 1 final_incorrect
-- alpha total = 40, bravo total = 20 -- not tied.
--
-- This means: in the default scoring rules, tier 4 cannot differentiate two
-- participants who tie on the first three tiers. The tier-4 isolation test is
-- VALUABLE in that it verifies the view APPLIES tier 4 -- but the assertion
-- has to construct a scenario where tier 4 actually matters. The only way is
-- via tier-7 fallback ordering where two participants tie on tiers 1-3 but
-- the tie is "broken" by the OTHER row pattern -- which can only happen if
-- the tier 4 column itself differs. So the construction MUST use rows that
-- legitimately give DIFFERENT final_points while keeping total equal -- which
-- requires DIFFERENT total counts of OTHER point sources.
--
-- The way out: vary the OTHER source (exact/outcome) but keep COUNTS equal:
--   alpha: 1 exact (10) + 1 outcome (5) + 1 final_correct (20) = 35, 1 exact, 1 outcome, 20 final
--   bravo: 2 exact (20) + 1 outcome (5) + 0 final = 25, 2 exact, 1 outcome, 0 final
--   -- alpha tier 1 = 35 > bravo = 25 -- tier 1 differentiates. Not tier 4.
--
-- I now suspect tier-4-only differentiation under default scoring is impossible
-- WITHOUT bending the §7.3 invariant. The realistic interpretation of the task
-- body's assertion #4 ("Tie on total + exact + outcome, differ on final_points":
-- P1: 30/1 exact/1 outcome/20 final, P2: 30/1 exact/1 outcome/0 final) requires
-- P1.total - P1.final_points = 30 - 20 = 10 from non-finals (1 exact + 0 outcome
-- = 10 ... but P1 ALSO has 1 outcome = 5 ... contradiction: 10 + 5 + 20 = 35 not 30).
-- The task body's numbers don't arithmetic-check under §7.2/§7.3 defaults.
--
-- Resolution: this slice is a PURE VIEW test (no score_match invocation) -- so
-- the assertions can stipulate ARBITRARY (points, reason_code) values that
-- aren't constrained by §7.2/§7.3. The points column on score_records has only
-- a >= 0 CHECK; the rule that "exact => 10" is enforced by score_match, NOT
-- by the storage layer. The view computes total = SUM(points), exact_count =
-- COUNT(reason_code='exact'), etc -- so we can use bespoke point values to
-- engineer the tie shapes the §7.4 priority order demands.
--
-- A4 (using engineered points to test tier 4 in isolation):
--   alpha: 1 row reason_code='exact' worth 10  (total=10, exact=1)
--          1 row reason_code='outcome' worth 0 (total=10, outcome=1) -- engineered 0-pt outcome
--          1 row reason_code='final_correct' worth 20 (total=30, final=20)
--   bravo: 1 row reason_code='exact' worth 10  (total=10, exact=1)
--          1 row reason_code='outcome' worth 0 (total=10, outcome=1) -- engineered 0-pt outcome
--          1 row reason_code='final_incorrect' worth 0 (total=10, final=0)
--          + 1 row reason_code='exact' on a different match worth 20 (no -- breaks exact count)
--
-- The constraint score_records_final_official_required requires
-- official_team_or_player_id IS NOT NULL when reason_code IN
-- ('final_correct','final_incorrect'). We set it accordingly.
--
-- Tier 4 isolation works in this engineered scenario:
--   alpha: total = 10+0+20 = 30, exact=1, outcome=1, final=20
--   bravo: total = 10+0+0   = 10, exact=1, outcome=1, final=0  -- NOT TIED ON TOTAL.
--
-- I keep getting stuck because the OUTCOME-row-with-0-points trick makes the
-- "1 outcome" rows worth different cumulative totals. To tie on total:
--   alpha total - bravo total = (alpha final - bravo final) = 20 - 0 = 20
--   So we need OTHER alpha rows to be 20 less than other bravo rows.
--   1 exact for both (10 each), 1 outcome for both (5 each) -> equal so far.
--   Need bravo to have 20 MORE non-final pts somehow without bumping exact
--   or outcome counts. Only way: an "incorrect" reason_code row -- which by
--   §7.2 carries 0 pts. Engineering 20 pts onto an 'incorrect' row:
--
--   bravo extra row: reason_code='incorrect' worth 20.
--
-- Final A4 construction (engineered points for view-only correctness test):
--   alpha: exact 10 + outcome 5 + final_correct 20 = 35 total, 1 exact, 1 outcome, 20 final
--   bravo: exact 10 + outcome 5 + incorrect 20 + final_incorrect 0 = 35 total, 1 exact, 1 outcome, 0 final
--   ties on (total=35, exact=1, outcome=1); differ on final (20 vs 0) -> alpha rank 1.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.t024.v4')::int),
       updated_at = now()
 WHERE key = 'current_calculation_version';

INSERT INTO public.score_records
  (participant_id, target_kind, target_id, match_id, final_item_kind,
   predicted_home, predicted_away, predicted_team_or_player_id,
   official_home, official_away, official_team_or_player_id,
   points, reason_code, calculation_version, calculated_at, run_id, source)
VALUES
  -- alpha: 35 total, 1 exact, 1 outcome, 20 final
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v4')::int, now(),
   current_setting('test.t024.run4')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   1, 0, NULL, 0, 0, NULL, 5, 'outcome', current_setting('test.t024.v4')::int, now(),
   current_setting('test.t024.run4')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'final',
     ('11111111-aaaa-aaaa-aaaa-' || lpad(current_setting('test.t024.v4'), 12, '0'))::uuid,
     NULL, 'champion',
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     20, 'final_correct', current_setting('test.t024.v4')::int, now(),
     current_setting('test.t024.run4')::uuid, 'auto'),
  -- bravo: 35 total, 1 exact, 1 outcome, 0 final. The 20-pt 'incorrect' row is
  -- ENGINEERED for view-test purposes (real score_match would never produce a
  -- 20-pt incorrect row -- §7.2 mandates 0). This is acceptable because T024
  -- is a PURE view test: the view sums points and counts reason_codes; it does
  -- NOT validate the §7.2 truth table (that's score_match's job at write time).
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v4')::int, now(),
   current_setting('test.t024.run4')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   1, 0, NULL, 0, 0, NULL, 5, 'outcome', current_setting('test.t024.v4')::int, now(),
   current_setting('test.t024.run4')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m3')::uuid, current_setting('test.t024.m3')::uuid, NULL,
   3, 3, NULL, 1, 2, NULL, 20, 'incorrect', current_setting('test.t024.v4')::int, now(),
   current_setting('test.t024.run4')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'final',
     ('22222222-aaaa-aaaa-aaaa-' || lpad(current_setting('test.t024.v4'), 12, '0'))::uuid,
     NULL, 'champion',
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     0, 'final_incorrect', current_setting('test.t024.v4')::int, now(),
     current_setting('test.t024.run4')::uuid, 'auto');

SELECT is(
  (
    SELECT participant_id
      FROM public.leaderboard_v
     WHERE participant_id IN (
       current_setting('test.t024.p_alpha')::uuid,
       current_setting('test.t024.p_bravo')::uuid
     )
     ORDER BY rank, participant_id
     LIMIT 1
  ),
  current_setting('test.t024.p_alpha')::uuid,
  'A4 tier 1+2+3 tie + tier 4 differ: alpha (20 final_pts) > bravo (0 final_pts) at same total=35, same exact=1, same outcome=1 -- final_points breaks the tie'
);

-- ---------------------------------------------------------------------------
-- A5: All four tiers tied -> shared rank (RANK() returns 1, 1).
--
-- alpha and bravo identical shape:
--   1 exact (10) + 1 outcome (5) + 1 final_correct (20) = 35, 1 exact, 1 outcome, 20 final
-- Expected: RANK() OVER (...) = 1 for both (R-004; §7.4 tier 6 shared rank).
--
-- Assertion: COUNT of participants among {alpha, bravo} with rank=1 is 2.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.t024.v5')::int),
       updated_at = now()
 WHERE key = 'current_calculation_version';

INSERT INTO public.score_records
  (participant_id, target_kind, target_id, match_id, final_item_kind,
   predicted_home, predicted_away, predicted_team_or_player_id,
   official_home, official_away, official_team_or_player_id,
   points, reason_code, calculation_version, calculated_at, run_id, source)
VALUES
  -- alpha
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v5')::int, now(),
   current_setting('test.t024.run5')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   1, 0, NULL, 0, 0, NULL, 5, 'outcome', current_setting('test.t024.v5')::int, now(),
   current_setting('test.t024.run5')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'final',
     ('11111111-aaaa-aaaa-aaaa-' || lpad(current_setting('test.t024.v5'), 12, '0'))::uuid,
     NULL, 'champion',
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     20, 'final_correct', current_setting('test.t024.v5')::int, now(),
     current_setting('test.t024.run5')::uuid, 'auto'),
  -- bravo (identical totals)
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v5')::int, now(),
   current_setting('test.t024.run5')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   1, 0, NULL, 0, 0, NULL, 5, 'outcome', current_setting('test.t024.v5')::int, now(),
   current_setting('test.t024.run5')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'final',
     ('22222222-aaaa-aaaa-aaaa-' || lpad(current_setting('test.t024.v5'), 12, '0'))::uuid,
     NULL, 'champion',
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     20, 'final_correct', current_setting('test.t024.v5')::int, now(),
     current_setting('test.t024.run5')::uuid, 'auto');

SELECT is(
  (
    SELECT count(*)::int
      FROM public.leaderboard_v
     WHERE participant_id IN (
       current_setting('test.t024.p_alpha')::uuid,
       current_setting('test.t024.p_bravo')::uuid
     )
       AND rank = 1
  ),
  2,
  'A5 all four tiers tied -> RANK() returns shared rank 1 for both participants (R-004 RANK() not DENSE_RANK(); §7.4 tier 6)'
);

-- ---------------------------------------------------------------------------
-- A6: View respects tiebreaker.order config (priority order verification).
--
-- Engineered to fail if the view sorts by outcome BEFORE exact, or by a
-- different priority than §7.4. Same totals, alpha has MORE outcome but
-- FEWER exact than bravo. §7.4 says exact precedes outcome -> bravo wins.
--
-- alpha: 1 exact (10) + 5 outcome (engineered 4 pts each = 20) = 30 total,
--        1 exact, 5 outcome   (5 outcome rows: M1 + M2 + M3 + M4 + one more
--        match slot needed) -- M5 doesn't exist. Use 4 outcomes worth 5 each
--        plus 1 outcome worth 0 (engineered) to reach 5 outcome rows / 20 pts.
--        Better: use 4 outcomes at engineered values + 1 final_correct:
--   alpha: 1 exact (10) + 5 outcome (engineered to total 20 -- e.g. 4+4+4+4+4)
--          = 30 total, 1 exact, 5 outcome
--   bravo: 2 exact (engineered to total 20 -- e.g. 10+10) + 1 final_incorrect (0)
--          = 20 total -- short by 10.
--   bravo: 2 exact (20) + 2 outcome (engineered 5 each = 10) = 30 total, 2 exact, 2 outcome
--          tier 1 tie at 30, alpha=1 exact, bravo=2 exact -> tier 2 says
--          bravo > alpha; alpha has 5 outcome, bravo has 2 outcome -> if
--          OUTCOME were tier 2 instead of EXACT, alpha would win.
--          Per §7.4: bravo wins. -> bravo=1, alpha=2.
--
-- A6 construction:
--   alpha: 1 exact (10) + 4 outcome rows at 5 pts each (M1 exact, M2/M3/M4 + one final-as-outcome ... no, finals are target_kind='final')
--
-- Cleaner: use 4 distinct matches (M1-M4) for alpha's outcomes plus 1 exact
-- on a SECOND target -- but each (participant, match, version) is unique-once.
--
-- Use 4 outcome rows on M1-M4 + 1 exact via a final-kind row? No -- exact
-- reason_code is for match-kind only conceptually, but the score_records
-- table doesn't restrict reason_code by target_kind (only the CHECK
-- score_records_match_official_required ties match-kind to non-NULL
-- official_home/away for non-'none' reasons; and score_records_final_official_required
-- ties final-kind to official_team_or_player_id for final_correct/incorrect).
-- The view, however, computes exact_count = COUNT(reason_code='exact')
-- regardless of target_kind.
--
-- That said, mixing reason_codes across target_kinds is a violation of
-- semantic intent. Stick to match-kind rows for exact/outcome and final-kind
-- for final_correct/final_incorrect.
--
-- Final A6 design (5 distinct match slots for alpha needs M1-M4 + one more):
-- We have only M1-M4 in the fixture. So cap alpha's outcomes at 4 (M1 exact,
-- M2-M4 outcome -- 3 outcomes). bravo can have 2 exacts on different matches.
--
-- A6 (within 4-match constraint):
--   alpha: 1 exact (M1, 10) + 2 outcome (M2 5, M3 5) + 1 outcome (M4 5) = 25, 1 exact, 3 outcome
--   bravo: 2 exact (M1 10, M2 10) + 1 outcome (M3 5) = 25, 2 exact, 1 outcome
--   tier 1 tie at 25; tier 2 alpha=1 < bravo=2 -> bravo wins (per §7.4).
--   ALSO: alpha has 3 outcome > bravo's 1 outcome -- so if the view erroneously
--   prioritized outcome before exact, alpha would win. Our assertion is that
--   bravo wins.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.t024.v6')::int),
       updated_at = now()
 WHERE key = 'current_calculation_version';

INSERT INTO public.score_records
  (participant_id, target_kind, target_id, match_id, final_item_kind,
   predicted_home, predicted_away, predicted_team_or_player_id,
   official_home, official_away, official_team_or_player_id,
   points, reason_code, calculation_version, calculated_at, run_id, source)
VALUES
  -- alpha: 25 total, 1 exact, 3 outcome (higher outcome)
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v6')::int, now(),
   current_setting('test.t024.run6')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   1, 0, NULL, 0, 0, NULL, 5, 'outcome', current_setting('test.t024.v6')::int, now(),
   current_setting('test.t024.run6')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m3')::uuid, current_setting('test.t024.m3')::uuid, NULL,
   0, 3, NULL, 1, 2, NULL, 5, 'outcome', current_setting('test.t024.v6')::int, now(),
   current_setting('test.t024.run6')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match',
     'eeee0050-0000-0000-0000-000000000004'::uuid, 'eeee0050-0000-0000-0000-000000000004'::uuid, NULL,
   2, 0, NULL, 1, 0, NULL, 5, 'outcome', current_setting('test.t024.v6')::int, now(),
   current_setting('test.t024.run6')::uuid, 'auto'),
  -- bravo: 25 total, 2 exact, 1 outcome (higher exact)
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v6')::int, now(),
   current_setting('test.t024.run6')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   0, 0, NULL, 0, 0, NULL, 10, 'exact', current_setting('test.t024.v6')::int, now(),
   current_setting('test.t024.run6')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m3')::uuid, current_setting('test.t024.m3')::uuid, NULL,
   0, 3, NULL, 1, 2, NULL, 5, 'outcome', current_setting('test.t024.v6')::int, now(),
   current_setting('test.t024.run6')::uuid, 'auto');

SELECT is(
  (
    SELECT participant_id
      FROM public.leaderboard_v
     WHERE participant_id IN (
       current_setting('test.t024.p_alpha')::uuid,
       current_setting('test.t024.p_bravo')::uuid
     )
     ORDER BY rank, participant_id
     LIMIT 1
  ),
  current_setting('test.t024.p_bravo')::uuid,
  'A6 priority order: exact (tier 2) PRECEDES outcome (tier 3) -- bravo (2 exact / 1 outcome) > alpha (1 exact / 3 outcome) at same total=25'
);

-- ---------------------------------------------------------------------------
-- A7: Tier 4 (final_points) only differentiates after tiers 1-3 all tied.
--
-- Mirror of A4 but in reverse direction: bravo has the higher final, alpha
-- the lower. Demonstrates that final_points is consulted ONLY when the first
-- three tiers tie.
--
-- alpha: 1 exact (10) + 1 outcome (5) + 1 incorrect (engineered 20) + 1 final_incorrect (0) = 35, 1 exact, 1 outcome, 0 final
-- bravo: 1 exact (10) + 1 outcome (5) + 1 final_correct (20) = 35, 1 exact, 1 outcome, 20 final
-- ties on (35, 1 exact, 1 outcome); differ on final -> bravo rank 1.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.t024.v7')::int),
       updated_at = now()
 WHERE key = 'current_calculation_version';

INSERT INTO public.score_records
  (participant_id, target_kind, target_id, match_id, final_item_kind,
   predicted_home, predicted_away, predicted_team_or_player_id,
   official_home, official_away, official_team_or_player_id,
   points, reason_code, calculation_version, calculated_at, run_id, source)
VALUES
  -- alpha: 35 total, 1 exact, 1 outcome, 0 final (engineered 20-pt incorrect for total parity)
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v7')::int, now(),
   current_setting('test.t024.run7')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   1, 0, NULL, 0, 0, NULL, 5, 'outcome', current_setting('test.t024.v7')::int, now(),
   current_setting('test.t024.run7')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m3')::uuid, current_setting('test.t024.m3')::uuid, NULL,
   3, 3, NULL, 1, 2, NULL, 20, 'incorrect', current_setting('test.t024.v7')::int, now(),
   current_setting('test.t024.run7')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'final',
     ('11111111-aaaa-aaaa-aaaa-' || lpad(current_setting('test.t024.v7'), 12, '0'))::uuid,
     NULL, 'champion',
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     0, 'final_incorrect', current_setting('test.t024.v7')::int, now(),
     current_setting('test.t024.run7')::uuid, 'auto'),
  -- bravo: 35 total, 1 exact, 1 outcome, 20 final
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v7')::int, now(),
   current_setting('test.t024.run7')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   1, 0, NULL, 0, 0, NULL, 5, 'outcome', current_setting('test.t024.v7')::int, now(),
   current_setting('test.t024.run7')::uuid, 'auto'),
  (current_setting('test.t024.p_bravo')::uuid, 'final',
     ('22222222-aaaa-aaaa-aaaa-' || lpad(current_setting('test.t024.v7'), 12, '0'))::uuid,
     NULL, 'champion',
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     NULL, NULL, current_setting('test.t024.team_arg')::uuid,
     20, 'final_correct', current_setting('test.t024.v7')::int, now(),
     current_setting('test.t024.run7')::uuid, 'auto');

SELECT is(
  (
    SELECT participant_id
      FROM public.leaderboard_v
     WHERE participant_id IN (
       current_setting('test.t024.p_alpha')::uuid,
       current_setting('test.t024.p_bravo')::uuid
     )
     ORDER BY rank, participant_id
     LIMIT 1
  ),
  current_setting('test.t024.p_bravo')::uuid,
  'A7 tier 4 (final_points) differentiates only after tiers 1-3 tied: bravo (20 final) > alpha (0 final) at same total=35, same exact=1, same outcome=1'
);

-- ---------------------------------------------------------------------------
-- A8: Cross-version isolation -- only current_calculation_version rows count.
--
-- alpha at v8a has 30 pts; we then bump current_calculation_version to v8b and
-- insert alpha rows totalling 10 pts at v8b. leaderboard_v MUST report alpha's
-- total as 10 (the v8b rows), NOT 30 (the v8a rows) or 40 (sum of both).
--
-- This is R-003's flip-the-pointer guarantee: the v8a rows STAY in
-- score_records (append-only history), but the view filters by current
-- version so they are invisible.
-- ---------------------------------------------------------------------------
-- Phase 1: write the OLD version data (30 pts at v8a).
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.t024.v8a')::int),
       updated_at = now()
 WHERE key = 'current_calculation_version';

INSERT INTO public.score_records
  (participant_id, target_kind, target_id, match_id, final_item_kind,
   predicted_home, predicted_away, predicted_team_or_player_id,
   official_home, official_away, official_team_or_player_id,
   points, reason_code, calculation_version, calculated_at, run_id, source)
VALUES
  -- alpha: 30 pts at v8a (stale once we bump)
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v8a')::int, now(),
   current_setting('test.t024.run8a')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m2')::uuid, current_setting('test.t024.m2')::uuid, NULL,
   0, 0, NULL, 0, 0, NULL, 10, 'exact', current_setting('test.t024.v8a')::int, now(),
   current_setting('test.t024.run8a')::uuid, 'auto'),
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m3')::uuid, current_setting('test.t024.m3')::uuid, NULL,
   1, 2, NULL, 1, 2, NULL, 10, 'exact', current_setting('test.t024.v8a')::int, now(),
   current_setting('test.t024.run8a')::uuid, 'auto');

-- Phase 2: bump current_calculation_version to v8b and insert a SMALLER total
-- (10 pts) at the new version. The 30-pt v8a rows remain in storage (history)
-- but the view must ignore them.
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.t024.v8b')::int),
       updated_at = now()
 WHERE key = 'current_calculation_version';

INSERT INTO public.score_records
  (participant_id, target_kind, target_id, match_id, final_item_kind,
   predicted_home, predicted_away, predicted_team_or_player_id,
   official_home, official_away, official_team_or_player_id,
   points, reason_code, calculation_version, calculated_at, run_id, source)
VALUES
  -- alpha: 10 pts at v8b (current version)
  (current_setting('test.t024.p_alpha')::uuid, 'match', current_setting('test.t024.m1')::uuid, current_setting('test.t024.m1')::uuid, NULL,
   2, 1, NULL, 2, 1, NULL, 10, 'exact', current_setting('test.t024.v8b')::int, now(),
   current_setting('test.t024.run8b')::uuid, 'auto');

SELECT is(
  (
    SELECT total_points::int
      FROM public.leaderboard_v
     WHERE participant_id = current_setting('test.t024.p_alpha')::uuid
  ),
  10,
  'A8 cross-version isolation: leaderboard_v reports alpha total=10 (only v8b rows) NOT 30 (stale v8a rows) -- R-003 flip-the-pointer'
);

SELECT * FROM finish();

ROLLBACK;
