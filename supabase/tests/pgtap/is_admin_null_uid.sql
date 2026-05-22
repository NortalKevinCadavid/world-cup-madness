-- Slice 006 / T033 / US4 / contracts/is-admin.predicate.sql.md § Test surface.
-- Likely GREEN against T007's real body (slot 0062).
--
-- Contract semantics: returns FALSE (NOT NULL) when p_uid IS NULL.
--   T007's body comment (slot 0062, header note) explicitly covers this: the
--   WHERE clause `p.auth_user_id = NULL` yields UNKNOWN for every row, so
--   EXISTS returns FALSE. This is the desired safe default for the
--   unauthenticated context where auth.uid() returns NULL.
--
-- Assertion: is_admin(NULL) returns FALSE -- and importantly returns a
-- non-null boolean (RLS USING expressions require boolean, not NULL).

BEGIN;

SELECT plan(2);

-- A1: the value is FALSE, not NULL.
SELECT is(
  public.is_admin(NULL::uuid),
  FALSE,
  'A1 is_admin(NULL) returns FALSE (the EXISTS predicate evaluates UNKNOWN -> no rows -> FALSE)'
);

-- A2: explicit non-null guard so RLS USING(is_admin(auth.uid())) cannot ever
-- evaluate to NULL (which would be treated as deny but should be EXPLICIT).
SELECT isnt(
  public.is_admin(NULL::uuid),
  NULL,
  'A2 is_admin(NULL) returns a non-null boolean (NEVER NULL per contract § Signature)'
);

SELECT * FROM finish();
ROLLBACK;
