-- Slice 002 / T026 / contracts/match-results.write.md § Test surface row 2.
-- RED until T029 ships record_match_result SP.
--
-- Precondition assertion: record_match_result MUST raise EXCEPTION when the
-- target match's matches.status is not 'finished' at SP call time. The sync
-- coordinator (R-002) updates matches.status to 'finished' immediately
-- BEFORE calling the SP in the same transaction; that ordering is the
-- contract's pre-finished guard. Per the contract § Stored procedure
-- semantics step 1 bullet 2:
--
--   (SELECT status FROM matches WHERE id = p_match_id) = 'finished'
--
-- — when this fails, the SP raises and the caller's transaction rolls back.
--
-- Fixture choice: M3 (bbbb0000-...-3) is 'scheduled' in the seed fixture and
-- we deliberately leave it that way to exercise the negative path.
--
-- D-007 reconciliation: source value 'provider_sync' (DB CHECK) — see the
-- happy-path test for the same caveat. The contract's exception message is
-- not pinned by the spec; we use throws_ok with NULL message matcher so the
-- assertion is robust to T029's choice of phrasing.
--
-- Pattern: BEGIN / plan(2) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- A1: invoking the SP against a scheduled match raises an exception. We use
-- throws_ok with a NULL pattern matcher to assert "some exception was raised"
-- without pinning the exact message; T029 may pin a SQLSTATE class later.
SELECT throws_ok(
  $$ SELECT public.record_match_result(
       'bbbb0000-0000-0000-0000-000000000003'::uuid,
       2,
       0,
       2,
       0,
       'regulation',
       'provider_sync',
       NULL::uuid
     ) $$,
  NULL,
  NULL,
  'A1 record_match_result raises EXCEPTION when target match.status <> ''finished'' (M3 is still ''scheduled'' in the seed)'
);

-- A2: no match_results row was created for M3 — the SP's precondition check
-- must run before the INSERT so a raised exception leaves match_results
-- unchanged.
SELECT is(
  (SELECT count(*) FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003'),
  0::bigint,
  'A2 no match_results row exists for M3 after the rejected SP call'
);

SELECT * FROM finish();

ROLLBACK;
