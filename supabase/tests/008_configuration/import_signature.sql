-- import_signature.sql
-- Slice 008 Tournament Configuration | Task T058 | US6 (Cross-environment import)
--
-- Spec anchors:
--   spec.md § US6 -- "Admin imports a signed configuration envelope exported
--   from another environment." The import RPC (admin_config_import) MUST
--   refuse to apply any envelope whose HMAC-SHA256 signature does not match
--   a recomputation over the envelope body (envelope - 'signature'), and MUST
--   refuse any envelope whose schema_version is not the one this build knows
--   how to handle. Both refusals MUST raise WCG08 (cross-environment import
--   error code) so the dashboard surfaces an "Import refused: signature/
--   schema mismatch" toast (T021) rather than a generic database error.
--
-- Contract source of truth:
--   contracts/config-import.write.md § Behavior -- admin_config_import:
--     - Step 1: is_admin gate -- exercised by T058's sibling tests, not here.
--     - Step 2: reason required (WCG02) -- not exercised here.
--     - Step 3: schema_version must equal '1.0.0' (slot 0077 L2095..L2100).
--         WCG08 on miss. FIRES BEFORE signature verification per Step 4.
--     - Step 4: signature presence + HMAC match (slot 0077 L2102..L2121).
--         WCG08 on missing 'signature' field OR HMAC mismatch.
--     - Step 5: per-key validation aggregate (WCG08 on any failures).
--     - Steps 6-7: audit row + versions + tournament_config bulk apply.
--
-- Implementation reference: supabase/migrations/0077_configuration.sql §
-- T052 admin_config_export (L1918..L2022) and § T053 admin_config_import
-- (L2041..L2254). Both rely on `extensions.hmac(body::text::bytea,
-- secret::bytea, 'sha256')` over `(envelope - 'signature')::text`; the test
-- exercises the contract that body-tampering invalidates the HMAC without
-- ever touching the signature field itself.
--
-- GUC dependency:
--   `app.config_export_secret` must be visible to BOTH the export RPC (Step 2
--   of T052) AND the import RPC (Step 4 of T053). We SET LOCAL the GUC inside
--   the BEGIN/COMMIT block so both calls see the same value. The literal
--   value is a synthetic test secret -- it does NOT need to match the
--   production secret because the test rolls back. T075 (runbook) wires the
--   production secret via the Supabase project's env vars.
--
-- GREEN-by-design: T052 (admin_config_export) and T053 (admin_config_import)
-- both shipped in slot 0077; T058 is the signature-gate regression test.
-- All assertions should pass on a freshly migrated DB.
--
-- RUNTIME-DEFERRED: This test cannot be executed locally until
-- `supabase start` (Docker stack) becomes available. The test is syntactically
-- valid SQL and is added to the pgTAP runner; CI will pick it up once the
-- runtime gate flips. Spec Kit slice 008 phase 8a tracks this as a
-- shipped-but-unverified deliverable.
--
-- Test plan (plan(5) -- see per-assertion comments below):
--   A1: lives_ok -- re-importing the original signed envelope succeeds
--       (roundtrip baseline; proves the test fixture's signature actually
--       verifies before we start mutating envelopes).
--   A2: throws_ok WCG08 -- envelope body is tampered (new key inserted under
--       current_config) while the OLD signature is retained. HMAC mismatch.
--   A3: throws_ok WCG08 -- envelope has the 'signature' field stripped
--       entirely (slot 0077 L2104 raise on null/empty signature).
--   A4: throws_ok WCG08 -- envelope's schema_version is forged to '9.9.9'.
--       Step 3 (L2097) fires BEFORE the signature check, so this WCG08
--       is the schema-version raise specifically, not an HMAC mismatch.
--   A5: cmp_ok -- the A1 roundtrip wrote at least one tournament_config_versions
--       row with change_kind='import_bulk' AND reason='T058 roundtrip test'.
--       Proves that the successful import actually mutated the versions
--       chain (defence against a no-op import that silently swallows the
--       envelope). Slot 0077 L2227 hard-codes change_kind='import_bulk'
--       and L2228 wires p_reason into the versions row's reason column.
--
-- Out of scope (covered by sibling tasks):
--   * T024 upsert_authorization.sql -- generic write-surface WCG07 gate.
--   * T042 get_secret_authorization.sql -- secret-read surface.
--   * T049/T050 rollback_*.sql -- rollback RPC contract.
--   * Future T0xx import_authorization.sql -- non-admin invokes import (WCG07).
--   * Future T0xx import_validation.sql -- per-key validation aggregate WCG08.
--
-- Impersonation pattern (mirrors rollback_happy.sql / get_secret_authorization.sql):
--   admin_config_export and admin_config_import are both SECURITY DEFINER and
--   gate on is_admin(auth.uid()). We use set_config('request.jwt.claims', ..., true)
--   so the JWT sub maps to admin1 (slot 0074 bootstrap admin), and SET LOCAL
--   ROLE authenticated so the privilege evaluation matches a real PostgREST
--   call. Assertion-phase SELECTs run under the default postgres role (after
--   RESET ROLE) so RLS on tournament_config_versions does not gate the read.
--
-- Fixture uuids (slice 001 seed + slot 0074 bootstrap):
--   * admin1  (admin)  auth_user_id 00000000-0000-0000-0000-0000000000d3
--
-- Pattern: BEGIN / plan(5) / DO-block setup writes captured envelope variants
-- into a TEMP table (_t058_state) / asserts read variants from the temp table
-- and invoke admin_config_import / finish / ROLLBACK. The ROLLBACK discards
-- every audit_log/versions/config mutation written during the test AND drops
-- the temp table, so the test is fully re-runnable.

BEGIN;

SELECT plan(5);

-- Capture the test start time as a session-local boundary so the A5
-- versions-row count can exclude any pre-existing import_bulk rows on the
-- same reason channel. is_local=false because we need it visible across
-- all assertions; ROLLBACK still clears it because set_config with is_local=false
-- only persists until the session ends, and pgTAP runs each test file in a
-- fresh session anyway.
SELECT set_config('test.start_ts', clock_timestamp()::text, false);

-- Scratch table for ferrying the four envelope variants out of the DO block
-- so pgTAP assertions can reference them. ON COMMIT DROP is redundant with
-- the session-scoped temp table lifetime, but documents the intent. We
-- create the temp table BEFORE the role switch so it's owned by postgres
-- (the test runner) -- the authenticated role inside the DO block writes to
-- it via the SECURITY DEFINER context's INSERT privilege on the temp table
-- (PostgreSQL grants writers to temp objects created in the same session
-- regardless of role).
CREATE TEMP TABLE _t058_state (
  name     text PRIMARY KEY,
  envelope jsonb NOT NULL
) ON COMMIT DROP;

-- ---------------------------------------------------------------------------
-- Setup: switch to admin1 + authenticated role, set the signing-secret GUC,
-- export a real signed envelope, and pre-compute the three tamper variants.
-- All four envelopes (original / tampered / no_sig / bad_version) are stashed
-- in _t058_state so the per-assertion lives_ok/throws_ok calls below can
-- pick them up without re-running the export.
--
-- GUC SET LOCAL note: app.config_export_secret MUST be set INSIDE the
-- transaction so T052 (Step 2, slot 0077 L1958..L1962) and T053 (Step 4,
-- slot 0077 L2108..L2112) both see the same non-null value. The literal
-- below is a synthetic test secret; production wires this via the Supabase
-- project env var per T075 runbook.
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
SET LOCAL app.config_export_secret = 'T058-test-secret-do-not-leak';

DO $setup$
DECLARE
  v_envelope    jsonb;
  v_tampered    jsonb;
  v_no_sig      jsonb;
  v_bad_version jsonb;
BEGIN
  -- Step 1: capture the original signed envelope. T052 stamps signature
  -- = encode(hmac(body::text::bytea, secret::bytea, 'sha256'), 'hex')
  -- over (envelope - 'signature'). All three tamper variants below
  -- inherit this signature; only the original re-verifies cleanly.
  v_envelope := public.admin_config_export();
  INSERT INTO _t058_state(name, envelope) VALUES ('original', v_envelope);

  -- Step 2: build the tampered variant. We modify current_config by
  -- overlaying a NEW value for eligibility.allowed_domains (the seeded
  -- key from slot 0077 L282). The old signature still occupies the
  -- 'signature' field but no longer matches the body's HMAC.
  --
  -- We deliberately overlay a key that already exists in current_config
  -- (rather than inventing a fake key) so per-key validation (T053
  -- Step 5) accepts the value -- the WCG08 raise we want to surface is
  -- the signature-mismatch raise from Step 4, not a validation-failure
  -- raise from Step 5. The replacement value is a valid jsonb array,
  -- so the eligibility.allowed_domains validator (T053 L2139..L2142,
  -- "must be a jsonb array") passes.
  v_tampered := v_envelope || jsonb_build_object(
    'current_config',
    (v_envelope -> 'current_config')
      || jsonb_build_object(
           'eligibility.allowed_domains',
           '["nortal.com","tampered.com"]'::jsonb
         )
  );
  INSERT INTO _t058_state(name, envelope) VALUES ('tampered', v_tampered);

  -- Step 3: build the no-signature variant by stripping the 'signature'
  -- field entirely. T053 Step 4 (L2103..L2106) raises WCG08 on
  -- "Import envelope missing signature" when (p_envelope ->> 'signature')
  -- is NULL.
  v_no_sig := v_envelope - 'signature';
  INSERT INTO _t058_state(name, envelope) VALUES ('no_sig', v_no_sig);

  -- Step 4: build the bad-schema_version variant. We use jsonb_set to
  -- forge schema_version='9.9.9' while leaving the original signature
  -- in place. T053 Step 3 (L2097..L2100) raises WCG08
  -- "Import envelope schema_version 9.9.9 is not supported; expected 1.0.0"
  -- BEFORE the Step 4 signature check runs, so we get a schema-version
  -- WCG08 (not an HMAC-mismatch WCG08). The two raises share the same
  -- SQLSTATE WCG08 so throws_ok cannot distinguish them; A4's narrative
  -- pins which raise we expect via the assertion message.
  v_bad_version := jsonb_set(v_envelope, '{schema_version}', '"9.9.9"'::jsonb);
  INSERT INTO _t058_state(name, envelope) VALUES ('bad_version', v_bad_version);
END;
$setup$;

-- ---------------------------------------------------------------------------
-- A1: roundtrip -- re-import the original signed envelope must succeed.
-- This is the GREEN baseline: it proves the test fixture's secret + envelope
-- pair actually produces a verifying signature. If A1 fails, every other
-- assertion in this file is meaningless (we can't distinguish "tamper
-- correctly rejected" from "the test secret was wrong all along").
--
-- The import RPC requires reason text (T053 Step 2, slot 0077 L2090..L2093),
-- so we pass 'T058 roundtrip test' as p_reason. That same reason string
-- shows up on the versions row (T053 L2228, RETURNING into v_new_version)
-- which A5 later asserts on.
--
-- Note we re-issue the JWT + ROLE + GUC settings here -- SET LOCAL inside
-- a transaction persists across statements, but we make the auth context
-- explicit at each assertion boundary to mirror the rollback_happy.sql
-- pattern (defence against a future refactor that splits this test into
-- multiple files).
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
SET LOCAL app.config_export_secret = 'T058-test-secret-do-not-leak';

SELECT lives_ok(
  $$SELECT public.admin_config_import(
      (SELECT envelope FROM _t058_state WHERE name = 'original'),
      'T058 roundtrip test'
    )$$,
  'A1: admin_config_import succeeds for a freshly-exported envelope (roundtrip baseline)'
);

-- ---------------------------------------------------------------------------
-- A2: tampered body -- same signature, modified content -> WCG08.
-- The 'signature' field still carries the HMAC computed over the original
-- body; T053 Step 4 (slot 0077 L2114..L2121) recomputes the expected
-- signature over (p_envelope - 'signature')::text and compares. Because
-- current_config was overlaid in setup, the recomputed HMAC diverges and
-- the raise at L2120 fires. NULL message-match keeps the assertion robust
-- against minor wording drift.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.admin_config_import(
      (SELECT envelope FROM _t058_state WHERE name = 'tampered'),
      'T058 tampered test'
    )$$,
  'WCG08',
  NULL,
  'A2: admin_config_import raises WCG08 when envelope body is tampered (HMAC mismatch)'
);

-- ---------------------------------------------------------------------------
-- A3: missing signature field -> WCG08.
-- The envelope had 'signature' stripped via the `-` operator in setup.
-- T053 Step 4's null-check (slot 0077 L2104..L2106) fires before any HMAC
-- recomputation, raising WCG08 with the "Import envelope missing signature"
-- message. This proves the import RPC refuses unsigned envelopes regardless
-- of whether the body would have otherwise been valid -- defence against
-- an attacker who knows the signing secret is mis-deployed (and so the
-- export side would also refuse) but tries to slip in an unsigned envelope.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.admin_config_import(
      (SELECT envelope FROM _t058_state WHERE name = 'no_sig'),
      'T058 no-signature test'
    )$$,
  'WCG08',
  NULL,
  'A3: admin_config_import raises WCG08 when envelope lacks signature field'
);

-- ---------------------------------------------------------------------------
-- A4: schema_version mismatch -> WCG08.
-- The envelope's schema_version was forged to '9.9.9'; everything else
-- (including the now-stale signature) is left untouched. T053 Step 3
-- (slot 0077 L2097..L2100) fires BEFORE Step 4's signature check, so the
-- raise we see here is the schema-version raise specifically:
-- "Import envelope schema_version 9.9.9 is not supported; expected 1.0.0".
-- Both Step 3 and Step 4 raise WCG08, so SQLSTATE alone can't distinguish
-- them; the ordering invariant (Step 3 before Step 4) is the contract.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.admin_config_import(
      (SELECT envelope FROM _t058_state WHERE name = 'bad_version'),
      'T058 bad-version test'
    )$$,
  'WCG08',
  NULL,
  'A4: admin_config_import raises WCG08 for schema_version=''9.9.9'' (Step 3 raises before Step 4 signature check)'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A5: the A1 roundtrip actually mutated tournament_config_versions.
-- T053 Step 7 (slot 0077 L2207..L2243) iterates current_config and INSERTs
-- one tournament_config_versions row per key with change_kind='import_bulk'
-- (L2227) and reason=p_reason (L2228). At least one such row must exist
-- on the 'T058 roundtrip test' reason channel, written since the test
-- start barrier (defence against pre-seeded fixture rows on the same
-- reason -- impossible in the current fixture stack but cheap insurance).
--
-- We use cmp_ok with '>' 0 (not exactly N) because the import iterates
-- EVERY key in current_config, and the seeded key count varies across
-- slot 0077 migrations. Asserting > 0 is the minimal contract: "the import
-- wrote at least one versions row." If a future seed change adds keys,
-- this assertion keeps passing; if the import RPC's Step 7 silently
-- short-circuits (regression), this assertion fails immediately.
--
-- Evaluated under postgres role (after RESET ROLE) so RLS on
-- tournament_config_versions (slice 008's narrow SELECT policy) does not
-- gate the SELECT.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  (SELECT count(*)::int
     FROM public.tournament_config_versions
    WHERE change_kind = 'import_bulk'
      AND reason = 'T058 roundtrip test'
      AND created_at >= current_setting('test.start_ts')::timestamptz),
  '>',
  0,
  'A5: A1 roundtrip created at least one tournament_config_versions row with change_kind=''import_bulk'' and reason=''T058 roundtrip test'''
);

SELECT * FROM finish();

ROLLBACK;
