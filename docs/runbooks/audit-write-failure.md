# Runbook: Audit Write Failure

**Slice**: 007 Audit Trail
**Owner**: Backend on-call
**Last reviewed**: 2026-05-21
**Reference**: `specs/007-audit-trail/spec.md` Clarification Q3, `specs/007-audit-trail/research.md` § R-011

---

## (a) Symptoms

- Postgres errors in Supabase logs containing `audit_log`
- Application 5xx responses on state-changing endpoints (predictions, final_predictions, admin RPCs, score-trigger)
- Specific error fingerprints to grep for:
  - `relation "audit_log" does not exist`
  - `permission denied for table audit_log`
  - `duplicate key value violates unique constraint "audit_log_sequence_id_uk"` — sequence collision (extremely unlikely with bigserial)
  - `null value in column "actor" violates not-null constraint` — trigger failed to resolve actor
- `score_calculation_runs` rows stuck in `status='running'` past the 60-second SC-007 boundary

## (b) Likely causes

- **DB unavailable**: Supabase outage, network partition, connection pool exhaustion
- **Sequence exhausted**: `audit_log_sequence_id_seq` has wrapped past `bigint` max (extremely unlikely — bigint = 9.2 × 10^18; at 1M audits/day, this is > 25,000 years)
- **Trigger failure**: A SECURITY DEFINER trigger that writes audit rows (slice 003/004/005/006) hit an exception. Logs will show the trigger's error message.
- **RLS misconfiguration**: A migration accidentally tightened the narrow INSERT policies at slots 0010/0073/0076 and broke a legitimate writer.
- **Tamper-resistance posture overrun**: Someone GRANT'd UPDATE/DELETE back to authenticated/anon/service_role contrary to T005's REVOKE — surface via `\dp public.audit_log` in psql.

## (c) Immediate response

1. **Verify DB connectivity**:
   ```bash
   psql $SUPABASE_DB_URL -c "SELECT 1"
   ```
2. **Check Supabase status page**: https://status.supabase.com
3. **Check pg_locks for blocking**:
   ```sql
   SELECT pid, mode, granted, relation::regclass, query
     FROM pg_locks JOIN pg_stat_activity USING (pid)
    WHERE NOT granted;
   ```
4. **Check current GRANTs on audit_log**:
   ```sql
   \dp public.audit_log
   ```
   Should show `INSERT/SELECT` for authenticated, anon, service_role — and NO `UPDATE/DELETE`.
5. **Check recent migration history**:
   ```sql
   SELECT name, executed_at FROM supabase_migrations.schema_migrations ORDER BY executed_at DESC LIMIT 20;
   ```
6. **Tail Supabase logs for the trigger emitting the error**:
   ```bash
   supabase logs --since 10m | grep audit_log
   ```

## (d) Escalation

- **Page on-call DBA** if:
  - DB is unreachable for > 5 minutes
  - audit_log is corrupted (rows mutated, sequence reset)
  - A migration broke writers and rolling back is not safe
- **Page security on-call** if:
  - Tamper-resistance posture has been bypassed (unauthorized UPDATE/DELETE detected)
  - Audit ring tampering suspected

## (e) Notification webhook (forward-compatible)

Slice 008 will add webhook delivery hooking the `tournament_config` key `notifications.audit_failure_webhook_url` (seeded by slot 0076 T006 with default `null`).

When implemented, the webhook will fire when:
- An application-level write to `audit_log` fails with any SQLSTATE
- The reaper (slot 0072) re-POSTs > 5 stale runs in a 5-minute window

To enable manually pre-Slice-008:
```sql
UPDATE public.tournament_config
   SET value = '"https://hooks.example.com/audit-failure"'::jsonb
 WHERE key = 'notifications.audit_failure_webhook_url';
```

## (f) Manual webhook verification (T067 follow-up)

The pgTAP test `supabase/tests/008_configuration/webhook_dispatch.sql` (T067)
exercises the deterministic, in-transaction behaviour of `enqueue_alert` and
`dispatch_pending_alerts`: queue row shape, `attempts` increment, exponential
backoff scheduling, skip-already-delivered semantics, and the unset-URL
no-op branch. It does NOT verify end-to-end webhook delivery because:

1. `extensions.http_post` (pg_net) is asynchronous — the test transaction
   commits before pg_net's worker actually issues the HTTP request.
2. Per slot 0077 D-T063-B, the trigger on `net._http_response` that
   populates `delivered_at` on a 2xx response is operator-wired and lives
   outside the migration set.

To verify end-to-end delivery against a real receiver (do this once per
environment after wiring the response trigger):

1. **Stand up a test receiver.** Pick one:
   - `webhook.site` — copy the unique URL it gives you.
   - A local `httpbin` container: `docker run -p 9000:80 kennethreitz/httpbin`
     and use `http://host.docker.internal:9000/post` from inside the
     Supabase Postgres container.
   - A small Python listener:
     ```bash
     python -m http.server 9000  # logs requests; returns 200 on GET, 501 on POST
     ```
     (use a real receiver for POST 2xx verification — `python -m http.server`
     only handles GET).

2. **Point the config at the receiver:**
   ```sql
   UPDATE public.tournament_config
      SET value = '"<receiver URL from step 1>"'::jsonb
    WHERE key = 'notifications.audit_failure_webhook_url';
   ```

3. **Enqueue a test alert:**
   ```sql
   SELECT public.enqueue_alert(
     'audit_write_failure',
     'Manual webhook verification',
     jsonb_build_object('source', 'runbook-(f)'),
     NULL
   );
   ```

4. **Tick the dispatcher** (or wait ≤30s for pg_cron):
   ```sql
   SELECT public.dispatch_pending_alerts();
   ```

5. **Confirm the receiver logged a POST** with `Content-Type:
   application/json` and a body matching the envelope shape from
   `contracts/audit-failure-webhook.outbound.md`.

6. **Verify `delivered_at` populated** (requires the
   `net._http_response` trigger to be live):
   ```sql
   SELECT id, attempts, delivered_at, failed_at, last_error
     FROM public.notification_dispatch_queue
    ORDER BY created_at DESC
    LIMIT 5;
   ```
   On success: `delivered_at` is non-null and `last_error` is null. On
   failure: `attempts` increments per tick, `last_error` carries the
   connect/HTTP error, and after `max_attempts` (default 5) `failed_at`
   is stamped.

7. **Reset the config** to the seeded default to avoid leaking the test
   receiver URL into operator-visible state:
   ```sql
   UPDATE public.tournament_config
      SET value = '"null"'::jsonb
    WHERE key = 'notifications.audit_failure_webhook_url';
   ```

---

## Audit-failure webhook delivery (Slice 008+)

This section supersedes the forward-compatible stub in (e) once Slice 008 is
deployed. It documents the production configuration path, receiver
contract, queue inspection, manual re-triggering, and known limitations
of the webhook delivery infrastructure (`enqueue_alert` /
`dispatch_pending_alerts` / `notification_dispatch_queue`).

### (a) Configuration via `/admin/config/retention`

The webhook URL is managed as a versioned `tournament_config` entry. Do
not `UPDATE` the table directly in production — use the admin UI so the
write goes through the audited config-update RPC.

1. Sign in as an admin (role `admin` on the active tournament).
2. Navigate to `/admin/config/retention`.
3. Locate the **Audit-failure webhook URL** section.
4. Enter the receiver URL. Validation rules:
   - Production: MUST start with `https://`.
   - Local/dev only: `http://localhost:*` is permitted.
5. Provide a **reason** plus a **source citation** (link to the change
   ticket or runbook). Click **Save**.
6. (Optional) In the same panel, set
   `notifications.audit_failure_webhook_secret`. The dispatcher will
   HMAC-SHA256 every outbound payload with this secret and write the
   hex digest into `payload.signature`. If the secret is unset,
   payloads ship with `"signature": null` and the receiver SHOULD
   treat them as untrusted/informational only.

**Verification after Save:**
- A new row appears in `tournament_config_versions` with
  `key = 'notifications.audit_failure_webhook_url'`.
- A new row appears in `audit_log` with
  `action = 'tournament_config.notifications.audit_failure_webhook_url'`.

### (b) Required receiver behavior

Any receiver wired to the audit-failure webhook MUST implement the
following. Failure to do so will silently drop alerts or, worse, accept
forged ones.

**Idempotency.** `dispatch_pending_alerts()` retries failed deliveries
with exponential backoff (60s, 120s, 180s, …). The receiver MUST handle
duplicate deliveries gracefully — typically by hashing the payload body
(or by keying on the queue row's `id` if a future enhancement plumbs it
into the payload envelope) and short-circuiting repeats. Treat every
inbound POST as at-least-once.

**HMAC verification.** When
`notifications.audit_failure_webhook_secret` is set, the dispatcher
computes `HMAC-SHA256(payload_jsonb_text, secret)` and writes the hex
digest into `payload.signature` BEFORE shipping. The receiver MUST:

1. Read the request body.
2. Parse it as JSON; extract and remove the `signature` field.
3. Re-serialize the remaining fields deterministically OR compute the
   HMAC over the raw body with `signature` stripped (preferred — match
   the dispatcher's canonicalization; see
   `contracts/audit-failure-webhook.outbound.md`).
4. Compare the computed digest to the received `signature` using a
   **constant-time** comparison (e.g. `hmac.compare_digest` in Python,
   `crypto.timingSafeEqual` in Node). Plain `==` is a timing-attack
   vector.
5. Reject (4xx) if mismatch.

**Response handling — dispatcher semantics.**

| Receiver response | Dispatcher action |
| --- | --- |
| `2xx` | Marks `delivered_at` (requires operator-wired pg_net response trigger — see (e) below and D-T063-B in slot 0077). |
| `4xx` | Marks `failed_at`; queue row is terminal and NOT retried. Receivers MUST be certain a 4xx is intended — a transient 4xx masquerading as permanent will drop the alert. |
| `5xx` / network error / timeout | Increments `attempts`, schedules retry at `next_attempt_at` via exponential backoff. Row marks `failed_at` only after `attempts >= max_attempts` (default 5). |

**Payload schema (LOCKED — see `contracts/audit-failure-webhook.outbound.md`):**

```json
{
  "schema_version": "1.0.0",
  "alert_kind": "audit_write_failure | config_unavailable | config_unavailable_eligibility | provider_outage",
  "environment": "<env label>",
  "occurred_at": "<ISO8601>",
  "summary": "<single sentence>",
  "details": { "<alert-kind-specific fields>" },
  "audit_log_id": "<uuid or null>",
  "signature": "<hex HMAC-SHA256 or null>"
}
```

### (c) Inspecting `notification_dispatch_queue`

`notification_dispatch_queue` is REVOKE-ALL'd from `authenticated`,
`anon`, and `service_role` — only the `postgres` superuser /
db-owner role can read it. Connect via psql:

```bash
psql "$SUPABASE_DB_URL"
```

**Pending deliveries** (not yet delivered, not terminal-failed):

```sql
SELECT id, channel, attempts, max_attempts, next_attempt_at,
       payload->>'alert_kind' AS kind
  FROM public.notification_dispatch_queue
 WHERE delivered_at IS NULL
   AND failed_at IS NULL
 ORDER BY created_at ASC
 LIMIT 50;
```

**Recently delivered:**

```sql
SELECT id, channel, attempts, delivered_at,
       payload->>'summary' AS summary
  FROM public.notification_dispatch_queue
 WHERE delivered_at IS NOT NULL
 ORDER BY delivered_at DESC
 LIMIT 20;
```

**Terminally failed** (exhausted retries OR explicit 4xx):

```sql
SELECT id, attempts, last_error, payload
  FROM public.notification_dispatch_queue
 WHERE failed_at IS NOT NULL
 ORDER BY failed_at DESC
 LIMIT 20;
```

### (d) Manually re-triggering `dispatch_pending_alerts()`

`pg_cron` ticks `dispatch_pending_alerts()` on a fixed cadence (see
slot 0077 schedule). It can also be invoked ad-hoc by any role with
EXECUTE privilege (typically `service_role` or `postgres`):

```sql
SELECT public.dispatch_pending_alerts() AS dispatched_count;
```

The function returns the number of queue rows it attempted on this
tick (typically 0..50, capped by the dispatcher's batch limit).
After the call, re-run the queries from (c) to confirm:

- `attempts` incremented on each row touched.
- `next_attempt_at` advanced per the exponential-backoff schedule.
- For 2xx responses (with the operator-wired finalizer live),
  `delivered_at` is non-null.

### (e) Known limitations

- **pg_net response-side trigger NOT yet wired** (D-T063-B in slot
  0077): the dispatch tick fires the HTTP POST via
  `extensions.http_post`, but no trigger on `net._http_response`
  finalizes `delivered_at` / `failed_at` based on the HTTP response.
  Operators MUST wire this manually post-deployment. Reference
  Supabase docs: search for **"pg_net http_response trigger"**.
- **End-to-end CI testing not feasible.** pg_net requires a real HTTP
  receiver to exercise the `2xx → delivered_at` flow. The pgTAP test
  `supabase/tests/008_configuration/webhook_dispatch.sql` (T067)
  covers the deterministic enqueue/dispatch path, but assertion A6
  SIMULATES the finalizer via a direct `UPDATE` rather than going
  through pg_net.
- **Manual smoke verification cadence — every release.** Before
  cutting a release, an operator MUST:
  1. Configure a sandbox receiver URL (e.g.
     [webhook.site](https://webhook.site)) via
     `/admin/config/retention`.
  2. Trigger a synthetic audit-write failure:
     ```sql
     SELECT public.enqueue_alert(
       'audit_write_failure',
       'manual smoke',
       '{}'::jsonb,
       NULL
     );
     ```
  3. Wait ≤30s for the pg_cron tick OR call
     `SELECT public.dispatch_pending_alerts();` manually.
  4. Verify the sandbox receiver logged the POST with a well-formed
     payload (schema per (b)).
  5. Verify `delivered_at` is populated on the queue row (assumes
     the operator-wired finalizer is live).
  6. Reset the URL to the production receiver (or `null` for
     pre-production environments).
- **Drift D-T069-A.1.** The `system.config_unavailable` audit action
  referenced in some research/spec docs is NOT emitted by any writer
  in the shipped migration set. The fail-closed paths (eligibility,
  locking) trap WCG06 to safe defaults without writing audit rows. A
  follow-up slice should add
  `enqueue_alert('config_unavailable', …)` calls inside those trap
  blocks so the webhook fires on config outages.

---

## Reference
- Tamper-resistance posture: `specs/007-audit-trail/contracts/audit-log.schema.md` § Tamper-resistance posture (LOCKED)
- Notification design: `specs/007-audit-trail/research.md` § R-011
- Clarification Q3: `specs/007-audit-trail/spec.md`
- Audit writers (cross-slice):
  - Slice 003: `0033_predictions_audit_trigger.sql`
  - Slice 004: `0043_final_predictions_audit_trigger.sql`
  - Slice 005: `0055_score_audit_trigger.sql`
  - Slice 006: admin SP audit emissions (slots 0064, 0065, 0068, 0070)
  - Slice 005 Edge Fn: `score_trigger.self_scan_resumed_runs`, `score_trigger.reaper_reposted_runs`
