-- Slice 006 / T033 / US4 / contracts/is-admin.predicate.sql.md § Test surface.
-- Authored RED against the CONTRACT (not T007's body).
--
-- Contract semantics (`contracts/is-admin.predicate.sql.md` § Semantics):
--   Returns TRUE iff ALL of:
--     1. Caller has a participants row with auth_user_id = p_uid.
--     2. participants.status = 'active' (slice 001's eligibility precondition
--        COMPOSES with admin grant).
--     3. >= 1 admin_roles row for that participant where revoked_at IS NULL.
--   Returns FALSE in all other cases, including "Participant is deactivated".
--
-- T007's shipped body (slot 0062) does NOT filter on participants.status.
-- Therefore this test is EXPECTED RED against the current T007 body and
-- T036 owns the fix (add `AND p.status = 'active'` to T007's EXISTS clause).
-- T035's red-gate documents this status.
--
-- Pre-state (seed):
--   zulu
--     auth.users.id   = 00000000-0000-0000-0000-00000000000d
--     participants.id = 99999999-9999-9999-9999-999999999999   status='DEACTIVATED'
--     NO admin_roles row (T009 bootstrap only seeds admin1).
--
-- This test INSERTs an active admin_roles row for zulu inline so the only
-- failure mode is the missing status filter, not the missing grant.
-- ROLLBACK at end discards the inserted row.
--
-- Assertion: is_admin(zulu.auth_user_id) returns FALSE because zulu is
-- deactivated, even though an active admin_roles row exists for them.

BEGIN;

SELECT plan(1);

-- Stage: zulu has an active admin_roles row. Without this insert the test
-- would pass for the wrong reason (no grant -> false), masking the missing
-- status filter we want to catch.
INSERT INTO public.admin_roles (
  participant_id, granted_at, granted_by, revoked_at, revoked_by, revoke_reason
) VALUES (
  '99999999-9999-9999-9999-999999999999'::uuid,
  now(),
  '77777777-7777-7777-7777-777777777777'::uuid, -- admin1 grants
  NULL, NULL, NULL
);

-- Contract assertion: deactivated participant -> is_admin FALSE.
-- Expected RED against current T007 body (missing status filter); T036 fixes.
SELECT is(
  public.is_admin('00000000-0000-0000-0000-00000000000d'::uuid),
  FALSE,
  'is_admin(zulu) returns FALSE: deactivated participant cannot be admin even with active admin_roles row (contract § Semantics)'
);

SELECT * FROM finish();
ROLLBACK;
