-- Slice 006 / T038 / Phase 7 / contracts/admin-rpcs.write.md § admin_resolve_match_pending_review.
-- Test surface row: admin_resolve_match_pending_review_reject_provider.
-- RED until slot 0069 ships admin_resolve_match_pending_review.
--
-- Scenario: admin1 resolves a quarantined review row with resolution='reject_provider'.
-- The review's proposed_payload still carries {"status":"postponed"} for M1, but admin
-- rejects it. The admin RPC MUST:
--   * NOT mutate matches (M1.status stays 'finished'),
--   * UPDATE match_pending_review SET resolution='rejected', resolved_at=now(),
--     resolved_by=admin1, notes=p_reason,
--   * emit one admin.pending_review_resolved audit row carrying
--     new_value->>'admin_resolution_kind'='reject_provider'.

BEGIN;

SELECT plan(5);

SELECT set_config('test.t038_prr.admin_uid', '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t038_prr.admin_pid', '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t038_prr.m1',        'eeee0050-0000-0000-0000-000000000001', false);

DO $$
DECLARE
  v_sync_run_id bigint;
  v_review_id   bigint;
BEGIN
  INSERT INTO public.provider_sync_runs (provider, outcome, trigger)
  VALUES ('test-provider', 'conflict_quarantined', 'manual_internal')
  RETURNING id INTO v_sync_run_id;

  INSERT INTO public.match_pending_review (
    match_id, provider, provider_external_id, sync_run_id,
    conflict_class, proposed_payload, current_value, detected_at
  )
  VALUES (
    current_setting('test.t038_prr.m1')::uuid,
    'test-provider',
    'm1-external-id-002',
    v_sync_run_id,
    'status_backward_transition',
    '{"status": "postponed"}'::jsonb,
    '{"status": "finished"}'::jsonb,
    now()
  )
  RETURNING id INTO v_review_id;

  PERFORM set_config('test.t038_prr.review_bigint', v_review_id::text, false);
END $$;

SELECT set_config(
  'test.t038_prr.review_uuid',
  ('00000000-0000-0000-0000-' || lpad(current_setting('test.t038_prr.review_bigint'), 12, '0')),
  false
);

-- Snapshot M1's pre-state status so A2 can prove it stayed put.
SELECT set_config(
  'test.t038_prr.m1_status_pre',
  (SELECT status::text FROM public.matches WHERE id = current_setting('test.t038_prr.m1')::uuid),
  false
);

SELECT set_config(
  'test.t038_prr.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.pending_review_resolved'),
  false
);

-- Impersonate admin1.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- A1: admin_resolve_match_pending_review(reject_provider) succeeds.
SELECT lives_ok(
  format(
    $$ SELECT public.admin_resolve_match_pending_review(
         %L::uuid,
         %L,
         %L,
         %L
       ) $$,
    current_setting('test.t038_prr.review_uuid'),
    'reject_provider',
    'admin disagrees with provider observation',
    'https://test.example/m1-reject-review'
  ),
  'A1 admin_resolve_match_pending_review(reject_provider) succeeds'
);

RESET ROLE;

-- A2: M1.status UNCHANGED (still 'finished' -- reject_provider does not touch matches).
SELECT is(
  (SELECT status::text FROM public.matches WHERE id = current_setting('test.t038_prr.m1')::uuid),
  current_setting('test.t038_prr.m1_status_pre'),
  'A2 matches.status UNCHANGED by reject_provider resolution'
);

-- A3: review row resolved with table-canonical 'rejected' label.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.match_pending_review
     WHERE id          = current_setting('test.t038_prr.review_bigint')::bigint
       AND resolution  = 'rejected'
       AND resolved_at IS NOT NULL
       AND resolved_by = current_setting('test.t038_prr.admin_pid')::uuid
       AND notes       = 'admin disagrees with provider observation'
  ),
  'A3 match_pending_review row resolved (resolution=rejected, resolved_by=admin1)'
);

-- A4: exactly ONE new admin.pending_review_resolved audit row with the right kind.
SELECT ok(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.pending_review_resolved')
    = current_setting('test.t038_prr.audit_baseline')::int + 1
  AND EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.pending_review_resolved'
       AND entity_type = 'match_pending_review'
       AND actor = current_setting('test.t038_prr.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://test.example/m1-reject-review'
       AND reason = 'admin disagrees with provider observation'
       AND (new_value->>'admin_resolution_kind') = 'reject_provider'
  ),
  'A4 exactly one admin.pending_review_resolved audit row carrying reject_provider kind'
);

SELECT * FROM finish();
ROLLBACK;
