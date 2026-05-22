/**
 * Slice 005 / T042 — auto_trigger_award_confirm.test.ts (RED, runtime-deferred).
 *
 * Contract: contracts/scoring-trigger.edge-fn.md § Invocation (auto path —
 *           DB trigger on tournament_award -> pg_net -> Edge Function).
 * Research: research.md § R-011 path 2 (auto-recalc on award confirm).
 * Migration: supabase/migrations/0059_score_auto_trigger.sql.
 *
 * What this test proves at runtime (once Docker + pg_net runtime is back up):
 *   1. The service-role client UPDATEs public.tournament_award to flip
 *      best_player_status from 'pending' to 'confirmed' (slice-005 fixture
 *      seeds best_player_status='pending' with best_player_player_id=NULL,
 *      so we also set best_player_player_id to the slice-005 Pedri player id
 *      to satisfy the slot 0051 CHECK constraint).
 *   2. The 0059 award_confirmed_trigger fires AFTER UPDATE, observes the
 *      *_status change, and calls public.invoke_score_trigger('finals', NULL).
 *   3. invoke_score_trigger reads app.score_trigger_url + app.score_trigger_secret
 *      from the session GUCs and issues net.http_post(...) carrying the
 *      X-Internal-Auth header.
 *   4. The score-trigger Edge Function (T020) admits the call via its
 *      internal-auth bypass and calls public.score_finals(run_id).
 *   5. score_finals (slot 0053) writes one score_records row per active
 *      final_predictions row (12 rows per the slice-005 fixture: 6 from
 *      slice-004 + 6 added by slice-005) AND inserts a score_calculation_runs
 *      row with trigger='award_confirmed'.
 *
 * The test polls public.score_calculation_runs (filtered by scope='finals',
 * trigger='award_confirmed') for up to ~5 seconds. The polling is bounded
 * because pg_net is asynchronous; the typical end-to-end latency on a local
 * Supabase stack is well under 1 second.
 *
 * Cleanup: deletes any score_records + score_calculation_runs rows produced
 *   during the test, AND restores the tournament_award row to its original
 *   slice-005 fixture state (best_player_status='pending',
 *   best_player_player_id=NULL). audit_log rows are LEFT in place
 *   (append-only contract from slice 007).
 *
 * Skip policy (RUN_EDGE_FN_TESTS=1 + SUPABASE_URL + service-role + internal
 *   secret). Without all four the test self-skips. The Docker daemon is down
 *   at the time T042 lands; this test ships RED and is expected to GREEN once
 *   the runtime is back up. T041 (CI bring-up) will exercise it.
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

// The single 2026 World Cup tournament uuid (slice-005 fixture convention).
const TOURNAMENT_ID = "00000000-0000-0000-0000-000000000001";

// Pedri's player id (slice-005 fixture). Used to satisfy slot 0051's
// best_player_confirmed_requires_id CHECK when we flip best_player_status to
// 'confirmed' in this test.
const PEDRI = "dddd1000-0000-0000-0000-000000000009";

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
 * (scope='finals', trigger='award_confirmed', status='succeeded'). The auto-
 * path uses a server-generated run_id that the test cannot know up-front —
 * we filter on the other columns instead.
 */
async function pollForAutoRun(
  supabase: SupabaseClient,
  sinceIso: string,
): Promise<{ id: string; affected_record_count: number | null } | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("score_calculation_runs")
      .select("id, status, trigger, affected_record_count, started_at")
      .eq("scope", "finals")
      .eq("trigger", "award_confirmed")
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
 * Snapshot the slice-005 fixture's tournament_award row so the test can
 * mutate it and restore it on cleanup.
 */
async function snapshotAward(
  supabase: SupabaseClient,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("tournament_award")
    .select("*")
    .eq("tournament_id", TOURNAMENT_ID)
    .maybeSingle();
  if (error) throw new Error(`tournament_award snapshot failed: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function restoreAward(
  supabase: SupabaseClient,
  snapshot: Record<string, unknown> | null,
): Promise<void> {
  if (!snapshot) return;
  // Mirror the fixture's state. We use UPDATE because the row's PK
  // (tournament_id) hasn't changed; the only mutated fields are best_player_*.
  const { error } = await supabase
    .from("tournament_award")
    .update({
      best_player_player_id: snapshot.best_player_player_id ?? null,
      best_player_status: snapshot.best_player_status ?? "pending",
      set_at: snapshot.set_at,
      set_by: snapshot.set_by ?? null,
    })
    .eq("tournament_id", TOURNAMENT_ID);
  if (error) {
    console.warn(`tournament_award restore failed (cleanup): ${error.message}`);
  }
}

// ============================================================================
// Test
// ============================================================================

Deno.test({
  name:
    "auto_trigger_award_confirm: UPDATE tournament_award (best_player pending->confirmed) -> DB trigger -> pg_net -> Edge Fn writes score_records with trigger='award_confirmed'",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // Capture a "before" wall-clock so the poll filter ignores any pre-
    // existing award_confirmed runs from earlier slice-005 tests.
    const sinceIso = new Date(Date.now() - 1000).toISOString();

    // Pre-clean any stale auto-runs since the cut-off (defensive — ordinarily
    // there are none; this handles a crashed prior invocation).
    const { data: stale } = await supabase
      .from("score_calculation_runs")
      .select("id")
      .eq("scope", "finals")
      .eq("trigger", "award_confirmed")
      .gte("started_at", sinceIso);
    if (stale && stale.length > 0) {
      for (const row of stale) {
        await supabase.from("score_records").delete().eq("run_id", (row as { id: string }).id);
        await supabase.from("score_calculation_runs").delete().eq("id", (row as { id: string }).id);
      }
    }

    // Snapshot the fixture's tournament_award row so we can restore it.
    const snapshot = await snapshotAward(supabase);
    assert(
      snapshot !== null,
      `slice-005 fixture must have seeded a tournament_award row for tournament_id=${TOURNAMENT_ID}`,
    );

    let autoRunId: string | null = null;
    try {
      // Flip best_player_status from 'pending' to 'confirmed' and set the
      // player id (slot 0051 CHECK requires *_id NOT NULL when *_status='confirmed').
      // This is the writer event the 0059 award_confirmed_trigger observes.
      const { error: updErr } = await supabase
        .from("tournament_award")
        .update({
          best_player_player_id: PEDRI,
          best_player_status: "confirmed",
        })
        .eq("tournament_id", TOURNAMENT_ID);
      assertEquals(
        updErr,
        null,
        `tournament_award UPDATE must succeed (got: ${updErr?.message ?? "ok"})`,
      );

      // Poll for the score_calculation_runs row produced by the auto path.
      const autoRun = await pollForAutoRun(supabase, sinceIso);
      assert(
        autoRun !== null,
        `expected a score_calculation_runs row with scope='finals', trigger='award_confirmed', status='succeeded' within ${POLL_TIMEOUT_MS} ms — pg_net + Edge Fn auto-path did not complete`,
      );
      autoRunId = autoRun!.id;

      // The slice-004 fixture seeds 6 active final_predictions rows and the
      // slice-005 fixture adds 6 more on distinct (participant, item_kind)
      // slots — score_finals must emit one score_records row per active row = 12.
      assertEquals(
        autoRun!.affected_record_count,
        12,
        "auto-triggered score_finals must write exactly 12 score_records rows (one per active final_predictions row per slice-004+slice-005 fixtures)",
      );

      // Cross-check via service-role: 12 final-kind score_records rows exist
      // under the auto-generated run_id.
      const { data: rows, error: rowsErr } = await supabase
        .from("score_records")
        .select("participant_id, target_kind, final_item_kind, points, reason_code")
        .eq("run_id", autoRunId)
        .eq("target_kind", "final");
      if (rowsErr) {
        throw new Error(`score_records SELECT failed: ${rowsErr.message}`);
      }
      assertEquals(
        rows?.length,
        12,
        `exactly 12 score_records rows must exist for (run_id=${autoRunId}, target_kind='final')`,
      );
    } finally {
      // Cleanup: delete the auto-generated rows, then restore the fixture's
      // original tournament_award state so the next test run sees a
      // consistent fixture.
      if (autoRunId) {
        await supabase.from("score_records").delete().eq("run_id", autoRunId);
        await supabase.from("score_calculation_runs").delete().eq("id", autoRunId);
      }
      await restoreAward(supabase, snapshot);
    }
  },
});
