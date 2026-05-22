/**
 * Slice 002 / T025 — Provider swap test (SC-005 invariant).
 *
 * Spec: specs/002-match-catalog/spec.md § SC-005
 * Contracts:
 *   - specs/002-match-catalog/contracts/sync-runner.scheduled.md § Test surface
 *     (the `provider_swap_test.ts` row)
 *   - specs/002-match-catalog/contracts/provider-adapter.contract.md § Why each
 *     design choice
 *
 * What this test proves:
 *   Swapping `tournament_config` row `('providers.active', '"stub2"'::jsonb)`
 *   from the canonical stub to a deliberately-different-internal-style stub2
 *   adapter (same contract output) produces BYTE-IDENTICAL catalog rows in
 *   `public.matches`. The SC-005 "no code change outside the adapter
 *   directory" half of the invariant is enforced by the fact that THIS test
 *   only needs:
 *     (a) the stub2 module's default export to land in the coordinator's
 *         static adapter registry (single-line change inside `sync-catalog`
 *         on T032 — which itself ships the registry; no further changes
 *         are needed to ADD stub2 there once the registry pattern exists
 *         per contracts/sync-runner.scheduled.md § "Implementation notes"
 *         bullet "The Edge Function imports MatchDataProviderAdapter from
 *         _shared/providers/types.ts and resolves the concrete adapter via
 *         a static map keyed by provider_name — no dynamic require, no
 *         eval."), and
 *     (b) the stub2 fixture to ship the same normalized output as the stub
 *         fixture.
 *   If any future contributor changes the sync coordinator to handle stub2
 *   specially, OR if anyone modifies stub2's normalization to drift from
 *   stub's, the hash equality below FAILS — that is the regression gate.
 *
 * RED-first state (current, per Constitution Principle IX):
 *   This test is authored before:
 *     - T030 (the canonical stub adapter + its fixture JSON)
 *     - T032 (the sync-catalog Edge Function with the adapter registry)
 *     - T033 (the swap wiring: stub2 added to the static adapter registry)
 *   It will GREEN once all three ship AND the stub2 fixture's normalized
 *   output equals the stub fixture's normalized output. The stub2 fixture
 *   (see `../../_shared/providers/stub2/fixtures/wc2026-snapshot.json`)
 *   is authored to produce the SAME 8 group-stage matches that the stub
 *   fixture will encode (same team short codes, same kickoff UTC values,
 *   same stage/group/venue/status). The provider-specific
 *   `providerMatchId` strings differ ('stub-*' vs 'stub2-*') by design —
 *   that field lives in `match_provider_external_ids`, not `matches`, so
 *   it does NOT participate in the matches-row hash.
 *
 * Skip policy: this test requires a running Supabase instance and a
 * service-role JWT. When `SUPABASE_SERVICE_ROLE_KEY` (or the URL) is
 * absent, the test self-skips so it doesn't block `deno test` in CI
 * environments that don't provision a database (RED-during-development).
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ============================================================================
// Environment + harness
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SYNC_TRIGGER_SECRET = Deno.env.get("SYNC_TRIGGER_SECRET") ?? "";
const SYNC_FUNCTION_URL = Deno.env.get("SYNC_FUNCTION_URL")
  ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/sync-catalog` : "");

const HARNESS_READY = Boolean(
  SUPABASE_URL && SERVICE_ROLE_KEY && SYNC_TRIGGER_SECRET,
);

function createServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Flip `tournament_config.providers.active` to the named provider.
 * Uses jsonb literal shape: `to_jsonb('<name>'::text)` semantics via
 * client-side JSON encoding (`JSON.stringify(name)` → '"name"').
 */
async function setActiveProvider(
  supabase: SupabaseClient,
  providerName: "stub" | "stub2",
): Promise<void> {
  const { error } = await supabase
    .from("tournament_config")
    .update({ value: providerName, updated_at: new Date().toISOString() })
    .eq("key", "providers.active");
  if (error) {
    throw new Error(
      `setActiveProvider('${providerName}') failed: ${error.message}`,
    );
  }
}

/**
 * POST to the sync-catalog Edge Function and poll `provider_sync_runs`
 * until a row with `outcome === expectedOutcome` for the given provider
 * appears (or timeout).
 */
async function runSyncAndAwaitOutcome(
  supabase: SupabaseClient,
  providerName: "stub" | "stub2",
  expectedOutcome: "success",
): Promise<void> {
  const runId = crypto.randomUUID();
  const response = await fetch(SYNC_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Auth": SYNC_TRIGGER_SECRET,
    },
    body: JSON.stringify({ run_id: runId, trigger: "swap-test" }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `sync-catalog POST failed for provider '${providerName}': `
        + `${response.status} ${body}`,
    );
  }

  // Poll for the run record to confirm outcome. The Edge Function may
  // run async behind the advisory lock; the contract guarantees the
  // run row is written before the function returns 200, so a single
  // read should suffice — but we tolerate eventual consistency with a
  // bounded retry loop.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("provider_sync_runs")
      .select("outcome")
      .eq("run_id", runId)
      .maybeSingle();
    if (error && error.code !== "PGRST116") {
      throw new Error(`provider_sync_runs read failed: ${error.message}`);
    }
    if (data?.outcome === expectedOutcome) return;
    if (data?.outcome && data.outcome !== expectedOutcome) {
      throw new Error(
        `sync outcome for provider '${providerName}' was `
          + `'${data.outcome}', expected '${expectedOutcome}'`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timeout waiting for sync run ${runId} (provider '${providerName}') `
      + `to reach outcome '${expectedOutcome}'`,
  );
}

/**
 * Compute a stable SHA-256 over the contract-locked columns of
 * `public.matches`. The selected columns are exactly the cross-slice
 * surface (NormalizedFixture mapped through the coordinator's UPSERT):
 *   id, home_team_id, away_team_id, stage, group_id, kickoff_utc, venue, status
 *
 * The hash is computed off of:
 *   1. rows ordered by `id ASC` for determinism
 *   2. canonical JSON serialization where each object's keys are sorted
 *      alphabetically — `JSON.stringify(value, replacer)` does NOT sort
 *      keys by default, so we walk the structure and rebuild it.
 *
 * NOTE: `id` is a UUID generated by Postgres on first INSERT (slice 002's
 * `0020_matches.sql` defines `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`).
 * Both phases of the swap UPSERT against the SAME `match_provider_external_ids`
 * mapping (because the coordinator looks up by `(provider_name,
 * provider_match_id)`)... but the providers differ. The coordinator's
 * idempotency key being `(provider_name, provider_match_id)` means stub2's
 * insert path creates SEPARATE external_id rows pointing at the same
 * `matches.id`s, by matching on the natural key (homeTeam shortCode +
 * awayTeam shortCode + kickoffUtc). Per the data-model the natural key
 * lookup is what makes the swap test work — without it, stub2's UPSERT
 * would create 8 NEW matches rows, doubling the catalog and breaking
 * SC-005. T033 wires the natural-key resolution; this test will fail
 * loudly if that wiring drifts.
 */
async function hashMatchesState(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from("matches")
    .select(
      "id, home_team_id, away_team_id, stage, group_id, kickoff_utc, venue, status",
    )
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`hashMatchesState read failed: ${error.message}`);
  }

  const rows = data ?? [];
  const canonical = canonicalJson(rows);
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Canonical JSON: arrays preserved in-order, object keys sorted
 * alphabetically. Stable across runtimes; the default `JSON.stringify`
 * is NOT stable for object key order in all engines.
 */
// deno-lint-ignore no-explicit-any
function canonicalJson(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{"
    + keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k]))
      .join(",")
    + "}"
  );
}

// ============================================================================
// Test
// ============================================================================

Deno.test({
  name: "SC-005: swapping providers produces byte-identical catalog rows",
  // Self-skip when the harness isn't ready (RED-during-development).
  // Once T030/T032/T033 ship + the harness env vars are present in CI,
  // this test runs and gates the SC-005 invariant.
  ignore: !HARNESS_READY,
  async fn() {
    const supabase = createServiceClient();

    // Phase 1 — sync against the canonical stub adapter.
    await setActiveProvider(supabase, "stub");
    await runSyncAndAwaitOutcome(supabase, "stub", "success");
    const stubState = await hashMatchesState(supabase);

    // Phase 2 — flip providers.active to stub2 and re-sync. The coordinator
    // resolves stub2 → the adapter at `_shared/providers/stub2/index.ts`,
    // which returns NormalizedFixture[] equal to stub's output. UPSERT
    // semantics (per contracts/sync-runner.scheduled.md § Upsert keys) means
    // re-running with the same data set yields the same matches rows.
    await setActiveProvider(supabase, "stub2");
    await runSyncAndAwaitOutcome(supabase, "stub2", "success");
    const stub2State = await hashMatchesState(supabase);

    // The core SC-005 assertion. If this fails, EITHER:
    //   (a) stub2's normalized fixture output drifted from stub's, OR
    //   (b) the coordinator handles stub2 differently than stub (e.g.,
    //       someone added an adapter-specific branch in sync-catalog/).
    // Either way, SC-005 ("zero code changes outside the adapter") is
    // violated and this test catches it.
    assertEquals(
      stub2State,
      stubState,
      "matches row hash differs after provider swap — "
        + "either stub2's fixture diverged from stub's or the sync "
        + "coordinator branched on provider name (SC-005 violation)",
    );

    // Restore the canonical stub for downstream tests in the suite.
    await setActiveProvider(supabase, "stub");
  },
});
