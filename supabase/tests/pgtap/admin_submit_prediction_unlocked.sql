-- Slice 006 / T038 / Phase 7 / contracts/admin-rpcs.write.md § admin_submit_prediction.
-- Test surface row: admin_submit_prediction_unlocked.
-- RED until slot 0066 ships admin_submit_prediction.
--
-- Scenario: admin1 submits a prediction on behalf of alpha against M4 (kickoff 2027-07-01,
-- well outside any lock window; matches.status='scheduled'). M4 is UNLOCKED. The admin RPC
-- MUST:
--   * branch to slice 003's public.submit_prediction(..., 'admin_override'),
--   * supersede alpha's existing active M4 prediction (1-1 -> 3-0),
--   * emit one admin.prediction_submitted audit row with previous_value->>'lock_bypass'='false',
--   * return the new prediction id.
--
-- Fixture refs (slice-005-fixture.sql):
--   * admin1 participants.id = 77777777-7777-7777-7777-777777777777
--             auth.users.id  = 00000000-0000-0000-0000-0000000000d3
--   * alpha  participants.id = 11111111-1111-1111-1111-111111111111
--   * M4     matches.id      = eeee0050-0000-0000-0000-000000000004 (scheduled, kickoff 2027)
--   * alpha's active M4 prediction id = eeee0051-000a-0004-0000-000000000000 (1-1).

BEGIN;

SELECT plan(5);

SELECT set_config('test.t038_unl.admin_uid', '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t038_unl.admin_pid', '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t038_unl.alpha_pid', '11111111-1111-1111-1111-111111111111', false);
SELECT set_config('test.t038_unl.m4',        'eeee0050-0000-0000-0000-000000000004', false);

-- A0: confirm M4 is UNLOCKED (kickoff well in the future).
SELECT is(
  public.is_prediction_locked(current_setting('test.t038_unl.m4')::uuid),
  false,
  'A0 M4 is unlocked (scheduled, kickoff 2027) -- pre-condition for non-bypass path'
);

SELECT set_config(
  'test.t038_unl.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.prediction_submitted'),
  false
);

-- Impersonate admin1.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- A1: admin_submit_prediction returns a uuid.
SELECT isnt(
  public.admin_submit_prediction(
    current_setting('test.t038_unl.alpha_pid')::uuid,
    current_setting('test.t038_unl.m4')::uuid,
    3, 0,
    'admin assist for alpha pre-tournament',
    'https://nortal.example/m4-alpha-assist'
  ),
  NULL::uuid,
  'A1 admin_submit_prediction returns a new prediction uuid on unlocked match'
);

RESET ROLE;

-- A2: alpha now has exactly one active prediction on M4 with the new score and source.
SELECT is(
  (SELECT ROW(predicted_home, predicted_away, source::text)::text
     FROM public.predictions
    WHERE participant_id = current_setting('test.t038_unl.alpha_pid')::uuid
      AND match_id       = current_setting('test.t038_unl.m4')::uuid
      AND superseded_at IS NULL),
  ROW(3, 0, 'admin_override')::text,
  'A2 alpha has one active M4 prediction 3-0 with source=admin_override (slice 003 path)'
);

-- A3: exactly one new admin.prediction_submitted audit row.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.prediction_submitted'),
  current_setting('test.t038_unl.audit_baseline')::int + 1,
  'A3 exactly one new admin.prediction_submitted audit row was emitted'
);

-- A4: that audit row carries lock_bypass=false + actor + source.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.prediction_submitted'
       AND entity_type = 'prediction'
       AND actor = current_setting('test.t038_unl.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://nortal.example/m4-alpha-assist'
       AND reason = 'admin assist for alpha pre-tournament'
       AND (previous_value->>'lock_bypass') = 'false'
  ),
  'A4 audit row has admin1 actor, source=admin_rpc, source_citation, reason, previous_value->>lock_bypass=false'
);

SELECT * FROM finish();
ROLLBACK;
