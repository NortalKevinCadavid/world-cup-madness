-- is_eligible_null_uid.sql
-- Slice 001-eligibility-login | Task T018
-- Spec scenario: contracts/eligibility-predicate.sql.md § Semantics — when
-- `p_uid IS NULL` the predicate MUST return FALSE (not NULL, no exception).
-- This is the most load-bearing fail-closed case because RLS treats a NULL
-- `USING` result as DENY but downstream code paths sometimes wrap the
-- predicate in COALESCE/boolean expressions where a NULL would corrupt
-- truth tables. The contract guarantees a concrete boolean.
--
-- RED expectation: this test is authored BEFORE T023 implements the
-- predicate body (Constitution Principle IX). Until T023 ships, the
-- function does not exist and this file is expected to fail.
--
-- Pattern: BEGIN / plan / asserts / finish / ROLLBACK so the harness
-- leaves no residue in the database.

BEGIN;

SELECT plan(2);

SELECT is(
  public.is_eligible_nortal_participant(NULL::uuid),
  false,
  'NULL uid returns false (not NULL)'
);

SELECT isnt(
  public.is_eligible_nortal_participant(NULL::uuid),
  NULL::boolean,
  'NULL uid does not return NULL (contract guarantees concrete boolean)'
);

SELECT * FROM finish();

ROLLBACK;
