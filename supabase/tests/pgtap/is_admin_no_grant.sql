-- Slice 006 / T033 / US4 / contracts/is-admin.predicate.sql.md § Test surface.
-- Likely GREEN against T007's real body (slot 0062).
--
-- Pre-state (seed):
--   alpha
--     auth.users.id   = 00000000-0000-0000-0000-00000000000a
--     participants.id = 11111111-1111-1111-1111-111111111111   status='active'
--     NO admin_roles row (T009 bootstrap only seeds admin1).
--
-- Assertion: is_admin(alpha.auth_user_id) returns FALSE -- the EXISTS query
-- finds no matching admin_roles row.

BEGIN;

SELECT plan(1);

SELECT is(
  public.is_admin('00000000-0000-0000-0000-00000000000a'::uuid),
  FALSE,
  'is_admin(alpha) returns FALSE for an active participant with NO admin_roles row'
);

SELECT * FROM finish();
ROLLBACK;
