/**
 * Slice 005 / T015 — idempotent_retry.test.ts (RED).
 *
 * Contract: contracts/scoring-trigger.edge-fn.md
 *   § Behavior step 2 ("idempotent retry of a previously-succeeded run_id")
 *   § Response (idempotent retries return the prior run summary)
 * Research: research.md § R-002 (idempotent and order-independent scoring).
 *
 * What this test proves at runtime:
 *   Two POSTs with the SAME run_id:
 *     (1) First call drives score_match end-to-end and writes 6 score_records
 *         rows + one score_calculation_runs row.
 *     (2) Second call short-circuits inside score_match (the SP early-returns
 *         when the run row already has status='succeeded'). The Edge Function
 *         re-reads the run row and returns the SAME body shape — same
 *         affected_record_count, same calculation_version_written, same
 *         started_at/completed_at.
 *   This is the safety net for at-least-once delivery (DB trigger + retries).
 *
 * Invariants asserted after the second call:
 *   - Still exactly 6 score_records rows for (run_id, M1) (no duplicates).
 *   - score_calculation_runs row unchanged on the second call
 *     (started_at + completed_at identical).
 *
 * Skip policy: mirrors single_match_auto_trigger.test.ts.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

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

const M1 = "eeee0050-0000-0000-0000-000000000001";
const R1 = "eeee0099-0002-4002-8002-000000000002";

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function postScore(runId: string): Promise<Response> {
  return await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Auth": INTERNAL_SECRET,
    },
    body: JSON.stringify({
      scope: "match",
      target_id: M1,
      reason: "T015 idempotent_retry test",
      run_id: runId,
    }),
  });
}

async function cleanup(supabase: SupabaseClient, runId: string): Promise<void> {
  await supabase.from("score_records").delete().eq("run_id", runId);
  await supabase.from("score_calculation_runs").delete().eq("id", runId);
}

Deno.test({
  name:
    "idempotent_retry: same run_id POSTed twice yields identical body; score_records count remains 6 (no duplicates)",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();
    await cleanup(supabase, R1);

    try {
      // ----- First POST: drives the SP end-to-end. -----------------------
      const first = await postScore(R1);
      assertEquals(
        first.status,
        200,
        `first POST with a fresh run_id must return 200. Body: ${await first.clone().text()}`,
      );
      const firstBody = await first.json();

      // ----- Second POST: same run_id; SP short-circuits, Edge re-reads. -
      const second = await postScore(R1);
      assertEquals(
        second.status,
        200,
        `second POST with the same run_id must also return 200 (idempotent). Body: ${await second.clone().text()}`,
      );
      const secondBody = await second.json();

      // Body equality — every field that the contract guarantees stable on
      // a replay must match byte-for-byte (the SP early-returns and the
      // Edge function re-reads the same row).
      assertEquals(
        secondBody.run_id,
        firstBody.run_id,
        "run_id must match",
      );
      assertEquals(
        secondBody.affected_record_count,
        firstBody.affected_record_count,
        "affected_record_count must match (no double-scoring)",
      );
      assertEquals(
        secondBody.calculation_version_written,
        firstBody.calculation_version_written,
        "calculation_version_written must NOT bump on idempotent replay",
      );
      assertEquals(
        secondBody.started_at,
        firstBody.started_at,
        "started_at must NOT change on replay (the SP early-returns; the run row's started_at remains the original timestamp)",
      );
      assertEquals(
        secondBody.completed_at,
        firstBody.completed_at,
        "completed_at must NOT change on replay",
      );
      assertEquals(
        secondBody.status,
        "succeeded",
        "second response must also report status='succeeded'",
      );

      // Invariant: still exactly 6 score_records rows.
      const { count, error: countErr } = await supabase
        .from("score_records")
        .select("*", { count: "exact", head: true })
        .eq("run_id", R1)
        .eq("target_id", M1);
      if (countErr) {
        throw new Error(`score_records count failed: ${countErr.message}`);
      }
      assertEquals(
        count,
        6,
        "idempotent replay MUST NOT insert duplicate score_records rows (R-002)",
      );

      // Invariant: exactly one score_calculation_runs row.
      const { count: runRows, error: runReadErr } = await supabase
        .from("score_calculation_runs")
        .select("*", { count: "exact", head: true })
        .eq("id", R1);
      if (runReadErr) {
        throw new Error(`score_calculation_runs count failed: ${runReadErr.message}`);
      }
      assertEquals(
        runRows,
        1,
        "exactly one score_calculation_runs row must exist for the retried run_id",
      );

      assert(true, "idempotent retry invariants all hold");
    } finally {
      await cleanup(supabase, R1);
    }
  },
});
