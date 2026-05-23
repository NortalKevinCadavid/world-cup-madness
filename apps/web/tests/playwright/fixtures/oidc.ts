// --------------------------------------------------------------------------
// DEV-ONLY: not used in any production environment.
// --------------------------------------------------------------------------
// Playwright fixture helpers for driving the local/CI OIDC sidecar.
//
// The sidecar (service "oidc-stub" / container "wcm-oidc-stub") is currently
// **real Keycloak 25** per `docker-compose.override.yml`. The original
// design used `navikt/mock-oauth2-server:3.0.3`, which exposed a runtime
// config endpoint (`PUT /<issuerId>`) that let tests inject arbitrary
// claim payloads on the fly. Keycloak does NOT expose that endpoint —
// it serves only the seeded users from `infra/keycloak/realm-export.json`
// with a fixed claim set per user.
//
// This fixture therefore drives Keycloak's interactive login form (fills
// username + password, clicks Sign In) for tests whose claim payload maps
// 1:1 to a seeded user. Tests that need runtime claim mutation (slice 001
// edge cases — email-drift, missing-claims, fresh-user) throw a clear
// error pointing to the follow-up doc.
//
// Background:
//   - `docker-compose.override.yml` swapped the sidecar to Keycloak because
//     Supabase Auth's [auth.external.keycloak] config hardcodes Keycloak's
//     URL conventions. The previous mock-oauth2-server used different
//     paths that caused Supabase's redirect builder to 404.
//   - The fix for this fixture is documented in
//     `specs/001-eligibility-login/follow-up-oidc-stub-keycloak-vs-mock-oauth2.md`.
//   - Reference implementation that drove this rewrite:
//     `tests/playwright/slice-005-breakdown-after-rename.spec.ts`.
// --------------------------------------------------------------------------

import { expect, type Page } from "@playwright/test";

// --------------------------------------------------------------------------
// Types — kept stable for backwards-compat with the ~127 consuming specs.
// --------------------------------------------------------------------------

/**
 * Standard OIDC ID-token claims that slice fixtures may set. All fields
 * are optional. With the Keycloak-driven backend, only `email` is
 * load-bearing: it picks which seeded Keycloak user to sign in as.
 *
 * Other fields (sub, name, etc.) are tolerated for backwards-compat with
 * the consuming specs but ignored at runtime — Keycloak serves the seeded
 * claim values for the user regardless of what's passed here.
 */
export interface OidcIdentityClaims {
  /** Subject — IGNORED at runtime; kept for type compat. */
  sub?: string;
  /** Email address. The ONLY load-bearing field — selects the Keycloak user. */
  email?: string;
  /** Whether the IdP marks the email as verified. IGNORED at runtime. */
  email_verified?: boolean;
  /** Display name. IGNORED at runtime — Keycloak serves the seeded display name. */
  name?: string;
  /** IGNORED at runtime. */
  given_name?: string;
  /** IGNORED at runtime. */
  family_name?: string;
  /** IGNORED at runtime. */
  preferred_username?: string;
  /** IGNORED at runtime. */
  iss?: string;
  /** IGNORED at runtime. */
  aud?: string | string[];
  /** Extra claims — IGNORED at runtime. */
  [extra: string]: unknown;
}

/** Options accepted by `signInWithIdentity`. */
export interface SignInOptions {
  /** The identity payload to sign in with. Only `email` is honored. */
  claims: OidcIdentityClaims;
  /** Optional override of where on the Next.js app to start the sign-in flow. Default "/". */
  startPath?: string;
  /** Optional URL fragment we expect to land on after sign-in. Default "/dashboard". */
  expectedPostSignInPath?: string;
  /**
   * Optional override of the Keycloak base URL.
   * Defaults to `process.env.OIDC_STUB_BASE_URL ?? "http://localhost:8090"`.
   */
  stubBaseUrl?: string;
}

/** Options accepted by `mintRefreshedAccessToken`. */
export interface RefreshOptions {
  /** The (potentially updated) claims. IGNORED — Keycloak doesn't support runtime claim mutation. */
  claims: OidcIdentityClaims;
  /** Optional Keycloak base URL override. */
  stubBaseUrl?: string;
}

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const DEFAULT_STUB_BASE_URL =
  process.env.OIDC_STUB_BASE_URL ?? "http://localhost:8090";

/** Keycloak realm name — matches `infra/keycloak/realm-export.json`. */
const KEYCLOAK_REALM = "default";

/** Shared password for every seeded dev user. */
const KEYCLOAK_DEV_PASSWORD = "dev-password";

/**
 * Email → Keycloak username lookup for the seeded dev users in
 * `infra/keycloak/realm-export.json`. Tests that pass any other email
 * trigger the "runtime claim injection required" error path.
 */
const SEEDED_USER_BY_EMAIL: Readonly<Record<string, string>> = {
  "alpha@nortal.com": "alpha",
  "bravo@nortal.com": "bravo",
  "charlie@nortal.com": "charlie",
  "admin1@nortal.com": "admin1",
  "newuser@nortal.com": "newuser",
};

const FOLLOWUP_REF =
  "specs/001-eligibility-login/follow-up-oidc-stub-keycloak-vs-mock-oauth2.md";

function resolveStubUrl(override?: string): string {
  return (override ?? DEFAULT_STUB_BASE_URL).replace(/\/+$/, "");
}

/**
 * Resolve a Keycloak username from the claim payload. Throws a precise
 * actionable error if the email doesn't match a seeded user — those tests
 * need the runtime-claim-injection path documented in the follow-up.
 */
function resolveKeycloakUsername(claims: OidcIdentityClaims): string {
  const email = (claims.email ?? "").toLowerCase().trim();
  const username = SEEDED_USER_BY_EMAIL[email];
  if (!username) {
    throw new Error(
      [
        `OIDC fixture: claims.email="${claims.email}" does not match a seeded Keycloak user.`,
        `Seeded users (see infra/keycloak/realm-export.json):`,
        ...Object.entries(SEEDED_USER_BY_EMAIL).map(
          ([e, u]) => `  - ${e} → ${u}`,
        ),
        ``,
        `Tests that need to sign in as a non-seeded identity (email-drift,`,
        `missing-claims, freshly-created participant, outsider rejection)`,
        `require runtime claim injection, which Keycloak does NOT support.`,
        `See ${FOLLOWUP_REF} for the three remediation paths.`,
        ``,
        `Quick fix: use .fixme() on this test until the runtime-claim-injection`,
        `path is restored (Path C in the follow-up).`,
      ].join("\n"),
    );
  }
  return username;
}

// --------------------------------------------------------------------------
// Public API — same signatures as the original fixture, Keycloak-backed.
// --------------------------------------------------------------------------

/**
 * Drives the Next.js sign-in flow end-to-end against the local Keycloak:
 *
 *   1. Resolves a seeded Keycloak username from `claims.email`.
 *   2. Navigates to `startPath` on the app under test.
 *   3. Clicks the "Sign in" button, which redirects to Supabase Auth
 *      then to Keycloak's login form.
 *   4. Fills username + password and submits.
 *   5. Waits for the browser to settle on `expectedPostSignInPath`.
 *
 * Returns the final URL the page settled on.
 *
 * @throws if `claims.email` is not a seeded user; see `resolveKeycloakUsername`.
 */
export async function signInWithIdentity(
  page: Page,
  options: SignInOptions,
): Promise<string> {
  const username = resolveKeycloakUsername(options.claims);
  const startPath = options.startPath ?? "/";
  const expectedPostSignInPath = options.expectedPostSignInPath ?? "/dashboard";

  // 1. Land on the app's sign-in entry point. The slice 009 redesign uses
  //    a <Button> for the sign-in trigger, not a <Link>; we accept either
  //    to remain robust across UI revisions.
  await page.goto(startPath);
  const signInTrigger = page
    .getByRole("button", { name: /sign in/i })
    .or(page.getByRole("link", { name: /sign in/i }))
    .first();
  await expect(signInTrigger).toBeVisible({ timeout: 10_000 });
  await signInTrigger.click();

  // 2. Wait for Keycloak's interactive login form to appear. Waiting on the
  //    username textbox (instead of a URL pattern) sidesteps redirect-chain
  //    races: localhost:3000 → Supabase Auth → Keycloak.
  const usernameField = page.getByRole("textbox", {
    name: /username or email/i,
  });
  await expect(usernameField).toBeVisible({ timeout: 15_000 });

  // 3. Submit credentials. Keycloak's password field has accessible name
  //    "Password"; the submit button is accessible name "Sign In".
  await usernameField.fill(username);
  await page.getByRole("textbox", { name: /^password$/i }).fill(KEYCLOAK_DEV_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // 4. Wait for the post-sign-in destination. Tests that expect a denied
  //    flow override `expectedPostSignInPath` to "/auth/denied".
  await page.waitForURL(
    (url) => url.pathname.startsWith(expectedPostSignInPath),
    { timeout: 20_000 },
  );

  return page.url();
}

/** Convenience alias for `signInWithIdentity({ claims })`. */
export async function mintIdentity(
  page: Page,
  claims: OidcIdentityClaims,
): Promise<string> {
  return signInWithIdentity(page, { claims });
}

/**
 * `mintRefreshedAccessToken` was used to drive Supabase Auth's
 * `custom_access_token` hook on the refresh path (Deviation D-001) by
 * mutating the claim payload BETWEEN sign-in and refresh. That mutation
 * relied on the mock-oauth2-server's runtime config endpoint, which
 * Keycloak does not expose.
 *
 * Until the runtime-claim-injection path is restored (Path C in the
 * follow-up), this helper THROWS so callers see a precise error rather
 * than silently no-op'ing the mutation.
 *
 * There is exactly one caller in the test suite — fixme that single test
 * until the follow-up path lands.
 */
export async function mintRefreshedAccessToken(
  _page: Page,
  _options: RefreshOptions,
): Promise<void> {
  throw new Error(
    [
      `OIDC fixture: mintRefreshedAccessToken is unavailable while the OIDC`,
      `sidecar is real Keycloak (claim mutation between sign-in and refresh`,
      `requires the mock-oauth2-server's runtime config endpoint).`,
      ``,
      `Until the runtime-claim-injection path is restored, mark the calling`,
      `test with .fixme() and link to ${FOLLOWUP_REF}.`,
    ].join("\n"),
  );
}

/**
 * Sanity probe — confirms Keycloak is reachable and serving a valid
 * discovery document. Use as a `beforeAll` guard so tests fail fast with
 * a clear message when the sidecar is down or on the wrong port.
 */
export async function assertOidcStubReachable(
  stubBaseUrl?: string,
): Promise<{
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}> {
  const base = resolveStubUrl(stubBaseUrl);
  const url = `${base}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Keycloak discovery probe ${url} failed: ${response.status} ${response.statusText}. ` +
        `Is the sidecar running? Try \`docker ps --filter name=wcm-oidc-stub\`. ` +
        `If you see mock-oauth2-server URLs in earlier logs, the slice 001 ` +
        `OIDC fixture was rewritten on 2026-05-23 — see ${FOLLOWUP_REF}.`,
    );
  }
  const doc = (await response.json()) as Record<string, unknown>;
  const required = [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ] as const;
  for (const k of required) {
    if (typeof doc[k] !== "string") {
      throw new Error(
        `Keycloak discovery doc at ${url} is missing required field "${k}".`,
      );
    }
  }
  return doc as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
  };
}

/**
 * No-op now that the sidecar is Keycloak — the mock-oauth2-server runtime
 * config endpoint that this helper used to clear is no longer present.
 * Playwright's per-test browser contexts already isolate cookies, so
 * inter-test bleed is not a concern.
 *
 * Kept as an exported function so the 413+ existing callers continue to
 * compile without per-spec edits.
 */
export async function resetStub(_stubBaseUrl?: string): Promise<void> {
  // Intentionally empty. Browser-context isolation handles inter-test cleanup.
}
