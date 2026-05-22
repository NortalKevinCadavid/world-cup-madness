-- Slice 005 / T026 / US3 Acceptance Scenario 6 + SC-008 / research.md § R-003.
-- RED until T029 ships leaderboard_v at on-disk slot 0054 per D-023.
-- Verifies flip-the-pointer semantics: in-flight v=N+1 writes don't affect
-- readers until current_calculation_version is bumped. Single-connection
-- simulation via SAVEPOINTs; true multi-connection concurrency is verified
-- by slice 005 Playwright Test 6 + T043 k6 load test.
--
-- =============================================================================
-- Why single-connection (a deliberate, documented limitation)
-- =============================================================================
-- pgTAP runs every test in one Postgres backend (one connection, one txn).
-- The "long writer + concurrent reader" scenario that R-003 protects against
-- (FR-012 / SC-008: 1,000 concurrent readers seeing no partial state during a
-- result-update window) is therefore not literally reproducible here -- there
-- is no second session to act as the "reader" while this transaction holds
-- the "writer" state open. pg_background extension is not installed in the
-- local Supabase dev container (verified at quickstart bootstrap time).
--
-- The correctness property we CAN verify in-process is the predicate the view
-- relies on: leaderboard_v filters WHERE calculation_version =
-- tournament_config.current_calculation_version. As long as the pointer is
-- 1, rows inserted under calculation_version=2 MUST NOT be visible through
-- leaderboard_v -- regardless of whether the v=2 INSERT happened in a
-- separate connection or in the same transaction at a savepoint. That is the
-- logical invariant; the multi-connection MVCC guarantee is a Postgres-level
-- property (commit visibility under READ COMMITTED) that pgTAP would only be
-- re-asserting if we did stand up two sessions.
--
-- =============================================================================
-- Fixture references
-- =============================================================================
-- Participant: alpha = 11111111-1111-1111-1111-111111111111 (slice 001 fixture,
--   carried forward by slice 005 fixture). FK score_records.participant_id ->
--   participants(id) requires a real participant row -- a synthetic UUID would
--   trip the FK.
-- Tournament: 00000000-0000-0000-0000-000000000001 (single 2026 tournament
--   placeholder uuid per slice 005 fixture). Used as the synthetic target_id
--   for final-kind rows (R-003 R-008 -- the final's polymorphic target uses
--   a deterministic UUID per (tournament_id, final_item_kind); for the
--   purposes of this test we use the tournament placeholder directly since
--   we don't exercise T019's target_id derivation).
--
-- We use target_kind='final' (not 'match') to sidestep the match_id FK +
-- official_home/away CHECK requirements -- final-kind rows have a simpler
-- shape and the calculation_version semantics are identical.

BEGIN;

SELECT plan(4);

-- ---------------------------------------------------------------------------
-- SETUP: ensure current_calculation_version pointer is 1, capture identifiers
-- in session GUCs so the same UUIDs are reused across statements without
-- hard-coding (set_config with is_local=false survives SAVEPOINTs; the outer
-- ROLLBACK cleans up everything else).
-- ---------------------------------------------------------------------------

-- Force the pointer to a known value. Migration 0057 seeded
-- current_calculation_version=1; we overwrite defensively so a prior test
-- run that leaked state (it shouldn't -- BEGIN/ROLLBACK isolates) cannot
-- skew this test. The outer ROLLBACK reverts this back to whatever was on
-- disk before BEGIN.
UPDATE public.tournament_config
   SET value = '1'::jsonb,
       updated_at = now()
 WHERE key = 'current_calculation_version';

-- alpha participant (real fixture row -- FK target).
SELECT set_config('test.t026.alpha', '11111111-1111-1111-1111-111111111111', false);

-- A synthetic but stable target_id for the final-kind rows. The data-model
-- says final-kind target_id is a deterministic UUID per (tournament_id,
-- final_item_kind); we use a hand-picked uuid in the slice 005 namespace
-- that does NOT collide with any seeded score_records target_id (none exist
-- yet -- score_records is empty until T013/T019 ship).
SELECT set_config('test.t026.target', 'eeee0050-0000-0000-0000-0000000000c0', false);

-- Two run_ids -- one per version we'll write. score_records.run_id FK ->
-- score_calculation_runs(id), so we INSERT the run rows first. triggered_by
-- = alpha (a real participant) per data-model § Entity 2.
SELECT set_config('test.t026.run1', gen_random_uuid()::text, false);
SELECT set_config('test.t026.run2', gen_random_uuid()::text, false);

INSERT INTO public.score_calculation_runs (
  id, scope, target_id, "trigger", triggered_by, reason,
  started_at, completed_at, status,
  affected_record_count, calculation_version_written, notes
) VALUES
  (
    current_setting('test.t026.run1')::uuid,
    'finals', NULL,
    'award_confirmed',
    current_setting('test.t026.alpha')::uuid,
    NULL,
    now(), now(), 'succeeded',
    1, 1, NULL
  ),
  (
    current_setting('test.t026.run2')::uuid,
    'finals', NULL,
    'award_confirmed',
    current_setting('test.t026.alpha')::uuid,
    NULL,
    now(), now(), 'succeeded',
    1, 2, NULL
  );

-- Seed one v=1 score_records row for alpha (final-kind: champion=ARG correct
-- => 30 points -- a synthetic value that is distinct from any seeded total,
-- so the assertions below cannot accidentally pass against fixture data).
INSERT INTO public.score_records (
  id, participant_id,
  target_kind, target_id, final_item_kind,
  predicted_home, predicted_away,
  predicted_team_or_player_id,
  official_home, official_away,
  official_team_or_player_id,
  points, reason_code,
  calculation_version, calculated_at,
  run_id, source, match_id
) VALUES (
  gen_random_uuid(),
  current_setting('test.t026.alpha')::uuid,
  'final', current_setting('test.t026.target')::uuid, 'champion',
  NULL, NULL,
  'aaaa0000-0000-0000-0000-000000000001'::uuid,    -- ARG (predicted)
  NULL, NULL,
  'aaaa0000-0000-0000-0000-000000000001'::uuid,    -- ARG (official)
  30, 'final_correct',
  1, now(),
  current_setting('test.t026.run1')::uuid, 'auto', NULL
);

-- ---------------------------------------------------------------------------
-- A1: leaderboard_v reads at current_calculation_version.
--
-- Pointer is 1; alpha has exactly one v=1 row worth 30 points; leaderboard_v
-- MUST surface alpha's total_points = 30. RED-by-design: T029 has not yet
-- shipped public.leaderboard_v, so this query raises "relation does not
-- exist" and the assertion fails.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT total_points
     FROM public.leaderboard_v
    WHERE participant_id = current_setting('test.t026.alpha')::uuid),
  30::int,
  'A1 leaderboard_v surfaces alpha total_points=30 at calculation_version=1 (R-003 reader pointer)'
);

-- ---------------------------------------------------------------------------
-- A2: in-flight v=2 INSERT does NOT affect reads while pointer = 1.
--
-- Open a SAVEPOINT and insert a contradictory v=2 row for alpha (100 points
-- instead of 30). DO NOT bump current_calculation_version. leaderboard_v
-- MUST still return 30 because it filters WHERE calculation_version =
-- current_calculation_version (still 1).
--
-- This is the load-bearing invariant from FR-012 / SC-008: a partially-
-- applied scoring run (rows landed under v=N+1 but pointer not yet flipped)
-- MUST NOT be visible to readers. In production this is enforced by MVCC
-- (uncommitted writes are invisible to other connections); here we enforce
-- the same logical guarantee via the view's filter predicate.
-- ---------------------------------------------------------------------------

SAVEPOINT writer_open;

INSERT INTO public.score_records (
  id, participant_id,
  target_kind, target_id, final_item_kind,
  predicted_home, predicted_away,
  predicted_team_or_player_id,
  official_home, official_away,
  official_team_or_player_id,
  points, reason_code,
  calculation_version, calculated_at,
  run_id, source, match_id
) VALUES (
  gen_random_uuid(),
  current_setting('test.t026.alpha')::uuid,
  'final', current_setting('test.t026.target')::uuid, 'champion',
  NULL, NULL,
  'aaaa0000-0000-0000-0000-000000000001'::uuid,
  NULL, NULL,
  'aaaa0000-0000-0000-0000-000000000001'::uuid,
  100, 'final_correct',
  2, now(),
  current_setting('test.t026.run2')::uuid, 'recalc', NULL
);

SELECT is(
  (SELECT total_points
     FROM public.leaderboard_v
    WHERE participant_id = current_setting('test.t026.alpha')::uuid),
  30::int,
  'A2 in-flight v=2 rows NOT visible to reader while current_calculation_version=1 (R-003 flip-the-pointer)'
);

-- ---------------------------------------------------------------------------
-- A3: pointer flip makes the new rows visible.
--
-- Bump current_calculation_version from 1 to 2. The v=2 row inserted above
-- is now the only row whose calculation_version matches the pointer; the
-- v=1 row is filtered out. alpha total_points MUST flip to 100.
--
-- This is the "after commit, the reader sees the new state" half of R-003.
-- In production the pointer-bump is in the same transaction as the v=2
-- INSERTs, so external readers see both transitions atomically.
-- ---------------------------------------------------------------------------

UPDATE public.tournament_config
   SET value = '2'::jsonb,
       updated_at = now()
 WHERE key = 'current_calculation_version';

SELECT is(
  (SELECT total_points
     FROM public.leaderboard_v
    WHERE participant_id = current_setting('test.t026.alpha')::uuid),
  100::int,
  'A3 post pointer flip current_calculation_version=2, leaderboard_v surfaces alpha total_points=100 (v=2 data now visible)'
);

-- ---------------------------------------------------------------------------
-- A4: v=1 rows still in score_records (append-only history preserved).
--
-- The pointer flip MUST NOT delete or modify the prior version's rows --
-- they remain in score_records for audit (Principle V) and so a future
-- admin recalculation under a corrected match score (Slice 006 / SC-005)
-- can reconstruct the v=1 state.
--
-- Asserting count(*)=1 (not >=1) because the only v=1 row for alpha at this
-- synthetic target_id is the one we inserted in setup; there are no fixture
-- score_records rows (slice 005 fixture explicitly does not seed
-- score_records -- those are written exclusively by T013/T019 at runtime).
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT count(*)
     FROM public.score_records
    WHERE participant_id = current_setting('test.t026.alpha')::uuid
      AND target_id = current_setting('test.t026.target')::uuid
      AND calculation_version = 1),
  1::bigint,
  'A4 v=1 score_records row for alpha preserved after pointer flip (append-only history per data-model § Entity 1)'
);

SELECT * FROM finish();

ROLLBACK;
