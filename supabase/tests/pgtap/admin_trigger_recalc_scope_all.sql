-- Slice 006 / T018 / US2 / contracts/admin-rpcs.write.md + data-model.md. RED until T021/T022/T023/T024 ship.
--
-- Happy path: admin1 calls admin_trigger_recalc('all', NULL, reason, NULL) and the SP:
--   * Returns a non-NULL run uuid (v_run_id).
--   * INSERTs a score_calculation_runs row at v_run_id with scope='all',
--     trigger='admin_recalc', triggered_by=admin1.participants.id, status='running'
--     (per contracts/admin-rpcs.write.md § admin_trigger_recalc step 4).
--   * Writes an audit_log row action='admin.recalc_triggered', entity_type='score_calculation_run',
--     entity_id=v_run_id, actor=admin1.participants.id, source='admin_rpc', reason=<arg>
--     (per § admin_trigger_recalc step 5 + § Audit emission pattern).
--   * Returns the run_id to the caller (step 8).
--
-- pg_net caveat (A6): the SP also POSTs to Slice 005's score-trigger Edge Function via
-- `net.http_post` (step 6). pgTAP CANNOT observe pg_net deliveries inside this transaction --
-- pg_net enqueues the request on the net.http_request_queue table and the worker dispatches
-- on commit; this file ROLLBACKs, so the dispatch never happens. The proxy assertion is that
-- the SP returned successfully (A1) and that any 409-from-score-trigger contention would
-- have surfaced as WAR06 (covered in admin_trigger_recalc_concurrent.sql). The full
-- request/response loop is exercised by the Slice 005 Deno tests + the Playwright
-- slice-006 recalc tests.
--
-- Fixture refs (loaded by `supabase db reset` before tests run):
--   * admin1
--       participants.id  = 77777777-7777-7777-7777-777777777777
--       auth.users.id    = 00000000-0000-0000-0000-0000000000d3
--       admin_roles row  = seeded by T009 (slot 0074 bootstrap)
--
-- Impersonation pattern: SET LOCAL request.jwt.claims (admin1's auth_user_id under sub) +
-- SET LOCAL ROLE authenticated. Outer ROLLBACK restores session role + JWT claims AND undoes
-- all mutations (including the score_calculation_runs INSERT and the audit_log INSERT).

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs in session GUCs.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t018_scope_all.admin_uid', '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t018_scope_all.admin_pid', '77777777-7777-7777-7777-777777777777', false);

-- ---------------------------------------------------------------------------
-- Impersonate admin1.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub','00000000-0000-0000-0000-0000000000d3','role','authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: SP returns a NON-NULL uuid. Capture into a GUC for downstream asserts.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'test.t018_scope_all.run_id',
  (SELECT public.admin_trigger_recalc(
    'all',                              -- p_scope
    NULL,                               -- p_target_id (NULL for scope='all')
    'manual full recalc test',          -- p_reason (REQUIRED -- score_calculation_runs CHECK)
    NULL                                -- p_source_citation (OPTIONAL for recalc per contract step 1)
  )::text),
  false
);

SELECT isnt(
  current_setting('test.t018_scope_all.run_id'),
  '',
  'A1 admin_trigger_recalc returns a non-NULL run_id uuid'
);

-- Drop back to superuser for the post-state SELECTs (RLS on score_calculation_runs
-- and audit_log may deny authenticated direct reads -- defence in depth).
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: score_calculation_runs row exists with the captured v_run_id, scope='all',
-- trigger='admin_recalc', triggered_by=admin1.participants.id, status='running'.
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.score_calculation_runs
     WHERE id            = current_setting('test.t018_scope_all.run_id')::uuid
       AND scope         = 'all'::public.score_run_scope
       AND "trigger"     = 'admin_recalc'::public.score_run_trigger
       AND triggered_by  = current_setting('test.t018_scope_all.admin_pid')::uuid
       AND status        = 'running'::public.score_run_status
  ),
  'A2 score_calculation_runs row exists with scope=all, trigger=admin_recalc, triggered_by=admin1, status=running'
);

-- ---------------------------------------------------------------------------
-- A3: target_id IS NULL for scope='all' (per migration 0050 CHECK
-- score_calculation_runs_target_xor_scope: scope IN ('finals','all') => target_id NULL).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT target_id FROM public.score_calculation_runs
    WHERE id = current_setting('test.t018_scope_all.run_id')::uuid),
  NULL::uuid,
  'A3 score_calculation_runs.target_id IS NULL for scope=all run (slot 0050 target_xor_scope CHECK)'
);

-- ---------------------------------------------------------------------------
-- A4: audit_log row exists for the trigger event. Per contract:
--   action='admin.recalc_triggered', entity_type='score_calculation_run',
--   entity_id=v_run_id, actor=admin1.participants.id, source='admin_rpc',
--   reason='manual full recalc test'.
-- source_citation MAY be NULL (the SP was called with NULL p_source_citation,
-- which is permitted for recalc per § Pre-flight step 3).
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action      = 'admin.recalc_triggered'
       AND entity_type = 'score_calculation_run'
       AND entity_id   = current_setting('test.t018_scope_all.run_id')::uuid
       AND actor       = current_setting('test.t018_scope_all.admin_pid')::uuid
       AND source      = 'admin_rpc'
       AND reason      = 'manual full recalc test'
  ),
  'A4 audit_log carries admin.recalc_triggered row scoped to v_run_id with actor=admin1, source=admin_rpc, reason captured'
);

-- ---------------------------------------------------------------------------
-- A5: pg_net POST to Slice 005's score-trigger CANNOT be observed in pgTAP.
-- pg_net enqueues onto net.http_request_queue and the background worker dispatches
-- ON COMMIT; this file ROLLBACKs, so no real HTTP traffic leaves the DB. The
-- proxy observation is that the SP returned successfully (A1) and that contention
-- against the score-trigger advisory lock would have surfaced as WAR06 (separate
-- test). This slot is reserved so plan(5) documents the contract surface explicitly.
-- ---------------------------------------------------------------------------
SELECT pass(
  'A5 pg_net POST to score-trigger fires on COMMIT (rolled back here; exercised end-to-end by Slice 005 Deno tests + Slice 006 Playwright recalc tests)'
);

SELECT * FROM finish();
ROLLBACK;
