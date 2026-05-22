// --------------------------------------------------------------------------
// Slice 002 / T013 — `GET /api/matches` 400 (bad-params) Playwright spec.
// --------------------------------------------------------------------------
// RED acceptance test for the validation-error branches of the catalog
// route handler.
//
// Source of truth: `specs/002-match-catalog/contracts/match-catalog.read.md`
// § 400 Bad Request:
//
//     { "error": { "code": "BAD_REQUEST", "message": "..." } }
//
// Causes (per the same § 400 section):
//   - `page` ≤ 0 or non-integer
//   - `page_size` outside [1, 200]
//   - `from > to` (inverted window)
//   - `stage` / `status` value not in the allowed enum
//   - `sort` value not in the allowed enum
//
// This spec covers three of those branches (one per test):
//   1. `?page_size=10000`  — well above the 200 cap; contract § Security
//      invariants requires server-side bound; MUST be 400 (NOT a 200 with
//      8 rows, NOT a 200 with the cap silently applied).
//   2. `?from=<later>&to=<earlier>` — inverted half-open window.
//   3. `?stage=unknown-stage` — value not in the allowed enum.
//
// IMPORTANT: validation happens BEFORE the eligibility check (contract §
// Server behavior step 2) "to avoid leaking eligible-but-bad-input
// timing". To exercise the pure-validation path without requiring auth,
// the tests still sign in as alpha; the assertion is purely on the 400
// status + error body shape.
//
// RED until T016 (the `/api/matches` route handler) lands with input
// validation.
// --------------------------------------------------------------------------

import { test, expect, type APIResponse } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

// --------------------------------------------------------------------------
// Persona — alpha@nortal.com is the eligible fixture row.
// --------------------------------------------------------------------------
const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

/**
 * Asserts the contract's exact 400 body shape:
 *   { "error": { "code": "BAD_REQUEST", "message": <string> } }
 * Returns the parsed body so individual tests can pin any
 * branch-specific message wording if they want to.
 */
async function expectBadRequest(
  response: APIResponse,
  context: string,
): Promise<{ error: { code: string; message: string } }> {
  expect(response.status(), `${context}: status MUST be 400`).toBe(400);

  const body = (await response.json()) as unknown;
  expect(body, `${context}: body MUST match the contract § 400 shape`).toMatchObject({
    error: {
      code: "BAD_REQUEST",
      message: expect.any(String),
    },
  });

  // Defense-in-depth: 400 body MUST NOT leak a Node stack trace.
  const rawText = JSON.stringify(body);
  expect(
    rawText,
    `${context}: 400 body must not contain a stack trace`,
  ).not.toMatch(/at\s+\S+\s+\(/);

  return body as { error: { code: string; message: string } };
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US1 — GET /api/matches 400 on bad params @slice-002 @us1", () => {
  test.beforeAll(async () => {
    await assertOidcStubReachable();
  });

  test.beforeEach(async ({ page }) => {
    await resetStub();
    // Validation runs before the eligibility check (contract § Server
    // behavior step 2), but we still sign in so the test path matches
    // production usage and would catch a regression that ordered the
    // checks differently.
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

  // ------------------------------------------------------------------------
  // Bad-param 1 — ?page_size=10000 (above the 200 cap)
  // ------------------------------------------------------------------------
  test(
    "?page_size=10000 returns 400 (above the 200 cap; contract § Security invariants) @slice-002 @us1",
    async ({ request }) => {
      const response = await request.get("/api/matches?page_size=10000");
      const body = await expectBadRequest(response, "page_size=10000");

      // The contract example pins the wording "page_size must be between 1
      // and 200". Pin a lenient containment match here so a copy edit
      // forces a contract update without being too strict about
      // formatting / casing.
      expect(body.error.message.toLowerCase()).toContain("page_size");
    },
  );

  // ------------------------------------------------------------------------
  // Bad-param 2 — ?from=<later>&to=<earlier> (inverted half-open window)
  // ------------------------------------------------------------------------
  test(
    "?from > ?to (inverted window) returns 400 @slice-002 @us1",
    async ({ request }) => {
      const from = "2026-06-20T00:00:00Z"; // later
      const to = "2026-06-10T00:00:00Z"; // earlier

      const response = await request.get(
        `/api/matches?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      const body = await expectBadRequest(response, "from > to");

      // The error message should mention either "from", "to", or "window"
      // so an operator reading logs can immediately understand the cause.
      const msg = body.error.message.toLowerCase();
      expect(
        /\b(from|to|window)\b/.test(msg),
        "400 message MUST mention from/to/window to aid operator diagnosis",
      ).toBe(true);
    },
  );

  // ------------------------------------------------------------------------
  // Bad-param 3 — ?stage=unknown-stage (value not in enum)
  // ------------------------------------------------------------------------
  test(
    "?stage=unknown-stage returns 400 (value not in stage enum) @slice-002 @us1",
    async ({ request }) => {
      const response = await request.get("/api/matches?stage=unknown-stage");
      const body = await expectBadRequest(response, "stage=unknown-stage");

      expect(body.error.message.toLowerCase()).toContain("stage");
    },
  );
});
