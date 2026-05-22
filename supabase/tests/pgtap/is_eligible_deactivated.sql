-- is_eligible_deactivated.sql
-- Slice 001-eligibility-login | Task T018
-- Spec scenario: Edge case E-6 / Slice 006 hand-off — a participant whose
-- row exists with `status='deactivated'` (admin override) MUST be reported
-- ineligible even though their email domain is still on the approved list.
-- The predicate's `status = 'active'` clause is the gate.
-- Fixture row: zulu (participants.auth_user_id =
--   '00000000-0000-0000-0000-00000000000d', email='zulu@nortal.com',
--   status='deactivated'); see supabase/seed/slice-001-fixture.sql.
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
    '00000000-0000-0000-0000-00000000000d'::uuid
  ),
  false,
  'deactivated participant (zulu) is not eligible'
);

SELECT * FROM finish();

ROLLBACK;
