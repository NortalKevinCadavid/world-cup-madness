// --------------------------------------------------------------------------
// Slice 006 / T011 — `/admin` dashboard eligible-admin happy path (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1):
//
//   "Administrator manually corrects a match score" — the dashboard entry
//   point at /admin must render the five expected layout sections for any
//   authenticated participant whose `admin_roles` row is active.
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § `/admin` — dashboard (Rendered layout: Open Pending Review,
//       Recent Overrides, Last Recalc, Admin Roster sections plus the
//       conditional recalc-pending banner). The dashboard's five
//       server-fetched data sources map 1-to-1 to five `data-testid`
//       attributes asserted here:
//         pending_review_count       → admin-dashboard-section-pending-review
//         recent_overrides           → admin-dashboard-section-recent-overrides
//         last_recalc                → admin-dashboard-section-last-recalc
//         pending_recalc_state       → admin-dashboard-section-pending-recalc
//         current_admin_count        → admin-dashboard-section-current-admins
//   - specs/006-admin-overrides/spec.md § US1.
//   - apps/web/tests/playwright/slice-005-match-scoring.spec.ts — admin1
//     persona pattern (T008 modified).
//   - apps/web/tests/playwright/helpers/admin-roles.ts — defensive
//     ensureAdminRole helper (T008).
//
// Cleanup contract:
//   beforeEach resets the stub and ensures admin1's `admin_roles` row is
//   active. afterEach resets the stub and re-asserts admin1's active
//   admin_roles row (defensive: in case a sibling test revoked mid-run).
//   No DB rows are mutated by this test; no further cleanup needed.
//
// RED-by-design until:
//   - T015 ships `apps/web/app/admin/layout.tsx` + `/admin/denied/page.tsx`.
//   - T016 ships `apps/web/app/admin/page.tsx` (the dashboard) emitting
//     the five `data-testid` attributes above.
//   Until both land, `page.goto('/admin')` will surface a 404 from
//   Next.js and the data-testid `waitForSelector` will time out.
//
// Selectors implied (T016 contract):
//   - [data-testid="admin-dashboard-section-pending-review"]
//   - [data-testid="admin-dashboard-section-recent-overrides"]
//   - [data-testid="admin-dashboard-section-last-recalc"]
//   - [data-testid="admin-dashboard-section-pending-recalc"]
//   - [data-testid="admin-dashboard-section-current-admins"]
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { ensureAdminRole } from "./helpers/admin-roles";

// admin1's auth.users `sub` (slice-005-fixture.sql § 1).
const ADMIN1 = {
  sub: "00000000-0000-0000-0000-0000000000d3",
  email: "admin1@nortal.com",
  email_verified: true,
  name: "Admin One",
} as const;

// admin1's participants.id (slice-005-fixture.sql § 2 line 248).
const ADMIN1_PARTICIPANT_ID = "77777777-7777-7777-7777-777777777777";

const DASHBOARD_SECTIONS: ReadonlyArray<string> = [
  "admin-dashboard-section-pending-review",
  "admin-dashboard-section-recent-overrides",
  "admin-dashboard-section-last-recalc",
  "admin-dashboard-section-pending-recalc",
  "admin-dashboard-section-current-admins",
];

test.describe(
  "US1 — /admin dashboard renders for eligible admin @slice-006 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test.afterEach(async () => {
      await resetStub();
      // Defensive: another test in the suite may have revoked admin1.
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 signs in and visits /admin; the page loads (200) and renders all five dashboard sections @slice-006 @us1",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        const response = await page.goto("/admin");

        expect(
          response,
          "page.goto('/admin') MUST return a Response object (not null) — Next.js served the route",
        ).not.toBeNull();
        expect(
          response!.status(),
          "/admin MUST return 200 for an active admin (admin-ui.surface.md § `/admin` — dashboard)",
        ).toBe(200);

        // Final URL MUST still be /admin — not redirected to /admin/denied.
        const finalPath = new URL(page.url()).pathname;
        expect(
          finalPath,
          `Final URL pathname MUST be '/admin' for an active admin (got '${finalPath}')`,
        ).toBe("/admin");

        // All five dashboard sections MUST be present in the DOM.
        for (const testId of DASHBOARD_SECTIONS) {
          const locator = page.locator(`[data-testid="${testId}"]`);
          await expect(
            locator,
            `[data-testid="${testId}"] MUST be present in /admin DOM ` +
              `(admin-ui.surface.md § Rendered layout — Open Pending Review / Recent Overrides / Last Recalc / Admin Roster + pending-recalc banner)`,
          ).toBeVisible();
        }
      },
    );
  },
);
