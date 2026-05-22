// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/teams 401 path on missing session.
// --------------------------------------------------------------------------
// RED acceptance test for the no-session branch of GET /api/teams.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/teams — Errors: 401 / 403 / 500 per the standard
//     error shape.
//
// RED until T018 ships the /api/teams handler with the requireSession()
// guard.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub } from "./fixtures/oidc";

test.describe(
  "US1 — GET /api/teams 401 on missing session @slice-004 @us1",
  () => {
    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "GET /api/teams with no cookies returns 401 UNAUTHENTICATED @slice-004 @us1",
      async ({ browser }) => {
        const context = await browser.newContext();
        try {
          await context.clearCookies();
          const response = await context.request.get(
            "http://localhost:3000/api/teams",
          );

          expect(
            response.status(),
            "GET /api/teams with no JWT MUST be 401",
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
        } finally {
          await context.close();
        }
      },
    );
  },
);
