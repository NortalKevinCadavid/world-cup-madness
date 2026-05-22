-- Slice 006 / T018 / US2 / contracts/admin-rpcs.write.md + data-model.md. RED until T021/T022/T023/T024 ship.
--
-- Audit <-> run cross-link. Per contracts/admin-rpcs.write.md § admin_trigger_recalc
-- step 4 + step 5, the SP MUST set the new score_calculation_runs.triggering_audit_log_id
-- column (slot 0063 / T005) to the id of the audit_log row it emits for the trigger
-- event (action='admin.recalc_triggered'). This lets queries answer
-- "which admin override triggered this recalc?" in a single JOIN.
--
-- Step 5 in the contract calls out: "the audit row must be written FIRST so
-- score_calculation_runs.triggering_audit_log_id can reference it; use deferred
-- constraints or two-step INSERT." This test asserts the resulting equality
-- after the SP returns, regardless of the implementation strategy.
--
-- Fixture refs:
--   * admin1.participants.id = 77777777-7777-7777-7777-777777777777
--   * admin1.auth.users.id   = 00000000-0000-0000-0000-0000000000d3

BEGIN;

SELECT plan(2);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t018_links.admin_pid', '77777777-7777-7777-7777-777777777777', false);

-- ---------------------------------------------------------------------------
-- Impersonate admin1 and trigger a recalc.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub','00000000-0000-0000-0000-0000000000d3','role','authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT set_config(
  'test.t018_links.run_id',
  (SELECT public.admin_trigger_recalc(
    'all',
    NULL,
    'audit link verification',
    NULL
  )::text),
  false
);

-- Drop back to superuser for post-state SELECTs.
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A1: score_calculation_runs.triggering_audit_log_id for the v_run_id row
-- equals the id of the admin.recalc_triggered audit row scoped to v_run_id.
-- This is the contract-locked link (data-model § Cross-slice ownership map row
-- "score_calculation_runs.triggering_audit_log_id" + § Recalculation Run).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT triggering_audit_log_id
     FROM public.score_calculation_runs
    WHERE id = current_setting('test.t018_links.run_id')::uuid),
  (SELECT id FROM public.audit_log
    WHERE action      = 'admin.recalc_triggered'
      AND entity_type = 'score_calculation_run'
      AND entity_id   = current_setting('test.t018_links.run_id')::uuid
      AND actor       = current_setting('test.t018_links.admin_pid')::uuid),
  'A1 score_calculation_runs.triggering_audit_log_id points at the admin.recalc_triggered audit row for v_run_id (slot 0063 link)'
);

-- ---------------------------------------------------------------------------
-- A2: bidirectional consistency -- the audit row's entity_id MUST equal
-- v_run_id. (The link from audit_log -> run is by entity_id, NOT by an FK
-- column; entity_id is a generic pointer across entity_type values.)
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.audit_log al
      JOIN public.score_calculation_runs scr
        ON scr.triggering_audit_log_id = al.id
     WHERE al.action      = 'admin.recalc_triggered'
       AND al.entity_type = 'score_calculation_run'
       AND al.entity_id   = scr.id
       AND scr.id         = current_setting('test.t018_links.run_id')::uuid
  ),
  'A2 bidirectional link: audit_log.entity_id = score_calculation_runs.id for the joined row pair'
);

SELECT * FROM finish();
ROLLBACK;
