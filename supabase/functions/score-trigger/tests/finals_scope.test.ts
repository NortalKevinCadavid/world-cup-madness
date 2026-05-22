/**
 * Slice 005 / T020 — finals_scope.test.ts (RED -> GREEN).
 *
 * Contract: contracts/scoring-trigger.edge-fn.md
 *   § Request  (scope='finals' takes NO target_id)
 *   § Behavior steps 1-7 (auth -> lock -> score_finals -> read run -> respond)
 *   § Response (run summary shape, target_id null on the wire for finals)
 *   § Error responses (target_id forbidden for finals -> 422)
 *
 * What this test proves at runtime:
 *
 *   Case A — happy path:
 *     POST /functions/v1/score-trigger with
 *       { scope:'finals', reason:'test', run_id:<R> }
 *     and X-Internal-Auth: $SCORE_TRIGGER_INTERNAL_AUTH_SECRET returns 200
 *     and a run summary with:
 *       - status='succeeded'
 *       - scope='finals'
 *       - target_id null (absent / null on the wire — the run row column
 *         is NULL per slot 0050 CHECK for non-'match' scopes)
 *       - calculation_version_written: positive integer
 *       - affected_record_count: 12 (slice-004 fixture seeds 6 active
 *         final_predictions rows + slice-005 fixture adds 6 more on
 *         distinct (participant, item_kind) slots = 12 active rows.
 *         score_finals writes one score_records row per active
 *         final_predictions row per scoring-model.md § 7.3).
 *     Cross-check via service-role: 12 score_records rows exist for
 *     (run_id=<R>, target_kind='final').
 *
 *   Case B — target_id forbidden:
 *     POST same endpoint with
 *       { scope:'finals', target_id:<any uuid>, reason:..., run_id:<R2> }
 *     returns 422 + error.code='UNPROCESSABLE_ENTITY' BEFORE the SP is
 *     called. No score_records / score_calculation_runs rows should
 *     have been written under R2 — the Edge Function rejects the body
 *     prior to acquiring the advisory lock or invoking the SP.
 *
 * Cleanup: deletes score_records + score_calculation_runs rows for the
 *   run_ids used in this file. audit_log rows are LEFT in place (append-
 *   only contract from slice 007). Distinct run_ids per case keep the
 *   cleanups independent.
 *
 * Skip policy: RUN_EDGE_FN_TESTS=1 + SUPABASE_URL + service-role + internal
 *   secret. Without all four the tests self-skip. Mirrors T015's tests.
 *
 * Constitution alignment: III (orchestration only; the rules live in the SP),
 *   V (every run row is audited via the AFTER INSERT trigger on
 *   score_records / slot 0055), VII (idempotent on run_id).
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

// Test-scoped run_ids. Distinct from other slice-005 Deno tests so a
// crashed cleanup in this file does not poison a sibling test's run_id
// pre-cleanup. The eeee0099-0005-* prefix is reserved for T020.
const R_FINALS_OK = "eeee0099-0005-4005-8005-000000000001";
const R_FINALS_FORBIDDEN = "eeee0099-0005-4005-8005-000000000002";

// A throwaway uuid used as the (invalid) target_id payload in case B. The
// Edge Function MUST reject the request BEFORE this uuid is dereferenced
// against any table, so its actual value is irrelevant.
const FORBIDDEN_TARGET_ID = "00000000-1111-2222-3333-444444444444";

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
// Case A — happy path
// ============================================================================

Deno.test({
  name:
    "finals_scope: POST scope='finals' returns 200, affected_record_count=12, score_records inserted with target_kind='final'",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // Defensive pre-cleanup in case a prior crashed run left rows around.
    await cleanup(supabase, R_FINALS_OK);

    try {
      const response = await postScore({
        scope: "finals",
        reason: "T020 finals_scope happy-path test",
        run_id: R_FINALS_OK,
      });

      assertEquals(
        response.status,
        200,
        `score-trigger MUST return 200 on a fresh scope='finals' invocation. Body: ${await response.clone().text()}`,
      );

      const body = await response.json();

      assertEquals(body.run_id, R_FINALS_OK, "response must echo the supplied run_id");
      assertEquals(body.scope, "finals", "response must echo scope='finals'");
      // target_id is null on the wire for finals (the score_calculation_runs
      // row's target_id column is NULL per slot 0050 CHECK; the Edge
      // Function passes that through unchanged).
      assert(
        body.target_id === null || body.target_id === undefined,
        `scope='finals' response.target_id must be null/absent — got: ${JSON.stringify(body.target_id)}`,
      );
      assertEquals(
        body.affected_record_count,
        12,
        "slice-004 fixture seeds 6 active final_predictions rows + slice-005 fixture adds 6 more on distinct (participant, item_kind) slots — score_finals must emit one score_records row per active row = 12 total",
      );
      assert(
        typeof body.calculation_version_written === "number" &&
          Number.isInteger(body.calculation_version_written) &&
          body.calculation_version_written > 0,
        `calculation_version_written must be a positive integer on success — got: ${JSON.stringify(body.calculation_version_written)}`,
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

      // Cross-check via service-role: 12 score_records rows exist for this
      // run_id, all with target_kind='final'. score_finals is the single
      // owner of final-kind rows at this version, so the count is exact.
      const { data: rows, error: rowsErr } = await supabase
        .from("score_records")
        .select("participant_id, target_kind, final_item_kind, points, reason_code, calculation_version")
        .eq("run_id", R_FINALS_OK)
        .eq("target_kind", "final");
      if (rowsErr) {
        throw new Error(`score_records SELECT failed: ${rowsErr.message}`);
      }
      assertEquals(
        rows?.length,
        12,
        "exactly 12 score_records rows must exist for (run_id=R_FINALS_OK, target_kind='final') — matches the fixture's 12 active final_predictions rows",
      );
    } finally {
      await cleanup(supabase, R_FINALS_OK);
    }
  },
});

// ============================================================================
// Case B — target_id forbidden for scope='finals'
// ============================================================================

Deno.test({
  name:
    "finals_scope: POST scope='finals' with target_id returns 422 UNPROCESSABLE_ENTITY before the SP is called",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // Defensive pre-cleanup — the request MUST be rejected before any rows
    // are written, but pre-cleanup keeps the test resilient to a regression
    // where the Edge Function partially-runs and inserts a run row.
    await cleanup(supabase, R_FINALS_FORBIDDEN);

    try {
      const response = await postScore({
        scope: "finals",
        target_id: FORBIDDEN_TARGET_ID,
        reason: "T020 finals_scope target_id-forbidden test",
        run_id: R_FINALS_FORBIDDEN,
      });

      assertEquals(
        response.status,
        422,
        `score-trigger MUST return 422 when scope='finals' is sent with a target_id. Body: ${await response.clone().text()}`,
      );

      const body = await response.json();
      assertEquals(
        body?.error?.code,
        "UNPROCESSABLE_ENTITY",
        "422 body must carry error.code='UNPROCESSABLE_ENTITY'",
      );
      assertEquals(
        body?.error?.reason,
        "target_id_forbidden_for_finals",
        "422 body should carry the stable reason code 'target_id_forbidden_for_finals' so callers can branch on it",
      );

      // Verify NO rows were written under this run_id — the Edge Function
      // must reject the request BEFORE acquiring the advisory lock or
      // invoking the SP. (A regression that writes the run row would
      // surface here.)
      const { data: runRow, error: runErr } = await supabase
        .from("score_calculation_runs")
        .select("id")
        .eq("id", R_FINALS_FORBIDDEN)
        .maybeSingle();
      if (runErr) {
        throw new Error(`score_calculation_runs SELECT failed: ${runErr.message}`);
      }
      assertEquals(
        runRow,
        null,
        "no score_calculation_runs row may exist for a 422-rejected request — the Edge Function must short-circuit before the SP call",
      );
    } finally {
      await cleanup(supabase, R_FINALS_FORBIDDEN);
    }
  },
});
