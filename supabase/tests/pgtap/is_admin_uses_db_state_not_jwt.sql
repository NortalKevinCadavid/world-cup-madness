-- Slice 006 / T033 / US4 / contracts/is-admin.predicate.sql.md § Test surface.
-- Likely GREEN against T007's real body (slot 0062).
--
-- Contract § "Difference from Slice 001 stub":
--   stub:  SELECT COALESCE(auth.jwt() ->> 'role' = 'admin', false)
--   real:  EXISTS query against admin_roles
--   Source of truth: JWT claim -> DATABASE ROW.
--
-- This test proves the new body reads DB state, NOT the JWT claim. It
-- synthesises a JWT for alpha (no admin_roles row) WITH a {"role":"admin"}
-- claim that WOULD have satisfied slice 001's stub. The real body MUST
-- ignore that claim and return FALSE.
--
-- Symmetric counter-case: admin1's JWT with role='authenticated' (NO admin
-- role claim) MUST still resolve TRUE because admin1 has an admin_roles row.
--
-- Fixture refs:
--   alpha    auth.users.id = 00000000-0000-0000-0000-00000000000a   NO admin_roles row
--   admin1   auth.users.id = 00000000-0000-0000-0000-0000000000d3   active admin_roles row (T009)

BEGIN;

SELECT plan(2);

-- ---------------------------------------------------------------------------
-- Case 1: alpha JWT claims role='admin' but DB has no admin_roles row for
-- alpha. is_admin(auth.uid()) MUST return FALSE -- the body reads admin_roles,
-- not the JWT claim.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"admin"}';

SELECT is(
  public.is_admin(auth.uid()),
  FALSE,
  'A1 is_admin(auth.uid()) returns FALSE for alpha even with {"role":"admin"} JWT claim (proves DB state, not JWT)'
);

-- ---------------------------------------------------------------------------
-- Case 2: admin1 JWT claims role='authenticated' (no admin claim). The DB
-- has an active admin_roles row from T009 bootstrap. is_admin(auth.uid())
-- MUST return TRUE because the source of truth is the DB row, not the JWT.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';

SELECT is(
  public.is_admin(auth.uid()),
  TRUE,
  'A2 is_admin(auth.uid()) returns TRUE for admin1 even with role="authenticated" JWT (DB admin_roles row is authoritative)'
);

SELECT * FROM finish();
ROLLBACK;
