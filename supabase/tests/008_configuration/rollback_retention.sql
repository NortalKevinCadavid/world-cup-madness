-- rollback_retention.sql
-- Slice 008 Tournament Configuration | Task T050 | US5 (Rollback retention horizon)
--
-- Spec anchors:
--   spec.md § US5 -- "Admin rolls back a tournament configuration to a prior
--   version." Rollback MUST honor the audit retention horizon: a target
--   version whose created_at falls before the horizon MUST be refused with
--   SQLSTATE WCG04 ("Rollback target version exceeds retention horizon").
--
-- Contract source of truth:
--   contracts/admin-config-rpcs.write.md § Behavior -- admin_config_rollback:
--   "If the target version's created_at is older than the retention horizon
--    (defaults to all history kept per Slice 007 retention policy), RAISE
--    EXCEPTION with SQLSTATE WCG04."
--
-- Implementation reference:
--   * slot 0077 lines 1614..1813 -- T046 _config_rollback_retention_horizon()
--     and admin_config_rollback (the function under test).
--   * slot 0077 lines 1645..1677 -- horizon helper body.
--   * slot 0077 lines 1739..1744 -- the WCG04 gate inside admin_config_rollback.
--   * slot 0076 lines 58..64 -- slot 0076 seeds
--     audit.retention.policy_kind='keep' and
--     audit.retention.tournament_end_buffer_months=12.
--
-- D-T046-A retention semantics (LOCKED at T046 ship time):
--   * If audit.retention.policy_kind = 'keep' (slot 0076 default),
--     _config_rollback_retention_horizon() returns '-infinity'::timestamptz
--     so NO rollback ever trips WCG04 (all history is rollback-eligible).
--   * If policy_kind = 'prune' (or anything other than 'keep'), the helper
--     returns now() - tournament_end_buffer_months * interval '1 month'
--     (default buffer 12 months). Versions older than that horizon raise
--     WCG04 when used as a rollback target.
--   * The production default posture is 'keep'. An operator who wants the
--     pruning behavior flips policy_kind via admin_config_upsert. This test
--     exercises the 'prune' branch -- the WCG04 path that production-default
--     code paths never hit.
--
-- Test scope (plan(7) -- see per-assertion comments below):
--   A1 isnt       horizon helper returns a non-(-infinity) value under prune
--   A2 ok         horizon helper returns approximately now() - 12 months
--   A3 throws_ok  admin_config_rollback against 24-month-old version raises WCG04
--   A4 is         no admin_rollback row was minted while the gate fired
--   A5 is         horizon helper returns to '-infinity' after flipping back to keep
--   A6 lives_ok   the SAME rollback now succeeds under keep policy (defensive
--                 proof that the gate is policy-driven, not target-age-driven)
--   A7 is         the successful rollback minted exactly one admin_rollback
--                 row with parent_version_id = synthetic version_id
--
-- Out of scope (covered by sibling tasks):
--   * T049 rollback_happy.sql -- the canonical happy-path rollback over a
--     fresh upsert chain (no synthetic backdating).
--
-- Test design notes:
--   * The synthetic tournament_config_versions row is inserted DIRECTLY (via
--     a CTE that captures the new version_id into a TEMP TABLE) to bypass
--     admin_config_upsert -- we need an explicit created_at, which the
--     normal write path does not expose. This is acceptable because (a) the
--     test's BEGIN/ROLLBACK frame discards the synthetic row, and (b) the
--     row satisfies all CHECK constraints (slot 0077 lines 89..103):
--       - change_kind='admin_upsert' satisfies the change_kind CHECK.
--       - previous_value IS NOT NULL satisfies the previous_value CHECK
--         (the CHECK only permits NULL when change_kind='initial_seed').
--       - change_kind != 'admin_rollback', so parent_version_id IS NULL is
--         required (and we leave it NULL).
--
--   * The retention policy_kind is flipped via a direct UPDATE on
--     public.tournament_config rather than via admin_config_upsert. This
--     keeps the test focused on the rollback gate -- routing the flip
--     through admin_config_upsert would entangle the test with the
--     audit.* key validation / authorization paths that belong to T024..T026.
--
--   * The plan() count is exact at 7. If a future revision of T046 adds
--     additional gates inside admin_config_rollback (e.g., the contract
--     ever adds a "horizon is logged in the audit row" requirement), update
--     plan() and add the corresponding assertion(s).
--
-- Impersonation pattern (mirrors upsert_authorization.sql / get_secret_authorization.sql):
--   The test runner role is `postgres` (BYPASSRLS + DDL). For the rollback
--   invocations we (1) set request.jwt.claims via set_config so the
--   SECURITY DEFINER body sees auth.uid()=admin1, (2) SET LOCAL ROLE
--   authenticated to mirror a real PostgREST call, (3) RESET ROLE between
--   assertions to return to the postgres test-runner context (needed for
--   the tournament_config UPDATE and the tournament_config_versions SELECT
--   which would otherwise be gated by slot 0077's RLS policies).
--
-- Fixture uuids (slice 001 seed; admin grant via slot 0074 bootstrap):
--   * admin1  (admin) auth_user_id 00000000-0000-0000-0000-0000000000d3
--   (No non-admin persona is needed -- the WCG04 gate is reached only after
--    the is_admin gate passes, and we want to isolate the retention path.)
--
-- Pattern: BEGIN / plan(7) / setup / asserts / finish / ROLLBACK. The
-- ROLLBACK discards the synthetic versions row, the policy_kind flip(s),
-- and the admin_rollback row produced by A6, leaving the database in its
-- pre-test state.
--
-- Runtime: RUNTIME-DEFERRED (requires a live Postgres + supabase
-- environment with slot 0077 applied; CI executes via supabase db test).

BEGIN;

SELECT plan(7);

-- ---------------------------------------------------------------------------
-- Capture the synthetic version_id into a TEMP TABLE so subsequent
-- format(...)/throws_ok/lives_ok calls can interpolate it as a literal
-- bigint. TEMP TABLE is dropped at COMMIT/ROLLBACK so it does not leak
-- between test files.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _t050_state (
  name        text PRIMARY KEY,
  version_id  bigint NOT NULL
);

-- ---------------------------------------------------------------------------
-- Setup step 1: flip audit.retention.policy_kind from 'keep' to 'prune'
-- via a direct UPDATE. This activates the horizon = now() - 12 months
-- branch of _config_rollback_retention_horizon(). We avoid routing
-- through admin_config_upsert (which would entangle this test with
-- T024..T026 concerns).
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value      = '"prune"'::jsonb,
       updated_at = now()
 WHERE key = 'audit.retention.policy_kind';

-- ---------------------------------------------------------------------------
-- A1: the helper now returns a non-(-infinity) horizon. Slot 0077 L1662
-- short-circuits to '-infinity' only when policy_kind IN (NULL,'keep'),
-- so any other value sends us into the now()-buffer_months branch.
-- ---------------------------------------------------------------------------
SELECT isnt(
  public._config_rollback_retention_horizon(),
  '-infinity'::timestamptz,
  'A1: horizon is not -infinity under prune policy'
);

-- ---------------------------------------------------------------------------
-- A2: the helper returns approximately now() - 12 months (the seeded
-- buffer). We allow a +/- 5 minute window to tolerate clock drift between
-- the assertion call site and the helper's now() call. Anything outside
-- that window means either (a) buffer_months was not 12, or (b) the
-- helper used a different anchor than now() -- either would be a contract
-- regression.
-- ---------------------------------------------------------------------------
SELECT ok(
  public._config_rollback_retention_horizon()
    BETWEEN (now() - interval '12 months' - interval '5 minutes')
        AND (now() - interval '12 months' + interval '5 minutes'),
  'A2: horizon is approximately now() - 12 months'
);

-- ---------------------------------------------------------------------------
-- Setup step 2: synthesize a tournament_config_versions row with
-- created_at = now() - 24 months. 24 months is comfortably past the
-- 12-month horizon (12 months on the other side of it), so the gate
-- MUST fire. Constraints satisfied:
--   * change_kind='admin_upsert' (allowed; slot 0077 L87)
--   * previous_value='10'::jsonb (NOT NULL; slot 0077 L94)
--   * actor=admin1 uuid (column is nullable but we provide it to make the
--     forensic story clean)
--   * parent_version_id NULL (required for non-rollback change_kinds; slot
--     0077 L102)
--   * version_id auto-assigned via bigserial -- captured into _t050_state.
-- ---------------------------------------------------------------------------
WITH ins AS (
  INSERT INTO public.tournament_config_versions (
    key,
    previous_value,
    new_value,
    change_kind,
    actor,
    reason,
    source_citation,
    created_at
  )
  VALUES (
    'scoring.match_points.exact',
    '10'::jsonb,
    '15'::jsonb,
    'admin_upsert',
    '00000000-0000-0000-0000-0000000000d3'::uuid,
    'T050 synthetic 24-month-old version (test fixture, never reached production)',
    'T050 retention horizon test',
    now() - interval '24 months'
  )
  RETURNING version_id
)
INSERT INTO _t050_state (name, version_id)
SELECT 'synthetic', version_id FROM ins;

-- ---------------------------------------------------------------------------
-- A3: invoke admin_config_rollback against the synthetic version_id with
-- admin1 as the caller. The is_admin gate passes (admin1 is bootstrapped
-- by slot 0074), the reason is non-empty (clears WCG02), the target row
-- exists (clears WCG03 step 3), then the retention horizon check fires
-- because the synthetic row's created_at (now()-24mo) is well below the
-- horizon (now()-12mo). Expected: WCG04.
--
-- Use format(...) with %L::bigint for the version_id so the literal is
-- correctly typed inside the dollar-quoted SQL passed to throws_ok.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  format(
    $f$SELECT public.admin_config_rollback(
         %L::bigint,
         'T050 attempt rollback past retention horizon'::text,
         'T050 test fixture'::text
       )$f$,
    (SELECT version_id FROM _t050_state WHERE name = 'synthetic')
  ),
  'WCG04',
  NULL,
  'A3: admin_config_rollback against 24-month-old version raises WCG04'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A4: no admin_rollback row was minted. The WCG04 raise inside Step 4
-- of admin_config_rollback (slot 0077 L1741..L1744) happens BEFORE the
-- versions INSERT at Step 8 (slot 0077 L1781..L1796), so the failed
-- call must leave tournament_config_versions untouched for this key
-- (modulo the synthetic row we just inserted, which is NOT an
-- admin_rollback row by construction).
--
-- We filter by change_kind='admin_rollback' so the synthetic row (which
-- is change_kind='admin_upsert') is naturally excluded.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int
     FROM public.tournament_config_versions
    WHERE key = 'scoring.match_points.exact'
      AND change_kind = 'admin_rollback'),
  0,
  'A4: WCG04 path did not insert any admin_rollback row'
);

-- ---------------------------------------------------------------------------
-- Setup step 3: flip policy_kind back to 'keep'. The horizon helper
-- short-circuits to '-infinity' under 'keep' (slot 0077 L1662..L1664),
-- so the same synthetic version's created_at is no longer below the
-- horizon (since any timestamptz is >= '-infinity').
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value      = '"keep"'::jsonb,
       updated_at = now()
 WHERE key = 'audit.retention.policy_kind';

-- ---------------------------------------------------------------------------
-- A5: the helper now returns '-infinity'. Confirms the gate is purely
-- policy-driven and not somehow caching the prune-era horizon value.
-- ---------------------------------------------------------------------------
SELECT is(
  public._config_rollback_retention_horizon(),
  '-infinity'::timestamptz,
  'A5: horizon returns to -infinity under keep policy'
);

-- ---------------------------------------------------------------------------
-- A6: the SAME rollback now succeeds. Same caller, same version_id,
-- same reason -- the only thing that changed is policy_kind. lives_ok
-- asserts the call returned a bigint without raising. This is the
-- DEFENSIVE proof that the WCG04 gate is solely policy-driven.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  format(
    $f$SELECT public.admin_config_rollback(
         %L::bigint,
         'T050 retry rollback after policy flip'::text,
         'T050 test fixture'::text
       )$f$,
    (SELECT version_id FROM _t050_state WHERE name = 'synthetic')
  ),
  'A6: admin_config_rollback succeeds when policy_kind is keep'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A7: the successful rollback minted exactly ONE admin_rollback row whose
-- parent_version_id points back at the synthetic version. Evaluated under
-- postgres role so RLS doesn't gate the SELECT. The parent_version_id
-- back-pointer is the contract-level guarantee that the new version row
-- carries provenance to the rollback target (slot 0077 L1781..L1796).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int
     FROM public.tournament_config_versions
    WHERE key = 'scoring.match_points.exact'
      AND change_kind = 'admin_rollback'
      AND parent_version_id = (SELECT version_id FROM _t050_state WHERE name = 'synthetic')),
  1,
  'A7: admin_rollback row exists with parent_version_id = synthetic version'
);

SELECT * FROM finish();

ROLLBACK;
