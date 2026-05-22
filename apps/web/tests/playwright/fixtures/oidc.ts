// --------------------------------------------------------------------------
// DEV-ONLY: not used in any production environment.
// --------------------------------------------------------------------------
// Playwright fixture helpers for driving the local/CI fake-IdP OIDC sidecar
// (ghcr.io/navikt/mock-oauth2-server:3.0.3) declared in
// `docker-compose.override.yml` at the repo root.
//
// The sidecar exposes:
//   - http://localhost:8090/default/.well-known/openid-configuration
//   - http://localhost:8090/default/jwks
//   - http://localhost:8090/default/authorize
//   - http://localhost:8090/default/token
//   - http://localhost:8090/default/userinfo
//
// And — critically for tests — a "config" endpoint that lets us shape the
// exact claim payload returned for the NEXT token request:
//   - PUT http://localhost:8090/default
//
// This helper exposes a small high-level API that slice-001 acceptance
// tests (T016, T017, ...) consume to synthesize identity payloads
// (eligible, ineligible, missing-claims, email-drift, etc.) without
// depending on Microsoft Entra ID.
//
// Spec deviation note (D-001): the slice's spec referenced a
// `before_user_signed_in` Supabase Auth hook, but Supabase CLI v2 only
// supports `custom_access_token` — which fires on BOTH initial sign-in AND
// refresh-token issuance. The fixture below therefore exposes BOTH a
// one-shot identity-mint (initial sign-in) and a separate refresh-token
// helper so tests can exercise either path independently.
// --------------------------------------------------------------------------

import type { Page } from "@playwright/test";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

/**
 * Standard OIDC ID-token claims that slice-001 fixtures may set. All fields
 * are optional so tests can deliberately omit one (e.g. drop `email` to
 * exercise the "missing claim" edge case E-1).
 */
export interface OidcIdentityClaims {
  /** Subject — stable per-user identifier from the IdP. Maps to auth.users.id linkage. */
  sub?: string;
  /** Email address. Omitting this triggers the missing-claims path. */
  email?: string;
  /** Whether the IdP marks the email as verified. */
  email_verified?: boolean;
  /** Display name (full name). Drives `participants.display_name`. */
  name?: string;
  /** Optional given name. */
  given_name?: string;
  /** Optional family name. */
  family_name?: string;
  /** Optional preferred-username claim. */
  preferred_username?: string;
  /** Optional issuer override (defaults to the stub's default issuer). */
  iss?: string;
  /** Optional audience override (defaults to SUPABASE_AUTH_OIDC_AUDIENCE). */
  aud?: string | string[];
  /**
   * Arbitrary extra claims merged into the token (e.g. a `groups` array).
   * Useful for slices 002+ where role/group claims may matter.
   */
  [extra: string]: unknown;
}

/**
 * Options accepted by `signInWithIdentity`.
 */
export interface SignInOptions {
  /** The identity payload the stub should mint. */
  claims: OidcIdentityClaims;
  /**
   * Optional override of the stub's base URL. Defaults to
   * `process.env.OIDC_STUB_BASE_URL ?? "http://localhost:8090"`. The path
   * `/default` is appended automatically.
   */
  stubBaseUrl?: string;
  /**
   * Optional override of where on the Next.js app to start the sign-in
   * flow. Defaults to `/` (the landing page) where a "Sign in" link
   * triggers the Supabase Auth redirect.
   */
  startPath?: string;
  /**
   * Optional URL fragment we expect to land on after a successful sign-in.
   * Defaults to `/dashboard`. Failure scenarios (denied, missing claims)
   * override this with `/auth/denied`.
   */
  expectedPostSignInPath?: string;
}

/**
 * Options accepted by `mintRefreshedAccessToken` — used to exercise the
 * `custom_access_token` Supabase hook on the refresh path specifically
 * (Deviation D-001).
 */
export interface RefreshOptions {
  /** The (potentially updated) claims to embed in the refreshed token. */
  claims: OidcIdentityClaims;
  /** Optional stub base URL override (see SignInOptions). */
  stubBaseUrl?: string;
}

/**
 * Shape of the JSON payload the mock-oauth2-server expects when we PUT to
 * `/<issuerId>` to register the next token's claims.
 */
interface MockOauth2ConfigPayload {
  tokenCallbacks: Array<{
    issuerId: string;
    tokenExpiry: number;
    requestMappings: Array<{
      requestParam: string;
      match: string;
      claims: OidcIdentityClaims;
    }>;
  }>;
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

const DEFAULT_STUB_BASE_URL =
  process.env.OIDC_STUB_BASE_URL ?? "http://localhost:8090";

const DEFAULT_ISSUER_ID = "default";

function resolveStubUrl(override?: string): string {
  return (override ?? DEFAULT_STUB_BASE_URL).replace(/\/+$/, "");
}

function buildConfigPayload(claims: OidcIdentityClaims): MockOauth2ConfigPayload {
  return {
    tokenCallbacks: [
      {
        issuerId: DEFAULT_ISSUER_ID,
        tokenExpiry: 3600,
        requestMappings: [
          {
            requestParam: "scope",
            match: "openid",
            claims,
          },
        ],
      },
    ],
  };
}

/**
 * Posts the per-test claim payload to the mock-oauth2-server's runtime
 * configuration endpoint. The NEXT token request the stub serves will
 * include exactly these claims.
 */
async function registerNextTokenClaims(
  claims: OidcIdentityClaims,
  stubBaseUrl: string,
): Promise<void> {
  const url = `${stubBaseUrl}/${DEFAULT_ISSUER_ID}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildConfigPayload(claims)),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable body>");
    throw new Error(
      `OIDC stub config PUT ${url} failed: ${response.status} ${response.statusText} — ${body}`,
    );
  }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Drives the Next.js sign-in flow end-to-end:
 *
 *   1. Registers the requested identity claims with the OIDC stub so the
 *      next /token call returns exactly those claims.
 *   2. Navigates to `startPath` (default "/") on the app under test.
 *   3. Clicks the "Sign in" link, which redirects to Supabase Auth, then
 *      to the stub's /authorize, then back through /callback.
 *   4. Waits until the browser settles on `expectedPostSignInPath`
 *      (default "/dashboard"). On a denied scenario callers should pass
 *      `expectedPostSignInPath: "/auth/denied"`.
 *
 * Returns the final URL the page settled on (so tests can assert on query
 * params like `?reason=domain_not_approved`).
 *
 * Exercises the INITIAL sign-in path of the `custom_access_token` Supabase
 * hook (Deviation D-001). For the refresh path use
 * `mintRefreshedAccessToken`.
 */
export async function signInWithIdentity(
  page: Page,
  options: SignInOptions,
): Promise<string> {
  const stubBaseUrl = resolveStubUrl(options.stubBaseUrl);
  const startPath = options.startPath ?? "/";
  const expectedPostSignInPath = options.expectedPostSignInPath ?? "/dashboard";

  await registerNextTokenClaims(options.claims, stubBaseUrl);

  await page.goto(startPath);
  await page.getByRole("link", { name: /sign in/i }).click();

  // Supabase Auth + OIDC stub round-trip — mock-oauth2-server with
  // `interactiveLogin: false` (set in docker-compose.override.yml)
  // auto-approves, so we just wait for the final landing URL.
  await page.waitForURL(
    (url) => url.pathname.startsWith(expectedPostSignInPath),
    { timeout: 15_000 },
  );

  return page.url();
}

/**
 * Convenience alias for `signInWithIdentity({ claims })`. Useful when
 * tests don't need to override paths.
 *
 * @example
 *   await mintIdentity(page, {
 *     email: "alpha@nortal.com",
 *     email_verified: true,
 *     name: "Alpha Tester",
 *     sub: "00000000-0000-0000-0000-000000000001",
 *   });
 */
export async function mintIdentity(
  page: Page,
  claims: OidcIdentityClaims,
): Promise<string> {
  return signInWithIdentity(page, { claims });
}

/**
 * Exercises the REFRESH path of the `custom_access_token` Supabase hook
 * (Deviation D-001). Registers a (potentially mutated) claim payload with
 * the stub, then triggers a token refresh by reloading the dashboard with
 * the access token expired. This is the helper slice-001 tests use to
 * verify mid-session eligibility revocation (Edge case E-3 / FR-007).
 *
 * Assumes the page is already signed in (call `signInWithIdentity` first).
 */
export async function mintRefreshedAccessToken(
  page: Page,
  options: RefreshOptions,
): Promise<void> {
  const stubBaseUrl = resolveStubUrl(options.stubBaseUrl);
  await registerNextTokenClaims(options.claims, stubBaseUrl);

  // Force Supabase Auth to issue a fresh token by clearing the current
  // access token in localStorage. The Next.js client will detect the
  // missing token on the next API call and request a refresh, which fires
  // the `custom_access_token` hook on the refresh path.
  await page.evaluate(() => {
    const keys = Object.keys(window.localStorage).filter((k) =>
      k.startsWith("sb-"),
    );
    for (const k of keys) {
      const raw = window.localStorage.getItem(k);
      if (raw && raw.includes("access_token")) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            delete parsed.access_token;
            window.localStorage.setItem(k, JSON.stringify(parsed));
          }
        } catch {
          /* ignore non-JSON entries */
        }
      }
    }
  });

  await page.reload();
}

/**
 * Sanity probe — confirms the OIDC stub is reachable and serving a valid
 * discovery document. Useful as a Playwright `beforeAll` guard so slice-001
 * tests fail fast with a clear message when the sidecar is down.
 *
 * Returns the parsed discovery document on success; throws on any
 * structural problem (wrong issuer, missing endpoints, non-2xx, etc.).
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
  const url = `${base}/${DEFAULT_ISSUER_ID}/.well-known/openid-configuration`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `OIDC stub discovery probe ${url} failed: ${response.status} ${response.statusText}. ` +
        `Is the sidecar running? Try \`docker compose ps oidc-stub\`.`,
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
        `OIDC stub discovery doc at ${url} is missing required field "${k}".`,
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
 * Clears any per-test claim configuration from the OIDC stub so the next
 * test starts from a clean slate. Idempotent and safe to call when nothing
 * is registered.
 *
 * Slice-001 tests typically call this in `afterEach`.
 */
export async function resetStub(stubBaseUrl?: string): Promise<void> {
  const base = resolveStubUrl(stubBaseUrl);
  // Resetting to an empty tokenCallbacks list makes the stub fall back to
  // its default identity (the one declared in docker-compose.override.yml's
  // JSON_CONFIG env var).
  await registerNextTokenClaims(
    {
      sub: "default-test-subject",
      email: "placeholder@nortal.com",
      email_verified: true,
      name: "Placeholder User",
    },
    base,
  );
}
