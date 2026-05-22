-- upsert_concurrency.sql
-- Slice 008 Tournament Configuration | Task T025 | Foundation regression
--
-- Spec anchors:
--   spec.md § Clarification Q2 -- when two admins edit the same key
--   concurrently, the second writer must lose with a deterministic conflict
--   error so neither write is silently dropped. The contract surfaces this
--   as Postgres SQLSTATE WCG01 (optimistic concurrency conflict).
--
-- Contract source of truth:
--   contracts/admin-config-upsert.write.md § Behavior > Concurrency control:
--     - Caller passes p_expected_version_id (the version_id they last read).
--     - If tournament_config.version_id <> p_expected_version_id at the time
--       of UPDATE, the RPC raises WCG01 and rolls back the whole transaction
--       (atomic 3-write of audit_log + tournament_config_versions +
--       tournament_config).
--     - pg_advisory_xact_lock(hashtext(key)) prevents two writers in the same
--       session/transaction from interleaving, but cross-session races are
--       resolved purely by the version_id check.
--
-- === Single-connection simulation caveat ============================
-- pgTAP runs every assertion on a single Postgres connection inside one
-- BEGIN ... ROLLBACK envelope, so we cannot literally open two sessions
-- here. Instead we simulate the race deterministically:
--
--   1. Read the current version_id V of eligibility.allowed_domains.
--   2. Call admin_config_upsert(..., expected_version_id => V, ...) as if
--      we were "admin A" -- this succeeds and bumps the row to V+1.
--   3. Call admin_config_upsert(..., expected_version_id => V, ...) AGAIN
--      with the SAME stale V -- this is exactly what "admin B" who read V
--      before A's write would send, and it must raise WCG01.
--
-- Because step 2 commits a new version_id within the test transaction and
-- step 3 re-uses the original V, the version-mismatch branch in
-- admin_config_upsert (Step 7 of the function body) fires for the same
-- reason it would in a real two-session race. True multi-session
-- concurrency (two psql clients, two HTTPS callers) is exercised at the
-- Playwright / integration-test layer or via a Deno-style spec; that is
-- intentionally out of scope for the single-connection pgTAP suite.
-- =====================================================================
--
-- All assertions run as the seeded admin (fixture uuid d3, mirroring slice
-- 007 conventions and the sibling T024/T026 tests) so the WCG07 admin gate
-- and the WCG02 reason/citation gates are satisfied and the WCG01 path is
-- the only one exercised.

BEGIN;
SELECT plan(3);

-- Establish admin context for every assertion below. SET LOCAL keeps the
-- role change inside this transaction so the ROLLBACK at the end fully
-- isolates state.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

-- Capture baseline state. test.v is the version_id both "admin A" (step 2)
-- and "admin B" (step 3) will send as their expected_version_id. After A
-- succeeds the row moves to V+1, so B's reuse of V is the exact stale-read
-- pattern the optimistic-lock check is designed to reject.
SELECT set_config(
  'test.v',
  (SELECT version_id::text
     FROM public.tournament_config
    WHERE key = 'eligibility.allowed_domains'),
  false
);

-- Capture the row-count baseline for tournament_config_versions so A3 can
-- assert that exactly ONE new version row exists after the race (proving
-- the WCG01 transaction in step 3 rolled back its would-be version insert,
-- per the atomic 3-write contract).
SELECT set_config(
  'test.versions_before',
  (SELECT count(*)::text
     FROM public.tournament_config_versions
    WHERE key = 'eligibility.allowed_domains'),
  false
);

-- A1: "admin A" upsert with the current version_id succeeds. We must pass
-- p_source_citation because eligibility.* is on the security-sensitive list
-- (Step 4 of admin_config_upsert) -- omitting it would short-circuit to
-- WCG02 before we ever reached the WCG01 path under test. The new value
-- adds a domain to the seed (["nortal.com"]) without removing any, so the
-- preview reports affecting=false and no acknowledge_token is required.
SELECT lives_ok(
  format(
    $f$SELECT public.admin_config_upsert(
         'eligibility.allowed_domains'::text,
         '["nortal.com","first.com"]'::jsonb,
         %L::bigint,
         'first concurrent writer'::text,
         'T025 concurrency test'::text
       )$f$,
    current_setting('test.v')
  ),
  'A1: first upsert with current version_id succeeds (becomes V+1)'
);

-- A2: "admin B" upsert reusing the SAME stale expected_version_id must
-- raise WCG01. After A1 the row sits at V+1, so resending V is identical
-- to the cross-session race where B read V before A wrote.
SELECT throws_ok(
  format(
    $f$SELECT public.admin_config_upsert(
         'eligibility.allowed_domains'::text,
         '["nortal.com","second.com"]'::jsonb,
         %L::bigint,
         'second concurrent writer'::text,
         'T025 concurrency test'::text
       )$f$,
    current_setting('test.v')
  ),
  'WCG01',
  NULL,
  'A2: second upsert with stale expected_version_id raises WCG01'
);

-- A3: exactly ONE new tournament_config_versions row exists for this key
-- since the test started. Two rows would indicate B's INSERT leaked
-- through despite the WCG01 raise, which would violate the atomic 3-write
-- contract (audit_log + versions + tournament_config all-or-nothing).
SELECT is(
  (SELECT count(*)::bigint
     FROM public.tournament_config_versions
    WHERE key = 'eligibility.allowed_domains')
    - current_setting('test.versions_before')::bigint,
  1::bigint,
  'A3: only 1 new tournament_config_versions row (WCG01 rolled back B''s writes)'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
