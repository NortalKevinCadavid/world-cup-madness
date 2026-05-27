-- ============================================================================
-- slice-010-submit-rpc.sql  — Slice 010 / T025 (pgTAP)
-- ============================================================================
-- Verifies public.submit_bracket (migration 0090 / FR-012,FR-013,FR-028,
-- Principle V) end-to-end:
--   A1  incomplete bracket → WCB04 BRACKET_INCOMPLETE
--   A2  complete bracket   → submission_status 'submitted'
--   A3  first submit       → version 1
--   A4  same run_token     → idempotent, version unchanged (no re-work)
--   A5  exactly ONE bracket.submitted audit row despite repeated idempotent calls
--   A6  past lock          → WCB03 BRACKET_LOCKED
--
-- Impersonates alpha (auth uid …000a, participant 1111…) via
-- request.jwt.claims + ROLE authenticated, so RLS + auth.uid() behave as in
-- production. Superuser reads the audit table (authenticated cannot). Outer
-- ROLLBACK restores role, JWT claims, config, and all mutations.
-- ============================================================================

BEGIN;
SELECT plan(6);

SELECT set_config('test.s010sr.alpha_uid', '00000000-0000-0000-0000-00000000000a', false);
SELECT set_config('test.s010sr.alpha_pid', '11111111-1111-1111-1111-111111111111', false);
SELECT set_config('test.s010sr.tok1',      '00000000-0000-0000-0000-0000000000a1', false);
SELECT set_config('test.s010sr.tok2',      '00000000-0000-0000-0000-0000000000a2', false);

-- Impersonate alpha.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- A1: alpha has only the 3 seeded fixture picks → incomplete.
SELECT throws_ok(
  format('SELECT public.submit_bracket(%L::uuid)', current_setting('test.s010sr.tok1')),
  'WCB04',
  NULL,
  'A1 incomplete bracket → WCB04 BRACKET_INCOMPLETE'
);

-- Fill the rest of the tree: pick team_a for every ready, unpicked matchup,
-- round by round, until all 31 are present. Runs as alpha so bracket_v resolves
-- alpha''s own tree (self-RLS) and the inserts pass self-write RLS.
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..6 LOOP
    INSERT INTO public.bracket_picks (participant_id, matchup_id, winner_team_id)
    SELECT '11111111-1111-1111-1111-111111111111'::uuid, v.matchup_id, v.team_a_id
      FROM public.bracket_v v
     WHERE v.team_a_id IS NOT NULL AND v.team_b_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.bracket_picks bp
          WHERE bp.participant_id = '11111111-1111-1111-1111-111111111111'::uuid
            AND bp.matchup_id = v.matchup_id);
  END LOOP;
END $$;

-- A2: complete bracket submits.
SELECT is(
  (SELECT submission_status FROM public.submit_bracket(current_setting('test.s010sr.tok1')::uuid)),
  'submitted',
  'A2 complete bracket → submitted'
);

-- A3: first submit is version 1 (idempotent re-read with the same token).
SELECT is(
  (SELECT version FROM public.submit_bracket(current_setting('test.s010sr.tok1')::uuid)),
  1,
  'A3 first submit → version 1'
);

-- A4: a third call with the same token stays version 1 (idempotent no-op).
SELECT is(
  (SELECT version FROM public.submit_bracket(current_setting('test.s010sr.tok1')::uuid)),
  1,
  'A4 same run_token → idempotent (version unchanged)'
);

-- A5: exactly one audit row despite the repeated idempotent calls. Read as
-- superuser (authenticated cannot read arbitrary audit rows).
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'bracket.submitted'
      AND entity_type = 'bracket'
      AND entity_id = current_setting('test.s010sr.alpha_pid')::uuid),
  1,
  'A5 exactly one bracket.submitted audit row (idempotency did not double-audit)'
);

-- A6: move the lock into the past, then a fresh-token submit is rejected.
UPDATE public.tournament_config SET value = to_jsonb('2020-01-01T00:00:00Z'::text)
 WHERE key = 'first_kickoff_utc';

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  format('SELECT public.submit_bracket(%L::uuid)', current_setting('test.s010sr.tok2')),
  'WCB03',
  NULL,
  'A6 past lock → WCB03 BRACKET_LOCKED'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
