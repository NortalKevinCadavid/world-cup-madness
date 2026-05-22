# Contract: Predictions read paths

**Slice**: 003-match-predictions
**Date**: 2026-05-16
**Status**: Phase 1 (Plan).

Two read surfaces this slice introduces, plus one **additive extension** to Slice 002's already-locked `/api/matches` contract:

1. **`GET /api/me/predictions`** — the participant's own active predictions. New endpoint.
2. **`GET /api/me/predictions?match_id=<uuid>`** — single-match variant of the same endpoint.
3. **`/api/matches` response gains `lock_state` field** — additive extension of `specs/002-match-catalog/contracts/match-catalog.read.md`. Slice 002's contract notes: *"Adding a field is permitted (additive change)."*

History queries (e.g., "show me my full prediction chain for match M") are NOT exposed by this slice; Slice 005's personal-breakdown surface handles them.

## Endpoint — `GET /api/me/predictions`

### Request

```
GET /api/me/predictions
GET /api/me/predictions?match_id=<uuid>
Authorization: Bearer <supabase-session-jwt>   (or cookies)
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `match_id` | uuid | (all) | When present, returns at most one prediction (the active one for that match). |

### Response

#### 200 OK — successful read

```jsonc
{
  "predictions": [
    {
      "id": "uuid",
      "match_id": "uuid",
      "predicted_home": 2,
      "predicted_away": 1,
      "submitted_at": "2026-06-12T18:00:00Z",
      "source": "ui"
    }
  ]
}
```

When `match_id` is supplied and no prediction exists for that match: `{ "predictions": [] }`. When `match_id` is supplied and the active prediction is from `source='admin_override'`: returned with `source` set accordingly so the UI can render an "Set by administrator" note.

Returns ONLY rows with `superseded_at IS NULL` (the active predictions). History is out of scope here (see Slice 005's breakdown).

#### 400 Bad Request — malformed query param

```jsonc
{ "error": { "code": "BAD_REQUEST", "message": "match_id must be a valid UUID" } }
```

#### 401 Unauthorized — no session

Same body shape as `/api/me` (Slice 001).

#### 403 Forbidden — caller no longer eligible

Same body shape as `/api/me`.

### Server behavior

1. Parse Supabase session cookie. Absent → 401.
2. Validate `match_id` param shape (if present); invalid → 400.
3. `await requireEligible(client)`. On denial → 403.
4. Query (RLS-bound to user JWT):
   ```sql
   SELECT id, match_id, predicted_home, predicted_away, submitted_at, source::text
   FROM   public.predictions
   WHERE  participant_id = (SELECT id FROM public.participants WHERE auth_user_id = auth.uid())
     AND  superseded_at IS NULL
     [AND match_id = $1]                  -- only when ?match_id= present
   ORDER  BY submitted_at DESC;
   ```
   (RLS on `predictions` from this slice's `predictions_self_read` policy enforces the same predicate. The explicit `participant_id =` is for clarity + plan stability.)
5. Return 200 with the body shape.

`Cache-Control: private, max-age=0, must-revalidate` on every response — predictions are mutable participant state.

### Security invariants

- The handler **never** uses the service-role key.
- The handler MUST NOT honor `participant_id` query params or impersonation headers — the RLS predicate is the only path to data.
- The 403 body NEVER reveals participant identities or admin state.

### Test surface

| File | Test |
|---|---|
| `slice-003-me-predictions-empty.spec.ts` | Newly-signed-in participant with no predictions; GET `/api/me/predictions`; assert 200 + `{predictions: []}` |
| `slice-003-me-predictions-list.spec.ts` | Submit 3 predictions for different matches; GET `/api/me/predictions`; assert 200 + 3 entries in the response array |
| `slice-003-me-predictions-match-filter.spec.ts` | Submit a prediction; GET `/api/me/predictions?match_id=<that-match>`; assert exactly 1 entry. GET with different match_id; assert 0 entries |
| `slice-003-me-predictions-after-supersede.spec.ts` | Submit 1-0, then 2-1 same match; GET; assert exactly 1 entry with `predicted_home=2, predicted_away=1` (the active row) |
| `slice-003-me-predictions-401.spec.ts` | GET with no session → 401 |
| `slice-003-me-predictions-403.spec.ts` | Sign in; admin removes domain; GET → 403 |
| `slice-003-me-predictions-bad-match-id.spec.ts` | GET `?match_id=not-a-uuid` → 400 |
| `slice-003-me-predictions-rls.sql` (pgTAP) | Participant A submits a prediction. Participant B's JWT executes the same SELECT against the predictions table; B sees zero rows |

## Additive extension to `/api/matches`

The Slice 002 contract permits adding fields to the `/api/matches` response (`specs/002-match-catalog/contracts/match-catalog.read.md` § Cross-slice contract). This slice adds **one new field per match row**:

| Field | Type | Notes |
|---|---|---|
| `lock_state` | `"editable"` &#124; `"locked"` | Server-computed via `public.is_prediction_locked(m.id)` at SELECT time. `"locked"` when remaining time ≤ `lock_window_minutes` OR `matches.status <> 'scheduled'`. |

The full extended response (only the new field added; rest unchanged from Slice 002):

```jsonc
{
  "matches": [
    {
      "id": "uuid",
      "home_team": { ... },
      "away_team": { ... },
      "stage": "group",
      "group_id": "A",
      "kickoff_utc": "2026-06-12T20:00:00Z",
      "venue": "MetLife Stadium",
      "status": "scheduled",
      "lock_state": "editable",           // NEW — added by Slice 003
      "match_result": null
    }
  ],
  "page": 1,
  "page_size": 50,
  "total": 104
}
```

### Server behavior change

The route handler at `apps/web/app/api/matches/route.ts` (owned by Slice 002) is modified to include `lock_state` in the SELECT projection. The SELECT becomes:

```sql
SELECT
  m.id, m.stage, m.group_id, m.kickoff_utc, m.venue, m.status,
  -- ... home_team, away_team join columns ...
  CASE WHEN public.is_prediction_locked(m.id) THEN 'locked' ELSE 'editable' END AS lock_state
FROM   public.matches m
JOIN   public.teams ht ON ht.id = m.home_team_id
JOIN   public.teams at ON at.id = m.away_team_id
-- ... filters, pagination, ORDER BY ...
```

This slice's task to modify the route handler is owned here, not by Slice 002 (Slice 002 has shipped by the time this slice starts).

### TypeScript type extension

The `Match` type at `apps/web/lib/types/match.ts` (owned by Slice 002) is extended:

```typescript
// Owned by Slice 002; extended by Slice 003
export interface Match {
  // ... existing fields from Slice 002 ...
  lock_state: "editable" | "locked";  // NEW — Slice 003
}
```

Slice 002's type-export commitment: "Adding a field is non-breaking." This extension does not require a coordinated change set with downstream consumers — Slice 002's existing consumers ignore the new field; this slice's UI reads it.

### Test surface

| File | Test |
|---|---|
| `slice-003-matches-lock-state-editable.spec.ts` | Sign in eligible; pre-seed match kickoff > 60 min out; GET `/api/matches`; assert that match's `lock_state === 'editable'` |
| `slice-003-matches-lock-state-locked-window.spec.ts` | Pre-seed match kickoff = now() + 59 minutes; GET; assert `lock_state === 'locked'` |
| `slice-003-matches-lock-state-locked-status.spec.ts` | Pre-seed match status='in_progress' with kickoff far in future; GET; assert `lock_state === 'locked'` |
| `slice-003-matches-lock-state-boundary.spec.ts` | Match kickoff = now() + lock_window exactly; GET; assert `lock_state === 'locked'` (strict BR-LOCK-003 boundary) |
| `slice-003-matches-lock-state-after-config-change.spec.ts` | Match kickoff = now() + 70 minutes; GET; assert editable. Bump `tournament_config.lock_window_minutes` from 60 to 90. GET again within 1 minute. Assert `lock_state === 'locked'`. Demonstrates SC-005 |

## Cross-slice contract summary

| Surface | Locked? |
|---|---|
| `GET /api/me/predictions` request/response | **Locked** — Slice 003's own UI consumes it; future mobile + admin tooling may |
| Response field shape (id, match_id, predicted_home, predicted_away, submitted_at, source) | **Locked** — adding fields is permitted; renaming/removing requires coordinated update |
| `/api/matches` response gains `lock_state` field | **Additive over Slice 002's contract** — existing consumers ignore; new consumers can rely on the field's presence |
| `Match.lock_state` TypeScript type | **Locked union** — `"editable" | "locked"`; adding a third state requires coordinated update |

## Implementation notes (for `/speckit-tasks` to expand)

- The `lock_state` field is computed via `public.is_prediction_locked()` per row. For a 104-row catalog query, that's 104 function calls — STABLE-volatility memoization within the query plan keeps cost bounded.
- The `/api/me/predictions` route handler can be cached at the Postgres plan layer (the parameterized SELECT will be plan-cached after first invocation per role), but the route MUST NOT add edge caching — predictions are per-participant mutable state.
- The Next.js `/matches` page extends Slice 002's page to read `lock_state` and conditionally render the prediction-entry form. Slice 002's page already SSR-fetches `/api/matches`; the extension is a small JSX delta.
