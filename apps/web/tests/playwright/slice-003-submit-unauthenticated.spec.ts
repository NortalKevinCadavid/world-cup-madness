// --------------------------------------------------------------------------
// Slice 003 / T011 — `POST /api/predictions` 401 unauthenticated path.
// --------------------------------------------------------------------------
// RED acceptance test for the no-session branch of the prediction-submit
// route handler. Source of truth:
//   `specs/003-match-predictions/contracts/predictions.write.md` § 401
//   "UNAUTHENTICATED — Sign in to continue." and § Server behavior step 1
//   (parse session cookie; absent → 401).
//
// Reuses the canonical envelope shape established by Slice 001's /api/me
// 401 path (the message string is identical — "Sign in to continue.").
//
// Setup:
//   This test deliberately does NOT sign in. The OIDC stub is reset, the
//   browser context is created via `browser.newContext()` so we are
//   guaranteed to have no cookies leaked from sibling tests, and the POST
//   is fired through that anonymous context's request fixture.
//
// RED until T015 ships the route handler.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub } from "./fixtures/oidc";

const M6_USA_JPN_ID = "bbbb0000-0000-0000-0000-000000000006";

test.describe(
  "US1 — POST /api/predictions 401 on missing session @slice-003 @us1",
  () => {
    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "POST /api/predictions with no cookies returns 401 UNAUTHENTICATED @slice-003 @us1",
      async ({ browser }) => {
        // Belt-and-braces: a brand-new context guarantees no cookies are
        // inherited from any prior test in the worker.
        const context = await browser.newContext();
        try {
          await context.clearCookies();
          const response = await context.request.post(
            "http://localhost:3000/api/predictions",
            {
              data: { match_id: M6_USA_JPN_ID, home: 1, away: 0 },
            },
          );

          expect(
            response.status(),
            "POST /api/predictions with no JWT must be 401 (contract § 401)",
          ).toBe(401);

          const body = (await response.json()) as unknown;
          expect(body).toMatchObject({
            error: {
              code: "UNAUTHENTICATED",
              message: expect.any(String),
            },
          });

          // Pin the message — Slice 001 owns the canonical wording.
          expect((body as { error: { message: string } }).error.message).toBe(
            "Sign in to continue.",
          );

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
