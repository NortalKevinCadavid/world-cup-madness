/**
 * Slice 002 / T035 — Cross-run conflict quarantined test (RED).
 *
 * Contract:
 *   - specs/002-match-catalog/spec.md § Clarifications 2026-05-15 Q2
 *       (hybrid abort/quarantine: per-row anomalies are QUARANTINED rather
 *       than aborting the whole run — the offending provider row lands in
 *       public.match_pending_review and the catalog is NOT mutated for that
 *       row, while sibling rows continue to apply normally).
 *   - specs/002-match-catalog/research.md § R-005 (cross-run conflict +
 *       quarantine table) — enumerates `team_assignment_changed`,
 *       `status_backward_transition`, `score_before_kickoff`,
 *       `kickoff_change_after_lock` as the quarantineable conflict classes.
 *   - specs/002-match-catalog/data-model.md § Entity 7 (Match Pending Review).
 *
 * As-built schema reconciliation:
 *   T007 (migration 0023) shipped the quarantine table with conflict_class
 *   text + a CHECK whitelist whose values are:
 *     'team_assignment_change' (not '_changed'),
 *     'status_backward_transition',
 *     'score_before_finished'  (not 'score_before_kickoff'),
 *     'kickoff_change_after_lock',
 *     'unknown_team',
 *     'other'
 *   That CHECK is the load-bearing contract; this test asserts against it.
 *
 * What this test proves:
 *   Pre-state: M1 is ARG vs MEX in the seeded catalog (finished, ARG 2-0 MEX).
 *   Mutation: rewrite the stub fixture so that the provider entry for
 *     `stub-match-1` returns ARG (home) vs BRA (away) — a team-assignment
 *     change because BRA was never M1's away team. The mutation is constrained
 *     to that one row; M2..M8 stay as the canonical fixture so the rest of
 *     the run can apply normally (hybrid policy).
 *   POST sync via X-Internal-Auth + trigger='manual_internal'.
 *   Assertions:
 *     (a) Response 200 with outcome IN ('conflict_quarantined', 'partial')
 *         — both are acceptable terminal outcomes for a run that produced
 *         quarantine rows; T040 will pick one and align this assertion.
 *     (b) `public.match_pending_review` has exactly ONE row for the offending
 *         provider entry — `provider_external_id='stub-match-1'`,
 *         `conflict_class='team_assignment_change'`, `resolution IS NULL`
 *         (un-triaged — Slice 006 admin flow resolves these).
 *     (c) `public.matches` row for M1 is UNCHANGED — still ARG (home) vs MEX
 *         (away). Silent UPDATE here would violate Principle II and the
 *         spec's hybrid clarification.
 *
 * RED-first state (Constitution IX):
 *   T040 hasn't shipped — the coordinator does not yet quarantine. Until it
 *   does, the POST either succeeds with outcome='success' (catalog mutated,
 *   no quarantine row) OR fails outright. Either failure mode is the RED
 *   gate; once T040 implements the quarantine logic this test becomes the
 *   regression gate.
 *
 * Skip policy:
 *   The test self-skips unless `RUN_SYNC_CATALOG_TESTS=1` AND all four
 *   harness env vars are set (mirrors T023 / T034 siblings — Docker +
 *   Supabase CLI are not installed on every contributor's machine, so
 *   `deno test` must remain clean without them).
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
//   M1 (ARG vs MEX, finished) — id bbbb…0001, home_team_id aaaa…0001 (ARG),
//   away_team_id aaaa…0002 (MEX).
const M1_MATCH_ID = "bbbb0000-0000-0000-0000-000000000001";
const ARG_TEAM_ID = "aaaa0000-0000-0000-0000-000000000001";
const MEX_TEAM_ID = "aaaa0000-0000-0000-0000-000000000002";
const M1_PROVIDER_EXTERNAL_ID = "stub-match-1";

// Fixture path — same URL used by the stub adapter at
// supabase/functions/_shared/providers/stub/index.ts.
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
    "cross_run_conflict_quarantined: team-assignment change on M1 (ARG vs MEX → ARG vs BRA) is quarantined; matches row UNCHANGED; one match_pending_review row written with conflict_class='team_assignment_change'",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();

    // ------------------------------------------------------------------------
    // Capture the canonical fixture so we can restore it in `finally` even if
    // any assertion throws mid-run. The fixture file is the SAME one the
    // stub adapter reads (`readSnapshot()` in stub/index.ts), so mutating it
    // here is what causes the next POST to see the conflicting team payload.
    // ------------------------------------------------------------------------
    const originalFixture = await Deno.readTextFile(FIXTURE_URL);

    try {
      // ----------------------------------------------------------------------
      // Mutate the stub fixture: rewrite stub-match-1's awayTeam from MEX to
      // BRA (Brazil — `id='bra'`, `shortCode='BRA'`). BRA was never M1's away
      // team in the seed, so the coordinator must detect a team-assignment
      // conflict against the existing matches row and quarantine. All other
      // fixture rows (stub-match-2 .. stub-match-8) are left untouched so the
      // hybrid policy is exercised: the run continues for sibling rows.
      // ----------------------------------------------------------------------
      const parsed = JSON.parse(originalFixture) as Array<Record<string, unknown>>;
      const m1 = parsed.find((r) => r.id === M1_PROVIDER_EXTERNAL_ID);
      if (!m1) {
        throw new Error(
          `fixture invariant violated: ${M1_PROVIDER_EXTERNAL_ID} not found in ${FIXTURE_URL}`,
        );
      }
      m1.awayTeam = {
        id: "bra",
        name: "Brazil",
        shortCode: "BRA",
        flagUrl: null,
      };
      await Deno.writeTextFile(FIXTURE_URL, JSON.stringify(parsed, null, 2));

      // ----------------------------------------------------------------------
      // Pre-state assertion: M1 in the catalog is ARG vs MEX. We assert this
      // baseline so a regression in the seed (or a polluted test DB) fails
      // LOUDLY before we accuse the coordinator of misbehaving.
      // ----------------------------------------------------------------------
      const { data: m1Before, error: beforeErr } = await supabase
        .from("matches")
        .select("id, home_team_id, away_team_id")
        .eq("id", M1_MATCH_ID)
        .single();
      if (beforeErr) {
        throw new Error(`M1 pre-state lookup failed: ${beforeErr.message}`);
      }
      assertEquals(
        m1Before?.home_team_id,
        ARG_TEAM_ID,
        "M1 pre-state must have ARG as home_team_id",
      );
      assertEquals(
        m1Before?.away_team_id,
        MEX_TEAM_ID,
        "M1 pre-state must have MEX as away_team_id",
      );

      // ----------------------------------------------------------------------
      // Trigger the coordinator. trigger='manual_internal' per the
      // provider_sync_runs CHECK enum (migration 0022 — 'scheduled' |
      // 'manual_admin' | 'manual_internal'). Manual internal is the
      // category for developer / internal-tooling invocations, which is
      // exactly what this RED test is.
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
      // match_pending_review assertion: exactly ONE row for stub-match-1 with
      // conflict_class='team_assignment_change' (per migration 0023's CHECK
      // whitelist) and resolution IS NULL (un-triaged — Slice 006 admin flow
      // is the only writer of `resolution`).
      // ----------------------------------------------------------------------
      const { data: reviewRows, error: reviewErr } = await supabase
        .from("match_pending_review")
        .select("id, conflict_class, resolution, provider, provider_external_id")
        .eq("provider_external_id", M1_PROVIDER_EXTERNAL_ID)
        .eq("provider", PROVIDER);
      if (reviewErr) {
        throw new Error(`match_pending_review lookup failed: ${reviewErr.message}`);
      }
      assertEquals(
        reviewRows?.length,
        1,
        `exactly one match_pending_review row must exist for ${M1_PROVIDER_EXTERNAL_ID}, got ${reviewRows?.length}`,
      );
      const review = (reviewRows ?? [])[0];
      assertEquals(
        review?.conflict_class,
        "team_assignment_change",
        "conflict_class must be 'team_assignment_change' per migration 0023's CHECK whitelist",
      );
      assertEquals(
        review?.resolution,
        null,
        "newly-quarantined rows are un-triaged — resolution MUST be NULL until Slice 006 admin acts",
      );

      // ----------------------------------------------------------------------
      // matches invariant: the M1 row is UNCHANGED. The conflicting provider
      // payload was diverted to the quarantine queue, NOT silently merged.
      // This is the Principle II + spec Clarifications Q2 (per-row=quarantine)
      // gate. A regression that silently overwrote M1's away_team_id to BRA's
      // UUID would fail this assertion loudly.
      // ----------------------------------------------------------------------
      const { data: m1After, error: afterErr } = await supabase
        .from("matches")
        .select("id, home_team_id, away_team_id")
        .eq("id", M1_MATCH_ID)
        .single();
      if (afterErr) {
        throw new Error(`M1 post-state lookup failed: ${afterErr.message}`);
      }
      assertEquals(
        m1After?.home_team_id,
        ARG_TEAM_ID,
        "M1.home_team_id must be unchanged (still ARG) — quarantine MUST NOT mutate the catalog",
      );
      assertEquals(
        m1After?.away_team_id,
        MEX_TEAM_ID,
        "M1.away_team_id must be unchanged (still MEX) — silent overwrite to BRA would violate spec Q2",
      );
    } finally {
      // ----------------------------------------------------------------------
      // ALWAYS restore the canonical fixture so downstream tests (and the
      // next `deno test` run) see the seeded shape. Even if every assertion
      // above threw, the fixture must come back. Without this restore the
      // entire test suite turns RED on the next invocation.
      // ----------------------------------------------------------------------
      await Deno.writeTextFile(FIXTURE_URL, originalFixture);
    }
  },
});
