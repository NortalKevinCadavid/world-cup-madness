-- Slice 002 / T026 / contracts/match-results.write.md § Test surface row 3.
-- RED until T029 ships record_match_result SP.
--
-- Invariant under test: the LOCKED cross-slice scoring contract from
-- data-model.md § Entity 3 validation rules and contracts/match-results.write.md
-- § Stored procedure semantics step 1:
--
--   p_home_score_for_scoring >= 0 AND p_home_score_for_scoring <= p_home_score_official
--   p_away_score_for_scoring >= 0 AND p_away_score_for_scoring <= p_away_score_official
--
-- A for-scoring total that EXCEEDS the official total is incoherent: the
-- scoring engine (Slice 005) consumes _for_scoring exclusively, and an
-- inflated for-scoring would inflate prediction-points awarded relative to
-- the real result. The SP must reject this BEFORE the INSERT so the DB-layer
-- match_results_for_scoring_matches CHECK (migration 0021) never fires on
-- this path.
--
-- This test calls the SP with home_score_for_scoring=5, home_score_official=3.
-- Either the SP's input validation rejects with a clear message, OR the
-- underlying CHECK fires; both qualify as "the invariant was enforced". We
-- assert via throws_ok with NULL pattern so the test does not lock T029 into
-- a specific phrasing.
--
-- Fixture choice: M3 flipped to 'finished' first so the pre-finished check
-- (covered separately in record_match_result_rejects_pre_finished.sql) is
-- not the one being exercised here.
--
-- Pattern: BEGIN / plan(2) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- Flip M3 to 'finished' via the allowed transition chain (matches_audit_trigger
-- writes match.status_changed rows; out of scope for this test).
UPDATE public.matches SET status = 'in_progress' WHERE id = 'bbbb0000-0000-0000-0000-000000000003';
UPDATE public.matches SET status = 'finished'    WHERE id = 'bbbb0000-0000-0000-0000-000000000003';

-- A1: SP raises when p_home_score_for_scoring (5) > p_home_score_official (3).
SELECT throws_ok(
  $$ SELECT public.record_match_result(
       'bbbb0000-0000-0000-0000-000000000003'::uuid,
       3,
       1,
       5,
       1,
       'regulation',
       'provider_sync',
       NULL::uuid
     ) $$,
  NULL,
  NULL,
  'A1 record_match_result raises EXCEPTION when p_home_score_for_scoring (5) > p_home_score_official (3) — for-scoring invariant'
);

-- A2: no row was inserted (exception rolls back the INSERT — or the SP's
-- input validation runs before the INSERT). Either way: count = 0.
SELECT is(
  (SELECT count(*) FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003'),
  0::bigint,
  'A2 no match_results row exists for M3 after the for-scoring-invariant rejection'
);

SELECT * FROM finish();

ROLLBACK;
