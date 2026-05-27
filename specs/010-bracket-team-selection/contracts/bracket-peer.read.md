# Contract: Read another participant's bracket (post-lock only)

**Surface**: `GET /api/bracket-peer/[participant_id]` → reads `bracket_peer_v`
**Auth**: eligible signed-in participant.

## Behaviour

Returns another participant's bracket **only after** the lock condition (`now() >= first_kickoff_utc`) is met AND the product permits public viewing (FR-019). Before lock, returns the empty/denied shape and leaks nothing about the target (existence, owner, contents) — FR-017, FR-018, SC-005.

The gate lives in `bracket_peer_v` (SECURITY DEFINER + lock predicate + self-exclusion in the view body, per R-002), NOT in the route handler alone. The route is a thin pass-through; a direct `/rest/v1/bracket_peer_v?participant_id=eq.<id>` call hits the same gate.

## Response 200 (post-lock)

```jsonc
{
  "participant": { "id": "uuid", "display_name": "…|Participant 1a2b3c4d" },
  "matchups": [ /* same shape as bracket.read, read-only */ ],
  "status": { "submission_status": "submitted|locked", /* … */ }
}
```

## Response 200 (pre-lock) — non-leaking empty

```jsonc
{ "bracket": null }
```

Identical body whether the target exists, has no bracket, or is being hidden — the caller cannot distinguish (mirrors slice-005 peer-pick "empty array" non-leak).

## Rules

- Pre-lock: the view returns zero rows for ANY target (including a real one) → route returns `{ "bracket": null }` with 200. No 404-vs-200 oracle that reveals existence.
- Self target: served by `bracket.read` (`bracket_v`), excluded here.
- `Cache-Control: no-store`.

## Test surface (RED-first, mirrors slice-005 SC-009)

- Pre-lock, alpha GETs bravo's bracket → 200 `{ bracket: null }`.
- Pre-lock, alpha calls `/rest/v1/bracket_peer_v?participant_id=eq.<bravo>` DIRECTLY with their JWT → `[]` (RLS/view gate, not the route).
- Post-lock (first_kickoff_utc in the past), alpha GETs bravo's bracket → 200 with bravo's read-only picks.
- Admin pre-lock direct REST → still `[]` (no admin bypass documented on the peer view; admin reads go through a separate surface if needed — same posture as slice-005 D-T023-1).
