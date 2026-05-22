/**
 * Slice 002 / T036 — Outage-alert dedup test (RED — SC-003 invariant).
 *
 * Contract:
 *   - specs/002-match-catalog/spec.md § Clarifications 2026-05-15 Q3
 *       (audit + webhook semantics, exactly-once-per-outage)
 *   - specs/002-match-catalog/spec.md § SC-003
 *       ("Administrators receive an alert within 15 minutes of sustained
 *        provider failure beyond the configured threshold, and exactly once
 *        per sustained outage (no flap-spam).")
 *   - specs/002-match-catalog/research.md § R-008
 *       (sustained-outage alert deduplication ledger:
 *        first_failure_after_success_at / outage_alert_emitted_at)
 *
 * What this test proves:
 *   Repeated failed sync runs against the `stub` provider, all of which sit
 *   beyond the configured outage threshold, MUST cause the coordinator to
 *   emit EXACTLY ONE `audit_log` row with `action='provider.outage_alert_emitted'`
 *   for the duration of the same sustained outage — subsequent qualifying
 *   failures within the same outage are deduplicated via
 *   `provider_sync_state.outage_alert_emitted_at` (R-008 state-ledger flag,
 *   set by the first emission and never re-fired until a successful sync
 *   clears it).
 *
 * Failure-simulation strategy (no Docker / no real provider downtime):
 *   The canonical stub adapter reads its fixture via
 *   `Deno.readTextFile(./fixtures/wc2026-snapshot.json)` on every call.
 *   We rename the fixture file aside BEFORE the first POST so that every
 *   `stub.fetchFixtures()` invocation throws (ENOENT) — the coordinator
 *   records a failure outcome on each run. `finally` restores the fixture
 *   so downstream tests are not poisoned (Constitution VII operability:
 *   tests own their setUp + tearDown).
 *
 * Time-travel strategy ("3 failures > 1 minute apart" without sleeping):
 *   The R-008 alert gate fires when
 *     now() - provider_sync_state.first_failure_after_success_at
 *       > tournament_config.notifications.outage_threshold_minutes
 *   AND `outage_alert_emitted_at IS NULL`. We do NOT wait 1 minute three
 *   times. Instead, the test:
 *     1. Sets `notifications.outage_threshold_minutes = 1` via service-role.
 *     2. Between successive failing POSTs, service-role-UPDATEs
 *        `provider_sync_state.first_failure_after_success_at` to
 *        `now() - interval '2 minutes'` so the coordinator on the NEXT POST
 *        sees an outage already past the threshold. This is a TEST-ONLY
 *        technique: production code never writes that column to a backdated
 *        value, only the coordinator owns it via R-008 step "set on first
 *        failure after success."
 *     3. Asserts the audit ledger holds EXACTLY ONE
 *        `provider.outage_alert_emitted` row across the three failing runs
 *        (the first qualifying failure emits; runs 2 and 3 see
 *        `outage_alert_emitted_at IS NOT NULL` and dedup).
 *
 * RED-first state (Constitution Principle IX):
 *   This test is authored before T041 (the coordinator's outage-alert dedup
 *   logic). It WILL fail until T041 ships:
 *     - currently the coordinator emits no `provider.outage_alert_emitted`
 *       audit rows at all, so the assertion `count === 1` reads 0.
 *   Once T041 lands the test becomes the regression gate for SC-003.
 *
 * Skip policy: mirrors T023 / T024 — self-skips unless
 * `RUN_SYNC_CATALOG_TESTS=1` AND the Supabase / Edge env vars are present.
 * Docker + Deno are not installed on every contributor's box; gated
 * execution keeps `deno test` clean on dev machines while still gating
 * SC-003 on CI environments that provision the full stack.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ============================================================================
// Environment + harness
// ============================================================================

const RUN = Deno.env.get("RUN_SYNC_CATALOG_TESTS") === "1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SYNC_TRIGGER_SECRET = Deno.env.get("SYNC_TRIGGER_SECRET") ?? "";
const SYNC_FUNCTION_URL = Deno.env.get("SYNC_FUNCTION_URL")
  ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/sync-catalog` : "");

const HAS_ENV =
  RUN &&
  SUPABASE_URL.length > 0 &&
  SERVICE_ROLE_KEY.length > 0 &&
  SYNC_TRIGGER_SECRET.length > 0 &&
  SYNC_FUNCTION_URL.length > 0;

const PROVIDER = "stub";

// Resolve fixture path RELATIVE TO THIS TEST FILE. The fixture is two
// directories up + into _shared/providers/stub/fixtures/.
const FIXTURE_URL = new URL(
  "../../_shared/providers/stub/fixtures/wc2026-snapshot.json",
  import.meta.url,
);
const FIXTURE_TMP_URL = new URL(
  "../../_shared/providers/stub/fixtures/wc2026-snapshot.json.t036.bak",
  import.meta.url,
);

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Service-role UPSERT of a single tournament_config key. */
async function setConfig(
  supabase: SupabaseClient,
  key: string,
  // deno-lint-ignore no-explicit-any
  jsonbValue: any,
): Promise<void> {
  const { error } = await supabase
    .from("tournament_config")
    .update({ value: jsonbValue, updated_at: new Date().toISOString() })
    .eq("key", key);
  if (error) {
    throw new Error(`setConfig('${key}') failed: ${error.message}`);
  }
}

/**
 * Backdate `provider_sync_state.first_failure_after_success_at` for the
 * given provider so the next coordinator invocation sees an outage already
 * past the configured threshold. TEST-ONLY: production code never writes
 * this column to a synthetic past value.
 */
async function backdateOutageStart(
  supabase: SupabaseClient,
  provider: string,
  minutesAgo: number,
): Promise<void> {
  const backdated = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("provider_sync_state")
    .update({ first_failure_after_success_at: backdated })
    .eq("provider", provider);
  if (error) {
    throw new Error(`backdateOutageStart failed: ${error.message}`);
  }
}

/** Force-clear the outage-alert dedup ledger to a known empty state. */
async function resetSyncState(
  supabase: SupabaseClient,
  provider: string,
): Promise<void> {
  // UPSERT pattern: insert if missing, overwrite if present. We do NOT
  // depend on T030's lazy-create path so the test is deterministic even
  // when run against a fresh DB.
  const { error } = await supabase
    .from("provider_sync_state")
    .upsert({
      provider,
      last_success_at: null,
      consecutive_failures: 0,
      first_failure_after_success_at: null,
      outage_alert_emitted_at: null,
      recovery_alert_pending: false,
    }, { onConflict: "provider" });
  if (error) {
    throw new Error(`resetSyncState failed: ${error.message}`);
  }
}

/** Move the fixture aside so `Deno.readTextFile` throws inside the adapter. */
async function hideFixture(): Promise<void> {
  await Deno.rename(FIXTURE_URL, FIXTURE_TMP_URL);
}

/** Best-effort restore — safe to call even if hide failed mid-run. */
async function restoreFixture(): Promise<void> {
  try {
    await Deno.stat(FIXTURE_TMP_URL);
  } catch {
    return; // tmp doesn't exist — nothing to restore.
  }
  await Deno.rename(FIXTURE_TMP_URL, FIXTURE_URL);
}

/** POST one sync invocation; returns the HTTP status. */
async function postSync(): Promise<number> {
  const runId = crypto.randomUUID();
  const response = await fetch(SYNC_FUNCTION_URL, {
    method: "POST",
    headers: {
      "X-Internal-Auth": SYNC_TRIGGER_SECRET,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: PROVIDER,
      trigger: "manual_internal",
      run_id: runId,
    }),
  });
  // Drain body — the coordinator may stream JSON and an unread body can
  // leak the fetch connection across runs (Deno permission warning).
  try {
    await response.text();
  } catch {
    // ignore
  }
  return response.status;
}

// ============================================================================
// Test
// ============================================================================

Deno.test({
  name:
    "outage_alert_dedup: three threshold-crossing failures emit exactly ONE provider.outage_alert_emitted audit row (SC-003)",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // ----- Pre-state (record so we can restore the config in finally) -----
    const { data: thresholdBefore, error: cfgErr } = await supabase
      .from("tournament_config")
      .select("value")
      .eq("key", "notifications.outage_threshold_minutes")
      .single();
    if (cfgErr) {
      throw new Error(
        `pre-state read of notifications.outage_threshold_minutes failed: ${cfgErr.message}`,
      );
    }
    const originalThreshold = thresholdBefore.value;

    // Capture the audit-row baseline so the test is robust against any
    // prior outage-alert rows that other test runs may have left behind.
    const { count: alertCountBefore, error: alertBeforeErr } = await supabase
      .from("audit_log")
      .select("*", { count: "exact", head: true })
      .eq("action", "provider.outage_alert_emitted");
    if (alertBeforeErr) {
      throw new Error(
        `pre-state audit_log count failed: ${alertBeforeErr.message}`,
      );
    }
    const baselineAlertCount = alertCountBefore ?? 0;

    try {
      // 1. Tighten the threshold so a 2-minute-backdated outage is "past"
      //    the threshold trivially.
      await setConfig(supabase, "notifications.outage_threshold_minutes", 1);

      // 2. Reset the dedup ledger so we know the first qualifying failure
      //    is the FIRST in this outage.
      await resetSyncState(supabase, PROVIDER);

      // 3. Make the adapter throw on every fetch.
      await hideFixture();

      // ----- Failure #1 -----
      // The coordinator should record the failure, populate
      // first_failure_after_success_at on the state row (if not already
      // set), and -- because the backdated start makes it past the
      // threshold -- emit the FIRST outage-alert audit row.
      //
      // We pre-backdate BEFORE the first call so the very first failure
      // already crosses the threshold. R-008's text-state lookup is:
      //   first_failure_after_success_at IS NOT NULL
      //   AND now() - first_failure_after_success_at > threshold
      //   AND outage_alert_emitted_at IS NULL
      // The coordinator may overwrite first_failure_after_success_at only
      // when it was NULL (i.e. "first failure after success"); a
      // pre-existing non-null value must NOT be reset by a failure. The
      // assertion below trusts that semantics — if the coordinator
      // clobbers our backdate on every call, the threshold won't be
      // exceeded and the test fails LOUDLY, which is the correct signal.
      await supabase
        .from("provider_sync_state")
        .upsert({
          provider: PROVIDER,
          first_failure_after_success_at: new Date(
            Date.now() - 2 * 60 * 1000,
          ).toISOString(),
          consecutive_failures: 0,
          last_success_at: null,
          outage_alert_emitted_at: null,
          recovery_alert_pending: false,
        }, { onConflict: "provider" });

      const status1 = await postSync();
      assert(
        status1 >= 200 && status1 < 600,
        `failure #1 must return a defined HTTP status, got ${status1}`,
      );

      // After failure #1, the coordinator must have set
      // outage_alert_emitted_at (one emission). We assert this here
      // because runs 2 and 3 depend on the dedup flag being non-null.
      const { data: stateAfter1, error: state1Err } = await supabase
        .from("provider_sync_state")
        .select("outage_alert_emitted_at, first_failure_after_success_at")
        .eq("provider", PROVIDER)
        .single();
      if (state1Err) {
        throw new Error(
          `provider_sync_state read after failure #1 failed: ${state1Err.message}`,
        );
      }
      assert(
        stateAfter1.outage_alert_emitted_at !== null,
        "after the first threshold-crossing failure, "
          + "provider_sync_state.outage_alert_emitted_at MUST be non-null "
          + "(R-008 dedup ledger)",
      );
      assert(
        stateAfter1.first_failure_after_success_at !== null,
        "after the first failure, first_failure_after_success_at MUST remain non-null",
      );

      // ----- Failure #2 -----
      // Re-backdate to keep the outage window past the threshold (the
      // coordinator may have advanced now() relative to our seeded
      // backdate; we re-anchor to be safe). The dedup flag stays set —
      // runs 2 + 3 must NOT emit a second audit row.
      await backdateOutageStart(supabase, PROVIDER, 2);
      const status2 = await postSync();
      assert(
        status2 >= 200 && status2 < 600,
        `failure #2 must return a defined HTTP status, got ${status2}`,
      );

      // ----- Failure #3 -----
      await backdateOutageStart(supabase, PROVIDER, 2);
      const status3 = await postSync();
      assert(
        status3 >= 200 && status3 < 600,
        `failure #3 must return a defined HTTP status, got ${status3}`,
      );

      // ----- SC-003 core assertion -----
      // Exactly ONE new `provider.outage_alert_emitted` audit row across
      // the three failing runs. We compare against the baseline captured
      // before the test ran, so a polluted long-lived DB does not poison
      // the assertion.
      const { count: alertCountAfter, error: alertAfterErr } = await supabase
        .from("audit_log")
        .select("*", { count: "exact", head: true })
        .eq("action", "provider.outage_alert_emitted");
      if (alertAfterErr) {
        throw new Error(
          `post-state audit_log count failed: ${alertAfterErr.message}`,
        );
      }
      const deltaAlerts = (alertCountAfter ?? 0) - baselineAlertCount;
      assertEquals(
        deltaAlerts,
        1,
        "SC-003: exactly ONE provider.outage_alert_emitted audit row must "
          + "be written across three threshold-crossing failures within the "
          + `same outage (got delta=${deltaAlerts}). Dedup is gated by `
          + "provider_sync_state.outage_alert_emitted_at per R-008.",
      );

      // Sanity: the dedup flag is still set after run #3.
      const { data: stateAfter3, error: state3Err } = await supabase
        .from("provider_sync_state")
        .select("outage_alert_emitted_at")
        .eq("provider", PROVIDER)
        .single();
      if (state3Err) {
        throw new Error(
          `provider_sync_state read after failure #3 failed: ${state3Err.message}`,
        );
      }
      assert(
        stateAfter3.outage_alert_emitted_at !== null,
        "outage_alert_emitted_at MUST remain non-null until a successful sync "
          + "clears it (R-008 recovery path is owned by recovery_clears_outage_state.test.ts)",
      );
    } finally {
      // Tear-down — order matters: restore the fixture before downstream
      // tests so the stub adapter can read it; restore the config so the
      // global default of 15 minutes is back in place; and clear the
      // dedup ledger so we do not leak an "outage in progress" flag into
      // a sibling test.
      await restoreFixture();
      await setConfig(
        supabase,
        "notifications.outage_threshold_minutes",
        originalThreshold,
      );
      // NOTE: we deliberately do NOT clear the dedup ledger here — the
      // sibling test `recovery_clears_outage_state.test.ts` consumes this
      // state OR sets its own pre-state. Resetting it here would obscure
      // the cross-test handoff documented in tasks.md § T036.
    }
  },
});
