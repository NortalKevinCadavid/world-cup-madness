-- Slice 006 / T038 / Phase 7 / contracts/admin-rpcs.write.md § admin_submit_final_prediction.
-- Test surface row: admin_submit_final_prediction_bypass_locked.
-- RED until slot 0067 ships admin_submit_final_prediction + admin_submit_final_prediction_bypass_lock.
--
-- Scenario: tournament has started (first_kickoff_utc moved into the past inside this
-- transaction; ROLLBACK restores the fixture). admin1 submits a runner_up final prediction
-- on behalf of delta against MEX. is_final_prediction_locked() returns TRUE, so the admin
-- RPC MUST:
--   * branch to admin_submit_final_prediction_bypass_lock,
--   * INSERT a new active final_prediction (delta has no prior runner_up row -> CREATE path),
--   * emit one admin.final_prediction_submitted audit row with
--     previous_value->>'lock_bypass'='true',
--   * return the new final_prediction id.
--
-- Fixture refs:
--   * admin1 participants.id = 77777777-7777-7777-7777-777777777777
--             auth.users.id  = 00000000-0000-0000-0000-0000000000d3
--   * delta  participants.id = 44444444-4444-4444-4444-444444444444
--   * MEX    teams.id        = aaaa0000-0000-0000-0000-000000000002

BEGIN;

SELECT plan(5);

SELECT set_config('test.t038_fblk.admin_uid', '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t038_fblk.admin_pid', '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t038_fblk.delta_pid', '44444444-4444-4444-4444-444444444444', false);
SELECT set_config('test.t038_fblk.mex',       'aaaa0000-0000-0000-0000-000000000002', false);

-- Force first_kickoff_utc into the past so is_final_prediction_locked() = TRUE.
-- ROLLBACK at end restores the fixture row.
UPDATE public.tournament_config
   SET value = '"2024-01-01T00:00:00Z"'::jsonb
 WHERE key = 'first_kickoff_utc';

-- A0: confirm the lock predicate is now TRUE.
SELECT is(
  public.is_final_prediction_locked(),
  true,
  'A0 final predictions locked (first_kickoff_utc shifted into the past) -- pre-condition for bypass path'
);

SELECT set_config(
  'test.t038_fblk.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.final_prediction_submitted'),
  false
);

-- Impersonate admin1.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- A1: admin_submit_final_prediction returns a uuid (the new final_prediction id).
SELECT isnt(
  public.admin_submit_final_prediction(
    current_setting('test.t038_fblk.delta_pid')::uuid,
    'runner_up',
    current_setting('test.t038_fblk.mex')::uuid,
    NULL::uuid,
    'admin granting delta a late runner_up pick',
    'https://nortal.example/final-delta-runner_up'
  ),
  NULL::uuid,
  'A1 admin_submit_final_prediction returns a new final_prediction uuid on locked tournament'
);

RESET ROLE;

-- A2: delta now has an active runner_up final_prediction = MEX with source=admin_override.
SELECT is(
  (SELECT ROW(item_kind::text, target_team_id::text, target_player_id, source::text)::text
     FROM public.final_predictions
    WHERE participant_id = current_setting('test.t038_fblk.delta_pid')::uuid
      AND item_kind      = 'runner_up'
      AND superseded_at IS NULL),
  ROW('runner_up', current_setting('test.t038_fblk.mex'), NULL::uuid, 'admin_override')::text,
  'A2 delta has one active runner_up final_prediction targeting MEX with source=admin_override'
);

-- A3: exactly one new admin.final_prediction_submitted audit row.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.final_prediction_submitted'),
  current_setting('test.t038_fblk.audit_baseline')::int + 1,
  'A3 exactly one new admin.final_prediction_submitted audit row was emitted'
);

-- A4: that audit row carries lock_bypass=true + actor + source.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.final_prediction_submitted'
       AND entity_type = 'final_prediction'
       AND actor = current_setting('test.t038_fblk.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://nortal.example/final-delta-runner_up'
       AND reason = 'admin granting delta a late runner_up pick'
       AND (previous_value->>'lock_bypass') = 'true'
  ),
  'A4 audit row has admin1 actor, source=admin_rpc, source_citation, reason, previous_value->>lock_bypass=true'
);

SELECT * FROM finish();
ROLLBACK;
