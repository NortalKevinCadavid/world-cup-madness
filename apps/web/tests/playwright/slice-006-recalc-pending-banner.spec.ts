// --------------------------------------------------------------------------
// Slice 006 / T019 — `/admin` pending-recalc banner lifecycle (RED).
// --------------------------------------------------------------------------
// RED acceptance test for FR-010 + spec § Edge Cases:
//
//   "A scoring-value configuration change is applied without a subsequent
//    recalculation → the leaderboard MUST surface a 'scoring values
//    changed; recalculation pending' state until an administrator triggers
//    the re-score."
//
// And data-model.md § Pending Recalc State VIEW (the `recalc_pending`
// boolean is true when any audit_log row with action LIKE
// 'tournament_config.scoring%' has occurred_at > the most recent
// score_calculation_runs.completed_at where status='succeeded').
//
// Test design:
//   1. Service-role: INSERT an audit_log row with
//      action='tournament_config.scoring.match_points.exact', source='admin_rpc',
//      occurred_at=now(). This simulates a Slice 008 scoring-config change
//      that hasn't yet been picked up by a recalc. The view's predicate
//      then makes `recalc_pending = true`.
//   2. Sign in as admin1 and navigate to `/admin` (dashboard).
//   3. Assert: `[data-testid="recalc-pending-banner"]` is visible.
//   4. Click the trigger button on the banner (or navigate to /admin/recalc
//      and trigger). Wait for completion (Realtime status='succeeded').
//   5. Refresh /admin.
//   6. Assert: the banner is gone (the recalc's completed_at now exceeds
//      the audit row's occurred_at; the view returns recalc_pending=false).
//
// Source of truth:
//   - specs/006-admin-overrides/data-model.md § Pending Recalc State VIEW
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md § /admin
//     dashboard (Rendered layout: "[Banner if pending_recalc_state.recalc_pending = true]")
//   - specs/006-admin-overrides/spec.md § Edge Cases
//
// Persona: admin1.
//
// Cleanup contract:
//   beforeEach: resetStub + ensureAdminRole(admin1) + capture
//   testStartInstant + INSERT the synthetic config-change audit row.
//   afterEach: DELETE that audit row (the row carries a known id we
//   captured at insert); DELETE every score_calculation_runs row
//   started_at >= testStartInstant; DELETE every score_records row
//   calculated_at >= testStartInstant. resetStub + ensureAdminRole.
//
// Caveat on audit_log mutation: Slice 007's append-only contract is NOT
// enforced for service-role today (RLS-bypass), so this DELETE works. If
// Slice 007 later adds a trigger-level append-only guard the cleanup
// strategy will switch to an isolation marker (e.g., a sentinel reason
// string) — for now, direct DELETE keyed by id is correct.
//
// RED-by-design until:
//   - T016 (already shipped per T015 layout) + T025 surface the
//     `[data-testid="recalc-pending-banner"]` element on the dashboard
//     when `pending_recalc_state.recalc_pending = true`.
//   - T022 ships the `pending_recalc_state` VIEW at slot 0071.
//   - T021 + T025 ship the trigger endpoint so the banner-clear path
//     works end-to-end.
//
// Selectors implied (T025 / T016 MUST honor):
//   - [data-testid="recalc-pending-banner"]
//       Wrapper on the conditional banner at the top of /admin.
//   - [data-testid="recalc-pending-banner-trigger"]
//       The "Trigger Recalc" button inside the banner. If T025 instead
//       routes users to /admin/recalc rather than inlining a button, the
//       test falls back to navigating there explicitly.
//   - [data-testid="trigger-recalc-button"]  (on /admin/recalc)
//   - [data-testid="recalc-status-value"]    (on /admin/recalc)
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

const CONFIG_CHANGE_ACTION = "tournament_config.scoring.match_points.exact";

interface InsertedAuditRow {
  id: string;
}

async function insertConfigChangeAuditRow(): Promise<InsertedAuditRow> {
  const client = getServiceClient();
  // Source 'admin_rpc' was admitted into the audit_log.source CHECK by
  // migration 0064 (Slice 006 / T013); occurred_at defaults to now().
  const { data, error } = await client
    .from("audit_log")
    .insert({
      actor: ADMIN1_PARTICIPANT_ID,
      action: CONFIG_CHANGE_ACTION,
      entity_type: "tournament_config",
      entity_id: null,
      previous_value: { value: 10 },
      new_value: { value: 15 },
      reason: "T019 pending-banner synthetic config change",
      source: "admin_rpc",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertConfigChangeAuditRow: ${error?.message ?? "no row returned"}. ` +
        `Confirm migrations 0003 (audit_log) + 0064 (admin_rpc source) are applied.`,
    );
  }
  return { id: data.id as string };
}

async function deleteAuditRow(id: string): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.from("audit_log").delete().eq("id", id);
  if (error) {
    throw new Error(`deleteAuditRow(${id}): ${error.message}`);
  }
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
  "US2 — /admin pending-recalc banner appears after config change and disappears after recalc completes @slice-006 @us2",
  () => {
    // Banner-clear path includes a full recalc — 5-minute envelope.
    test.setTimeout(5 * 60 * 1000);

    let testStartInstant: Date;
    let auditRowId: string;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      testStartInstant = new Date();
      const inserted = await insertConfigChangeAuditRow();
      auditRowId = inserted.id;
    });

    test.afterEach(async () => {
      if (auditRowId) {
        await deleteAuditRow(auditRowId);
      }
      await purgeScoringRowsSince(testStartInstant);
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "after a tournament_config.scoring.* audit row is emitted, /admin shows the recalc-pending banner; after triggering a recalc to completion, the banner is gone @slice-006 @us2",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        // 1) Banner visible on /admin.
        const dashboardResponse = await page.goto("/admin");
        expect(
          dashboardResponse,
          "page.goto('/admin') MUST return a Response object",
        ).not.toBeNull();
        expect(
          dashboardResponse!.status(),
          "/admin MUST return 200 for an active admin",
        ).toBe(200);

        const banner = page.locator('[data-testid="recalc-pending-banner"]');
        await expect(
          banner,
          "[data-testid=\"recalc-pending-banner\"] MUST be visible on /admin when pending_recalc_state.recalc_pending = true (admin-ui.surface.md § Rendered layout — Banner if pending_recalc_state.recalc_pending = true)",
        ).toBeVisible();

        // 2) Trigger a recalc. Prefer the in-banner button if T025 ships
        // one; otherwise navigate to /admin/recalc and click there.
        const bannerTrigger = page.locator(
          '[data-testid="recalc-pending-banner-trigger"]',
        );
        const bannerTriggerCount = await bannerTrigger.count();

        let postResponsePromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/admin/recalc") &&
            r.request().method() === "POST",
          { timeout: 15_000 },
        );

        if (bannerTriggerCount > 0) {
          await bannerTrigger.click();
        } else {
          // Fallback: navigate to /admin/recalc and click the trigger button.
          await page.goto("/admin/recalc");
          // Re-set the waitForResponse after navigation so it observes the
          // post-navigation POST rather than any pre-navigation transient.
          postResponsePromise = page.waitForResponse(
            (r) =>
              r.url().includes("/api/admin/recalc") &&
              r.request().method() === "POST",
            { timeout: 15_000 },
          );
          await page.locator('[data-testid="trigger-recalc-button"]').click();
        }

        const postResponse = await postResponsePromise;
        expect(
          postResponse.status(),
          "POST /api/admin/recalc MUST return 200 when triggered from the banner / recalc page",
        ).toBe(200);

        // 3) Wait for the recalc to succeed. If we're on /admin/recalc the
        // live status component reflects it; if we're still on /admin
        // after an in-banner click we navigate explicitly.
        if (new URL(page.url()).pathname !== "/admin/recalc") {
          await page.goto("/admin/recalc");
        }
        const statusEl = page.locator('[data-testid="recalc-status-value"]');
        await expect(
          statusEl,
          "[data-testid=\"recalc-status-value\"] MUST be visible on /admin/recalc after triggering",
        ).toBeVisible({ timeout: 10_000 });
        await expect(
          statusEl,
          "Realtime status MUST transition to 'succeeded' within 5 minutes (banner-clear depends on a 'succeeded' completed_at)",
        ).toHaveText(/succeeded/i, { timeout: 5 * 60 * 1000 });

        // 4) Refresh /admin; banner MUST be gone.
        const refreshResponse = await page.goto("/admin");
        expect(
          refreshResponse!.status(),
          "/admin MUST still return 200 after the recalc completes",
        ).toBe(200);

        await expect(
          page.locator('[data-testid="recalc-pending-banner"]'),
          "[data-testid=\"recalc-pending-banner\"] MUST NOT be visible after the recalc completes (the view's completed_at now exceeds the audit row's occurred_at; recalc_pending=false)",
        ).toHaveCount(0);
      },
    );
  },
);
