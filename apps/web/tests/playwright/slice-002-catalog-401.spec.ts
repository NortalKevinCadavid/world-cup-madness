// --------------------------------------------------------------------------
// Slice 002 / T014 — `/api/matches` 401 path.
// --------------------------------------------------------------------------
// RED acceptance test for the "no cookie / no JWT" branch of
// `GET /api/matches` documented in
// `specs/002-match-catalog/contracts/match-catalog.read.md` § 401.
//
// Mirrors slice-001's `slice-001-api-me-401.spec.ts`. The 401 body shape
// is shared across slice-001 and slice-002 — the participant-me contract
// owns the canonical `{ error: { code, message } }` envelope and the
// match-catalog contract reuses it byte-for-byte (contract § 401 "Same
// body shape as /api/me").
//
// Then-clauses:
//   1. Status code is exactly 401.
//   2. Body matches `{ error: { code: 'UNAUTHENTICATED', message: <string> } }`.
//      The exact message string is pinned to `"Sign in to continue."` per
//      slice-001 contract — a copy edit should force a contract update.
//   3. `Cache-Control: private, max-age=0, must-revalidate` per slice-001's
//      caching posture (the 401 short-circuit predates the 200-path's
//      `max-age=10` posture; eligibility-gate denials never get cached).
//   4. No `X-Debug-*` headers or stack-trace leakage in headers or body.
//
// RED until T020+ wires up the route handler at
// `apps/web/app/api/matches/route.ts` with the requireEligible() guard.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub } from "./fixtures/oidc";

test.describe(
  "US1 — /api/matches 401 on missing session @slice-002 @us1",
  () => {
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
      "GET /api/matches with no cookie returns 401 with UNAUTHENTICATED body @slice-002 @us1",
      async ({ request, page }) => {
        // Belt-and-braces: clear any cookies on the request context so
        // even if the Playwright config or a sibling test leaked a
        // Supabase cookie, this request is genuinely anonymous.
        await page.context().clearCookies();

        const response = await request.get("/api/matches");

        // Then 1 — exact status code.
        expect(
          response.status(),
          "GET /api/matches with no JWT must be 401 (contract § 401)",
        ).toBe(401);

        // Then 2 — body shape.
        const body = (await response.json()) as unknown;
        expect(body).toMatchObject({
          error: {
            code: "UNAUTHENTICATED",
            message: expect.any(String),
          },
        });

        // The contract reuses slice-001's exact message string. Pin it
        // here too so a copy edit forces a cross-contract update.
        expect((body as { error: { message: string } }).error.message).toBe(
          "Sign in to continue.",
        );

        // Then 3 — cache-control per § Caching posture (denials never
        // cached; the 200-path's max-age=10 is the eligible-only posture).
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
  },
);
