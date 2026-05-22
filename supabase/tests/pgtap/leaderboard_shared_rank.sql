-- Slice 005 / T025 / US3 Acceptance Scenario 5 / research.md § R-004.
-- RED until T029 ships leaderboard_v at on-disk slot 0054 per D-023.
-- Verifies RANK() shared-rank pattern: 1, 2, 2, 4 (NOT 1, 2, 2, 3 -- that's
-- DENSE_RANK, deferred to Slice 008 per R-004).
--
-- This file authors the shared-rank / tie-breaker contract for the not-yet-
-- shipped leaderboard_v view (T029 / slot 0054). Per R-004, ranking is
-- computed with RANK() OVER (ORDER BY total_points DESC, exact_count DESC,
-- outcome_count DESC, final_points DESC) so participants tied across ALL
-- configured tie-breaker tiers (§7.4 tier 6) share the SAME rank, and the
-- next rank position SKIPS to the count-adjusted value (US3 Acceptance
-- Scenario 5: "1, 2, 2, 4 pattern").
--
-- Scenario construction (US3 Acceptance Scenario 5):
--   alpha   total=10  exact=1  outcome=0  final=0  -> rank 1
--   bravo   total=5   exact=0  outcome=1  final=0  -> rank 2 (tied with charlie)
--   charlie total=5   exact=0  outcome=1  final=0  -> rank 2 (tied with bravo)
--   delta   total=3   exact=0  outcome=1  final=0  -> rank 4 (NOT 3 -- RANK() skips)
--
-- Note on delta=3: the test inserts a raw 3-point row to make delta strictly
-- lower than bravo/charlie on tier 1. 3 is not a canonical match point value
-- (FR-001 produces 0/5/10) but score_records.points CHECK only enforces
-- `>= 0`; the FR-001 enum-of-values discipline is enforced by score_match
-- (T013), not by the storage table. This test bypasses score_match and
-- writes directly because we only care about leaderboard_v's ORDER BY /
-- RANK() projection here -- T024 + T011 own score_match's value contract.
--
-- Why we mutate tournament_config.current_calculation_version: leaderboard_v
-- (per data-model.md § Entity 4) filters score_records to ONLY the rows at
-- `calculation_version = tournament_config.current_calculation_version` (the
-- R-003 flip-the-pointer pattern). To isolate this test's 4 rows from any
-- already-seeded score_records at version 1 (T006), we use a fresh sentinel
-- version (99) AND point current_calculation_version at it for the duration
-- of this transaction. Both writes ROLLBACK at end-of-test.
--
-- Pattern: BEGIN / plan(3) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(3);

-- ---------------------------------------------------------------------------
-- SETUP: sentinel calculation_version + tournament_config redirect.
-- ---------------------------------------------------------------------------
-- A fresh, deliberately-high version isolates this test's 4 rows from any
-- score_records previously written at version 1 by the fixture or other
-- tests within the same DB session. set_config(..., false) is SESSION-scope
-- so the value is readable across statements; the final ROLLBACK reverts
-- the actual database state, including the tournament_config UPDATE below.
SELECT set_config('test.cv', '99', false);

-- Redirect leaderboard_v's current-version filter to our sentinel. This
-- UPDATE is rolled back with the outer transaction; no permanent state
-- change occurs. The value column is jsonb -- we cast the int to jsonb so
-- the row's type stays consistent with T006's seed shape.
UPDATE public.tournament_config
   SET value = to_jsonb(current_setting('test.cv')::int)
 WHERE key = 'current_calculation_version';

-- Manufacture a score_calculation_runs row to satisfy score_records.run_id
-- NOT NULL + FK (slot 0050). Status='succeeded' with all required
-- completeness columns (per the score_calculation_runs_succeeded_completeness
-- CHECK in slot 0050: completed_at + affected_record_count +
-- calculation_version_written all populated). We pick triggered_by=admin1
-- (77777777-...) -- the slice-005 fixture seeds admin1 as an active
-- participant, satisfying the FK to participants(id). trigger='admin_recalc'
-- with a reason satisfies the reason_required_for_admin_and_config CHECK.
SELECT set_config('test.t025.run_id', gen_random_uuid()::text, false);

INSERT INTO public.score_calculation_runs (
  id, scope, "trigger", triggered_by, reason,
  started_at, completed_at, status,
  affected_record_count, calculation_version_written
) VALUES (
  current_setting('test.t025.run_id')::uuid,
  'all',                                          -- scope='all' -> target_id stays NULL (CHECK)
  'admin_recalc',
  '77777777-7777-7777-7777-777777777777',         -- admin1 (slice-005 fixture)
  'T025 leaderboard_v shared-rank pattern test (US3 AS5)',
  now() - interval '1 second',
  now(),
  'succeeded',
  4,
  current_setting('test.cv')::int
);

-- ---------------------------------------------------------------------------
-- INSERT 4 score_records (one per participant) at version 99. All four
-- target the same fixture match (M1, eeee0050-...000000001) so the rows are
-- legal under score_records_uk = (participant_id, target_kind, target_id,
-- calculation_version): each participant has at most one row per (target,
-- version), which we satisfy. The target_kind='match' shape requires
-- match_id IS NOT NULL AND match_id = target_id (slot 0049
-- score_records_target_kind_shape CHECK).
--
-- Per-participant reason_code/points -> derived tier values that
-- leaderboard_v will GROUP BY (research § R-005):
--   alpha    reason_code='exact'    points=10   -> exact_count=1, outcome_count=0
--   bravo    reason_code='outcome'  points=5    -> exact_count=0, outcome_count=1
--   charlie  reason_code='outcome'  points=5    -> exact_count=0, outcome_count=1  (tied w/ bravo across all tiers)
--   delta    reason_code='outcome'  points=3    -> exact_count=0, outcome_count=1, total=3
-- final_points is 0 for every participant (no final-kind rows here).
--
-- We populate predicted_home/away + official_home/away because the
-- score_records_match_official_required CHECK requires both whenever
-- reason_code != 'none'.
-- ---------------------------------------------------------------------------
INSERT INTO public.score_records (
  participant_id, target_kind, target_id, match_id,
  predicted_home, predicted_away, official_home, official_away,
  points, reason_code, calculation_version, run_id, source
) VALUES
  -- alpha total=10 (exact)
  ('11111111-1111-1111-1111-111111111111', 'match',
   'eeee0050-0000-0000-0000-000000000001', 'eeee0050-0000-0000-0000-000000000001',
   2, 1, 2, 1,
   10, 'exact', current_setting('test.cv')::int,
   current_setting('test.t025.run_id')::uuid, 'auto'),
  -- bravo total=5 (outcome) -- tied with charlie across ALL tiers
  ('22222222-2222-2222-2222-222222222222', 'match',
   'eeee0050-0000-0000-0000-000000000001', 'eeee0050-0000-0000-0000-000000000001',
   3, 1, 2, 1,
   5, 'outcome', current_setting('test.cv')::int,
   current_setting('test.t025.run_id')::uuid, 'auto'),
  -- charlie total=5 (outcome) -- tied with bravo across ALL tiers
  ('33333333-3333-3333-3333-333333333333', 'match',
   'eeee0050-0000-0000-0000-000000000001', 'eeee0050-0000-0000-0000-000000000001',
   4, 1, 2, 1,
   5, 'outcome', current_setting('test.cv')::int,
   current_setting('test.t025.run_id')::uuid, 'auto'),
  -- delta total=3 (outcome with non-canonical 3-point award; see header)
  ('44444444-4444-4444-4444-444444444444', 'match',
   'eeee0050-0000-0000-0000-000000000001', 'eeee0050-0000-0000-0000-000000000001',
   5, 1, 2, 1,
   3, 'outcome', current_setting('test.cv')::int,
   current_setting('test.t025.run_id')::uuid, 'auto');

-- ---------------------------------------------------------------------------
-- Assertion 1: RANK() yields the 1, 2, 2, 4 pattern (US3 AS5 / R-004).
--
-- We project (participant_id, rank) for our 4 personas, ORDER BY rank,
-- participant_id for stable serialization, and compare against the
-- canonical expected JSON. Tie-breakers in §7.4 priority order produce:
--   alpha   rank 1 (highest total)
--   bravo   rank 2 (tied with charlie -- bravo sorts first by participant_id)
--   charlie rank 2 (tied with bravo)
--   delta   rank 4 (RANK() skips 3, NOT DENSE_RANK's 3 -- R-004 deferral)
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT json_agg(
            json_build_object('p', participant_id, 'r', rank)
            ORDER BY rank, participant_id
          )::text
     FROM public.leaderboard_v
    WHERE calculation_version = current_setting('test.cv')::int
      AND participant_id IN (
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444'
      )),
  '[{"p" : "11111111-1111-1111-1111-111111111111", "r" : 1}, '
    || '{"p" : "22222222-2222-2222-2222-222222222222", "r" : 2}, '
    || '{"p" : "33333333-3333-3333-3333-333333333333", "r" : 2}, '
    || '{"p" : "44444444-4444-4444-4444-444444444444", "r" : 4}]',
  'A1 leaderboard_v RANK() produces (alpha=1, bravo=2, charlie=2, delta=4) -- US3 AS5 "1, 2, 2, 4 pattern" per R-004'
);

-- ---------------------------------------------------------------------------
-- Assertion 2: genuine ties (bravo vs charlie -- identical on every tier)
-- share the SAME rank. Belt-and-braces against A1: even if A1's JSON shape
-- assertion later fails for a serialization reason, A2 isolates the
-- shared-rank property directly. Per §7.4 tier 6.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT rank FROM public.leaderboard_v
    WHERE calculation_version = current_setting('test.cv')::int
      AND participant_id = '22222222-2222-2222-2222-222222222222'),
  (SELECT rank FROM public.leaderboard_v
    WHERE calculation_version = current_setting('test.cv')::int
      AND participant_id = '33333333-3333-3333-3333-333333333333'),
  'A2 bravo and charlie -- tied across ALL configured tie-breaker tiers (total, exact_count, outcome_count, final_points) -- share the same rank (§7.4 tier 6)'
);

-- ---------------------------------------------------------------------------
-- Assertion 3: DENSE_RANK fallback is SKIPPED, not a failing test.
--
-- Per R-004: "If the team later wants dense ranking ('1, 2, 2, 3'), it
-- becomes a Slice 008 config flag; the function is swappable in one line."
-- The current tournament_config.tiebreaker.rank_function = 'rank' (T006
-- default, R-004), so DENSE_RANK behavior is NOT in scope for Slice 005.
-- pgTAP's skip() counts toward plan(3) WITHOUT failing -- when Slice 008
-- ships the dense_rank toggle, this slot can be promoted to a real
-- assertion verifying the (1, 2, 2, 3) pattern under rank_function='dense_rank'.
-- ---------------------------------------------------------------------------
SELECT skip(1, 'A3 DENSE_RANK fallback (1, 2, 2, 3 pattern) deferred to Slice 008 per R-004 -- current tournament_config.tiebreaker.rank_function=''rank'' only');

SELECT * FROM finish();

ROLLBACK;
