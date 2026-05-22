# Contract: Auth Callback Page (`/auth/callback`)

**Slice**: 001-eligibility-login
**Date**: 2026-05-15
**Status**: Phase 1 (Plan).

The Next.js page Supabase Auth redirects to after the IdP completes. **By the time this page runs, the eligibility decision has already been made** (R-004 — the auth hook either admitted the user and provisioned the participant, or rejected the sign-in and the user never reaches this page with a valid session). This page is therefore a *secondary* surface: it handles UI routing and renders the denial screen, but it does **not** re-decide eligibility.

## Routes

| URL | Purpose |
|---|---|
| `/auth/callback?code=<oauth_code>` | Supabase Auth's redirect after a successful IdP round-trip. Exchanges the code for a session, then redirects to the dashboard. |
| `/auth/denied?reason=<code>` | Render the denial screen. Reached when the auth hook rejected the sign-in OR when `/api/me` returns 403 on a still-active session. |

## Behavior — `/auth/callback`

1. Server component reads `?code=` from the URL.
2. Calls `supabase.auth.exchangeCodeForSession(code)` (server-side, using the publishable anon key — never service-role).
3. **If success** (session JWT issued): the hook has already provisioned the participant. Redirect to `/dashboard`.
4. **If error** (`AuthApiError` with `message` containing `decision: reject`): parse the auth-hook's denial reason from the error message and redirect to `/auth/denied?reason=<code>`. No participant row exists; there is nothing to clean up.
5. **If error** (any other Supabase Auth failure — network, etc.): redirect to `/auth/denied?reason=unknown`, log the actual error server-side for ops.

The page is intentionally thin: 100% of the eligibility *decision* lives in the auth hook (R-004). This page does not query `participants`, does not call `/api/me`, does not write any audit row. (The auth hook already wrote the audit row before this page renders.)

## Behavior — `/auth/denied?reason=<code>`

Server component renders a static denial screen. Behavior matrix:

| `?reason=` | Message rendered |
|---|---|
| `domain_not_approved` | "This application is restricted to approved Nortal corporate identities. Contact the tournament administrator if you believe this is a mistake." |
| `missing_claims` | "We could not complete sign-in because your identity provider did not return the information we need. Please try again, or contact your administrator." |
| `config_unavailable` | "We could not verify eligibility right now. Please try again in a moment." |
| `deactivated` | "This account is currently deactivated. Contact the tournament administrator." |
| _anything else_ | "We could not complete sign-in. Please try again, or contact your administrator." |

The page MUST NOT reveal:
- Whether a participant exists for the attempted identity.
- The approved-domain list.
- Whether the rejection came from the auth hook, RLS, or the API guard.

The page DOES include a "Sign in with a different account" link that clears the Supabase session cookie and redirects to `/`.

## Security invariants

- The page is a **server component**; it does not pass session tokens into a client bundle.
- No `console.log` of session data or IdP claims. Diagnostic logging goes through `next/server` logging primitives to the server-side logger only.
- No `next-rewrites` or middleware-level bypass of the page; the auth hook is the source of truth, and the page mirrors its decision.
- The route MUST be accessible without authentication (denial screen is reached by denied users); the auth-callback step requires the OAuth `code` and is otherwise inaccessible.

## Test surface

| File | Test |
|---|---|
| `slice-001-callback-success.spec.ts` (Playwright) | Stub OIDC for eligible user; visit `/auth/callback?code=...`; assert redirect to `/dashboard` and `participants` row exists |
| `slice-001-callback-denied-domain.spec.ts` (Playwright) | Stub OIDC for ineligible domain; visit `/auth/callback?code=...`; assert redirect to `/auth/denied?reason=domain_not_approved` and denial screen renders the matching message |
| `slice-001-denied-no-leak.spec.ts` (Playwright) | Visit `/auth/denied?reason=anything_else`; assert generic message is rendered (no info leak even on unknown reason codes) |
| `slice-001-denied-renders-without-session.spec.ts` (Playwright) | Visit `/auth/denied?reason=domain_not_approved` with NO cookies; assert 200 + denial renders (no redirect loop) |
| `slice-001-callback-no-code.spec.ts` (Playwright) | Visit `/auth/callback` with no `?code=`; assert redirect to `/auth/denied?reason=unknown` (not a 500) |

## Cross-slice contract

- The denial screen's URL `/auth/denied?reason=<code>` is referenced by `/api/me`'s 403 response (frontend handler may redirect to it). The `reason` codes are a closed set; new reasons require updating both this page and the contract.
- The redirect URL `/dashboard` is a Slice-002+ surface; this slice ships a placeholder dashboard that simply says "Welcome, <display_name>" until later slices replace it.

## Implementation notes (for `/speckit-tasks` to expand)

- The OIDC stub used in tests is `@supabase/auth-helpers` test mode + a small custom mock for the IdP callback URL. Real production uses Entra ID; the contract above is provider-agnostic.
- The denial-screen messages are i18n-ready strings keyed by `reason`. NFR-010 (English + Spanish + future locales): use `next-intl` or equivalent. Out of scope for this slice; the strings ship in English-only.
- The page must work without JavaScript (denial screen is plain HTML/CSS) so users with strict browser policies still see the message.
