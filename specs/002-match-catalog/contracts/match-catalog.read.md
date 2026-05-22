# Contract: `GET /api/matches` — Match catalog read

**Slice**: 002-match-catalog
**Date**: 2026-05-15
**Status**: Phase 1 (Plan).

The paginated read surface for the participant-facing match list. The single endpoint serves every catalog view (full schedule, group filter, live matches, post-match results). Implemented as a Next.js App Router route handler in `apps/web/app/api/matches/route.ts`, using the **user's** Supabase JWT — no service-role.

## Request

```
GET /api/matches?<filters>&page=<n>&page_size=<m>
Authorization: Bearer <supabase-session-jwt>
```

### Query parameters

| Param | Type | Default | Multi? | Notes |
|---|---|---|---|---|
| `stage` | enum | (all) | yes | One of `group`, `r16`, `qf`, `sf`, `final`, `third_place`. Comma-separated for multi. |
| `group` | string | (all) | yes | Group letter for group-stage filtering. E.g., `A`, `B`, … `L`. |
| `status` | enum | (all) | yes | `scheduled`, `in_progress`, `finished`, `postponed`, `cancelled`. |
| `team_id` | uuid | (all) | yes | Matches involving any of the supplied teams (home OR away). |
| `from` | ISO-8601 UTC | (none) | no | `kickoff_utc >= from`. |
| `to` | ISO-8601 UTC | (none) | no | `kickoff_utc < to` (exclusive upper bound — half-open windows compose). |
| `page` | int ≥ 1 | `1` | no | 1-indexed. |
| `page_size` | int (1..200) | `50` | no | Clamped at 200; values outside the range are rejected with 400. |
| `sort` | enum | `kickoff_utc_asc` | no | One of `kickoff_utc_asc` (default), `kickoff_utc_desc`. Limited deliberately — additional sorts open future N+1 query patterns. |

Multi-valued filters accept comma-separated lists: `?stage=group,r16&team_id=abc,def`.

No body. No cookies other than the session.

## Response

### 200 OK

```jsonc
{
  "matches": [
    {
      "id": "uuid",
      "home_team": {
        "id": "uuid",
        "name": "Argentina",
        "short_code": "ARG",
        "flag_url": "https://cdn.example.com/flags/arg.png"
      },
      "away_team": { "id": "uuid", "name": "Brazil", "short_code": "BRA", "flag_url": null },
      "stage": "group",
      "group_id": "A",
      "kickoff_utc": "2026-06-12T20:00:00Z",         // ISO-8601 UTC; client localizes via Intl.DateTimeFormat
      "venue": "MetLife Stadium",
      "status": "scheduled",
      "match_result": null                            // null when status != 'finished'; populated otherwise
    },
    {
      "id": "uuid",
      "home_team": { ... },
      "away_team": { ... },
      "stage": "r16",
      "group_id": null,
      "kickoff_utc": "2026-07-04T16:00:00Z",
      "venue": "AT&T Stadium",
      "status": "finished",
      "match_result": {
        "home_score_official": 3,
        "away_score_official": 2,                     // displayed as-is — UI may render "3-2 (4-3 on penalties)"
        "home_score_for_scoring": 2,                  // Slice 005 reads this; consumer UI usually does NOT
        "away_score_for_scoring": 2,
        "result_status": "penalties_shootout",
        "approved_at": "2026-07-04T19:30:00Z"
      }
    }
  ],
  "page": 1,
  "page_size": 50,
  "total": 104
}
```

### 400 Bad Request

Returned for:
- `page` ≤ 0 or non-integer.
- `page_size` outside `[1, 200]`.
- `from > to` (inverted window).
- `stage` / `status` value not in the allowed enum.
- `sort` value not in the allowed enum.

```jsonc
{ "error": { "code": "BAD_REQUEST", "message": "page_size must be between 1 and 200" } }
```

### 401 Unauthorized

No JWT / invalid JWT. Same body shape as `/api/me`.

```jsonc
{ "error": { "code": "UNAUTHENTICATED", "message": "Sign in to continue." } }
```

### 403 Forbidden

JWT valid but caller is no longer eligible (mid-session domain removal — Slice 001 Clarifications 2026-05-15). Same body shape as `/api/me`. `requireEligible()` writes the `access.denied` / `source='api_guard'` audit row.

```jsonc
{ "error": { "code": "DOMAIN_NOT_APPROVED", "message": "This application is restricted to approved Nortal corporate identities." } }
```

### 500 Internal Server Error

Genuine infrastructure failure (Postgres unreachable). The body matches the 401 shape with `code: "INTERNAL"`. Eligibility decisions that *cannot* be made fail closed (403), never as 500.

## Server behavior

1. Parse the Supabase session JWT from App Router cookies. Absent or invalid → 401.
2. Validate query params; on validation failure → 400 (before eligibility check, to avoid leaking "eligible-but-bad-input" timing).
3. Call `requireEligible(client)` from Slice 001's lib. On `EligibilityDeniedError` → 403 (audit row written by `requireEligible`).
4. Build the SQL query from the validated filters. The query runs **as the user** (the user-JWT-bound Supabase client), so RLS is applied automatically:
   - `matches_eligible_read` policy filters out nothing for an eligible participant (the predicate is "is the caller eligible?", not "does this match belong to the caller").
   - `match_results_eligible_read` same.
   - `teams_eligible_read` same.
5. Construct the response with `match_result` joined only when `matches.status='finished'`.
6. Set `Cache-Control: private, max-age=10, must-revalidate` — the catalog is read-heavy but eligibility-bound; brief client cache is fine but no edge caching.

## Server-side query shape (illustrative)

```sql
WITH filtered AS (
  SELECT m.*, ht.*, at.*  -- aliased columns
  FROM   public.matches m
  JOIN   public.teams ht ON ht.id = m.home_team_id
  JOIN   public.teams at ON at.id = m.away_team_id
  WHERE  ($1::stage[] IS NULL OR m.stage = ANY ($1))
    AND  ($2::text[]  IS NULL OR m.group_id = ANY ($2))
    AND  ($3::status[] IS NULL OR m.status = ANY ($3))
    AND  ($4::uuid[]  IS NULL OR m.home_team_id = ANY ($4) OR m.away_team_id = ANY ($4))
    AND  ($5::timestamptz IS NULL OR m.kickoff_utc >= $5)
    AND  ($6::timestamptz IS NULL OR m.kickoff_utc <  $6)
)
SELECT *, COUNT(*) OVER () AS total_rows
FROM   filtered
ORDER  BY kickoff_utc ASC, id ASC      -- id break for deterministic order
OFFSET ($7 - 1) * $8
LIMIT  $8;
```

The `LEFT JOIN match_results` is performed in a separate query (or inline JOIN) only for rows with `status='finished'`. Two-query approach avoids the planner choosing a bad join for the all-scheduled common case.

## Caching posture

| Layer | Caching? | Why |
|---|---|---|
| Browser | `Cache-Control: private, max-age=10` | Catalog is mostly static between syncs; 10s of staleness is invisible to the participant |
| Vercel CDN | NOT cached (route handler with auth) | Eligibility is per-session; cannot share across users |
| Postgres | Implicit row-cache at PG layer | Acceptable; bounded by RLS |

## Security invariants

- The route handler **never** uses the service-role key. The participant's own JWT drives every query.
- 403 body NEVER reveals participant existence or admin state.
- The route MUST NOT honor any debug / impersonation query param (`as_user`, `participant_id`, etc.).
- Pagination MUST bound `page_size` server-side; a client sending `page_size=10000` MUST get a 400, not a 200 with 104 rows.
- The `match_result.home_score_for_scoring` field is exposed in the response for Slice 005's potential client-side reconciliation needs; it is harmless to expose because the response is RLS-gated to eligible participants who would see the value in `/me/breakdown` anyway.

## Test surface

Authored as Playwright + pgTAP under their respective directories:

| File | Test |
|---|---|
| `slice-002-catalog-eligible-200.spec.ts` (Playwright) | Sign in eligible; `GET /api/matches`; assert 200 + body matches seed fixture |
| `slice-002-catalog-401.spec.ts` (Playwright) | No cookie; assert 401 |
| `slice-002-catalog-403-domain-removed.spec.ts` (Playwright) | Sign in; admin removes domain; assert 403 + audit row |
| `slice-002-catalog-filters.spec.ts` (Playwright) | Single-fixture query each filter (stage, group, status, team_id, from/to) returns expected subset |
| `slice-002-catalog-pagination.spec.ts` (Playwright) | `page_size=10` produces 10 rows; next page yields the next 10; `total` consistent across pages |
| `slice-002-catalog-bad-params.spec.ts` (Playwright) | `page_size=10000` → 400; inverted `from > to` → 400; unknown `stage` → 400 |
| `slice-002-catalog-no-leak.spec.ts` (Playwright) | 403 body contains no admin info, no other participants, no provider info |
| `slice-002-catalog-locale-display.spec.ts` (Playwright) | Set browser locale to `es-ES`; UI renders kickoff time localized; underlying `kickoff_utc` in payload stays UTC (verifies SC-004) |
| `slice-002-catalog-rls.sql` (pgTAP) | Direct REST call with participant JWT returns expected rows; with non-Nortal JWT returns zero |

All tests RED-first per Constitution Principle IX before the route handler implementation.

## Cross-slice contract

- The `Match` and `MatchResult` TypeScript types in `apps/web/lib/types/match.ts` (defined by this slice) are the cross-slice consumer type. Slices 003 (prediction display joins matches), 004 (final-prediction validation against `teams`), 005 (leaderboard joins matches for breakdown) all import from this type module.
- Adding a field to the response is non-breaking. Removing or renaming requires updates across consumers (Principle XI).
