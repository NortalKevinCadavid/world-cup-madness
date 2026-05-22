-- is_eligible_unknown_uid.sql
-- Slice 001-eligibility-login | Task T018
-- Spec scenario: fail-closed default (contracts/eligibility-predicate.sql.md
--   § Semantics — "No matching participant row exists"). A UUID with no
-- corresponding row in `public.participants` MUST return FALSE, not NULL
-- and not raise. Guards RLS callers (`USING is_eligible_nortal_participant(
-- auth.uid())`) against a NULL leak being treated as TRUE.
-- Fixture: the UUID '99999999-0000-0000-0000-999999999999' is deliberately
-- not present in any seeded auth.users or participants row.
--
-- RED expectation: this test is authored BEFORE T023 implements the
-- predicate body (Constitution Principle IX). Until T023 ships, the
-- function does not exist and this file is expected to fail.
--
-- Pattern: BEGIN / plan / asserts / finish / ROLLBACK so the harness
-- leaves no residue in the database.

BEGIN;

SELECT plan(1);

SELECT is(
  public.is_eligible_nortal_participant(
    '99999999-0000-0000-0000-999999999999'::uuid
  ),
  false,
  'unknown uid with no participants row is not eligible (fail-closed)'
);

SELECT * FROM finish();

ROLLBACK;
