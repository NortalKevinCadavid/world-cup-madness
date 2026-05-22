// --------------------------------------------------------------------------
// Slice 004 / T013 — `POST /api/final-predictions` 403 on mid-session
// domain removal.
// --------------------------------------------------------------------------
// RED acceptance test for the eligibility-gate denial branch on the
// final-predictions submit route, mirroring Slice 002/003 patterns.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § 403 Forbidden: { error: { code: 'DOMAIN_NOT_APPROVED', message } }.
//   - § Server behavior step 3: `await requireEligible(client)` runs
//     BEFORE the SP is invoked. On EligibilityDeniedError the response
//     is 403.
//   - § Security invariants: 403 body MUST NOT reveal participant
//     identity or admin state.
//
// Setup:
//   1. Sign in as alpha@nortal.com (fixture row, ACTIVE).
//   2. Use the service-role helper `withTemporaryConfig` to flip
//      `eligibility.approved_domains` to `[]` for the duration of the
//      POST.
//   3. Post a syntactically-valid prediction body and assert 403.
//
// The helper restores the config in a finally block, and the afterEach
// is belt-and-braces in case sign-in itself fails before entering the
// helper.
//
// Cleanup:
//   The 403 path inserts nothing. resetStub afterEach for hygiene only.
//
// Why alpha (not charlie):
//   The denial branch is identity-agnostic — any signed-in caller whose
//   domain is no longer approved hits it. Using alpha (already proven
//   eligible in slice 001) makes the test's pre-condition clearer.
//
// RED until T018 wires the `requireEligible()` call into the POST
// handler.
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

const POL_TEAM_ID = "aaaa0000-0000-0000-0000-000000000004";

test.describe(
  "US1 — POST /api/final-predictions 403 on mid-session domain removal @slice-004 @us1",
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
      "mid-session domain removal flips POST /api/final-predictions to 403 DOMAIN_NOT_APPROVED @slice-004 @us1",
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
            const response = await request.post("/api/final-predictions", {
              data: {
                item_kind: "champion",
                target_team_id: POL_TEAM_ID,
              },
            });

            expect(
              response.status(),
              "post-removal POST /api/final-predictions MUST be 403 (contract § 403)",
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
