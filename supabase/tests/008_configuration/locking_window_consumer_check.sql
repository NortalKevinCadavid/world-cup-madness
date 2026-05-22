-- locking_window_consumer_check.sql
-- Slice 008 Tournament Configuration | Task T032 | US2 (Match-prediction lock window)
--
-- Spec anchors:
--   spec.md  US2 -- "Admin updates the match-prediction lock window from 60 to
--   90 minutes; Slice 003's is_prediction_locked must observe the new value
--   within 1 minute (SC-005). The redefinition in T015 lifts the legacy
--   hard-coded 'lock_window_minutes' lookup and replaces it with a read of the
--   new namespaced key 'locking.match_prediction_window_minutes' via
--   config_read." This task verifies that consumer migration end-to-end: same
--   match_id, same now() snapshot inside the txn, but the predicate output
--   flips after an admin_config_upsert moves the window across the 75-minute
--   horizon.
--
-- Contract source of truth:
--   contracts/admin-config-rpcs.write.md  Behavior -- admin_config_upsert:
--     - On success appends one row to tournament_config_versions and bumps
--       tournament_config.version_id (see slot 0077 L611..629).
--     - For 'locking.match_prediction_window_minutes' the preview branch at
--       slot 0077 L822..858 sets affecting=true when there is a scheduled
--       match in the (min(old,new), max(old,new)] window from now(). Our
--       fixture match (75 min out) sits inside (60, 90] AND inside (30, 90],
--       so both upserts below MUST present an acknowledge_token (WCG05).
--   contracts/prediction-lock.predicate.sql.md  Behavior -- is_prediction_locked:
--     - Returns true iff now() >= kickoff_utc - v_minutes * INTERVAL '1 minute'.
--     - v_minutes is read fresh from 'locking.match_prediction_window_minutes'
--       on every call (no caching) -- this is precisely what T015 enforces.
--
-- Implementation references (slot 0077):
--   * T015 redefine is_prediction_locked: L1101..L1148 (signature preserved
--     per Principle XI -- still public.is_prediction_locked(uuid) RETURNS
--     boolean STABLE; SECURITY INVOKER).
--   * T010 seed default 60: L287..L289 (initial_seed version row backfilled
--     for the key during T010's two-step seed pass).
--   * admin_config_upsert: L460..L633.
--   * admin_config_preview (locking branch): L822..L858.
--
-- Test plan (plan(5) -- five assertions across A0..A4):
--   A0: Pre-flight -- the seeded default for the lock-window key is 60. If
--       this ever changes the rest of the math (60-min unlocked, 90-min
--       locked, 30-min unlocked) needs revisiting, so we gate on it
--       deterministically rather than computing the window on the fly.
--   A1: With the default 60-min window and a scheduled match 75 min away,
--       is_prediction_locked returns FALSE (75 > 60). This is the BASELINE
--       under the migrated function body -- proving the function actually
--       reads the new namespace and not the legacy 'lock_window_minutes'
--       key, because the legacy key is not touched anywhere in this test.
--   A2: After upserting the window to 90, the same match (same id, same
--       kickoff_utc, same now() snapshot) is now LOCKED (75 < 90). This is
--       the FLIP from A1 -- the assertion T032 was authored to demonstrate.
--       The intermediate admin_config_preview call mints the
--       acknowledge_token required by Step 8 of admin_config_upsert because
--       our fixture match is inside the affecting window (60 < 75 <= 90).
--   A3: After upserting the window to 30, the match is unlocked again
--       (75 > 30). Three points worth: (1) the flip is reversible end-to-end
--       through the RPC, (2) is_prediction_locked has no stale-snapshot bug,
--       (3) downstream slices (Slice 003 submit_prediction) inherit this
--       responsiveness automatically because they call is_prediction_locked
--       inline rather than caching a window value.
--   A4: tournament_config_versions has at least 3 rows for the key after
--       the test sequence: 1 row from T010 initial_seed + 2 from the upserts
--       above. The atomic 3-write contract (audit_log + versions +
--       tournament_config) guarantees each upsert appends exactly one
--       versions row, and the seed pass guarantees the baseline row exists.
--       We use >=3 (not =3) so this test stays robust if a future migration
--       inserts additional initial_seed-style backfills before T032 runs.
--
-- Out of scope (covered by sibling tasks):
--   * T024/T025/T026 -- generic upsert authorization / concurrency / validation
--     paths (WCG07/WCG01/WCG02). T032 only exercises the happy path.
--   * T031 (Playwright config-locking.spec.ts) -- the user-facing flow including
--     the participant submit retry post-flip. T032 is the DB-layer regression
--     gate, not the UX-layer gate.
--   * The legacy 'lock_window_minutes' key behavior (slice 003 slot 0035) --
--     superseded by T015 and not read by the new function body.
--
-- Impersonation pattern:
--   admin_config_upsert is SECURITY DEFINER and gates on is_admin(auth.uid())
--   at Step 1 (slot 0077 L487..L502). The match INSERT must happen as the
--   pgTAP postgres role because slot 0026 REVOKEs INSERT on public.matches
--   from authenticated. We therefore do the INSERT first (no role switch),
--   then SET LOCAL ROLE authenticated with admin1's JWT claims for the
--   preview/upsert calls, and RESET ROLE between RPC calls so each one
--   starts from the same role baseline. Slice 001 fixture seeds admin1 with
--   auth_user_id = 00000000-0000-0000-0000-0000000000d3 (mirrors
--   eligibility_preview_affecting.sql / upsert_concurrency.sql).
--
-- Fixture choices:
--   * gen_random_uuid() for match id -- no overlap risk with any seeded
--     fixture; the ROLLBACK envelope guarantees no leak into other tests.
--   * (SELECT id FROM public.teams LIMIT 1) / OFFSET 1 for the two team FKs
--     -- slice 002 seed (supabase/seed/slice-002-fixture.sql) populates
--     public.teams with the full WC2026 roster, so LIMIT/OFFSET always
--     resolve. Pattern matches supabase/tests/pgtap/is_prediction_locked_*.
--   * stage='group' + group_id='A' satisfies the matches_group_id_consistency
--     CHECK (slot 0020 L86..L87): (stage='group') <=> (group_id IS NOT NULL).
--   * kickoff_utc = now() + 75 minutes -- a single anchor inside (60, 90]
--     AND inside (30, 90]. This is the SAME 75-minute horizon US2's
--     independent test calls out, so the regression matches the spec example.
--   * status='scheduled' -- BR-LOCK-004 short-circuits to true for any
--     non-scheduled status, which would mask the config-driven branch we
--     are testing.
--
-- Pattern: BEGIN / plan(5) / asserts / finish / ROLLBACK. The ROLLBACK
-- discards: the synthetic match, the two tournament_config_versions rows,
-- the audit_log rows written by both upserts, the _admin_acknowledge_tokens
-- rows minted by both previews, and the version_id bumps on the
-- tournament_config row. Test isolation matches the sibling 008 files.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Setup A: synthesize a scheduled match 75 minutes from now under the
-- default postgres role (slot 0026 REVOKEs INSERT on public.matches from
-- authenticated, so this MUST happen before SET LOCAL ROLE authenticated).
-- gen_random_uuid stashed in a session-scoped GUC so subsequent assertions
-- can reach the same id after RESET ROLE / SET LOCAL ROLE cycles.
-- ---------------------------------------------------------------------------
SELECT set_config('test.match_id', gen_random_uuid()::text, false);

INSERT INTO public.matches (
  id, home_team_id, away_team_id, stage, group_id,
  kickoff_utc, status
)
VALUES (
  current_setting('test.match_id')::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '75 minutes',
  'scheduled'::public.match_status
);

-- ---------------------------------------------------------------------------
-- Setup B: capture default window value for A0. value::text on jsonb '60'
-- yields the textual '60'; cast through int to validate it parses as a
-- number, then back to text for storage in the session GUC. Defending the
-- assertion this way means any seed drift (e.g. someone changes the slot
-- 0077 seed from 60 to 75) fails A0 explicitly rather than silently
-- masquerading as a flip-direction bug in A1.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'test.default_window',
  (SELECT (value::text)::int::text
     FROM public.tournament_config
    WHERE key = 'locking.match_prediction_window_minutes'),
  false
);

-- ---------------------------------------------------------------------------
-- A0: seeded default is 60 minutes. Slot 0077 L287..L289 INSERTs '60'::jsonb
-- with ON CONFLICT DO NOTHING. If a prior slice had already seeded the key
-- (it had not -- this namespace is brand-new in slice 008) the value could
-- diverge; cmp_ok with explicit ::int cast guards against textual surprises.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  current_setting('test.default_window')::int,
  '=', 60::int,
  'A0: locking.match_prediction_window_minutes default is 60 minutes'
);

-- ---------------------------------------------------------------------------
-- A1: under 60-min window, 75-min-away match is NOT locked. The function
-- body (slot 0077 L1146) computes now() >= kickoff_utc - 60min. With
-- kickoff_utc = now()+75min the comparison is now() >= now()+15min -> false.
-- This call also indirectly proves T015 reads the new namespace -- the
-- seed pass at slot 0077 T010 left the legacy 'lock_window_minutes' key
-- untouched at its slice-003 default (also 60), so a regression that
-- accidentally read the legacy key would PASS this assertion. We rely on
-- A2/A3 (which only mutate the new key) to catch that regression.
-- ---------------------------------------------------------------------------
SELECT is(
  public.is_prediction_locked(current_setting('test.match_id')::uuid),
  false,
  'A1: under 60-min window, 75-min-away match is NOT locked'
);

-- ---------------------------------------------------------------------------
-- Switch to admin1 + authenticated role for the preview/upsert RPCs.
-- admin_config_preview at slot 0077 L760..L772 and admin_config_upsert at
-- L487..L502 both gate on is_admin(auth.uid()); slice 006 fixture grants
-- admin1 (auth_user_id ...000d3) is_admin=true. is_local=true on the JWT
-- claims means the value is dropped on ROLLBACK, which is desired.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);

-- Capture the current version_id before the first upsert so the optimistic
-- concurrency check (Step 7) passes deterministically.
SELECT set_config(
  'test.expected_v',
  (SELECT version_id::text
     FROM public.tournament_config
    WHERE key = 'locking.match_prediction_window_minutes'),
  false
);

-- ---------------------------------------------------------------------------
-- Preview call #1: 60 -> 90. Our fixture match sits at +75min, i.e. inside
-- the (least(60,90), greatest(60,90)] = (60, 90] window evaluated at L835..
-- L837. v_count therefore >= 1, v_affecting flips to true, and L928..L930
-- issues an acknowledge_token. Without this token Step 8 of the upsert
-- would raise WCG05 -- exactly the WAR-PIT case in contracts/admin-config-
-- rpcs.write.md.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;

SELECT set_config(
  'test.ack_token_1',
  (SELECT (public.admin_config_preview(
            'locking.match_prediction_window_minutes'::text,
            '90'::jsonb
          ) ->> 'acknowledge_token')),
  false
);

-- Upsert 60 -> 90 with the freshly minted token.
SELECT public.admin_config_upsert(
  'locking.match_prediction_window_minutes'::text,
  '90'::jsonb,
  current_setting('test.expected_v')::bigint,
  'T032 lock window test -- flip to 90'::text,
  'specs/008-configuration/tasks.md#T032'::text,
  current_setting('test.ack_token_1')::uuid
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: under 90-min window, 75-min-away match IS locked. The function body
-- now computes now() >= kickoff_utc - 90min = now()+75min - 90min =
-- now()-15min, which is always true. is_prediction_locked has no caching
-- (STABLE within a single statement only -- a new statement re-evaluates),
-- so this call observes the version_id we just bumped. The match row is
-- identical to A1; the only mutation between the two is the config upsert,
-- so this assertion is the regression-gate for T015 reading config_read.
-- ---------------------------------------------------------------------------
SELECT is(
  public.is_prediction_locked(current_setting('test.match_id')::uuid),
  true,
  'A2: under 90-min window, 75-min-away match IS locked (flip from A1)'
);

-- ---------------------------------------------------------------------------
-- Second upsert: 90 -> 30. Capture the new version_id (it was bumped by the
-- prior upsert) and mint a fresh acknowledge_token via preview. The match
-- is at +75min, which is inside (least(90,30), greatest(90,30)] = (30, 90],
-- so this preview also returns affecting=true (token required).
-- ---------------------------------------------------------------------------
SELECT set_config(
  'test.expected_v_2',
  (SELECT version_id::text
     FROM public.tournament_config
    WHERE key = 'locking.match_prediction_window_minutes'),
  false
);

SET LOCAL ROLE authenticated;

SELECT set_config(
  'test.ack_token_2',
  (SELECT (public.admin_config_preview(
            'locking.match_prediction_window_minutes'::text,
            '30'::jsonb
          ) ->> 'acknowledge_token')),
  false
);

SELECT public.admin_config_upsert(
  'locking.match_prediction_window_minutes'::text,
  '30'::jsonb,
  current_setting('test.expected_v_2')::bigint,
  'T032 lock window test -- flip to 30'::text,
  'specs/008-configuration/tasks.md#T032'::text,
  current_setting('test.ack_token_2')::uuid
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A3: under 30-min window, 75-min-away match is NOT locked. The function
-- body computes now() >= kickoff_utc - 30min = now()+45min, which is
-- always false. This is the SECOND flip (A2 -> A3) and proves the
-- predicate is symmetric: it both locks AND unlocks in response to config
-- changes, which is exactly the BR-LOCK-002 guarantee Slice 003 promised
-- before slice 008 took ownership of the window value.
-- ---------------------------------------------------------------------------
SELECT is(
  public.is_prediction_locked(current_setting('test.match_id')::uuid),
  false,
  'A3: under 30-min window, 75-min-away match is NOT locked (returned to open)'
);

-- ---------------------------------------------------------------------------
-- A4: tournament_config_versions accumulates >= 3 rows for the key over
-- the lifetime of the test (initial_seed from T010 + two admin_upsert rows
-- from above). Slot 0077 L611..L621 INSERTs exactly one versions row per
-- successful upsert, and L621's RETURNING into v_new_version is the value
-- written back to tournament_config.version_id at L628. We use >=3 (not =3)
-- because future migrations might add another initial_seed-style row
-- (e.g. a corrective backfill); the invariant we care about here is "every
-- upsert appended a row", not the exact baseline count.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  (SELECT count(*)
     FROM public.tournament_config_versions
    WHERE key = 'locking.match_prediction_window_minutes'),
  '>=', 3::bigint,
  'A4: >= 3 versions for the lock window key (initial_seed + 2 upserts)'
);

SELECT * FROM finish();
ROLLBACK;
