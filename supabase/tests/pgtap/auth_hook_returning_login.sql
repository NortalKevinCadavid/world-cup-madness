-- auth_hook_returning_login.sql
-- Slice 001-eligibility-login | Task T037
--
-- Spec anchors:
--   FR-002 (server-side re-verification on every authenticated request),
--   FR-004 (refresh existing participant's mutable profile attributes on
--   subsequent eligible sign-ins without creating duplicates and without
--   altering the participant identifier),
--   FR-006 (audit every access decision),
--   FR-008 (fail closed when eligibility data is unavailable),
--   FR-009 (do not capture identity attributes outside the FR-003 list).
--
--   spec.md US3 Acceptance Scenarios 1-3:
--     - display_name refresh in place (no new participant.id)
--     - newly-available region populated
--     - missing region claim does NOT clear stored value
--
--   spec.md Clarifications 2026-05-15:
--     - Q2: returning-login email-drift handling — audit `participant.email_drift`,
--       keep stored email as source of truth, do NOT overwrite participants.email.
--     - Q4: missing optional claim (e.g. region) on returning login MUST be
--       treated as "no signal" and MUST NOT clear / null / modify the stored value.
--
--   research.md § R-010 (refresh whitelist: display_name + region only, never
--   email; email-drift detection emits a separate audit row).
--
--   contracts/auth-hook.sql.md § handle_auth_user_signed_in + § Decision matrix:
--   Approved + returning + active   → continue, audit `access.granted`
--   Approved + returning + drift    → continue, audit `participant.email_drift` + `access.granted`
--   Approved + returning + deactivated → reject, audit `access.denied` (reason='deactivated')
--   Domain removed + returning      → reject, audit `access.denied` (reason='domain_not_approved')
--
-- ---------------------------------------------------------------------------
-- Deviation note (D-001 / D-005)
-- ---------------------------------------------------------------------------
-- The spec contract pins the hook return envelope to
--   success → '{"decision":"continue"}'
--   reject  → '{"decision":"reject","message":"<text>"}'
-- BUT the function is wired via the Supabase `[auth.hook.custom_access_token]`
-- hook key (see D-001 in tasks.md). The custom_access_token hook contract is:
--   INPUT  : { user_id, claims: { sub, email, role, aal, amr, session_id,
--              user_metadata: {...}, app_metadata: {...} }, authentication_method }
--   OUTPUT (success): jsonb_build_object('claims', event->'claims')
--                     — return the claims object (optionally mutated)
--   OUTPUT (reject) : jsonb_build_object('error',
--                       jsonb_build_object('http_code', 403, 'message', '<reason>'))
--
-- T040 will implement to this shape. Per D-005 (recorded in tasks.md just
-- above D-004), this RED test is authored against the `custom_access_token`
-- envelope so it goes GREEN when T040 ships. The legacy `{decision}` envelope
-- documented in the contract markdown is superseded by D-001 + D-005; the
-- contract file will be reconciled when next opened.
--
-- RED expectation (Constitution Principle IX):
--   public.handle_auth_user_signed_in(event jsonb) does NOT yet exist (T040
--   implements it). Every assertion below will fail with "function does not
--   exist" until T040 lands. That is the expected RED state.
--
-- Pattern: BEGIN / plan / asserts / finish / ROLLBACK. Each scenario is
-- wrapped in its own SAVEPOINT / ROLLBACK TO SAVEPOINT so that the side
-- effects of one scenario (e.g. config DELETE in S5, participant UPDATE in
-- S1) do not leak into the next. The outer ROLLBACK ensures the fixture is
-- pristine for any subsequent test file.

BEGIN;

SELECT plan(15);

-- ===========================================================================
-- Scenario 1: Returning approved alpha — refresh display_name + last_login_at
-- ===========================================================================
-- Fixture (slice-001-fixture.sql):
--   alpha auth.users.id   = 00000000-0000-0000-0000-00000000000a
--         participants.id = 11111111-1111-1111-1111-111111111111
--         email='alpha@nortal.com', display_name='Alpha', region='EE-North',
--         status='active', last_login_at='2026-04-01T10:00:00Z'.
--
-- The hook receives a custom_access_token event whose claims carry an
-- UPDATED display_name ('Alpha Tester Updated'). Per R-010 the hook MUST
-- update display_name in place (no new participant.id, no duplicate row)
-- and advance last_login_at; the T013 trigger emits `participant.updated`
-- automatically because the row IS DISTINCT FROM its prior state.

SAVEPOINT s1_returning_refresh;

-- S1.a: hook returns the custom_access_token success envelope.
--   On success the function returns jsonb_build_object('claims', ...)
--   — `result ? 'claims'` is true and `result ? 'error'` is false.
-- IMPORTANT: invoke the hook EXACTLY ONCE here. The result is captured into
-- a temp table so the subsequent participant + audit assertions below
-- observe the single-invocation state (a second call would emit a second
-- participant.updated trigger row and break S1.f).
CREATE TEMP TABLE s1_hook_result ON COMMIT DROP AS
SELECT public.handle_auth_user_signed_in(jsonb_build_object(
  'user_id', '00000000-0000-0000-0000-00000000000a'::text,
  'claims', jsonb_build_object(
    'sub', '00000000-0000-0000-0000-00000000000a',
    'email', 'alpha@nortal.com',
    'role', 'authenticated',
    'aal', 'aal1',
    'session_id', '11111111-aaaa-1111-aaaa-111111111111',
    'user_metadata', jsonb_build_object(
      'name', 'Alpha Tester Updated',
      'display_name', 'Alpha Tester Updated',
      'region', 'EE-North'
    ),
    'app_metadata', jsonb_build_object('provider', 'email')
  ),
  'authentication_method', 'oauth'
)) AS result;

SELECT ok(
  (SELECT (result ? 'claims') AND NOT (result ? 'error') FROM s1_hook_result),
  'S1.a returning alpha: hook returns custom_access_token success envelope '
  '(has ''claims'' key, no ''error'' key)'
);

-- S1.b: still exactly one participants row for alpha (no duplicate INSERT;
-- FR-004 anti-duplication).
SELECT is(
  (SELECT count(*) FROM public.participants
     WHERE auth_user_id = '00000000-0000-0000-0000-00000000000a'::uuid)::int,
  1,
  'S1.b returning alpha: exactly one participants row (no duplicate)'
);

-- S1.c: display_name updated in place (FR-004, R-010 refresh whitelist).
SELECT is(
  (SELECT display_name FROM public.participants
     WHERE auth_user_id = '00000000-0000-0000-0000-00000000000a'::uuid),
  'Alpha Tester Updated'::text,
  'S1.c returning alpha: display_name refreshed in place to ''Alpha Tester Updated'''
);

-- S1.d: last_login_at advanced past the seed pin (US1.2: "last_login_at MUST
-- be updated to the current server time"). Seed pinned last_login_at to
-- 2026-04-01T10:00:00Z; the hook MUST move it forward.
SELECT ok(
  (SELECT last_login_at FROM public.participants
     WHERE auth_user_id = '00000000-0000-0000-0000-00000000000a'::uuid)
    > '2026-04-01T10:00:00Z'::timestamptz,
  'S1.d returning alpha: last_login_at advanced past seed pin (2026-04-01T10:00:00Z)'
);

-- S1.e: hook wrote exactly one access.granted audit row for alpha
-- (source='auth_hook', actor=alpha's participants.id). The audit_log
-- baseline is empty per the fixture (no direct INSERTs); any rows present
-- come from this transaction.
SELECT is(
  (SELECT count(*) FROM public.audit_log
     WHERE action = 'access.granted'
       AND source = 'auth_hook'
       AND actor = '11111111-1111-1111-1111-111111111111'::uuid)::int,
  1,
  'S1.e returning alpha: exactly one access.granted/auth_hook audit row '
  'attributed to alpha''s participants.id'
);

-- S1.f: T013 trigger emitted `participant.updated` automatically because
-- display_name (and last_login_at) changed. source='trigger' — distinct from
-- the access.granted row's source='auth_hook'. Scoping the predicate on
-- the participants.id (entity_id) keeps the assertion robust against rows
-- emitted for other personas in the same txn.
SELECT is(
  (SELECT count(*) FROM public.audit_log
     WHERE action = 'participant.updated'
       AND source = 'trigger'
       AND entity_id = '11111111-1111-1111-1111-111111111111'::uuid)::int,
  1,
  'S1.f returning alpha: trigger emitted one participant.updated audit row'
);

ROLLBACK TO SAVEPOINT s1_returning_refresh;

-- ===========================================================================
-- Scenario 2: Email drift — stored email unchanged, drift event written
-- ===========================================================================
-- Clarifications 2026-05-15 Q2 + R-010: IdP-provided email differs from
-- stored email → audit `participant.email_drift`, keep stored email as
-- source of truth, do NOT overwrite participants.email. The hook still
-- returns success (the drift is a flag for admin review, not a denial).

SAVEPOINT s2_email_drift;

-- S2.a: hook returns success envelope despite the email mismatch.
SELECT ok(
  (
    public.handle_auth_user_signed_in(jsonb_build_object(
      'user_id', '00000000-0000-0000-0000-00000000000a'::text,
      'claims', jsonb_build_object(
        'sub', '00000000-0000-0000-0000-00000000000a',
        'email', 'alpha-aka@nortal.com',
        'role', 'authenticated',
        'user_metadata', jsonb_build_object(
          'display_name', 'Alpha',
          'region', 'EE-North',
          'email', 'alpha-aka@nortal.com'
        ),
        'app_metadata', jsonb_build_object('provider', 'email')
      ),
      'authentication_method', 'oauth'
    )) ? 'claims'
  ),
  'S2.a email drift: hook returns success envelope (claims, no error) — '
  'drift is audited, not a denial'
);

-- S2.b: stored email is UNCHANGED. The hook MUST NOT overwrite
-- participants.email even when the IdP claims differ (account-takeover guard).
SELECT is(
  (SELECT email::text FROM public.participants
     WHERE auth_user_id = '00000000-0000-0000-0000-00000000000a'::uuid),
  'alpha@nortal.com',
  'S2.b email drift: stored participants.email unchanged (still alpha@nortal.com)'
);

-- S2.c: exactly one participant.email_drift audit row capturing both the
-- stored email (previous_value) and the IdP-provided email (new_value).
-- Per R-010 the drift row is distinct from the access.granted row.
SELECT is(
  (SELECT count(*) FROM public.audit_log
     WHERE action = 'participant.email_drift'
       AND previous_value ->> 'email' = 'alpha@nortal.com'
       AND new_value      ->> 'email' = 'alpha-aka@nortal.com')::int,
  1,
  'S2.c email drift: one participant.email_drift audit row captures '
  'stored email (previous_value) and IdP email (new_value)'
);

ROLLBACK TO SAVEPOINT s2_email_drift;

-- ===========================================================================
-- Scenario 3: Missing region claim — stored region preserved
-- ===========================================================================
-- Clarifications 2026-05-15 Q4 + US3.3: a missing optional claim on returning
-- login MUST be treated as "no signal" — the hook MUST NOT clear, null, or
-- otherwise modify the stored region. The seed pins alpha.region='EE-North'.

SAVEPOINT s3_missing_region;

-- S3.a: hook returns success envelope.
SELECT ok(
  (
    public.handle_auth_user_signed_in(jsonb_build_object(
      'user_id', '00000000-0000-0000-0000-00000000000a'::text,
      'claims', jsonb_build_object(
        'sub', '00000000-0000-0000-0000-00000000000a',
        'email', 'alpha@nortal.com',
        'role', 'authenticated',
        -- user_metadata intentionally omits `region`. Per Q4 the stored
        -- value must survive untouched.
        'user_metadata', jsonb_build_object(
          'display_name', 'Alpha'
        ),
        'app_metadata', jsonb_build_object('provider', 'email')
      ),
      'authentication_method', 'oauth'
    )) ? 'claims'
  ),
  'S3.a missing region: hook returns success envelope'
);

-- S3.b: stored region UNCHANGED ('EE-North' per the seed).
SELECT is(
  (SELECT region FROM public.participants
     WHERE auth_user_id = '00000000-0000-0000-0000-00000000000a'::uuid),
  'EE-North'::text,
  'S3.b missing region: stored region preserved (still ''EE-North'') — '
  'missing claim is not a delete signal (Clarifications Q4)'
);

ROLLBACK TO SAVEPOINT s3_missing_region;

-- ===========================================================================
-- Scenario 4: Deactivated participant — reject with http_code=403
-- ===========================================================================
-- Decision matrix: Approved domain + returning + status='deactivated' →
-- reject; audit `access.denied` (reason='deactivated'). spec.md edge case E-6
-- + Clarifications Q3 (deactivated-status mid-session denial).
--
-- Fixture: zulu auth.users.id=…000d, participants.id=…999, status='deactivated'.

SAVEPOINT s4_deactivated;

-- S4.a: hook returns the custom_access_token reject envelope. The contract:
--   { "error": { "http_code": 403, "message": "<reason>" } }
-- We assert (a) `error` key present, (b) `claims` key absent, (c)
-- error.http_code = 403, (d) error.message references deactivation in some
-- form (case-insensitive match on 'deactivat' covers 'deactivated' /
-- 'deactivation').
SELECT ok(
  (
    WITH r AS (
      SELECT public.handle_auth_user_signed_in(jsonb_build_object(
        'user_id', '00000000-0000-0000-0000-00000000000d'::text,
        'claims', jsonb_build_object(
          'sub', '00000000-0000-0000-0000-00000000000d',
          'email', 'zulu@nortal.com',
          'role', 'authenticated',
          'user_metadata', jsonb_build_object(
            'display_name', 'Zulu Deactivated'
          ),
          'app_metadata', jsonb_build_object('provider', 'email')
        ),
        'authentication_method', 'oauth'
      )) AS result
    )
    SELECT (result ? 'error')
       AND NOT (result ? 'claims')
       AND (result -> 'error' ->> 'http_code') = '403'
       AND (lower(result -> 'error' ->> 'message') LIKE '%deactivat%')
    FROM r
  ),
  'S4.a deactivated zulu: hook returns reject envelope '
  '({error:{http_code:403, message:~deactivat*}}, no claims)'
);

-- S4.b: hook wrote exactly one access.denied row with reason='deactivated',
-- source='auth_hook', attributing the attempt to zulu (either via actor =
-- zulu's participants.id, or via new_value->>'user_id' = zulu's auth uuid —
-- both are valid forensic attributions per the contract). We allow either.
SELECT is(
  (SELECT count(*) FROM public.audit_log
     WHERE action = 'access.denied'
       AND source = 'auth_hook'
       AND reason = 'deactivated'
       AND (
         actor = '99999999-9999-9999-9999-999999999999'::uuid
         OR new_value ->> 'user_id' = '00000000-0000-0000-0000-00000000000d'
       ))::int,
  1,
  'S4.b deactivated zulu: one access.denied/auth_hook/deactivated audit row '
  'attributed to zulu'
);

ROLLBACK TO SAVEPOINT s4_deactivated;

-- ===========================================================================
-- Scenario 5: Domain removed since last login — reject
-- ===========================================================================
-- Decision matrix: Approved domain newly removed + returning eligible →
-- reject; audit `access.denied` (reason='domain_not_approved'). FR-007 +
-- spec.md edge case E-3 (mid-tournament domain removal — existing predictions
-- preserved, next request denied).
--
-- We DELETE the tournament_config eligibility row to simulate the removal;
-- the SAVEPOINT/ROLLBACK restores it before any subsequent assertion. Per
-- R-007 the hook fails closed when the config is unavailable.

SAVEPOINT s5_domain_removed;

DELETE FROM public.tournament_config
 WHERE key = 'eligibility.approved_domains';

-- S5.a: hook returns reject envelope with http_code=403 and a message that
-- references domain eligibility (case-insensitive 'domain' / 'approved' /
-- 'nortal' — any of those would be acceptable wording per the contract's
-- standardised denial message).
SELECT ok(
  (
    WITH r AS (
      SELECT public.handle_auth_user_signed_in(jsonb_build_object(
        'user_id', '00000000-0000-0000-0000-00000000000a'::text,
        'claims', jsonb_build_object(
          'sub', '00000000-0000-0000-0000-00000000000a',
          'email', 'alpha@nortal.com',
          'role', 'authenticated',
          'user_metadata', jsonb_build_object(
            'display_name', 'Alpha',
            'region', 'EE-North'
          ),
          'app_metadata', jsonb_build_object('provider', 'email')
        ),
        'authentication_method', 'oauth'
      )) AS result
    )
    SELECT (result ? 'error')
       AND NOT (result ? 'claims')
       AND (result -> 'error' ->> 'http_code') = '403'
       AND (lower(result -> 'error' ->> 'message')
              ~ '(domain|approved|nortal|restricted)')
    FROM r
  ),
  'S5.a domain removed: hook returns reject envelope '
  '({error:{http_code:403, message:~domain*}}, no claims)'
);

-- S5.b: hook wrote exactly one access.denied row with
-- reason='domain_not_approved', source='auth_hook'. Per the contract the
-- actor MAY be alpha's participants.id (the participant exists, the hook
-- could look it up) or NULL (the hook denied before looking up). Either
-- attribution is acceptable; the load-bearing assertions are action + source
-- + reason.
SELECT is(
  (SELECT count(*) FROM public.audit_log
     WHERE action = 'access.denied'
       AND source = 'auth_hook'
       AND reason = 'domain_not_approved')::int,
  1,
  'S5.b domain removed: one access.denied/auth_hook/domain_not_approved audit row'
);

ROLLBACK TO SAVEPOINT s5_domain_removed;

SELECT * FROM finish();

ROLLBACK;
