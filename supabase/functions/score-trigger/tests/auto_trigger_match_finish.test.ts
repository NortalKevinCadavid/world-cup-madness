/**
 * Slice 005 / T042 — auto_trigger_match_finish.test.ts (RED, runtime-deferred).
 *
 * Contract: contracts/scoring-trigger.edge-fn.md § Invocation (auto path —
 *           DB trigger on match_results -> pg_net -> Edge Function).
 * Research: research.md § R-011 path 1 (auto-recalc on match finish).
 * Migration: supabase/migrations/0059_score_auto_trigger.sql.
 *
 * What this test proves at runtime (once Docker + pg_net runtime is back up):
 *   1. The service-role client INSERTs a public.match_results row for a match
 *      whose status is already 'finished' AND whose for-scoring columns are
 *      populated. (We use a slice-005 fixture match that has its existing
 *      match_results row DELETEd in the test prologue, so the INSERT is the
 *      writer event that the trigger observes — distinct from the slice-005
 *      fixture's seeded match_results row.)
 *   2. The 0059 match_finished_trigger fires AFTER INSERT, observes the
 *      finished status + populated for-scoring columns, and calls
 *      public.invoke_score_trigger('match', NEW.match_id).
 *   3. invoke_score_trigger reads app.score_trigger_url + app.score_trigger_secret
 *      from the session GUCs and issues a net.http_post(...) carrying the
 *      X-Internal-Auth header.
 *   4. The score-trigger Edge Function (T015) admits the call via its
 *      internal-auth bypass and calls public.score_match(target_id, run_id).
 *   5. score_match (slot 0052) writes one score_records row per active
 *      eligible participant for this match AND inserts a score_calculation_runs
 *      row with trigger='match_finish'.
 *
 * The test polls public.score_calculation_runs (filtered by scope='match',
 * target_id=<match>, trigger='match_finish') for up to ~5 seconds. The
 * polling is bounded because pg_net is asynchronous; the typical end-to-end
 * latency on a local Supabase stack is well under 1 second.
 *
 * Cleanup: deletes any score_records + score_calculation_runs rows produced
 *   during the test, and re-INSERTs the slice-005 fixture's original
 *   match_results row so a subsequent test run is not surprised by missing
 *   data. audit_log rows are LEFT in place (append-only contract from slice 007).
 *
 * Skip policy (RUN_EDGE_FN_TESTS=1 + SUPABASE_URL + service-role + internal
 *   secret). Without all four the test self-skips. The Docker daemon is down
 *   at the time T042 lands (per the slice's known environment state), so this
 *   test ships RED and is expected to GREEN once the runtime is back up. T041
 *   (CI bring-up) will exercise it.
 *
 * D-T042-A: This test does NOT POST to the Edge Function directly — it
 *   exercises the FULL auto-path (writer -> trigger -> pg_net -> Edge Fn ->
 *   SP). That distinguishes it from single_match_auto_trigger.test.ts (T015)
 *   which short-circuits the trigger by POSTing directly.
 *
 * Constitution alignment:
 *   - III (orchestration only — the rules live in the SP).
 *   - V (every run row is audited via the AFTER INSERT trigger on score_records).
 *   - VII (idempotent on run_id; advisory lock in the Edge Fn coalesces races).
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
// Original fixture seeds match_results for M1 with home=2, away=1, status='regulation'.
const M1 = "eeee0050-0000-0000-0000-000000000001";

// Bounded polling: pg_net is async. 5 s upper bound is well above the
// expected sub-second end-to-end latency on a local Supabase stack.
const POLL_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Poll score_calculation_runs for a row with the auto-path signature
 * (scope='match', target_id=match_id, trigger='match_finish', status='succeeded').
 * The auto-path uses a server-generated run_id that the test cannot know
 * up-front — we filter on the other columns instead.
 */
async function pollForAutoRun(
  supabase: SupabaseClient,
  matchId: string,
  sinceIso: string,
): Promise<{ id: string; affected_record_count: number | null } | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("score_calculation_runs")
      .select("id, status, trigger, affected_record_count, started_at")
      .eq("scope", "match")
      .eq("target_id", matchId)
      .eq("trigger", "match_finish")
      .eq("status", "succeeded")
      .gte("started_at", sinceIso)
      .order("started_at", { ascending: false })
      .limit(1);

    if (error) {
      throw new Error(`score_calculation_runs poll failed: ${error.message}`);
    }
    if (data && data.length > 0) {
      return {
        id: data[0].id as string,
        affected_record_count: data[0].affected_record_count as number | null,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Snapshot the slice-005 fixture's match_results row for M1 so the test can
 * delete it (to provoke the INSERT path) and restore it on cleanup.
 */
async function snapshotAndDeleteMatchResults(
  supabase: SupabaseClient,
  matchId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("match_results")
    .select("*")
    .eq("match_id", matchId)
    .maybeSingle();
  if (error) throw new Error(`match_results snapshot failed: ${error.message}`);
  if (data) {
    const { error: delErr } = await supabase
      .from("match_results")
      .delete()
      .eq("match_id", matchId);
    if (delErr) throw new Error(`match_results delete failed: ${delErr.message}`);
  }
  return data as Record<string, unknown> | null;
}

async function restoreMatchResults(
  supabase: SupabaseClient,
  snapshot: Record<string, unknown> | null,
): Promise<void> {
  if (!snapshot) return;
  // delete-if-exists first (the auto-run path will have re-INSERTed a row),
  // then restore the snapshot to preserve fixture state across test runs.
  await supabase.from("match_results").delete().eq("match_id", snapshot.match_id as string);
  const { error } = await supabase.from("match_results").insert(snapshot);
  if (error) {
    // Non-fatal in cleanup — log and continue.
    console.warn(`match_results restore failed (cleanup): ${error.message}`);
  }
}

// ============================================================================
// Test
// ============================================================================

Deno.test({
  name:
    "auto_trigger_match_finish: INSERT match_results -> DB trigger -> pg_net -> Edge Fn writes score_records with trigger='match_finish'",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // Capture a "before" wall-clock so the poll filter ignores any pre-
    // existing match_finish runs from earlier slice-005 tests.
    const sinceIso = new Date(Date.now() - 1000).toISOString();

    // Pre-clean any stale auto-runs for M1 from this same test (defensive —
    // ordinarily there are none; this handles a crashed prior invocation).
    const { data: stale } = await supabase
      .from("score_calculation_runs")
      .select("id")
      .eq("scope", "match")
      .eq("target_id", M1)
      .eq("trigger", "match_finish")
      .gte("started_at", sinceIso);
    if (stale && stale.length > 0) {
      for (const row of stale) {
        await supabase.from("score_records").delete().eq("run_id", (row as { id: string }).id);
        await supabase.from("score_calculation_runs").delete().eq("id", (row as { id: string }).id);
      }
    }

    // Snapshot + delete the fixture's M1 match_results row so the upcoming
    // INSERT is the writer event the 0059 trigger observes.
    const snapshot = await snapshotAndDeleteMatchResults(supabase, M1);

    let autoRunId: string | null = null;
    try {
      // INSERT a fresh match_results row for M1. The 0059 match_finished_trigger
      // observes the INSERT, confirms the parent match.status='finished', and
      // calls invoke_score_trigger('match', M1) -> net.http_post(...) ->
      // Edge Fn -> score_match(M1, new_run_id).
      const { error: insErr } = await supabase.from("match_results").insert({
        match_id: M1,
        home_score: 2,
        away_score: 1,
        extra_time_home_score: null,
        extra_time_away_score: null,
        penalty_home_score: null,
        penalty_away_score: null,
        home_score_for_scoring: 2,
        away_score_for_scoring: 1,
        result_status: "regulation",
        recorded_at: new Date().toISOString(),
        recorded_by: null,
        source: "provider_sync",
      });
      assertEquals(
        insErr,
        null,
        `match_results INSERT must succeed (got: ${insErr?.message ?? "ok"})`,
      );

      // Poll for the score_calculation_runs row produced by the auto path.
      const autoRun = await pollForAutoRun(supabase, M1, sinceIso);
      assert(
        autoRun !== null,
        `expected a score_calculation_runs row with scope='match', target_id=${M1}, trigger='match_finish', status='succeeded' within ${POLL_TIMEOUT_MS} ms — pg_net + Edge Fn auto-path did not complete`,
      );
      autoRunId = autoRun!.id;

      // The slice-005 fixture seeds 6 active eligible participants — every
      // score_match call for one finished match must write 6 rows (one per
      // participant, per §7.2 truth table).
      assertEquals(
        autoRun!.affected_record_count,
        6,
        "auto-triggered score_match must write exactly 6 score_records rows for M1 (one per active eligible participant per slice-005 fixture)",
      );

      // Cross-check via service-role: the 6 score_records rows exist under
      // the auto-generated run_id.
      const { data: rows, error: rowsErr } = await supabase
        .from("score_records")
        .select("participant_id, target_id, points, reason_code")
        .eq("run_id", autoRunId)
        .eq("target_id", M1);
      if (rowsErr) {
        throw new Error(`score_records SELECT failed: ${rowsErr.message}`);
      }
      assertEquals(
        rows?.length,
        6,
        `exactly 6 score_records rows must exist for (run_id=${autoRunId}, target_id=${M1})`,
      );
    } finally {
      // Cleanup: delete the auto-generated score_records + run row, then
      // restore the fixture's original match_results row so the next test
      // run sees a consistent fixture state.
      if (autoRunId) {
        await supabase.from("score_records").delete().eq("run_id", autoRunId);
        await supabase.from("score_calculation_runs").delete().eq("id", autoRunId);
      }
      await restoreMatchResults(supabase, snapshot);
    }
  },
});
