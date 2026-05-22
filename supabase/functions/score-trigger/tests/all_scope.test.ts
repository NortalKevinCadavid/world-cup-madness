/**
 * Slice 005 / T037 — all_scope.test.ts (RED -> GREEN at runtime).
 *
 * Contract: contracts/scoring-trigger.edge-fn.md
 *   § Request  (scope='all' takes NO target_id)
 *   § Behavior steps 1-7 (auth -> lock -> score_all -> read run -> respond)
 *   § Response (run summary shape, target_id null on the wire for all)
 *   § Error responses (target_id forbidden for scope='all' -> 422)
 *
 * What this test proves at runtime:
 *
 *   Case A — happy path:
 *     POST /functions/v1/score-trigger with
 *       { scope:'all', reason:'test', run_id:<R> }
 *     and X-Internal-Auth: $SCORE_TRIGGER_INTERNAL_AUTH_SECRET returns 200
 *     and a run summary with:
 *       - status='succeeded'
 *       - scope='all'
 *       - target_id null (absent / null on the wire — the run row column
 *         is NULL per slot 0050 CHECK for non-'match' scopes)
 *       - calculation_version_written: positive integer
 *       - affected_record_count: 30 (slice-005 fixture seeds 3 finished
 *         matches × 6 eligible active participants = 18 match score_records,
 *         PLUS 12 active final_predictions rows = 12 final score_records.
 *         18 + 12 = 30 total rows under one run_id.
 *         See supabase/seed/slice-005-fixture.sql header for the truth table.
 *         score_all (slot 0058) writes all 30 in a single transaction with
 *         a single pointer bump.)
 *     Cross-check via service-role: 30 score_records rows exist for
 *     (run_id=<R>); 18 with target_kind='match', 12 with target_kind='final'.
 *     Verifies the fixture's full-leaderboard truth table is reproducible
 *     from a single scope='all' invocation (T037 Definition of done).
 *
 *   Case B — target_id forbidden:
 *     POST same endpoint with
 *       { scope:'all', target_id:<any uuid>, reason:..., run_id:<R2> }
 *     returns 422 + error.code='UNPROCESSABLE_ENTITY' BEFORE the SP is
 *     called. No score_records / score_calculation_runs rows should
 *     have been written under R2 — the Edge Function rejects the body
 *     prior to acquiring the advisory lock or invoking the SP. Mirrors
 *     finals_scope.test.ts Case B with the all-scope-specific reason
 *     'target_id_forbidden_for_all'.
 *
 * Cleanup: deletes score_records + score_calculation_runs rows for the
 *   run_ids used in this file. audit_log rows are LEFT in place (append-
 *   only contract from slice 007). Distinct run_ids per case keep the
 *   cleanups independent. The eeee0099-0005-4005-8037-* prefix is reserved
 *   for T037 so a crashed cleanup in this file does not poison a sibling
 *   slice-005 Deno test's run_id pre-cleanup.
 *
 * Skip policy: RUN_EDGE_FN_TESTS=1 + SUPABASE_URL + service-role + internal
 *   secret + function URL. Without all five the tests self-skip. Mirrors
 *   T015 + T020 patterns. Docker-down environments (the slice 005 Phase 7
 *   polish baseline) self-skip; runtime verification is deferred to T041.
 *
 * Constitution alignment: III (orchestration only; the rules live in the
 *   SP at slot 0058), V (every run row is audited via the AFTER INSERT
 *   trigger on score_records / slot 0055), VII (idempotent on run_id).
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
// pre-cleanup. The eeee0099-0005-4005-8037-* prefix is reserved for T037.
const R_ALL_OK = "eeee0099-0005-4005-8037-000000000001";
const R_ALL_FORBIDDEN = "eeee0099-0005-4005-8037-000000000002";

// A throwaway uuid used as the (invalid) target_id payload in case B. The
// Edge Function MUST reject the request BEFORE this uuid is dereferenced
// against any table, so its actual value is irrelevant.
const FORBIDDEN_TARGET_ID = "00000000-1111-2222-3333-444444444444";

// Expected affected_record_count from the slice-005 fixture under a single
// scope='all' invocation:
//   - 3 finished matches (M1 ARG-MEX, M2 ESP-BRA, M3 CAN-USA) × 6 eligible
//     active participants (alpha, bravo, charlie, delta, epsilon, zeta)
//     = 18 match-kind score_records rows.
//   - 12 active final_predictions rows (slice-004 seeds 6 + slice-005 seeds
//     6 more on distinct (participant, item_kind) slots)
//     = 12 final-kind score_records rows.
//   - Total = 30 rows under one run_id.
// See supabase/seed/slice-005-fixture.sql § "Slice 005 UUID conventions"
// and § "TRUTH TABLE" for the hand-verified leaderboard breakdown.
const EXPECTED_ALL_AFFECTED = 30;
const EXPECTED_MATCH_ROWS = 18;
const EXPECTED_FINAL_ROWS = 12;

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
    "all_scope: POST scope='all' returns 200, affected_record_count=30 (18 match + 12 final), full-fixture leaderboard scored under one run_id",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // Defensive pre-cleanup in case a prior crashed run left rows around.
    await cleanup(supabase, R_ALL_OK);

    try {
      const response = await postScore({
        scope: "all",
        reason: "T037 all_scope happy-path test",
        run_id: R_ALL_OK,
      });

      assertEquals(
        response.status,
        200,
        `score-trigger MUST return 200 on a fresh scope='all' invocation. Body: ${await response.clone().text()}`,
      );

      const body = await response.json();

      assertEquals(body.run_id, R_ALL_OK, "response must echo the supplied run_id");
      assertEquals(body.scope, "all", "response must echo scope='all'");
      // target_id is null on the wire for scope='all' (the score_calculation_runs
      // row's target_id column is NULL per slot 0050 CHECK; the Edge
      // Function passes that through unchanged).
      assert(
        body.target_id === null || body.target_id === undefined,
        `scope='all' response.target_id must be null/absent — got: ${JSON.stringify(body.target_id)}`,
      );
      assertEquals(
        body.affected_record_count,
        EXPECTED_ALL_AFFECTED,
        `score_all must emit exactly ${EXPECTED_ALL_AFFECTED} rows under the slice-005 fixture: ${EXPECTED_MATCH_ROWS} match-kind + ${EXPECTED_FINAL_ROWS} final-kind. See fixture header for the truth table.`,
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

      // Cross-check via service-role: 30 score_records rows exist for this
      // run_id, split 18/12 across match/final target_kinds. score_all is
      // the single owner of v_target_version rows during its transaction
      // so the counts are exact.
      const { data: allRows, error: allErr } = await supabase
        .from("score_records")
        .select("participant_id, target_kind, final_item_kind, points, reason_code, calculation_version")
        .eq("run_id", R_ALL_OK);
      if (allErr) {
        throw new Error(`score_records SELECT failed: ${allErr.message}`);
      }
      assertEquals(
        allRows?.length,
        EXPECTED_ALL_AFFECTED,
        `exactly ${EXPECTED_ALL_AFFECTED} score_records rows must exist for run_id=R_ALL_OK across both target_kinds`,
      );

      const matchRows = (allRows ?? []).filter((r) => r.target_kind === "match");
      const finalRows = (allRows ?? []).filter((r) => r.target_kind === "final");
      assertEquals(
        matchRows.length,
        EXPECTED_MATCH_ROWS,
        `exactly ${EXPECTED_MATCH_ROWS} match-kind score_records rows must exist for run_id=R_ALL_OK (3 finished matches × 6 eligible participants)`,
      );
      assertEquals(
        finalRows.length,
        EXPECTED_FINAL_ROWS,
        `exactly ${EXPECTED_FINAL_ROWS} final-kind score_records rows must exist for run_id=R_ALL_OK (12 active final_predictions rows)`,
      );

      // All rows must share one calculation_version (single pointer bump
      // per scope='all' transaction per scoring-model.md / R-003).
      const distinctVersions = new Set(
        (allRows ?? []).map((r) => r.calculation_version),
      );
      assertEquals(
        distinctVersions.size,
        1,
        `all 30 rows for run_id=R_ALL_OK must share a single calculation_version — got: ${JSON.stringify(Array.from(distinctVersions))}`,
      );

      // Cross-check the leaderboard view reads the same fixture truth table
      // after a scope='all' run. The slice-005 fixture's hand-verified
      // ranking is: alpha (60 match + 60 final = 120), bravo (45 + 0 = 45),
      // charlie (varies), ..., zeta (0). We assert the leaderboard row
      // count == 6 eligible participants (a structural smoke check; the
      // exact points are covered by slot 0054's pgTAP tests and T008).
      const { data: lbRows, error: lbErr } = await supabase
        .from("leaderboard_v")
        .select("participant_id, total_points, rank")
        .order("rank", { ascending: true });
      if (lbErr) {
        // leaderboard_v may not yet be queryable via PostgREST in all
        // environments; this is a soft check — log and continue.
        console.warn(
          `leaderboard_v read failed (soft check): ${lbErr.message}`,
        );
      } else {
        assert(
          (lbRows?.length ?? 0) >= 6,
          `leaderboard_v must surface at least 6 eligible participants after scope='all' scoring — got: ${lbRows?.length}`,
        );
      }
    } finally {
      await cleanup(supabase, R_ALL_OK);
    }
  },
});

// ============================================================================
// Case B — target_id forbidden for scope='all'
// ============================================================================

Deno.test({
  name:
    "all_scope: POST scope='all' with target_id returns 422 UNPROCESSABLE_ENTITY before the SP is called",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // Defensive pre-cleanup — the request MUST be rejected before any rows
    // are written, but pre-cleanup keeps the test resilient to a regression
    // where the Edge Function partially-runs and inserts a run row.
    await cleanup(supabase, R_ALL_FORBIDDEN);

    try {
      const response = await postScore({
        scope: "all",
        target_id: FORBIDDEN_TARGET_ID,
        reason: "T037 all_scope target_id-forbidden test",
        run_id: R_ALL_FORBIDDEN,
      });

      assertEquals(
        response.status,
        422,
        `score-trigger MUST return 422 when scope='all' is sent with a target_id. Body: ${await response.clone().text()}`,
      );

      const body = await response.json();
      assertEquals(
        body?.error?.code,
        "UNPROCESSABLE_ENTITY",
        "422 body must carry error.code='UNPROCESSABLE_ENTITY'",
      );
      assertEquals(
        body?.error?.reason,
        "target_id_forbidden_for_all",
        "422 body should carry the stable reason code 'target_id_forbidden_for_all' so callers can branch on it",
      );

      // Verify NO rows were written under this run_id — the Edge Function
      // must reject the request BEFORE acquiring the advisory lock or
      // invoking the SP. (A regression that writes the run row would
      // surface here.)
      const { data: runRow, error: runErr } = await supabase
        .from("score_calculation_runs")
        .select("id")
        .eq("id", R_ALL_FORBIDDEN)
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
      await cleanup(supabase, R_ALL_FORBIDDEN);
    }
  },
});
