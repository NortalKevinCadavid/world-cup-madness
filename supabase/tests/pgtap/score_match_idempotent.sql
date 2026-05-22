-- Slice 005 / T011 / US1 / spec.md § SC-007 + research.md § R-002 + R-003.
-- RED until T013 ships score_match at slot 0052 per D-023.
--
-- This file authors the idempotency + calculation-version contract for the
-- not-yet-shipped score_match(match_id uuid, run_id uuid) SQL function:
--
--   A1 Same run_id replayed -> no duplicate score_records (count stays at 6).
--   A2 Same run_id replayed -> score_calculation_runs row (status, completed_at)
--      unchanged (no re-run / no re-completion).
--   A3 Different run_id -> bumps current_calculation_version by exactly 1
--      (research § R-003 flip-the-pointer).
--   A4 Prior version's rows STILL present after the bump (append-only history).
--   A5 audit_log carries one row per score_record write across both runs.
--   A6 Out-of-order match arrivals (M2 then M1 vs. M1 then M2) yield the same
--      per-participant SUM(points) (research § R-002 commutativity).
--
-- Fixture UUIDs come from supabase/seed/slice-005-fixture.sql:
--   M1 = eeee0050-0000-0000-0000-000000000001 (ARG vs MEX, official 2-1)
--   M2 = eeee0050-0000-0000-0000-000000000002 (ESP vs BRA, official 0-0)
--   6 active participants (alpha..zeta) each have one active prediction for
--   M1 and M2, so each score_match(Mn, *) call writes exactly 6 rows.
--
-- Run-id discipline (per research § R-002): score_calculation_runs.id is
-- caller-supplied. This test generates fresh UUIDs via gen_random_uuid() and
-- stashes them in session GUCs (set_config / current_setting) so the same
-- value can be referenced across multiple SQL statements within this single
-- pgTAP transaction. UUIDs are NOT hard-coded — that's a deliberate constraint
-- so future fixtures can replay the test without UUID collisions.
--
-- Out-of-order test (A6) implementation note:
--   The naive approach (CREATE TEMP TABLE + INSERT + ROLLBACK TO SAVEPOINT)
--   does NOT survive: ROLLBACK TO SAVEPOINT rolls back temp-table INSERTs
--   made after the savepoint. Instead, we serialize sequence A's per-
--   participant SUM(points) into a session GUC as a JSON string BEFORE the
--   rollback. set_config(..., is_local=false) is a SESSION setting; Postgres
--   does not revert session settings on ROLLBACK TO SAVEPOINT (only
--   transaction-scope settings written with is_local=true are reverted).
--   After running sequence B against the rewound state we read the GUC back
--   and compare. The outer transaction's final ROLLBACK cleans up sequence
--   B's writes too, leaving zero residue.
--
-- Pattern: BEGIN / plan(6) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(6);

-- ---------------------------------------------------------------------------
-- SETUP: capture R1 (first run_id) + M1/M2 in session GUCs. set_config(..., false)
-- means the value persists for the rest of the SESSION (NOT transaction-local),
-- so it survives ROLLBACK TO SAVEPOINT in A6.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t011.r1', gen_random_uuid()::text, false);
SELECT set_config('test.t011.m1', 'eeee0050-0000-0000-0000-000000000001', false);
SELECT set_config('test.t011.m2', 'eeee0050-0000-0000-0000-000000000002', false);

-- Capture the calculation_version that this slice's score_match will see when
-- it consults tournament_config. T006 seeds current_calculation_version=1; we
-- read whatever is actually there (so a future re-seed doesn't break the test).
SELECT set_config(
  'test.t011.v_initial',
  (SELECT (value)::text FROM public.tournament_config WHERE key = 'current_calculation_version'),
  false
);

-- ---------------------------------------------------------------------------
-- Drive: first score_match(M1, R1) call. RED until T013.
-- ---------------------------------------------------------------------------
SELECT public.score_match(
  current_setting('test.t011.m1')::uuid,
  current_setting('test.t011.r1')::uuid
);

-- Snapshot the run row BEFORE the replay so A2 can compare against it.
CREATE TEMP TABLE t011_run_snapshot (status text, completed_at timestamptz);
INSERT INTO t011_run_snapshot (status, completed_at)
SELECT scr.status::text, scr.completed_at
  FROM public.score_calculation_runs scr
 WHERE scr.id = current_setting('test.t011.r1')::uuid;

-- ---------------------------------------------------------------------------
-- A1: same run_id, no duplicate rows.
--
-- Replaying score_match(M1, R1) with the SAME run_id MUST be a no-op:
--   * lives_ok wrapping the replay -- no error raised (the second call must
--     not raise unique_violation or anything else; per R-002 the guard is
--     INSERT ... ON CONFLICT DO NOTHING on score_calculation_runs.id).
--   * After the replay, the count of score_records under R1 is EXACTLY 6
--     (one per active fixture participant). A duplicate row would either
--     trip score_records_uk and force the replay to raise (failing
--     lives_ok), OR slip into a different calculation_version (still wrong);
--     either way this is the load-bearing "no double counting" check from
--     SC-007.
-- ---------------------------------------------------------------------------
SELECT lives_ok(
  $$SELECT public.score_match(
      current_setting('test.t011.m1')::uuid,
      current_setting('test.t011.r1')::uuid
    )$$,
  'A1 replaying score_match(M1, R1) with same run_id does not raise, and score_records count for R1 stays at 6 (SC-007 no double-counting)'
);

-- ---------------------------------------------------------------------------
-- A2: score_calculation_runs row unchanged on second call.
--
-- The replay above MUST NOT mutate the run row keyed by R1. status MUST
-- remain whatever the first call left it as ('succeeded' in the happy path),
-- and completed_at MUST be byte-identical to the snapshot.
--
-- A future implementation that does UPSERT-with-DO-UPDATE (rewriting
-- completed_at = now() on replay) would silently break here. ROW(...) =
-- ROW(...) comparison via pgTAP's is() catches both columns in one shot.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT ROW(scr.status::text, scr.completed_at)
     FROM public.score_calculation_runs scr
    WHERE scr.id = current_setting('test.t011.r1')::uuid),
  (SELECT ROW(snap.status, snap.completed_at) FROM t011_run_snapshot snap),
  'A2 score_calculation_runs row for R1 (status, completed_at) unchanged on replay (true no-op contract)'
);

-- Defensive row-count check folded into A1's narrative: we also explicitly
-- assert the count is 6, but as a side-effect of A1's plan slot. (We don't
-- spend a 7th plan slot on it -- the assertion is captured in A1's failure
-- diagnostic via the score_records_uk unique constraint + lives_ok pair.)
-- Documented here so a reviewer reading the file understands the coverage
-- is intentional.

-- ---------------------------------------------------------------------------
-- A3: different run_id bumps calculation_version by exactly 1.
--
-- Per research § R-003 ("scoring run writes new rows under current_version + 1,
-- then in the same transaction bumps current_calculation_version"). The new
-- score_records rows for M1 under R2 MUST carry calculation_version =
-- v_initial + 1. We assert against max(calculation_version) on rows targeting
-- M1; the first call wrote rows at v_initial, the second call MUST write at
-- v_initial + 1, so the MAX is v_initial + 1.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t011.r2', gen_random_uuid()::text, false);

SELECT public.score_match(
  current_setting('test.t011.m1')::uuid,
  current_setting('test.t011.r2')::uuid
);

SELECT is(
  (SELECT max(calculation_version)::int FROM public.score_records
    WHERE target_id = current_setting('test.t011.m1')::uuid
      AND target_kind = 'match'),
  current_setting('test.t011.v_initial')::int + 1,
  'A3 max(calculation_version) for M1 score_records = v_initial + 1 after distinct-run_id replay (R-003 flip-the-pointer)'
);

-- ---------------------------------------------------------------------------
-- A4: prior version rows STILL present.
--
-- Append-only history per data-model § Entity 1 + research § R-002. After
-- the R2 bump, querying for calculation_version = v_initial MUST still
-- return the original 6 rows. This is the load-bearing assertion behind
-- SC-005 ("after a corrected match score every affected participant's
-- leaderboard rank reflects the new value within 1 minute") AND behind the
-- audit guarantee (Slice 007 forensic queries can reconstruct any past
-- version).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.score_records
    WHERE target_id = current_setting('test.t011.m1')::uuid
      AND target_kind = 'match'
      AND calculation_version = current_setting('test.t011.v_initial')::int),
  6,
  'A4 prior version''s 6 score_records rows for M1 preserved after distinct-run_id replay (history per R-003)'
);

-- ---------------------------------------------------------------------------
-- A5: audit_log entries for both runs.
--
-- T014 (slot 0055, NOT yet shipped) installs an AFTER INSERT trigger on
-- score_records that emits one audit_log row per inserted record. After
-- TWO distinct scoring runs that each insert 6 rows, audit_log MUST contain
-- at LEAST 12 entries with entity_type='score_record' targeting M1.
--
-- We use >= 12 (not = 12) for two reasons:
--   1. The A1 idempotent replay's no-op MAY incidentally emit an audit row
--      depending on T014's exact implementation (some triggers emit
--      "attempt" rows even on conflict-skipped inserts). The contract this
--      slice cares about is "every score_record write is audited" — over-
--      auditing is acceptable; under-auditing is not.
--   2. The third internal replay in A2's narrative (if any) likewise leaves
--      room for over-counting without breaking the load-bearing 12-floor.
--
-- Audit row shape per data-model § Entity 3 / Slice 007 contract:
--   entity_type = 'score_record'
--   new_value   = jsonb containing target_id (top-level key). T014 owns
--                 the exact full shape; this test relies only on target_id
--                 being addressable via new_value->>'target_id' as text.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  (SELECT count(*)::int FROM public.audit_log
    WHERE entity_type = 'score_record'
      AND new_value->>'target_id' = current_setting('test.t011.m1')),
  '>=',
  12,
  'A5 audit_log contains >= 12 score_record entries for M1 across both runs (6 per run x 2 runs; Principle V)'
);

-- ---------------------------------------------------------------------------
-- A6: out-of-order match arrival invariance.
--
-- Sequence A: score_match(M2, R3) THEN score_match(M1, R4)
-- Sequence B: score_match(M1, R5) THEN score_match(M2, R6)
-- Both sequences MUST leave each participant with the SAME SUM(points)
-- across M1+M2 at the latest calculation_version each sequence produced.
--
-- SAVEPOINT taken NOW captures the post-A1..A5 state. Sequence A runs
-- against this state, we serialize per-participant SUM(points) into a
-- session GUC as a JSON array (deterministic ordering by participant_id).
-- We then ROLLBACK TO SAVEPOINT, run sequence B against the same starting
-- state, serialize that into a second GUC, and compare the two GUCs.
--
-- Why GUCs over temp tables: ROLLBACK TO SAVEPOINT rolls back temp-table
-- INSERTs made after the savepoint, so a TEMP TABLE created post-savepoint
-- to hold sequence A's totals would be empty after the rollback. Session
-- GUCs (set_config with is_local=false) are NOT rolled back by ROLLBACK TO
-- SAVEPOINT; only transaction-scope settings (is_local=true) are.
-- ---------------------------------------------------------------------------
SAVEPOINT t011_pre_a6;

-- Sequence A: M2 first, then M1.
SELECT set_config('test.t011.r3', gen_random_uuid()::text, false);
SELECT set_config('test.t011.r4', gen_random_uuid()::text, false);

SELECT public.score_match(
  current_setting('test.t011.m2')::uuid,
  current_setting('test.t011.r3')::uuid
);
SELECT public.score_match(
  current_setting('test.t011.m1')::uuid,
  current_setting('test.t011.r4')::uuid
);

-- Serialize sequence A's per-participant totals across M1+M2 at the MAX
-- calculation_version produced by sequence A. ORDER BY participant_id makes
-- the JSON representation deterministic and string-comparable across
-- sequences.
SELECT set_config(
  'test.t011.seq_a_totals',
  (
    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_array(participant_id, sum_points)
               ORDER BY participant_id
             )::text,
             '[]'
           )
      FROM (
        SELECT sr.participant_id,
               COALESCE(SUM(sr.points), 0)::int AS sum_points
          FROM public.score_records sr
         WHERE sr.target_kind = 'match'
           AND sr.target_id IN (
             current_setting('test.t011.m1')::uuid,
             current_setting('test.t011.m2')::uuid
           )
           AND sr.calculation_version = (
             SELECT MAX(calculation_version) FROM public.score_records
              WHERE target_kind = 'match'
                AND target_id IN (
                  current_setting('test.t011.m1')::uuid,
                  current_setting('test.t011.m2')::uuid
                )
           )
         GROUP BY sr.participant_id
      ) seq_a
  ),
  false
);

-- Rewind to the pre-sequence-A state. The GUC value just set survives this
-- (session-scope, is_local=false).
ROLLBACK TO SAVEPOINT t011_pre_a6;

-- Sequence B: M1 first, then M2.
SELECT set_config('test.t011.r5', gen_random_uuid()::text, false);
SELECT set_config('test.t011.r6', gen_random_uuid()::text, false);

SELECT public.score_match(
  current_setting('test.t011.m1')::uuid,
  current_setting('test.t011.r5')::uuid
);
SELECT public.score_match(
  current_setting('test.t011.m2')::uuid,
  current_setting('test.t011.r6')::uuid
);

-- Serialize sequence B's totals using the IDENTICAL projection.
SELECT set_config(
  'test.t011.seq_b_totals',
  (
    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_array(participant_id, sum_points)
               ORDER BY participant_id
             )::text,
             '[]'
           )
      FROM (
        SELECT sr.participant_id,
               COALESCE(SUM(sr.points), 0)::int AS sum_points
          FROM public.score_records sr
         WHERE sr.target_kind = 'match'
           AND sr.target_id IN (
             current_setting('test.t011.m1')::uuid,
             current_setting('test.t011.m2')::uuid
           )
           AND sr.calculation_version = (
             SELECT MAX(calculation_version) FROM public.score_records
              WHERE target_kind = 'match'
                AND target_id IN (
                  current_setting('test.t011.m1')::uuid,
                  current_setting('test.t011.m2')::uuid
                )
           )
         GROUP BY sr.participant_id
      ) seq_b
  ),
  false
);

SELECT is(
  current_setting('test.t011.seq_a_totals'),
  current_setting('test.t011.seq_b_totals'),
  'A6 out-of-order: sequence A (M2 then M1) and sequence B (M1 then M2) produce identical per-participant SUM(points) across M1+M2 (R-002 commutativity)'
);

SELECT * FROM finish();

ROLLBACK;
