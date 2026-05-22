// --------------------------------------------------------------------------
// Slice 003 / T011 — `GET /api/me/predictions` 401 on missing session.
// --------------------------------------------------------------------------
// RED acceptance test for the no-session branch of GET /api/me/predictions.
//
// Source of truth:
//   - specs/003-match-predictions/contracts/predictions.read.md § 401
//     "Same body shape as /api/me (Slice 001)" — i.e.
//     { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }
//   - § Server behavior step 1: "Parse Supabase session cookie. Absent → 401."
//
// Setup:
//   Deliberately do NOT sign in. Use a fresh browser context to ensure no
//   sibling test leaks a Supabase cookie.
//
// RED until T015 ships the /api/me/predictions GET handler.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub } from "./fixtures/oidc";

test.describe(
  "US1 — GET /api/me/predictions 401 on missing session @slice-003 @us1",
  () => {
    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "GET /api/me/predictions with no cookies returns 401 UNAUTHENTICATED @slice-003 @us1",
      async ({ browser }) => {
        const context = await browser.newContext();
        try {
          await context.clearCookies();
          const response = await context.request.get(
            "http://localhost:3000/api/me/predictions",
          );

          expect(
            response.status(),
            "GET /api/me/predictions with no JWT must be 401",
          ).toBe(401);

          const body = (await response.json()) as unknown;
          expect(body).toMatchObject({
            error: {
              code: "UNAUTHENTICATED",
              message: "Sign in to continue.",
            },
          });

          // No debug-header leakage.
          const headers = response.headers();
          for (const name of Object.keys(headers)) {
            expect(
              name.toLowerCase(),
              `response header "${name}" must not be a debug header`,
            ).not.toMatch(/^x-debug/i);
          }
        } finally {
          await context.close();
        }
      },
    );
  },
);
