// --------------------------------------------------------------------------
// Slice 003 / T011 — `POST /api/predictions` 403 on mid-session domain removal.
// --------------------------------------------------------------------------
// RED acceptance test for the eligibility-gate denial branch on the
// prediction-submit route, mirroring Slice 002's
// `slice-002-catalog-403-domain-removed.spec.ts`.
//
// Source of truth:
//   - specs/003-match-predictions/contracts/predictions.write.md § 403
//     "DOMAIN_NOT_APPROVED — ...".
//   - specs/003-match-predictions/contracts/predictions.write.md § Server
//     behavior step 3 — `await requireEligible(client)` runs BEFORE the SP
//     is invoked. On `EligibilityDeniedError` the response is 403.
//
// Setup:
//   1. Sign in as alpha@nortal.com (fixture row, ACTIVE).
//   2. Use the service-role helper `withTemporaryConfig` to flip
//      `eligibility.approved_domains` to `[]` for the duration of the
//      POST.
//   3. Post a syntactically-valid prediction body and assert 403.
//
// The helper restores the config in a finally block, and the afterEach is
// belt-and-braces in case sign-in itself fails before entering the helper.
//
// RED until T015 wires the `requireEligible()` call into the POST handler.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { withTemporaryConfig } from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const M6_USA_JPN_ID = "bbbb0000-0000-0000-0000-000000000006";

test.describe(
  "US1 — POST /api/predictions 403 on mid-session domain removal @slice-003 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "mid-session domain removal flips POST /api/predictions to 403 DOMAIN_NOT_APPROVED @slice-003 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        await withTemporaryConfig(
          "eligibility.approved_domains",
          [],
          async () => {
            const response = await request.post("/api/predictions", {
              data: { match_id: M6_USA_JPN_ID, home: 2, away: 1 },
            });

            expect(
              response.status(),
              "post-removal POST /api/predictions MUST be 403 (contract § 403)",
            ).toBe(403);

            const body = (await response.json()) as unknown;
            expect(body).toMatchObject({
              error: {
                code: "DOMAIN_NOT_APPROVED",
                message: expect.any(String),
              },
            });

            // The 403 body MUST NOT reveal participant identities or
            // admin state, per the contract's § Security invariants.
            const rawText = JSON.stringify(body);
            expect(rawText).not.toMatch(/alpha@nortal\.com/i);
            expect(rawText).not.toMatch(/admin/i);
          },
        );
      },
    );
  },
);
