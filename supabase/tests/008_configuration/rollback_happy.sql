-- rollback_happy.sql
-- Slice 008 Tournament Configuration | Task T049 | US5 (Rollback)
--
-- Spec anchors:
--   spec.md § US5 -- "Admin rolls back a configuration value to an earlier
--   version." The rollback RPC (admin_config_rollback) MUST create a NEW
--   tournament_config_versions row carrying change_kind='admin_rollback' and
--   parent_version_id = the targeted ancestor; tournament_config.value MUST
--   be stamped to the targeted ancestor's new_value (NOT the value present
--   when the targeted version was authored, but the new_value field on the
--   ancestor version row -- i.e. "the value AFTER the targeted change").
--   The audit trail MUST carry one row per write (two forward upserts + one
--   rollback = three rows on the action='tournament_config.<key>' channel).
--
-- Contract source of truth:
--   contracts/admin-config-rpcs.write.md § Behavior -- admin_config_rollback:
--     - is_admin gate (slot 0077 L1705..L1720) -- not exercised here; see T050.
--     - Reason required (L1723..L1726) -- not exercised here; see T050.
--     - Target version must exist (L1729..L1737) -- not exercised here.
--     - Retention horizon (L1740..L1744) -- not exercised here.
--     - Atomic 3-write (L1763..L1803):
--         audit_log.action       = 'tournament_config.' || v_target_key
--         audit_log.previous_value = current tournament_config.value
--         audit_log.new_value      = v_target.new_value
--         audit_log.reason         = 'Rollback to version ' || target_id || ': ' || p_reason
--         tournament_config_versions.change_kind       = 'admin_rollback'
--         tournament_config_versions.parent_version_id = p_target_version_id
--         tournament_config_versions.previous_value    = current value (the one being rolled back FROM)
--         tournament_config_versions.new_value         = target.new_value (the one being restored)
--         tournament_config.value                      = target.new_value
--         tournament_config.version_id                 = new versions row's id
--
-- Implementation reference: supabase/migrations/0077_configuration.sql §
-- T046 admin_config_rollback (L1681..L1808) and § T011 admin_config_upsert
-- (L460..L633) -- both write to the same audit_log action channel
-- ('tournament_config.' || key), so the three-row count assertion (A6)
-- exercises the full forward+forward+rollback audit chain.
--
-- GREEN-by-design: T046 (admin_config_rollback) and T011 (admin_config_upsert)
-- both shipped in slot 0077; T049 is a happy-path regression gate, NOT a
-- failing TDD red. All assertions should pass on a freshly migrated DB.
--
-- Test plan (plan(7) -- see per-assertion comments below):
--   A1: tournament_config_versions row for v3 carries change_kind='admin_rollback'.
--   A2: tournament_config_versions row for v3 carries parent_version_id = v1.
--   A3: tournament_config.value for the key is now '15'::jsonb (the value at
--       v1's new_value field, NOT the pre-test initial value, NOT '20').
--   A4: tournament_config.version_id for the key is now v3 (the rollback row,
--       NOT v1 -- rollback creates a forward-only NEW version, it does not
--       rewind the pointer to an earlier version_id).
--   A5: tournament_config_versions row for v3 carries previous_value='20'
--       (the value BEFORE the rollback was applied -- i.e. v2's new_value).
--   A6: tournament_config_versions row for v3 carries new_value='15'
--       (the value AFTER the rollback, == v1's new_value, == target's
--       new_value). Together with A5 this proves the rollback row records
--       the actual delta, not the v1->v2 delta.
--   A7: audit_log carries exactly 3 rows on the
--       action='tournament_config.scoring.match_points.exact' channel
--       written since the test start barrier (two from the forward upserts,
--       one from the rollback). The rollback's audit row's reason starts
--       with 'Rollback to version ' (RPC body prefixes p_reason).
--
-- Out of scope (covered by sibling tasks):
--   * T050 rollback_validation.sql -- WCG07/WCG02/WCG03/WCG04 error paths.
--   * T024/T025/T026 -- generic upsert authorization / concurrency / validation.
--   * T036 scoring_consumer_check.sql -- compute_match_score config_read flip.
--
-- Impersonation pattern (mirrors scoring_consumer_check.sql / get_secret_authorization.sql):
--   admin_config_upsert, admin_config_preview, admin_config_rollback are all
--   SECURITY DEFINER and gate on is_admin(auth.uid()). We set JWT claims to
--   admin1's auth_user_id (slot 0074 seeded) and SET LOCAL ROLE authenticated
--   so the privilege evaluation matches a real PostgREST call. The reads
--   in the assertion phase happen under the default postgres role (after
--   RESET ROLE) so RLS on tournament_config / tournament_config_versions /
--   audit_log does not gate the SELECTs.
--
-- Fixture choice:
--   Key: scoring.match_points.exact (seeded by slot 0077 L298 to '10'::jsonb).
--   Mutation chain: initial(10) -> v1(15) -> v2(20) -> v3(rollback->15).
--   The 008 fixture stack does NOT seed score_records, so the scoring branch
--   of admin_config_preview (slot 0077 L881..L898) returns affecting=false
--   for all three upserts -- the upsert RPC's Step 8 (L587 IF block) does
--   not fire and a NULL acknowledge_token would suffice. Following the
--   defensive pattern from scoring_consumer_check.sql, we still call
--   admin_config_preview before each upsert and forward whatever token it
--   produces (NULL today, real uuid if a future fixture starts seeding
--   score_records).
--
-- Fixture uuids (slice 001 seed + slot 0074 bootstrap):
--   * admin1  (admin)  auth_user_id 00000000-0000-0000-0000-0000000000d3
--
-- Pattern: BEGIN / plan(7) / DO-block setup writes captured v1/v2/v3 + the
-- initial seed into a TEMP table (_t049_state) / asserts read from the temp
-- table JOIN'd against the persisted state / finish / ROLLBACK. The ROLLBACK
-- discards every audit_log/versions/config mutation written during the test
-- AND drops the temp table, so the test is fully re-runnable.

BEGIN;

SELECT plan(7);

-- Capture the test start time as a session-local boundary so the A7
-- audit-row count can exclude any pre-existing rows on the same action
-- channel. is_local=false because we need it visible across all assertions.
SELECT set_config('test.start_ts', clock_timestamp()::text, false);

-- Scratch table for ferrying v1/v2/v3 + the initial version_id out of the
-- DO block so pgTAP assertions can reference them.  ON COMMIT DROP would
-- fire at the ROLLBACK boundary anyway (temp tables are session-scoped),
-- but the explicit declaration documents the lifetime.
CREATE TEMP TABLE _t049_state (
  name  text PRIMARY KEY,
  v_id  bigint,
  v_val jsonb
) ON COMMIT DROP;

-- ---------------------------------------------------------------------------
-- Setup: switch to admin1 + authenticated role and execute the upsert chain
-- + rollback in a single DO block. We capture v_initial (the seed version
-- _id), v1 (after upsert 10->15), v2 (after upsert 15->20), and v3 (the
-- rollback version_id) into the _t049_state temp table for assertion-phase
-- access. Each upsert mints a fresh acknowledge_token via admin_config_preview
-- (NULL in the current fixture stack -- score_records is unseeded -- but
-- forwarded defensively per the scoring_consumer_check.sql pattern).
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

DO $$
DECLARE
  v_initial_version bigint;
  v_initial_value   jsonb;
  v_token_a         uuid;
  v_token_b         uuid;
  v1                bigint;
  v2                bigint;
  v3                bigint;
BEGIN
  -- Capture the seed row's version_id + value. The seed is slot 0077 L298
  -- ('10'::jsonb). We do not assert this is == 10 here (that would be the
  -- A0 pattern from scoring_consumer_check.sql); the rollback test only
  -- cares about the version chain, not the initial scalar.
  SELECT version_id, value
    INTO v_initial_version, v_initial_value
    FROM public.tournament_config
   WHERE key = 'scoring.match_points.exact';

  INSERT INTO _t049_state(name, v_id, v_val)
    VALUES ('initial', v_initial_version, v_initial_value);

  -- ---- Forward upsert 1: initial(10) -> 15 ----
  -- Preview first to mint an acknowledge_token. The scoring.match_points.*
  -- branch (slot 0077 L881..L898) only flags affecting=true when score_records
  -- has > 0 rows; in this fixture it does not, so the returned token is
  -- NULL and the upsert's Step 8 (L587) short-circuits. Capture the token
  -- anyway for forward compatibility (per scoring_consumer_check.sql).
  v_token_a := (
    public.admin_config_preview(
      'scoring.match_points.exact'::text,
      '15'::jsonb
    ) ->> 'acknowledge_token'
  )::uuid;

  v1 := public.admin_config_upsert(
    'scoring.match_points.exact'::text,
    '15'::jsonb,
    v_initial_version,
    'T049 forward upsert 10->15'::text,
    'specs/008-configuration/tasks.md#T049'::text,
    v_token_a
  );

  INSERT INTO _t049_state(name, v_id, v_val) VALUES ('v1', v1, '15'::jsonb);

  -- ---- Forward upsert 2: 15 -> 20 ----
  -- Mint a FRESH token. Acknowledge tokens are single-use per (key, value)
  -- pair, and the value is now changing (15 -> 20) so a new digest is
  -- required regardless. In the current fixture stack this is again NULL.
  v_token_b := (
    public.admin_config_preview(
      'scoring.match_points.exact'::text,
      '20'::jsonb
    ) ->> 'acknowledge_token'
  )::uuid;

  v2 := public.admin_config_upsert(
    'scoring.match_points.exact'::text,
    '20'::jsonb,
    v1,
    'T049 forward upsert 15->20'::text,
    'specs/008-configuration/tasks.md#T049'::text,
    v_token_b
  );

  INSERT INTO _t049_state(name, v_id, v_val) VALUES ('v2', v2, '20'::jsonb);

  -- ---- Rollback: undo to v1 ----
  -- admin_config_rollback (slot 0077 L1681..L1808) does NOT consume an
  -- acknowledge_token (its impact contract is "restore an already-vetted
  -- ancestor"; preview/ack is a forward-upsert concept). p_source_citation
  -- is OPTIONAL on the rollback RPC even for security-sensitive keys --
  -- slot 0077 L1681..L1684 does not enforce the L552..L559 prefix check.
  -- We pass NULL here to exercise that branch.
  v3 := public.admin_config_rollback(
    v1,
    'T049 rollback v2->v1'::text,
    NULL
  );

  INSERT INTO _t049_state(name, v_id, v_val) VALUES ('v3', v3, '15'::jsonb);
END;
$$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A1: the rollback's versions row carries change_kind='admin_rollback'.
-- Slot 0077 L1789 hard-codes this literal; any drift (e.g. someone adds a
-- new 'admin_rollback_v2' kind) breaks this assertion and forces a contract
-- review.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT change_kind
     FROM public.tournament_config_versions
    WHERE version_id = (SELECT v_id FROM _t049_state WHERE name = 'v3')),
  'admin_rollback',
  'A1: v3 versions row carries change_kind=''admin_rollback'''
);

-- ---------------------------------------------------------------------------
-- A2: the rollback's versions row's parent_version_id == v1 (the targeted
-- ancestor). Slot 0077 L1794 wires this to p_target_version_id. This is the
-- forensic linkage that lets config_version_history (T047) draw the
-- "rolled back to" arrow in the timeline UI (T020).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT parent_version_id
     FROM public.tournament_config_versions
    WHERE version_id = (SELECT v_id FROM _t049_state WHERE name = 'v3')),
  (SELECT v_id FROM _t049_state WHERE name = 'v1'),
  'A2: v3 versions row carries parent_version_id = v1'
);

-- ---------------------------------------------------------------------------
-- A3: tournament_config.value is now '15'::jsonb. Slot 0077 L1800 stamps
-- v_target_value (= v1's new_value, which the forward upsert at L617 set to
-- p_value='15'::jsonb) onto the row. Critically, this is NOT the initial
-- seed value ('10') -- it is the value AFTER v1's forward change. This is
-- the contract distinction the task spec calls out explicitly: rollback
-- restores the value AS OF the targeted version's new_value field, not the
-- previous_value field; the targeted version's new_value IS the "state after"
-- snapshot.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT value
     FROM public.tournament_config
    WHERE key = 'scoring.match_points.exact'),
  '15'::jsonb,
  'A3: tournament_config.value = ''15''::jsonb after rollback to v1'
);

-- ---------------------------------------------------------------------------
-- A4: tournament_config.version_id is now v3 (the rollback row), NOT v1.
-- Slot 0077 L1801 stamps v_new_version (the version_id RETURNed by the
-- versions INSERT at L1796). The version chain is forward-only: rollback
-- creates a NEW version pointing back at v1 via parent_version_id; it
-- never rewinds the pointer to v1 itself. This invariant is what lets
-- audit forensics list "every change ever made" without gaps.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT version_id
     FROM public.tournament_config
    WHERE key = 'scoring.match_points.exact'),
  (SELECT v_id FROM _t049_state WHERE name = 'v3'),
  'A4: tournament_config.version_id = v3 (forward-only chain, not rewound to v1)'
);

-- ---------------------------------------------------------------------------
-- A5: the rollback's versions row's previous_value = '20' (the value
-- present in tournament_config BEFORE the rollback ran, i.e. v2's new_value).
-- Slot 0077 L1787 wires this to v_current_value, captured at L1750..L1754
-- via SELECT ... FOR UPDATE. This is the BEFORE side of the rollback's
-- delta; together with A6 it proves the rollback's versions row records
-- the v2->v1 transition correctly (not, for example, the v1->v2 delta).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT previous_value
     FROM public.tournament_config_versions
    WHERE version_id = (SELECT v_id FROM _t049_state WHERE name = 'v3')),
  '20'::jsonb,
  'A5: v3 versions row previous_value = ''20''::jsonb (pre-rollback value)'
);

-- ---------------------------------------------------------------------------
-- A6: the rollback's versions row's new_value = '15' (== v1's new_value).
-- Slot 0077 L1788 wires this to v_target_value, captured at L1729..L1732
-- from tournament_config_versions WHERE version_id = p_target_version_id.
-- Together with A5 this proves the rollback row's delta is v2(20) -> v1(15)
-- as required by the contract. Also cross-checks against the v1 row's
-- new_value to make the linkage explicit (rather than just literal '15').
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT new_value
     FROM public.tournament_config_versions
    WHERE version_id = (SELECT v_id FROM _t049_state WHERE name = 'v3')),
  (SELECT new_value
     FROM public.tournament_config_versions
    WHERE version_id = (SELECT v_id FROM _t049_state WHERE name = 'v1')),
  'A6: v3 versions row new_value = v1 versions row new_value (= ''15''::jsonb)'
);

-- ---------------------------------------------------------------------------
-- A7: composite assertion -- exactly 3 audit_log rows on the
-- action='tournament_config.scoring.match_points.exact' channel since the
-- test start barrier, AND the most recent one (the rollback) has a reason
-- starting with 'Rollback to version '. Slot 0077 L1774 prefixes p_reason
-- with the literal 'Rollback to version <id>: '; the two forward upserts
-- at L599..L608 wrote the bare p_reason. The COUNT half is the headline
-- "audit_log has 3 rows" check from the task spec; the prefix half pins
-- the contract distinction between forward and rollback audit reasons.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT json_build_object(
            'count',         count(*),
            'rollback_prefixed',
            bool_or(reason LIKE 'Rollback to version %' AND action = 'tournament_config.scoring.match_points.exact')
          )::jsonb
     FROM public.audit_log
    WHERE action = 'tournament_config.scoring.match_points.exact'
      AND occurred_at >= current_setting('test.start_ts')::timestamptz),
  '{"count": 3, "rollback_prefixed": true}'::jsonb,
  'A7: audit_log has exactly 3 rows on the channel + rollback row carries the ''Rollback to version '' prefix'
);

SELECT * FROM finish();

ROLLBACK;
