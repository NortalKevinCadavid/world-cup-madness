// --------------------------------------------------------------------------
// Slice 001 / T029 — `/auth/callback` redirect on ineligible-domain payload.
// --------------------------------------------------------------------------
// RED acceptance test for the callback's denial-redirect branch in
// `specs/001-eligibility-login/contracts/auth-callback.page.md` §
// Behavior `/auth/callback` step 4 + § Test surface row
// `slice-001-callback-denied-domain.spec.ts`.
//
// Test surface row text:
//   "Stub OIDC for ineligible domain; visit `/auth/callback?code=...`;
//    assert redirect to `/auth/denied?reason=domain_not_approved` and
//    denial screen renders the matching message."
//
// Implementation note: we cannot synthesise a raw OIDC `?code=` value
// out-of-band because the mock-oauth2-server signs each code against
// its own internal session. The contract's intent is to verify that the
// callback page correctly translates an auth-hook denial into the
// expected redirect path, NOT to hit /auth/callback with a bare GET.
// We therefore exercise the path the way Supabase Auth actually drives
// it: configure the stub to mint an outsider identity, click "Sign in",
// and let Supabase Auth round-trip through /auth/callback. The browser's
// final URL is the canonical assertion target — same as for
// slice-001-login-denied-domain, but here we focus on the callback's
// translation behavior rather than the audit / no-provision assertions
// (which live in the login-denied-domain spec).
//
// RED until /auth/denied (T032) and the auth hook's reject branch
// (T024) ship.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

const DENIED_PATH = "/auth/denied";

const OUTSIDER = {
  sub: "00000000-0000-0000-0000-00000000000e",
  email: "outsider@example.com",
  email_verified: true,
  name: "Outsider",
} as const;

test.describe(
  "US2 — /auth/callback redirects ineligible domain to /auth/denied @slice-001 @us2",
  () => {
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
      "callback with ineligible-domain payload redirects to /auth/denied?reason=domain_not_approved @slice-001 @us2",
      async ({ page }) => {
        const finalUrl = await signInWithIdentity(page, {
          claims: {
            sub: OUTSIDER.sub,
            email: OUTSIDER.email,
            email_verified: OUTSIDER.email_verified,
            name: OUTSIDER.name,
          },
          expectedPostSignInPath: DENIED_PATH,
        });

        const denied = new URL(finalUrl);

        // The redirect MUST land on the denial page with the exact reason
        // code from contracts/auth-callback.page.md § Behavior — `/auth/denied`.
        expect(denied.pathname).toBe(DENIED_PATH);
        expect(denied.searchParams.get("reason")).toBe("domain_not_approved");

        // The matching denial message MUST render — exercise the callback
        // -> denied -> SSR render pipeline end-to-end so we know the
        // callback didn't silently fall through to a 500 page.
        await expect(
          page.getByText(/restricted to approved Nortal corporate identities/i),
        ).toBeVisible();

        // The callback MUST NOT have left a `sb-*` session cookie behind —
        // a denied user has no eligible session. (The page can still be
        // reached without a session per contract § Security invariants,
        // but the user MUST NOT carry a partial session forward.)
        const cookies = await page.context().cookies();
        const sbCookies = cookies.filter((c) =>
          c.name.startsWith("sb-"),
        );
        expect(
          sbCookies.find((c) => c.value && c.value.includes("access_token")),
          "denied users must not retain a Supabase access-token cookie",
        ).toBeUndefined();
      },
    );
  },
);
