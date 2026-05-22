-- is_eligible_active_approved.sql
-- Slice 001-eligibility-login | Task T018
-- Spec scenario: FR-003 / US1 happy path — an active participant whose
-- stored email domain is in `tournament_config.eligibility.approved_domains`
-- MUST be reported eligible by the locked cross-slice predicate
-- `public.is_eligible_nortal_participant(uuid)`.
-- Fixture row: alpha (participants.auth_user_id =
--   '00000000-0000-0000-0000-00000000000a', email='alpha@nortal.com',
--   status='active'); see supabase/seed/slice-001-fixture.sql.
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
    '00000000-0000-0000-0000-00000000000a'::uuid
  ),
  true,
  'active approved-domain participant (alpha) is eligible'
);

SELECT * FROM finish();

ROLLBACK;
