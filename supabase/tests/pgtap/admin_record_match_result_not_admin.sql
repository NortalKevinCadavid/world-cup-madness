-- Slice 006 / T010 / US1 / contracts/admin-rpcs.write.md. RED until T013 ships admin_record_match_result at on-disk slot 0064 per D-026.
--
-- Non-admin rejection path: alpha (participant, NOT in admin_roles) attempts
-- to call admin_record_match_result. Pre-flight step 1 (every admin RPC) MUST:
--   a) write an audit_log row with action='admin.access_denied', source='api_guard',
--      reason='not_admin', actor=alpha.participants.id (per slot 0073 narrow
--      INSERT policy + § Pre-flight steps in contracts/admin-rpcs.write.md);
--   b) RAISE EXCEPTION ERRCODE='WAR01' with MESSAGE='admin role required'.
--
-- AND match_results MUST NOT be mutated -- the rejection short-circuits before
-- the underlying record_match_result SP is invoked.
--
-- Fixture refs:
--   * alpha
--       participants.id  = 11111111-1111-1111-1111-111111111111
--       auth.users.id    = 00000000-0000-0000-0000-00000000000a
--       NO admin_roles row (T009 only seeds admin1)
--   * M1
--       matches.id       = eeee0050-0000-0000-0000-000000000001
--       match_results pre-state = home_score 2, away_score 1
--
-- ERRCODE assertion: pgTAP's throws_ok with the SQLSTATE form so the test is
-- robust against minor MESSAGE text drift in T013's implementation.

BEGIN;

SELECT plan(3);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs + snapshot M1's pre-state for the no-mutation assert.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t010_notadmin.alpha_pid', '11111111-1111-1111-1111-111111111111', false);
SELECT set_config('test.t010_notadmin.m1',        'eeee0050-0000-0000-0000-000000000001', false);

SELECT set_config(
  'test.t010_notadmin.m1_prestate',
  (SELECT ROW(home_score, away_score, home_score_for_scoring, away_score_for_scoring)::text
     FROM public.match_results
    WHERE match_id = current_setting('test.t010_notadmin.m1')::uuid),
  false
);

-- ---------------------------------------------------------------------------
-- Impersonate alpha (non-admin).
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: WAR01 ERRCODE raised. The exception MUST short-circuit BEFORE any
-- match_results mutation. throws_ok asserts on SQLSTATE (4th positional arg);
-- the message-match arg is intentionally permissive ('admin role required'
-- substring is the contract's spelled-out MESSAGE but T013 may add context).
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.admin_record_match_result(
      'eeee0050-0000-0000-0000-000000000001'::uuid,
      2, 2, 2, 2,
      'regulation',
      'FIFA decision',
      'https://fifa.example/m1'
    )$$,
  'WAR01',
  NULL,
  'A1 non-admin caller raises ERRCODE=WAR01 (admin role required)'
);

-- Drop back to superuser for the post-state asserts.
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: audit_log carries an admin.access_denied row scoped to alpha. The slot
-- 0073 narrow INSERT policy admits exactly this shape under the authenticated
-- role; the row was inserted in alpha's session BEFORE the WAR01 raise (and
-- the raise rolled back ITS work, but the audit row was written outside the
-- subtransaction the raise belongs to -- the admin RPC body documents that
-- the audit-then-raise is a savepoint/PERFORM pattern, so the audit row
-- survives the RAISE).
--
-- NOTE: if T013's implementation uses a single transaction where RAISE rolls
-- back the audit INSERT, this assertion will fail and T013 will need to
-- restructure (e.g. use a SECURITY DEFINER helper to write the audit row in
-- a subtransaction). The contract § Pre-flight steps explicitly requires
-- "write audit_log row ... AND RAISE EXCEPTION", implying the audit row
-- MUST persist past the raise.
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.access_denied'
       AND actor  = current_setting('test.t010_notadmin.alpha_pid')::uuid
       AND source = 'api_guard'
       AND reason = 'not_admin'
  ),
  'A2 audit_log carries admin.access_denied row for alpha with source=api_guard, reason=not_admin'
);

-- ---------------------------------------------------------------------------
-- A3: match_results NOT changed. The pre-state ROW signature MUST byte-match
-- the post-state ROW signature.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT ROW(home_score, away_score, home_score_for_scoring, away_score_for_scoring)::text
     FROM public.match_results
    WHERE match_id = current_setting('test.t010_notadmin.m1')::uuid),
  current_setting('test.t010_notadmin.m1_prestate'),
  'A3 match_results row for M1 UNCHANGED by rejected non-admin call'
);

SELECT * FROM finish();
ROLLBACK;
