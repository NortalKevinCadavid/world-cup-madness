-- Slice 006 / T038 / Phase 7 / contracts/admin-rpcs.write.md § admin_resolve_match_pending_review.
-- Test surface row: admin_resolve_match_pending_review_accept_provider.
-- RED until slot 0069 ships admin_resolve_match_pending_review.
--
-- Scenario: admin1 resolves a quarantined review row with resolution='accept_provider'.
-- The review's proposed_payload carries {"status":"postponed"} for M1 (currently 'finished');
-- the admin RPC MUST:
--   * call admin_update_match(M1, 'postponed', NULL, ...) which UPDATEs matches.status,
--   * UPDATE match_pending_review SET resolution='accepted', resolved_at=now(),
--     resolved_by=admin1, notes=p_reason,
--   * emit one admin.pending_review_resolved audit row with source='admin_rpc' carrying
--     new_value->>'admin_resolution_kind'='accept_provider'.
--
-- Fixture refs:
--   * admin1     participants.id = 77777777-7777-7777-7777-777777777777
--   * M1         matches.id      = eeee0050-0000-0000-0000-000000000001 (currently 'finished')
--
-- The pgTAP file seeds a provider_sync_runs row + a match_pending_review row from scratch
-- inside this transaction. ROLLBACK at end discards both.

BEGIN;

SELECT plan(5);

SELECT set_config('test.t038_pra.admin_uid', '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t038_pra.admin_pid', '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t038_pra.m1',        'eeee0050-0000-0000-0000-000000000001', false);

-- Seed a provider_sync_runs row + a match_pending_review row inside a DO block so
-- we can capture the bigserial PKs into session GUCs for downstream assertions.
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
    current_setting('test.t038_pra.m1')::uuid,
    'test-provider',
    'm1-external-id-001',
    v_sync_run_id,
    'status_backward_transition',
    '{"status": "postponed"}'::jsonb,
    '{"status": "finished"}'::jsonb,
    now()
  )
  RETURNING id INTO v_review_id;

  PERFORM set_config('test.t038_pra.sync_run_id',  v_sync_run_id::text, false);
  PERFORM set_config('test.t038_pra.review_bigint', v_review_id::text,  false);
END $$;

-- Compute the contract-encoded uuid form: '00000000-0000-0000-0000-' || lpad(bigint, 12, '0').
SELECT set_config(
  'test.t038_pra.review_uuid',
  ('00000000-0000-0000-0000-' || lpad(current_setting('test.t038_pra.review_bigint'), 12, '0')),
  false
);

SELECT set_config(
  'test.t038_pra.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.pending_review_resolved'),
  false
);

-- A0: confirm pre-state -- M1.status='finished' and review row unresolved.
SELECT ok(
  (SELECT status::text FROM public.matches WHERE id = current_setting('test.t038_pra.m1')::uuid) = 'finished'
  AND (SELECT resolution FROM public.match_pending_review
        WHERE id = current_setting('test.t038_pra.review_bigint')::bigint) IS NULL,
  'A0 pre-state: M1 status=finished, review row resolution IS NULL'
);

-- Impersonate admin1.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- A1: admin_resolve_match_pending_review succeeds (returns void).
SELECT lives_ok(
  format(
    $$ SELECT public.admin_resolve_match_pending_review(
         %L::uuid,
         %L,
         %L,
         %L
       ) $$,
    current_setting('test.t038_pra.review_uuid'),
    'accept_provider',
    'admin accepts provider postponed status for M1',
    'https://test.example/m1-postponed-review'
  ),
  'A1 admin_resolve_match_pending_review(accept_provider) succeeds'
);

RESET ROLE;

-- A2: M1.status flipped to 'postponed' via the nested admin_update_match call.
SELECT is(
  (SELECT status::text FROM public.matches WHERE id = current_setting('test.t038_pra.m1')::uuid),
  'postponed',
  'A2 M1.status updated from finished -> postponed via admin_update_match delegation'
);

-- A3: review row resolved with the table-canonical 'accepted' label.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.match_pending_review
     WHERE id          = current_setting('test.t038_pra.review_bigint')::bigint
       AND resolution  = 'accepted'
       AND resolved_at IS NOT NULL
       AND resolved_by = current_setting('test.t038_pra.admin_pid')::uuid
       AND notes       = 'admin accepts provider postponed status for M1'
  ),
  'A3 match_pending_review row resolved (resolution=accepted, resolved_by=admin1, notes=reason)'
);

-- A4: exactly ONE new admin.pending_review_resolved audit row with the contract shape.
SELECT ok(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.pending_review_resolved')
    = current_setting('test.t038_pra.audit_baseline')::int + 1
  AND EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.pending_review_resolved'
       AND entity_type = 'match_pending_review'
       AND actor = current_setting('test.t038_pra.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://test.example/m1-postponed-review'
       AND reason = 'admin accepts provider postponed status for M1'
       AND (new_value->>'admin_resolution_kind') = 'accept_provider'
  ),
  'A4 exactly one admin.pending_review_resolved audit row with admin1 actor, admin_rpc source, accept_provider kind'
);

SELECT * FROM finish();
ROLLBACK;
