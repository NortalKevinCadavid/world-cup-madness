// --------------------------------------------------------------------------
// Slice 004 / T014 — `GET /api/me/final-predictions` 403 on mid-session
// domain removal.
// --------------------------------------------------------------------------
// RED acceptance test for the eligibility-gate denial branch on the
// final-predictions read route, mirroring slice 002 /api/matches and slice
// 003 /api/predictions 403 contracts.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md § 403
//     `{error: {code: 'DOMAIN_NOT_APPROVED', ...}}` — caller no longer
//     eligible.
//
// Setup:
//   1. Sign in as alpha@nortal.com (fixture row, ACTIVE).
//   2. Use `withTemporaryConfig` to flip
//      `eligibility.approved_domains` to `[]` for the duration of the GET.
//   3. Assert 403 + DOMAIN_NOT_APPROVED envelope.
//
// The helper restores the config in a finally block, and the afterEach is
// belt-and-braces for the case where sign-in itself fails before entering
// the helper.
//
// RED until T018 wires `requireEligible()` into the GET handler.
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

test.describe(
  "US1 — GET /api/me/final-predictions 403 on mid-session domain removal @slice-004 @us1",
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
      "mid-session domain removal flips GET /api/me/final-predictions to 403 DOMAIN_NOT_APPROVED @slice-004 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        await withTemporaryConfig(
          "eligibility.approved_domains",
          [],
          async () => {
            const response = await request.get("/api/me/final-predictions", {
              headers: { Cookie: cookieHeader },
            });

            expect(
              response.status(),
              "post-removal GET /api/me/final-predictions MUST be 403 (contract § 403)",
            ).toBe(403);

            const body = (await response.json()) as unknown;
            expect(body).toMatchObject({
              error: {
                code: "DOMAIN_NOT_APPROVED",
                message: expect.any(String),
              },
            });

            // No identity / admin / stack leakage.
            const rawText = JSON.stringify(body);
            expect(rawText).not.toMatch(/alpha@nortal\.com/i);
            expect(rawText).not.toMatch(/admin/i);
            expect(
              rawText,
              "403 body MUST NOT contain a stack frame",
            ).not.toMatch(/at\s+\S+\s+\(/);
          },
        );
      },
    );
  },
);
