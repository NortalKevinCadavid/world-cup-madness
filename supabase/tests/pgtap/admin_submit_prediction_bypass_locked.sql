-- Slice 006 / T038 / Phase 7 / contracts/admin-rpcs.write.md § admin_submit_prediction.
-- Test surface row: admin_submit_prediction_bypass_locked.
-- RED until slot 0066 ships admin_submit_prediction + admin_submit_prediction_bypass_lock.
--
-- Scenario: admin1 submits a prediction on behalf of alpha against M1 (status='finished').
-- M1 is locked (status<>scheduled => is_prediction_locked(M1)=true). The admin RPC MUST:
--   * branch to admin_submit_prediction_bypass_lock,
--   * supersede alpha's existing active prediction on M1 (2-1 -> 4-4),
--   * emit one admin.prediction_submitted audit row with previous_value->>'lock_bypass'='true',
--     entity_type='prediction', source='admin_rpc',
--   * return the new prediction id.
--
-- Fixture refs (slice-005-fixture.sql):
--   * admin1 participants.id = 77777777-7777-7777-7777-777777777777
--             auth.users.id  = 00000000-0000-0000-0000-0000000000d3
--   * alpha  participants.id = 11111111-1111-1111-1111-111111111111
--   * M1     matches.id      = eeee0050-0000-0000-0000-000000000001 (finished)
--   * alpha's active M1 prediction id = eeee0051-000a-0001-0000-000000000000 (2-1).

BEGIN;

SELECT plan(6);

SELECT set_config('test.t038_blk.admin_uid',  '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t038_blk.admin_pid',  '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t038_blk.alpha_pid',  '11111111-1111-1111-1111-111111111111', false);
SELECT set_config('test.t038_blk.m1',         'eeee0050-0000-0000-0000-000000000001', false);
SELECT set_config('test.t038_blk.old_pid_id', 'eeee0051-000a-0001-0000-000000000000', false);

-- A0: confirm M1 is indeed locked (the whole point of this test).
SELECT is(
  public.is_prediction_locked(current_setting('test.t038_blk.m1')::uuid),
  true,
  'A0 M1 is locked (status=finished -> is_prediction_locked=true) -- pre-condition for bypass path'
);

-- Snapshot baseline audit_log count for admin.prediction_submitted scoped to alpha+M1.
SELECT set_config(
  'test.t038_blk.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.prediction_submitted'),
  false
);

-- Impersonate admin1.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- A1: admin_submit_prediction returns a uuid (the new prediction id).
SELECT isnt(
  public.admin_submit_prediction(
    current_setting('test.t038_blk.alpha_pid')::uuid,
    current_setting('test.t038_blk.m1')::uuid,
    4, 4,
    'FIFA gave alpha a corrected late submission',
    'https://fifa.example/m1-alpha-late'
  ),
  NULL::uuid,
  'A1 admin_submit_prediction returns a new prediction uuid on locked match (bypass path)'
);

-- Drop back to superuser for post-state SELECTs.
RESET ROLE;

-- A2: alpha now has exactly ONE active prediction on M1 with the new score.
SELECT is(
  (SELECT ROW(predicted_home, predicted_away, source::text)::text
     FROM public.predictions
    WHERE participant_id = current_setting('test.t038_blk.alpha_pid')::uuid
      AND match_id       = current_setting('test.t038_blk.m1')::uuid
      AND superseded_at IS NULL),
  ROW(4, 4, 'admin_override')::text,
  'A2 alpha has one active prediction on M1 with score 4-4 and source=admin_override'
);

-- A3: the original alpha-M1 prediction row is now superseded.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.predictions
     WHERE id = current_setting('test.t038_blk.old_pid_id')::uuid
       AND superseded_at IS NOT NULL
  ),
  'A3 alpha''s pre-existing M1 prediction (2-1) is now superseded'
);

-- A4: exactly ONE new admin.prediction_submitted audit row, scoped properly.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.prediction_submitted'),
  current_setting('test.t038_blk.audit_baseline')::int + 1,
  'A4 exactly one new admin.prediction_submitted audit row was emitted'
);

-- A5: that audit row carries the bypass marker + admin actor + source=admin_rpc.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.prediction_submitted'
       AND entity_type = 'prediction'
       AND actor = current_setting('test.t038_blk.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://fifa.example/m1-alpha-late'
       AND reason = 'FIFA gave alpha a corrected late submission'
       AND (previous_value->>'lock_bypass') = 'true'
  ),
  'A5 audit row carries actor=admin1, source=admin_rpc, source_citation, reason, previous_value->>lock_bypass=true'
);

SELECT * FROM finish();
ROLLBACK;
