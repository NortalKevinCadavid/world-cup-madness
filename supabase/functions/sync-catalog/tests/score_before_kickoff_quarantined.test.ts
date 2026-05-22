/**
 * Slice 002 / T035 — Score-before-kickoff quarantined test (RED).
 *
 * Contract:
 *   - specs/002-match-catalog/spec.md § Clarifications 2026-05-15 Q2
 *       (per-row anomalies = quarantine; the catalog continues to serve the
 *       last-known-good state for that match).
 *   - specs/002-match-catalog/research.md § R-005:
 *       "Spec Edge Case 'provider returns scores for a not-yet-started match'
 *        requires rejection — this is a conflict case that gets quarantined."
 *   - specs/002-match-catalog/data-model.md § Entity 7 (Match Pending Review).
 *
 * As-built schema reconciliation:
 *   T007 (migration 0023) shipped the quarantine table with conflict_class
 *   text + a CHECK whitelist. The class for this anomaly is
 *   'score_before_finished' (not 'score_before_kickoff' as the older
 *   research draft uses — the migration is the load-bearing contract). Per
 *   D-006 this test asserts against the as-built enum value.
 *
 * What this test proves:
 *   Pre-state: M3 (ARG vs CAN, status='scheduled', no match_results row).
 *   Mutation: rewrite the stub fixture so stub-match-3 ships a non-null
 *     `result` object with scores while status remains 'scheduled'. (The
 *     anomaly is the SAME whether status is 'scheduled' or maliciously
 *     flipped to 'finished' — the catalog says scheduled, so any score is
 *     premature and must be quarantined, not merged. We pick status=
 *     'scheduled' because that is the strictest form of the anomaly and
 *     mirrors the spec Edge Case verbatim.)
 *   POST sync via X-Internal-Auth + trigger='manual_internal'.
 *   Assertions:
 *     (a) Response 200 with outcome IN ('conflict_quarantined', 'partial').
 *     (b) `public.match_pending_review` has one row with
 *         `provider_external_id='stub-match-3'` and
 *         `conflict_class='score_before_finished'`.
 *     (c) `public.match_results` for M3 was NOT inserted — the seed only
 *         contains a result row for M1; the post-sync count for M3 must
 *         remain zero. A silent insert here would let a premature score
 *         leak into Slice 005's scoring path, which is exactly what spec
 *         Q2's quarantine policy prevents.
 *
 * RED-first state (Constitution IX):
 *   T040 hasn't shipped — the coordinator does not yet detect this anomaly.
 *   Until it does, the run either applies the score (test FAILS on the
 *   match_results count assertion) or aborts entirely (test FAILS on the
 *   match_pending_review row assertion). Either failure mode is the RED
 *   gate; once T040 implements the quarantine logic this test becomes the
 *   regression gate.
 *
 * Skip policy:
 *   The test self-skips unless `RUN_SYNC_CATALOG_TESTS=1` AND all four
 *   harness env vars are set. Mirrors the sibling tests T023 / T034 / T035a
 *   (cross_run_conflict_quarantined.test.ts).
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

// Pre-existing seeded UUIDs (supabase/seed/slice-002-fixture.sql):
//   M3 (ARG vs CAN, scheduled) — id bbbb…0003. The seed loads NO match_results
//   row for M3; only M1 ships a result row. Confirming that pre-state is part
//   of the test below.
const M3_MATCH_ID = "bbbb0000-0000-0000-0000-000000000003";
const M3_PROVIDER_EXTERNAL_ID = "stub-match-3";

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
    "score_before_kickoff_quarantined: provider ships a result for M3 (status='scheduled' in the catalog); the row is quarantined with conflict_class='score_before_finished'; match_results for M3 is NOT inserted",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // ------------------------------------------------------------------------
    // Capture the canonical fixture so we can restore it in `finally`. The
    // fixture file is the SAME one the stub adapter reads, so mutating it
    // here is what causes the next POST to see the premature-score payload.
    // ------------------------------------------------------------------------
    const originalFixture = await Deno.readTextFile(FIXTURE_URL);

    try {
      // ----------------------------------------------------------------------
      // Mutate stub-match-3: attach a `result` object. Status is left as
      // 'scheduled' so the catalog (matches.status='scheduled') and the
      // provider's claim of a scored result are mutually inconsistent —
      // exactly the anomaly R-005 calls out. All other fixture rows are
      // unchanged so the run can continue applying sibling rows under the
      // hybrid policy.
      //
      // NOTE: the stub adapter's `fetchResults()` only emits results when
      // status === 'finished' OR 'penalties_shootout'. We deliberately exploit
      // the broader semantics: even with status='scheduled', the coordinator
      // is expected to detect the catalog-vs-payload mismatch via the
      // existing matches.status (which is 'scheduled') against the
      // provider's claim of a real score. T040 owns the detection logic —
      // see contracts/sync-runner.scheduled.md § Quarantine flow. If T040
      // chooses to drive the check off the result-stream rather than the
      // fixture-stream, this test will still RED because the coordinator's
      // own fetchResults path filters out scheduled rows entirely, leaving
      // no quarantine row written — and the assertion below fires.
      //
      // To keep the RED gate robust against either detection design, we set
      // status='finished' on stub-match-3 too — the catalog row for M3 is
      // still 'scheduled', so the score-vs-status conflict is genuine
      // ("provider claims finished + score; catalog says scheduled" — the
      // canonical R-005 scenario). The catalog-side status is the source of
      // truth, so the conflict_class is 'score_before_finished' regardless
      // of which side of the diff drives detection.
      // ----------------------------------------------------------------------
      const parsed = JSON.parse(originalFixture) as Array<Record<string, unknown>>;
      const m3 = parsed.find((r) => r.id === M3_PROVIDER_EXTERNAL_ID);
      if (!m3) {
        throw new Error(
          `fixture invariant violated: ${M3_PROVIDER_EXTERNAL_ID} not found in ${FIXTURE_URL}`,
        );
      }
      m3.status = "finished";
      m3.result = {
        homeScoreOfficial: 3,
        awayScoreOfficial: 1,
        homeScoreForScoring: 3,
        awayScoreForScoring: 1,
        resultStatus: "regulation",
      };
      await Deno.writeTextFile(FIXTURE_URL, JSON.stringify(parsed, null, 2));

      // ----------------------------------------------------------------------
      // Pre-state assertion: M3 is 'scheduled' in the catalog and has NO
      // match_results row. If either fails, the seed regressed.
      // ----------------------------------------------------------------------
      const { data: m3Before, error: m3BeforeErr } = await supabase
        .from("matches")
        .select("id, status")
        .eq("id", M3_MATCH_ID)
        .single();
      if (m3BeforeErr) {
        throw new Error(`M3 pre-state lookup failed: ${m3BeforeErr.message}`);
      }
      assertEquals(
        m3Before?.status,
        "scheduled",
        "M3 pre-state must be 'scheduled' for the score-before-finished anomaly to apply",
      );

      const { count: resultsBefore, error: rbErr } = await supabase
        .from("match_results")
        .select("*", { count: "exact", head: true })
        .eq("match_id", M3_MATCH_ID);
      if (rbErr) {
        throw new Error(`M3 pre-state match_results count failed: ${rbErr.message}`);
      }
      assertEquals(
        resultsBefore,
        0,
        "M3 must have zero match_results rows pre-sync (the seed only writes a result for M1)",
      );

      // ----------------------------------------------------------------------
      // Trigger the coordinator. trigger='manual_internal' per migration
      // 0022's provider_sync_runs CHECK enum.
      // ----------------------------------------------------------------------
      const runId = crypto.randomUUID();
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

      assertEquals(
        response.status,
        200,
        "sync POST with a quarantineable conflict must still return 200 (the run completed; one row was diverted to the review queue)",
      );

      const body = await response.json();
      assertEquals(
        body?.run_id,
        runId,
        "200 body must echo the supplied run_id",
      );
      assert(
        body?.outcome === "conflict_quarantined" || body?.outcome === "partial",
        `outcome must be one of {conflict_quarantined, partial} when at least one row was quarantined; got '${body?.outcome}'`,
      );

      // ----------------------------------------------------------------------
      // match_pending_review assertion: exactly ONE row for stub-match-3
      // with conflict_class='score_before_finished' (per migration 0023's
      // CHECK whitelist).
      // ----------------------------------------------------------------------
      const { data: reviewRows, error: reviewErr } = await supabase
        .from("match_pending_review")
        .select("id, conflict_class, resolution, provider, provider_external_id")
        .eq("provider_external_id", M3_PROVIDER_EXTERNAL_ID)
        .eq("provider", PROVIDER);
      if (reviewErr) {
        throw new Error(`match_pending_review lookup failed: ${reviewErr.message}`);
      }
      assertEquals(
        reviewRows?.length,
        1,
        `exactly one match_pending_review row must exist for ${M3_PROVIDER_EXTERNAL_ID}, got ${reviewRows?.length}`,
      );
      const review = (reviewRows ?? [])[0];
      assertEquals(
        review?.conflict_class,
        "score_before_finished",
        "conflict_class must be 'score_before_finished' per migration 0023's CHECK whitelist (D-006 enum reconciliation)",
      );
      assertEquals(
        review?.resolution,
        null,
        "newly-quarantined rows are un-triaged — resolution MUST be NULL until Slice 006 admin acts",
      );

      // ----------------------------------------------------------------------
      // match_results invariant: NO row for M3 was inserted. The premature
      // score was diverted to quarantine, not merged into the scoring
      // surface. This is the load-bearing assertion that protects Slice
      // 005's scoring pipeline from premature inputs.
      // ----------------------------------------------------------------------
      const { count: resultsAfter, error: raErr } = await supabase
        .from("match_results")
        .select("*", { count: "exact", head: true })
        .eq("match_id", M3_MATCH_ID);
      if (raErr) {
        throw new Error(`M3 post-state match_results count failed: ${raErr.message}`);
      }
      assertEquals(
        resultsAfter,
        0,
        "match_results for M3 MUST NOT be inserted — premature scores belong in the quarantine queue, not the scoring surface",
      );
    } finally {
      // ----------------------------------------------------------------------
      // ALWAYS restore the canonical fixture so downstream tests see the
      // seeded shape.
      // ----------------------------------------------------------------------
      await Deno.writeTextFile(FIXTURE_URL, originalFixture);
    }
  },
});
