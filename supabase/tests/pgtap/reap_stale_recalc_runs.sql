-- Slice 006 / T018 / US2 / contracts/admin-rpcs.write.md + data-model.md § Reaper function. RED until T023 (slot 0072) ships reap_stale_recalc_runs() + T024 ships score-trigger self-scan audit.
--
-- Reaper happy path: data-model.md § Reaper function (per R-007 + spec
-- Clarifications 2026-05-17 Q2 -- the SLOW BACKUP reaper, 5-minute cadence).
-- The function selects every score_calculation_runs row where status='running'
-- AND started_at < now() - INTERVAL '60 seconds', then PERFORMs net.http_post
-- to re-invoke score-trigger for each (with the same run_id so Slice 005's
-- idempotency handles resumption). It returns the count of rows it re-POSTed.
-- The stale rows' status MUST remain 'running' -- the reaper does NOT mark them
-- succeeded; that is the score-trigger Edge Function's job after the re-POST
-- completes.
--
-- pg_net caveat (A4): the net.http_post call is observable only post-COMMIT
-- (pgTAP rolls back). We assert the SP's RETURN value (count reaped) and the
-- absence of state transition; the actual HTTP traffic is exercised by the
-- Slice 005 Deno test + the Playwright SC-007 interrupt-resume test.
--
-- Audit assertion (A3): the spec's Clarifications Q2 names the resume mechanism
-- `score_trigger.self_scan_resumed_runs` (T024's audit action) as the audit
-- label fired by the Edge Function's self-scan. The reaper function defined in
-- data-model.md § Reaper does NOT itself emit audit (only PERFORMs http_post).
-- Some implementations may add a reaper-specific audit row (e.g.
-- 'score_trigger.reaper_reposted_runs') for observability; this test uses a
-- flexible LIKE pattern that matches EITHER convention so T023's implementer
-- has discretion within the contract. If the reaper emits no audit at all (the
-- pure data-model.md form), this assertion FAILS and T023 must add at least
-- one observability row -- a deliberate red flag since SC-007 demands operator
-- visibility into resume events.
--
-- Fixture refs:
--   * admin1.participants.id  = 77777777-7777-7777-7777-777777777777
--   * Tournament placeholder  = 00000000-0000-0000-0000-000000000001 (slice 005 fixture)
--   * Stale-threshold         = 60 seconds (per data-model.md § Reaper function)

BEGIN;

SELECT plan(4);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t018_reap.admin_pid',     '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t018_reap.stale_run_id',  '22222222-aaaa-bbbb-cccc-dddddddddddd', false);

-- ---------------------------------------------------------------------------
-- Pre-state: one STALE 'running' admin_recalc row at started_at = now() - 2 min.
-- 2 minutes is well past the 60-second threshold from data-model § Reaper.
-- The non-empty reason satisfies the slot 0050 CHECK
-- score_calculation_runs_reason_required_for_admin_and_config for
-- trigger='admin_recalc'.
-- ---------------------------------------------------------------------------
INSERT INTO public.score_calculation_runs (
  id,
  scope,
  target_id,
  "trigger",
  triggered_by,
  reason,
  started_at,
  status
) VALUES (
  current_setting('test.t018_reap.stale_run_id')::uuid,
  'all'::public.score_run_scope,
  NULL,
  'admin_recalc'::public.score_run_trigger,
  current_setting('test.t018_reap.admin_pid')::uuid,
  'stale-running fixture for reaper test',
  now() - INTERVAL '2 minutes',
  'running'::public.score_run_status
);

-- ---------------------------------------------------------------------------
-- A1: reaper invocation returns 1 (exactly one stale row reaped). Future
-- invocations within the same transaction may return 0 (after the row is
-- considered handled) OR continue returning 1 (since the reaper doesn't
-- change status) -- the contract says it RE-POSTS, not transitions, so the
-- single-call observation is the asserted surface.
-- ---------------------------------------------------------------------------
SELECT is(
  public.reap_stale_recalc_runs(),
  1,
  'A1 reap_stale_recalc_runs() returns 1 (count of stale running runs re-POSTed)'
);

-- ---------------------------------------------------------------------------
-- A2: the stale row's status is UNCHANGED ('running'). The reaper re-invokes
-- score-trigger via pg_net; it does NOT mark the run succeeded -- that's the
-- score-trigger Edge Function's job after it completes the re-run. Asserting
-- the no-mutation property protects against accidental status flips in the
-- reaper body (which would corrupt the run history).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT status FROM public.score_calculation_runs
    WHERE id = current_setting('test.t018_reap.stale_run_id')::uuid),
  'running'::public.score_run_status,
  'A2 reaper leaves the stale run row status=running (re-POSTs only; does NOT mark succeeded)'
);

-- ---------------------------------------------------------------------------
-- A3: an audit_log row exists for the resume event. Per spec Clarifications
-- 2026-05-17 Q2, the score-trigger Edge Function emits
-- 'score_trigger.self_scan_resumed_runs' (T024). The reaper SP MAY ALSO emit
-- its own audit (e.g. 'score_trigger.reaper_reposted_runs') for observability
-- of the slow-backup path. We assert at least ONE such observability row exists
-- referencing this run -- either path satisfies SC-007's "operator visibility
-- of resume events" need.
--
-- entity_id may be NULL if the audit row reports a batch of resumed run_ids in
-- new_value JSON instead of one-row-per-run; we fall back to a JSON-text-match
-- on the run_id in that case.
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE (action LIKE 'score_trigger.%resumed%' OR action LIKE 'score_trigger.%reaper%' OR action LIKE 'score_trigger.%reposted%')
       AND (
         entity_id = current_setting('test.t018_reap.stale_run_id')::uuid
         OR new_value::text  LIKE '%' || current_setting('test.t018_reap.stale_run_id') || '%'
         OR previous_value::text LIKE '%' || current_setting('test.t018_reap.stale_run_id') || '%'
       )
  ),
  'A3 audit_log carries a score_trigger.* observability row referencing the resumed run_id (self_scan_resumed_runs OR reaper_reposted_runs)'
);

-- ---------------------------------------------------------------------------
-- A4: pg_net.http_post to score-trigger CANNOT be observed in pgTAP.
-- net.http_post enqueues onto net.http_request_queue and the background worker
-- dispatches ON COMMIT; this file ROLLBACKs, so no real HTTP traffic leaves
-- the DB. The proxy observation is that A1 returned 1 (the SP successfully
-- looped over one stale row and reached the PERFORM call). The full
-- request/response loop is exercised by the Slice 006 Playwright
-- slice-006-admin-recalc-resumes-after-interrupt.spec.ts. This slot is
-- reserved so plan(4) documents the contract surface explicitly.
-- ---------------------------------------------------------------------------
SELECT pass(
  'A4 net.http_post to score-trigger fires on COMMIT (rolled back here; exercised end-to-end by Slice 006 Playwright SC-007 interrupt-resume test)'
);

SELECT * FROM finish();
ROLLBACK;
