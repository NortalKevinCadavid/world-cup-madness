-- webhook_dispatch.sql
-- Slice 008 Tournament Configuration | Task T067 | Phase 8b
--
-- Spec anchors:
--   spec.md § US7 / SC-007 -- "Audit-write failures notify operators within
--   5 minutes via outbound webhook." Slice 008 ships the deterministic part
--   of that delivery chain: a notification_dispatch_queue table (T061), an
--   enqueue_alert RPC (T062), a pg_net-backed dispatch_pending_alerts worker
--   (T063), and a 30-second pg_cron schedule (T064). End-to-end delivery
--   verification (HTTP receiver returns 2xx, queue row's delivered_at gets
--   populated by a net._http_response trigger) is OUT of slot 0077's
--   transactional scope per D-T063-B and is operator-wired per the
--   audit-write-failure runbook.
--
-- Contract source of truth:
--   contracts/audit-failure-webhook.outbound.md
--     § Tables       -- notification_dispatch_queue shape (slot 0077 L2268..L2280).
--     § Enqueue path -- enqueue_alert no-ops (RETURNS NULL) when the
--                       webhook URL is unset / "null" / empty (L2326..L2328).
--     § Delivery worker
--                    -- dispatch_pending_alerts walks rows where
--                       delivered_at IS NULL AND failed_at IS NULL AND
--                       next_attempt_at <= now() (L2409..L2417), POSTs via
--                       extensions.http_post, increments attempts and
--                       schedules exponential backoff (next_attempt_at =
--                       now() + ((attempts+1) * interval '60 seconds')),
--                       both on success AND in the EXCEPTION branch
--                       (L2439..L2451). Rows already marked delivered_at /
--                       failed_at are skipped by the WHERE filter (L2412..L2413).
--
-- Implementation reference: supabase/migrations/0077_configuration.sql §
--   T061 notification_dispatch_queue (L2259..L2290)
--   T062 enqueue_alert (L2293..L2352)
--   T063 dispatch_pending_alerts (L2355..L2469)
--   T064 pg_cron schedule (L2471 onwards) -- not exercised here; cron firing
--        belongs in integration runtime, not pgTAP.
--
-- RUNTIME-DEFERRED: This test cannot be executed locally until
-- `supabase start` (Docker stack) becomes available. It is syntactically
-- valid SQL and is added to the pgTAP runner; CI will pick it up once the
-- runtime gate flips. Spec Kit slice 008 phase 8b tracks this as a
-- shipped-but-unverified deliverable.
--
-- IMPORTANT -- end-to-end webhook delivery is NOT verified by this test.
-- pg_net's http_post is async; a real 2xx -> delivered_at finalizer requires
-- (a) a live HTTP receiver listening at the configured URL, and (b) a
-- response trigger on net._http_response that updates the queue row when
-- the response arrives. Neither (a) nor (b) ships in the migration set
-- (D-T063-B in slot 0077). Operators verify those two pieces manually per
-- docs/runbooks/audit-write-failure.md § (f) "Manual webhook verification".
-- This test exercises only the DETERMINISTIC, IN-TRANSACTION behaviour:
--   * enqueue produces a queue row with the correct shape (A1, A2, A3).
--   * dispatch_pending_alerts increments attempts and pushes
--     next_attempt_at into the future regardless of pg_net success/failure
--     (A4, A5) -- both branches of the dispatch body's TRY/EXCEPT increment
--     attempts identically per slot 0077 L2439..L2451.
--   * A queue row that already has delivered_at set is skipped on
--     subsequent ticks (A7) -- this is the contract that protects against
--     double-delivery once the response finalizer eventually lands.
--   * enqueue is a no-op (RETURNS NULL) when the webhook URL is unset (A8).
--
-- NOTE on A6 -- delivered_at population is SIMULATED here via a direct
-- UPDATE inside a DO block. In production, the response trigger on
-- net._http_response is what writes delivered_at on a 2xx response (T075
-- runbook). The simulation only proves the column accepts the write and
-- that A7's "skip delivered rows" contract is exercised against a row that
-- ACTUALLY has delivered_at populated. It does NOT prove the response
-- trigger itself works -- that is intentionally out of scope (see
-- RUNTIME-DEFERRED note above + runbook manual verification step).
--
-- Test scope (plan(8)):
--   A1: enqueue_alert returns a non-null queue uuid when the webhook URL is
--       configured (proves the no-op branch of L2326..L2328 was NOT taken).
--   A2: the resulting queue row's payload->>'alert_kind' matches the
--       enqueue_alert p_alert_kind argument (proves the JSON envelope wired
--       per L2333..L2341 is shaped per contract).
--   A3: the resulting queue row's attempts starts at 0 (defaults per
--       L2272 DEFAULT 0 -- defence against a future T062 refactor that
--       pre-increments).
--   A4: after one dispatch_pending_alerts() tick, attempts increments to 1.
--       Holds in BOTH dispatch paths (success-branch L2439..L2442, exception
--       branch L2446..L2450) -- we don't care whether pg_net's http_post
--       succeeded or raised, only that the queue row advanced.
--   A5: after one tick, next_attempt_at is at least 50 seconds in the future.
--       Slot 0077 L2441/L2449 schedule next_attempt_at = now() + (attempts+1)
--       * interval '60 seconds'. At attempts=0 going to attempts=1, the
--       formula yields now() + 60s. We assert "> now() + 50s" to absorb
--       any sub-second clock drift between the dispatch tick and the
--       assertion's now() call (the test transaction freezes statement_timestamp
--       but not clock_timestamp).
--   A6: after a SIMULATED response-trigger finalizer (direct UPDATE setting
--       delivered_at = now()), the column is populated. Documents the
--       contract that delivered_at is the terminal-success state.
--   A7: a subsequent dispatch_pending_alerts() tick does NOT touch the
--       already-delivered row (attempts stays at 1). This pins the
--       worker's WHERE filter (L2412..L2413).
--   A8: enqueue_alert returns NULL no-op when the webhook URL is set to the
--       string "null" (the seeded default per slot 0076 T006). Defence
--       against any call site that fires enqueue_alert before an operator
--       has configured the URL.
--
-- Out of scope (covered by sibling tasks / integration tests):
--   * pg_cron firing dispatch_pending_alerts every 30s (T064; integration).
--   * net._http_response trigger populating delivered_at on 2xx (T075 runbook).
--   * HMAC signing of the outbound body (slot 0077 L2421..L2428; not directly
--     observable here without an HTTP receiver to mirror back the body).
--   * Exhausted-attempts -> failed_at sweep (slot 0077 L2455..L2459; needs
--     5 consecutive failed dispatches to trip, deliberately not exercised
--     in this unit test -- belongs in a dedicated retry/backoff test).
--
-- Impersonation pattern:
--   enqueue_alert is SECURITY DEFINER and grants EXECUTE to authenticated +
--   service_role. dispatch_pending_alerts is SECURITY DEFINER and grants
--   EXECUTE to service_role only. We exercise both from the postgres test
--   runner role (superuser, so the GRANT/REVOKE posture is bypassed) with a
--   synthetic admin JWT claim for parity with sibling tests; the JWT is not
--   actually consulted by either RPC body (neither one calls auth.uid() or
--   is_admin) but we set it so future refactors that gate on caller identity
--   surface here.
--
-- Fixture uuids (slice 001 seed + slot 0074 bootstrap):
--   * admin1  (admin) auth_user_id 00000000-0000-0000-0000-0000000000d3
--
-- Pattern: BEGIN / plan(8) / setup writes state into _t067_state / asserts /
-- finish / ROLLBACK. The ROLLBACK discards the seeded URL mutation, the
-- queue row, and the simulated delivered_at write, so the test is fully
-- re-runnable. The notifications.audit_failure_webhook_url row was seeded
-- by slot 0076 T006 with value 'null'::jsonb; we UPDATE that row inside the
-- transaction and ROLLBACK restores the seeded default.

BEGIN;

SELECT plan(8);

SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);

-- Scratch state carrying the enqueued queue id out of the DO block so
-- pgTAP assertions can reference it. ON COMMIT DROP is redundant with
-- session-scoped temp tables but documents intent.
CREATE TEMP TABLE _t067_state (
  name     text PRIMARY KEY,
  queue_id uuid
) ON COMMIT DROP;

-- ---------------------------------------------------------------------------
-- Setup Step 1: configure the webhook URL to a synthetic localhost endpoint.
-- The seed row from slot 0076 T006 already exists with value='null'::jsonb,
-- so a straight UPDATE suffices. The defensive INSERT...WHERE NOT EXISTS
-- below is a guard against any future migration that drops the seed row
-- (slot 0076 line 67 currently writes it, but the guard keeps this test
-- robust against seed drift -- the assertion that matters is "the row is
-- present with a real URL by the end of setup").
--
-- We use a port (9999) that is almost certainly closed in CI / dev so the
-- inevitable connect-refused error inside extensions.http_post lands in
-- dispatch_pending_alerts's EXCEPTION branch deterministically. If a real
-- service happens to listen at :9999, A4/A5/A7 still hold because both the
-- success branch (L2439..L2442) and the exception branch (L2446..L2450)
-- increment attempts identically and schedule the same backoff.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = '"http://localhost:9999/audit-webhook-test"'::jsonb,
       updated_at = now()
 WHERE key = 'notifications.audit_failure_webhook_url';

INSERT INTO public.tournament_config (key, value, updated_at)
SELECT 'notifications.audit_failure_webhook_url',
       '"http://localhost:9999/audit-webhook-test"'::jsonb,
       now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.tournament_config
   WHERE key = 'notifications.audit_failure_webhook_url'
);

-- ---------------------------------------------------------------------------
-- Setup Step 2: call enqueue_alert and stash the resulting queue id.
-- enqueue_alert's body reads the webhook URL via config_read (slot 0077
-- L2321), checks for the no-op short-circuit, and INSERTs a row into
-- notification_dispatch_queue with channel='webhook:audit_failure' and a
-- payload envelope built per L2333..L2341.
-- ---------------------------------------------------------------------------
DO $eq$
DECLARE
  v_id uuid;
BEGIN
  v_id := public.enqueue_alert(
    'audit_write_failure',
    'T067 test alert',
    jsonb_build_object('test_run', 'T067'),
    NULL
  );
  INSERT INTO _t067_state(name, queue_id) VALUES ('enqueued', v_id);
END;
$eq$;

-- ---------------------------------------------------------------------------
-- A1: enqueue_alert returned a non-null queue id. If this assertion fails,
-- the no-op short-circuit (L2326..L2328) fired -- meaning setup did not
-- successfully write the webhook URL row. Every downstream assertion in
-- this file is meaningless without A1's invariant.
-- ---------------------------------------------------------------------------
SELECT isnt(
  (SELECT queue_id FROM _t067_state WHERE name = 'enqueued'),
  NULL,
  'A1: enqueue_alert returned a non-null queue uuid when webhook URL is configured'
);

-- ---------------------------------------------------------------------------
-- A2: payload envelope shape -- alert_kind is wired from the enqueue_alert
-- p_alert_kind argument per slot 0077 L2335. Probing payload->>'alert_kind'
-- is enough to pin "the JSON envelope was built per contract"; the rest of
-- the envelope (environment, occurred_at, summary, details, audit_log_id)
-- is mechanically identical and reading it would just multiply assertions
-- without adding coverage.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT payload->>'alert_kind'
     FROM public.notification_dispatch_queue
    WHERE id = (SELECT queue_id FROM _t067_state WHERE name = 'enqueued')),
  'audit_write_failure',
  'A2: queue row payload has the expected alert_kind'
);

-- ---------------------------------------------------------------------------
-- A3: initial attempts = 0. Column default per slot 0077 L2272. Defence
-- against a future refactor of T062 that might pre-increment (e.g. "first
-- attempt happens during enqueue" mistake).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT attempts
     FROM public.notification_dispatch_queue
    WHERE id = (SELECT queue_id FROM _t067_state WHERE name = 'enqueued')),
  0,
  'A3: queue row starts with attempts = 0'
);

-- ---------------------------------------------------------------------------
-- Setup Step 3: tick the dispatcher once. The HTTP POST against :9999 is
-- expected to fail (connect refused), landing in the EXCEPTION branch of
-- the dispatch body (slot 0077 L2445..L2451). Either branch increments
-- attempts and schedules the same backoff, so A4/A5 hold regardless.
--
-- We wrap PERFORM in our own EXCEPTION block as a SAFETY NET only: the
-- dispatch body is structured to NEVER let an http_post exception escape
-- (its own BEGIN/EXCEPTION around the http_post call at L2430..L2451
-- catches WHEN OTHERS). If a future regression causes dispatch_pending_alerts
-- to propagate an exception, we deliberately swallow it here so the file
-- still gets to A4. A4 then surfaces the actual problem (attempts didn't
-- increment because the dispatch body raised before reaching the UPDATE).
-- ---------------------------------------------------------------------------
DO $tick$
BEGIN
  PERFORM public.dispatch_pending_alerts();
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$tick$;

-- ---------------------------------------------------------------------------
-- A4: attempts incremented to 1. Both dispatch paths -- success
-- (L2439..L2442) and exception (L2446..L2450) -- write attempts = attempts +
-- 1, so this assertion is path-agnostic.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT attempts
     FROM public.notification_dispatch_queue
    WHERE id = (SELECT queue_id FROM _t067_state WHERE name = 'enqueued')),
  1,
  'A4: attempts incremented to 1 after first dispatch_pending_alerts tick'
);

-- ---------------------------------------------------------------------------
-- A5: next_attempt_at scheduled at least 50s in the future. The dispatch
-- body writes next_attempt_at = now() + ((attempts + 1) * interval '60 sec')
-- (slot 0077 L2441 / L2449). At the moment of the UPDATE, the row's
-- attempts has just been computed as (old_attempts + 1) = 1, so the formula
-- yields now() + 60s. The 50s lower bound absorbs sub-second clock drift
-- between the dispatch tick and clock_timestamp() inside the assertion --
-- we intentionally DON'T use a tight 60s lower bound because clock_timestamp()
-- advances inside the test transaction (statement_timestamp does not).
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT next_attempt_at > clock_timestamp() + interval '50 seconds'
     FROM public.notification_dispatch_queue
    WHERE id = (SELECT queue_id FROM _t067_state WHERE name = 'enqueued')),
  'A5: next_attempt_at scheduled at least 50s in the future after first attempt'
);

-- ---------------------------------------------------------------------------
-- Setup Step 4: simulate the response-trigger finalizer marking the row as
-- delivered. In production, slot 0077 D-T063-B punts this to an operator-
-- wired trigger on net._http_response that runs OUT of slot 0077's
-- transactional scope. For the test we INSERT a delivered_at directly
-- so we can assert (a) the column accepts the write (A6) and (b) the
-- dispatch worker's WHERE filter actually skips delivered rows (A7).
--
-- IMPORTANT -- this is a SIMULATION, not an end-to-end verification. We
-- are NOT testing that pg_net's response actually arrives or that the
-- finalizer trigger is correctly wired. Those belong in the operator-run
-- manual verification step per docs/runbooks/audit-write-failure.md.
-- ---------------------------------------------------------------------------
DO $deliver$
DECLARE
  v_id uuid := (SELECT queue_id FROM _t067_state WHERE name = 'enqueued');
BEGIN
  UPDATE public.notification_dispatch_queue
     SET delivered_at = now()
   WHERE id = v_id;
END;
$deliver$;

-- ---------------------------------------------------------------------------
-- A6: delivered_at populated after the SIMULATED finalizer. Trivial column
-- write assertion; the value of this assertion is documenting the contract
-- that delivered_at is the terminal-success column and setting up the
-- precondition for A7 (which is the real contract: dispatch skips delivered
-- rows).
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT delivered_at IS NOT NULL
     FROM public.notification_dispatch_queue
    WHERE id = (SELECT queue_id FROM _t067_state WHERE name = 'enqueued')),
  'A6: delivered_at populated after response-trigger finalizer SIMULATION'
);

-- ---------------------------------------------------------------------------
-- A7: a subsequent dispatch tick does NOT touch a row already marked
-- delivered. This is the real contract pinned by this file: slot 0077
-- L2412..L2413's WHERE delivered_at IS NULL AND failed_at IS NULL must
-- filter out delivered rows. If a future refactor accidentally drops the
-- delivered_at IS NULL predicate, attempts would tick to 2 here and this
-- assertion fails immediately.
-- ---------------------------------------------------------------------------
DO $tick2$
BEGIN
  PERFORM public.dispatch_pending_alerts();
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$tick2$;

SELECT is(
  (SELECT attempts
     FROM public.notification_dispatch_queue
    WHERE id = (SELECT queue_id FROM _t067_state WHERE name = 'enqueued')),
  1,
  'A7: attempts unchanged after dispatch tick on a row already marked delivered'
);

-- ---------------------------------------------------------------------------
-- A8: enqueue_alert returns NULL no-op when the webhook URL is the literal
-- string "null". This is the seeded default per slot 0076 T006 -- in dev /
-- pre-launch, every audit-write call site hits this path. Slot 0077
-- L2326..L2328 short-circuits on v_url IS NULL OR length(v_url) = 0 OR
-- v_url = 'null'; we exercise the third condition specifically because it
-- is the one that protects against silent enqueueing in fresh installs.
-- ---------------------------------------------------------------------------
UPDATE public.tournament_config
   SET value = '"null"'::jsonb,
       updated_at = now()
 WHERE key = 'notifications.audit_failure_webhook_url';

SELECT is(
  public.enqueue_alert(
    'audit_write_failure',
    'noop test',
    '{}'::jsonb,
    NULL
  ),
  NULL,
  'A8: enqueue_alert returns NULL no-op when webhook URL is set to "null"'
);

SELECT * FROM finish();

ROLLBACK;
