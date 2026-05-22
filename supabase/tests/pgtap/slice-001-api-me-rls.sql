-- slice-001-api-me-rls.sql
-- Slice 001-eligibility-login | Task T030
--
-- Spec anchors:
--   FR-001 (eligibility-restricted access), FR-002 (server-side re-check on
--   every authenticated read or write), Constitution Principle II
--   (defense-in-depth: RLS independently denies even if the API guard is
--   bypassed). Contract: `specs/001-eligibility-login/contracts/participant-me.read.md`
--   § Test surface row `slice-001-api-me-rls.sql` ("With participant Alpha's
--   JWT, SELECT … FROM participants returns exactly Alpha's row; never any
--   other participant's row"). Data-model anchor:
--   `specs/001-eligibility-login/data-model.md` § RLS posture summary.
--
-- Migration under test:
--   `supabase/migrations/0007_participants_rls.sql` creates policy
--   `participants_self_or_admin_read` with USING:
--     (auth_user_id = auth.uid()
--        AND public.is_eligible_nortal_participant(auth.uid()))
--     OR public.is_admin(auth.uid())
--   FORCE ROW LEVEL SECURITY is set so the policy applies to every non-bypass
--   role. The `is_admin` stub (migration 0006) returns false for everyone in
--   Slice 001, so only the self-and-eligible branch of the OR is active.
--
-- RED / GREEN expectation against the current migration set:
--   GREEN. Migrations 0001-0009 are all present, including 0005
--   (is_eligible_nortal_participant body) and 0007 (the RLS policy). T012/T023
--   shipped together, so the policy can already evaluate the predicate. The
--   task body in tasks.md (line 1172) anticipated a RED state because T023's
--   body was meant to land later in Phase 4; in the current tree T023 has
--   already shipped. Final RED-vs-GREEN status is reconciled by T031's
--   red-gate document and T035's regression checkpoint.
--
-- Fixture personas (supabase/seed/slice-001-fixture.sql):
--   alpha — auth.users.id = 00000000-0000-0000-0000-00000000000a
--         — participants.id = 11111111-1111-1111-1111-111111111111
--         — email alpha@nortal.com, status='active'
--   bravo — auth.users.id = 00000000-0000-0000-0000-00000000000b
--         — participants.id = 22222222-2222-2222-2222-222222222222
--         — email bravo@nortal.com, status='active'
--   Both personas are eligible (active + approved domain), so the predicate
--   side of the policy evaluates true and the auth_user_id = auth.uid() side
--   restricts each persona to their own row.
--
-- JWT-switching convention used here:
--   Supabase's `auth.uid()` resolves to
--     (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
--   so we set `request.jwt.claims` via `SET LOCAL` to a JSON object whose
--   `sub` is the auth.users.id of the persona under test. We also `SET LOCAL
--   role authenticated;` so the `TO authenticated` clause on the policy
--   actually engages and FORCE ROW LEVEL SECURITY denies bypass. Switching
--   personas is two more `SET LOCAL`s — Postgres scopes `SET LOCAL` to the
--   surrounding transaction, so `ROLLBACK` at the end cleans everything up.
--   We `RESET role` (back to the test runner's superuser) between persona
--   switches to ensure the next `SET LOCAL role authenticated` re-applies
--   cleanly; we do NOT need to RESET request.jwt.claims because the next
--   `SET LOCAL request.jwt.claims = '...'` overwrites it within the same txn.
--
-- Pattern: BEGIN / plan / asserts / finish / ROLLBACK so this test leaves no
-- residue and never escalates privilege beyond the txn.

BEGIN;

SELECT plan(4);

-- ---------------------------------------------------------------------------
-- Persona switch: ALPHA
-- ---------------------------------------------------------------------------
-- Stage the JWT claims first (as superuser, before downgrading role). The
-- second SET LOCAL flips us into the `authenticated` role so the policy's
-- `TO authenticated` clause engages and FORCE ROW LEVEL SECURITY applies.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL role authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.participants),
  1,
  'T1 alpha JWT: SELECT count(*) FROM participants returns exactly 1 row under RLS'
);

SELECT is(
  (SELECT id FROM public.participants),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'T2 alpha JWT: the one visible participants.id is alpha''s (no cross-leak)'
);

-- ---------------------------------------------------------------------------
-- Persona switch: BRAVO
-- ---------------------------------------------------------------------------
-- Back to the test runner so we can re-set role + claims cleanly. RESET role
-- returns us to the session role (superuser in the test harness), which has
-- the privilege to issue the next SET LOCAL role authenticated.
RESET role;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}';
SET LOCAL role authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.participants),
  1,
  'T3 bravo JWT: SELECT count(*) FROM participants returns exactly 1 row under RLS'
);

SELECT is(
  (SELECT id FROM public.participants),
  '22222222-2222-2222-2222-222222222222'::uuid,
  'T4 bravo JWT: the one visible participants.id is bravo''s (no cross-leak)'
);

-- Restore superuser role before finish() so the test harness's housekeeping
-- queries (plan/finish bookkeeping) don't run under the authenticated role.
RESET role;

SELECT * FROM finish();

ROLLBACK;
