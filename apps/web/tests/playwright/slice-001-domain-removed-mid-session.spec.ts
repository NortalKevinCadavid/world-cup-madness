// --------------------------------------------------------------------------
// Slice 001 / T036 — Edge Case E-3 (long-running-session variant).
//   "Domain removed mid-session: existing session is denied on next request;
//    participant data is preserved; access is restored when the config is."
// --------------------------------------------------------------------------
// RED acceptance test for Edge Case E-3 of
// `specs/001-eligibility-login/spec.md`:
//
//   A previously-eligible participant's domain is removed from the
//   approved list mid-tournament. Their existing predictions and audit
//   history MUST be preserved, but new requests MUST be denied. Their
//   *currently active* session MUST be denied on its next authenticated
//   request (read or write) — the predicate re-evaluation produces a 403
//   and the next navigation renders the denial screen; the JWT itself is
//   not server-side revoked.
//
// Then-clauses asserted in this file:
//   1. Inside `withTemporaryConfig('eligibility.approved_domains', [], ...)`
//      navigating to `/dashboard` from the existing authenticated session
//      lands on `/auth/denied?reason=domain_not_approved`.
//   2. Alpha's `participants` row STILL exists (data preserved — only
//      access is denied; per the spec "do not silently delete data").
//   3. An `audit_log` row with `action='access.denied'`, `source='api_guard'`
//      exists for the denied dashboard read.
//   4. After `withTemporaryConfig` restores the config, the same session
//      can navigate to `/dashboard` again successfully.
//
// --------------------------------------------------------------------------
// Spec deviations
// --------------------------------------------------------------------------
// D-T036-D: The dashboard read path (`getCurrentParticipant` →
//   `requireEligible`) lands in T034. Until T034 + T040 ship, this test is
//   RED. The companion API-only variant of this scenario lives in
//   `slice-001-api-me-403-domain-removed.spec.ts`.
//
// D-T036-E: This file does NOT assert on Slice 003 (predictions) data
//   preservation. The spec text mentions predictions, but those tables
//   land in Slice 003. We assert on the `participants` row preservation,
//   which is the slice-001 scope.
//
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import {
  getServiceClient,
  readAuditLog,
  withTemporaryConfig,
} from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
  region: "EE-North",
} as const;

const DASHBOARD_PATH = "/dashboard";
const DENIED_PATH = "/auth/denied";

test.describe(
  "Edge E-3 — domain removed mid-session denies dashboard read @slice-001 @us3 @edge",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
      // `withTemporaryConfig` already restores the config on both happy and
      // crash paths. No additional cleanup needed here.
    });

    test(
      "AS — mid-session domain removal denies dashboard navigation; participant row preserved; audit row written; restore re-enables access @slice-001 @us3 @edge",
      async ({ page }) => {
        // Step 1 — sign in as alpha. Capture the authenticated session.
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
            region: ALPHA.region,
          },
        });

        // Sanity — the session can hit /dashboard BEFORE the removal.
        await page.goto(DASHBOARD_PATH);
        expect(
          page.url(),
          "alpha's pre-removal /dashboard navigation must land on /dashboard (sanity check)",
        ).toMatch(/\/dashboard(\?|$|#|\/)/);

        // Capture the wall-clock floor for the audit-row query.
        const removalStartedAt = new Date(Date.now() - 1_000);

        // Step 2 — flip the approved-domain list to [] and exercise the
        // mid-session denial inside the bracketed snapshot/restore helper.
        await withTemporaryConfig(
          "eligibility.approved_domains",
          [],
          async () => {
            // Step 3 — navigate the existing session to /dashboard. The
            // page-server `getCurrentParticipant` → `requireEligible` call
            // MUST detect the removed domain and redirect to /auth/denied.
            await page.goto(DASHBOARD_PATH);

            // Wait for the redirect to settle.
            await page.waitForURL(
              (url) => url.pathname.startsWith(DENIED_PATH),
              { timeout: 10_000 },
            );

            // Then 1 — landed on /auth/denied?reason=domain_not_approved.
            const denied = new URL(page.url());
            expect(denied.pathname).toBe(DENIED_PATH);
            expect(denied.searchParams.get("reason")).toBe(
              "domain_not_approved",
            );

            // Then 2 — alpha's participants row is preserved.
            const client = getServiceClient();
            const { count, error } = await client
              .from("participants")
              .select("id", { count: "exact", head: true })
              .eq("auth_user_id", ALPHA.sub);
            if (error) {
              throw new Error(
                `participants count query failed: ${error.message}`,
              );
            }
            expect(
              count,
              "Edge E-3: mid-session denial MUST NOT delete the participant row",
            ).toBe(1);

            // Then 3 — an audit row exists from the api_guard layer.
            const rows = await readAuditLog({
              action: "access.denied",
              source: "api_guard",
              since: removalStartedAt,
            });
            expect(
              rows.length,
              "FR-006: api_guard MUST write an audit row on mid-session denial (T033/T034)",
            ).toBeGreaterThanOrEqual(1);

            // At least one of those rows should reference the
            // domain_not_approved reason (the dashboard read path).
            const dnA = rows.find((r) => r.reason === "domain_not_approved");
            expect(
              dnA,
              "expected an audit row with reason='domain_not_approved' for the denied dashboard read",
            ).toBeDefined();
          },
        );

        // Then 4 — after restore, alpha can return to /dashboard.
        await page.goto(DASHBOARD_PATH);
        await page.waitForURL(
          (url) => url.pathname.startsWith(DASHBOARD_PATH),
          { timeout: 10_000 },
        );
        expect(
          page.url(),
          "post-restore /dashboard navigation MUST succeed (helper sanity)",
        ).toMatch(/\/dashboard(\?|$|#|\/)/);
      },
    );
  },
);
