-- Slice 006 / SC-007 / Clarifications 2026-05-17 Q2 — SLOW BACKUP REAPER (5-min cadence).
-- Primary resume mechanism is the score-trigger Edge Function's self-scan at startup (T024).
-- This reaper handles the case where no Edge Function invocation happens for >5 minutes after an interrupt.
-- Migration slot 0072 per D-026.
--
-- ---------------------------------------------------------------------------
-- Implementation notes (T023 / US2)
-- ---------------------------------------------------------------------------
-- Stale threshold: 60 seconds (data-model.md § Reaper function). The cron
-- cadence is locked at 5 minutes per Clarifications 2026-05-17 Q2 — the spec
-- intentionally trades latency for low pressure on pg_cron because the
-- score-trigger Edge Function's startup self-scan (T024) is the PRIMARY
-- resume mechanism and achieves SC-007's "within 10 seconds of restart"
-- target. This reaper only matters if no Edge Function invocation occurs for
-- >5 minutes after an interrupt.
--
-- Behaviour: for every score_calculation_runs row where status='running' AND
-- started_at < now() - 60 seconds, re-POST to the score-trigger Edge Function
-- with the SAME run_id so Slice 005's idempotency (research.md § R-002)
-- handles resumption. The reaper itself NEVER mutates status — neither to
-- 'succeeded' nor 'failed'. The score-trigger Edge Function owns terminal
-- state transitions after it completes the re-run.
--
-- Audit: when at least one stale row is re-POSTed, a single batch audit row
-- is inserted with action='score_trigger.reaper_reposted_runs' carrying the
-- resumed run_ids array in new_value. The T018 pgTAP test accepts this
-- action label via the LIKE pattern 'score_trigger.%reposted%' (alongside
-- the T024 Edge Function's 'score_trigger.self_scan_resumed_runs' label).
--
-- pg_net caveat: net.http_post enqueues onto net.http_request_queue and the
-- background worker dispatches ON COMMIT. The COMMIT below ensures the
-- enqueued requests actually fire. pgTAP tests rollback so they observe only
-- the SP's RETURN value (see T018's A4 doc-block).
--
-- Permissions: SECURITY DEFINER with REVOKE EXECUTE FROM PUBLIC. pg_cron's
-- scheduled job runs as the database owner (postgres) so it does not need
-- an explicit GRANT.

BEGIN;

-- ---------------------------------------------------------------------------
-- public.reap_stale_recalc_runs()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reap_stale_recalc_runs()
  RETURNS int
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp, net
AS $$
DECLARE
  v_count       int   := 0;
  v_run         RECORD;
  v_url         text;
  v_secret      text;
  v_resumed_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Read URL + secret from session GUCs (operator sets via ALTER DATABASE,
  -- mirroring the pattern from slot 0027 / sync-catalog-trigger).
  v_url    := current_setting('app.score_trigger_url',    true);
  v_secret := current_setting('app.score_trigger_secret', true);

  -- Find stale running runs (started_at > 60 seconds ago, per Clarifications
  -- Q2 + data-model.md § Reaper function). Ordered oldest-first so a backlog
  -- gets the worst offenders first.
  FOR v_run IN
    SELECT id, scope, target_id
      FROM public.score_calculation_runs sr
     WHERE sr.status = 'running'
       AND sr.started_at < (now() - interval '60 seconds')
     ORDER BY sr.started_at ASC
  LOOP
    -- Re-POST to score-trigger via pg_net (best-effort). The same run_id is
    -- passed so Slice 005's idempotency guard (23505 on duplicate INSERT)
    -- handles resumption cleanly.
    IF v_url IS NOT NULL AND v_url <> '' AND v_secret IS NOT NULL AND v_secret <> '' THEN
      PERFORM net.http_post(
        url     := v_url,
        headers := jsonb_build_object(
          'Content-Type',     'application/json',
          'X-Internal-Auth',  v_secret
        ),
        body    := jsonb_build_object(
          'scope',     v_run.scope::text,
          'target_id', v_run.target_id,
          'trigger',   'reaper_resume',
          'run_id',    v_run.id,
          'reason',    'reaper_resume_after_stale_>60s'
        )
      );
    END IF;

    v_resumed_ids := v_resumed_ids || v_run.id;
    v_count       := v_count + 1;
  END LOOP;

  -- Emit a single batch audit row IF any rows were resumed. This gives the
  -- operator visibility required by SC-007 without one-row-per-run churn.
  -- Action label `score_trigger.reaper_reposted_runs` matches T018 pgTAP's
  -- accepted patterns ('score_trigger.%reposted%').
  IF v_count > 0 THEN
    INSERT INTO public.audit_log (
      actor,
      action,
      entity_type,
      entity_id,
      previous_value,
      new_value,
      reason,
      source
    ) VALUES (
      NULL,  -- system action, no human actor
      'score_trigger.reaper_reposted_runs',
      'score_calculation_run',
      NULL,
      NULL,
      jsonb_build_object(
        'resumed_run_ids', to_jsonb(v_resumed_ids),
        'count',           v_count
      ),
      'slow backup reaper at 5-min cadence',
      'trigger'
    );
  END IF;

  RETURN v_count;
END;
$$;

-- Permissions: only postgres can call (system function). cron.schedule runs
-- the body as the database owner so no GRANT to service_role / authenticated.
REVOKE EXECUTE ON FUNCTION public.reap_stale_recalc_runs() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- pg_cron schedule (5-minute cadence per Clarifications 2026-05-17 Q2)
-- ---------------------------------------------------------------------------
-- Idempotent: unschedule any prior job with this name before (re-)scheduling,
-- mirroring slot 0027's sync-catalog-trigger pattern. The first-run case
-- (no prior schedule) raises which we swallow.
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('reap-stale-recalcs');
  EXCEPTION WHEN OTHERS THEN
    -- First-run case: no job exists yet. Swallow.
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'reap-stale-recalcs',
  '*/5 * * * *',                                    -- every 5 minutes (locked)
  'SELECT public.reap_stale_recalc_runs();'
);

COMMIT;
