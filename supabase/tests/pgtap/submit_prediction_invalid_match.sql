-- Slice 003 / T010 / contracts/predictions.write.md § Test surface. RED until T013 ships submit_prediction SP at slot 0034.
--
-- Invalid-match path: submit_prediction MUST raise an EXCEPTION with
-- ERRCODE='WCM04' when p_match_id references a match that does not exist.
-- Per § Stored procedure semantics step 5: SELECT 1 FROM matches WHERE
-- id = p_match_id -- if zero rows then RAISE WCM04.
--
-- Fixture choice: alpha (eligible) + a uuid that is GUARANTEED not to exist
-- in the matches table. We use the all-'a' uuid 'aaaaaaaa-aaaa-aaaa-aaaa-
-- aaaaaaaaaaaa' -- the slice-002 fixture uses the 'bbbb...N' prefix for
-- match ids so the all-'a' uuid is safe.
--
-- Pattern: BEGIN / plan(2) / throws_ok + count-invariant / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- Snapshot the total predictions count BEFORE the SP call so we can assert
-- nothing was inserted by the failed call.
CREATE TEMP TABLE _before AS
SELECT count(*) AS pred_count FROM public.predictions;

-- A1: SP raises ERRCODE WCM04 when the match id does not exist in matches.
SELECT throws_ok(
  $$ SELECT public.submit_prediction(
       '11111111-1111-1111-1111-111111111111'::uuid,
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
       1,
       0,
       'ui'
     ) $$,
  'WCM04',
  NULL,
  'A1 submit_prediction raises ERRCODE=WCM04 when p_match_id does not exist in public.matches'
);

-- A2: predictions row count unchanged -- the failed SP call inserted nothing.
SELECT is(
  (SELECT count(*) FROM public.predictions),
  (SELECT pred_count FROM _before),
  'A2 predictions row count is unchanged after the rejected SP call'
);

SELECT * FROM finish();

ROLLBACK;
