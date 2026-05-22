-- Slice 002 / T026 / contracts/match-results.write.md § Test surface row 4.
-- RED until T029 ships record_match_result SP.
--
-- Invariant under test: per contracts/match-results.write.md § Stored
-- procedure semantics step 1, when p_result_status is the shootout enum:
--
--   p_home_score_for_scoring = p_away_score_for_scoring  -- level after ET
--   (p_home_score_official > p_away_score_official)
--     <> (p_away_score_official > p_home_score_official) -- shootout has 1 winner
--
-- A real shootout happens ONLY because the match was level after extra time;
-- if the SP receives shootout=true but for-scoring is not level, the input
-- is incoherent and the SP must reject it.
--
-- D-007 reconciliation: the contract status enum is 'penalties_shootout'
-- (plural); the on-disk CHECK in 0021_match_results.sql allows
-- 'penalty_shootout' (singular). T029 may accept either spelling. This test
-- calls with the contract spelling first; if T029 rejects the contract
-- spelling with a different error, the throws_ok still passes because we
-- pin no message pattern.
--
-- Fixture choice: M3 flipped to 'finished' first. The for-scoring values
-- 3 / 2 are NOT level (3 != 2) — that is the violation we exercise. The
-- official totals (4 / 3) DO have a single winner (home), so the second
-- shootout invariant is satisfied; only the level-after-ET invariant fails.
--
-- Pattern: BEGIN / plan(2) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

UPDATE public.matches SET status = 'in_progress' WHERE id = 'bbbb0000-0000-0000-0000-000000000003';
UPDATE public.matches SET status = 'finished'    WHERE id = 'bbbb0000-0000-0000-0000-000000000003';

-- A1: SP raises when result_status is the shootout enum but for-scoring is
-- not level (3 != 2). throws_ok with NULL pattern so the assertion is robust
-- to either spelling of the status enum and to T029's choice of message.
SELECT throws_ok(
  $$ SELECT public.record_match_result(
       'bbbb0000-0000-0000-0000-000000000003'::uuid,
       4,
       3,
       3,
       2,
       'penalties_shootout',
       'provider_sync',
       NULL::uuid
     ) $$,
  NULL,
  NULL,
  'A1 record_match_result raises EXCEPTION when p_result_status is shootout and p_home_score_for_scoring (3) <> p_away_score_for_scoring (2) — level-after-ET invariant'
);

-- A2: no row inserted.
SELECT is(
  (SELECT count(*) FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003'),
  0::bigint,
  'A2 no match_results row exists for M3 after the shootout-invariant rejection'
);

SELECT * FROM finish();

ROLLBACK;
