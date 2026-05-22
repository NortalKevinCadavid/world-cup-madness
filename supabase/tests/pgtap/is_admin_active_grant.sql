-- Slice 006 / T033 / US4 / contracts/is-admin.predicate.sql.md § Test surface.
-- Likely GREEN against T007's real body (slot 0062).
--
-- Pre-state (seed):
--   admin1
--     auth.users.id   = 00000000-0000-0000-0000-0000000000d3
--     participants.id = 77777777-7777-7777-7777-777777777777   status='active'
--     admin_roles row (active, revoked_at IS NULL) seeded by migration 0074
--     (T009 bootstrap).
--
-- Assertion: is_admin(admin1.auth_user_id) returns TRUE.
--
-- Reads admin_roles via T007's body: EXISTS over admin_roles JOIN participants
-- WHERE auth_user_id = p_user_id AND revoked_at IS NULL.

BEGIN;

SELECT plan(1);

SELECT is(
  public.is_admin('00000000-0000-0000-0000-0000000000d3'::uuid),
  TRUE,
  'is_admin(admin1) returns TRUE for the bootstrapped active admin grant'
);

SELECT * FROM finish();
ROLLBACK;
