# Contract: Peer Pick Read

**Feature**: 005-scoring-leaderboard
**Direction**: Server → Client (read)
**Anchor**: spec FR-016 (both halves); Constitution Principle III; supports SC-009

This contract covers **two surfaces** that both implement FR-016:

1. **Match-pick peer visibility** (the original surface; `peer_pick_v` view, `/api/peer-pick/[match_id]` route).
2. **Final-tournament-pick peer visibility** (added during `/speckit-analyze` finding I1; `peer_final_pick_v` view, `/api/peer-final-pick/[participant_id]` route).

Both surfaces share the same enforcement pattern: a server-side view applies the lock predicate; the route handler is a thin pass-through; the gate is in SQL, not in app code (Constitution Principle III).

## Surface 1: Match-pick peer visibility

### Capability

Return the picks made by other eligible participants for a specific match — but ONLY after that match's prediction lock has passed per trusted server time (BR-LOCK-002 / BR-LOCK-003). Before lock, the response is empty regardless of the requester's identity. The gate is enforced in the database via RLS on `peer_pick_v`; it CANNOT be bypassed by calling Supabase REST directly.

Self-reads of one's own pick go through Slice 003's existing `predictions` RLS policy and are not subject to the lock gate (a participant can always see their own pick).

## Access

| Surface | Path / mechanism | Notes |
|---|---|---|
| Web UI | `GET /api/peer-pick/[match_id]` (Next.js route handler) | route handler invokes the view using the participant's JWT |
| Supabase REST | `GET /rest/v1/peer_pick_v?match_id=eq.<uuid>&select=*` | direct read; RLS-gated by lock state |

Authentication required.

## Server-side gate (definitional)

```sql
-- in peer_pick_v RLS predicate
USING (
  is_eligible_nortal_participant(auth.uid())
  AND now() >= matches.kickoff_utc
              - (config_value('lock_window_minutes')::int || ' minutes')::interval
)
```

`config_value('lock_window_minutes')` reads from `tournament_config`; default is 60 (BR-LOCK-002).

## Request

| Param | Type | Notes |
|---|---|---|
| `match_id` | UUID | required |

## Response (one row per other eligible participant who submitted a prediction for the match)

| Field | Type | Notes |
|---|---|---|
| `match_id` | UUID | |
| `participant_id` | UUID | the picker; never the caller |
| `display_name` | string | subject to `leaderboard_visibility` config |
| `predicted_home` | int \| null | null when the peer had no valid prediction (or admin-invalidated) |
| `predicted_away` | int \| null | same |
| `submitted_at` | timestamptz \| null | null when no valid prediction |

The "peer pick was admin-invalidated" edge case is satisfied by returning `predicted_home / predicted_away / submitted_at = null` (same shape as "never predicted"), so non-admin peers cannot see that an override occurred.

## Error responses

| Cause | HTTP | Detail |
|---|---|---|
| Unauthenticated | 401 | |
| Non-Nortal domain | 403 | RLS denies |
| Lock has not passed | 200 + empty body | this is the correct deny-by-RLS behavior; the route handler returns `{ "picks": [] }` so the client cannot distinguish "no picks" from "still locked" except by reading the lock state separately |
| Final-tournament picks requested before first kickoff | 200 + empty body | enforced by the same RLS pattern against `tournament_config.first_kickoff_utc` |

All denied attempts MUST be audited (SC-009). The audit row is written by a Postgres trigger on the underlying `predictions` access path; the route handler does NOT need to audit separately because the database is the gate.

## Lock-boundary behavior

| Server time (relative to kickoff) | Behavior |
|---|---|
| kickoff − 60:00:01 (1 s before lock) | empty (locked = false; condition `now() >= kickoff − lock_window` is false) |
| kickoff − 60:00 exactly | non-empty (locked = true; BR-LOCK-003 strict-equality boundary). Slice 003 treats prediction *writes* as forbidden at this boundary, which means peer *reads* are permitted — these are dual sides of the same boundary rule. |
| kickoff − 30:00 | non-empty |
| kickoff + 60:00 | non-empty |

This matches the spec's edge case explicitly.

## Surface 2: Final-tournament-pick peer visibility

### Capability

Return one eligible peer participant's full set of four final-tournament picks (champion, runner-up, top scorer, best player) — but ONLY after the first match of the tournament has kicked off per trusted server time (FR-016 final-tournament half, BR-LOCK-005). Before first kickoff, the response is empty regardless of the requester's identity. The gate is enforced in the database via the lock predicate inside `peer_final_pick_v`.

Self-reads of one's own final-pick set go through Slice 004's existing `final_predictions` RLS policy and are not subject to the lock gate.

### Access

| Surface | Path / mechanism | Notes |
|---|---|---|
| Web UI | `GET /api/peer-final-pick/[participant_id]` (Next.js route handler) | thin wrapper over `peer_final_pick_v` using the participant's JWT |
| Supabase REST | `GET /rest/v1/peer_final_pick_v?participant_id=eq.<uuid>&select=*` | RLS-gated by first-kickoff timestamp |

### Server-side gate (definitional)

```sql
-- in peer_final_pick_v WHERE predicate
WHERE is_eligible_nortal_participant(auth.uid())
  AND participant_id <> auth.uid()       -- self-exclusion; self-reads go to Slice 004's surface
  AND now() >= (SELECT (value #>> '{}')::timestamptz
                FROM tournament_config
                WHERE key = 'first_kickoff_utc')
```

### Request

| Param | Type | Notes |
|---|---|---|
| `participant_id` | UUID | required — the peer whose final picks are being requested |

### Response (zero or one row)

| Field | Type | Notes |
|---|---|---|
| `participant_id` | UUID | the peer |
| `display_name` | string | masked per `leaderboard_visibility` |
| `champion_team_id` | UUID \| null | null when admin-invalidated; never null otherwise once first kickoff has passed |
| `runner_up_team_id` | UUID \| null | same |
| `top_scorer_player_id` | UUID \| null | same |
| `best_player_player_id` | UUID \| null | same |
| `submitted_at` | timestamptz \| null | null when admin-invalidated |

Route handler returns `{ "pick": <row> }` when a row exists, `{ "pick": null }` when RLS filters it out (pre-first-kickoff, or caller asked about themselves, or peer never submitted finals).

### Error responses

| Cause | HTTP | Detail |
|---|---|---|
| Unauthenticated | 401 | |
| Non-Nortal domain | 403 | RLS denies |
| First kickoff has not yet occurred | 200 + `{ "pick": null }` | indistinguishable from "peer never submitted" per the contract; clients query lock state separately to disambiguate |
| Caller asked about themselves | 200 + `{ "pick": null }` | self-exclusion in view; caller's own picks belong on `/me/breakdown` |
| Peer admin-invalidated their final set | 200 + row with all FK columns null | no leak of admin override to non-admin peers |

### First-kickoff-boundary behavior

| Server time (relative to `first_kickoff_utc`) | Behavior |
|---|---|
| first_kickoff − 1 s | `{ "pick": null }` (locked = false; condition `now() >= first_kickoff_utc` is false) |
| first_kickoff exact | populated row (locked = true; same strict-equality boundary as BR-LOCK-003) |
| first_kickoff + 1 h | populated row |

## Test surface (both surfaces)

| Test | Lives in | Validates |
|---|---|---|
| Playwright `slice-005-peer-pick-visibility.spec.ts` — *Match: pre-lock empty* | `apps/web/tests/playwright/` | spec edge case + FR-016 match variant (UI route) |
| Playwright — *Match: boundary exact* | same | lock-boundary edge case |
| Playwright — *Match: post-lock visible* | same | FR-016 match-variant happy path |
| Playwright — *Match: direct API attempt before lock* | same | SC-009 (API route hit directly while logged in) |
| Playwright — *Match: admin-invalidated pick masked* | same | non-admin peer sees null fields, no leak of admin override |
| Playwright — *Final: before first kickoff* | same | FR-016 final-tournament variant — pre-lock empty |
| Playwright — *Final: at first-kickoff boundary* | same | strict-equality boundary, mirror of BR-LOCK-003 |
| Playwright — *Final: after first kickoff* | same | FR-016 final-variant happy path |
| Playwright — *Final: caller asks about self* | same | self-exclusion via view |
| pgTAP `peer_pick_rls_lock_boundary.sql` | `supabase/tests/pgtap/` | RLS predicate at each of the boundary cases above, both views |
| pgTAP — *Admin-invalidated pick masked (match + final)* | same | mask pattern consistent across both views |
| pgTAP — *Unauthorized direct REST call* | same | SC-009: zero rows returned regardless of auth context manipulation, both views |
