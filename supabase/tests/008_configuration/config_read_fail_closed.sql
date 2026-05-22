-- config_read_fail_closed.sql
-- Slice 008 Tournament Configuration | Task T068 | Phase 8c (Hardening)
--
-- Spec anchors:
--   Clarification Q3 -- "If a configuration key is missing or its store is
--   unreachable, every consumer MUST fail closed." config_read is the single
--   choke point that makes this guarantee uniform: when the requested key is
--   absent AND no caller-supplied default is provided, it raises SQLSTATE
--   WCG06 (Configuration store unreachable). The two principal consumers
--   touched by slice 008 -- is_eligible_nortal_participant (login eligibility)
--   and is_prediction_locked (pre-kickoff lock window) -- pass NULL as the
--   default so the WCG06 raise propagates into their EXCEPTION blocks, which
--   then collapse to the SAFE-CLOSED return value (FALSE for eligibility ->
--   deny login; TRUE for locking -> deny writes).
--
-- Contract source of truth:
--   contracts/tournament-config.schema.md  4 -- "Helper config_read(p_key,
--   p_default jsonb DEFAULT NULL) RETURNS jsonb: STABLE, SECURITY INVOKER,
--   reads public.tournament_config; if row absent and p_default IS NULL
--   raises ERRCODE WCG06; if row absent and p_default IS NOT NULL returns
--   p_default verbatim."
--
-- Implementation references (slot 0077 supabase/migrations/0077_configuration.sql):
--   * T007 config_read body: L155..L174 (the IF v IS NULL / IF p_default IS
--     NULL / RAISE WCG06 / ELSE RETURN p_default / END branch).
--   * T014 is_eligible_nortal_participant ALTER: L1029..L1081, fail-closed
--     EXCEPTION trap at L1065..L1069 (WCG06 -> RETURN false).
--   * T015 is_prediction_locked ALTER: L1101..L1148, fail-closed EXCEPTION
--     trap at L1131..L1135 (WCG06 -> RETURN true).
--
-- Test plan (plan(4) -- one assertion per sub-test):
--   A1: config_read('t068.nonexistent_key', NULL) raises WCG06. This is the
--       direct contract assertion against config_read itself.
--   A2: config_read('t068.nonexistent_key', '"default_value"'::jsonb) returns
--       the supplied default verbatim. Proves the fail-closed branch only
--       fires when p_default IS NULL -- callers that want a soft fallback
--       (e.g. notifications.audit_failure_webhook_url at slot 0077 L2321,
--       L2394 with 'null'::jsonb default) get the default they passed.
--   A3: is_eligible_nortal_participant(<alpha's auth_user_id>) returns FALSE
--       after we DELETE the eligibility.allowed_domains config row. Alpha
--       has email alpha@nortal.com and status='active' (slice 001 fixture
--       seed); under a healthy config row the function would return TRUE,
--       so a FALSE return proves the WCG06 EXCEPTION trap at slot 0077
--       L1065..L1069 fired and forced the safe-closed deny path.
--   A4: is_prediction_locked(<synthetic match uuid>) returns TRUE after we
--       DELETE the locking.match_prediction_window_minutes config row. The
--       synthetic match is scheduled +60 minutes out (well outside any
--       reasonable lock window) so under a healthy 60-min config the
--       function would return FALSE; a TRUE return proves the WCG06
--       EXCEPTION trap at slot 0077 L1131..L1135 fired and forced
--       safe-closed lock.
--
-- Out of scope (covered by sibling tasks):
--   * T029 eligibility_preview_affecting.sql -- preview-surface behavior.
--   * T032 locking_window_consumer_check.sql -- end-to-end lock window flip.
--   * T042 get_secret_authorization.sql -- secret-namespace read surface.
--   * Slice 005 scoring consumers (compute_match_score) and the audit
--     retention consumer (audit.retention.*) use config_read with a NON-NULL
--     default and therefore do not exhibit the WCG06 raise behavior. Their
--     fail-closed responses are exercised by scoring_consumer_check.sql.
--
-- Impersonation pattern:
--   The test does NOT switch roles -- it runs entirely as the pgTAP
--   postgres test-runner role. This is important because:
--   (1) The DELETE against public.tournament_config requires BYPASSRLS;
--       under SET LOCAL ROLE authenticated the slice 008 RLS policies
--       would refuse the DELETE.
--   (2) is_eligible_nortal_participant and is_prediction_locked are both
--       SECURITY INVOKER, so they read with the caller's privileges; the
--       postgres role can SELECT participants and matches without RLS
--       interference.
--   We set request.jwt.claims to admin1's auth_user_id as a defensive
--   default in case any downstream helper inspects auth.uid() -- but the
--   functions under test do not.
--
-- Fixture choices:
--   * Alpha (auth_user_id 00000000-0000-0000-0000-00000000000a) for the
--     eligibility check: slice 001 fixture seeds her with
--     email='alpha@nortal.com', status='active'. Under a healthy
--     eligibility.allowed_domains=["nortal.com"] config she IS eligible;
--     once we delete the config row, the function MUST return false.
--   * Synthetic match uuid 00000000-0000-0000-1066-000000000002 (the 1066
--     fragment scopes to T068 to avoid any cross-test collision): inserted
--     with stage='group', group_id='A', kickoff_utc=now()+60min,
--     status='scheduled'. The +60min horizon is well outside any
--     reasonable lock window, so a healthy config (60-min default) would
--     leave the match UNLOCKED. Once we delete the config row, fail-closed
--     forces TRUE.
--   * Team FKs use (SELECT id FROM public.teams ORDER BY short_code LIMIT 1)
--     / OFFSET 1 -- the slice 002 seed populates the full WC2026 roster
--     so LIMIT/OFFSET always resolve (same pattern as
--     locking_window_consumer_check.sql L129..L130).
--
-- RUNTIME-DEFERRED: This test is authored for execution against a freshly
-- migrated DB once Phase 2 T014/T015 ALTER FUNCTION migrations land in slot
-- 0077. Static SQL validity only at authoring time; runtime PASS depends on
-- the migrated function bodies actually trapping WCG06 to the fail-closed
-- return. Verified by reading slot 0077 L1029..L1081 (eligibility) and
-- L1101..L1148 (locking) -- both functions DO use config_read('...', NULL)
-- and DO trap WCG06 -> safe-closed return.
--
-- Pattern: BEGIN / plan(4) / asserts / finish / ROLLBACK. The ROLLBACK
-- restores the deleted tournament_config rows automatically -- the explicit
-- INSERT restore steps inside the test body are defense-in-depth so that if
-- ROLLBACK ever fails (e.g. autonomous-transaction regression) the rows
-- remain present for subsequent tests in the same harness run.

BEGIN;

SELECT plan(4);

-- Defensive role-context: set JWT to admin1 in case any helper inspects
-- auth.uid(). The functions under test (is_eligible_nortal_participant,
-- is_prediction_locked) do not, but config_read itself is invoked under
-- whatever role calls it; staying as postgres (pgTAP default) avoids RLS
-- on the temp DELETE/INSERT against tournament_config.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);

-- Session-scoped backup table for the two config values we delete. ON
-- COMMIT DROP means the table evaporates with the ROLLBACK envelope, but
-- the restoration INSERTs below run BEFORE finish() so the rows are
-- defensively restored even if the ROLLBACK never fires.
CREATE TEMP TABLE _t068_state (
  name        text PRIMARY KEY,
  saved_value jsonb NOT NULL
) ON COMMIT DROP;

-- ===========================================================================
-- A1: config_read with absent key + NULL default raises WCG06.
-- ===========================================================================
-- Slot 0077 L164..L168: SELECT INTO returns NULL, p_default IS NULL, so the
-- IF branch RAISEs 'WCG06'. We use the literal key 't068.nonexistent_key'
-- which is not seeded by any slice (the 't068.' prefix is reserved for
-- T068's test fixtures). throws_ok with a NULL message-pattern tolerates
-- future drift in the RAISE message text -- only the ERRCODE matters.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.config_read('t068.nonexistent_key', NULL::jsonb) $$,
  'WCG06',
  NULL,
  'A1: config_read raises WCG06 when key absent and no default supplied'
);

-- ===========================================================================
-- A2: config_read with absent key + non-NULL default returns the default.
-- ===========================================================================
-- Slot 0077 L169..L170: when v IS NULL but p_default IS NOT NULL, the body
-- RETURNs p_default verbatim (no transformation, no validation). We pass
-- '"default_value"'::jsonb (a jsonb string scalar) and assert the return
-- equals that exact jsonb value. is() compares with IS NOT DISTINCT FROM,
-- which handles jsonb equality correctly.
-- ---------------------------------------------------------------------------
SELECT is(
  public.config_read('t068.nonexistent_key', '"default_value"'::jsonb),
  '"default_value"'::jsonb,
  'A2: config_read returns the supplied default jsonb when key absent'
);

-- ===========================================================================
-- A3: is_eligible_nortal_participant fails closed (FALSE) when
--     eligibility.allowed_domains config row is absent.
-- ===========================================================================
-- Save the current row so the ROLLBACK + defensive restore both have a
-- value to write back. We pin to value+updated_at (no version_id capture
-- because version_id is auto-bumped on every INSERT through the table's
-- DEFAULT chain -- restoring exact version is unnecessary here; the test
-- only needs the value column to be present and well-formed for any
-- subsequent test that consults the key).
INSERT INTO _t068_state (name, saved_value)
SELECT 'allowed_domains', value
  FROM public.tournament_config
 WHERE key = 'eligibility.allowed_domains';

-- Delete the row. Under the postgres pgTAP role (BYPASSRLS), no slice 008
-- RLS policy gates this. Confirmed against slot 0077 L185..L260 (the RLS
-- policy block) -- the postgres role is unaffected.
DELETE FROM public.tournament_config
 WHERE key = 'eligibility.allowed_domains';

-- Alpha (slice 001 fixture seed): auth_user_id 0...00a, email
-- alpha@nortal.com, status='active'. Under a healthy config this call
-- returns TRUE; with the row deleted, the function body's BEGIN/EXCEPTION
-- block at slot 0077 L1065..L1069 traps the WCG06 from config_read and
-- RETURNs false. The assertion below is the security-critical regression
-- gate: any future refactor of is_eligible_nortal_participant that drops
-- the WCG06 trap (e.g. switches to config_read with a non-NULL default
-- like 'null'::jsonb, which would NOT raise) fails this assertion
-- immediately.
SELECT is(
  public.is_eligible_nortal_participant(
    '00000000-0000-0000-0000-00000000000a'::uuid
  ),
  false,
  'A3: is_eligible_nortal_participant returns FALSE when allowed_domains config absent (fail-closed)'
);

-- Restore the row (defense in depth -- ROLLBACK also reverses this, but
-- the explicit restore protects against autonomous-transaction regressions
-- where the DELETE somehow escaped the txn). INSERT ... ON CONFLICT DO
-- NOTHING guards against running this restore when the row was never
-- successfully deleted (e.g. an earlier failure short-circuited the test).
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES (
  'eligibility.allowed_domains',
  (SELECT saved_value FROM _t068_state WHERE name = 'allowed_domains'),
  now()
)
ON CONFLICT (key) DO NOTHING;

-- ===========================================================================
-- A4: is_prediction_locked fails closed (TRUE) when
--     locking.match_prediction_window_minutes config row is absent.
-- ===========================================================================
-- Save the locking-window row.
INSERT INTO _t068_state (name, saved_value)
SELECT 'locking_window', value
  FROM public.tournament_config
 WHERE key = 'locking.match_prediction_window_minutes';

-- Insert a synthetic scheduled match +60 minutes in the future. The
-- synthetic uuid 0...1066...02 is T068-scoped (1066 hex roughly resembles
-- "T068") and does not collide with seeded matches or with the +75min
-- fixture used by locking_window_consumer_check.sql (which uses
-- gen_random_uuid()). Stage='group' + group_id='A' satisfies the
-- matches_group_id_consistency CHECK at slot 0020 L86..L87. Team FKs use
-- the same LIMIT/OFFSET pattern as the sibling T032 test.
--
-- Under a healthy 60-min config, kickoff_utc=now()+60min sits exactly at
-- the lock boundary -- BR-LOCK-002's strict >= comparator would treat
-- this as locked. To avoid an ambiguous boundary case, we use +120min
-- (well outside any reasonable lock window) so a healthy config would
-- definitively return FALSE and only the fail-closed branch can produce
-- TRUE.
INSERT INTO public.matches (
  id, home_team_id, away_team_id, stage, group_id,
  kickoff_utc, status
)
VALUES (
  '00000000-0000-0000-1066-000000000002'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '120 minutes',
  'scheduled'::public.match_status
);

-- Now delete the locking-window config. Under a healthy config the
-- +120min match would return FALSE (120 > any reasonable window). With
-- the row deleted, the EXCEPTION trap at slot 0077 L1131..L1135 catches
-- WCG06 and RETURNs true.
DELETE FROM public.tournament_config
 WHERE key = 'locking.match_prediction_window_minutes';

SELECT is(
  public.is_prediction_locked(
    '00000000-0000-0000-1066-000000000002'::uuid
  ),
  true,
  'A4: is_prediction_locked returns TRUE when locking window config absent (fail-closed)'
);

-- Restore the locking-window row (defense in depth -- see A3 commentary).
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES (
  'locking.match_prediction_window_minutes',
  (SELECT saved_value FROM _t068_state WHERE name = 'locking_window'),
  now()
)
ON CONFLICT (key) DO NOTHING;

SELECT * FROM finish();

ROLLBACK;
