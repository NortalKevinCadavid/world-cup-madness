// --------------------------------------------------------------------------
// Slice 006 / T019 — `/admin/recalc` full-recalc happy path (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 2 (P1) Acceptance Scenario 1:
//
//   "Given a corrected match score (manual or provider), When an
//    administrator triggers a recalculation, Then all affected predictions
//    MUST be re-scored using the corrected official score, prior score
//    records MUST be retained as immutable history, and the leaderboard
//    MUST reflect the new values within 1 minute of completion."
//
// And SC-003 (UI-visible status transitions running → succeeded via
// Supabase Realtime — see admin-ui.surface.md § /admin/recalc test surface).
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md § /admin/recalc
//   - specs/006-admin-overrides/spec.md § US2 AS1
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md § admin_trigger_recalc
//   - .specify/memory/constitution.md § Principle IX (BDD: every Then-clause
//     MUST assert a specific checkable value).
//
// Persona: admin1 (admin role active via T009 + ensureAdminRole).
//
// Cleanup contract:
//   beforeEach: resetStub + ensureAdminRole(admin1) + capture
//   `testStartInstant` so afterEach can purge ONLY rows this test created.
//   afterEach: service-role DELETE every score_records row with
//   `calculated_at >= testStartInstant`, then every score_calculation_runs
//   row with `started_at >= testStartInstant`. audit_log rows are
//   append-only (Slice 007 contract) and remain. Then resetStub +
//   ensureAdminRole (defensive).
//
// RED-by-design until:
//   - T021 ships `admin_trigger_recalc` SP at migration slot 0070.
//   - T022 ships `pending_recalc_state` VIEW at slot 0071.
//   - T024 modifies score-trigger Edge Function to self-scan at startup.
//   - T025 ships `apps/web/app/admin/recalc/page.tsx` +
//     `apps/web/app/api/admin/recalc/route.ts` +
//     `RecalcStatusLive` client component.
//   Until those land:
//     * `page.goto('/admin/recalc')` 404s OR the recalc form is absent.
//     * The trigger POST returns 404 OR the Realtime status transitions
//       are never emitted.
//   The failure mode is always assertion-level (status / DOM expectation
//   mismatches), never infrastructure-error.
//
// Selectors implied (T025 MUST honor):
//   - [data-testid="trigger-recalc-button"]
//       The primary "Trigger Full Recalc" button on /admin/recalc.
//   - [data-testid="recalc-status-live"]
//       Wrapper element on the RecalcStatusLive client component.
//   - [data-testid="recalc-status-value"]
//       Live-updating element whose textContent reflects the current
//       score_calculation_runs.status (e.g. 'running', 'succeeded').
//   - [data-testid="recalc-run-id"]
//       Element whose textContent is the just-triggered run_id (so the
//       test can assert which row to verify in the DB).
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

// admin1's participants.id (slice-005-fixture.sql § 2 line 248).
const ADMIN1_PARTICIPANT_ID = "77777777-7777-7777-7777-777777777777";

interface ScoreCalculationRunRow {
  id: string;
  scope: "match" | "finals" | "all";
  target_id: string | null;
  trigger: string;
  triggered_by: string;
  reason: string | null;
  started_at: string;
  completed_at: string | null;
  status: "running" | "succeeded" | "failed";
  affected_record_count: number | null;
  calculation_version_written: number | null;
  notes: string | null;
}

async function readScoreCalcRun(
  runId: string,
): Promise<ScoreCalculationRunRow | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("score_calculation_runs")
    .select(
      "id,scope,target_id,trigger,triggered_by,reason,started_at,completed_at,status,affected_record_count,calculation_version_written,notes",
    )
    .eq("id", runId)
    .maybeSingle();
  if (error) {
    throw new Error(`readScoreCalcRun(${runId}): ${error.message}`);
  }
  return (data ?? null) as ScoreCalculationRunRow | null;
}

async function purgeScoringRowsSince(since: Date): Promise<void> {
  const client = getServiceClient();
  const sinceIso = since.toISOString();
  const { error: srErr } = await client
    .from("score_records")
    .delete()
    .gte("calculated_at", sinceIso);
  if (srErr) {
    throw new Error(`purgeScoringRowsSince score_records: ${srErr.message}`);
  }
  const { error: runsErr } = await client
    .from("score_calculation_runs")
    .delete()
    .gte("started_at", sinceIso);
  if (runsErr) {
    throw new Error(
      `purgeScoringRowsSince score_calculation_runs: ${runsErr.message}`,
    );
  }
}

test.describe(
  "US2 — admin triggers full recalc; status running → succeeded @slice-006 @us2",
  () => {
    // The whole-tournament fixture recalc must complete within 5 minutes
    // (SC-002: leaderboard reflects new values within 1 minute of completion;
    // a 5-minute outer envelope absorbs the fixture-DB warm-up).
    test.setTimeout(5 * 60 * 1000);

    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      testStartInstant = new Date();
    });

    test.afterEach(async () => {
      await purgeScoringRowsSince(testStartInstant);
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 clicks 'Trigger Full Recalc' on /admin/recalc; Realtime status transitions running → succeeded; DB row reflects trigger='admin_recalc', triggered_by=admin1, status='succeeded' @slice-006 @us2",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        // Navigate to /admin/recalc.
        const pageResponse = await page.goto("/admin/recalc");
        expect(
          pageResponse,
          "page.goto('/admin/recalc') MUST return a Response object (not null) — Next.js served the route",
        ).not.toBeNull();
        expect(
          pageResponse!.status(),
          "/admin/recalc MUST return 200 for an active admin (admin-ui.surface.md § `/admin/recalc`)",
        ).toBe(200);

        // Final URL MUST still be /admin/recalc.
        expect(
          new URL(page.url()).pathname,
          "Final URL pathname MUST be '/admin/recalc' for an active admin (no redirect to /admin/denied)",
        ).toBe("/admin/recalc");

        // The trigger button MUST be present.
        const triggerButton = page.locator(
          '[data-testid="trigger-recalc-button"]',
        );
        await expect(
          triggerButton,
          "[data-testid=\"trigger-recalc-button\"] MUST be visible on /admin/recalc (admin-ui.surface.md § /admin/recalc Actions)",
        ).toBeVisible();

        // Click the trigger and intercept the POST to /api/admin/recalc.
        const [postResponse] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes("/api/admin/recalc") &&
              r.request().method() === "POST",
            { timeout: 15_000 },
          ),
          triggerButton.click(),
        ]);

        expect(
          postResponse.status(),
          "POST /api/admin/recalc MUST return 200 (admin-rpcs.write.md § admin_trigger_recalc returns run_id)",
        ).toBe(200);

        const postJson = (await postResponse.json()) as { run_id?: string };
        expect(
          postJson.run_id,
          "POST /api/admin/recalc response body MUST include 'run_id' (admin-rpcs.write.md § admin_trigger_recalc Returns)",
        ).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        const runId = postJson.run_id!;

        // The live status element MUST render. It first reflects 'running'
        // (the row was INSERTed by the SP with status='running') and MUST
        // transition to 'succeeded' once the Edge Function completes.
        // Realtime delivers both transitions to the client; we observe via
        // `data-testid="recalc-status-value"`.
        const statusEl = page.locator('[data-testid="recalc-status-value"]');
        await expect(
          statusEl,
          "[data-testid=\"recalc-status-value\"] MUST be visible after triggering a recalc (RecalcStatusLive client component, T025)",
        ).toBeVisible();

        // First transition: 'running'. The SP INSERTs the row with
        // status='running' before returning; Realtime delivers the row
        // immediately. Allow 10 seconds.
        await expect(
          statusEl,
          "Realtime MUST surface status='running' within 10 seconds of trigger (the SP INSERTs the row with status='running' before returning)",
        ).toHaveText(/running/i, { timeout: 10_000 });

        // Second transition: 'succeeded'. The score-trigger Edge Function
        // processes the run and UPDATEs status='succeeded'. For the fixture
        // size this MUST complete within the test timeout (5 minutes).
        await expect(
          statusEl,
          "Realtime MUST surface status='succeeded' within 5 minutes (score-trigger Edge Function UPDATE; SC-002 envelope)",
        ).toHaveText(/succeeded/i, { timeout: 5 * 60 * 1000 });

        // Service-role verify: the run row matches the contract.
        const dbRun = await readScoreCalcRun(runId);
        expect(
          dbRun,
          `score_calculation_runs row for run_id=${runId} MUST exist after trigger`,
        ).not.toBeNull();
        expect(
          dbRun!.trigger,
          "score_calculation_runs.trigger MUST be 'admin_recalc' (admin-rpcs.write.md § admin_trigger_recalc step 4)",
        ).toBe("admin_recalc");
        expect(
          dbRun!.triggered_by,
          `score_calculation_runs.triggered_by MUST equal admin1's participants.id ('${ADMIN1_PARTICIPANT_ID}')`,
        ).toBe(ADMIN1_PARTICIPANT_ID);
        expect(
          dbRun!.scope,
          "score_calculation_runs.scope MUST be 'all' for a full recalc (button posts {scope: 'all'})",
        ).toBe("all");
        expect(
          dbRun!.status,
          "score_calculation_runs.status MUST be 'succeeded' after the Edge Function completes",
        ).toBe("succeeded");
        expect(
          dbRun!.completed_at,
          "score_calculation_runs.completed_at MUST be non-null when status='succeeded' (table CHECK score_calculation_runs_succeeded_completeness)",
        ).not.toBeNull();
        expect(
          dbRun!.calculation_version_written,
          "score_calculation_runs.calculation_version_written MUST be non-null when status='succeeded' (table CHECK)",
        ).not.toBeNull();
        expect(
          dbRun!.affected_record_count,
          "score_calculation_runs.affected_record_count MUST be a non-negative integer when status='succeeded'",
        ).toBeGreaterThanOrEqual(0);
      },
    );
  },
);
