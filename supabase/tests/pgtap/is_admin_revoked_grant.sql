-- Slice 006 / T033 / US4 / contracts/is-admin.predicate.sql.md § Test surface.
-- Likely GREEN against T007's real body (slot 0062).
--
-- Pre-state (seed):
--   admin1
--     auth.users.id   = 00000000-0000-0000-0000-0000000000d3
--     participants.id = 77777777-7777-7777-7777-777777777777
--     ONE active admin_roles row (T009 bootstrap).
--
-- This test mutates that row -> sets revoked_at = now(), revoked_by = admin1.pid
-- (CHECK constraint requires both NULL or both NOT NULL). After the UPDATE
-- there is ZERO active admin_roles row for admin1.
--
-- Assertions:
--   A1 sanity: starting state is_admin(admin1) = TRUE.
--   A2 post-revoke: is_admin(admin1) = FALSE.
--
-- ROLLBACK at end restores the bootstrap row to active state.

BEGIN;

SELECT plan(2);

-- A1: sanity check the pre-state matches our assumption (bootstrap shipped).
SELECT is(
  public.is_admin('00000000-0000-0000-0000-0000000000d3'::uuid),
  TRUE,
  'A1 admin1 starts with active admin role (T009 bootstrap)'
);

-- Revoke admin1's active grant. The partial unique index admin_roles_active_uk
-- means there is at most one row with revoked_at IS NULL for this participant.
UPDATE public.admin_roles
   SET revoked_at    = now(),
       revoked_by    = '77777777-7777-7777-7777-777777777777'::uuid,
       revoke_reason = 'T033 revoked-grant test'
 WHERE participant_id = '77777777-7777-7777-7777-777777777777'::uuid
   AND revoked_at IS NULL;

-- A2: predicate now returns FALSE because no active admin_roles row exists.
SELECT is(
  public.is_admin('00000000-0000-0000-0000-0000000000d3'::uuid),
  FALSE,
  'A2 is_admin(admin1) returns FALSE after the only active grant is revoked'
);

SELECT * FROM finish();
ROLLBACK;
