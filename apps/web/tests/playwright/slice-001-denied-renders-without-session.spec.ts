// --------------------------------------------------------------------------
// Slice 001 / T029 — `/auth/denied` renders without any session cookie.
// --------------------------------------------------------------------------
// RED acceptance test for the "denial screen is reached by denied users"
// invariant in `contracts/auth-callback.page.md` § Security invariants
// + § Test surface row `slice-001-denied-renders-without-session.spec.ts`.
//
// Test surface row text:
//   "Visit `/auth/denied?reason=domain_not_approved` with NO cookies;
//    assert 200 + denial renders (no redirect loop)."
//
// Then-clauses:
//   1. The page returns 200 with no cookies present (no auth middleware
//      should redirect a denied user away from the denial screen — that
//      would create a redirect loop).
//   2. The contract's `domain_not_approved` message is rendered.
//   3. The "Sign in with a different account" affordance per contract §
//      Behavior `/auth/denied` is present (a link / button visible on
//      the rendered page).
//
// RED until `/auth/denied` page ships (T032) and the auth middleware
// allow-lists this route.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub } from "./fixtures/oidc";

test.describe(
  "US2 — /auth/denied is reachable cookieless @slice-001 @us2 @edge",
  () => {
    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "cookieless GET /auth/denied?reason=domain_not_approved returns 200 and renders the denial @slice-001 @us2 @edge",
      async ({ page }) => {
        // Belt-and-braces: clear cookies + storage so even a leaked
        // Supabase session from a sibling test cannot give us a stale
        // "authenticated" redirect.
        await page.context().clearCookies();

        // Cannot clear localStorage before navigation because the origin
        // is not yet established; do it after the first hit if needed.
        const response = await page.goto(
          "/auth/denied?reason=domain_not_approved",
        );

        expect(response, "navigation response must exist").not.toBeNull();

        // Then 1 — 200 status, no redirect.
        expect(
          response!.status(),
          "denial page must render 200 even without a session (no redirect loop)",
        ).toBe(200);
        expect(new URL(page.url()).pathname).toBe("/auth/denied");

        // Then 2 — the contract's domain_not_approved message renders.
        await expect(
          page.getByText(
            /restricted to approved Nortal corporate identities/i,
          ),
        ).toBeVisible();

        // Then 3 — the "Sign in with a different account" affordance is
        // present per contract § Behavior — `/auth/denied` last paragraph.
        await expect(
          page.getByRole("link", { name: /sign in with a different account/i }),
        ).toBeVisible();
      },
    );
  },
);
