-- Slice 006 / T038 / Phase 7 / contracts/admin-rpcs.write.md § admin_submit_final_prediction.
-- Test surface row: admin_submit_final_prediction_unlocked (parity with admin_submit_prediction_unlocked).
-- RED until slot 0067 ships admin_submit_final_prediction.
--
-- Scenario: tournament has NOT started (first_kickoff_utc = '2026-06-16'; today is well
-- before that per the dev clock). is_final_prediction_locked() returns FALSE so the admin
-- RPC delegates to slice 004's public.submit_final_prediction(..., 'admin_override'). The
-- admin RPC MUST:
--   * branch to slice 004's locked SP,
--   * INSERT a new active final_prediction for zeta on runner_up = JPN (zeta has no prior
--     runner_up active row -- CREATE path),
--   * emit one admin.final_prediction_submitted audit row with
--     previous_value->>'lock_bypass'='false',
--   * return the new final_prediction id.
--
-- Fixture refs:
--   * admin1 participants.id = 77777777-7777-7777-7777-777777777777
--   * zeta   participants.id = 66666666-6666-6666-6666-666666666666
--   * JPN    teams.id        = aaaa0000-0000-0000-0000-000000000008

BEGIN;

SELECT plan(5);

SELECT set_config('test.t038_funl.admin_uid', '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t038_funl.admin_pid', '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t038_funl.zeta_pid',  '66666666-6666-6666-6666-666666666666', false);
SELECT set_config('test.t038_funl.jpn',       'aaaa0000-0000-0000-0000-000000000008', false);

-- A0: confirm finals are NOT locked.
SELECT is(
  public.is_final_prediction_locked(),
  false,
  'A0 final predictions unlocked (current time pre-first-kickoff) -- pre-condition for non-bypass path'
);

SELECT set_config(
  'test.t038_funl.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.final_prediction_submitted'),
  false
);

-- Impersonate admin1.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- A1: admin_submit_final_prediction returns a uuid.
SELECT isnt(
  public.admin_submit_final_prediction(
    current_setting('test.t038_funl.zeta_pid')::uuid,
    'runner_up',
    current_setting('test.t038_funl.jpn')::uuid,
    NULL::uuid,
    'admin filing zeta runner_up pre-tournament',
    'https://nortal.example/final-zeta-runner_up'
  ),
  NULL::uuid,
  'A1 admin_submit_final_prediction returns a new final_prediction uuid on unlocked tournament'
);

RESET ROLE;

-- A2: zeta has an active runner_up final_prediction = JPN with source=admin_override.
SELECT is(
  (SELECT ROW(item_kind::text, target_team_id::text, target_player_id, source::text)::text
     FROM public.final_predictions
    WHERE participant_id = current_setting('test.t038_funl.zeta_pid')::uuid
      AND item_kind      = 'runner_up'
      AND superseded_at IS NULL),
  ROW('runner_up', current_setting('test.t038_funl.jpn'), NULL::uuid, 'admin_override')::text,
  'A2 zeta has one active runner_up final_prediction targeting JPN with source=admin_override (slice 004 path)'
);

-- A3: exactly one new admin.final_prediction_submitted audit row.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.final_prediction_submitted'),
  current_setting('test.t038_funl.audit_baseline')::int + 1,
  'A3 exactly one new admin.final_prediction_submitted audit row was emitted'
);

-- A4: that audit row carries lock_bypass=false + actor + source.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.final_prediction_submitted'
       AND entity_type = 'final_prediction'
       AND actor = current_setting('test.t038_funl.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://nortal.example/final-zeta-runner_up'
       AND reason = 'admin filing zeta runner_up pre-tournament'
       AND (previous_value->>'lock_bypass') = 'false'
  ),
  'A4 audit row has admin1 actor, source=admin_rpc, source_citation, reason, previous_value->>lock_bypass=false'
);

SELECT * FROM finish();
ROLLBACK;
