// --------------------------------------------------------------------------
// Slice 001 / T029 — `/auth/denied` no-info-leak on unknown reason codes.
// --------------------------------------------------------------------------
// RED acceptance test for the "anything else" row of the denial-message
// matrix in `contracts/auth-callback.page.md` § Behavior — `/auth/denied`.
//
// Then-clauses:
//   1. Visiting `/auth/denied?reason=foo-bar-unknown` renders the generic
//      "We could not complete sign-in. Please try again, or contact your
//      administrator." message.
//   2. No participant info leaks (no email, no participants.id, no
//      display name).
//   3. No approved-domain list is rendered (no "nortal.com" string).
//   4. No debug or stack-trace text leaks into the rendered HTML.
//   5. The reason token itself ("foo-bar-unknown") is NOT echoed into
//      the page body — the contract's "MUST NOT reveal ... whether the
//      rejection came from the auth hook, RLS, or the API guard" rule
//      implies the page must not let attackers probe internal reason
//      codes by URL-pasting and reading them back.
//
// RED until `/auth/denied` page ships (T032).
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub } from "./fixtures/oidc";

test.describe(
  "US2 — /auth/denied renders generic message for unknown reason @slice-001 @us2 @edge",
  () => {
    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "unknown ?reason= renders the generic denial without leaking the reason or participant data @slice-001 @us2 @edge",
      async ({ page }) => {
        // Clear any session so this is the cookieless render path. The
        // /auth/denied page MUST be reachable with no session per
        // contract § Security invariants.
        await page.context().clearCookies();

        const response = await page.goto(
          "/auth/denied?reason=foo-bar-unknown",
        );

        // Page must render (200), not 500 or redirect away.
        expect(response, "navigation response must exist").not.toBeNull();
        expect(response!.status()).toBe(200);

        // Then 1 — generic message rendered.
        await expect(
          page.getByText(
            /could not complete sign-in.*try again.*contact your administrator/i,
          ),
        ).toBeVisible();

        const html = await page.content();

        // Then 2 — no participant info.
        expect(html).not.toMatch(/@nortal\.com/i);
        expect(html).not.toMatch(/@example\.com/i);
        expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

        // Then 3 — no approved-domain list.
        expect(html).not.toMatch(/nortal\.com/i);
        expect(html).not.toMatch(/approved[_-]?domains/i);

        // Then 4 — no debug or stack content.
        expect(html).not.toMatch(/at\s+\S+\s+\([^)]+:\d+:\d+\)/);
        expect(html).not.toMatch(/Error:\s/);
        expect(html).not.toMatch(/x-debug/i);

        // Then 5 — the unknown reason token is NOT echoed into the body.
        // (The URL query string still contains it; we only assert it's
        // absent from the rendered HTML body that an attacker would
        // scrape after a probe.)
        expect(
          html.toLowerCase(),
          "raw `reason=` token must not appear in rendered denial body",
        ).not.toContain("foo-bar-unknown");
      },
    );
  },
);
