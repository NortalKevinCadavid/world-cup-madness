-- Slice 006 / T033 / US4 / contracts/is-admin.predicate.sql.md § Test surface.
-- Likely GREEN against T007's real body (slot 0062).
--
-- Exercises the partial-unique-index semantics on admin_roles_active_uk:
--   UNIQUE (participant_id) WHERE revoked_at IS NULL
-- so multiple historic rows are allowed as long as at most one is active.
--
-- Pre-state (seed):
--   admin1.participants.id = 77777777-7777-7777-7777-777777777777
--   ONE active admin_roles row from the T009 bootstrap (migration 0074).
--
-- Sequence:
--   1. Sanity: is_admin(admin1) = TRUE.
--   2. Revoke the bootstrap row -> is_admin(admin1) = FALSE.
--   3. INSERT a brand-new active admin_roles row (allowed because the prior
--      row is revoked, so the partial-unique-index permits the new active row).
--      -> is_admin(admin1) = TRUE again.
--
-- ROLLBACK at end restores the seed.

BEGIN;

SELECT plan(3);

-- A1: starting state -- T009 bootstrap shipped an active grant.
SELECT is(
  public.is_admin('00000000-0000-0000-0000-0000000000d3'::uuid),
  TRUE,
  'A1 admin1 starts active (T009 bootstrap)'
);

-- Revoke the active grant.
UPDATE public.admin_roles
   SET revoked_at    = now(),
       revoked_by    = '77777777-7777-7777-7777-777777777777'::uuid,
       revoke_reason = 'T033 revoke-then-regrant: phase 1'
 WHERE participant_id = '77777777-7777-7777-7777-777777777777'::uuid
   AND revoked_at IS NULL;

-- A2: post-revoke -> FALSE.
SELECT is(
  public.is_admin('00000000-0000-0000-0000-0000000000d3'::uuid),
  FALSE,
  'A2 is_admin(admin1) is FALSE while no active admin_roles row exists'
);

-- Re-grant: insert a NEW active row. The partial-unique-index permits this
-- because the prior row's revoked_at IS NOT NULL excludes it from the index.
INSERT INTO public.admin_roles (
  participant_id, granted_at, granted_by, revoked_at, revoked_by, revoke_reason
) VALUES (
  '77777777-7777-7777-7777-777777777777'::uuid,
  now(),
  '77777777-7777-7777-7777-777777777777'::uuid, -- self-grant for the test
  NULL, NULL, NULL
);

-- A3: regranted -> TRUE again. Multiple historic rows (one revoked + one
-- active) are handled correctly by the partial-unique-index.
SELECT is(
  public.is_admin('00000000-0000-0000-0000-0000000000d3'::uuid),
  TRUE,
  'A3 is_admin(admin1) is TRUE again after a new active admin_roles row is inserted (revoke + regrant)'
);

SELECT * FROM finish();
ROLLBACK;
