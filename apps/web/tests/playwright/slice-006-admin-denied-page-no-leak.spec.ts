// --------------------------------------------------------------------------
// Slice 006 / T034 — /admin/denied is a generic page; leaks no admin info (RED).
// --------------------------------------------------------------------------
// RED acceptance test pinning the content invariants of the `/admin/denied`
// page introduced by T015 (apps/web/app/admin/denied/page.tsx). The page
// MUST be a generic denial screen that does NOT disclose:
//   - the identity of any current admin (no admin emails, no participant
//     ids, no display names),
//   - the number of admins,
//   - the reason the caller was denied (not_admin / not_eligible /
//     no_session all collapse to one screen),
//   - the contents of any query string the caller supplied (no SSR leak of
//     attacker-controlled URL parameters back into HTML).
//
// Spec source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § `/admin/denied` — "denial screen" — "Content invariants: NO
//       detail about who the admins are. NO 'request access' form in this
//       slice. NO information about why the caller was denied (not_admin
//       vs not_eligible vs no_session all collapse to the same screen)."
//   - specs/006-admin-overrides/spec.md § US4 AS1: "no admin data MUST be
//     served."
//   - apps/web/app/admin/denied/page.tsx (T015) — the static page under
//     test. data-testid="admin-denied-page".
//
// Persona: alpha — eligible, non-admin. alpha is the canonical non-admin
// probe (specs/006-admin-overrides/quickstart.md line 135). Sign-in is
// driven via the OIDC stub so the layout's requireAdmin gate fires and
// the redirect to /admin/denied is exercised end-to-end (not just direct
// navigation, which would also work because the page is static).
//
// Test variants (single describe, multiple `test()` cases):
//   1. Reach /admin/denied via the requireAdmin redirect from /admin.
//      Assert the page body contains the generic copy and no admin
//      identifiers.
//   2. Direct-navigate to `/admin/denied?reason=anything`. Assert the
//      query param does NOT appear in the rendered HTML — proves no SSR
//      reflection of attacker-controlled URL contents.
//   3. Direct-navigate to `/admin/denied?admin_email=admin1@nortal.com`.
//      Assert neither the query string nor "admin1" nor "admin1@nortal.com"
//      appears in the rendered HTML. This is a focused regression guard
//      against any future "personalized denial" enhancement (e.g. "you
//      requested admin1's resource") that would leak admin identity.
//
// DOM contract under test:
//   - data-testid="admin-denied-page" — the <main> wrapper exists.
//   - Visible heading text "Access Denied".
//   - Visible body copy "You don't have administrator access for this
//     application." (matched case-insensitively to tolerate future
//     punctuation/typography tweaks).
//   - Visible "Return to dashboard" link pointing at /dashboard.
//
// No-leak assertions:
//   - Page body text does NOT contain "admin1" (admin1's email local-part).
//   - Page body text does NOT contain "admin1@nortal.com" (admin1 full
//     email). admin1 is the bootstrapped administrator
//     (specs/006-admin-overrides/spec.md + T009 slot 0074), so it is the
//     specific identifier most at risk of leakage in a buggy "you tried
//     to escalate against admin1" message.
//   - Page body text does NOT contain "admin_roles" (the table name —
//     guard against stack-trace / error leakage).
//   - Page body text does NOT contain the literal string
//     "00000000-0000-0000-0000-0000000000d3" (admin1's auth_user_id).
//   - Page body text does NOT contain "77777777" (a prefix of admin1's
//     participants.id) — guards against accidental id-leak from a future
//     "denied for participant <id>" diagnostic.
//   - Page body text does NOT contain the literal query param value
//     "anything" (variant 2) or "admin_email" / "admin1@nortal.com"
//     (variant 3) — proves no SSR reflection.
//
// Cleanup contract:
//   beforeEach: resetStub.
//   afterEach: resetStub. (No DB writes — the page is static and read-only;
//     audit rows written by requireAdmin in variant 1 are append-only and
//     intentionally NOT cleaned up.)
//
// RED-by-design until:
//   - T015 ships `/admin/denied/page.tsx` with data-testid="admin-denied-page".
//   - T007 ships `is_admin(uuid)` real body and T015 ships the layout's
//     requireAdmin gate, so variant 1's redirect succeeds.
//   Until those land:
//     * /admin/denied 404s (variants 2 and 3).
//     * /admin 404s (variant 1's redirect target missing).
//
// Constitution:
//   - Principle II (Security by Design): no admin info leakage.
//   - Principle IX (Test-First): every Then-clause asserts a specific
//     string presence or absence.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

// alpha — slice-001-fixture.sql.
const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

// Known-sensitive admin1 identifiers — sourced from
// specs/006-admin-overrides/spec.md and T009 bootstrap. These are the
// strings the page MUST NOT contain.
const ADMIN1_FORBIDDEN_STRINGS = [
  "admin1@nortal.com",
  "admin1",
  "admin_roles",
  "00000000-0000-0000-0000-0000000000d3", // admin1 auth_user_id
  "77777777", // admin1 participants.id prefix
] as const;

test.describe(
  "US4 — /admin/denied is generic and leaks no admin info @slice-006 @us4",
  () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "alpha (non-admin) reaches /admin/denied via requireAdmin redirect; page shows generic copy; no admin1 identifiers in HTML @slice-006 @us4",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        await page.goto("/admin");
        await page.waitForURL(
          (url) => url.pathname.endsWith("/admin/denied"),
          { timeout: 10_000 },
        );

        // DOM contract: the page wrapper exists.
        const wrapper = page.getByTestId("admin-denied-page");
        await expect(
          wrapper,
          "page MUST render an element with data-testid='admin-denied-page' (T015 contract)",
        ).toBeVisible();

        // Visible generic copy.
        await expect(
          page.getByRole("heading", { name: "Access Denied" }),
          "page MUST contain a heading 'Access Denied' (generic, non-personalized)",
        ).toBeVisible();
        await expect(
          page.getByText(
            /you don['’]t have administrator access for this application/i,
          ),
          "page MUST contain the generic body copy 'You don't have administrator access for this application.'",
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: /return to dashboard/i }),
          "page MUST offer a 'Return to dashboard' link",
        ).toHaveAttribute("href", "/dashboard");

        // No-leak: page text contains no admin1 identifiers.
        const bodyText = await page.locator("body").innerText();
        for (const forbidden of ADMIN1_FORBIDDEN_STRINGS) {
          expect(
            bodyText.toLowerCase().includes(forbidden.toLowerCase()),
            `/admin/denied rendered text MUST NOT contain admin identifier '${forbidden}' ` +
              "(admin-ui.surface.md § `/admin/denied` — 'NO detail about who the admins are.')",
          ).toBe(false);
        }
      },
    );

    test(
      "direct GET /admin/denied?reason=anything does NOT reflect the query param into HTML @slice-006 @us4",
      async ({ page }) => {
        // Direct navigation — no sign-in required because the page is
        // static AND the admin layout's requireAdmin gate redirects ANY
        // non-admin (including no_session) here. We intentionally exercise
        // the no-session path: a logged-out attacker hitting this URL
        // with a crafted query string must NOT see their string reflected.
        await page.goto("/admin/denied?reason=anything");
        await page.waitForURL(
          (url) => url.pathname.endsWith("/admin/denied"),
          { timeout: 10_000 },
        );

        await expect(
          page.getByTestId("admin-denied-page"),
          "page MUST render even when reached directly with a query string",
        ).toBeVisible();

        // No-leak: 'anything' (the attacker's query value) MUST NOT appear
        // anywhere in the rendered HTML. We check the full page HTML, not
        // just innerText, to catch reflection into attributes, hidden
        // inputs, JSON blobs, etc.
        const html = await page.content();
        expect(
          html.toLowerCase().includes("anything"),
          "/admin/denied?reason=anything page HTML MUST NOT contain the literal query value 'anything' — " +
            "no SSR reflection of attacker-controlled URL params.",
        ).toBe(false);

        // Also assert the generic copy still renders (proves the page
        // didn't 500 / blank out).
        await expect(
          page.getByRole("heading", { name: "Access Denied" }),
          "page MUST still show generic 'Access Denied' heading regardless of query string",
        ).toBeVisible();
      },
    );

    test(
      "direct GET /admin/denied?admin_email=admin1@nortal.com does NOT reflect param name OR value into HTML @slice-006 @us4",
      async ({ page }) => {
        // Maximally hostile query: an attacker who already KNOWS admin1's
        // email tries to confirm it via reflection. The page must collapse
        // to the same generic screen with no leakage.
        await page.goto("/admin/denied?admin_email=admin1%40nortal.com");
        await page.waitForURL(
          (url) => url.pathname.endsWith("/admin/denied"),
          { timeout: 10_000 },
        );

        await expect(
          page.getByTestId("admin-denied-page"),
          "page MUST render under hostile query strings",
        ).toBeVisible();

        const html = await page.content();

        // The param NAME must not appear (no debug echo of req.query).
        expect(
          html.toLowerCase().includes("admin_email"),
          "/admin/denied page HTML MUST NOT contain the query param NAME 'admin_email' — no debug reflection.",
        ).toBe(false);

        // None of the admin1-identifying strings may appear anywhere in
        // the HTML (URL bar excluded — page.content() returns the DOM).
        for (const forbidden of ADMIN1_FORBIDDEN_STRINGS) {
          expect(
            html.toLowerCase().includes(forbidden.toLowerCase()),
            `/admin/denied page HTML MUST NOT contain admin identifier '${forbidden}' even when the query string supplies it ` +
              "(admin-ui.surface.md § `/admin/denied` — generic content invariant).",
          ).toBe(false);
        }

        // Generic copy still renders.
        await expect(
          page.getByRole("heading", { name: "Access Denied" }),
          "page MUST still show generic 'Access Denied' heading regardless of query string",
        ).toBeVisible();
      },
    );
  },
);
