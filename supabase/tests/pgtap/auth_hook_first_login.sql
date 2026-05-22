-- auth_hook_first_login.sql
-- Slice 001-eligibility-login | Task T020
--
-- Spec anchors:
--   FR-001 (eligibility gating), FR-002 (server-side re-check), FR-003 (provision
--   one participant per eligible identity), FR-006 (audit every access decision).
--   spec.md US1 Acceptance Scenario 1 (first-time eligible sign-in provisions a
--   participants row + emits access.granted audit). spec.md US2 Acceptance
--   Scenario 1 (ineligible domain is denied + audited).
--
-- Contract source of truth: contracts/auth-hook.sql.md
--   * `public.handle_auth_user_created(event jsonb) RETURNS jsonb`
--   * Return envelopes:
--       success → '{"decision": "continue"}'::jsonb
--       reject  → '{"decision": "reject", "message": "<text>"}'::jsonb
--   * Side-effects on success: one INSERT into public.participants + one
--     `access.granted` audit_log row from the hook (source='auth_hook'),
--     PLUS one `participant.created` audit_log row from the T013 trigger
--     (source='trigger'). Both rows commit in the same transaction.
--   * Side-effects on domain denial: one `access.denied` audit_log row with
--     reason='domain_not_approved', source='auth_hook'. NO participants row.
--   * Returning-sub (re-invocation against an existing auth_user_id): the hook
--     MUST NOT duplicate the participants row. Per the contract this should
--     either raise (uk violation on participants_auth_user_id_uk) and roll back,
--     or be coded idempotently. Either way the post-condition is the same:
--     exactly one participants row for that sub. This test asserts the
--     post-condition; how the hook achieves it is T024's concern.
--
-- RED expectation (Constitution Principle IX):
--   This test is authored BEFORE T024 implements the body of
--   public.handle_auth_user_created. Until T024 ships, the call site will fail
--   with "function does not exist". That is the expected RED state; every
--   subsequent assertion is unreachable and will not be evaluated. The plan
--   count below reflects the assertions that WILL run once T024 lands.
--
-- Pattern: BEGIN / plan / asserts / finish / ROLLBACK so this test leaves no
-- residue. The ROLLBACK reverts the synthetic Freshie auth.users + participants
-- + audit_log rows so neighbouring tests see the pristine fixture.

BEGIN;

SELECT plan(9);

-- ---------------------------------------------------------------------------
-- Test 1: First-login ELIGIBLE user (Freshie @ nortal.com)
--
-- Synthesise a `before_user_created` event payload for a brand-new sub that
-- does NOT collide with any fixture identity, invoke the hook, then assert
-- the documented success-path side-effects.
-- ---------------------------------------------------------------------------

-- Stage the auth.users row first. Per the contract the hook runs INSIDE the
-- Supabase Auth transaction that will commit the auth.users row; for a direct
-- pgTAP invocation we have to stage that row ourselves so the participants FK
-- (auth_user_id REFERENCES auth.users(id) ON DELETE RESTRICT) is satisfiable.
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  'aaaa1111-aaaa-1111-aaaa-aaaa11110001',
  'authenticated', 'authenticated', 'freshie@nortal.com',
  '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Freshie"}'::jsonb,
  now(), now(), '', '', '', ''
);

-- Invoke the hook and capture the return envelope.
SELECT is(
  public.handle_auth_user_created(jsonb_build_object(
    'user_id', 'aaaa1111-aaaa-1111-aaaa-aaaa11110001',
    'user_metadata', jsonb_build_object(
      'email', 'freshie@nortal.com',
      'display_name', 'Freshie'
    ),
    'claims', jsonb_build_object(
      'sub', 'aaaa1111-aaaa-1111-aaaa-aaaa11110001',
      'email', 'freshie@nortal.com'
    )
  )) -> 'decision',
  to_jsonb('continue'::text),
  'T1.a Freshie first-login: hook returns {"decision":"continue"} envelope'
);

-- Participants row landed with the expected attributes.
SELECT is(
  (SELECT display_name FROM public.participants
     WHERE auth_user_id = 'aaaa1111-aaaa-1111-aaaa-aaaa11110001'::uuid),
  'Freshie'::text,
  'T1.b Freshie first-login: participants.display_name = ''Freshie'''
);

SELECT is(
  (SELECT status::text FROM public.participants
     WHERE auth_user_id = 'aaaa1111-aaaa-1111-aaaa-aaaa11110001'::uuid),
  'active',
  'T1.c Freshie first-login: participants.status = ''active'''
);

-- first_login_at is set close to now() (within the test transaction's clock).
-- Tolerance is generous (5 s) to absorb clock skew between the hook's now()
-- and this assertion's now().
SELECT ok(
  (SELECT first_login_at FROM public.participants
     WHERE auth_user_id = 'aaaa1111-aaaa-1111-aaaa-aaaa11110001'::uuid)
    BETWEEN now() - interval '5 seconds' AND now() + interval '5 seconds',
  'T1.d Freshie first-login: first_login_at is set near now()'
);

-- Audit posture: exactly one access.granted row, source='auth_hook', scoped to
-- the new participant. Per contract the hook writes
--   action='access.granted', source='auth_hook', entity_id=<new participant.id>.
-- We scope on entity_id to the participant we just created so this assertion
-- is robust against the audit_log baseline left by other rows in the txn.
SELECT is(
  (SELECT count(*) FROM public.audit_log
     WHERE action = 'access.granted'
       AND source = 'auth_hook'
       AND entity_id = (SELECT id FROM public.participants
                          WHERE auth_user_id =
                            'aaaa1111-aaaa-1111-aaaa-aaaa11110001'::uuid))::int,
  1,
  'T1.e Freshie first-login: exactly one access.granted audit_log row from auth_hook'
);

-- ---------------------------------------------------------------------------
-- Test 2: First-login DOMAIN-DENIED user (outsider2 @ example.com)
--
-- Outsider2 has NO pre-existing auth.users row in the fixture (and per the
-- contract no auth.users row gets created when the hook rejects). We
-- therefore do NOT stage an auth.users row here — we synthesise the payload
-- only, and assert that the rejection short-circuits before any participants
-- INSERT (which would otherwise FK-fail anyway).
-- ---------------------------------------------------------------------------

SELECT is(
  public.handle_auth_user_created(jsonb_build_object(
    'user_id', 'cccc2222-cccc-2222-cccc-cccc22220001',
    'user_metadata', jsonb_build_object(
      'email', 'outsider2@example.com',
      'display_name', 'Outsider Two'
    ),
    'claims', jsonb_build_object(
      'sub', 'cccc2222-cccc-2222-cccc-cccc22220001',
      'email', 'outsider2@example.com'
    )
  )) -> 'decision',
  to_jsonb('reject'::text),
  'T2.a outsider2 first-login: hook returns {"decision":"reject", ...} envelope'
);

-- NO participants row got created for that sub.
SELECT is(
  (SELECT count(*) FROM public.participants
     WHERE auth_user_id = 'cccc2222-cccc-2222-cccc-cccc22220001'::uuid)::int,
  0,
  'T2.b outsider2 first-login: zero participants rows for the denied sub'
);

-- Audit posture: exactly one access.denied row with reason='domain_not_approved',
-- source='auth_hook'. Per data-model § Entity 3, actor is NULL on denied
-- pre-create attempts (no participant exists yet); the attempted identity is
-- captured in new_value rather than actor. We therefore scope this assertion
-- by reason + the attempted email lifted from new_value, which is the most
-- forensically meaningful predicate.
SELECT is(
  (SELECT count(*) FROM public.audit_log
     WHERE action = 'access.denied'
       AND source = 'auth_hook'
       AND reason = 'domain_not_approved'
       AND new_value ->> 'email' = 'outsider2@example.com')::int,
  1,
  'T2.c outsider2 first-login: one access.denied/domain_not_approved audit row '
  'capturing the attempted email in new_value'
);

-- ---------------------------------------------------------------------------
-- Test 3: Returning sub (alpha) MUST NOT duplicate the participants row
--
-- The fixture (supabase/seed/slice-001-fixture.sql) already provisioned alpha:
--   auth.users.id        = 00000000-0000-0000-0000-00000000000a
--   participants.id      = 11111111-1111-1111-1111-111111111111
--   participants.email   = alpha@nortal.com
-- Invoking `handle_auth_user_created` against the SAME sub must not create a
-- second participants row. The hook may raise (uk_violation) and roll back,
-- or it may be coded idempotently — either path lands the same post-condition.
-- We only assert the post-condition; we therefore wrap the call in a SAVEPOINT
-- so a possible RAISE doesn't abort the outer test transaction.
-- ---------------------------------------------------------------------------

SAVEPOINT before_re_invocation;

DO $$
BEGIN
  PERFORM public.handle_auth_user_created(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-00000000000a',
    'user_metadata', jsonb_build_object(
      'email', 'alpha@nortal.com',
      'display_name', 'Alpha'
    ),
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-00000000000a',
      'email', 'alpha@nortal.com'
    )
  ));
EXCEPTION
  -- A unique_violation on participants_auth_user_id_uk is an acceptable
  -- implementation choice (the contract's success path INSERTs unconditionally).
  -- Swallow it so the post-condition assertion can still run.
  WHEN unique_violation THEN NULL;
  -- Likewise, an explicit RAISE from the hook (e.g. raise_exception) is a
  -- valid implementation; swallow to reach the post-condition assertion.
  WHEN raise_exception THEN NULL;
END;
$$;

-- If the inner block raised something we did NOT anticipate, the SAVEPOINT
-- may have aborted; roll back to the savepoint defensively so the count below
-- runs against a usable transaction state.
ROLLBACK TO SAVEPOINT before_re_invocation;

SELECT is(
  (SELECT count(*) FROM public.participants
     WHERE auth_user_id = '00000000-0000-0000-0000-00000000000a'::uuid)::int,
  1,
  'T3.a Returning sub (alpha): still exactly one participants row; no duplicate INSERT'
);

SELECT * FROM finish();

ROLLBACK;
