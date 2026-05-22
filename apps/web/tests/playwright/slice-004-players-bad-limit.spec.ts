// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/players?limit=99999 400 BAD_REQUEST.
// --------------------------------------------------------------------------
// RED acceptance test for the malformed-query-param branch of GET /api/players.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/players § Request — `limit` clamped to [1, 500].
//   - § Test surface — slice-004-players-bad-limit: ?limit=999999 → 400
//     (clamp-then-reject: pick 400 for explicit feedback).
//   - § Server behavior step 2 — Validate query params (limit in [1, 500]).
//
// Scenario:
//   Sign in as alpha. GET /api/players?limit=99999. Assert 400 +
//   BAD_REQUEST envelope. Validation MUST happen before the DB query and
//   before any eligibility re-check (a 200 or 403 here would be a contract
//   regression).
//
// RED until T018 ships the /api/players handler with the limit validator.
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
  "US1 — GET /api/players?limit=99999 returns 400 BAD_REQUEST (out of [1,500]) @slice-004 @us1",
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
      "alpha GET /api/players?limit=99999 returns 400 BAD_REQUEST @slice-004 @us1",
      async ({ page, request }) => {
        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        const response = await request.get("/api/players?limit=99999", {
          headers: { Cookie: cookieHeader },
        });

        expect(
          response.status(),
          "limit=99999 (out of [1,500]) MUST be rejected with 400 (contract § 400)",
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
