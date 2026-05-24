// --------------------------------------------------------------------------
// Slice 003 / T011 — `POST /api/predictions` 404 invalid-match path.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) Acceptance Scenario 3:
//
//   "Given an eligible participant, when they attempt to submit a
//    prediction for a match they are not authorized to predict on (e.g.,
//    the match does not exist or has been cancelled), then the request
//    MUST be rejected with a clear reason and no record MUST be created."
//
// Source of truth:
//   `specs/003-match-predictions/contracts/predictions.write.md` § 404
//   "MATCH_NOT_FOUND — Match not found." and § Server behavior step 4.
//
// Scenario:
//   POST /api/predictions with match_id = all-zeros UUID (guaranteed
//   absent from the slice-002 fixture, which uses bbbb000000-...). Expect
//   404 with body { error: { code: 'MATCH_NOT_FOUND', message: ... } }.
//
// RED until T015 ships the route handler that performs the
//   SELECT 1 FROM matches WHERE id = body.match_id
// check and returns 404 on zero rows.
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

// All-zeros UUID — syntactically valid, semantically absent from the
// matches fixture (slice-002 uses bbbb0000-... namespace).
const ABSENT_MATCH_UUID = "00000000-0000-0000-0000-000000000000";

test.describe(
  "US1 — POST /api/predictions 404 invalid match @slice-003 @us1",
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
      "POST with a syntactically-valid but non-existent match_id MUST be 404 MATCH_NOT_FOUND @slice-003 @us1",
      async ({ page, request }) => {
        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const response = await request.post("/api/predictions", {
          headers: { Cookie: cookieHeader },
          data: { match_id: ABSENT_MATCH_UUID, home: 2, away: 1 },
        });

        expect(
          response.status(),
          "absent match_id MUST be rejected with 404 (contract § 404 MATCH_NOT_FOUND)",
        ).toBe(404);

        const body = (await response.json()) as unknown;
        expect(body).toMatchObject({
          error: {
            code: "MATCH_NOT_FOUND",
            message: expect.any(String),
          },
        });

        // The 404 body MUST NOT reveal which matches the caller could see
        // — only that this one was not found. Defense against enumeration.
        const rawText = JSON.stringify(body);
        expect(
          rawText,
          "404 body MUST NOT leak any other match's UUID",
        ).not.toMatch(/bbbb0000-0000-0000-0000-/i);
      },
    );
  },
);
