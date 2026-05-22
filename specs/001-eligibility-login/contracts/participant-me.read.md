# Contract: `GET /api/me` — Current participant read

**Slice**: 001-eligibility-login
**Date**: 2026-05-15
**Status**: Phase 1 (Plan).

The minimum read surface this slice exposes to the participant client: "tell me my own profile." Every other UI screen depends on it (the participant-side header, the dashboard, the eventual prediction pages in slices 003–005). Implemented as a Next.js App Router route handler reading `public.participants` via the **user's** Supabase JWT — no service-role.

## Request

```
GET /api/me
Authorization: Bearer <supabase-session-jwt>
```

No body. No query params.

## Response shape

### 200 OK (caller is an eligible participant)

```jsonc
{
  "participant": {
    "id": "uuid",                              // participants.id (the cross-slice key)
    "display_name": "Kevin Cadavid",
    "email": "kevin.cadavid@nortal.com",       // self-only; never returned for any other participant
    "domain": "nortal.com",                    // derived; convenient for client-side display
    "region": "EE-North",                      // nullable
    "status": "active",
    "first_login_at": "2026-05-15T12:34:56Z",
    "last_login_at": "2026-05-15T18:42:01Z"
  }
}
```

### 401 Unauthorized (no JWT or JWT signature invalid)

```jsonc
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Sign in to continue."
  }
}
```

### 403 Forbidden (JWT valid, but caller is no longer eligible — mid-tournament domain removal)

```jsonc
{
  "error": {
    "code": "DOMAIN_NOT_APPROVED",
    "message": "This application is restricted to approved Nortal corporate identities."
  }
}
```

The 403 body is **identical** to the auth-hook denial body. Frontend code can render a single denial screen for both paths.

### 500 Internal Server Error

Returned only on genuine infrastructure failure (Supabase unreachable mid-request). The error body matches the 401/403 shape with `code: "INTERNAL"`. Eligibility decisions that *cannot* be made (config unreachable per R-007) fail closed as 403, not 500.

## Server behavior

1. Parse the Supabase session JWT (App Router cookies). If absent or invalid → 401.
2. Call `requireEligible(client)` helper (R-009):
   - `SELECT is_eligible_nortal_participant(auth.uid())` via the user-JWT-bound client.
   - If `false` → write audit row `action='access.denied', reason='domain_not_approved', source='api_guard', actor=<participants.id if known else NULL>`, return 403.
   - If `true` → proceed.
3. `SELECT id, display_name, email, domain, region, status, first_login_at, last_login_at FROM participants WHERE auth_user_id = auth.uid()`. RLS guarantees only the caller's row is returned.
4. Return 200 with the participant body.

**No write side-effects** on a 200 path. `last_login_at` is owned by the auth hook (R-010); `/api/me` MUST NOT advance it on every page load (would mask the auth-hook bug we want to detect).

## Caching posture

| Layer | Caching? | Why |
|---|---|---|
| Browser | `Cache-Control: private, max-age=0, must-revalidate` | Per-user, must re-check on every navigation |
| Vercel CDN | not cached (route handler with auth) | Eligibility decisions cannot be cached at the edge — they're per-session and dependent on live config (FR-007) |
| Supabase | implicit row cache at the Postgres level | acceptable; bounded by RLS |

## Security invariants

- The route handler **never** uses the service-role key. The participant's own JWT drives every query.
- The 403 body NEVER reveals the existence of other participants, other domains, or the approved-domain list. It exists *because* of the spec Acceptance Scenario US2.1 ("display a clear denial message without leaking information about other accounts or domains").
- The route MUST NOT honor an `as_user` or `participant_id` query parameter. There is no debug bypass.
- A request with a valid Supabase Auth JWT but no `participants` row (race window between IdP success and auth-hook completion — should be impossible per R-004's same-transaction guarantee, but defensive) returns 403 with `reason='participant_not_provisioned'`, audited.

## Test surface

| File | Test |
|---|---|
| `slice-001-api-me-200.spec.ts` (Playwright) | Sign in as eligible; GET `/api/me`; assert 200 + body matches participants row |
| `slice-001-api-me-401.spec.ts` (Playwright) | GET `/api/me` with no cookie; assert 401 + body shape |
| `slice-001-api-me-403-domain-removed.spec.ts` (Playwright) | Sign in eligible; admin removes domain; GET `/api/me`; assert 403 + audit row written |
| `slice-001-api-me-no-leak.spec.ts` (Playwright) | Sign in as ineligible (rejected at auth hook so technically no JWT — synthesize a JWT for an `auth.users` row that *would* be ineligible if domain check ran on it); assert 403 body identical to UI denial; assert response headers contain no `X-` debugging info |
| `slice-001-api-me-rls.sql` (pgTAP) | With participant Alpha's JWT, `SELECT … FROM participants` returns exactly Alpha's row; never any other participant's row |

## Frontend contract (consumed by `apps/web/`)

- Server components and client components MUST fetch the current participant via this route, never by direct Supabase SDK access to `participants`. This centralizes the eligibility re-check (R-009) on every page.
- The TypeScript helper `apps/web/lib/auth/getCurrentParticipant(): Promise<Participant | null>` wraps this endpoint and is the only sanctioned way for frontend code to obtain `participants.id`.

## Cross-slice contract

The `participant` object shape returned by 200 is a cross-slice contract:
- Slices 002–005 import the same `Participant` TypeScript type from `apps/web/lib/types/participant.ts`.
- Adding a field is permitted (additive change).
- Removing or renaming a field is a contract break and requires updating every consumer slice in the same change set (Principle XI).
