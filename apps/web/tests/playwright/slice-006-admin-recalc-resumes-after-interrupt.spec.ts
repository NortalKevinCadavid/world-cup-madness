// --------------------------------------------------------------------------
// Slice 006 / T019 — score-trigger Edge Function self-scan resume (RED).
// --------------------------------------------------------------------------
// RED acceptance test for SC-007 + spec § Clarifications 2026-05-17 Q2:
//
//   "Interrupted recalculations resume cleanly within 10 seconds of
//    restart with no duplicate records and no missed records. Per
//    Clarifications, the resume mechanism is the score-trigger Edge
//    Function's self-scan at startup (re-invokes any stale
//    `score_calculation_runs` rows older than 60 seconds via the same
//    `run_id` for idempotency), plus a pg_cron backup reaper at 5-minute
//    cadence as eventual-fallback."
//
// Test design (exercises the T024 self-scan mechanism specifically):
//
//   1. Service-role: INSERT a synthetic score_calculation_runs row with
//      status='running' and started_at = now() - 2 minutes. This
//      simulates a stalled run from before an Edge Function restart
//      (started_at older than the 60-second staleness threshold).
//   2. Trigger ANY score-trigger Edge Function invocation by directly
//      POSTing to /functions/v1/score-trigger with a no-op-ish request
//      (scope='match' on a fixture match — even if no predictions match,
//      the invocation itself runs the self-scan at startup BEFORE doing
//      any per-match work).
//   3. Within 10 seconds the self-scan MUST notice the stale row, re-POST
//      itself with the same run_id, the second invocation runs scoring
//      under the original run_id, and the row's status transitions to
//      'succeeded' (Slice 005's score functions UPDATE the existing row
//      identified by run_id rather than INSERTing a new one — that's the
//      idempotency contract from research.md § R-002).
//
// Source of truth:
//   - specs/006-admin-overrides/spec.md § Clarifications 2026-05-17 Q2
//   - specs/006-admin-overrides/spec.md § Success Criterion SC-007
//   - specs/006-admin-overrides/tasks.md § T024 (score-trigger self-scan
//     at startup)
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § /admin/recalc Test surface row 3
//   - apps/web/tests/playwright/slice-005-match-scoring.spec.ts
//       (callScoreTrigger pattern + cookie forwarding)
//
// Persona: admin1 (the direct POST to the Edge Function forwards the
// signed-in admin cookie; T024's self-scan logic runs unconditionally at
// startup regardless of the inbound caller).
//
// Cleanup contract:
//   beforeEach: resetStub + ensureAdminRole(admin1) + INSERT the synthetic
//   stale row + capture testStartInstant.
//   afterEach: DELETE every score_calculation_runs row whose started_at >=
//   (testStartInstant - 5min) — wider window because the synthetic stale
//   row predates testStartInstant by 2 minutes. DELETE score_records
//   created since testStartInstant. resetStub + ensureAdminRole.
//
// RED-by-design until:
//   - T024 modifies supabase/functions/score-trigger/index.ts to self-scan
//     at startup and re-invoke for each stale row via pg_net.http_post.
//   - T021 ships admin_trigger_recalc SP (the synthetic row insert below
//     bypasses the SP but T024's self-scan re-invokes with the existing
//     run_id; Slice 005's score functions then process under that id).
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { ensureAdminRole } from "./helpers/admin-roles";
import { getServiceClient } from "./helpers/service-role";

const ADMIN1 = {
  sub: "00000000-0000-0000-0000-0000000000d3",
  email: "admin1@nortal.com",
  email_verified: true,
  name: "Admin One",
} as const;

const ADMIN1_PARTICIPANT_ID = "77777777-7777-7777-7777-777777777777";

// Deterministic UUID for the synthetic stale 'running' row.
const STALE_RUN_ID = "eeee0070-0006-0019-0003-000000000001";

// M1 from slice-005-fixture.sql § 3 — exists, has match_results, so the
// no-op POST below will reach the Edge Function self-scan without 4xx-ing
// at request validation.
const M1 = "eeee0050-0000-0000-0000-000000000001";

const SCORE_TRIGGER_ENDPOINT =
  (process.env.SUPABASE_FUNCTIONS_BASE_URL ??
    "http://localhost:54321/functions/v1") + "/score-trigger";

interface ScoreCalculationRunRow {
  id: string;
  scope: "match" | "finals" | "all";
  status: "running" | "succeeded" | "failed";
  started_at: string;
  completed_at: string | null;
  calculation_version_written: number | null;
  affected_record_count: number | null;
}

async function readRun(runId: string): Promise<ScoreCalculationRunRow | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("score_calculation_runs")
    .select(
      "id,scope,status,started_at,completed_at,calculation_version_written,affected_record_count",
    )
    .eq("id", runId)
    .maybeSingle();
  if (error) {
    throw new Error(`readRun(${runId}): ${error.message}`);
  }
  return (data ?? null) as ScoreCalculationRunRow | null;
}

async function insertStaleRunningRun(): Promise<void> {
  const client = getServiceClient();
  // started_at 2 minutes in the past → comfortably past T024's 60-second
  // staleness threshold (per spec Clarifications Q2).
  const startedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { error } = await client.from("score_calculation_runs").insert({
    id: STALE_RUN_ID,
    scope: "match",
    target_id: M1,
    trigger: "admin_recalc",
    triggered_by: ADMIN1_PARTICIPANT_ID,
    reason: "T019 resumes-after-interrupt synthetic stale pre-state",
    status: "running",
    started_at: startedAt,
  });
  if (error) {
    throw new Error(
      `insertStaleRunningRun: ${error.message}. ` +
        `Confirm migration 0050 (score_calculation_runs) is applied.`,
    );
  }
}

async function deleteRun(runId: string): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("score_calculation_runs")
    .delete()
    .eq("id", runId);
  if (error) {
    throw new Error(`deleteRun(${runId}): ${error.message}`);
  }
}

async function buildCookieHeader(
  context: import("@playwright/test").BrowserContext,
): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

test.describe(
  "US2 / SC-007 — Edge Function self-scan resumes stale recalc within 10 seconds @slice-006 @us2",
  () => {
    test.setTimeout(60_000);

    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      await deleteRun(STALE_RUN_ID); // defensive
      testStartInstant = new Date();
      await insertStaleRunningRun();
    });

    test.afterEach(async () => {
      await deleteRun(STALE_RUN_ID);
      const client = getServiceClient();
      // Wider window than testStartInstant: the synthetic stale row was
      // back-dated to (now - 2min) before the test started; clean up
      // anything in that window inclusive of the wider lookback.
      const since = new Date(
        testStartInstant.getTime() - 5 * 60 * 1000,
      ).toISOString();
      const { error: runsErr } = await client
        .from("score_calculation_runs")
        .delete()
        .gte("started_at", since);
      if (runsErr) {
        throw new Error(`afterEach runs cleanup: ${runsErr.message}`);
      }
      const { error: recsErr } = await client
        .from("score_records")
        .delete()
        .gte("calculated_at", testStartInstant.toISOString());
      if (recsErr) {
        throw new Error(`afterEach score_records cleanup: ${recsErr.message}`);
      }
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "a stale 'running' row started 2 minutes ago resumes to 'succeeded' within 10 seconds of the next score-trigger invocation (T024 self-scan at startup; SC-007 primary mechanism) @slice-006 @us2",
      async ({ page, request, context }) => {
        // Sign in admin1 so the page's cookie jar holds a valid Supabase
        // session that we can forward to the Edge Function.
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        // Pre-state sanity: the synthetic stale row exists with status='running'.
        const preRow = await readRun(STALE_RUN_ID);
        expect(
          preRow,
          `Pre-state: score_calculation_runs row id=${STALE_RUN_ID} MUST exist (inserted in beforeEach)`,
        ).not.toBeNull();
        expect(
          preRow!.status,
          "Pre-state: synthetic stale row MUST have status='running'",
        ).toBe("running");
        const preStartedAt = new Date(preRow!.started_at).getTime();
        expect(
          Date.now() - preStartedAt,
          "Pre-state: synthetic stale row MUST have started_at older than 60 seconds (the T024 staleness threshold)",
        ).toBeGreaterThan(60_000);

        // Now invoke the score-trigger Edge Function with an unrelated
        // request. T024's self-scan runs at the START of every invocation
        // BEFORE the per-request work — so even if this incoming request
        // is rejected or no-ops at validation, the self-scan still re-POSTs
        // for the stale row.
        const cookieHeader = await buildCookieHeader(context);
        const triggerStart = Date.now();
        const triggerResponse = await request.post(SCORE_TRIGGER_ENDPOINT, {
          headers: {
            "Content-Type": "application/json",
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          // A minimal valid-shape request for an arbitrary match. The
          // Edge Function MAY accept or reject this; either way the
          // self-scan at the top of the handler runs.
          data: {
            scope: "match",
            target_id: M1,
            reason: "T019 self-scan trigger probe",
          },
        });

        // Whether the probe itself succeeds is not the contract under
        // test; the self-scan side-effect is. We log the status for
        // diagnostic purposes only.
        expect(
          [200, 202, 400, 403, 409, 500].includes(triggerResponse.status()),
          `score-trigger probe returned status=${triggerResponse.status()} — any well-formed status is acceptable; the self-scan is the contract under test`,
        ).toBe(true);

        // Poll the stale run row for transition to 'succeeded'. The
        // SC-007 budget is 10 seconds; we generously allow a 15-second
        // poll cap to absorb CI scheduling jitter while still surfacing
        // a real regression.
        const deadline = Date.now() + 15_000;
        let resumed: ScoreCalculationRunRow | null = null;
        while (Date.now() < deadline) {
          resumed = await readRun(STALE_RUN_ID);
          if (resumed && resumed.status === "succeeded") break;
          await new Promise((r) => setTimeout(r, 500));
        }

        const elapsedMs = Date.now() - triggerStart;
        expect(
          resumed,
          `Stale run row id=${STALE_RUN_ID} MUST still exist after self-scan resume (idempotency: same run_id is re-used, not replaced)`,
        ).not.toBeNull();
        expect(
          resumed!.status,
          `Stale run row MUST transition to status='succeeded' (got status='${resumed!.status}' after ${elapsedMs}ms)`,
        ).toBe("succeeded");
        expect(
          elapsedMs,
          `Resume MUST complete within 10 seconds of the next Edge Function invocation (SC-007); observed ${elapsedMs}ms`,
        ).toBeLessThanOrEqual(10_000);
        expect(
          resumed!.completed_at,
          "Resumed row MUST have completed_at set (table CHECK score_calculation_runs_succeeded_completeness)",
        ).not.toBeNull();
        expect(
          resumed!.calculation_version_written,
          "Resumed row MUST have calculation_version_written set (table CHECK)",
        ).not.toBeNull();

        // Service-role verify: score_records rows MAY exist under the
        // stale run_id (the self-scan re-invoked Slice 005's score
        // functions which INSERT into score_records keyed by run_id). We
        // assert non-negative count rather than > 0 because the fixture
        // may have zero affected predictions for M1 in some seeds —
        // either way, no duplicate rows.
        const client = getServiceClient();
        const { count: srCount, error: srErr } = await client
          .from("score_records")
          .select("id", { count: "exact", head: true })
          .eq("run_id", STALE_RUN_ID);
        if (srErr) {
          throw new Error(`score_records count: ${srErr.message}`);
        }
        expect(
          srCount ?? 0,
          `score_records rows for run_id=${STALE_RUN_ID} MUST equal affected_record_count=${resumed!.affected_record_count} (idempotent re-invocation: same run_id, no duplicates)`,
        ).toBe(resumed!.affected_record_count);
      },
    );
  },
);
