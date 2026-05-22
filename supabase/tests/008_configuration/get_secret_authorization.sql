-- get_secret_authorization.sql
-- Slice 008 Tournament Configuration | Task T042 | US4 (Secret read surface)
--
-- Spec anchors:
--   spec.md § US4 — "Admin reads a secret-namespace configuration value via
--   admin_config_get_secret." The read surface is admin-only AND forensic-
--   audited. Non-admin callers MUST be denied and the denial MUST be
--   auditable; admin callers MUST produce an admin.config_secret_accessed
--   audit row that records the KEY only — NEVER the secret value itself.
--
-- Contract source of truth:
--   contracts/admin-config-rpcs.write.md § Behavior — admin_config_get_secret:
--     - is_admin(auth.uid()) gate: on failure INSERT audit row with
--       action='admin.access_denied', entity_type='admin_config_get_secret',
--       source='api_guard', actor=auth.uid(),
--       new_value=jsonb_build_object('rpc','admin_config_get_secret','key',p_key);
--       then RAISE WCG07.
--     - key_is_secret(p_key) gate (slot 0077 L131..L137:
--       p_key LIKE 'providers.%.credentials.%'). RAISE WCG03 on miss.
--     - Row-absent gate: RAISE WCG03 if tournament_config has no row.
--     - On success: INSERT audit_log row with action='admin.config_secret_accessed',
--       entity_type='tournament_config', entity_id=NULL, source='api_guard',
--       new_value=jsonb_build_object('key', p_key). The new_value MUST NOT
--       carry the 'value' or 'secret' jsonb field (Clarification Q9: secret
--       material never enters the audit trail).
--     - RETURN the full tournament_config.value jsonb (the {secret:true, value:...}
--       envelope, with the plaintext value field).
--
-- Implementation reference: supabase/migrations/0077_configuration.sql §
-- T037 admin_config_get_secret (L1313..L1399).
--
-- Catalog seed reference: slot 0077 L381..L388 seeds
--   providers.football_data_org.credentials.api_key
--   = '{"secret":true,"value":null}'::jsonb
-- so the admin-success assertion (A4) pins against this exact stub envelope.
-- A future operator-issued admin_config_upsert would replace 'value':null with
-- a real api key; the test only runs on a freshly migrated DB so the seed
-- value is the canonical fixture.
--
-- RED-by-design until T037 ships (T037 just shipped in same slice; this test
-- is GREEN-on-runtime once both T037 and T042 land together).
--
-- Test scope (plan(9) — see per-assertion comments below):
--   A1 throws_ok WCG07 (non-admin -> admin_config_get_secret)
--   A2 cmp_ok    audit_log count for admin.access_denied row (>=1)
--   A3 is        denial audit row new_value->>'key' = requested key
--   A4 is        admin call returns the seeded secret envelope jsonb
--   A5 cmp_ok    audit_log count for admin.config_secret_accessed (>=1)
--   A6 is        success audit row new_value = {"key":<requested_key>}
--   A7 is        success audit row new_value does NOT contain 'value' field
--                (the security-critical assertion: secret material MUST NOT
--                leak into the audit trail)
--   A8 throws_ok WCG03 (admin asks for a non-secret-namespace key — defence
--                in depth against accidental routing of non-secret keys
--                through the secret-read surface)
--   A9 throws_ok WCG03 (admin asks for a secret-shaped key that has no row
--                in tournament_config — proves the row-absent gate fires
--                separately from the namespace gate)
--
-- Out of scope (covered by sibling tasks):
--   * T024 upsert_authorization.sql — generic write-surface WCG07.
--   * T025 upsert_concurrency.sql / T026 upsert_validation.sql — write-side
--     gates not relevant to the read surface.
--
-- Impersonation pattern (mirrors upsert_authorization.sql / scoring_consumer_check.sql):
--   The test runner role is `postgres` (BYPASSRLS + DDL). For each role-gated
--   assertion we (1) set request.jwt.claims via set_config so the
--   SECURITY DEFINER body sees auth.uid() = the target persona, (2) SET LOCAL
--   ROLE authenticated to ensure the privilege evaluation matches a real
--   PostgREST call, (3) RESET ROLE between assertions to return to the
--   postgres test-runner context (needed for the audit_log SELECT in A2/A5
--   which would otherwise be RLS-gated by slot 0073's narrow INSERT policy
--   and the slice-007 SELECT policy).
--
-- Fixture uuids (slice 001 + slice 005 seeds; admin grant via slot 0074 bootstrap):
--   * alpha   (non-admin) auth_user_id 00000000-0000-0000-0000-00000000000a
--   * admin1  (admin)     auth_user_id 00000000-0000-0000-0000-0000000000d3
--   These match the convention used in upsert_authorization.sql /
--   scoring_consumer_check.sql / locking_window_consumer_check.sql so the
--   008 test suite remains consistent. Slot 0074 auto-grants admin1 an
--   active admin_roles row at migration time, so no in-test admin_roles
--   INSERT is needed.
--
-- Pattern: BEGIN / plan(9) / asserts / finish / ROLLBACK. The ROLLBACK
-- discards every audit_log row written during the test (both denial and
-- success rows), so the test is fully re-runnable.

BEGIN;

SELECT plan(9);

-- Capture the test start time as a session-local boundary so the audit-row
-- count assertions can exclude any pre-seeded rows on these entity_type /
-- action tuples (defense against fixture drift). is_local=false because we
-- need this visible across all assertions.
SELECT set_config('test.start_ts', clock_timestamp()::text, false);

-- ---------------------------------------------------------------------------
-- A1: non-admin caller -> WCG07.
-- Set JWT sub to alpha's auth_user_id, switch to authenticated role, invoke
-- admin_config_get_secret(). The RPC's is_admin(auth.uid()) gate raises WCG07
-- BEFORE any key_is_secret check runs (slot 0077 L1347..L1362). NULL message-
-- match keeps the assertion robust against minor wording drift in the
-- RAISE EXCEPTION USING MESSAGE clause.
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
  $$SELECT public.admin_config_get_secret(
      'providers.football_data_org.credentials.api_key'::text
    )$$,
  'WCG07',
  NULL,
  'A1: non-admin admin_config_get_secret raises WCG07'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: the WCG07 raise was preceded by an admin.access_denied audit row
-- written by the RPC body's BEGIN/EXCEPTION block (slot 0077 L1348..L1360).
-- Evaluate under postgres role so RLS doesn't gate the SELECT. The
-- occurred_at lower bound (test.start_ts captured above) protects against
-- false positives from any pre-seeded denial rows in the fixture.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  (SELECT count(*)
     FROM public.audit_log
    WHERE action = 'admin.access_denied'
      AND entity_type = 'admin_config_get_secret'
      AND source = 'api_guard'
      AND actor = '00000000-0000-0000-0000-00000000000a'::uuid
      AND occurred_at >= current_setting('test.start_ts')::timestamptz),
  '>=',
  1::bigint,
  'A2: non-admin call produced admin.access_denied audit row'
);

-- ---------------------------------------------------------------------------
-- A3: the denial audit row's new_value carries the requested key. Slot 0077
-- L1356 writes jsonb_build_object('rpc','admin_config_get_secret','key',p_key);
-- we assert new_value->>'key' matches the key we asked for. This proves that
-- forensic queries like "every denied secret-read attempt for api_key"
-- can be answered by indexing on new_value->>'key'.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT new_value->>'key'
     FROM public.audit_log
    WHERE action = 'admin.access_denied'
      AND entity_type = 'admin_config_get_secret'
      AND source = 'api_guard'
      AND actor = '00000000-0000-0000-0000-00000000000a'::uuid
      AND occurred_at >= current_setting('test.start_ts')::timestamptz
    ORDER BY occurred_at DESC
    LIMIT 1),
  'providers.football_data_org.credentials.api_key',
  'A3: denial audit row new_value->>''key'' matches the requested key'
);

-- ---------------------------------------------------------------------------
-- Switch to admin1 + authenticated role for the success-path assertions.
-- admin_config_get_secret (slot 0077 L1333..L1394) gates on is_admin(auth.uid());
-- slot 0074 bootstrap grants admin1 (auth_user_id ...000d3) an active
-- admin_roles row. is_local=true on the JWT claims means the value is dropped
-- on ROLLBACK, which is desired.
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

-- ---------------------------------------------------------------------------
-- A4: admin caller -> returns the seeded secret envelope jsonb. Slot 0077
-- L381..L388 INSERTs '{"secret":true,"value":null}' for the api_key row;
-- with no admin_config_upsert mutation in this test, that is the canonical
-- value the RPC must return. Pin against the literal envelope so any future
-- drift in the seed shape is flagged here (the RPC contract is "return
-- the stored value as-is"; if the seed shape changes, the contract may or
-- may not still hold but the test should fail loudly either way).
-- ---------------------------------------------------------------------------
SELECT is(
  public.admin_config_get_secret(
    'providers.football_data_org.credentials.api_key'::text
  ),
  '{"secret":true,"value":null}'::jsonb,
  'A4: admin call returns the seeded secret envelope jsonb'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A5: the success call wrote an admin.config_secret_accessed audit row
-- (slot 0077 L1381..L1390). entity_type='tournament_config' (not
-- 'admin_config_get_secret' — the success row uses the target table's name
-- to support "show every access to this config row" forensic queries),
-- entity_id=NULL (slot 0077 L1387), source='api_guard', actor=admin1.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  (SELECT count(*)
     FROM public.audit_log
    WHERE action = 'admin.config_secret_accessed'
      AND entity_type = 'tournament_config'
      AND source = 'api_guard'
      AND actor = '00000000-0000-0000-0000-0000000000d3'::uuid
      AND occurred_at >= current_setting('test.start_ts')::timestamptz),
  '>=',
  1::bigint,
  'A5: admin call produced admin.config_secret_accessed audit row'
);

-- ---------------------------------------------------------------------------
-- A6: the success audit row's new_value is EXACTLY {"key":<requested_key>}
-- — no extra fields beyond the key. Slot 0077 L1389 writes
-- jsonb_build_object('key', p_key). Pin against the literal jsonb so any
-- drift (adding "rpc" or "actor_email" or — worst of all — leaking the
-- secret value into new_value) fails this assertion immediately.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT new_value
     FROM public.audit_log
    WHERE action = 'admin.config_secret_accessed'
      AND entity_type = 'tournament_config'
      AND source = 'api_guard'
      AND actor = '00000000-0000-0000-0000-0000000000d3'::uuid
      AND occurred_at >= current_setting('test.start_ts')::timestamptz
    ORDER BY occurred_at DESC
    LIMIT 1),
  jsonb_build_object('key', 'providers.football_data_org.credentials.api_key'),
  'A6: success audit row new_value = {"key":<requested_key>} exactly'
);

-- ---------------------------------------------------------------------------
-- A7: the SECURITY-CRITICAL invariant. The success audit row's new_value
-- MUST NOT carry a 'value' field. Clarification Q9 + contract § Behavior:
-- "the audit row carries the KEY only — never the secret value itself."
-- We use the jsonb `?` operator: `new_value ? 'value'` returns true iff
-- new_value contains a top-level key named 'value'. A regression where
-- the RPC body accidentally writes the full tournament_config.value
-- (which has shape {"secret":true,"value":<plaintext>}) into the audit
-- new_value column would trip this assertion. This is the single most
-- important security-test in T042.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT new_value ? 'value'
     FROM public.audit_log
    WHERE action = 'admin.config_secret_accessed'
      AND entity_type = 'tournament_config'
      AND source = 'api_guard'
      AND actor = '00000000-0000-0000-0000-0000000000d3'::uuid
      AND occurred_at >= current_setting('test.start_ts')::timestamptz
    ORDER BY occurred_at DESC
    LIMIT 1),
  false,
  'A7: success audit row new_value does NOT contain ''value'' field (no secret leak)'
);

-- ---------------------------------------------------------------------------
-- A8: defence in depth — admin asks for a non-secret key.
-- 'eligibility.allowed_domains' is a real seeded key (slot 0077 L282) but
-- does NOT match the 'providers.%.credentials.%' pattern that key_is_secret()
-- requires. The RPC body's Step 2 (slot 0077 L1365..L1368) raises WCG03
-- BEFORE the SELECT against tournament_config runs. Proves the secret-read
-- surface refuses to act as a generic admin-only read path; non-secret
-- reads MUST go through tournament_config's RLS-gated SELECT instead.
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
SELECT throws_ok(
  $$SELECT public.admin_config_get_secret('eligibility.allowed_domains'::text)$$,
  'WCG03',
  NULL,
  'A8: admin admin_config_get_secret on non-secret key raises WCG03'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A9: defence in depth — admin asks for a secret-namespace key that has
-- no row in tournament_config. 'providers.nonexistent.credentials.api_key'
-- matches 'providers.%.credentials.%' so key_is_secret() returns true
-- (Step 2 passes), but the SELECT INTO at slot 0077 L1371..L1373 returns
-- NULL v_value, and Step 3 (L1375..L1378) raises WCG03 with the
-- "Unknown configuration key %" message. Proves the absent-row gate
-- fires separately from the namespace gate — both paths reach WCG03,
-- but via different branches.
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
SELECT throws_ok(
  $$SELECT public.admin_config_get_secret(
      'providers.nonexistent.credentials.api_key'::text
    )$$,
  'WCG03',
  NULL,
  'A9: admin admin_config_get_secret on absent secret key raises WCG03'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
