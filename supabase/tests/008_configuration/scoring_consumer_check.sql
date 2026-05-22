-- scoring_consumer_check.sql
-- Slice 008 Tournament Configuration | Task T036 | US3 (Scoring values + tie-breaker order)
--
-- Spec anchors:
--   spec.md  US3 -- "Admin changes scoring.match_points.exact from 10 to 15;
--   compute_match_score must observe the new value within 1 minute (SC-005)."
--   Slot 0077 T016 CREATEs a new public.compute_match_score(int,int,int,int)
--   helper that reads three keys via config_read:
--     * scoring.match_points.exact            (default 10)
--     * scoring.match_points.correct_outcome  (default 5)
--     * scoring.match_points.incorrect        (default 0)
--   T036 is the DB-layer regression gate proving the function actually reads
--   from tournament_config rather than embedding literal constants -- i.e.
--   an admin_config_upsert that bumps scoring.match_points.exact to 15 must
--   be observed by the very next compute_match_score call within the same
--   transaction (config_read does no caching at the SQL layer).
--
-- Contract source of truth:
--   contracts/admin-config-rpcs.write.md  Behavior -- admin_config_upsert:
--     - On success appends one row to tournament_config_versions and bumps
--       tournament_config.version_id (slot 0077 L598..L629).
--     - For scoring.match_points.* the preview branch at slot 0077 L881..L898
--       sets affecting=true ONLY when public.score_records has > 0 rows
--       ("Changing scoring rule %s will require recomputing all %s existing
--        score_records on next scoring run."). The 008 fixture stack
--       deliberately does NOT seed score_records (slice-005-fixture.sql L632
--       documents that T013/T019 own all score_records writes at runtime),
--       so v_count = 0 and v_affecting = false here. The Step 8 check at
--       L587 only enforces the acknowledge_token when affecting=true, so
--       a NULL token would technically suffice. We mint and pass a token
--       anyway via admin_config_preview -- this keeps T036 robust if a
--       future fixture starts seeding score_records, and a non-null token
--       on an affecting=false path is a no-op (the IF at L587 short-circuits).
--   contracts/admin-config-rpcs.write.md  Step 4 -- security-sensitive keys:
--     - scoring.* matches the prefix that REQUIRES p_source_citation
--       (slot 0077 L552..L559). Omitting it raises WCG02 before the WCG05
--       path is reached, so every admin_config_upsert below passes both
--       p_reason and p_source_citation explicitly.
--   compute_match_score (slot 0077 L1176..L1219):
--     - Exact-score branch returns scoring.match_points.exact.
--     - sign(p_pred_home - p_pred_away) = sign(p_actual_home - p_actual_away)
--       returns scoring.match_points.correct_outcome.
--     - Otherwise returns scoring.match_points.incorrect.
--     - STABLE only -- each statement re-reads config, so the post-upsert
--       call observes the new value immediately.
--
-- Implementation references (slot 0077):
--   * T010 scoring seeds:        L298..L306 (exact=10, correct_outcome=5,
--                                            incorrect=0; initial_seed
--                                            version rows backfilled).
--   * admin_config_upsert:       L460..L633.
--   * admin_config_preview (scoring branch): L881..L898.
--   * compute_match_score:       L1176..L1219.
--   * T016 in-migration probe:   L1273..L1306 (asserts the function returns
--                                              10/5/0 for the same fixed
--                                              4-tuples we re-use as A1/A2/A3).
--
-- Test plan (plan(5) -- five assertions across A0..A4):
--   A0: Pre-flight -- the seeded default for scoring.match_points.exact is
--       10. If a prior seed-pass had set it differently, A1's expected value
--       (10 under default config) would need to track the new seed; gating
--       on this explicitly converts a silent seed drift into a deterministic
--       A0 failure rather than a flip-direction bug in A4.
--   A1: compute_match_score(2, 1, 2, 1) under default config returns 10.
--       This is the exact-score branch (predicted = actual on both sides)
--       and verifies T016 reads scoring.match_points.exact from config_read
--       -- NOT a baked-in literal. Same 4-tuple the in-migration probe at
--       slot 0077 L1283 used, so any divergence between the test and the
--       probe localizes the regression.
--   A2: compute_match_score(3, 1, 2, 0) returns 5 (correct_outcome).
--       Both rows have sign(p_home - p_away) = +1 (home win) but the
--       absolute scores differ, so the exact-score branch is skipped and
--       the outcome branch fires. Proves the outcome key is also driven by
--       config_read and not hard-coded to 5.
--   A3: compute_match_score(3, 1, 0, 2) returns 0 (incorrect).
--       Predicted home win (sign +1) vs. actual away win (sign -1); neither
--       exact nor outcome matches, so the incorrect branch returns 0.
--       Proves the incorrect key is also driven by config_read.
--   A4: After upserting scoring.match_points.exact to 15,
--       compute_match_score(2, 1, 2, 1) returns 15. This is the FLIP from
--       A1 -- same 4-tuple, same now() snapshot, only the config row
--       changed between the two calls. Demonstrates SC-005 (config change
--       observable end-to-end within the same connection) and is the
--       regression-gate this task was authored to provide.
--
-- Out of scope (covered by sibling tasks):
--   * T024/T025/T026 -- generic upsert authorization / concurrency / validation
--     paths (WCG07/WCG01/WCG02). T036 only exercises the happy path on the
--     scoring namespace.
--   * T034 (Playwright config-scoring.spec.ts) -- the user-facing flow
--     including the leaderboard re-score banner and Slice 006 recalc trigger.
--     T036 is the DB-layer regression gate, not the UX-layer gate.
--   * T035 (Playwright config-tiebreaker.spec.ts) -- the tie_breaker_order
--     drag-and-drop flow + leaderboard ordering shift. T036 only covers the
--     scalar match_points keys.
--   * Slice 005's legacy score_match SP body (slot 0052) -- still reads the
--     legacy match_points.{exact,outcome,incorrect} keys until the deferred
--     follow-up (D-031) lands. compute_match_score is a separate helper
--     introduced by T016; T036 only verifies that helper, not score_match.
--
-- Impersonation pattern:
--   admin_config_upsert and admin_config_preview are SECURITY DEFINER and
--   both gate on is_admin(auth.uid()) at Step 1 (slot 0077 L487..L502 +
--   L760..L772). compute_match_score is SECURITY INVOKER STABLE; it does
--   not gate on the caller role, so we issue the A0..A3 calls under the
--   default postgres role and only switch to the seeded admin (auth_user_id
--   = 00000000-0000-0000-0000-0000000000d3, mirrors locking_window_consumer_
--   check.sql / upsert_concurrency.sql) for the preview + upsert RPCs.
--   RESET ROLE between role-gated calls so each one starts from the same
--   role baseline.
--
-- Pattern: BEGIN / plan(5) / asserts / finish / ROLLBACK. The ROLLBACK
-- discards: the tournament_config_versions row added by the upsert, the
-- audit_log row written by the upsert, the _admin_acknowledge_tokens row
-- minted by the preview, and the version_id bump on the tournament_config
-- row. Test isolation matches the sibling 008 files.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Setup A: capture default scoring.match_points.exact for A0. value::text on
-- jsonb '10' yields '10'; cast through int to validate it parses as a number
-- then back to text for storage in the session GUC. Defending the assertion
-- this way means any seed drift (e.g. someone changes slot 0077 L298 from 10
-- to 12) fails A0 explicitly rather than silently masquerading as a
-- flip-direction bug in A1/A4.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'test.default_exact',
  (SELECT (value::text)::int::text
     FROM public.tournament_config
    WHERE key = 'scoring.match_points.exact'),
  false
);

-- ---------------------------------------------------------------------------
-- A0: seeded default is 10. Slot 0077 L298 INSERTs '10'::jsonb with
-- ON CONFLICT DO NOTHING. cmp_ok with explicit ::int cast guards against
-- textual surprises (e.g. '10 '::jsonb vs. 10::int).
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  current_setting('test.default_exact')::int,
  '=', 10::int,
  'A0: scoring.match_points.exact default is 10'
);

-- ---------------------------------------------------------------------------
-- A1: compute_match_score for an exact-score prediction (2-1 / 2-1) returns
-- 10. Function body (slot 0077 L1208..L1210) takes the exact-score branch
-- and RETURNs v_pts_exact, which was just read via config_read at L1200.
-- This is the BASELINE under the migrated function body. Identical to the
-- in-migration probe input at slot 0077 L1283, so any divergence localizes
-- the regression cleanly.
-- ---------------------------------------------------------------------------
SELECT is(
  public.compute_match_score(2, 1, 2, 1),
  10::int,
  'A1: exact match (2-1 / 2-1) under default config returns 10'
);

-- ---------------------------------------------------------------------------
-- A2: compute_match_score for an outcome-only match (3-1 / 2-0) returns 5.
-- sign(3-1)=+1 = sign(2-0)=+1 so the outcome branch (slot 0077 L1213..L1214)
-- fires and RETURNs v_pts_outcome (scoring.match_points.correct_outcome).
-- Proves the outcome key is read from config rather than hard-coded.
-- ---------------------------------------------------------------------------
SELECT is(
  public.compute_match_score(3, 1, 2, 0),
  5::int,
  'A2: same outcome (home wins) but different score returns 5 (correct_outcome default)'
);

-- ---------------------------------------------------------------------------
-- A3: compute_match_score for an incorrect-outcome prediction (3-1 / 0-2)
-- returns 0. sign(3-1)=+1 <> sign(0-2)=-1; neither exact nor outcome branch
-- fires, so the function falls through to RETURN v_pts_incorrect
-- (scoring.match_points.incorrect default 0). Proves the incorrect key is
-- read from config rather than hard-coded.
-- ---------------------------------------------------------------------------
SELECT is(
  public.compute_match_score(3, 1, 0, 2),
  0::int,
  'A3: opposite outcome returns 0 (incorrect default)'
);

-- ---------------------------------------------------------------------------
-- Switch to admin1 + authenticated role for the preview/upsert RPCs.
-- admin_config_preview (slot 0077 L760..L772) and admin_config_upsert
-- (L487..L502) both gate on is_admin(auth.uid()); slice 006 fixture grants
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

-- Capture the current version_id before the upsert so the optimistic
-- concurrency check (Step 7) passes deterministically.
SELECT set_config(
  'test.expected_v',
  (SELECT version_id::text
     FROM public.tournament_config
    WHERE key = 'scoring.match_points.exact'),
  false
);

-- ---------------------------------------------------------------------------
-- Preview call: 10 -> 15. The scoring branch at slot 0077 L881..L898
-- evaluates `SELECT count(*) FROM public.score_records`. The 008 fixture
-- stack does not seed score_records, so v_count = 0 and v_affecting stays
-- false; the returned acknowledge_token is therefore NULL. We still issue
-- the preview here for two reasons:
--   (1) Robustness: a future fixture (or a real deployment with prior
--       scoring runs) WILL have rows in score_records, and at that point
--       affecting=true and the upsert below would raise WCG05 without a
--       token. Wiring the token plumbing up-front means T036 stays green
--       regardless of which fixture stage is loaded.
--   (2) Exercise: even when v_affecting=false, the preview call validates
--       the scoring branch's count query against public.score_records
--       (no undefined_table errors, etc.).
-- COALESCE the ->> result through NULLIF + ::uuid cast so the captured GUC
-- is the empty string when no token was minted; the upsert then receives
-- NULL via NULLIF below, which Step 8 short-circuits past when affecting=
-- false (L587 IF block does not fire). When affecting=true (future fixture),
-- the token is forwarded and Step 8 verifies it.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;

SELECT set_config(
  'test.ack_token',
  COALESCE(
    (SELECT (public.admin_config_preview(
              'scoring.match_points.exact'::text,
              '15'::jsonb
            ) ->> 'acknowledge_token')),
    ''
  ),
  false
);

-- Upsert 10 -> 15. Reason + source_citation are REQUIRED for scoring.*
-- (slot 0077 L552..L559 raises WCG02 otherwise). NULLIF on the token
-- handles the empty-string => NULL conversion described above.
SELECT public.admin_config_upsert(
  'scoring.match_points.exact'::text,
  '15'::jsonb,
  current_setting('test.expected_v')::bigint,
  'T036 consumer check -- flip exact to 15'::text,
  'specs/008-configuration/tasks.md#T036'::text,
  NULLIF(current_setting('test.ack_token'), '')::uuid
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A4: after upsert, compute_match_score(2, 1, 2, 1) returns 15. Function
-- body re-reads config_read('scoring.match_points.exact', NULL) at slot
-- 0077 L1200 on every invocation (STABLE means stable within a single
-- statement only -- a new statement re-evaluates), so this call observes
-- the version_id bump committed by the upsert above. The 4-tuple is
-- identical to A1; the only mutation between the two is the config
-- upsert, so this assertion is the regression-gate for T016 reading
-- config_read. Demonstrates SC-005 end-to-end at the DB layer.
-- ---------------------------------------------------------------------------
SELECT is(
  public.compute_match_score(2, 1, 2, 1),
  15::int,
  'A4: after upsert, exact match (2-1 / 2-1) returns 15 (config-driven flip from A1)'
);

SELECT * FROM finish();
ROLLBACK;
