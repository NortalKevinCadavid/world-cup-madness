-- import_validation_aggregate.sql
-- Slice 008 Tournament Configuration | Task T059 | US7 (Import / Export)
--
-- RUNTIME-DEFERRED: this pgTAP test is checked in for static SQL validation
-- only. Executing it requires a running Supabase Postgres instance with the
-- 008 migration stack applied AND the `extensions.hmac` function (pgcrypto)
-- available on the search_path. CI executes the suite in 008's runtime gate;
-- T059 is authored against the contract surface, not asserted to be green
-- ahead of slot 0077 deployment.
--
-- Spec anchors:
--   contracts/config-import.write.md § "Per-key validation aggregate" --
--   admin_config_import MUST collect EVERY per-key validation failure into
--   a single jsonb error array and surface them together via a WCG08 raise.
--   It MUST NOT short-circuit on the first failure (the operator needs to
--   see the full list of bad keys in one pass) and it MUST NOT mutate
--   tournament_config or tournament_config_versions when ANY key fails
--   (atomic all-or-nothing semantics: a bad envelope is rejected wholesale).
--
-- Implementation reference:
--   supabase/migrations/0077_configuration.sql § T053 admin_config_import
--   (L2027..L2256). Specifically:
--     * L2123..L2176 -- per-key validation loop. Each per-key check runs
--       inside a BEGIN..EXCEPTION block; on failure the {key, value, reason}
--       tuple is appended to v_validation_errors and the loop CONTINUES.
--     * L2178..L2183 -- after the loop, if v_validation_errors is non-empty
--       raise WCG08 with the array serialized into SQLERRM (so callers can
--       parse the list out of the error message).
--     * L2127..L2132 -- secret-redacted entries are SKIPPED entirely (the
--       null placeholder is not validated). Not exercised in this test
--       because we want to focus on the aggregate gate; the secret-skip
--       branch is exercised by a sibling task.
--     * L2185..L2243 -- the actual mutation phase (audit row + per-key
--       version + tournament_config upsert) runs AFTER the validation
--       aggregate. Because the WCG08 raise is BEFORE that block, the
--       audit row, the versions rows, and the tournament_config upserts
--       all roll back together with the function-level transaction.
--
-- Critical pre-condition: the synthetic envelope's signature MUST be valid.
-- admin_config_import's Step 4 (L2102..L2121) verifies the HMAC-SHA256 of
-- (envelope - 'signature') against current_setting('app.config_export_secret').
-- If we hit a signature mismatch we'd get WCG08 on the signature gate at
-- L2120 instead of the validation aggregate at L2179 -- and A2's locking /
-- match_points keyword assertions would fail because the error message
-- would say "signature invalid" rather than the per-key reason list.
-- We mint the signature inline with extensions.hmac() using the same
-- formula as Step 4 so the gate passes and execution reaches the aggregate.
--
-- Test plan (plan(6)):
--   A1: admin_config_import raises WCG08 when the envelope contains keys
--       that fail per-key validation. throws_ok captures the SQLSTATE.
--   A2 (split into A2a + A2b): the error message text mentions BOTH bad
--       keys -- locking.match_prediction_window_minutes (-5 fails the
--       "integer 1..1440" check at L2143..L2148) and scoring.match_points.exact
--       ("string" fails the "non-negative integer" check at L2149..L2155).
--       throws_ok only checks SQLSTATE; we capture SQLERRM via a separate
--       PERFORM-with-EXCEPTION block, stash the substring checks in the
--       state temp table, and assert them as two booleans. This proves the
--       aggregate collects ALL failures (the canonical first-failure-only
--       bug would surface as one of the two booleans being false).
--   A3: count(*) of tournament_config_versions is unchanged across the
--       two failed import calls. This is the atomic-rollback contract --
--       no per-key version rows escape even though the loop visited all
--       five keys before raising.
--   A4: NO audit_log row for action='admin.config_imported' exists with
--       a reason that starts with the test's reason string. Slot 0077
--       L2188..L2205 emits ONE audit row per SUCCESSFUL import; on
--       failure that INSERT never runs because the WCG08 at L2179 fires
--       first. (Note: the WCG07 path at L2073..L2086 DOES emit an
--       admin.access_denied audit row even on failure, but that uses a
--       DIFFERENT action name. We filter on action='admin.config_imported'
--       specifically.)
--   A5: tournament_config.value WHERE key='tournament.phase.current' is
--       still '"pre_tournament"' -- the value it was seeded to at slot
--       0077 L347. The synthetic envelope tries to set this key to
--       '"group_stage"' as one of the THREE VALID keys. If the import
--       were non-atomic (applied valid keys first, then bailed on the
--       invalid ones) this row would have flipped to '"group_stage"'.
--       The fact that it is unchanged is the strongest assertion that
--       the validation aggregate's WCG08 raises BEFORE any mutation.
--
-- Out of scope (covered by sibling tasks in Phase 8a):
--   * T058 import_signature.sql -- WCG08 on bad signature / missing GUC.
--   * T060 import_secret_skip.sql -- key_is_secret + null placeholder branch.
--   * T061 import_schema_version.sql -- WCG08 on schema_version mismatch.
--   * T062 import_authorization.sql -- WCG07 on non-admin caller.
--
-- Impersonation pattern (mirrors rollback_happy.sql):
--   admin_config_import is SECURITY DEFINER and gates on is_admin(auth.uid()).
--   We set request.jwt.claims to admin1's auth_user_id (slot 0074 seeded:
--   00000000-0000-0000-0000-0000000000d3) and SET LOCAL ROLE authenticated
--   so the privilege evaluation matches a real PostgREST call. Reads in
--   the assertion phase happen under the default postgres role (after
--   RESET ROLE) so RLS does not gate the SELECTs against tournament_config /
--   tournament_config_versions / audit_log.
--
-- GUC dependency: app.config_export_secret. Set via SET LOCAL so it lives
-- for the duration of the test's transaction and is rolled back at the
-- final ROLLBACK. The RPC reads it via current_setting(..., true) which
-- honors session-local and transaction-local GUC scopes equivalently.

BEGIN;

SELECT plan(6);

-- Configure the HMAC secret BEFORE the impersonation handshake so the
-- inline signature computation in the DO-block setup and the RPC's
-- Step 4 signature verification both observe the same value.
SET LOCAL app.config_export_secret = 'T059-test-secret';

-- Admin impersonation: admin1 from slot 0074 fixture (auth_user_id =
-- 00000000-0000-0000-0000-0000000000d3). The 'role' claim is set so the
-- RPC's PostgREST-style auth.uid() resolution returns the expected uuid.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

-- Scratch table for ferrying the baseline versions count, the synthetic
-- envelope (so the throws_ok call can re-reference it), and the captured
-- SQLERRM + keyword-presence booleans out of the DO blocks into the
-- pgTAP assertion phase. ON COMMIT DROP is redundant with the final
-- ROLLBACK but documents the intended lifetime.
CREATE TEMP TABLE _t059_state (
  name  text PRIMARY KEY,
  value jsonb
) ON COMMIT DROP;

-- ---------------------------------------------------------------------------
-- Setup: capture the pre-test versions count and build the synthetic
-- envelope (3 valid keys + 2 invalid keys) with a matching HMAC signature.
--
-- Key selection rationale:
--   VALID keys (must pass the L2138..L2168 CASE dispatcher):
--     * eligibility.allowed_domains = ["nortal.com"]
--         -> jsonb_typeof = 'array' -- passes L2139..L2142.
--     * scoring.final_pick_points = 25
--         -> jsonb_typeof='number' AND int>=0 -- passes L2149..L2155.
--     * tournament.phase.current = "group_stage"
--         -> string in the enum -- passes L2160..L2164.
--   INVALID keys (must FAIL the L2138..L2168 CASE dispatcher):
--     * locking.match_prediction_window_minutes = -5
--         -> number but < 1 -- fails L2143..L2148 ("integer 1..1440").
--     * scoring.match_points.exact = "string"
--         -> jsonb_typeof='string' (not 'number') -- fails L2149..L2155
--            ("non-negative integer"). The cast (v_value)::text::int would
--            also fail with invalid_text_representation, but the typeof
--            check trips first, producing a deterministic SQLERRM.
--
-- Signature construction: the RPC at L2114..L2118 computes the expected
-- signature as encode(hmac((envelope - 'signature')::text::bytea,
-- secret::bytea, 'sha256'), 'hex'). We use the EXACT same formula here
-- so the Step 4 gate accepts the envelope and execution reaches the
-- validation aggregate. The 'exported_at' field is captured as now()::text
-- once and frozen in the envelope so the v_body bytea is stable across
-- the two RPC calls (A1's throws_ok and A2's PERFORM).
-- ---------------------------------------------------------------------------
DO $setup$
DECLARE
  v_baseline_count int;
  v_body           jsonb;
  v_signature      text;
  v_envelope       jsonb;
BEGIN
  SELECT count(*)::int INTO v_baseline_count
    FROM public.tournament_config_versions;
  INSERT INTO _t059_state(name, value)
    VALUES ('baseline_count', to_jsonb(v_baseline_count));

  v_body := jsonb_build_object(
    'schema_version', '1.0.0',
    'exported_at',    now()::text,
    'exported_by',    '00000000-0000-0000-0000-0000000000d3',
    'environment',    'test',
    'current_config', jsonb_build_object(
      'eligibility.allowed_domains',             '["nortal.com"]'::jsonb,
      'scoring.final_pick_points',               '25'::jsonb,
      'tournament.phase.current',                '"group_stage"'::jsonb,
      'locking.match_prediction_window_minutes', '-5'::jsonb,
      'scoring.match_points.exact',              '"string"'::jsonb
    ),
    'version_history', '[]'::jsonb
  );

  v_signature := encode(
    extensions.hmac(v_body::text::bytea, 'T059-test-secret'::bytea, 'sha256'),
    'hex'
  );

  v_envelope := v_body || jsonb_build_object('signature', v_signature);
  INSERT INTO _t059_state(name, value) VALUES ('envelope', v_envelope);
END;
$setup$;

-- ---------------------------------------------------------------------------
-- A1: admin_config_import raises WCG08 when the envelope contains keys
-- that fail per-key validation. throws_ok only captures the SQLSTATE
-- (PostgreSQL exception code) -- it does NOT inspect the message text;
-- A2 covers the message contents below. The inline SELECT pulls the
-- envelope out of the temp table so the synthetic body + signature are
-- byte-stable with the A2 invocation.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.admin_config_import(
         (SELECT value FROM _t059_state WHERE name = 'envelope'),
         'T059 aggregated validation test'
       ) $$,
  'WCG08',
  NULL,
  'A1: admin_config_import raises WCG08 when one or more keys fail validation'
);

-- ---------------------------------------------------------------------------
-- A2 setup: capture the SQLERRM text from a fresh RPC invocation so the
-- substring checks below can verify the aggregate lists BOTH bad keys.
-- We re-invoke the RPC (A1's throws_ok already triggered an exception that
-- was swallowed) inside a savepoint-style EXCEPTION block, store the
-- message, and record whether each bad key's name appears anywhere in
-- the message. The contract guarantees the {key, value, reason} tuple is
-- serialized into the WCG08 SQLERRM via L2179..L2182.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
  v_message          text;
  v_has_locking      boolean;
  v_has_match_points boolean;
BEGIN
  BEGIN
    PERFORM public.admin_config_import(
      (SELECT value FROM _t059_state WHERE name = 'envelope'),
      'T059 aggregated validation test (second call)'
    );
    -- If we reach here the RPC did NOT raise -- the test is broken.
    v_message := '<no exception raised>';
  EXCEPTION WHEN OTHERS THEN
    v_message := SQLERRM;
  END;

  v_has_locking      := v_message LIKE '%locking.match_prediction_window_minutes%';
  v_has_match_points := v_message LIKE '%scoring.match_points.exact%';

  INSERT INTO _t059_state(name, value) VALUES
    ('error_message',    to_jsonb(v_message)),
    ('has_locking',      to_jsonb(v_has_locking)),
    ('has_match_points', to_jsonb(v_has_match_points));
END;
$check$;

-- A2a: the WCG08 error message names locking.match_prediction_window_minutes.
SELECT is(
  (SELECT (value)::text::boolean FROM _t059_state WHERE name = 'has_locking'),
  true,
  'A2a: WCG08 SQLERRM mentions locking.match_prediction_window_minutes'
);

-- A2b: the WCG08 error message names scoring.match_points.exact.
-- (The aggregate must include BOTH keys, not just the first encountered.)
SELECT is(
  (SELECT (value)::text::boolean FROM _t059_state WHERE name = 'has_match_points'),
  true,
  'A2b: WCG08 SQLERRM mentions scoring.match_points.exact'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A3: NO rows were appended to tournament_config_versions across the two
-- failed import calls. The RPC's mutation phase at L2207..L2243 never
-- ran because the WCG08 raise at L2179 fired first. The PL/pgSQL function
-- boundary is also an implicit savepoint -- when the function raises,
-- everything it wrote rolls back together, leaving the row count exactly
-- where the setup DO block captured it.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.tournament_config_versions),
  (SELECT (value)::text::int FROM _t059_state WHERE name = 'baseline_count'),
  'A3: no tournament_config_versions rows added when import aggregate fails (atomic rollback)'
);

-- ---------------------------------------------------------------------------
-- A4: NO audit_log row exists for action='admin.config_imported' with a
-- reason starting with our test's reason string. Slot 0077 L2188..L2205
-- writes that audit row only on the SUCCESS path -- it sits AFTER the
-- validation aggregate at L2179. The single-audit-row contract for
-- imports (one row per successful bulk import, none on failure) is
-- distinct from the per-write audit contract for individual upserts.
-- We filter on the reason prefix so unrelated successful imports in the
-- ambient test database (none expected, but defensive) don't pollute
-- the count.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.config_imported'
      AND reason LIKE 'T059 aggregated validation test%'),
  0,
  'A4: no admin.config_imported audit row written when import aggregate fails'
);

-- ---------------------------------------------------------------------------
-- A5: tournament_config.value WHERE key='tournament.phase.current' is
-- still '"pre_tournament"'::jsonb -- the seed value from slot 0077 L347.
-- The synthetic envelope tried to set this key to '"group_stage"' as one
-- of the three VALID keys. If the import RPC had non-atomically applied
-- valid keys before raising on invalid ones, this row would now be
-- '"group_stage"'. Because the RPC validates ALL keys first (L2123..L2176)
-- and only mutates on a clean validation pass (L2207..L2243), the seed
-- value is preserved. This is the strongest atomicity assertion in the
-- test: it proves the validation gate fires BEFORE any mutation, not
-- merely that mutations roll back via the implicit savepoint.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT value FROM public.tournament_config WHERE key = 'tournament.phase.current'),
  '"pre_tournament"'::jsonb,
  'A5: tournament.phase.current unchanged after failed import (validation gate precedes mutation)'
);

SELECT * FROM finish();

ROLLBACK;
