/**
 * Slice 002 / T036 — Recovery clears outage state (RED — SC-003 invariant).
 *
 * Contract:
 *   - specs/002-match-catalog/spec.md § Clarifications 2026-05-15 Q3
 *       ("Recovery emits action='provider.recovered' audit row and (if URL
 *        configured) a recovery webhook payload — symmetry preserves the
 *        operator's mental model.")
 *   - specs/002-match-catalog/spec.md § SC-003 (exactly-once-per-outage
 *       alerting; the recovery transition closes the outage and re-arms
 *       the dedup ledger for the next outage).
 *   - specs/002-match-catalog/research.md § R-008
 *       ("On the next successful sync: clear both
 *        first_failure_after_success_at and outage_alert_emitted_at. Write
 *        an audit_log row with action='provider.recovered'.")
 *
 * What this test proves:
 *   Given a `provider_sync_state` row showing an active, already-alerted
 *   outage (first_failure_after_success_at set 10 minutes ago,
 *   outage_alert_emitted_at set 5 minutes ago), a successful sync run MUST:
 *     (a) return 200 OK with a happy outcome (`success` or
 *         `success_no_changes` per contract § Outcome enum),
 *     (b) NULL out `provider_sync_state.first_failure_after_success_at`
 *         (the outage is closed — there is no current outage to time-out),
 *     (c) NULL out `provider_sync_state.outage_alert_emitted_at` (the
 *         dedup gate is re-armed for the next outage), and
 *     (d) append EXACTLY ONE NEW `audit_log` row with
 *         `action='provider.recovered'` (symmetric counterpart to
 *         `provider.outage_alert_emitted`).
 *
 *   The combination of (b) + (c) is the R-008 "re-arming" invariant: a
 *   second outage hours later must again qualify for a single new alert
 *   without administrator intervention.
 *
 * Time-travel strategy (no live wait):
 *   The test seeds the outage pre-state via a service-role UPSERT against
 *   `provider_sync_state` — no Docker, no fixture mutation, no sleep. This
 *   is the same TEST-ONLY pattern used in the sibling
 *   `outage_alert_dedup.test.ts`: production code never writes
 *   first_failure_after_success_at or outage_alert_emitted_at to
 *   synthetically-backdated values, only the coordinator does, as part of
 *   the R-008 state-machine.
 *
 * RED-first state (Constitution Principle IX):
 *   This test is authored before T041 (the coordinator's outage-alert
 *   dedup + recovery logic). It WILL fail until T041 ships:
 *     - currently the coordinator does not write `provider.recovered`
 *       audit rows on the success-after-failure transition,
 *     - and it does not clear the dedup ledger.
 *   Once T041 lands, the test becomes the regression gate for the recovery
 *   half of SC-003.
 *
 * Skip policy: mirrors T023 / T024 / T036's sibling — self-skips unless
 * `RUN_SYNC_CATALOG_TESTS=1` AND Supabase/Edge env vars are present.
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

// Resolve the canonical fixture path (relative to this test file). We do
// NOT mutate the fixture here — but we DO `Deno.stat` it during set-up
// to fail loudly if a prior test (`outage_alert_dedup.test.ts`) left the
// fixture renamed-aside. The recovery path is meaningless without a
// working adapter.
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

/**
 * Restore the stub fixture if a sibling test left it renamed aside.
 * Idempotent — safe to call when no .bak exists.
 */
async function ensureFixtureRestored(): Promise<void> {
  try {
    await Deno.stat(FIXTURE_URL);
    return; // fixture is in place — nothing to do.
  } catch {
    // Fall through to the tmp-restore path.
  }
  try {
    await Deno.stat(FIXTURE_TMP_URL);
  } catch {
    throw new Error(
      `stub fixture missing at ${FIXTURE_URL.pathname} and no .bak `
        + `at ${FIXTURE_TMP_URL.pathname} — recovery test cannot run`,
    );
  }
  await Deno.rename(FIXTURE_TMP_URL, FIXTURE_URL);
}

/**
 * Seed the outage pre-state for the recovery test: a 10-minutes-old
 * outage start with a 5-minutes-old alert already emitted, no last
 * success ever recorded (or last success older than the outage start —
 * either way, the recovery transition is "first success after the
 * outage began"). recovery_alert_pending=true reflects the R-008
 * invariant that the dedup ledger owes a recovery notification.
 */
async function seedOutageState(supabase: SupabaseClient): Promise<void> {
  const nowMs = Date.now();
  const tenMinutesAgo = new Date(nowMs - 10 * 60 * 1000).toISOString();
  const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from("provider_sync_state")
    .upsert({
      provider: PROVIDER,
      last_success_at: null,
      consecutive_failures: 3,
      first_failure_after_success_at: tenMinutesAgo,
      outage_alert_emitted_at: fiveMinutesAgo,
      recovery_alert_pending: true,
    }, { onConflict: "provider" });
  if (error) {
    throw new Error(`seedOutageState failed: ${error.message}`);
  }
}

// ============================================================================
// Test
// ============================================================================

Deno.test({
  name:
    "recovery_clears_outage_state: a successful sync after a sustained outage clears the dedup ledger AND emits exactly one provider.recovered audit row (SC-003 recovery half)",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // ----- Pre-state -----

    // 1. Restore the stub fixture (the sibling outage test may have
    //    renamed it aside if it crashed before its `finally`).
    await ensureFixtureRestored();

    // 2. Seed the outage pre-state.
    await seedOutageState(supabase);

    // 3. Capture the baseline `provider.recovered` audit-row count so
    //    the assertion is robust against a long-lived test DB carrying
    //    leftover rows from prior runs.
    const { count: recoveredCountBefore, error: recoveredBeforeErr } =
      await supabase
        .from("audit_log")
        .select("*", { count: "exact", head: true })
        .eq("action", "provider.recovered");
    if (recoveredBeforeErr) {
      throw new Error(
        `pre-state audit_log count for provider.recovered failed: ${recoveredBeforeErr.message}`,
      );
    }
    const baselineRecoveredCount = recoveredCountBefore ?? 0;

    // ----- Trigger -----

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

    assertEquals(
      response.status,
      200,
      "successful recovery sync must return HTTP 200 (the stub fixture is "
        + "back in place so the adapter returns a normal 8-match payload)",
    );

    const body = await response.json();
    assertEquals(
      body?.run_id,
      runId,
      "200 body must echo the request run_id",
    );
    assert(
      typeof body?.outcome === "string",
      "200 body must carry an outcome string per contract § Outcome enum",
    );
    assert(
      body.outcome === "success" || body.outcome === "success_no_changes",
      `recovery outcome must be one of {success, success_no_changes}, got ${body.outcome}`,
    );

    // ----- Post-state assertions -----

    // (b) + (c): the dedup ledger MUST be re-armed.
    const { data: stateAfter, error: stateErr } = await supabase
      .from("provider_sync_state")
      .select(
        "first_failure_after_success_at, outage_alert_emitted_at, "
          + "recovery_alert_pending, last_success_at",
      )
      .eq("provider", PROVIDER)
      .single();
    if (stateErr) {
      throw new Error(
        `provider_sync_state post-state read failed: ${stateErr.message}`,
      );
    }
    assertEquals(
      stateAfter.first_failure_after_success_at,
      null,
      "after a successful sync, "
        + "provider_sync_state.first_failure_after_success_at MUST be NULL "
        + "(R-008: the current outage is closed)",
    );
    assertEquals(
      stateAfter.outage_alert_emitted_at,
      null,
      "after a successful sync, "
        + "provider_sync_state.outage_alert_emitted_at MUST be NULL "
        + "(R-008: dedup ledger re-armed for the next outage)",
    );
    assertEquals(
      stateAfter.recovery_alert_pending,
      false,
      "after a successful sync, recovery_alert_pending MUST be false "
        + "(the recovery alert is now satisfied)",
    );
    assert(
      stateAfter.last_success_at !== null,
      "after a successful sync, last_success_at MUST be populated "
        + "(R-008: anchors the next outage's first_failure_after_success_at)",
    );

    // (d): exactly ONE new provider.recovered audit row.
    const { count: recoveredCountAfter, error: recoveredAfterErr } =
      await supabase
        .from("audit_log")
        .select("*", { count: "exact", head: true })
        .eq("action", "provider.recovered");
    if (recoveredAfterErr) {
      throw new Error(
        `post-state audit_log count for provider.recovered failed: ${recoveredAfterErr.message}`,
      );
    }
    const deltaRecovered =
      (recoveredCountAfter ?? 0) - baselineRecoveredCount;
    assertEquals(
      deltaRecovered,
      1,
      "SC-003: exactly ONE provider.recovered audit row must be written "
        + "on the success-after-outage transition (symmetric with the "
        + `outage alert per Clarifications Q3). Got delta=${deltaRecovered}.`,
    );
  },
});
