# Contract: Read own bracket + status

**Surface**: `GET /api/bracket`
**Auth**: eligible signed-in participant (slice-001 `requireEligible`). 401 if no session, 403 if not eligible.

## Behaviour

Returns the caller's bracket: the full matchup tree with the caller's picks resolved into later rounds, plus the single `bracket_status` shape. Reads through `bracket_v` under the caller's JWT (self-RLS). Never returns another participant's data.

## Response 200

```jsonc
{
  "matchups": [
    {
      "id": "uuid",
      "round": "r32|r16|qf|sf|final",
      "position": 1,
      "team_a": { "id": "uuid", "name": "Brazil", "flag_url": "…|null", "seed": 1 } , // null when not yet resolved
      "team_b": { "id": "uuid", "name": "…", "flag_url": "…|null" } ,                 // null when pending
      "winner_team_id": "uuid|null",
      "next_matchup_id": "uuid|null",
      "next_slot": "A|B|null"
    }
    // … 31 matchups, round order r32→final
  ],
  "status": {
    "total_required": 31,
    "completed": 12,
    "is_complete": false,
    "missing_matchup_ids": ["uuid", "…"],
    "submission_status": "draft|complete|submitted|locked"
  }
}
```

## Rules

- A later-round matchup's `team_a`/`team_b` is non-null only when the feeding upstream winner is picked (FR-007 pending).
- `status` is the server-authoritative source (FR-014). The client may recompute for in-progress display but MUST treat this as truth on load.
- `Cache-Control: no-store` (status flips at the lock boundary).
- Loading/empty/error envelopes per FR-021/FR-022.

## Test surface (RED-first)

- Eligible caller with partial picks → 200, `completed` matches picks, later rounds resolved correctly.
- Unauthenticated → 401. Ineligible (domain removed mid-session) → 403.
- `submission_status` flips to `locked` once `first_kickoff_utc` passes (server time).
