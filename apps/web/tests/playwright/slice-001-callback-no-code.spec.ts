// --------------------------------------------------------------------------
// Slice 001 / T029 — `/auth/callback` robustness when called with no `code`.
// --------------------------------------------------------------------------
// RED acceptance test for the "callback with no `?code=` (or no `?error=`)"
// branch in `contracts/auth-callback.page.md` § Test surface row
// `slice-001-callback-no-code.spec.ts`.
//
// Test surface row text:
//   "Visit `/auth/callback` with no `?code=`; assert redirect to
//    `/auth/denied?reason=unknown` (not a 500)."
//
// The brief for T029 widens this slightly: a callback hit with NEITHER
// `code` nor `error` MUST redirect to `/auth/denied` (the contract pins
// `reason=unknown`; we assert exactly that). The key invariant is
// "not a 500" — the callback must degrade gracefully into the denial
// page rather than throw an unhandled exception that exposes the stack.
//
// RED until /auth/callback (T022) defends against the bare-GET case and
// /auth/denied (T032) ships.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub } from "./fixtures/oidc";

test.describe(
  "US2 — /auth/callback handles missing code gracefully @slice-001 @us2 @edge",
  () => {
    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "GET /auth/callback with no code and no error redirects to /auth/denied @slice-001 @us2 @edge",
      async ({ page }) => {
        await page.context().clearCookies();

        const response = await page.goto("/auth/callback");

        expect(response, "navigation response must exist").not.toBeNull();

        // The callback MUST NOT 500.
        expect(
          response!.status(),
          "callback with no code/error must NOT return 500 — must degrade to /auth/denied",
        ).not.toBe(500);

        // After the redirect chain settles, the URL must be on /auth/denied.
        // The contract pins `reason=unknown`; we assert exactly that.
        const finalUrl = new URL(page.url());
        expect(
          finalUrl.pathname,
          "callback with no code must redirect to /auth/denied",
        ).toBe("/auth/denied");
        expect(
          finalUrl.searchParams.get("reason"),
          "contract pins reason=unknown for the missing-code branch",
        ).toBe("unknown");

        // Sanity: the page renders the generic denial message (the
        // "anything else" matrix row). No stack trace text leaks into
        // the rendered HTML.
        const html = await page.content();
        expect(html).not.toMatch(/at\s+\S+\s+\([^)]+:\d+:\d+\)/);
        expect(html).not.toMatch(/Error:\s/);
      },
    );
  },
);
