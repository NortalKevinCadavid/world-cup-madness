-- upsert_authorization.sql
-- Slice 008 Tournament Configuration | Task T024 | US1
--
-- Spec anchors:
--   spec.md § US1 -- "Admin updates a tournament configuration value." The
--   write surface (admin_config_upsert) is admin-only. Non-admin callers
--   MUST be denied and the denial MUST be auditable.
--
-- Contract source of truth:
--   contracts/admin-config-rpcs.write.md § Behavior -- admin_config_upsert:
--   "If is_admin(auth.uid()) returns false, the RPC MUST (a) INSERT an
--    audit_log row with action='admin.access_denied',
--    entity_type='admin_config_upsert', source='api_guard',
--    actor=auth.uid(), new_value=jsonb_build_object('rpc',
--    'admin_config_upsert','key',p_key), and (b) RAISE EXCEPTION with
--    SQLSTATE WCG07. Admin callers receive RETURNS bigint = the new
--    tournament_config_versions.version_id and the corresponding
--    tournament_config row's version_id is updated atomically."
--
-- Implementation reference: supabase/migrations/0077_configuration.sql §
-- T011 admin_config_upsert (lines 460..636), Step 1 = is_admin gate +
-- audit row + WCG07 raise.
--
-- Test scope (plan(4) -- 1 throws_ok + 1 cmp_ok + 1 lives_ok + 1 cmp_ok):
--   A1: SET ROLE authenticated with non-admin JWT (alpha); call
--       admin_config_upsert(...) -- expect SQLSTATE WCG07.
--   A2: Verify the RPC body wrote an admin.access_denied audit row with
--       the locked shape (entity_type='admin_config_upsert',
--       source='api_guard', actor=alpha uuid, occurred_at within the
--       current test window).
--   A3: SET ROLE authenticated with admin JWT (admin1); call
--       admin_config_upsert('eligibility.allowed_domains', new_value,
--       current_version_id, reason, source_citation) -- expect lives_ok
--       (returns a bigint version_id).
--   A4: Verify tournament_config.version_id was incremented (atomic
--       3-write of audit_log -> tournament_config_versions ->
--       tournament_config completed).
--
-- Out of scope (covered by sibling tasks):
--   * T025 upsert_concurrency.sql -- WCG01 expected_version_id race.
--   * T026 upsert_validation.sql -- WCG02/WCG03/WCG05/WCG06 input errors.
--
-- Impersonation pattern:
--   The test runner role is `postgres` (BYPASSRLS + DDL). For each
--   assertion we (1) set request.jwt.claims via set_config so the
--   SECURITY DEFINER body sees auth.uid() correctly, (2) SET LOCAL ROLE
--   authenticated to ensure the privilege evaluation matches a real
--   PostgREST call, (3) RESET ROLE between assertions to return to the
--   postgres test-runner context (needed for the audit_log SELECT in A2
--   and the tournament_config SELECT in A4 which would otherwise be
--   RLS-gated). This mirrors slice 007's audit_search_authorization.sql.
--
-- Fixture choices:
--   Key: 'eligibility.allowed_domains' (seeded by slot 0077 line 282 to
--   '["nortal.com"]'). A3 sets value to '["nortal.com","testdomain.com"]'
--   which ADDS a domain but REMOVES NONE, so admin_config_preview returns
--   affecting=false (see slot 0077 lines 781..820: "affecting" only fires
--   when domains are being removed). This means we can exercise the
--   happy path without minting an acknowledge_token. The key is in the
--   'eligibility.%' family, so p_source_citation is REQUIRED (slot 0077
--   lines 551..560). We pass 'T024 test fixture' to satisfy that gate.
--
-- Fixture uuids (slice 001 seed):
--   * alpha   (non-admin) auth_user_id 00000000-0000-0000-0000-00000000000a
--   * admin1  (admin)     auth_user_id 00000000-0000-0000-0000-0000000000d3
--
-- Pattern: BEGIN / plan(4) / asserts / finish / ROLLBACK. The ROLLBACK
-- means none of the audit_log inserts or tournament_config mutations
-- persist beyond the test session.

BEGIN;

SELECT plan(4);

-- Capture the test start time as a session-local boundary so the A2
-- audit-row count can exclude any pre-seeded admin.access_denied rows
-- on entity_type='admin_config_upsert' (defense against fixture drift).
-- is_local=false because we need this visible across all assertions.
SELECT set_config('test.start_ts', clock_timestamp()::text, false);

-- Capture the current version_id of 'eligibility.allowed_domains' BEFORE
-- the admin upsert so A4 can verify the increment. Captured under the
-- postgres role to bypass any RLS on tournament_config.
SELECT set_config(
  'test.expected_v',
  (SELECT version_id::text
     FROM public.tournament_config
    WHERE key = 'eligibility.allowed_domains'),
  false
);

-- ---------------------------------------------------------------------------
-- A1: non-admin caller -> WCG07.
-- Set JWT sub to alpha's auth_user_id, switch to authenticated role, invoke
-- admin_config_upsert() with otherwise-valid arguments. The RPC's
-- is_admin(auth.uid()) gate raises WCG07 BEFORE any value/version checks
-- run, so the (intentionally bogus) p_expected_version_id=1 is irrelevant.
-- NULL message-match keeps the assertion robust against minor wording drift
-- in the RAISE EXCEPTION USING MESSAGE clause.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000a',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.admin_config_upsert(
      'eligibility.allowed_domains'::text,
      '["test.com"]'::jsonb,
      1::bigint,
      'non-admin denial test'::text,
      'T024 fixture'::text
    )$$,
  'WCG07',
  NULL,
  'A1: non-admin admin_config_upsert raises WCG07'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: the WCG07 raise was preceded by an admin.access_denied audit row
-- written by the RPC body (api_guard pattern from slice 006/007). We
-- evaluate under postgres role so RLS doesn't gate the SELECT. The
-- occurred_at lower bound (test.start_ts captured above) protects against
-- false positives from any pre-seeded denial rows in the fixture.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  (SELECT count(*)
     FROM public.audit_log
    WHERE action = 'admin.access_denied'
      AND entity_type = 'admin_config_upsert'
      AND source = 'api_guard'
      AND actor = '00000000-0000-0000-0000-00000000000a'::uuid
      AND occurred_at >= current_setting('test.start_ts')::timestamptz),
  '>=',
  1::bigint,
  'A2: non-admin call produced admin.access_denied audit row'
);

-- ---------------------------------------------------------------------------
-- A3: admin caller -> happy-path upsert returns a bigint version_id.
-- Set JWT sub to admin1's auth_user_id (is_admin() resolves via
-- participants.is_admin flag for the participant row keyed by this
-- auth_user_id). Pass:
--   * key            = 'eligibility.allowed_domains' (seeded to ["nortal.com"])
--   * value          = ["nortal.com","testdomain.com"] (ADD only, no removals)
--   * expected_v_id  = current version_id captured above
--   * reason         = non-empty (clears WCG02 reason gate)
--   * source_citation= 'T024 test fixture' (required for eligibility.% per slot 0077 L551..560)
--   * ack_token      = NULL (affecting=false because no domain is removed)
-- lives_ok asserts the call did not raise; we deliberately do NOT pin the
-- return value because version_id is BIGSERIAL and other tests in the
-- same DB may have allocated ids. A4 below pins the directional invariant
-- (new > old) which is the contract-level guarantee.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  format(
    $f$SELECT public.admin_config_upsert(
         'eligibility.allowed_domains'::text,
         '["nortal.com","testdomain.com"]'::jsonb,
         %L::bigint,
         'T024 admin upsert add domain'::text,
         'T024 test fixture'::text
       )$f$,
    current_setting('test.expected_v')
  ),
  'A3: admin admin_config_upsert lives_ok (returns bigint version_id)'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A4: tournament_config.version_id was incremented as part of the atomic
-- 3-write (slot 0077 lines 598..629). The strict '>' assertion proves a
-- NEW row was minted in tournament_config_versions and the matching
-- tournament_config row was UPDATEd to point at it. Evaluated under
-- postgres role to bypass RLS on tournament_config (which is admin-read
-- in production but kept restrictive in tests).
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  (SELECT version_id
     FROM public.tournament_config
    WHERE key = 'eligibility.allowed_domains'),
  '>',
  current_setting('test.expected_v')::bigint,
  'A4: tournament_config.version_id incremented after admin upsert'
);

SELECT * FROM finish();

ROLLBACK;
