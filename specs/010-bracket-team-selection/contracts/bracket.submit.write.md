# Contract: Submit the completed bracket

**Surface**: `POST /api/bracket/submit` → `submit_bracket()` RPC (SECURITY DEFINER)
**Auth**: eligible signed-in participant. 401 / 403 as usual.

## Request

```jsonc
{ "run_token": "uuid" }   // idempotency token; a repeat with the same token is a no-op success
```

## Behaviour (single transaction, server-side — FR-012, FR-013, Principle V)

1. Resolve caller → participant; reject if not eligible.
2. Read `first_kickoff_utc`; if `now() >= first_kickoff_utc` → `BRACKET_LOCKED`.
3. Recompute completeness from `bracket_matchups` + the caller's `bracket_picks`: all 31 required matchups have a valid winner consistent with the resolved tree. If not → `BRACKET_INCOMPLETE` with the missing count.
4. Upsert `bracket_submissions` → `submitted`, set `submitted_at = now()`, bump `version`.
5. Insert one `audit_log` row (`action='bracket.submitted'`, `entity_type='bracket'`, `entity_id=<participant_id>`) in the SAME transaction.
6. Return the new status.

## Response 200

```jsonc
{
  "submission_status": "submitted",
  "submitted_at": "2026-06-11T19:59:00Z",
  "version": 1,
  "status": { /* bracket.read status shape, now is_complete=true, submission_status=submitted */ }
}
```

## Error responses

| Code | HTTP | When |
|------|------|------|
| `BRACKET_INCOMPLETE` | 422 | fewer than 31 valid picks at submit time (revalidated server-side; defeats stale client state). Body includes `missing_count`. |
| `BRACKET_LOCKED` | 409 | `now() >= first_kickoff_utc`. |
| `UNAUTHENTICATED` | 401 | no session. |
| `DOMAIN_NOT_APPROVED` | 403 | not an eligible participant. |

## Rules

- The completeness check is server-authoritative; a client `isComplete=true` is never trusted (Principle II/III).
- Idempotent on `run_token` (mirror slice-005 scoring run_id idempotency): a duplicate submit returns the same result without a second audit row.
- Audit row is in-transaction with the state write (Principle V) — either both land or neither.

## Test surface (RED-first)

- 31/31 picks, before lock → 200 `submitted`; exactly one `bracket.submitted` audit row.
- 30/31 picks → 422 `BRACKET_INCOMPLETE`, `missing_count=1`, no submission row, no audit row.
- Client marks complete but a pick was cleared server-side → 422 (stale-state defense).
- Submit after lock → 409 `BRACKET_LOCKED`.
- Same `run_token` twice → one audit row, identical response.
