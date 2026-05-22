// --------------------------------------------------------------------------
// Slice 001 / T029 — `/api/me` 403 path on mid-session domain removal.
// --------------------------------------------------------------------------
// RED acceptance test for US2 Acceptance Scenario 2 +
// Clarifications 2026-05-15 (mid-session deny).
//
// Setup:
//   1. Sign in as alpha@nortal.com (fixture row, ACTIVE).
//   2. Flip `tournament_config.eligibility.approved_domains` to `[]` via
//      the service-role helper.
//   3. GET /api/me from the same authenticated session.
//
// Then-clauses:
//   1. Status code 403 (contracts/participant-me.read.md § 403).
//   2. Body `{ error: { code: 'DOMAIN_NOT_APPROVED', message: <string> } }`.
//   3. `Cache-Control: private, max-age=0, must-revalidate`.
//   4. An `audit_log` row exists with
//      `action='access.denied', reason='domain_not_approved',
//      source='api_guard'` (contract § Server behavior step 2 +
//      FR-006).
//
// The config is restored in `afterEach` so a failed assertion cannot
// poison sibling tests; `withTemporaryConfig` further guarantees the
// restore even on test crash.
//
// RED until T033 (audit row write on the API-guard path) and T034 (the
// per-request eligibility predicate call wired into requireEligible).
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import {
  readAuditLog,
  withTemporaryConfig,
} from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

test.describe(
  "US2 — /api/me 403 on mid-session domain removal @slice-001 @us2",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
      // `withTemporaryConfig` already restores on the happy + crash paths.
      // The afterEach here is belt-and-braces for the case where the test
      // body throws BEFORE entering withTemporaryConfig (e.g. sign-in
      // failure). That branch leaves the config untouched, so no extra
      // work is required.
    });

    test(
      "AS-2 — mid-session domain removal flips /api/me to 403 + audits the denial @slice-001 @us2",
      async ({ page, request }) => {
        // Step 1 — sign in as an eligible participant.
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        // Sanity — the session can fetch /api/me successfully BEFORE the
        // domain is removed. Asserts the test setup is correctly wired.
        const sanity = await request.get("/api/me");
        expect(
          sanity.status(),
          "alpha's pre-removal /api/me call must be 200 (sanity check)",
        ).toBe(200);

        // Capture the wall-clock floor for the audit-row query.
        const removalStartedAt = new Date(Date.now() - 1_000);

        // Step 2 + 3 — flip the approved-domain list to [] and re-call /api/me
        // INSIDE the withTemporaryConfig block so the snapshot/restore
        // brackets the assertion regardless of pass / fail / crash.
        await withTemporaryConfig(
          "eligibility.approved_domains",
          [],
          async () => {
            const response = await request.get("/api/me");

            // Then 1 — status 403.
            expect(
              response.status(),
              "Clarifications 2026-05-15: post-removal /api/me MUST be 403",
            ).toBe(403);

            // Then 2 — body shape.
            const body = (await response.json()) as unknown;
            expect(body).toMatchObject({
              error: {
                code: "DOMAIN_NOT_APPROVED",
                message: expect.any(String),
              },
            });
            expect(
              (body as { error: { message: string } }).error.message,
            ).toBe(
              "This application is restricted to approved Nortal corporate identities.",
            );

            // Then 3 — cache-control per § Caching posture.
            expect(response.headers()["cache-control"]).toBe(
              "private, max-age=0, must-revalidate",
            );

            // Then 4 — audit row from the API guard layer.
            const rows = await readAuditLog({
              action: "access.denied",
              reason: "domain_not_approved",
              source: "api_guard",
              since: removalStartedAt,
            });
            expect(
              rows.length,
              "FR-006: API-guard MUST write an audit row on mid-session denial (T033)",
            ).toBeGreaterThanOrEqual(1);
          },
        );

        // After the helper restores the config, /api/me should recover.
        // This is not a contract assertion per se; it's a self-check that
        // the test cleanup actually restored eligibility. If it fails the
        // helper restore is broken and CI will catch it before this
        // poisons sibling tests.
        const recovered = await request.get("/api/me");
        expect(
          recovered.status(),
          "post-restore /api/me must return 200 again (helper sanity)",
        ).toBe(200);
      },
    );
  },
);
