/**
 * Slice 002 / T034 — Empty-payload rejection test (RED).
 *
 * Contract:
 *   - specs/002-match-catalog/spec.md § Clarifications 2026-05-15 Q2 (structural=abort)
 *     "Payload-structural anomalies — empty replacement of populated data,
 *      undersized payload (configurable threshold; default `< 50%` of last
 *      known catalog count for the same window), in-payload duplicate
 *      identifiers — abort the whole sync run, leave the catalog
 *      untouched, and emit the administrator alert."
 *   - specs/002-match-catalog/research.md § R-004 (payload sanity)
 *     Rule 1: empty fetchFixtures() against a populated catalog →
 *     outcome='rejected_empty', no mutation, alert.
 *   - specs/002-match-catalog/contracts/sync-runner.scheduled.md
 *       § Response 422 (rejection per R-004 / R-005):
 *         body shape `{ run_id, outcome: 'rejected_empty', error: {
 *           code: 'PROVIDER_PAYLOAD_INVALID', message: '...' }, attempts }`.
 *       § Outcome enum row `rejected_empty`: "R-004 empty-payload guard
 *         tripped. Coordinator action: No mutation; alert fires."
 *       § Test surface row `empty_payload_rejected.test.ts`:
 *         "Stub adapter returns []; assert 422 + outcome `rejected_empty`;
 *          assert `matches` unchanged; assert alert emitted."
 *
 * What this test proves:
 *   When the stub adapter's fixture file is mutated to an empty array AND
 *   the `matches` table already holds rows (the slice-002 seed installs 8):
 *     (a) the Edge Function responds HTTP 422 with
 *         `outcome='rejected_empty'` and an error envelope,
 *     (b) the `matches` table is NOT mutated (count stays at 8),
 *     (c) exactly one `audit_log` row with
 *         `action='provider.sync_rejected_empty'` is written for this run
 *         (per tasks.md T034 agent-prompt step 1's audit-row assertion and
 *         the Outcome enum's "alert fires" requirement — the audit row is
 *         the canonical alert record per spec Clarifications 2026-05-15 Q3
 *         which guarantees an audit row in every alert case regardless of
 *         webhook configuration).
 *
 * RED-first state (Constitution IX):
 *   The Edge Function's happy-path-only T032 implementation does NOT yet
 *   ship the R-004 payload-sanity guard. T039 will add it. Until then,
 *   this test MUST fail. That failure is the spec gate.
 *
 * Skip policy:
 *   `RUN_SYNC_CATALOG_TESTS=1` + Supabase URL + service-role key + internal
 *   secret. Without all four the test self-skips so plain `deno test` stays
 *   green on machines lacking Docker / the Supabase CLI.
 *
 * Fixture-mutation pattern:
 *   The stub adapter (T030) reads its fixture from a JSON file on disk:
 *   `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json`.
 *   This test mutates that file IN PLACE, runs the sync, asserts the
 *   rejection, then restores the original file in a `finally` block so the
 *   repo working tree is invariant under repeated test runs. We resolve
 *   the absolute fixture path via `new URL('../../_shared/providers/stub/
 *   fixtures/wc2026-snapshot.json', import.meta.url)` so the test runs
 *   from any CWD.
 *
 * Trigger value:
 *   Per D-006 (migration 0022 CHECK on `provider_sync_runs.trigger`), the
 *   only canonical values are `'cron'`, `'manual_internal'`, and
 *   `'admin_manual'`. We use `'manual_internal'` here because this test
 *   is invoking the function ad-hoc from a Deno test harness, not from
 *   pg_cron — using the wrong value would trip the migration-0022 CHECK
 *   (D-010-flagged failure mode) and mask the actual rejection assertion.
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

// Absolute URL of the stub-adapter fixture, resolved relative to THIS test
// file. The fixture lives two directories up + over into _shared/providers/
// stub/fixtures/ — so the relative path from
// supabase/functions/sync-catalog/tests/ is
// `../../_shared/providers/stub/fixtures/wc2026-snapshot.json`.
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
    "empty_payload_rejected: stub fixture mutated to [] → 422 + outcome='rejected_empty', `matches` unchanged, audit row provider.sync_rejected_empty written",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // Snapshot the on-disk fixture so we can restore it in `finally` no
    // matter what fails below. We use the text-roundtrip form (rather than
    // parse-then-stringify) so any incidental formatting in the file is
    // preserved byte-for-byte.
    const originalFixture = await Deno.readTextFile(FIXTURE_URL);

    // Pre-state: assert the slice-002 seed has installed exactly 8 matches.
    // If this assertion fails the test DB is in an unexpected state and we
    // should NOT proceed — the rejection assertion would be uninterpretable
    // against an empty catalog.
    const { count: beforeMatches, error: beforeErr } = await supabase
      .from("matches")
      .select("*", { count: "exact", head: true });
    if (beforeErr) {
      throw new Error(`pre-state matches count failed: ${beforeErr.message}`);
    }
    assertEquals(
      beforeMatches,
      8,
      "pre-state must have the seed's 8 matches; rejection guard is only meaningful against a populated catalog",
    );

    const runId = crypto.randomUUID();

    try {
      // --- Mutate the fixture to an empty array. -------------------------
      await Deno.writeTextFile(FIXTURE_URL, "[]");

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

      // --- Assert: 422 + outcome='rejected_empty' + error envelope. ------
      assertEquals(
        response.status,
        422,
        "empty payload against a populated catalog must be rejected with HTTP 422 per contract § Response 422",
      );

      const body = await response.json();

      assertEquals(
        body?.run_id,
        runId,
        "422 body must echo the request run_id per contract § Response 422 shape",
      );
      assertEquals(
        body?.outcome,
        "rejected_empty",
        "422 body must carry outcome='rejected_empty' per contract § Outcome enum",
      );
      assertEquals(
        body?.error?.code,
        "PROVIDER_PAYLOAD_INVALID",
        "422 body must carry error.code='PROVIDER_PAYLOAD_INVALID' per contract § Response 422",
      );
      assertEquals(
        typeof body?.error?.message,
        "string",
        "422 body must include a human-readable error.message",
      );

      // --- Assert: `matches` row count unchanged. ------------------------
      // Spec Clarifications Q2 + R-004 + Outcome-enum row both require
      // "no mutation" on rejection. The catalog count is the cheapest
      // proof that no destructive UPDATE/DELETE leaked through.
      const { count: afterMatches, error: afterErr } = await supabase
        .from("matches")
        .select("*", { count: "exact", head: true });
      if (afterErr) {
        throw new Error(`post-state matches count failed: ${afterErr.message}`);
      }
      assertEquals(
        afterMatches,
        8,
        "matches table must be untouched after an empty-payload rejection (spec Clarifications 2026-05-15 Q2 + R-004)",
      );

      // --- Assert: ledger row written with the rejection outcome. --------
      // Per contract § Response 422 note: "the provider_sync_runs row is
      // still written with the rejection outcome — 422 here is the Edge
      // Function's view of 'I declined to apply this', not a
      // provider_sync_runs write failure."
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
        "rejected_empty",
        "provider_sync_runs.outcome must record 'rejected_empty' per contract",
      );

      // --- Assert: exactly one audit_log row for this rejection. ---------
      // We scope the audit query by entity_id=run_id so concurrent test
      // runs (advisory_lock_returns_409 etc.) don't pollute the count.
      // The contract Outcome-enum row says "alert fires" on rejected_*;
      // spec Clarifications Q3 guarantees the audit row is always
      // written (the webhook is optional). The action name follows the
      // pattern established for outage alerts (`provider.outage_alert_emitted`,
      // `provider.recovered`) and is fixed by tasks.md T034 agent prompt:
      // `action='provider.sync_rejected_empty'`.
      const { data: auditRows, error: auditErr } = await supabase
        .from("audit_log")
        .select("id, action, entity_id")
        .eq("entity_id", runId)
        .eq("action", "provider.sync_rejected_empty");
      if (auditErr) {
        throw new Error(`audit_log lookup failed: ${auditErr.message}`);
      }
      assert(
        Array.isArray(auditRows) && auditRows.length === 1,
        `exactly one audit_log row with action='provider.sync_rejected_empty' must exist for this run_id, got ${auditRows?.length ?? 0}`,
      );
    } finally {
      // ALWAYS restore the original fixture, even if assertions failed —
      // otherwise a single failed test would corrupt every subsequent
      // test run (including sibling tests like single_sync_happy that
      // assume the canonical 8-match fixture).
      await Deno.writeTextFile(FIXTURE_URL, originalFixture);
    }
  },
});
