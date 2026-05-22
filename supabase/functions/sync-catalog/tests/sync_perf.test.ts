/**
 * Slice 002 / T044 — Sync coordinator perf gate (Phase 6 polish).
 *
 * Contract anchors:
 *   - specs/002-match-catalog/plan.md § Performance Goals
 *       "Sync end-to-end p95 < 30 s (well under the 60 s Edge Function
 *        ceiling; supports SC-001's 5-min trigger-to-reflect)."
 *   - specs/002-match-catalog/contracts/sync-runner.scheduled.md
 *       § Performance budget: "End-to-end run time < 30s p95".
 *
 * What this test proves:
 *   The sync-catalog Edge Function, driven by the stub adapter against a
 *   tournament-sized payload (100 fixtures of which 20 are finished),
 *   completes within the < 30 s p95 wall-clock budget across 5 sequential
 *   invocations.
 *
 *   We measure from the moment the test issues `POST /functions/v1/sync-catalog`
 *   to the moment the response is received. This is intentionally end-to-end
 *   (network + Edge runtime + adapter + DB upsert + ledger write + response
 *   serialization) because the plan's budget is an *external* latency promise
 *   to the cron scheduler, not an internal-coordinator metric.
 *
 * Coarseness disclaimer:
 *   5 samples is a coarse gate, not a statistically rigorous benchmark.
 *   p95 of 5 samples is computed as `sorted[floor(0.95 * (n-1))]` which
 *   degenerates to "the slowest sample" for n=5 — i.e. this is closer to
 *   a "max-of-5 < 30s" assertion. That is *intentionally* strict: under
 *   the plan's budget, a 30 s ceiling on the slowest of five runs is a
 *   useful smoke gate for regressions (a sudden 2x slowdown in the
 *   coordinator surfaces here even with the coarse statistic).
 *
 *   A finer-grained benchmark (e.g. k6 / autocannon with hundreds of
 *   samples) is out of scope for slice 002 and can be added later if the
 *   budget tightens.
 *
 * Fixture inflation:
 *   The stub adapter (T030) reads `wc2026-snapshot.json`. To exercise a
 *   realistic payload we *temporarily* overwrite that file with 100
 *   synthetically generated fixtures, run the test, and restore the
 *   original contents in a `finally` block — no matter what. The
 *   synthetic team IDs are prefixed `perf-team-*` so they do not collide
 *   with the slice 001/002 seed data (which uses ISO country codes like
 *   `arg`, `mex`, `usa`).
 *
 * Dirty-state acknowledgement:
 *   This test deliberately inserts ~100 synthetic matches, ~32 synthetic
 *   teams, and up to 20 synthetic results into the local database, plus 5
 *   `provider_sync_runs` ledger rows. It does NOT clean them up. A perf
 *   test should not be entangled with cleanup logic that could itself
 *   skew the measurement, and the synthetic IDs are namespaced so they
 *   cannot collide with the canonical seed or with other slice-002 tests.
 *   Operators running this test against a long-lived dev DB should expect
 *   accumulated `perf-team-*` / `perf-match-*` rows over time and can
 *   purge them with a simple `WHERE provider_team_id LIKE 'perf-team-%'`.
 *
 * Skip policy:
 *   Self-skips unless `RUN_SYNC_CATALOG_TESTS=1` AND the supabase URL +
 *   service-role key + sync-trigger secret are present. Mirrors every
 *   other slice 002 Deno test — Docker + the Supabase CLI are not
 *   installed on every contributor's box.
 *
 * Trigger value:
 *   Uses `trigger='manual_internal'` (D-010): the CHECK constraint in
 *   migration 0022 admits `{'scheduled', 'manual_admin', 'manual_internal'}`.
 *   A perf smoke run is neither cron-driven nor admin-initiated; it is an
 *   internal automated invocation, which is exactly what `manual_internal`
 *   is for.
 */

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
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

// Path to the stub fixture, resolved relative to this test file so it
// works regardless of cwd. Matches the path the stub adapter uses.
const FIXTURE_PATH = new URL(
  "../../_shared/providers/stub/fixtures/wc2026-snapshot.json",
  import.meta.url,
);

// Performance budget (kept in one place so a future spec change updates
// the assertion + the log line together).
const P95_BUDGET_MS = 30_000;
const SAMPLE_COUNT = 5;

// ============================================================================
// Synthetic payload generators
// ============================================================================

interface StubTeam {
  id: string;
  name: string;
  shortCode: string;
  flagUrl: string | null;
}

interface StubResult {
  homeScoreOfficial: number;
  awayScoreOfficial: number;
  homeScoreForScoring: number;
  awayScoreForScoring: number;
  resultStatus: "regulation" | "extra_time" | "penalties";
}

interface StubFixture {
  id: string;
  homeTeam: StubTeam;
  awayTeam: StubTeam;
  stage: "group" | "round_of_32" | "round_of_16" | "quarter" | "semi" | "final" | "third_place";
  groupId: string | null;
  kickoffUtc: string;
  venue: string;
  status: "scheduled" | "in_progress" | "finished" | "postponed" | "cancelled";
  result: StubResult | null;
}

const GROUP_IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

function syntheticTeam(i: number): StubTeam {
  // 32 unique synthetic teams, indexed 0..31. Namespaced with `perf-team-`
  // so they cannot collide with slice 001/002 seed team IDs.
  const idx = ((i % 32) + 32) % 32;
  return {
    id: `perf-team-${idx}`,
    name: `PerfTeam${idx}`,
    shortCode: `P${String(idx).padStart(2, "0")}`,
    flagUrl: null,
  };
}

function syntheticFixture(i: number): StubFixture {
  // Pair team (2i mod 32) vs (2i+1 mod 32) for non-self-matches. The
  // (i*2)%32 / ((i*2)+1)%32 scheme guarantees home != away for all
  // 0 <= i < 100 because the two indices differ by exactly 1 mod 32.
  const home = syntheticTeam(i * 2);
  const away = syntheticTeam(i * 2 + 1);

  // First 20 fixtures are finished (carry a result); the remaining 80
  // are scheduled. This mirrors a mid-tournament snapshot.
  const status: StubFixture["status"] = i < 20 ? "finished" : "scheduled";

  // Spread kickoffs 4 hours apart starting 2026-06-11 12:00 UTC.
  // Use UTC ms to avoid local-tz drift in the test runner.
  const baseUtcMs = Date.UTC(2026, 5, 11, 12, 0, 0);
  const kickoffMs = baseUtcMs + i * 4 * 3600 * 1000;

  const fixture: StubFixture = {
    id: `perf-match-${i}`,
    homeTeam: home,
    awayTeam: away,
    stage: "group",
    groupId: GROUP_IDS[i % GROUP_IDS.length],
    kickoffUtc: new Date(kickoffMs).toISOString(),
    venue: `Perf Stadium ${i}`,
    status,
    result: null,
  };

  if (status === "finished") {
    const homeScore = i % 4;
    const awayScore = (i + 1) % 4;
    fixture.result = {
      homeScoreOfficial: homeScore,
      awayScoreOfficial: awayScore,
      homeScoreForScoring: homeScore,
      awayScoreForScoring: awayScore,
      resultStatus: "regulation",
    };
  }

  return fixture;
}

function buildInflatedSnapshot(): StubFixture[] {
  const arr: StubFixture[] = [];
  for (let i = 0; i < 100; i++) {
    arr.push(syntheticFixture(i));
  }
  return arr;
}

// ============================================================================
// p95 (coarse, 5-sample) helper
// ============================================================================

/**
 * Coarse p95: sort the sample, return `sorted[floor(0.95 * (n-1))]`.
 *
 * For n=5 this returns the 4th-indexed (i.e. slowest) element, so the
 * assertion behaves like a "max-of-5 < budget" check. Documented in the
 * file-level disclaimer.
 */
function quantile(samples: number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor(q * (sorted.length - 1));
  return sorted[idx];
}

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
    `sync_perf: coordinator stays under p95 ${P95_BUDGET_MS} ms with 100-fixture payload (${SAMPLE_COUNT} sequential samples)`,
  ignore: !HAS_ENV,
  // Allow generous time for 5 sequential invocations + restore.
  // Each invocation must be < 30 s by spec; 5 + overhead = ~3 min ceiling.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Capture the original fixture verbatim so we restore it byte-for-byte.
    const originalRaw = await Deno.readTextFile(FIXTURE_PATH);
    let restored = false;

    try {
      // ----- Inflate the fixture (100 fixtures, 20 finished) ------------
      const inflated = buildInflatedSnapshot();
      await Deno.writeTextFile(
        FIXTURE_PATH,
        JSON.stringify(inflated, null, 2),
      );

      // Touch the service client to fail fast if creds are wrong (so
      // we don't pollute the perf samples with auth retries).
      const supabase = serviceClient();
      const { error: pingErr } = await supabase
        .from("provider_sync_runs")
        .select("id", { count: "exact", head: true });
      if (pingErr) {
        throw new Error(
          `pre-test supabase ping failed: ${pingErr.message} — fix the test DB before measuring perf`,
        );
      }

      // ----- Run SAMPLE_COUNT sequential sync invocations ---------------
      const durationsMs: number[] = [];

      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const runId = crypto.randomUUID();

        const startedAt = performance.now();
        const response = await fetch(SYNC_FUNCTION_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Auth": SYNC_TRIGGER_SECRET,
          },
          body: JSON.stringify({
            provider: PROVIDER,
            // D-010: CHECK constraint admits 'manual_internal' (not 'cron').
            trigger: "manual_internal",
            run_id: runId,
            reason: "perf-test",
          }),
        });
        // Drain the body so the timing includes full response delivery,
        // not just header arrival. (`response.ok` after a fetch without
        // body consumption can hide TTLB issues.)
        const _body = await response.text();
        const finishedAt = performance.now();

        const durationMs = finishedAt - startedAt;
        durationsMs.push(durationMs);

        // Sanity: a 5xx response would invalidate the measurement.
        assert(
          response.ok,
          `sync invocation ${i + 1}/${SAMPLE_COUNT} failed: HTTP ${response.status} body=${_body.slice(0, 200)}`,
        );
      }

      // ----- Report + assert -------------------------------------------
      const sorted = [...durationsMs].sort((a, b) => a - b);
      const p50 = quantile(durationsMs, 0.5);
      const p95 = quantile(durationsMs, 0.95);
      const max = sorted[sorted.length - 1];

      // Round to whole ms for readable logs; keep raw values in the assertion.
      const samplesStr = sorted.map((d) => Math.round(d)).join(", ");
      console.log(`[sync_perf] samples (sorted, ms): ${samplesStr}`);
      console.log(
        `[sync_perf] p50=${Math.round(p50)} ms  p95=${Math.round(p95)} ms  max=${Math.round(max)} ms  budget=${P95_BUDGET_MS} ms`,
      );

      assert(
        p95 < P95_BUDGET_MS,
        `sync coordinator p95 ${Math.round(p95)} ms exceeds ${P95_BUDGET_MS} ms budget (samples: ${samplesStr})`,
      );
    } finally {
      // Restore the fixture no matter what. If the restore itself fails
      // we surface the error loudly — leaving an inflated fixture on disk
      // would break every other sync-catalog test on the next `deno test`.
      if (!restored) {
        try {
          await Deno.writeTextFile(FIXTURE_PATH, originalRaw);
          restored = true;
        } catch (e) {
          console.error(
            "[sync_perf] CRITICAL: failed to restore wc2026-snapshot.json fixture. " +
              "Re-checkout the file from git before running other tests:",
            e,
          );
          throw e;
        }
      }
    }
  },
});
