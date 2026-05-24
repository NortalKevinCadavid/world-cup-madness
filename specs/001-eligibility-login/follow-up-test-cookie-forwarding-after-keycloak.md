# Slice 001 follow-up: test specs across slices 001-006 must forward cookies to `request.get/post` calls after the Keycloak/PKCE migration

**Filed**: 2026-05-23
**Discovered by**: full Playwright suite run (`apps/web/playwright-full-run.log`) — 81 failures of 195 chromium tests; ~50 of them trace to this single pattern.
**Severity**: high — every test that signs in via the OIDC fixture and then makes an API call through the bare `request` fixture fails authentication. Tests written before the slice 001 OIDC migration assumed `{ page, request }` shared storage; after the migration they no longer do.
**Surface**:
- `apps/web/tests/playwright/fixtures/oidc.ts` (the OIDC fixture rewritten in commit `5a74acf`)
- ~50 spec files across slices 001 / 002 / 003 / 004 / 006 (every spec that does `signInWithIdentity(page, …)` then `request.get/post(…)` without explicit cookie forwarding)
- Precedent fix patterns (already shipped):
  - `tests/playwright/slice-003-matches-lock-state-boundary.spec.ts` — forwards `await context.cookies()` as a `Cookie` header on every `request.get`.
  - `tests/playwright/slice-005-match-scoring.spec.ts` — `extractAccessTokenFromBrowserContext(context)` + `Authorization: Bearer <jwt>` for Edge Runtime calls.
  - `tests/playwright/slice-005-peer-pick-visibility.spec.ts` — same cookie/JWT bridge for both the route handler and `/rest/v1/...` direct-REST calls.

## Symptom

A signed-in `signInWithIdentity(page, …)` is followed by a `request.get('/api/...')` call that asserts `status === 200`; the call instead returns `401`:

```text
✘  47  slice-002-catalog-403-domain-removed.spec.ts › mid-session domain removal flips /api/matches to 403
       Error: alpha's pre-removal /api/matches call must be 200 (sanity check)
       Expected: 200
       Received: 401
```

The test is doing exactly what it says — signing in as alpha, then sanity-checking `/api/matches`. Sanity check fails because the unauthenticated `request` fixture doesn't see alpha's session.

## Root cause

Before commit `5a74acf` ("fix(slice-001): make local auth chain actually sign in"), the OIDC stub was based on `navikt/mock-oauth2-server` and the Supabase session was stored in `window.localStorage` under `sb-*-auth-token`. Playwright's `request` fixture would pick up storage state via the `use.storageState` config, so a test that signed in via `page` could then hit the API via `request` and remain authenticated.

After commit `5a74acf`, the OIDC stub is Keycloak 25 and the Supabase session is stored in `sb-*-auth-token.<index>` **cookies** on the page's `BrowserContext`. The `request` fixture is a separate `APIRequestContext` whose storage state is **not** automatically synchronized with the page's cookie jar. Every `request.get/post` therefore lands at the route handler without an auth cookie, the route's `requireEligible()` returns `no_session`, and the response is a 401.

Slice 005's follow-up cascade hit this first; the fix pattern is one of:

1. **Forward the page's cookies as a `Cookie` header** (used for route-handler reads — slice-003 lock-state suite, slice-005 peer-pick spec):
   ```ts
   const cookies = await context.cookies();
   const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
   const response = await request.get('/api/matches', { headers: { Cookie: cookieHeader } });
   ```

2. **Extract the JWT from the cookie chunks and forward as `Authorization: Bearer <jwt>`** (used for Edge Runtime calls + direct `/rest/v1/...` PostgREST hits — slice-005-match-scoring + slice-005-peer-pick-visibility):
   ```ts
   const accessToken = await extractAccessTokenFromBrowserContext(context);
   const response = await request.post(SCORE_TRIGGER_ENDPOINT, {
     headers: { Authorization: `Bearer ${accessToken}` },
     // ...
   });
   ```

3. **Use `page.request` instead of `request`** (cheapest when the test only needs cookie-bound calls; `page.request` shares the page's `BrowserContext`):
   ```ts
   const response = await page.request.get('/api/me');
   ```

## Affected specs

The script that surfaces every spec in scope is:

```sh
grep -l 'await request\.get\|await request\.post' tests/playwright/*.spec.ts
```

Currently **78 spec files** match; **~50 of them sign in via `signInWithIdentity(page, …)` before making the call** (the other ~28 either intentionally test no-cookie / unauthenticated branches, or are already cookie-forwarding correctly).

The dominant clusters from the full-suite run (`apps/web/playwright-full-run.log`):

| Slice | Affected specs (subset, not exhaustive) |
|-------|---------------------------------------|
| 002 | catalog-403-domain-removed, catalog-eligible-200, catalog-filters (x6), catalog-locale-display (x4), catalog-no-leak, catalog-pagination (x2) |
| 003 | me-predictions-* (x5), submit-* (x10 — happy, supersede, direct-api-rejected, domain-removed, invalid-*, locked-*) |
| 004 | me-final-predictions-* (x4), submit-* (x14 — champion-happy, top-scorer, all-four, invalid-*, locked-*, just-before-lock, concurrent-tabs, removed-player) |
| 006 | admin-audit-by-target, admin-audit-detail, admin-audit-search, admin-final-predictions-submit, admin-finals-* (x2), admin-match-* (x2), admin-pending-review-resolve, admin-recalc-* (x3) |

## Why not a fixture-level fix?

The temptation is to "just sync cookies into `request` once in a `beforeEach`." That works for the simple case but breaks several edge cases the suite explicitly relies on:

- **Mid-test re-authentication.** Several specs (slice-001's domain-removal flow, slice-003's submit-domain-removed) sign in, mutate config, then expect a *fresh* `/api/...` call to fail. Auto-syncing cookies at fixture time would inject stale auth.
- **Direct-API-rejected scenarios** intentionally test that an unauthenticated `request` is rejected. Auto-syncing would defeat those.
- **`page.request` vs `request` semantics** are documented; quietly making them equivalent is a footgun for future authors who want one or the other.

The proven pattern (forward explicitly per call) is verbose but exact. It also matches what real attackers would do — forward a captured session cookie, not a magic browser context.

## Recommendation

**Sweep the ~50 affected specs and apply pattern #1 or #2 above per the call kind:**

- Route-handler GETs / POSTs through `/api/...` → cookie header forwarding (pattern #1).
- Edge Runtime / Supabase `/functions/v1/...` → JWT bearer (pattern #2).
- Direct `/rest/v1/...` PostgREST → JWT bearer (pattern #2) — exactly what slice-005-peer-pick-visibility Tests 4 + 5 did after this same fix.

A single sweep commit per slice is the right granularity — each is a mechanical change, easily reviewed, and keeps the test-fix history bisectable.

The pattern is documented in two reference specs:
- `tests/playwright/slice-003-matches-lock-state-boundary.spec.ts:46-55` — the canonical cookie-header forwarding.
- `tests/playwright/slice-005-match-scoring.spec.ts:225-253` — the canonical JWT extractor.

## Status

**Open** — fix pattern proven on slice 005, sweep of slices 001-004 + 006 not yet performed.

## Related follow-ups

This is one of several distinct failure classes surfaced by the full-suite run. The others (filed separately or to be filed):

- **Keycloak fixture seed-user list incomplete** — `Error: OIDC fixture: claims.email="X" does not match a seeded Keycloak user.` fires for `outsider@example.com`, `newcomer@nortal.com`, `freshie@nortal.com`, `alpha-aka@nortal.com`, `no-name@nortal.com`, `newcomer-04@nortal.com`. The Keycloak realm needs every claimed email pre-provisioned, or the fixture needs a JIT user-creation path. ~7 failures.
- **`/admin/*` infinite redirect loop** — `net::ERR_TOO_MANY_REDIRECTS` on `/admin`, `/admin/denied`, `/admin/audit/search`. Likely interacts with the new `isRenderingDeniedPage()` header check in `apps/web/app/admin/layout.tsx` against the slice 009 layout. ~5 failures.
- **Mid-session domain-removal not invalidating `/api/me`** — `/api/me` returns 200 instead of 403 after `approved_domains` is flipped to `[]`. The cached eligibility check isn't re-evaluating per request. ~3-4 failures.
- **Slice 009 UI selectors broke pre-009 tests** — `element(s) not found` (6 failures), strict-mode locator violations (`textarea[name='reason']` resolved to 2 elements), success-toast assertions failing — slice 009's redesign changed DOM that older selectors anchored on.
- **`slice-005-final-scoring` AS1 fails in full-suite mode only** — passes in isolation; preceding tests leave score_records / calculation_version in a state where the new run is a no-op. State-isolation fix needed in the test's `beforeEach`.
- **`audit_log` RLS missing DELETE for fixture teardown** — `Error: deleteAuditRow(<uuid>): permission denied for table audit_log` from slice-006 audit specs' cleanup helpers.
- **es-ES locale display** — slice-002 catalog renders English "Jun" instead of Spanish "jun". Slice 009 may have hard-coded the locale.

Filing each as its own follow-up keeps the cleanup work parallelizable. This document covers the largest-and-most-mechanical class.
