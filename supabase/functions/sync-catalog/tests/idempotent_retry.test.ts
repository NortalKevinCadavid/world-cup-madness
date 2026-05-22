/**
 * Slice 002 / T023 — Idempotent retry test (RED).
 *
 * Contract:
 *   - specs/002-match-catalog/contracts/sync-runner.scheduled.md
 *       § Response (200 OK — idempotent retry shape, with `notes` field)
 *       § Coordinator behavior step 3:
 *         "If [provider_sync_runs row] exists with non-NULL outcome →
 *          idempotent retry; return the recorded outcome with
 *          notes='idempotent retry'."
 *       § Test surface (the `idempotent_retry.test.ts` row):
 *         "POST same body twice with same run_id; second call returns 200
 *          with notes='idempotent retry' and identical body to the first."
 *   - specs/002-match-catalog/data-model.md § Entity 5 (provider_sync_runs):
 *       `id` is the PK; one row per run_id — so an idempotent retry must
 *       NOT insert a second ledger row.
 *
 * What this test proves:
 *   Two POSTs with the SAME `run_id`:
 *     (1) First call runs the coordinator end-to-end and writes the ledger
 *         row (terminal outcome).
 *     (2) Second call short-circuits at Coordinator step 3, returns 200 with
 *         the SAME run_id / outcome / counts as call 1 plus
 *         `notes='idempotent retry'`, and writes NO additional ledger row.
 *   This is the safety net for at-least-once delivery from pg_cron → pg_net:
 *   if the network glitches and the wrapper retries with the same
 *   gen_random_uuid()-derived run_id, the catalog must not be applied twice.
 *
 * RED-first state (Constitution IX):
 *   Authored before T032 lands. WILL fail until the coordinator implements
 *   the step-3 short-circuit. That's the gate.
 *
 * Skip policy:
 *   `RUN_SYNC_CATALOG_TESTS=1` + Supabase URL + service-role key + internal
 *   secret. Without all four the test self-skips so plain `deno test` stays
 *   green on machines lacking Docker / the Supabase CLI.
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

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip transport-level non-determinism from a coordinator response so two
 * calls can be compared shape-and-value-for-value. The contract guarantees
 * that the second (idempotent) call returns the SAME outcome/counts as the
 * first plus a `notes='idempotent retry'` field — so we drop `notes` from
 * both sides before the equality check and assert on it separately.
 *
 * `started_at` / `finished_at` are deliberately KEPT in the comparison
 * because per Coordinator step 3 the retry returns the recorded outcome —
 * i.e., the original timestamps. If a coordinator regression caused the
 * retry to "rerun and re-stamp", this equality would fail.
 */
function withoutNotes(body: Record<string, unknown>): Record<string, unknown> {
  const { notes: _omit, ...rest } = body;
  return rest;
}

async function postSync(runId: string): Promise<Response> {
  return await fetch(SYNC_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Auth": SYNC_TRIGGER_SECRET,
    },
    body: JSON.stringify({
      provider: PROVIDER,
      trigger: "cron",
      run_id: runId,
    }),
  });
}

// ============================================================================
// Test
// ============================================================================

Deno.test({
  name:
    "idempotent_retry: same run_id POSTed twice yields 200 + notes='idempotent retry' on the second call, with identical outcome/counts and no duplicate provider_sync_runs row",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();
    const runId = crypto.randomUUID();

    // --- First POST: drives the coordinator end-to-end. ----------------------
    const first = await postSync(runId);
    assertEquals(
      first.status,
      200,
      "first POST with a fresh run_id must return 200 OK",
    );
    const firstBody = await first.json();
    assertEquals(
      firstBody?.run_id,
      runId,
      "first response must echo the supplied run_id",
    );
    assert(
      typeof firstBody?.outcome === "string",
      "first response must carry an outcome string",
    );
    assert(
      firstBody?.counts && typeof firstBody.counts === "object",
      "first response must include a counts object",
    );

    // --- Second POST: same run_id; must short-circuit at Coordinator step 3. -
    const second = await postSync(runId);
    assertEquals(
      second.status,
      200,
      "second POST with the same run_id must also return 200 (idempotent), not 409",
    );
    const secondBody = await second.json();

    // The retry MUST carry the contract's `notes` marker.
    assertEquals(
      secondBody?.notes,
      "idempotent retry",
      "second response must carry notes='idempotent retry' per contract § Coordinator behavior step 3",
    );

    // Aside from `notes`, the two response bodies must be identical:
    // same run_id, provider, outcome, counts, started_at, finished_at,
    // attempts. Anything else implies the coordinator re-ran instead of
    // short-circuiting.
    assertEquals(
      withoutNotes(secondBody),
      withoutNotes(firstBody),
      "idempotent retry body must mirror the original body (modulo the `notes` marker)",
    );

    // --- Ledger invariant: exactly one provider_sync_runs row for run_id. ----
    // The retry must NOT insert a new ledger row; it must echo the existing
    // one. We use a count query so this remains correct even if a future
    // coordinator added columns to the ledger row.
    const { count: ledgerCount, error: ledgerErr } = await supabase
      .from("provider_sync_runs")
      .select("*", { count: "exact", head: true })
      .eq("id", runId);
    if (ledgerErr) {
      throw new Error(`provider_sync_runs count failed: ${ledgerErr.message}`);
    }
    assertEquals(
      ledgerCount,
      1,
      "exactly one provider_sync_runs row must exist for the retried run_id",
    );
  },
});
