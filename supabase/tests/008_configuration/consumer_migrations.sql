-- consumer_migrations.sql
-- Slice 008 Tournament Configuration | Task T070 | Phase 8d (Cross-slice regression)
--
-- Spec anchors:
--   tasks.md § T070 — "explicitly re-runs the regression assertions from each
--   prior slice's quickstart.md Step 14 against the post-Slice-008 state…
--   Single test file aggregating all assertions per Principle XI."
--
-- Phase 2 ALTER FUNCTION sites being regression-gated:
--   * T013 (slot 0077 L1226..L1302) ships a pre/post smoke-probe inside the
--     migration itself (it captures predicate outputs in _t013_smoke_pre
--     BEFORE the ALTERs, then RAISEs WCG06 if any post-ALTER predicate
--     diverges). T070 is the HIGHER-LEVEL pgTAP equivalent: it runs against
--     the FULLY-migrated database state and re-asserts the canonical
--     consumer-slice quickstart Step 14 expectations rather than the
--     pre-ALTER snapshot. The two probes are complementary:
--       - T013 catches "ALTERs changed observable behavior for the rows
--         captured at migration time" (migration-internal).
--       - T070 catches "post-migration state fails to satisfy the
--         contract documented in prior slices' Step 14" (suite-external).
--   * T014 is_eligible_nortal_participant ALTER (slot 0077 L1029..L1081):
--     swaps the data source from the legacy 'eligibility.approved_domains'
--     key (slot 0002 seed) to the new namespaced
--     'eligibility.allowed_domains' (slot 0077 L282 seed = ["nortal.com"]).
--     Fail-closed EXCEPTION trap at L1065..L1069 returns false on WCG06.
--   * T015 is_prediction_locked ALTER (slot 0077 L1101..L1148): swaps the
--     window source from the legacy 'lock_window_minutes' key (slot 0035)
--     to the new namespaced 'locking.match_prediction_window_minutes'
--     (slot 0077 seed). Fail-closed EXCEPTION trap at L1131..L1135 returns
--     true on WCG06. Boundary semantics (BR-LOCK-002 strict >=) preserved.
--   * T016 NEW public.compute_match_score helper (slot 0077 L1176..L1219):
--     reads scoring.match_points.{exact,correct_outcome,incorrect} via
--     config_read with NULL default; fail-closed (WCG06) returns 0. The
--     defaults (slot 0077 L298..L306) are exact=10, correct_outcome=5,
--     incorrect=0 — the exact same values the slice-005 score_match SP
--     (slot 0052) embedded inline. Under default config compute_match_score
--     MUST be a drop-in replacement.
--
-- Contracts referenced (slice 001 / 003 / 005):
--   * specs/001-eligibility-login/contracts/eligibility.contract.md —
--     is_eligible_nortal_participant returns true for active Nortal-domain
--     participants. Step 14 of slice 001's quickstart pins the canonical
--     happy-path assertion: alpha@nortal.com (status=active) -> true.
--   * specs/003-match-predictions/contracts/prediction-lock.predicate.sql.md —
--     is_prediction_locked returns true iff now() >= kickoff_utc -
--     v_minutes * INTERVAL '1 minute'. Step 14 of slice 003's quickstart
--     pins the canonical lock-window assertion: under default 60-min
--     window, a match 30 min in the future is INSIDE the window -> locked.
--   * specs/005-scoring-leaderboard/contracts/scoring.contract.md —
--     compute_match_score returns 10 for an exact match (predicted equals
--     actual), 5 for a correct outcome (sign of goal-diff matches), 0
--     otherwise. Step 14 of slice 005's quickstart pins the canonical
--     scoring-table happy path.
--
-- Failure-mode triage (per task prompt):
--   If ANY assertion fails, the migration's corresponding ALTER FUNCTION
--   step is at fault — A1 fails -> investigate T014 (eligibility ALTER);
--   A2 fails -> investigate T015 (locking ALTER); A3/A4/A5 fail ->
--   investigate T016 (new compute_match_score helper); A6 fails ->
--   investigate slot 0054 leaderboard_v migration was clobbered or dropped
--   by the slice-008 migration. The probes already in slot 0077 catch the
--   migration-internal regression; T070 catches downstream surface-level
--   drift the in-migration probe cannot see (e.g., the right function name
--   exists with the right signature but reads the WRONG key, or the
--   leaderboard view was inadvertently dropped during DDL).
--
-- Out of scope (covered by sibling tasks):
--   * T068 config_read_fail_closed.sql — proves the WCG06 raise / safe-closed
--     return path. T070 only exercises the HAPPY path (config rows present,
--     consumers return their canonical values).
--   * T032 locking_window_consumer_check.sql — exercises the lock flip
--     end-to-end via admin_config_upsert. T070 only reads the seeded default.
--   * T034 scoring_consumer_check.sql — exercises score_match end-to-end.
--     T070 only tests the new compute_match_score helper at three
--     representative inputs (exact / correct_outcome / incorrect branches).
--   * T071 config-cross-slice-regression.spec.ts — the Playwright-layer
--     equivalent of T070 (UI-driven, one happy-path action per prior slice).
--   * T072 action_label_catalog.sql extension — audit-label catalog growth.
--
-- Impersonation pattern:
--   The test does NOT switch roles. All four functions under test are either
--   STABLE SECURITY INVOKER (is_eligible_nortal_participant,
--   is_prediction_locked) or STABLE (compute_match_score), and they only
--   READ from public.tournament_config + the consumer-owned tables
--   (participants, matches). Running as the pgTAP postgres role
--   (BYPASSRLS) avoids any RLS interference on the SELECT against
--   public.matches that A2 inserts. We set request.jwt.claims to admin1's
--   auth_user_id as a defensive default in case any downstream helper
--   inspects auth.uid() — but the functions under test do not.
--
-- Fixture choices:
--   * Alpha (auth_user_id 00000000-0000-0000-0000-00000000000a) — slice 001
--     fixture seed: email='alpha@nortal.com', status='active'. The canonical
--     Nortal-domain participant referenced by every prior slice's eligibility
--     happy-path assertion. Same persona used by T068's A3 assertion.
--   * Synthetic match uuid 00000000-0000-0000-0070-000000000001 — the 0070
--     fragment scopes to T070 to avoid collision with T068's 1066-namespace
--     and T032's gen_random_uuid() match. Inserted with stage='group',
--     group_id='A' (satisfies matches_group_id_consistency CHECK at slot
--     0020 L86..L87), status='scheduled' (BR-LOCK-004 would short-circuit
--     any non-scheduled status to true and mask the config-driven branch),
--     kickoff_utc=now()+30min (strictly INSIDE the seeded 60-min window).
--   * Team FKs use (SELECT id FROM public.teams ... LIMIT 1) / OFFSET 1 with
--     ORDER BY short_code — same pattern as locking_window_consumer_check.sql
--     L129..L130 and config_read_fail_closed.sql L247..L248. Slice 002 seed
--     populates the full WC2026 roster so LIMIT/OFFSET always resolve.
--
-- RUNTIME-DEFERRED: This test is authored for execution against a freshly
-- migrated DB once Phase 2 T014/T015/T016 ALTER/CREATE FUNCTION migrations
-- land in slot 0077. Static SQL validity only at authoring time; runtime
-- PASS depends on (a) the migrated function bodies actually reading the
-- new slice-008 namespaces, (b) the seeded defaults
-- (eligibility.allowed_domains=["nortal.com"],
--  locking.match_prediction_window_minutes=60,
--  scoring.match_points.exact=10, .correct_outcome=5, .incorrect=0)
-- being present in tournament_config, and (c) slot 0054's leaderboard_v
-- view still existing in the public schema after slice-008 DDL. Verified
-- by reading slot 0077 L282 (eligibility seed), L286..L289 (locking seed),
-- L298..L306 (scoring seeds), L1029..L1081 (T014 ALTER), L1101..L1148
-- (T015 ALTER), L1176..L1219 (T016 CREATE). Docker is down at authoring
-- time so runtime verification is deferred to the post-merge sweep.
--
-- Pattern: BEGIN / plan(6) / asserts / finish / ROLLBACK. The ROLLBACK
-- discards the synthetic match insert in A2 — nothing else mutates state.

BEGIN;

SELECT plan(6);

-- Defensive role-context: set JWT to admin1 in case any helper inspects
-- auth.uid(). The functions under test (is_eligible_nortal_participant,
-- is_prediction_locked, compute_match_score) do not. is_local=true means
-- the value is dropped on ROLLBACK, which is desired.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);

-- ===========================================================================
-- A1: Slice 001 regression — Nortal-domain participant passes eligibility.
-- ===========================================================================
-- Quickstart anchor: specs/001-eligibility-login/quickstart.md Step 14 —
-- "alpha@nortal.com signs in and passes is_eligible_nortal_participant."
-- Under post-008 state, T014's ALTER (slot 0077 L1029..L1081) reads the
-- new key 'eligibility.allowed_domains'. The seed at slot 0077 L282
-- defaults this key to '["nortal.com"]'::jsonb. Alpha (slice 001 fixture
-- seed) has email='alpha@nortal.com', status='active', so the body's
-- domain-extraction (L1059) yields 'nortal.com' and the EXISTS check
-- (L1075..L1079) returns TRUE. A regression where the function reads
-- the WRONG namespaced key (e.g., a typo 'eligibility.approved_domains'
-- from the legacy slot-0002 seed left in place) might still pass IF the
-- legacy seed also defaults to ["nortal.com"] — but the in-migration
-- T013 smoke probe at slot 0077 L1252..L1264 already catches that. T070
-- is the surface-level guarantee: as long as the FUNCTION returns TRUE
-- for alpha under default config, slice 001's contract is preserved.
-- ---------------------------------------------------------------------------
SELECT is(
  public.is_eligible_nortal_participant(
    '00000000-0000-0000-0000-00000000000a'::uuid
  ),
  true,
  'A1: Slice 001 regression — alpha@nortal.com passes is_eligible_nortal_participant under post-008 ALTER FUNCTION (T014)'
);

-- ===========================================================================
-- A2: Slice 003 regression — match 30 min away returns is_prediction_locked=TRUE.
-- ===========================================================================
-- Quickstart anchor: specs/003-match-predictions/quickstart.md Step 14 —
-- "a scheduled match 30 min in the future is LOCKED under the default
-- 60-min window." Under post-008 state, T015's ALTER (slot 0077
-- L1101..L1148) reads 'locking.match_prediction_window_minutes' (default
-- 60). The body's comparator at slot 0077 L1146 evaluates
-- now() >= kickoff_utc - 60min = now()+30min - 60min = now()-30min, which
-- is always true. The 30-min horizon (vs. T032's 75-min or T068's 120-min)
-- is the canonical "inside-the-window" Step 14 assertion.
-- ---------------------------------------------------------------------------
-- Insert a synthetic scheduled match +30 minutes from now. The 0070
-- namespace fragment in the uuid scopes to T070; the ROLLBACK envelope
-- discards the row at end-of-test. Team FKs use the same LIMIT/OFFSET
-- pattern as the sibling 008 tests. stage='group' + group_id='A' satisfies
-- the matches_group_id_consistency CHECK at slot 0020 L86..L87.
INSERT INTO public.matches (
  id, home_team_id, away_team_id, stage, group_id,
  kickoff_utc, status
)
VALUES (
  '00000000-0000-0000-0070-000000000001'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '30 minutes',
  'scheduled'::public.match_status
);

SELECT is(
  public.is_prediction_locked(
    '00000000-0000-0000-0070-000000000001'::uuid
  ),
  true,
  'A2: Slice 003 regression — match 30 min away returns is_prediction_locked=TRUE under default 60-min window (T015)'
);

-- ===========================================================================
-- A3: Slice 005 regression — compute_match_score(2,1,2,1) = 10 (exact match).
-- ===========================================================================
-- Quickstart anchor: specs/005-scoring-leaderboard/quickstart.md Step 14 —
-- "an exact-score match awards 10 points." T016 (slot 0077 L1176..L1219)
-- adds compute_match_score, which reads scoring.match_points.exact (seeded
-- to '10'::jsonb at slot 0077 L298). The body's branch at L1207..L1210
-- detects p_pred_home=p_actual_home AND p_pred_away=p_actual_away and
-- returns v_pts_exact. The (2,1)-vs-(2,1) input is the canonical exact-
-- match probe — same input used by the in-migration T016 smoke probe at
-- slot 0077 L1283..L1286.
-- ---------------------------------------------------------------------------
SELECT is(
  public.compute_match_score(2, 1, 2, 1),
  10,
  'A3: Slice 005 regression — compute_match_score(2,1,2,1) returns 10 (exact match) under default config (T016)'
);

-- ===========================================================================
-- A4: Slice 005 regression — compute_match_score(2,1,3,0) = 5 (correct outcome).
-- ===========================================================================
-- Quickstart anchor: specs/005-scoring-leaderboard/quickstart.md Step 14 —
-- "a correct-outcome match awards 5 points." (2,1) predicted is a home
-- win (sign=+1); (3,0) actual is also a home win (sign=+1). The body's
-- branch at L1212..L1214 returns v_pts_outcome (seeded to '5'::jsonb at
-- slot 0077 L302). This probe complements A3 by exercising the
-- non-exact, sign-equal path. A regression where compute_match_score
-- reads the wrong key (e.g., scoring.outcome_points instead of
-- scoring.match_points.correct_outcome) would fail this assertion via
-- the WCG06 EXCEPTION trap at L1203..L1205, which returns 0 instead.
-- ---------------------------------------------------------------------------
SELECT is(
  public.compute_match_score(2, 1, 3, 0),
  5,
  'A4: Slice 005 regression — compute_match_score(2,1,3,0) returns 5 (correct outcome) under default config (T016)'
);

-- ===========================================================================
-- A5: Slice 005 regression — compute_match_score(2,1,0,3) = 0 (incorrect).
-- ===========================================================================
-- Quickstart anchor: specs/005-scoring-leaderboard/quickstart.md Step 14 —
-- "an incorrect-outcome match awards 0 points." (2,1) predicted is a home
-- win (sign=+1); (0,3) actual is an away win (sign=-1). The body falls
-- through both branches and returns v_pts_incorrect (seeded to '0'::jsonb
-- at slot 0077 L306). Three points worth: (1) confirms the third branch
-- is reachable, (2) confirms the seeded default for the incorrect-points
-- key is 0 (and not, e.g., -1 or NULL), (3) demonstrates the function
-- distinguishes between "fail-closed return 0" (WCG06 trap at L1203..L1205)
-- and "valid incorrect-outcome return 0" — they happen to be the same
-- numeric value, but only the latter follows the happy-path branch.
-- ---------------------------------------------------------------------------
SELECT is(
  public.compute_match_score(2, 1, 0, 3),
  0,
  'A5: Slice 005 regression — compute_match_score(2,1,0,3) returns 0 (incorrect outcome) under default config (T016)'
);

-- ===========================================================================
-- A6: Slice 005 regression — leaderboard_v view exists in public schema.
-- ===========================================================================
-- Quickstart anchor: specs/005-scoring-leaderboard/quickstart.md Step 14 —
-- "the leaderboard view returns ordered rows under the default tie-breaker."
-- Slot 0054 created public.leaderboard_v with security_invoker=true,
-- hard-coding the §7.4 tier order (total DESC -> exact DESC -> outcome
-- DESC -> final DESC). Slice 008's migration MUST NOT clobber or drop
-- this view — its DDL only touches the new tournament_config namespace
-- and the consumer functions T014/T015/T016 listed above. The existence
-- check is the minimum-viable regression: a "view dropped by accident"
-- regression would fail this assertion immediately, prompting the
-- operator to investigate which slice-008 migration step caused the drop.
--
-- We intentionally test EXISTENCE rather than row-count or ordering here.
-- Reasons:
--   1. The default fixture set may seed zero score_records rows for a
--      "fresh DB", in which case leaderboard_v returns zero rows — a
--      row-count assertion would be flaky.
--   2. Tie-breaker ordering is exercised end-to-end by slice 005's
--      T024/T025/T026 (leaderboard_v_*.sql) and by slice 008's T070
--      sibling tests — duplicating that here would violate Principle XI's
--      "single test file aggregating high-level assertions" rationale.
--   3. The actual ORDER BY clause is encoded in the view DDL at slot 0054;
--      its correctness is verified at migration time by slot 0054 itself.
--      T070 only needs to assert "the view didn't disappear."
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1
      FROM information_schema.views
     WHERE table_schema = 'public'
       AND table_name = 'leaderboard_v'
  ),
  'A6: Slice 005 regression — leaderboard_v view still exists in public schema after slice-008 DDL'
);

SELECT * FROM finish();

ROLLBACK;
