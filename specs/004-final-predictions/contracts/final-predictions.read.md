# Contract: Final Predictions read paths

**Slice**: 004-final-predictions
**Date**: 2026-05-16
**Status**: Phase 1 (Plan).

Three read surfaces this slice introduces:

1. **`GET /api/me/final-predictions`** — the participant's own active final predictions + the global lock state.
2. **`GET /api/teams`** — RLS-gated team list for the picker UI (thin wrapper over Slice 002's `teams` table).
3. **`GET /api/players`** — RLS-gated player roster with `?team_id=` and `?q=` filters for the picker UI.

Slice 005's `peer_final_pick_v` view (post-lock peer visibility) is owned by Slice 005 and not specified here.

## Endpoint — `GET /api/me/final-predictions`

### Request

```
GET /api/me/final-predictions
Authorization: Bearer <supabase-session-jwt>   (or cookies)
```

### Response — 200 OK

```jsonc
{
  "final_predictions": [
    {
      "id": "uuid",
      "item_kind": "champion",
      "target_team_id": "uuid",
      "target_player_id": null,
      "submitted_at": "2026-06-12T15:00:00Z",
      "source": "ui"
    },
    {
      "id": "uuid",
      "item_kind": "top_scorer",
      "target_team_id": null,
      "target_player_id": "uuid",
      "submitted_at": "2026-06-12T15:30:00Z",
      "source": "ui"
    }
  ],
  "lock_state": "editable",                 // "editable" | "locked" — computed via is_final_prediction_locked()
  "first_kickoff_utc": "2026-07-15T16:00:00Z"  // ISO-8601 UTC; null if not yet set
}
```

Returns ONLY active rows (`superseded_at IS NULL`). Unset items are absent from the array. `lock_state` is server-computed via `public.is_final_prediction_locked()`. `first_kickoff_utc` is provided so the UI can render its own countdown indicator (display-only; the API's `lock_state` is authoritative).

History queries (full supersede chain per participant per item) are OUT OF SCOPE for this slice — Slice 005's `/me/breakdown` owns the participant history view (mirrors Slice 003 Clarifications 2026-05-16 Q3).

### Error responses

| Status | Body | Cause |
|---|---|---|
| 401 | `{error: {code: "UNAUTHENTICATED", ...}}` | No session |
| 403 | `{error: {code: "DOMAIN_NOT_APPROVED", ...}}` | Caller no longer eligible |
| 500 | `{error: {code: "INTERNAL", ...}}` | Infrastructure |

### Server behavior

1. Parse session cookie → 401 if missing.
2. `await requireEligible(client)` → 403 on denial.
3. Query (RLS-bound):
   ```sql
   SELECT id, item_kind::text, target_team_id, target_player_id, submitted_at, source::text
   FROM   public.final_predictions
   WHERE  participant_id = (SELECT id FROM public.participants WHERE auth_user_id = auth.uid())
     AND  superseded_at IS NULL;
   ```
4. Separate query: `SELECT public.is_final_prediction_locked()`. Capture result for `lock_state`.
5. Separate query: `SELECT (value::text)::timestamptz FROM public.tournament_config WHERE key = 'first_kickoff_utc'`. Capture for the response.
6. Compose and return 200 with the shape above.

`Cache-Control: private, max-age=0, must-revalidate`.

### Test surface

| File | Test |
|---|---|
| `slice-004-me-final-predictions-empty.spec.ts` | New participant; GET → `final_predictions: []`, `lock_state` reflects config |
| `slice-004-me-final-predictions-list.spec.ts` | Participant has 3 of 4 picks submitted; GET → 3 entries |
| `slice-004-me-final-predictions-after-supersede.spec.ts` | Submit champion = A, then = B; GET → 1 entry for champion with `target_team_id=B` |
| `slice-004-me-final-predictions-lock-state-editable.spec.ts` | first_kickoff_utc far in future; GET → `lock_state='editable'` |
| `slice-004-me-final-predictions-lock-state-locked.spec.ts` | first_kickoff_utc in past; GET → `lock_state='locked'` |
| `slice-004-me-final-predictions-lock-state-at-boundary.spec.ts` | first_kickoff_utc = now(); GET → `lock_state='locked'` (strict BR-LOCK-005) |
| `slice-004-me-final-predictions-401.spec.ts` | No session → 401 |
| `slice-004-me-final-predictions-403.spec.ts` | Sign in; admin removes domain; GET → 403 |
| `slice-004-me-final-predictions-rls.sql` (pgTAP) | Participant A submits picks. Participant B's JWT executes SELECT; B sees zero rows |

## Endpoint — `GET /api/teams`

Thin RLS-gated wrapper over Slice 002's `teams` table.

### Request

```
GET /api/teams
Authorization: Bearer <session>
```

### Response — 200 OK

```jsonc
{
  "teams": [
    { "id": "uuid", "name": "Argentina", "short_code": "ARG", "flag_url": "..." }
  ]
}
```

Returns all teams visible under RLS (eligible callers see all; Slice 002's `teams_eligible_read` policy applies). No pagination — the team set is bounded to ~32 for the tournament.

### Errors: 401 / 403 / 500 per the standard error shape.

### Test surface

Two minimal Playwright tests (`slice-004-teams-200`, `slice-004-teams-401`); the underlying RLS is already tested by Slice 002.

## Endpoint — `GET /api/players`

RLS-gated player roster with filter + search support.

### Request

```
GET /api/players[?team_id=<uuid>&q=<substring>&limit=<int>]
Authorization: Bearer <session>
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `team_id` | uuid | (all) | Filter by team |
| `q` | string | (none) | Substring match on `full_name` + `aliases` (case-insensitive) |
| `limit` | int | `50` | Clamped to `[1, 500]`. Players typeahead returns top-N matches |

### Response — 200 OK

```jsonc
{
  "players": [
    {
      "id": "uuid",
      "full_name": "Lionel Messi",
      "team_id": "uuid-ARG",
      "team_short_code": "ARG"     // joined for display
    }
  ],
  "total_matching": 12               // total before limit, for typeahead "and N more"
}
```

Only active players (`removed_at IS NULL`). Sorted by `full_name` ASC for determinism.

### Errors: 400 (bad params) / 401 / 403 / 500.

### Server behavior

1. Standard auth + `requireEligible`.
2. Validate query params (uuid for `team_id`; `limit` in `[1, 500]`).
3. SQL (RLS-bound):
   ```sql
   SELECT p.id, p.full_name, p.team_id, t.short_code AS team_short_code,
          COUNT(*) OVER () AS total_matching
   FROM   public.players p
   LEFT   JOIN public.teams t ON t.id = p.team_id
   WHERE  p.removed_at IS NULL
     AND  ($1::uuid IS NULL OR p.team_id = $1)
     AND  ($2::text IS NULL OR (p.full_name ILIKE '%' || $2 || '%' OR EXISTS (
       SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || $2 || '%')))
   ORDER  BY p.full_name ASC
   LIMIT  $3;
   ```
4. Return 200.

`Cache-Control: private, max-age=60` — the roster is largely static during the tournament; brief client cache reduces typeahead chatter.

### Test surface

| File | Test |
|---|---|
| `slice-004-players-list.spec.ts` | GET → 200 with active players only |
| `slice-004-players-team-filter.spec.ts` | `?team_id=<ARG>` → only Argentinian players |
| `slice-004-players-q-search.spec.ts` | `?q=mes` → matches Messi (full_name substring) and Mesut (alias substring) |
| `slice-004-players-excludes-removed.spec.ts` | Pre-state: one player with `removed_at IS NOT NULL`; GET → that player NOT in response |
| `slice-004-players-401.spec.ts` | No session → 401 |
| `slice-004-players-bad-limit.spec.ts` | `?limit=999999` → 400 (clamp-then-reject; pick 400 for explicit feedback) |

## Cross-slice contract summary

| Surface | Locked? |
|---|---|
| `GET /api/me/final-predictions` request/response | **Locked** — Slice 004's UI + future mobile clients |
| Response `lock_state` field | **Locked** union `'editable' \| 'locked'` |
| Response `first_kickoff_utc` field | **Locked** — added so UI countdowns can be rendered without a separate config endpoint |
| `GET /api/teams` response shape | **Stable** — additive extension over Slice 002's teams table |
| `GET /api/players` response shape | **Locked** — `total_matching` field is part of the contract; renames/removals are breaking |
| `Cache-Control` headers per endpoint | **Locked** per route — predictions never cached; players brief client cache OK; teams brief client cache OK |
