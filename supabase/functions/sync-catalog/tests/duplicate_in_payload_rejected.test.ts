/**
 * Slice 002 / T034 — Duplicate-in-payload rejection test (RED).
 *
 * Contract:
 *   - specs/002-match-catalog/spec.md § Clarifications 2026-05-15 Q2 (structural=abort)
 *     "in-payload duplicate identifiers — abort the whole sync run, leave
 *      the catalog untouched, and emit the administrator alert."
 *   - specs/002-match-catalog/spec.md § Edge Cases:
 *     "Provider returns a duplicate match identifier in the same payload →
 *      the sync MUST treat it as an error, NOT pick one arbitrarily, and
 *      MUST alert administrators."
 *   - specs/002-match-catalog/research.md § R-004 (payload sanity) Rule 3:
 *     "If a single payload contains two rows with the same
 *      `(provider_name, provider_match_id)`: abort with
 *      `outcome='rejected_duplicate_in_payload'`, fire alert."
 *   - specs/002-match-catalog/contracts/sync-runner.scheduled.md
 *       § Response 422:
 *         body shape `{ run_id, outcome: 'rejected_duplicate_in_payload',
 *           error: { code: 'PROVIDER_PAYLOAD_INVALID', message: '...' },
 *           attempts }`.
 *       § Outcome enum row `rejected_duplicate_in_payload`: "R-005
 *         in-payload duplicate guard tripped. Coordinator action: No
 *         mutation; alert fires."
 *       § Test surface row `duplicate_in_payload_rejected.test.ts`:
 *         "Stub returns 2 rows with same `providerMatchId`; assert 422 +
 *          outcome `rejected_duplicate_in_payload`."
 *
 * What this test proves:
 *   When the stub adapter's fixture file is mutated so that two of its
 *   eight elements share the same `id` (the stub's provider_match_id),
 *   while the `matches` table already holds the seed's 8 rows:
 *     (a) the Edge Function responds HTTP 422 with
 *         `outcome='rejected_duplicate_in_payload'` and an error envelope,
 *     (b) the `matches` table is NOT mutated (count stays at 8 — neither
 *         the duplicate winner nor the legitimate other 7 are applied,
 *         because the spec says structural=abort the WHOLE run, not
 *         partial-apply),
 *     (c) exactly one `audit_log` row with
 *         `action='provider.sync_rejected_duplicate'` is written for this
 *         run (per tasks.md T034 agent-prompt step 3).
 *
 * RED-first state (Constitution IX):
 *   The Edge Function's happy-path-only T032 implementation does NOT yet
 *   ship the R-004/R-005 payload-sanity guard. T039 will add it. Until
 *   then, this test MUST fail.
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
    "duplicate_in_payload_rejected: stub fixture mutated so two rows share the same `id` → 422 + outcome='rejected_duplicate_in_payload', `matches` unchanged, audit row provider.sync_rejected_duplicate written",
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
      "pre-state must have the seed's 8 matches",
    );

    const runId = crypto.randomUUID();

    try {
      // --- Mutate the fixture so two rows share the same `id`. -----------
      // We keep all 8 rows so the undersized-guard does NOT trip first —
      // the duplicate guard is the only one we want to exercise here.
      // We collide stub-match-2's `id` with stub-match-1's `id` (= "stub-
      // match-1"). The teams + kickoff differ between rows 1 and 2, so the
      // duplicate is unambiguous: same provider_match_id, different
      // payload — exactly the R-005 "in-payload duplicate" case.
      const fullPayload = JSON.parse(originalFixture);
      assert(
        Array.isArray(fullPayload) && fullPayload.length === 8,
        `original fixture must be an 8-element array; got ${Array.isArray(fullPayload) ? fullPayload.length : typeof fullPayload}`,
      );
      const duplicatePayload = fullPayload.map((row: { id: string }, idx: number) =>
        idx === 1 ? { ...row, id: fullPayload[0].id } : row
      );

      // Sanity: there must now be exactly two rows with the same `id`.
      const idCounts = new Map<string, number>();
      for (const row of duplicatePayload) {
        idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
      }
      assertEquals(
        idCounts.get(fullPayload[0].id),
        2,
        "test setup: the mutated fixture must contain exactly two rows with the duplicated id",
      );

      await Deno.writeTextFile(
        FIXTURE_URL,
        JSON.stringify(duplicatePayload, null, 2),
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

      // --- Assert: 422 + outcome='rejected_duplicate_in_payload'. --------
      assertEquals(
        response.status,
        422,
        "in-payload duplicate must be rejected with HTTP 422 per contract § Response 422",
      );

      const body = await response.json();

      assertEquals(
        body?.run_id,
        runId,
        "422 body must echo the request run_id",
      );
      assertEquals(
        body?.outcome,
        "rejected_duplicate_in_payload",
        "422 body must carry outcome='rejected_duplicate_in_payload' per contract § Outcome enum (R-004 rule 3 / R-005 in-payload duplicate)",
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
      // Spec Clarifications Q2 is explicit: structural anomalies abort the
      // WHOLE run. The other 7 legitimate rows must NOT be partial-applied.
      const { count: afterMatches, error: afterErr } = await supabase
        .from("matches")
        .select("*", { count: "exact", head: true });
      if (afterErr) {
        throw new Error(`post-state matches count failed: ${afterErr.message}`);
      }
      assertEquals(
        afterMatches,
        8,
        "matches table must be untouched after a duplicate-in-payload rejection — structural anomalies abort the whole run (spec Clarifications Q2)",
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
        "rejected_duplicate_in_payload",
        "provider_sync_runs.outcome must record 'rejected_duplicate_in_payload'",
      );

      // --- Assert: exactly one audit_log row for this rejection. ---------
      const { data: auditRows, error: auditErr } = await supabase
        .from("audit_log")
        .select("id, action, entity_id")
        .eq("entity_id", runId)
        .eq("action", "provider.sync_rejected_duplicate");
      if (auditErr) {
        throw new Error(`audit_log lookup failed: ${auditErr.message}`);
      }
      assert(
        Array.isArray(auditRows) && auditRows.length === 1,
        `exactly one audit_log row with action='provider.sync_rejected_duplicate' must exist for this run_id, got ${auditRows?.length ?? 0}`,
      );
    } finally {
      // ALWAYS restore the original fixture, even on assertion failure.
      await Deno.writeTextFile(FIXTURE_URL, originalFixture);
    }
  },
});
