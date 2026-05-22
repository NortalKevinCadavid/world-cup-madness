-- Slice 002 / T026 / contracts/match-results.write.md § Test surface row 1.
-- RED until T029 ships record_match_result SP.
--
-- Happy-path exercise of the not-yet-implemented public.record_match_result
-- SECURITY DEFINER stored procedure. Per the contract the SP signature is:
--
--   record_match_result(
--     p_match_id              uuid,
--     p_home_score_official   int,
--     p_away_score_official   int,
--     p_home_score_for_scoring int,
--     p_away_score_for_scoring int,
--     p_result_status         text,
--     p_source                text,
--     p_approved_by           uuid
--   ) RETURNS uuid
--
-- D-007 reconciliation: the contract uses _official + _for_scoring column
-- names; the on-disk schema (migration 0021) uses split-column shape
-- (home_score / away_score / extra_time_* / penalty_*). The SP MUST translate
-- internally. This test calls with the contract argument names and verifies
-- DB persistence via the as-built columns. For a 'regulation' result with no
-- extra time, home_score == home_score_official == home_score_for_scoring.
--
-- Fixture choice: M3 (bbbb0000-...-3, ARG vs CAN) is the seed's scheduled
-- match we flip to 'finished' inside the txn before invoking the SP, leaving
-- the pre-seeded M1 ARG-MEX result row alone. The matches_audit_trigger will
-- write a `match.status_changed` audit row when we flip M3; that is expected
-- side effect (we only assert on the match_result.recorded audit row).
--
-- Source value: contract uses 'sync' but the as-built CHECK on match_results
-- (migration 0021) allows only 'provider_sync' | 'admin_override'. Per D-007
-- the SP is the translation layer; we pass the contract value here and let
-- T029 decide whether to accept the contract name, the DB name, or both.
-- Assertion accepts BOTH spellings via IN (...).
--
-- Pattern: BEGIN / plan(6) / asserts / finish / ROLLBACK. The outer ROLLBACK
-- guarantees no residue.

BEGIN;

SELECT plan(7);

-- ---------------------------------------------------------------------------
-- Pre-state: flip M3 from 'scheduled' to 'finished'. Status transitions per
-- migration 0020 require scheduled -> in_progress -> finished, so we hop
-- through in_progress in the same txn. Both UPDATEs fire matches_audit_trigger
-- (out of scope for this test).
-- ---------------------------------------------------------------------------
UPDATE public.matches
   SET status = 'in_progress'
 WHERE id = 'bbbb0000-0000-0000-0000-000000000003';

UPDATE public.matches
   SET status = 'finished'
 WHERE id = 'bbbb0000-0000-0000-0000-000000000003';

-- ---------------------------------------------------------------------------
-- Invoke the SP with happy-path arguments (ARG 3 - 1 CAN, regulation, sync).
-- Returned value pinned into a temp table so subsequent assertions can read
-- it without re-invoking the SP.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE sp_result (returned_match_id uuid);

INSERT INTO sp_result (returned_match_id)
SELECT public.record_match_result(
  'bbbb0000-0000-0000-0000-000000000003'::uuid,
  3,
  1,
  3,
  1,
  'regulation',
  'provider_sync',
  NULL::uuid
);

-- A1: SP returned the match's UUID.
SELECT is(
  (SELECT returned_match_id FROM sp_result),
  'bbbb0000-0000-0000-0000-000000000003'::uuid,
  'A1 record_match_result returns the input p_match_id'
);

-- A2: a match_results row now exists for M3.
SELECT is(
  (SELECT count(*) FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003'),
  1::bigint,
  'A2 exactly one match_results row was inserted for M3'
);

-- A3: home_score / away_score persisted (DB split-column shape per D-007).
SELECT is(
  (SELECT home_score FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003'),
  3,
  'A3 home_score persisted as 3 (translated from p_home_score_official=3, no extra time)'
);

SELECT is(
  (SELECT away_score FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003'),
  1,
  'A3b away_score persisted as 1 (translated from p_away_score_official=1, no extra time)'
);

-- A4: locked cross-slice _for_scoring columns persisted.
SELECT is(
  (SELECT (home_score_for_scoring, away_score_for_scoring)
     FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003'),
  (3, 1),
  'A4 home_score_for_scoring=3 / away_score_for_scoring=1 persisted unchanged from SP args'
);

-- A5: result_status == 'regulation'. D-007 notes the contract spelling for
-- shootout is 'penalties_shootout' (plural) but the DB CHECK uses singular.
-- For 'regulation' the two spellings are identical so a direct equality is
-- safe here.
SELECT is(
  (SELECT result_status FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003'),
  'regulation',
  'A5 result_status persisted as ''regulation'''
);

-- A6: source persisted. Accept both contract ('sync') and DB ('provider_sync')
-- spellings per D-007 — T029 may normalize either way.
SELECT ok(
  (SELECT source FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003')
    IN ('provider_sync', 'sync'),
  'A6 source persisted as ''provider_sync'' (or contract spelling ''sync'') per D-007'
);

SELECT * FROM finish();

ROLLBACK;
