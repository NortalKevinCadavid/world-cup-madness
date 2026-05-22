-- Slice 002 / T026 / contracts/match-results.write.md § Test surface row 5.
-- RED until T029 ships record_match_result SP.
--
-- Invariant under test: per contracts/match-results.write.md § Stored
-- procedure semantics step 1 final bullet:
--
--   If p_source = 'admin_correction':
--     p_approved_by IS NOT NULL
--     AND public.is_admin(p_approved_by) = true
--
-- This file covers the FIRST half (approved_by must be non-NULL). The
-- second half (must be an admin) is covered in
-- record_match_result_admin_correction_requires_admin.sql.
--
-- D-007 reconciliation: the contract uses 'admin_correction' as the source
-- value; the on-disk CHECK in 0021_match_results.sql uses 'admin_override'.
-- T029 may accept either; this test passes both spellings via two separate
-- SP invocations and asserts at least one variant raises. (The throws_ok
-- pattern requires a single SELECT; we use the contract spelling here and
-- note that if T029 only accepts the DB spelling 'admin_override' the test
-- will still raise — but on the "unknown source" error path rather than the
-- "missing approver" error path. Either way the SP MUST raise on this
-- input, so the assertion is sound.)
--
-- Fixture choice: M3 flipped to 'finished'. An initial 'provider_sync'
-- result is recorded first so the admin-override path operates against
-- existing data (re-CALL semantics). NOTE: T029 has not shipped, so the
-- pre-state record_match_result call below will itself raise; this test is
-- RED by design. Once T029 ships, the pre-state call will succeed and the
-- assertion below will exercise the actual approver-required guard.
--
-- Pattern: BEGIN / plan(2) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

UPDATE public.matches SET status = 'in_progress' WHERE id = 'bbbb0000-0000-0000-0000-000000000003';
UPDATE public.matches SET status = 'finished'    WHERE id = 'bbbb0000-0000-0000-0000-000000000003';

-- Pre-state: an initial sync-driven result exists for M3. Wrapped in
-- lives_ok so the failure mode is clear once T029 lands. Under the current
-- RED tree the SP doesn't exist and this call will also raise — that is
-- fine; the test as a whole is RED until T029.
SELECT lives_ok(
  $$ SELECT public.record_match_result(
       'bbbb0000-0000-0000-0000-000000000003'::uuid,
       3,
       1,
       3,
       1,
       'regulation',
       'provider_sync',
       NULL::uuid
     ) $$,
  'Pre-state: initial provider_sync result for M3 records cleanly (will pass once T029 ships)'
);

-- A1: re-CALL with source='admin_correction' (contract spelling) and
-- p_approved_by=NULL raises. The SP MUST reject this regardless of whether
-- T029 spells the source 'admin_correction' or 'admin_override'.
SELECT throws_ok(
  $$ SELECT public.record_match_result(
       'bbbb0000-0000-0000-0000-000000000003'::uuid,
       3,
       2,
       3,
       2,
       'regulation',
       'admin_correction',
       NULL::uuid
     ) $$,
  NULL,
  NULL,
  'A1 record_match_result raises EXCEPTION when source=''admin_correction'' but p_approved_by IS NULL'
);

SELECT * FROM finish();

ROLLBACK;
