/**
 * Slice 005 / T015 — single_match_auto_trigger.test.ts (RED).
 *
 * Contract: contracts/scoring-trigger.edge-fn.md
 *   § Request (admin path / auto path)
 *   § Behavior steps 1-7
 *   § Response (run summary shape)
 *
 * What this test proves at runtime:
 *   - POST /functions/v1/score-trigger with {scope:'match', target_id:M1,
 *     reason:'test', run_id:R1} and the X-Internal-Auth header set to the
 *     SCORE_TRIGGER_INTERNAL_AUTH_SECRET env var returns 200.
 *   - The response body carries affected_record_count=6 (the slice-005
 *     fixture seeds 6 active eligible participants — alpha, bravo, charlie,
 *     delta, epsilon, zeta — all of whom must contribute one score_records
 *     row for M1 per § Behavior step 4 + score_match SP semantics).
 *   - calculation_version_written is a number.
 *   - The 6 score_records rows are visible via service-role SELECT keyed by
 *     run_id=R1 and target_id=M1.
 *
 * Cleanup: deletes the 6 score_records rows and the score_calculation_runs
 * row keyed by R1. audit_log rows are LEFT in place (append-only contract
 * from slice 007). The next test's distinct run_id makes this safe.
 *
 * Skip policy: RUN_EDGE_FN_TESTS=1 + SUPABASE_URL + service-role + internal
 * secret. Without all four the test self-skips (mirrors slice 002 +
 * slice 004 D-020 pattern).
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

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

// Slice-005 fixture UUID conventions — see supabase/seed/slice-005-fixture.sql
// § "Slice 005 UUID conventions". M1 is the ARG-MEX finished match (2-1).
const M1 = "eeee0050-0000-0000-0000-000000000001";
// A deterministic-but-test-scoped run_id. Distinct from other tests so a
// crashed cleanup in one test doesn't poison a sibling.
const R1 = "eeee0099-0001-4001-8001-000000000001";

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function postScore(body: Record<string, unknown>): Promise<Response> {
  return await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Auth": INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
  });
}

async function cleanup(supabase: SupabaseClient, runId: string): Promise<void> {
  // score_records first (FK to score_calculation_runs via run_id).
  await supabase.from("score_records").delete().eq("run_id", runId);
  await supabase.from("score_calculation_runs").delete().eq("id", runId);
}

// ============================================================================
// Test
// ============================================================================

Deno.test({
  name:
    "single_match_auto_trigger: POST scope='match' for M1 returns 200, affected_record_count=6, score_records inserted",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // Defensive pre-cleanup in case a prior crashed run left rows around.
    await cleanup(supabase, R1);

    try {
      const response = await postScore({
        scope: "match",
        target_id: M1,
        reason: "T015 single_match_auto_trigger test",
        run_id: R1,
      });

      assertEquals(
        response.status,
        200,
        `score-trigger MUST return 200 on a fresh scope='match' invocation. Body: ${await response.clone().text()}`,
      );

      const body = await response.json();

      assertEquals(body.run_id, R1, "response must echo the supplied run_id");
      assertEquals(body.scope, "match", "response must echo scope='match'");
      assertEquals(
        body.target_id,
        M1,
        "response must echo the supplied target_id",
      );
      assertEquals(
        body.affected_record_count,
        6,
        "slice-005 fixture seeds 6 eligible-active participants — every score_match call for one finished match must write 6 rows (one per participant, per §7.2 truth table)",
      );
      assert(
        typeof body.calculation_version_written === "number" &&
          Number.isInteger(body.calculation_version_written),
        "calculation_version_written must be a non-null integer on success",
      );
      assertEquals(
        body.status,
        "succeeded",
        "status must be 'succeeded' once the SP returns",
      );
      assert(
        typeof body.started_at === "string" && body.started_at.length > 0,
        "started_at must be present in ISO-8601 form",
      );
      assert(
        typeof body.completed_at === "string" && body.completed_at.length > 0,
        "completed_at must be present in ISO-8601 form",
      );

      // Cross-check via service-role: 6 score_records rows for M1 under R1.
      const { data: rows, error: rowsErr } = await supabase
        .from("score_records")
        .select("participant_id, target_id, points, reason_code, calculation_version")
        .eq("run_id", R1)
        .eq("target_id", M1);
      if (rowsErr) {
        throw new Error(`score_records SELECT failed: ${rowsErr.message}`);
      }
      assertEquals(
        rows?.length,
        6,
        "exactly 6 score_records rows must exist for (run_id=R1, target_id=M1)",
      );
    } finally {
      await cleanup(supabase, R1);
    }
  },
});
