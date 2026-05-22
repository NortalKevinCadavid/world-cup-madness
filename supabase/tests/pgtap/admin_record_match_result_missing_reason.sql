-- Slice 006 / T010 / US1 / contracts/admin-rpcs.write.md. RED until T013 ships admin_record_match_result at on-disk slot 0064 per D-026.
--
-- Missing-reason rejection path: admin1 (authorized) calls
-- admin_record_match_result with p_reason='' (empty). Pre-flight step 2 MUST:
--   IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
--     RAISE EXCEPTION ERRCODE='WAR02';
--   END IF;
--
-- The raise MUST happen BEFORE the underlying record_match_result SP is
-- invoked, so match_results MUST NOT be mutated.
--
-- Fixture refs:
--   * admin1
--       participants.id = 77777777-7777-7777-7777-777777777777
--       auth.users.id   = 00000000-0000-0000-0000-0000000000d3
--   * M1
--       matches.id      = eeee0050-0000-0000-0000-000000000001
--       pre-state       = home_score 2, away_score 1
--
-- Even though admin1 passes the admin-role check, the empty-reason guard
-- fires next. FR-002 / contract § Pre-flight steps: reason is required AND
-- non-empty (trim-length > 0). The empty-string literal exercises the
-- length-after-trim branch; a NULL-reason test would exercise the IS NULL
-- branch but the contract treats both identically -- one test covers both.

BEGIN;

SELECT plan(2);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs + snapshot M1's pre-state.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t010_missing_reason.m1', 'eeee0050-0000-0000-0000-000000000001', false);

SELECT set_config(
  'test.t010_missing_reason.m1_prestate',
  (SELECT ROW(home_score, away_score, home_score_for_scoring, away_score_for_scoring)::text
     FROM public.match_results
    WHERE match_id = current_setting('test.t010_missing_reason.m1')::uuid),
  false
);

-- ---------------------------------------------------------------------------
-- Impersonate admin1.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: WAR02 ERRCODE raised on empty p_reason.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.admin_record_match_result(
      'eeee0050-0000-0000-0000-000000000001'::uuid,
      2, 2, 2, 2,
      'regulation',
      '',                                     -- p_reason empty -> WAR02
      'https://fifa.example/m1'
    )$$,
  'WAR02',
  NULL,
  'A1 empty p_reason raises ERRCODE=WAR02 (reason missing or empty)'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: match_results UNCHANGED. The raise short-circuited before the
-- underlying SP was invoked.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT ROW(home_score, away_score, home_score_for_scoring, away_score_for_scoring)::text
     FROM public.match_results
    WHERE match_id = current_setting('test.t010_missing_reason.m1')::uuid),
  current_setting('test.t010_missing_reason.m1_prestate'),
  'A2 match_results row for M1 UNCHANGED by rejected empty-reason call'
);

SELECT * FROM finish();
ROLLBACK;
