// --------------------------------------------------------------------------
// Slice 001 / T029 — `/api/me` 401 path.
// --------------------------------------------------------------------------
// RED acceptance test for the "no cookie / no JWT" branch of
// `GET /api/me` documented in
// `specs/001-eligibility-login/contracts/participant-me.read.md` § 401.
//
// Then-clauses:
//   1. Status code is exactly 401.
//   2. Body matches `{ error: { code: 'UNAUTHENTICATED', message: <string> } }`.
//   3. `Cache-Control: private, max-age=0, must-revalidate` per the contract's
//      § Caching posture table.
//   4. No `X-Debug-*` or stack-trace leakage in headers or body.
//
// The current `/api/me` route already emits the 401 body shape (Phase 3
// reconciliation), but this file is still RED because Phase 4 will add
// the audit-row write on the 403 path (T033) and the per-request
// eligibility re-check (T034). The 401 assertions here are stable and
// should pass once the dev server is reachable in CI.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub } from "./fixtures/oidc";

test.describe("US2 — /api/me 401 on missing session @slice-001 @us2", () => {
  test.beforeEach(async () => {
    // Reset the OIDC stub so a stale token-callback config from a prior
    // test does not unexpectedly seed a session. This test deliberately
    // does not sign in — the stub state should still be clean.
    await resetStub();
  });

  test.afterEach(async () => {
    await resetStub();
  });

  test(
    "GET /api/me with no cookie returns 401 with UNAUTHENTICATED body @slice-001 @us2",
    async ({ request, page }) => {
      // Belt-and-braces: clear any cookies on the request context so
      // even if the Playwright config or a sibling test leaked a
      // Supabase cookie, this request is genuinely anonymous.
      await page.context().clearCookies();

      const response = await request.get("/api/me");

      // Then 1 — exact status code.
      expect(
        response.status(),
        "GET /api/me with no JWT must be 401 (contract § 401)",
      ).toBe(401);

      // Then 2 — body shape.
      const body = (await response.json()) as unknown;
      expect(body).toMatchObject({
        error: {
          code: "UNAUTHENTICATED",
          message: expect.any(String),
        },
      });

      // The contract pins the exact message string. Pin it here too so
      // a copy edit forces a contract update.
      expect((body as { error: { message: string } }).error.message).toBe(
        "Sign in to continue.",
      );

      // Then 3 — cache-control per § Caching posture.
      expect(response.headers()["cache-control"]).toBe(
        "private, max-age=0, must-revalidate",
      );

      // Then 4 — no debug or stack leakage.
      const headers = response.headers();
      for (const headerName of Object.keys(headers)) {
        expect(
          headerName.toLowerCase(),
          `response header "${headerName}" must not be a debug header`,
        ).not.toMatch(/^x-debug/i);
      }
      const rawText = JSON.stringify(body);
      expect(rawText, "401 body must not contain a stack trace").not.toMatch(
        /at\s+\S+\s+\(/, // Node stack frame: "at funcName (file:line:col)"
      );
    },
  );
});
