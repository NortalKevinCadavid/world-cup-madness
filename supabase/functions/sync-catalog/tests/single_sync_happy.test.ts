/**
 * Slice 002 / T023 — Single sync happy-path test (RED).
 *
 * Contract:
 *   - specs/002-match-catalog/contracts/sync-runner.scheduled.md
 *       § Invocation Path 1 (scheduled / X-Internal-Auth)
 *       § Response (200 OK shape)
 *       § Coordinator behavior steps 1-15
 *       § Outcome enum (`success` / `success_no_changes`)
 *       § Test surface (the `single_sync_happy.test.ts` row)
 *   - specs/002-match-catalog/data-model.md § Entity 5 (provider_sync_runs):
 *       `id` is the PK and equals `run_id` from the request per
 *       sync-runner.scheduled.md § Coordinator behavior step 3.
 *
 * What this test proves:
 *   POSTing to /functions/v1/sync-catalog with the `stub` provider, a valid
 *   `X-Internal-Auth` secret, and a fresh `run_id`:
 *     (a) returns HTTP 200 with the contract response shape (run_id echoed,
 *         outcome string, counts object, provider == 'stub'),
 *     (b) writes a `provider_sync_runs` row with `id = run_id`,
 *         `provider_name = 'stub'`, and a terminal `outcome` (per Coordinator
 *         step 11),
 *     (c) leaves `matches` populated with the canonical fixture set. The
 *         stub adapter (T030) is authored to emit the same 8 matches the
 *         slice-002 seed already contains, so UPSERT is idempotent — the
 *         row count stays at 8 regardless of whether the coordinator records
 *         `outcome='success'` (first apply) or `outcome='success_no_changes'`
 *         (re-apply against a freshly-seeded DB). Both outcomes are valid per
 *         the contract for a happy run; this test accepts either to remain
 *         stable against test-DB reset timing.
 *
 * RED-first state (Constitution IX):
 *   This test is authored BEFORE T032 (the `sync-catalog` Edge Function
 *   index.ts) ships. It WILL fail until T032 + T030 + T031 land. That
 *   failure is the spec gate. Once the coordinator is implemented, the
 *   test becomes the regression gate.
 *
 * Skip policy:
 *   The test self-skips unless `RUN_SYNC_CATALOG_TESTS=1` AND the required
 *   environment is present (mirrors T024 sibling tests). Docker + Supabase
 *   CLI are NOT installed on every contributor's box, so `deno test` must
 *   remain clean without them — gated execution preserves that.
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
// Test
// ============================================================================

Deno.test({
  name:
    "single_sync_happy: POST with valid X-Internal-Auth runs the coordinator, returns 200, writes provider_sync_runs, and leaves matches populated",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // Pre-state: the slice-002 seed installs 8 matches. We assert the
    // baseline so that a regression in the fixture (or a polluted test DB)
    // fails LOUDLY before we accuse the coordinator of misbehaving.
    const { count: beforeMatches, error: beforeErr } = await supabase
      .from("matches")
      .select("*", { count: "exact", head: true });
    if (beforeErr) {
      throw new Error(`pre-state count failed: ${beforeErr.message}`);
    }
    assertEquals(
      beforeMatches,
      8,
      "Slice-002 seed must install exactly 8 matches before the sync runs",
    );

    // Trigger the coordinator. Use a fresh UUID so the test never collides
    // with prior runs in a long-lived test DB.
    const runId = crypto.randomUUID();
    const response = await fetch(SYNC_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth": SYNC_TRIGGER_SECRET,
        // Scheduled-path invocation deliberately carries NO Authorization
        // header (per contract § Auth, scheduled path authenticates via the
        // internal secret alone).
      },
      body: JSON.stringify({
        provider: PROVIDER,
        trigger: "cron",
        run_id: runId,
      }),
    });

    assertEquals(
      response.status,
      200,
      "happy-path POST with valid X-Internal-Auth must return HTTP 200",
    );

    const body = await response.json();

    // Response shape per contract § Response (200 OK).
    assertEquals(body?.run_id, runId, "200 body must echo the request run_id");
    assertEquals(
      body?.provider,
      PROVIDER,
      "200 body must echo the requested provider name",
    );
    assert(
      typeof body?.outcome === "string",
      "200 body must carry an outcome string per § Outcome enum",
    );
    assert(
      body.outcome === "success" || body.outcome === "success_no_changes",
      `happy-path outcome must be one of {success, success_no_changes}, got ${body.outcome}`,
    );
    assert(
      body?.counts && typeof body.counts === "object",
      "200 body must include a counts object",
    );
    assertEquals(
      typeof body?.started_at,
      "string",
      "200 body must include started_at (ISO-8601 UTC string)",
    );
    assertEquals(
      typeof body?.finished_at,
      "string",
      "200 body must include finished_at (ISO-8601 UTC string)",
    );
    assert(
      typeof body?.attempts === "number" && body.attempts >= 1,
      "200 body must include attempts (>= 1)",
    );

    // Ledger row: provider_sync_runs.id == run_id (Coordinator step 3).
    const { data: runRow, error: runErr } = await supabase
      .from("provider_sync_runs")
      .select("id, provider_name, outcome, finished_at, started_at, counts, attempts")
      .eq("id", runId)
      .single();
    if (runErr) {
      throw new Error(`provider_sync_runs lookup failed: ${runErr.message}`);
    }
    assert(runRow, "a provider_sync_runs row must exist for the request run_id");
    assertEquals(
      runRow.provider_name,
      PROVIDER,
      "provider_sync_runs.provider_name must record the stub provider",
    );
    assert(
      runRow.outcome === "success" || runRow.outcome === "success_no_changes",
      `provider_sync_runs.outcome must be a terminal happy outcome, got ${runRow.outcome}`,
    );
    assert(
      runRow.finished_at !== null,
      "provider_sync_runs.finished_at must be populated after the coordinator returns",
    );

    // The stub adapter emits the same 8 matches the seed installed, so the
    // table count is invariant across a happy run regardless of whether the
    // coordinator classified the apply as `success` (rows touched) or
    // `success_no_changes` (no diff).
    const { count: afterMatches, error: afterErr } = await supabase
      .from("matches")
      .select("*", { count: "exact", head: true });
    if (afterErr) {
      throw new Error(`post-state count failed: ${afterErr.message}`);
    }
    assertEquals(
      afterMatches,
      8,
      "matches table must still hold 8 rows after an idempotent stub-provider sync (no orphan inserts, no accidental deletes)",
    );
  },
});
