// --------------------------------------------------------------------------
// Slice 006 / T019 — `/admin/recalc` concurrent-trigger 409 path (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 2 (P1) Edge Case:
//
//   "A recalculation is triggered while a previous recalculation is still
//    running → only one recalculation per scope MUST run at a time; the
//    second MUST queue or be skipped with a clear status."
//
// And admin-rpcs.write.md WAR06 → HTTP 409 mapping (admin_trigger_recalc
// step 7: on Slice 005's 409 from the advisory lock, the SP raises WAR06;
// the route handler at /api/admin/recalc maps WAR06 → 409).
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md
//       § `admin_trigger_recalc` step 7 + ERRCODE WAR06.
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § /admin/recalc Test surface row 2.
//   - specs/006-admin-overrides/spec.md § US2 Edge Cases.
//
// Persona: admin1.
//
// Pre-state strategy:
//   We do NOT race two real recalcs (timing-fragile and the score-trigger
//   Edge Function for a full-tournament run might finish before we can
//   land the second click). Instead, we insert a synthetic
//   score_calculation_runs row with status='running' and a recent
//   started_at via service-role. The advisory-lock collision the SP
//   detects in step 7 is keyed off the existence of a running row for the
//   same scope — so the inserted row simulates the "first recalc still
//   in-flight" state precisely without needing real timing control.
//
// Cleanup contract:
//   beforeEach: resetStub + ensureAdminRole(admin1) + INSERT the synthetic
//   'running' row + capture testStartInstant.
//   afterEach: DELETE that synthetic row + any rows created since
//   testStartInstant + DELETE score_records since testStartInstant.
//   resetStub + ensureAdminRole defensive.
//
// RED-by-design until:
//   - T021 ships `admin_trigger_recalc` SP at slot 0070 (must raise WAR06
//     when a running row already exists for the same scope).
//   - T025 ships the `/api/admin/recalc` route handler (must map WAR06 →
//     HTTP 409) and the `/admin/recalc` page (must render the trigger
//     button + 409 error inline).
//
// Selectors implied (T025 MUST honor):
//   - [data-testid="trigger-recalc-button"]
//   - [data-testid="recalc-error"]
//       Inline error region surfaced when /api/admin/recalc returns a
//       non-2xx status. textContent MUST include the human-friendly 409
//       message (something matching /concurrent|in flight|already.*running/i
//       per admin-rpcs.write.md § ERRCODE WAR06).
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

// Deterministic UUID for the synthetic 'running' row. Picked from a
// reserved test-only block (eeee0070-...) so cleanup is keyed by id even
// if multiple workers race.
const SYNTHETIC_RUN_ID = "eeee0070-0006-0019-0002-000000000001";

async function insertSyntheticRunningRun(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.from("score_calculation_runs").insert({
    id: SYNTHETIC_RUN_ID,
    scope: "all",
    target_id: null,
    trigger: "admin_recalc",
    triggered_by: ADMIN1_PARTICIPANT_ID,
    reason: "T019 concurrent-blocked synthetic pre-state",
    status: "running",
    // started_at defaults to now() — explicit not required, but we set it
    // so any clock-skew assertion in the test stays deterministic.
    started_at: new Date().toISOString(),
  });
  if (error) {
    throw new Error(
      `insertSyntheticRunningRun: ${error.message}. ` +
        `Confirm migration 0050 (score_calculation_runs) is applied.`,
    );
  }
}

async function deleteSyntheticRunningRun(): Promise<void> {
  const client = getServiceClient();
  // Idempotent: tolerates "already gone".
  const { error } = await client
    .from("score_calculation_runs")
    .delete()
    .eq("id", SYNTHETIC_RUN_ID);
  if (error) {
    throw new Error(`deleteSyntheticRunningRun: ${error.message}`);
  }
}

async function countRunsSince(since: Date): Promise<number> {
  const client = getServiceClient();
  const { count, error } = await client
    .from("score_calculation_runs")
    .select("id", { count: "exact", head: true })
    .gte("started_at", since.toISOString());
  if (error) {
    throw new Error(`countRunsSince: ${error.message}`);
  }
  return count ?? 0;
}

test.describe(
  "US2 — concurrent recalc blocked with 409 inline error @slice-006 @us2",
  () => {
    test.setTimeout(60_000);

    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      // Defensive: in case a previous run failed to clean up.
      await deleteSyntheticRunningRun();
      testStartInstant = new Date();
      await insertSyntheticRunningRun();
    });

    test.afterEach(async () => {
      // Remove the synthetic row + any NEW rows that this test (or a buggy
      // SP under test) accidentally created.
      await deleteSyntheticRunningRun();
      const client = getServiceClient();
      const { error: cleanRuns } = await client
        .from("score_calculation_runs")
        .delete()
        .gte("started_at", testStartInstant.toISOString());
      if (cleanRuns) {
        throw new Error(`afterEach score_calculation_runs cleanup: ${cleanRuns.message}`);
      }
      const { error: cleanRecs } = await client
        .from("score_records")
        .delete()
        .gte("calculated_at", testStartInstant.toISOString());
      if (cleanRecs) {
        throw new Error(`afterEach score_records cleanup: ${cleanRecs.message}`);
      }
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 triggers a second recalc while one is already 'running' → /api/admin/recalc returns 409; [data-testid=\"recalc-error\"] surfaces the WAR06 message; no new score_calculation_runs row was created @slice-006 @us2",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        const pageResponse = await page.goto("/admin/recalc");
        expect(
          pageResponse,
          "page.goto('/admin/recalc') MUST return a Response object",
        ).not.toBeNull();
        expect(
          pageResponse!.status(),
          "/admin/recalc MUST return 200 for an active admin even when a recalc is already running",
        ).toBe(200);

        // Baseline: at this moment exactly ONE running row exists (the
        // synthetic one we inserted in beforeEach). If T025's SSR fetch
        // races and shows zero, the rest of this test still meaningfully
        // exercises the SP's WAR06 path, so we don't assert on the
        // SSR-rendered count here.
        const baselineCount = await countRunsSince(testStartInstant);
        expect(
          baselineCount,
          "Pre-trigger: exactly 1 score_calculation_runs row (the synthetic 'running' row) MUST exist since testStartInstant",
        ).toBe(1);

        // Click the trigger; intercept the POST.
        const triggerButton = page.locator(
          '[data-testid="trigger-recalc-button"]',
        );
        await expect(
          triggerButton,
          "[data-testid=\"trigger-recalc-button\"] MUST be visible on /admin/recalc",
        ).toBeVisible();

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
          "POST /api/admin/recalc MUST return 409 when a recalc with status='running' already exists (WAR06 → 409 per admin-rpcs.write.md § HTTP route handlers)",
        ).toBe(409);

        // The inline error region MUST surface a human-readable concurrent
        // / in-flight message.
        const errorEl = page.locator('[data-testid="recalc-error"]');
        await expect(
          errorEl,
          "[data-testid=\"recalc-error\"] MUST be visible after a 409 response (T025 RecalcStatusLive surfaces WAR06 inline)",
        ).toBeVisible({ timeout: 10_000 });
        await expect(
          errorEl,
          "[data-testid=\"recalc-error\"] textContent MUST match /concurrent|in flight|already.*running/i (WAR06 user-facing message)",
        ).toHaveText(/concurrent|in flight|already.*running/i);

        // Service-role verify: no NEW score_calculation_runs row was
        // created — only the synthetic pre-state row exists.
        const afterCount = await countRunsSince(testStartInstant);
        expect(
          afterCount,
          "After the rejected trigger: count of score_calculation_runs rows since testStartInstant MUST still be 1 (the synthetic row); no new row created",
        ).toBe(1);
      },
    );
  },
);
