// --------------------------------------------------------------------------
// Slice 003 / T011 — `GET /api/me/predictions?match_id=<not-a-uuid>` 400.
// --------------------------------------------------------------------------
// RED acceptance test for the malformed-query-param branch of the
// /api/me/predictions GET handler.
//
// Source of truth:
//   - specs/003-match-predictions/contracts/predictions.read.md § 400 Bad
//     Request: { error: { code: 'BAD_REQUEST', message: 'match_id must
//     be a valid UUID' } }
//   - § Server behavior step 2: "Validate `match_id` param shape (if
//     present); invalid → 400." Validation happens BEFORE eligibility
//     re-check.
//
// Scenario:
//   Sign in as alpha. GET /api/me/predictions?match_id=not-a-uuid. Assert
//   400 + BAD_REQUEST envelope. The validation MUST happen before the
//   eligibility re-check (a 403 here would be a security regression).
//
// RED until T015 ships the /api/me/predictions GET handler with zod
// validation on the match_id query param.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

test.describe(
  "US1 — GET /api/me/predictions 400 on malformed match_id @slice-003 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async ({ page }) => {
      await resetStub();
      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA.sub,
          email: ALPHA.email,
          email_verified: ALPHA.email_verified,
          name: ALPHA.name,
        },
      });
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "GET ?match_id=not-a-uuid returns 400 BAD_REQUEST @slice-003 @us1",
      async ({ request }) => {
        const response = await request.get(
          "/api/me/predictions?match_id=not-a-uuid",
        );

        expect(
          response.status(),
          "malformed match_id MUST be rejected with 400 (contract § 400)",
        ).toBe(400);

        const body = (await response.json()) as unknown;
        expect(body).toMatchObject({
          error: {
            code: "BAD_REQUEST",
            message: expect.any(String),
          },
        });

        // Defense-in-depth — no stack trace.
        const rawText = JSON.stringify(body);
        expect(
          rawText,
          "400 body MUST NOT contain a stack frame",
        ).not.toMatch(/at\s+\S+\s+\(/);
      },
    );
  },
);
