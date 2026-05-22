-- Slice 006 / T033 / US4 / contracts/is-admin.predicate.sql.md § Test surface.
-- Likely GREEN against T007's real body (slot 0062).
--
-- Contract semantics: returns FALSE when no participants row matches p_uid.
--
-- Assertion: is_admin(<random uuid>) returns FALSE -- the EXISTS query's
-- JOIN finds zero participants rows, so EXISTS is FALSE.
--
-- The literal random uuid is deterministic so the failure message is stable;
-- we deliberately avoid gen_random_uuid() to keep the test reproducible.

BEGIN;

SELECT plan(1);

SELECT is(
  public.is_admin('deadbeef-dead-beef-dead-beefdeadbeef'::uuid),
  FALSE,
  'is_admin(<random uuid not matching any auth_user_id>) returns FALSE'
);

SELECT * FROM finish();
ROLLBACK;
