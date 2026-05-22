/**
 * Slice 005 / T044 — all_scope_perf.test.ts (RED, perf gate).
 *
 * Perf gate for SC-005: "after a corrected match score (Slice 006), every
 * affected participant's leaderboard rank reflects the new value within
 * 1 minute of recalculation completion."
 *
 * This file is a SIBLING to T037's all_scope.test.ts and deliberately
 * authored as a separate file so that:
 *   * Functional/correctness assertions (T037 — scope='all' behaviour and
 *     audit_log shape) stay decoupled from wall-clock perf assertions
 *     (T044) — slow runner flakiness on the perf gate never poisons the
 *     row-count assertions in T037.
 *   * The gate can be opted into via RUN_PERF_TESTS=1 — regular CI runs
 *     T037 but does NOT run this file unless explicitly enabled on a
 *     perf-stable runner.
 *   * The full-tournament fixture (500 participants × 104 matches ≈ 52K
 *     predictions; see supabase/seed/slice-005-full-tournament-fixture.sql)
 *     is heavy; loading it for every Deno test run would slow CI.
 *     Out-of-band loading + RUN_PERF_TESTS=1 keeps the regular Edge-Function
 *     test suite fast.
 *
 * Source of truth:
 *   * specs/005-scoring-leaderboard/spec.md § SC-005 — the < 60-second
 *     budget for a full-tournament recalculation.
 *   * specs/005-scoring-leaderboard/contracts/scoring-trigger.edge-fn.md
 *     § Performance — "A full-tournament `scope='all'` rescores ~52,500
 *     rows; expected duration under 60 s (SC-005)."
 *   * supabase/functions/score-trigger/tests/finals_scope.test.ts (T020) —
 *     pattern reference for env-gating, service-role cleanup, and
 *     X-Internal-Auth invocation.
 *   * supabase/seed/slice-005-full-tournament-fixture.sql (T044) — the
 *     500 × 104 fixture that this test assumes is loaded.
 *
 * Gating contract:
 *   * RUN_EDGE_FN_TESTS=1 — base gate (same as every score-trigger Deno
 *     test). Without it the score-trigger function URL + service-role
 *     key are typically absent.
 *   * RUN_PERF_TESTS=1 — additional gate, perf-specific. Both MUST be set
 *     for these tests to execute; otherwise they self-skip via Deno.test
 *     { ignore: !HAS_ENV }.
 *   * The full-tournament fixture MUST be loaded BEFORE running this file
 *     (out-of-band: `psql -f supabase/seed/slice-005-full-tournament-fixture.sql`).
 *
 * What this test proves at runtime:
 *   1. scope='match' on a single finished match in the full-tournament
 *      fixture (500 participants → ~500 score_records writes) completes
 *      in under 60,000 ms — measured BOTH at the HTTP layer (round-trip)
 *      AND at the SP layer (completed_at - started_at from the response).
 *   2. scope='all' rescoring the full fixture (500 × 104 ≈ 52K match
 *      rows + 500 × 4 = 2K final rows = ~54K total) completes in under
 *      60,000 ms by the same dual measurement.
 *
 * The SP-layer measurement is the load-bearing one per the contract
 * (§ Performance specifies "expected duration under 60 s" for the SP
 * itself, not the HTTP round-trip). The HTTP measurement is captured
 * for observability — it includes the advisory-lock acquisition + the
 * commit, which the SP duration does not.
 *
 * Constitution alignment:
 *   * Principle IX (BDD assertions are checkable exact numbers) — the
 *     60,000 ms ceiling is a strict bound, no ranges, no "approximately".
 *   * Principle VII (Operational Resilience) — the perf gate is part of
 *     the "recalc completes within 1 min" operational contract.
 *
 * Cleanup: deletes score_records + score_calculation_runs rows keyed by
 * the perf-test run_ids. audit_log rows are LEFT in place (append-only
 * per slice 007). Distinct run_ids per case keep cleanups independent.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ============================================================================
// Environment + harness
// ============================================================================

const RUN_EDGE_FN_TESTS = Deno.env.get("RUN_EDGE_FN_TESTS") === "1";
const RUN_PERF_TESTS = Deno.env.get("RUN_PERF_TESTS") === "1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INTERNAL_SECRET =
  Deno.env.get("SCORE_TRIGGER_INTERNAL_AUTH_SECRET") ?? "";
const FUNCTION_URL = Deno.env.get("SCORE_TRIGGER_FUNCTION_URL")
  ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/score-trigger` : "");

// Both env vars MUST be set, plus the four secrets/URLs every Edge-Function
// test needs. Without all six the tests self-skip.
const HAS_ENV =
  RUN_EDGE_FN_TESTS &&
  RUN_PERF_TESTS &&
  SUPABASE_URL.length > 0 &&
  SERVICE_ROLE_KEY.length > 0 &&
  INTERNAL_SECRET.length > 0 &&
  FUNCTION_URL.length > 0;

// SC-005 budget — 60,000 ms (1 minute). Load-bearing numeric ceiling per
// the spec. Asserted strictly less-than (NOT less-than-or-equal) so a
// boundary regression to exactly 60 s fails the gate.
const RECALC_BUDGET_MS = 60_000;

// Test-scoped run_ids. The eeee0099-0044-* prefix is reserved for T044 so a
// crashed cleanup never collides with T015/T020/T037's run_ids. The choice
// of UUIDv4 layout (8-4-4-4-12) is preserved for Postgres uuid storage
// compatibility.
const R_PERF_MATCH = "eeee0099-0044-4044-8044-000000000001";
const R_PERF_ALL = "eeee0099-0044-4044-8044-000000000002";

// Full-tournament fixture seeds 104 finished matches with deterministic
// UUIDs of the form `ffff0050-NNNN-0000-0000-000000000000` where NNNN is
// the match index 1..104. Match 1 is the canonical "first finished match"
// that the scope='match' perf test targets. The fixture's seed file owns
// this naming convention; if the file's UUID scheme changes, this constant
// MUST move with it.
const PERF_MATCH_1 = "ffff0050-0001-0000-0000-000000000000";

// Expected affected_record_count bounds. The fixture commits 500 active
// match predictions for the targeted match, so scope='match' writes 500
// rows. scope='all' writes 500 × 104 match rows + 500 × 4 final rows
// (the latter only if the fixture seeds final_predictions for every
// load-test participant; T044's fixture does so deterministically) =
// 52,000 + 2,000 = 54,000 score_records rows total. The perf test asserts
// the count is in a sane band (>= 500 and >= 50,000 respectively) rather
// than an exact number — fixture tweaks (e.g. one match scheduled instead
// of finished) shouldn't break the perf gate as long as the workload is
// the right ORDER of magnitude.
const MIN_MATCH_ROWS = 500;
const MIN_ALL_ROWS = 50_000;

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
// Helper — extract SP-layer elapsed milliseconds from a successful response.
// The SP records started_at + completed_at in score_calculation_runs; the
// Edge Function echoes both in the response body. The difference is the
// load-bearing SP duration (excludes advisory-lock acquisition + commit,
// which the HTTP round-trip duration includes).
// ============================================================================

function spElapsedMs(body: { started_at: string; completed_at: string }): number {
  const start = new Date(body.started_at).getTime();
  const end = new Date(body.completed_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(
      `Response started_at/completed_at must be parseable ISO-8601 strings. ` +
        `Got started_at=${JSON.stringify(body.started_at)}, ` +
        `completed_at=${JSON.stringify(body.completed_at)}.`,
    );
  }
  return end - start;
}

// ============================================================================
// Case A — SC-005 perf gate, scope='match' on the full-tournament fixture.
// ============================================================================

Deno.test({
  name:
    "SC-005 — scope='match' on a fixture match (500 participants) MUST complete under 60 s (SP elapsed)",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();
    await cleanup(supabase, R_PERF_MATCH);

    try {
      const httpStart = Date.now();
      const response = await postScore({
        scope: "match",
        target_id: PERF_MATCH_1,
        reason: "T044 SC-005 perf gate — scope='match' on full-tournament fixture",
        run_id: R_PERF_MATCH,
      });
      const httpElapsed = Date.now() - httpStart;

      assertEquals(
        response.status,
        200,
        `score-trigger MUST return 200 on the perf-test scope='match' call. ` +
          `Body: ${await response.clone().text()}`,
      );

      const body = await response.json();
      assertEquals(body.run_id, R_PERF_MATCH, "response must echo run_id");
      assertEquals(body.scope, "match", "response must echo scope='match'");
      assertEquals(body.status, "succeeded", "status must be 'succeeded'");
      assert(
        typeof body.affected_record_count === "number" &&
          body.affected_record_count >= MIN_MATCH_ROWS,
        `affected_record_count must be at least ${MIN_MATCH_ROWS} on the ` +
          `full-tournament fixture (500 active predictions per match). ` +
          `Got ${body.affected_record_count} — the fixture was likely not loaded. ` +
          `Load supabase/seed/slice-005-full-tournament-fixture.sql before running this test.`,
      );

      // Load-bearing SC-005 assertion — SP-layer elapsed.
      const sp = spElapsedMs(body);
      console.log(
        `[T044/SC-005 scope='match'] HTTP elapsed=${httpElapsed} ms, ` +
          `SP elapsed=${sp} ms, affected_record_count=${body.affected_record_count} ` +
          `(budget ${RECALC_BUDGET_MS} ms)`,
      );
      assert(
        sp < RECALC_BUDGET_MS,
        `SC-005 FAIL: scope='match' SP elapsed ${sp} ms (>= ${RECALC_BUDGET_MS} ms). ` +
          `Full-tournament fixture: 500 participants. HTTP elapsed: ${httpElapsed} ms.`,
      );

      // HTTP round-trip is observability-only — NOT a load-bearing
      // assertion. It includes lock acquisition + commit which the SP
      // duration does not, and is more sensitive to network/CI jitter.
      // We log it for trend analysis but do NOT fail the test on it.
    } finally {
      await cleanup(supabase, R_PERF_MATCH);
    }
  },
});

// ============================================================================
// Case B — SC-005 perf gate, scope='all' on the full-tournament fixture.
// This is the canonical SC-005 measurement: 500 × 104 ≈ 52K match rows +
// 500 × 4 = 2K final rows = ~54K total score_records writes in a single
// run, all under the same advisory lock, under the 60-second ceiling.
// ============================================================================

Deno.test({
  name:
    "SC-005 — scope='all' on full-tournament fixture (500 x 104 ≈ 52K rows) MUST complete under 60 s (SP elapsed)",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();
    await cleanup(supabase, R_PERF_ALL);

    try {
      const httpStart = Date.now();
      const response = await postScore({
        scope: "all",
        reason: "T044 SC-005 perf gate — scope='all' on full-tournament fixture",
        run_id: R_PERF_ALL,
      });
      const httpElapsed = Date.now() - httpStart;

      assertEquals(
        response.status,
        200,
        `score-trigger MUST return 200 on the perf-test scope='all' call. ` +
          `Body: ${await response.clone().text()}`,
      );

      const body = await response.json();
      assertEquals(body.run_id, R_PERF_ALL, "response must echo run_id");
      assertEquals(body.scope, "all", "response must echo scope='all'");
      assertEquals(body.status, "succeeded", "status must be 'succeeded'");
      assert(
        typeof body.affected_record_count === "number" &&
          body.affected_record_count >= MIN_ALL_ROWS,
        `affected_record_count must be at least ${MIN_ALL_ROWS} on the ` +
          `full-tournament fixture (500 participants × 104 matches + 500 × 4 finals = ~54K). ` +
          `Got ${body.affected_record_count} — the fixture was likely not loaded or only ` +
          `partially seeded. Load supabase/seed/slice-005-full-tournament-fixture.sql before running this test.`,
      );

      // Load-bearing SC-005 assertion — SP-layer elapsed for the FULL
      // tournament recalc.
      const sp = spElapsedMs(body);
      console.log(
        `[T044/SC-005 scope='all'] HTTP elapsed=${httpElapsed} ms, ` +
          `SP elapsed=${sp} ms, affected_record_count=${body.affected_record_count} ` +
          `(budget ${RECALC_BUDGET_MS} ms)`,
      );
      assert(
        sp < RECALC_BUDGET_MS,
        `SC-005 FAIL: scope='all' SP elapsed ${sp} ms (>= ${RECALC_BUDGET_MS} ms). ` +
          `Full-tournament fixture: 500 participants × 104 matches. HTTP elapsed: ${httpElapsed} ms. ` +
          `affected_record_count=${body.affected_record_count}.`,
      );
    } finally {
      await cleanup(supabase, R_PERF_ALL);
    }
  },
});
