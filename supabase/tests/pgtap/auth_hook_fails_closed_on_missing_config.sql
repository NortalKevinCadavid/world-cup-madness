-- auth_hook_fails_closed_on_missing_config.sql
-- Slice 001-eligibility-login | Task T038
--
-- Spec anchors:
--   FR-008 (system MUST fail closed when eligibility configuration is
--   unavailable). spec.md § Edge Cases E-5 ("user attempts to sign in while
--   the application's domain configuration store is temporarily unreachable
--   → access MUST be denied by default (fail-closed), not granted").
--   spec.md § Clarifications 2026-05-15 (Q1 status enum; Q3 mid-session
--   deny rule -- fail-closed is the same decision rule applied to the
--   "config row missing" sub-case).
--
-- Contract source of truth: contracts/auth-hook.sql.md § Decision matrix
--   row "Config unreachable" → reject + audit access.denied (reason value
--   tolerated as either 'config_unavailable' or the collapsed
--   'domain_not_approved' per is_approved_domain's fail-closed COALESCE
--   path -- T024's implementation collapses both into a single
--   'domain_not_approved' reason because the eligibility predicate
--   returns false in both cases. See research.md § R-007 (last paragraph)
--   for the design rationale).
--
-- Dual-hook split (tasks.md § Implementation deviations D-001 + D-005):
--   * `handle_auth_user_created`  binds to Supabase Auth's
--     `before_user_created` hook key. RETURN ENVELOPE = `{decision,
--     message}`. Reject path returns `{"decision":"reject","message":...}`.
--     This is the shape covered by Scenarios 1 and 3 below.
--
--   * `handle_auth_user_signed_in` binds to Supabase Auth's
--     `custom_access_token` hook key (D-001). RETURN ENVELOPE =
--     `{claims}` on accept, `{error: {http_code, message}}` on reject
--     (D-005). This is the shape covered by Scenario 2 below.
--
--   The asymmetry is deliberate -- Supabase Auth interprets each hook
--   key's return value differently. Returning `{decision}` from
--   `custom_access_token` would be silently ignored (admitting a reject);
--   returning `{claims}` from `before_user_created` likewise would not
--   block sign-up. Tests MUST assert the shape that matches each hook's
--   binding, not the contract document's pre-D-001/D-005 unified shape.
--
-- RED expectations (Constitution Principle IX):
--   Scenario 1 (handle_auth_user_created + missing config row):
--     T024 already ships the function with fail-closed semantics built in
--     (is_approved_domain returns false on missing config row via
--     COALESCE). GREEN against current code.
--   Scenario 2 (handle_auth_user_signed_in + missing config row):
--     T040 has NOT yet shipped. The function does not exist. RED until
--     T040 lands -- the DO-block raise-handler swallows the
--     undefined_function exception so post-condition assertions still
--     execute against a usable transaction state.
--   Scenario 3 (handle_auth_user_created + empty approved_domains array):
--     Same as Scenario 1 -- T024's reject branch fires on
--     is_approved_domain returning false against an empty jsonb array.
--     GREEN against current code.
--
-- Pattern: BEGIN / plan / asserts / finish / ROLLBACK so the test leaves
-- no residue. SAVEPOINTs delimit each scenario so a config DELETE or an
-- expected raise from a missing function does not bleed across scenarios.

BEGIN;

SELECT plan(8);

-- ===========================================================================
-- Scenario 1 -- handle_auth_user_created with NO config row
--
-- Pre-state: DELETE the tournament_config row for
-- 'eligibility.approved_domains'. is_approved_domain() then COALESCEs to
-- false for every input, so the hook's domain-check branch fires and
-- returns a reject envelope.
-- ===========================================================================

SAVEPOINT scenario_1;

DELETE FROM public.tournament_config
 WHERE key = 'eligibility.approved_domains';

-- Capture the hook's return envelope (kept in a temp table so we can issue
-- multiple is()/ok() assertions against the SAME invocation without
-- replaying the function call, which would also write a second audit row).
CREATE TEMP TABLE t_scenario_1_result (
  result jsonb
) ON COMMIT DROP;

INSERT INTO t_scenario_1_result (result)
SELECT public.handle_auth_user_created(jsonb_build_object(
  'user_id', 'aaaa1111-aaaa-1111-aaaa-aaaa11110099',
  'user_metadata', jsonb_build_object(
    'email', 'newuser@nortal.com',
    'name',  'NewUser'
  )
));

-- 1.1 Reject envelope: `{decision: reject, ...}` per T024's contract.
SELECT is(
  (SELECT result ->> 'decision' FROM t_scenario_1_result),
  'reject',
  'S1.a handle_auth_user_created with no config row returns decision=reject'
);

-- 1.2 The message references the eligibility / domain / config story.
-- T024 emits 'domain not approved' for the collapsed fail-closed branch
-- (research § R-007); a future T024 hardening could emit 'configuration
-- unavailable' instead. The assertion tolerates either wording.
SELECT ok(
  (SELECT result ->> 'message' FROM t_scenario_1_result)
    ~* '(config|unavail|domain)',
  'S1.b reject message references config / unavailable / domain'
);

-- 1.3 No participants row was created for the freshly-synthesised uuid.
-- The reject branch short-circuits BEFORE the INSERT, so the post-condition
-- is zero rows even though the auth.users row also does not exist (the
-- contract notes Supabase Auth would have prevented its creation too).
SELECT is(
  (SELECT count(*) FROM public.participants
     WHERE auth_user_id = 'aaaa1111-aaaa-1111-aaaa-aaaa11110099'::uuid)::int,
  0,
  'S1.c handle_auth_user_created rejected → zero participants rows for uuid'
);

ROLLBACK TO SAVEPOINT scenario_1;

-- ===========================================================================
-- Scenario 2 -- handle_auth_user_signed_in with NO config row
--
-- Pre-state: DELETE the tournament_config row again (the previous
-- ROLLBACK TO SAVEPOINT reverted Scenario 1's DELETE).
--
-- Per D-005 the returning-login hook is wired to `custom_access_token`,
-- which mandates a different return envelope (`{claims}` on accept,
-- `{error: {http_code, message}}` on reject). The fixture for alpha
-- (auth.users.id 00000000-0000-0000-0000-00000000000a; participants.id
-- 11111111-1111-1111-1111-111111111111) provides the existing-user
-- starting state.
--
-- T040 ships the function body; until then the SELECT below raises
-- undefined_function and we swallow it so the post-condition assertions
-- (no last_login_at update + audit row written) still get a chance to
-- run. Both post-conditions will currently fail in this RED state
-- because no function = no audit write and no last_login_at update;
-- that's the expected RED.
-- ===========================================================================

SAVEPOINT scenario_2;

DELETE FROM public.tournament_config
 WHERE key = 'eligibility.approved_domains';

-- Snapshot alpha's last_login_at BEFORE the invocation so we can assert
-- it is unchanged after a rejected sign-in attempt.
CREATE TEMP TABLE t_scenario_2_pre (
  last_login_at timestamptz
) ON COMMIT DROP;

INSERT INTO t_scenario_2_pre (last_login_at)
SELECT last_login_at
  FROM public.participants
 WHERE auth_user_id = '00000000-0000-0000-0000-00000000000a'::uuid;

CREATE TEMP TABLE t_scenario_2_result (
  result jsonb
) ON COMMIT DROP;

-- Wrap the call so a missing-function RED state doesn't abort the
-- outer transaction. On RED, t_scenario_2_result stays empty.
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.handle_auth_user_signed_in(jsonb_build_object(
    'user_id',                '00000000-0000-0000-0000-00000000000a',
    'claims',                 jsonb_build_object(
      'sub',           '00000000-0000-0000-0000-00000000000a',
      'email',         'alpha@nortal.com',
      'user_metadata', jsonb_build_object('name', 'Alpha Tester')
    ),
    'authentication_method',  'oauth'
  ));
  INSERT INTO t_scenario_2_result (result) VALUES (v_result);
EXCEPTION
  -- RED state: the function doesn't exist yet (T040). Swallow so the
  -- post-condition assertions below can still execute meaningfully.
  WHEN undefined_function THEN NULL;
  -- A future hardening of T040 may raise on missing config; the
  -- contract says it should reject (return), not raise. We tolerate both
  -- here so the test transitions cleanly from RED to GREEN.
  WHEN OTHERS THEN NULL;
END;
$$;

-- 2.1 Reject envelope: `{error}` key present (custom_access_token shape).
-- RED until T040 lands: t_scenario_2_result is empty so the subquery
-- returns NULL, ` ? 'error' ` returns NULL, ` IS TRUE ` is false.
SELECT ok(
  (SELECT result ? 'error' FROM t_scenario_2_result) IS TRUE,
  'S2.a handle_auth_user_signed_in reject envelope has "error" key (D-005)'
);

-- 2.2 The error envelope's http_code is 403 (per D-005 / R-007 fail-closed).
SELECT is(
  (SELECT result -> 'error' ->> 'http_code' FROM t_scenario_2_result),
  '403',
  'S2.b reject envelope error.http_code = "403"'
);

-- 2.3 Alpha's last_login_at MUST be unchanged on reject (no side-effect).
-- Comparing the post-invocation value to the snapshot taken pre-invocation
-- guards against any UPDATE that may have slipped past the reject branch.
SELECT is(
  (SELECT last_login_at FROM public.participants
     WHERE auth_user_id = '00000000-0000-0000-0000-00000000000a'::uuid),
  (SELECT last_login_at FROM t_scenario_2_pre),
  'S2.c rejected sign-in does NOT advance alpha.last_login_at'
);

-- 2.4 Exactly one access.denied audit row was written for this attempt
-- with source='auth_hook' and a fail-closed reason (either
-- 'domain_not_approved' or 'config_unavailable' -- the test tolerates
-- both because T040 may collapse them the way T024 does, or surface
-- 'config_unavailable' explicitly as the contract suggests). RED until
-- T040 lands and writes the row.
SELECT is(
  (SELECT count(*) FROM public.audit_log
     WHERE action = 'access.denied'
       AND source = 'auth_hook'
       AND reason IN ('domain_not_approved', 'config_unavailable'))::int,
  1,
  'S2.d one access.denied / auth_hook audit row written on reject'
);

ROLLBACK TO SAVEPOINT scenario_2;

-- ===========================================================================
-- Scenario 3 -- handle_auth_user_created with an EMPTY approved_domains array
--
-- Pre-state: UPDATE tournament_config so the value is the empty jsonb
-- array `[]`. is_approved_domain() returns false for every input
-- (jsonb_array_elements_text over `[]` yields zero rows, EXISTS = false).
-- The hook's reject branch fires with reason='domain_not_approved' -- the
-- canonical reason value per the contract's Decision matrix.
-- ===========================================================================

SAVEPOINT scenario_3;

UPDATE public.tournament_config
   SET value = '[]'::jsonb
 WHERE key = 'eligibility.approved_domains';

CREATE TEMP TABLE t_scenario_3_result (
  result jsonb
) ON COMMIT DROP;

INSERT INTO t_scenario_3_result (result)
SELECT public.handle_auth_user_created(jsonb_build_object(
  'user_id', 'aaaa1111-aaaa-1111-aaaa-aaaa1111009b',
  'user_metadata', jsonb_build_object(
    'email', 'newuser@nortal.com',
    'name',  'NewUser'
  )
));

-- 3.1 Reject envelope.
SELECT is(
  (SELECT result ->> 'decision' FROM t_scenario_3_result),
  'reject',
  'S3.a empty approved_domains array → decision=reject'
);

-- 3.2 The reject message references the domain story (T024 emits
-- 'domain not approved'). Tolerates 'domain' OR 'approved' OR 'eligible'
-- so a future message wording refresh does not break the test.
SELECT ok(
  (SELECT result ->> 'message' FROM t_scenario_3_result)
    ~* '(domain|approv|eligib)',
  'S3.b reject message references domain not approved'
);

ROLLBACK TO SAVEPOINT scenario_3;

SELECT * FROM finish();

ROLLBACK;
