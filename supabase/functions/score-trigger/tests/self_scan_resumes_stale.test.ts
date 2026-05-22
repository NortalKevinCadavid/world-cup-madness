/**
 * Slice 006 / T024 — self_scan_resumes_stale.test.ts.
 *
 * Contract: spec.md § Clarifications 2026-05-17 Q2 (locked resume mechanism)
 *           + research.md § R-007 (post-clarification).
 *
 * What this test proves at runtime:
 *   - Pre-state: a `score_calculation_runs` row exists with
 *     `status='running'` and `started_at` 2 minutes in the past — i.e. a
 *     classic "Edge Function crashed mid-run" leftover.
 *   - When ANY new Edge Function invocation arrives (here a benign
 *     `scope='match'` POST for M1 with a fresh run_id), the function MUST,
 *     as a fire-and-forget startup task, scan for stale rows and re-POST to
 *     itself for each. Slice 005's SP idempotency (R-002) handles the
 *     actual resumption — this test only asserts the SELF-SCAN happened.
 *   - Verification: an `audit_log` row with
 *     `action='score_trigger.self_scan_resumed_runs'` MUST exist whose
 *     `new_value.resumed_run_ids` contains the stale run_id we seeded.
 *   - We give the background task up to 10 seconds (SC-007 budget) to land.
 *
 * Why audit_log (not status transition) is the assertion target:
 *   The re-POSTed inner invocation may itself fail (the stale run was
 *   inserted with a bogus 'admin_recalc' trigger via service role, bypassing
 *   the SP layer that would normally set up score_records rows). The audit
 *   row is what unambiguously proves the SELF-SCAN itself fired — which is
 *   the behavior under test. The downstream "did the re-POST succeed?" is
 *   already covered by `idempotent_retry.test.ts` and the slice 005 SP
 *   tests.
 *
 * Cleanup: deletes the stale `score_calculation_runs` row + any
 * `score_records` it may have spawned during re-resume. The audit_log row
 * for the self-scan is intentionally LEFT in place (append-only contract
 * from slice 007).
 *
 * Skip policy: RUN_EDGE_FN_TESTS=1 + SUPABASE_URL + service-role + internal
 * secret. Without all four the test self-skips (mirrors slice 002 +
 * slice 005 + T015's pattern).
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ============================================================================
// Environment + harness
// ============================================================================

const RUN = Deno.env.get("RUN_EDGE_FN_TESTS") === "1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INTERNAL_SECRET =
  Deno.env.get("SCORE_TRIGGER_INTERNAL_AUTH_SECRET") ?? "";
const FUNCTION_URL = Deno.env.get("SCORE_TRIGGER_FUNCTION_URL")
  ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/score-trigger` : "");

const HAS_ENV =
  RUN &&
  SUPABASE_URL.length > 0 &&
  SERVICE_ROLE_KEY.length > 0 &&
  INTERNAL_SECRET.length > 0 &&
  FUNCTION_URL.length > 0;

// Slice-005 fixture UUIDs (see supabase/seed/slice-005-fixture.sql §
// "Slice 005 UUID conventions"). M1 is the ARG-MEX finished match.
const M1 = "eeee0050-0000-0000-0000-000000000001";

// Slice-006 fixture: admin1 is the seeded administrator (see slice-006
// fixture). We use this uuid only as `triggered_by` on the synthetic stale
// row — the test does not exercise admin RPC, only the Edge Function's
// startup self-scan.
const ADMIN1 = "77777777-7777-7777-7777-777777777777";

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ============================================================================
// Test
// ============================================================================

Deno.test({
  name:
    "self_scan_resumes_stale: a 2-minute-old running run is detected + an audit row records the resumption within 10 seconds of any new invocation",
  ignore: !HAS_ENV,
  async fn() {
    const service = serviceClient();

    // -----------------------------------------------------------------------
    // 1. Pre-state — insert a stale 'running' run for M1 with
    //    started_at = now - 2 minutes. This simulates an Edge Function
    //    crash mid-run.
    //
    //    NOTE: this bypasses slice 005's SP layer (no score_records get
    //    written, no calculation_version is bumped). That is intentional —
    //    the test asserts ONLY that the self-scan re-POST occurred, not
    //    that the re-POST's SP work succeeded. The latter is covered by
    //    `idempotent_retry.test.ts`.
    // -----------------------------------------------------------------------
    const staleRunId = crypto.randomUUID();
    const staleStartedAt = new Date(Date.now() - 120_000).toISOString();

    {
      const { error: insertErr } = await service
        .from("score_calculation_runs")
        .insert({
          id: staleRunId,
          scope: "match",
          target_id: M1,
          trigger: "admin_recalc",
          triggered_by: ADMIN1,
          status: "running",
          started_at: staleStartedAt,
          reason: "self_scan_test_stale_pre_state",
        });
      if (insertErr) {
        throw new Error(
          `failed to seed stale score_calculation_runs row: ${insertErr.message}`,
        );
      }
    }

    try {
      // ---------------------------------------------------------------------
      // 2. Capture the audit_log "before" cursor so we can scope our search
      //    to the time window after this point. Avoids flaky reads against a
      //    polluted append-only table.
      // ---------------------------------------------------------------------
      const beforeCursor = new Date().toISOString();

      // ---------------------------------------------------------------------
      // 3. Trigger ANY new Edge Fn invocation. We use a benign scope='match'
      //    POST for M1 with a fresh run_id. The outer request can succeed,
      //    fail, or 409 — the test does not assert on its outcome. The
      //    self-scan kicks off BEFORE body parsing, so this works regardless.
      // ---------------------------------------------------------------------
      const probeRunId = crypto.randomUUID();
      const probeResponse = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth": INTERNAL_SECRET,
        },
        body: JSON.stringify({
          scope: "match",
          target_id: M1,
          run_id: probeRunId,
          reason: "self_scan_test_probe",
        }),
      });
      // Drain the body so the connection releases. Outcome irrelevant.
      await probeResponse.text();

      // ---------------------------------------------------------------------
      // 4. The self-scan runs fire-and-forget. Poll audit_log for up to 10s
      //    (SC-007 budget) for the resume-record audit row that names our
      //    seeded stale run_id. Polling avoids a hard 10s sleep so the test
      //    runs fast when the background task lands quickly.
      // ---------------------------------------------------------------------
      const deadline = Date.now() + 10_000;
      let hasResumeAudit = false;

      while (Date.now() < deadline) {
        const { data: auditRows, error: auditErr } = await service
          .from("audit_log")
          .select("id, action, new_value, occurred_at")
          .eq("action", "score_trigger.self_scan_resumed_runs")
          .gte("occurred_at", beforeCursor)
          .order("occurred_at", { ascending: false })
          .limit(20);

        if (auditErr) {
          throw new Error(`audit_log read failed: ${auditErr.message}`);
        }

        hasResumeAudit = (auditRows ?? []).some((row) => {
          const ids =
            ((row.new_value as Record<string, unknown> | null)
              ?.resumed_run_ids as string[] | undefined) ?? [];
          return Array.isArray(ids) && ids.includes(staleRunId);
        });

        if (hasResumeAudit) break;

        // Short backoff before next poll. 250ms => up to ~40 polls inside
        // the 10s window, more than enough.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      assertEquals(
        hasResumeAudit,
        true,
        `An audit_log row with action='score_trigger.self_scan_resumed_runs' and new_value.resumed_run_ids containing '${staleRunId}' MUST exist within 10s of the probe POST. The self-scan did not run, or it failed to write the audit row, or the stale row was filtered out by the WHERE clause.`,
      );
    } finally {
      // -----------------------------------------------------------------------
      // 5. Cleanup. score_records first (FK to score_calculation_runs). The
      //    re-POSTed inner invocation may have inserted up to 6 score_records
      //    rows (the slice-005 fixture's eligible-participant count for M1)
      //    if its SP path actually ran to completion. Best-effort cleanup so
      //    a partial inner run doesn't poison sibling tests.
      // -----------------------------------------------------------------------
      await service.from("score_records").delete().eq("run_id", staleRunId);
      await service.from("score_calculation_runs").delete().eq("id", staleRunId);
    }
  },
});
