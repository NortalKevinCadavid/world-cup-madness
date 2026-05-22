# Contract: Audit-failure webhook delivery + fail-closed alerts

**Feature**: 008-configuration
**Date**: 2026-05-17
**Status**: Contract (locked)
**Vendor-neutral**: Postgres `pg_cron` + `pg_net` outbound HTTP (final shipping target).

## Purpose

Closes the deferred SC-007 from Slice 007: deliver audit-write-failure alerts to operators within 5 minutes. Also handles `WCG06` fail-closed alerts (R-011 of this slice).

Slice 007 seeded `notifications.audit_failure_webhook_url` as NULL. This slice ships the delivery glue: a queue table, a `pg_cron` worker, and a `pg_net` HTTP POST.

## Tables

```sql
CREATE TABLE IF NOT EXISTS public.notification_dispatch_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL,
  payload         jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz NULL,
  failed_at       timestamptz NULL,
  last_error      text NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_dispatch_queue_pending_idx
  ON public.notification_dispatch_queue (next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
```

Privilege posture mirrors `audit_log`: REVOKE UPDATE, DELETE from app roles; INSERT only via SECURITY DEFINER paths.

## Webhook envelope (LOCKED payload schema)

POST body (`Content-Type: application/json`):

```json
{
  "schema_version": "1.0.0",
  "alert_kind": "audit_write_failure" | "config_unavailable" | "config_unavailable_eligibility" | "provider_outage",
  "environment": "<from app.environment_label>",
  "occurred_at": "<ISO8601>",
  "summary": "<single sentence>",
  "details": {
    "<alert-kind-specific fields>"
  },
  "audit_log_id": "<uuid or null>",
  "signature": "<HMAC-SHA256 of body sans signature>"
}
```

Receiving endpoints MUST verify the signature using a pre-shared secret (`notifications.audit_failure_webhook_secret`, optional jsonb config key). If absent, the receiver SHOULD treat the webhook as untrusted (informational only).

## Enqueue path

A SECURITY DEFINER function `public.enqueue_alert(p_alert_kind text, p_summary text, p_details jsonb, p_audit_log_id uuid)` is called from:

1. Slice 007's audit-write-failure code paths (whenever an INSERT into `audit_log` raises an exception — handled by an EXCEPTION block in writer SPs).
2. `config_read` when it raises `WCG06`.
3. Slice 002's sync coordinator on consecutive provider failures (already exists from Slice 002 — this slice extends it to use the shared queue).

```sql
CREATE OR REPLACE FUNCTION public.enqueue_alert(
  p_alert_kind   text,
  p_summary      text,
  p_details      jsonb,
  p_audit_log_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_url text;
BEGIN
  -- Don't enqueue if no webhook configured
  v_url := public.config_read('notifications.audit_failure_webhook_url', 'null'::jsonb) #>> '{}';
  IF v_url IS NULL OR v_url = '' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notification_dispatch_queue (channel, payload)
  VALUES (
    'webhook:audit_failure',
    jsonb_build_object(
      'schema_version', '1.0.0',
      'alert_kind',     p_alert_kind,
      'environment',    coalesce(current_setting('app.environment_label', true), 'unknown'),
      'occurred_at',    now()::text,
      'summary',        p_summary,
      'details',        p_details,
      'audit_log_id',   p_audit_log_id
    )
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
```

The function returns NULL if no webhook URL is configured (no-op), allowing safe call sites that don't care whether delivery is set up.

## Delivery worker (pg_cron + pg_net)

Schedule: every 30 seconds (to meet the 5-minute target with retry margin).

```sql
SELECT cron.schedule(
  'tournament-config-alert-dispatcher',
  '*/30 * * * * *',  -- every 30 seconds (cron supports second granularity via Supabase pg_cron extension)
  $$ SELECT public.dispatch_pending_alerts(); $$
);
```

```sql
CREATE OR REPLACE FUNCTION public.dispatch_pending_alerts()
RETURNS int  -- number dispatched
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text := public.config_read('notifications.audit_failure_webhook_url', 'null'::jsonb) #>> '{}';
  v_secret text := public.config_read('notifications.audit_failure_webhook_secret', 'null'::jsonb) #>> '{}';
  v_row record;
  v_signed_body jsonb;
  v_request_id bigint;
  v_dispatched int := 0;
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT id, payload, attempts, max_attempts
    FROM public.notification_dispatch_queue
    WHERE delivered_at IS NULL
      AND failed_at IS NULL
      AND next_attempt_at <= now()
    ORDER BY created_at ASC
    LIMIT 50
  LOOP
    -- Add signature
    v_signed_body := v_row.payload || jsonb_build_object(
      'signature',
      encode(hmac(canonical_jsonb_to_bytea(v_row.payload), v_secret::bytea, 'sha256'), 'hex')
    );

    BEGIN
      -- pg_net is Supabase's async HTTP extension
      SELECT net.http_post(
        url     := v_url,
        body    := v_signed_body,
        headers := jsonb_build_object('Content-Type', 'application/json'),
        timeout_milliseconds := 10000
      ) INTO v_request_id;

      -- Mark as in-flight; the http_response trigger (below) finalizes status
      UPDATE public.notification_dispatch_queue
        SET attempts = attempts + 1,
            next_attempt_at = now() + (attempts + 1) * interval '60 seconds'
      WHERE id = v_row.id;

      v_dispatched := v_dispatched + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.notification_dispatch_queue
        SET attempts = attempts + 1,
            last_error = SQLERRM,
            next_attempt_at = now() + (attempts + 1) * interval '60 seconds'
      WHERE id = v_row.id;
    END;
  END LOOP;

  -- Mark exhausted-attempt rows as failed
  UPDATE public.notification_dispatch_queue
    SET failed_at = now()
  WHERE delivered_at IS NULL
    AND failed_at IS NULL
    AND attempts >= max_attempts;

  RETURN v_dispatched;
END;
$$;
```

A separate trigger on `net._http_response` (Supabase pg_net internal) marks the corresponding queue row as `delivered_at = response.completed_at` when the HTTP response is 2xx, or leaves it pending (allowing retry) when 5xx, or marks `failed_at` when 4xx (client error; won't retry).

## Privilege model

```sql
REVOKE ALL ON public.notification_dispatch_queue FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_alert(text, text, jsonb, uuid) TO authenticated, service_role;
-- dispatch_pending_alerts is called only by pg_cron; no direct grant needed
```

The queue table is invisible to participants. Admins access it via a separate read RPC (similar to `audit_search`) — `admin_alert_queue_recent(p_limit int) RETURNS TABLE(...)`.

## 5-minute SC-007 target verification

| Event timeline | Time |
|---|---|
| t=0s: Audit write fails OR `config_read` raises `WCG06` | event |
| t≤1s: `enqueue_alert` writes to queue | enqueue |
| t≤30s: Next `dispatch_pending_alerts` tick | dispatch |
| t≤60s: HTTP POST completes (typical network) | delivered |
| t≤180s: First retry if 5xx | retry |
| t≤300s: Second retry if 5xx | retry |

Worst-case delivery: ~5 minutes assuming up to one transient 5xx. Meets SC-007.

## Cross-slice contract

- Closes Slice 007's deferred SC-007.
- Reads `notifications.audit_failure_webhook_url` and `notifications.audit_failure_webhook_secret` via `config_read`.
- Writes to `notification_dispatch_queue` (table owned by this slice).
- Does NOT write to `audit_log` itself (would create recursion if the audit failure path emitted more audit writes).
- Consumed by external operations: Nortal Slack incoming webhook OR PagerDuty Events API OR similar.

## Operational runbook reference

Operations must configure:
1. `notifications.audit_failure_webhook_url` — the receiver URL.
2. (Optional) `notifications.audit_failure_webhook_secret` — the HMAC secret.
3. The receiving endpoint must idempotently handle duplicates (queue retries may double-deliver if the HTTP response is lost).

`docs/runbooks/audit-write-failure.md` (created by Slice 007 T030) MUST be extended in this slice's polish phase to document the webhook receiver setup.
