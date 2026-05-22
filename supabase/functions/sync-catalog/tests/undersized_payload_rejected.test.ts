/**
 * Slice 002 / T034 — Undersized-payload rejection test (RED).
 *
 * Contract:
 *   - specs/002-match-catalog/spec.md § Clarifications 2026-05-15 Q2 (structural=abort)
 *     "undersized payload (configurable threshold; default `< 50%` of last
 *      known catalog count for the same window) ... abort the whole sync
 *      run, leave the catalog untouched, and emit the administrator alert."
 *   - specs/002-match-catalog/research.md § R-004 (payload sanity) Rule 2:
 *     "If `fetchFixtures()` returns a count `< 50%` of the catalog's
 *      existing count for that window: abort the run with
 *      `outcome='rejected_undersized'`, fire alert. The 50% threshold is
 *      configurable via `tournament_config.provider_sync.undersized_threshold`
 *      (default `0.5`)."
 *   - specs/002-match-catalog/contracts/sync-runner.scheduled.md
 *       § Response 422 (rejection per R-004 / R-005):
 *         body shape `{ run_id, outcome: 'rejected_undersized', error: {
 *           code: 'PROVIDER_PAYLOAD_INVALID', message: '...' }, attempts }`.
 *       § Outcome enum row `rejected_undersized`: "R-004 undersized-payload
 *         guard tripped. Coordinator action: No mutation; alert fires."
 *       § Test surface row `undersized_payload_rejected.test.ts`:
 *         "Pre-seed 100 matches; stub returns 30 (< 50%); assert 422 +
 *          outcome `rejected_undersized`."
 *
 *   Note on test sizing: the contract's example references 100/30 against a
 *   notional full World Cup catalog. The slice-002 seed installs 8 matches
 *   (the stub-adapter fixture set). Three matches against eight is
 *   3 / 8 = 37.5% — well below the 50% default threshold and therefore
 *   exercises the same guard. We deliberately mutate to 3 (not 4 — which is
 *   exactly 50% and would land on the boundary depending on whether the
 *   guard uses `<` or `<=`) to keep the test stable regardless of which
 *   strict inequality the implementation chooses.
 *
 * What this test proves:
 *   When the stub adapter's fixture file is mutated to a 3-element subset
 *   while `matches` already holds the seed's 8 rows:
 *     (a) the Edge Function responds HTTP 422 with
 *         `outcome='rejected_undersized'` and an error envelope,
 *     (b) the `matches` table is NOT mutated (count stays at 8),
 *     (c) exactly one `audit_log` row with
 *         `action='provider.sync_rejected_undersized'` is written for
 *         this run (per tasks.md T034 agent-prompt step 2 and the
 *         Outcome enum's "alert fires" requirement).
 *
 * RED-first state (Constitution IX):
 *   The Edge Function's happy-path-only T032 implementation does NOT yet
 *   ship the R-004 payload-sanity guard. T039 will add it. Until then,
 *   this test MUST fail.
 *
 * Skip policy / fixture-mutation pattern / trigger value:
 *   See `empty_payload_rejected.test.ts` for the full rationale. Same
 *   `RUN_SYNC_CATALOG_TESTS=1` gate. Same `try/finally` write+restore.
 *   Same `trigger='manual_internal'` (D-006).
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

const FIXTURE_URL = new URL(
  "../../_shared/providers/stub/fixtures/wc2026-snapshot.json",
  import.meta.url,
);

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
    "undersized_payload_rejected: stub fixture mutated to 3/8 (37.5%, < 50% threshold) → 422 + outcome='rejected_undersized', `matches` unchanged, audit row provider.sync_rejected_undersized written",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    const originalFixture = await Deno.readTextFile(FIXTURE_URL);

    // Pre-state: 8 matches from the seed.
    const { count: beforeMatches, error: beforeErr } = await supabase
      .from("matches")
      .select("*", { count: "exact", head: true });
    if (beforeErr) {
      throw new Error(`pre-state matches count failed: ${beforeErr.message}`);
    }
    assertEquals(
      beforeMatches,
      8,
      "pre-state must have the seed's 8 matches; the 50% threshold guard is computed against the existing catalog count",
    );

    const runId = crypto.randomUUID();

    try {
      // --- Mutate the fixture to the first 3 of 8 matches. ---------------
      // 3 / 8 = 37.5% < 50% threshold → guard MUST trip.
      // We parse, slice, re-stringify to guarantee a syntactically-valid
      // JSON array (the empty-payload test uses the trivial `[]` literal;
      // here we need the items to remain well-formed in case the guard
      // schema-checks before counting).
      const fullPayload = JSON.parse(originalFixture);
      assert(
        Array.isArray(fullPayload) && fullPayload.length === 8,
        `original fixture must be an 8-element array; got ${Array.isArray(fullPayload) ? fullPayload.length : typeof fullPayload}`,
      );
      const undersizedPayload = fullPayload.slice(0, 3);
      await Deno.writeTextFile(
        FIXTURE_URL,
        JSON.stringify(undersizedPayload, null, 2),
      );

      // --- Trigger the coordinator. --------------------------------------
      const response = await fetch(SYNC_FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth": SYNC_TRIGGER_SECRET,
        },
        body: JSON.stringify({
          provider: PROVIDER,
          trigger: "manual_internal",
          run_id: runId,
        }),
      });

      // --- Assert: 422 + outcome='rejected_undersized' + error envelope. -
      assertEquals(
        response.status,
        422,
        "undersized payload (3/8 = 37.5%, < 50% default threshold) must be rejected with HTTP 422 per contract § Response 422",
      );

      const body = await response.json();

      assertEquals(
        body?.run_id,
        runId,
        "422 body must echo the request run_id",
      );
      assertEquals(
        body?.outcome,
        "rejected_undersized",
        "422 body must carry outcome='rejected_undersized' per contract § Outcome enum (R-004 rule 2)",
      );
      assertEquals(
        body?.error?.code,
        "PROVIDER_PAYLOAD_INVALID",
        "422 body must carry error.code='PROVIDER_PAYLOAD_INVALID'",
      );
      assertEquals(
        typeof body?.error?.message,
        "string",
        "422 body must include a human-readable error.message",
      );

      // --- Assert: `matches` row count unchanged. ------------------------
      const { count: afterMatches, error: afterErr } = await supabase
        .from("matches")
        .select("*", { count: "exact", head: true });
      if (afterErr) {
        throw new Error(`post-state matches count failed: ${afterErr.message}`);
      }
      assertEquals(
        afterMatches,
        8,
        "matches table must be untouched after an undersized-payload rejection — the rejection's whole point is to preserve last-known-good data",
      );

      // --- Assert: ledger row written with the rejection outcome. --------
      const { data: runRow, error: runErr } = await supabase
        .from("provider_sync_runs")
        .select("id, provider_name, outcome")
        .eq("id", runId)
        .single();
      if (runErr) {
        throw new Error(`provider_sync_runs lookup failed: ${runErr.message}`);
      }
      assert(
        runRow,
        "a provider_sync_runs row must exist for the rejected run_id",
      );
      assertEquals(
        runRow.outcome,
        "rejected_undersized",
        "provider_sync_runs.outcome must record 'rejected_undersized'",
      );

      // --- Assert: exactly one audit_log row for this rejection. ---------
      const { data: auditRows, error: auditErr } = await supabase
        .from("audit_log")
        .select("id, action, entity_id")
        .eq("entity_id", runId)
        .eq("action", "provider.sync_rejected_undersized");
      if (auditErr) {
        throw new Error(`audit_log lookup failed: ${auditErr.message}`);
      }
      assert(
        Array.isArray(auditRows) && auditRows.length === 1,
        `exactly one audit_log row with action='provider.sync_rejected_undersized' must exist for this run_id, got ${auditRows?.length ?? 0}`,
      );
    } finally {
      // ALWAYS restore the original fixture, even on assertion failure.
      await Deno.writeTextFile(FIXTURE_URL, originalFixture);
    }
  },
});
