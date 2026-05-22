// --------------------------------------------------------------------------
// Slice 004 / T014 — `GET /api/me/final-predictions` 401 on missing session.
// --------------------------------------------------------------------------
// RED acceptance test for the no-session branch of GET
// /api/me/final-predictions, mirroring slice 001's /api/me 401 and slice
// 003's /api/me/predictions 401 envelope.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md § 401
//     `{error: {code: 'UNAUTHENTICATED', ...}}`.
//
// Setup:
//   Deliberately do NOT sign in. Use a fresh browser context to ensure no
//   sibling test leaks a Supabase cookie.
//
// RED until T018 ships the /api/me/final-predictions GET handler.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub } from "./fixtures/oidc";

test.describe(
  "US1 — GET /api/me/final-predictions 401 on missing session @slice-004 @us1",
  () => {
    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "GET /api/me/final-predictions with no cookies returns 401 UNAUTHENTICATED @slice-004 @us1",
      async ({ browser }) => {
        const context = await browser.newContext();
        try {
          await context.clearCookies();
          const response = await context.request.get(
            "http://localhost:3000/api/me/final-predictions",
          );

          expect(
            response.status(),
            "GET /api/me/final-predictions with no JWT must be 401",
          ).toBe(401);

          const body = (await response.json()) as unknown;
          expect(body).toMatchObject({
            error: {
              code: "UNAUTHENTICATED",
              message: expect.any(String),
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

          // No stack-frame leakage in body.
          const rawText = JSON.stringify(body);
          expect(
            rawText,
            "401 body MUST NOT contain a stack frame",
          ).not.toMatch(/at\s+\S+\s+\(/);
        } finally {
          await context.close();
        }
      },
    );
  },
);
