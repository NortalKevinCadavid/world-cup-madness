# Contract: Submit a single winner pick

**Surface**: `POST /api/bracket/pick`
**Auth**: eligible signed-in participant. 401 / 403 as usual.

## Request

```jsonc
{ "matchup_id": "uuid", "winner_team_id": "uuid" }
```

## Behaviour

Upserts the caller's pick for one matchup, then re-derives and persists the downstream cascade (R-005): any of the caller's later picks whose chosen team can no longer reach its matchup are deleted. Returns the updated status + the set of cleared matchup ids so the client can reconcile.

## Response 200

```jsonc
{
  "pick": { "matchup_id": "uuid", "winner_team_id": "uuid" },
  "cleared_matchup_ids": ["uuid", "…"],   // downstream picks invalidated by this change
  "status": { /* same shape as bracket.read */ }
}
```

## Error responses

| Code | HTTP | When |
|------|------|------|
| `BRACKET_LOCKED` | 409 | `now() >= first_kickoff_utc`, or the bracket is already submitted-and-locked (FR-008). Edits refused. |
| `MATCHUP_NOT_READY` | 409 | the matchup's competitors are not yet resolved by the caller's upstream picks (FR-007). |
| `INVALID_WINNER` | 422 | `winner_team_id` is not one of the matchup's two resolved competitors (FR-004). |
| `MATCHUP_NOT_FOUND` | 404 | unknown `matchup_id`. |
| `BAD_REQUEST` | 400 | malformed body. |

## Rules

- Lock is checked server-side from DB time (Principle VI) — a client clock cannot bypass it (mirror slice-003 `submit-client-clock-ignored`).
- The cascade is authoritative server-side; the client's optimistic cascade is for UX only.
- `Cache-Control: no-store`.

## Test surface (RED-first)

- Pick a valid R32 winner → 200, team appears in the dependent R16 matchup on the next read.
- Change an R32 winner that an existing QF/champion pick depended on → 200 with non-empty `cleared_matchup_ids`; `status.completed` drops.
- Pick on a pending later matchup → 409 `MATCHUP_NOT_READY`.
- Pick a team that isn't a competitor → 422 `INVALID_WINNER`.
- Pick after lock → 409 `BRACKET_LOCKED` (even with a back-dated client clock).
