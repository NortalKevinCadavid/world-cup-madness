-- Slice 002 / T026 / contracts/match-results.write.md § Test surface row 6.
-- RED until T029 ships record_match_result SP.
--
-- Invariant under test (defense-in-depth half of the admin-override guard):
-- per contracts/match-results.write.md § Stored procedure semantics step 1:
--
--   If p_source = 'admin_correction':
--     p_approved_by IS NOT NULL                                  -- covered by sibling test
--     AND public.is_admin(p_approved_by) = true                  -- this file
--
-- The SP defense-in-depths the admin check even though the Slice 006 RPC
-- wrapper will also check. is_admin is Slice 001's permissive stub (returns
-- false for every uuid until Slice 006 ships the real body — see migration
-- 0006_is_admin_stub and slice 001 T014). So in the current tree EVERYONE
-- fails the admin check; this test GREENs today (once T029 ships) because
-- alpha — a regular participant — is not admin per the stub.
--
-- Fixture choice: M3 flipped to 'finished', alpha's participants.id used as
-- the non-admin approver. alpha is alpha@nortal.com / participants.id
-- 11111111-1111-1111-1111-111111111111 (slice 001 seed fixture).
--
-- D-007 reconciliation: same source-spelling caveat as the sibling test
-- (record_match_result_admin_correction_requires_approver.sql); the SP MUST
-- raise on this input regardless of which spelling T029 settles on.
--
-- Pattern: BEGIN / plan(2) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

UPDATE public.matches SET status = 'in_progress' WHERE id = 'bbbb0000-0000-0000-0000-000000000003';
UPDATE public.matches SET status = 'finished'    WHERE id = 'bbbb0000-0000-0000-0000-000000000003';

-- Pre-state: an initial sync-driven result exists for M3 (will pass once
-- T029 lands; raises in the RED tree, which is expected).
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

-- A1: re-CALL with source='admin_correction' and p_approved_by=alpha
-- (non-admin per the slice 001 is_admin stub) raises. The SP MUST defense-
-- in-depth-check is_admin even when the approver is non-NULL.
SELECT throws_ok(
  $$ SELECT public.record_match_result(
       'bbbb0000-0000-0000-0000-000000000003'::uuid,
       3,
       2,
       3,
       2,
       'regulation',
       'admin_correction',
       '11111111-1111-1111-1111-111111111111'::uuid
     ) $$,
  NULL,
  NULL,
  'A1 record_match_result raises EXCEPTION when source=''admin_correction'' but is_admin(p_approved_by) = false (alpha is a regular participant)'
);

SELECT * FROM finish();

ROLLBACK;
