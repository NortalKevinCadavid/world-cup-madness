// --------------------------------------------------------------------------
// Slice 003 / T011 — `POST /api/predictions` invalid-score validation specs.
// --------------------------------------------------------------------------
// RED acceptance tests for the two distinct score-validation rejection
// paths documented in
// `specs/003-match-predictions/contracts/predictions.write.md`:
//
//   - 400 Bad Request — route-handler zod validation, body shape:
//       { error: { code: 'BAD_REQUEST', message: '...' } }
//     Triggered when home/away violates the schema BEFORE the SP is called
//     (e.g. home = -1 fails `z.number().int().min(0)`).
//
//   - 422 Unprocessable Entity — SP-side rejection (defense-in-depth),
//     body shape:
//       { error: { code: 'INVALID_SCORE', message: '...' } }
//     Triggered when the route-handler validation does not catch the value
//     (e.g. home = 21 is above the configured `score_upper_bound` of 20;
//     contract § Server behavior step 2 reads the bound on cold cache and
//     the SP's RAISE WCM03 also fires as defense-in-depth).
//
// Per the contract, both branches are tested here so the route handler is
// proven to map BOTH WCM03 (SP) → 422 AND zod failure → 400.
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

// M6 USA-JPN — scheduled, alpha has no fixture prediction on this match.
// Using a known-valid match_id removes "match doesn't exist" as a possible
// rejection cause; only the score validation can fire.
const M6_USA_JPN_ID = "bbbb0000-0000-0000-0000-000000000006";

test.describe(
  "US1 — POST /api/predictions invalid score paths @slice-003 @us1",
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
      "home=-1 is rejected with 400 BAD_REQUEST (route-handler zod) @slice-003 @us1",
      async ({ request }) => {
        const response = await request.post("/api/predictions", {
          data: { match_id: M6_USA_JPN_ID, home: -1, away: 0 },
        });

        expect(
          response.status(),
          "negative home score MUST be rejected by route-handler validation BEFORE the SP (contract § 400)",
        ).toBe(400);

        const body = (await response.json()) as unknown;
        expect(body).toMatchObject({
          error: {
            code: "BAD_REQUEST",
            message: expect.any(String),
          },
        });

        // Defense-in-depth — no stack trace leakage.
        const rawText = JSON.stringify(body);
        expect(
          rawText,
          "400 body MUST NOT contain a stack frame",
        ).not.toMatch(/at\s+\S+\s+\(/);
      },
    );

    test(
      "home=21 is rejected with 422 INVALID_SCORE (SP-side, above score_upper_bound=20) @slice-003 @us1",
      async ({ request }) => {
        const response = await request.post("/api/predictions", {
          data: { match_id: M6_USA_JPN_ID, home: 21, away: 0 },
        });

        expect(
          response.status(),
          "score above configured upper bound (default 20) MUST be 422 (contract § 422 INVALID_SCORE / SP WCM03)",
        ).toBe(422);

        const body = (await response.json()) as unknown;
        expect(body).toMatchObject({
          error: {
            code: "INVALID_SCORE",
            message: expect.any(String),
          },
        });
      },
    );
  },
);
