-- Slice 006 / T010 / US1 / contracts/admin-rpcs.write.md. RED until T013 ships admin_record_match_result at on-disk slot 0064 per D-026.
--
-- Missing source_citation rejection path: admin1 (authorized) calls
-- admin_record_match_result with p_source_citation='' (empty). Pre-flight
-- step 3 MUST:
--   IF p_source_citation IS NULL OR length(trim(p_source_citation)) = 0 THEN
--     RAISE EXCEPTION ERRCODE='WAR03';
--   END IF;
--
-- The raise MUST happen BEFORE the underlying record_match_result SP is
-- invoked, so match_results MUST NOT be mutated. p_reason here is non-empty
-- so pre-flight step 2 (WAR02) passes -- WAR03 is the specific guard under
-- test.
--
-- Fixture refs:
--   * admin1 / M1 -- same as the happy-path file.
--
-- FR-002 / contract § Pre-flight steps: source_citation is required AND
-- non-empty for the override RPCs (only the recalc RPC may omit it).

BEGIN;

SELECT plan(2);

SELECT set_config('test.t010_missing_source.m1', 'eeee0050-0000-0000-0000-000000000001', false);

SELECT set_config(
  'test.t010_missing_source.m1_prestate',
  (SELECT ROW(home_score, away_score, home_score_for_scoring, away_score_for_scoring)::text
     FROM public.match_results
    WHERE match_id = current_setting('test.t010_missing_source.m1')::uuid),
  false
);

-- ---------------------------------------------------------------------------
-- Impersonate admin1.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: WAR03 ERRCODE raised on empty p_source_citation.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.admin_record_match_result(
      'eeee0050-0000-0000-0000-000000000001'::uuid,
      2, 2, 2, 2,
      'regulation',
      'FIFA decision',                        -- p_reason non-empty (passes WAR02)
      ''                                      -- p_source_citation empty -> WAR03
    )$$,
  'WAR03',
  NULL,
  'A1 empty p_source_citation raises ERRCODE=WAR03 (source citation missing or empty)'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: match_results UNCHANGED.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT ROW(home_score, away_score, home_score_for_scoring, away_score_for_scoring)::text
     FROM public.match_results
    WHERE match_id = current_setting('test.t010_missing_source.m1')::uuid),
  current_setting('test.t010_missing_source.m1_prestate'),
  'A2 match_results row for M1 UNCHANGED by rejected empty-source_citation call'
);

SELECT * FROM finish();
ROLLBACK;
