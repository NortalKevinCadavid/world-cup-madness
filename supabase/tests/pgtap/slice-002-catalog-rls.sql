-- Slice 002 / T017 / Constitution II + III + data-model.md § RLS posture. Validates
-- that the catalog policies (T009 / migration 0026) deny ineligible reads and
-- enforce mid-session deny from slice 001's Clarifications Q3.
--
-- Spec anchors:
--   data-model.md § RLS posture summary — participant-readable: teams, matches,
--   match_results; admin-only: team_provider_external_ids,
--   match_provider_external_ids, provider_sync_runs, provider_sync_state,
--   match_pending_review. contracts/match-catalog.read.md § Test surface row
--   `slice-002-catalog-rls.sql`. Slice 001 Clarifications 2026-05-15 / E-3
--   (mid-session domain removal MUST deny the next read).
--
-- Migration under test:
--   `supabase/migrations/0026_catalog_rls.sql` (T009, already shipped in
--   Phase 2). All 8 catalog tables are ENABLE + FORCE RLS; SELECT policies on
--   teams/matches/match_results gate on
--   public.is_eligible_nortal_participant(auth.uid()); SELECT policies on the
--   5 internal-plumbing tables gate on public.is_admin(auth.uid()).
--
-- RED / GREEN expectation against the current migration set:
--   GREEN. The original T017 task body (specs/002-match-catalog/tasks.md
--   line 686) anticipated RED because it was authored when T009 was still
--   pending, but T009 landed in Phase 2 so the policies are already live.
--   T020's API-route handler is the user-facing surface, but this file
--   tests the database layer directly via pgTAP, which is independent of
--   the route. Every assertion below is expected to pass against the
--   current tree.
--
-- Fixture personas:
--   alpha     — auth.users.id = 00000000-0000-0000-0000-00000000000a
--             — eligible (active participant, @nortal.com domain on the
--               approved-domains list).
--   outsider  — auth.users.id = 00000000-0000-0000-0000-00000000000e
--             — INELIGIBLE: no participants row exists, so
--               is_eligible_nortal_participant(outsider) returns false.
--   No admin persona is exercised here. The slice 001 is_admin(uuid) stub
--   (migration 0006, retained by T014) returns false for everyone, so an
--   "admin JWT" scenario cannot prove admin-visibility of the internal
--   tables in the current tree — it would only re-prove the deny path.
--   Slice 006 will introduce a real admin role and the admin-positive
--   assertions belong with that work.
--
-- Slice 002 fixture (supabase/seed/slice-002-fixture.sql):
--   8 teams, 8 matches, 1 match_results row. No rows are seeded into
--   provider_sync_runs / provider_sync_state / match_pending_review, but
--   those tables are RLS-protected regardless — admin-only SELECT — and
--   alpha must see 0 rows there even when they happen to be empty (the
--   policy denial and the empty-table case both yield count=0; this test
--   asserts that the count is 0, which holds under either reading).
--
-- JWT-switching convention used here (mirrors slice-001-api-me-rls.sql):
--   Supabase's `auth.uid()` resolves to
--     (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
--   so we stage the claims via `SET LOCAL request.jwt.claims = '...'` from
--   the test runner's superuser role, then `SET LOCAL role authenticated;`
--   so the `TO authenticated` clause on each policy engages and FORCE ROW
--   LEVEL SECURITY denies bypass. Persona switches go through `RESET role`
--   before the next pair of SET LOCALs so the role-grant step re-applies
--   cleanly. SAVEPOINTs partition the scenarios so any mutation (Scenario 4)
--   is reverted before the next scenario runs.
--
-- Pattern: BEGIN / plan / asserts / finish / ROLLBACK. The outer ROLLBACK
-- guarantees no residue (including the Scenario 4 tournament_config UPDATE).

BEGIN;

SELECT plan(7);

-- ===========================================================================
-- Scenario 1: Alpha (eligible) reads the catalog tables
-- ===========================================================================
-- Eligible-participant policy on teams / matches / match_results should let
-- alpha see the full seeded catalog: 8 teams, 8 matches, 1 match_result.
SAVEPOINT s1;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL role authenticated;

SELECT is(
  (SELECT count(*) FROM public.matches),
  8::bigint,
  'S1.1 alpha (eligible) JWT: SELECT count(*) FROM matches returns the full 8-row catalog under RLS'
);

SELECT is(
  (SELECT count(*) FROM public.teams),
  8::bigint,
  'S1.2 alpha (eligible) JWT: SELECT count(*) FROM teams returns the full 8-row catalog under RLS'
);

SELECT is(
  (SELECT count(*) FROM public.match_results),
  1::bigint,
  'S1.3 alpha (eligible) JWT: SELECT count(*) FROM match_results returns the 1 seeded finished-match result under RLS'
);

RESET role;
RELEASE SAVEPOINT s1;

-- ===========================================================================
-- Scenario 2: Alpha cannot read the internal-plumbing (admin-only) tables
-- ===========================================================================
-- provider_sync_runs and match_pending_review have admin-only SELECT
-- policies gated on is_admin(auth.uid()). The slice 001 stub returns false
-- for every uuid, so alpha (despite being eligible) MUST see 0 rows from
-- both tables. (Both happen to be empty in the seed fixture, but the
-- assertion semantics are "RLS hides them"; count=0 holds in either case.)
SAVEPOINT s2;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL role authenticated;

SELECT is(
  (SELECT count(*) FROM public.provider_sync_runs),
  0::bigint,
  'S2.1 alpha (eligible, non-admin) JWT: SELECT count(*) FROM provider_sync_runs returns 0 — admin-only RLS denies the read'
);

SELECT is(
  (SELECT count(*) FROM public.match_pending_review),
  0::bigint,
  'S2.2 alpha (eligible, non-admin) JWT: SELECT count(*) FROM match_pending_review returns 0 — admin-only RLS denies the read'
);

RESET role;
RELEASE SAVEPOINT s2;

-- ===========================================================================
-- Scenario 3: Outsider (ineligible) sees nothing from matches
-- ===========================================================================
-- outsider has no participants row, so
-- is_eligible_nortal_participant(outsider) returns false and the
-- matches_eligible_read USING clause evaluates to false. Every matches row
-- MUST be filtered out — count = 0.
SAVEPOINT s3;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000e","role":"authenticated"}';
SET LOCAL role authenticated;

SELECT is(
  (SELECT count(*) FROM public.matches),
  0::bigint,
  'S3.1 outsider (ineligible — no participants row) JWT: SELECT count(*) FROM matches returns 0 — eligibility predicate denies the read'
);

RESET role;
RELEASE SAVEPOINT s3;

-- ===========================================================================
-- Scenario 4: Mid-session deny (slice 001 Clarifications Q3 / E-3)
-- ===========================================================================
-- Slice 002's catalog policies embed the same is_eligible_nortal_participant
-- predicate that slice 001 already proved re-evaluates on every read. We
-- reconfirm here on the matches table: alpha starts eligible, an admin
-- empties eligibility.approved_domains, and alpha's NEXT read under the
-- same JWT MUST return 0 rows from matches.
--
-- The UPDATE on tournament_config runs as the test runner's superuser
-- because migration 0007 REVOKEd UPDATE on tournament_config from the
-- authenticated role. RESET role first, mutate, then SET LOCAL role
-- authenticated for the post-mutation measurement. The SAVEPOINT scope
-- reverts the UPDATE before this txn exits (the outer ROLLBACK would do
-- the same, but the explicit SAVEPOINT keeps this scenario self-contained
-- in case future scenarios are appended below).
SAVEPOINT s4;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL role authenticated;

-- Sanity: alpha sees the full catalog at this point (baseline inside s4).
-- Folding the precondition into the assertion would inflate the plan; we
-- rely on Scenario 1's already-passing S1.1 as the baseline and only assert
-- the post-mutation count here.

RESET role;

UPDATE public.tournament_config
   SET value = '[]'::jsonb
 WHERE key = 'eligibility.approved_domains';

SET LOCAL role authenticated;
-- request.jwt.claims is still alpha's from above — SET LOCAL persists for
-- the rest of the transaction unless overwritten.

SELECT is(
  (SELECT count(*) FROM public.matches),
  0::bigint,
  'S4.1 mid-session deny: same alpha JWT but eligibility.approved_domains is now empty — RLS denies the next read, 0 matches visible (slice 001 Clarifications 2026-05-15 / E-3)'
);

RESET role;
ROLLBACK TO SAVEPOINT s4;

-- Restore superuser role before finish() so the test harness's bookkeeping
-- queries run with full privilege. The outer ROLLBACK reverts the txn
-- (including any residual SET LOCALs) so this test leaves no residue.
RESET role;

SELECT * FROM finish();

ROLLBACK;
