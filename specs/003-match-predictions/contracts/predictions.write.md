# Contract: Predictions write path

**Slice**: 003-match-predictions
**Date**: 2026-05-16
**Status**: Phase 1 (Plan).

How participant predictions are created and updated. Two layers:

1. **`POST /api/predictions`** — the participant-facing Next.js route handler. The only client-accessible write surface.
2. **`public.submit_prediction(uuid, uuid, int, int, text) RETURNS uuid`** — the SECURITY DEFINER SP that the route handler invokes. Also callable by Slice 006's admin manual-entry RPC with `p_source='admin_override'`. **Locked cross-slice signature**.

Both layers enforce the same invariants. The route handler returns user-friendly HTTP responses; the SP enforces correctness at the data boundary (Constitution Principle II + III).

## Endpoint — `POST /api/predictions`

### Request

```
POST /api/predictions
Authorization: Bearer <supabase-session-jwt>   (or cookies)
Content-Type: application/json

{ "match_id": "uuid", "home": 0, "away": 0 }
```

| Field | Type | Constraints |
|---|---|---|
| `match_id` | uuid | Required. Must exist in `matches`. |
| `home` | int | Required. Non-negative. ≤ `tournament_config.score_upper_bound` (default 20). |
| `away` | int | Required. Same. |

No PUT or PATCH. Submit-and-update flow through the same POST: the SP detects an existing active row and supersedes it. The participant client doesn't need to know the prediction ID.

### Response shapes

#### 200 OK — submission accepted (create OR update)

```jsonc
{
  "prediction": {
    "id": "uuid",
    "match_id": "uuid",
    "predicted_home": 2,
    "predicted_away": 1,
    "submitted_at": "2026-06-12T18:00:00Z",
    "source": "ui",
    "superseded_at": null
  }
}
```

#### 400 Bad Request — malformed body or scores out of range (route-handler validation)

```jsonc
{ "error": { "code": "BAD_REQUEST", "message": "home and away must be non-negative integers in [0, 20]" } }
```

#### 401 Unauthorized — no session

```jsonc
{ "error": { "code": "UNAUTHENTICATED", "message": "Sign in to continue." } }
```

#### 403 Forbidden — caller no longer eligible (mid-session domain removal)

```jsonc
{ "error": { "code": "DOMAIN_NOT_APPROVED", "message": "..." } }
```

#### 404 Not Found — match does not exist or is invisible to the caller (RLS)

```jsonc
{ "error": { "code": "MATCH_NOT_FOUND", "message": "Match not found." } }
```

#### 409 Conflict — match is locked

```jsonc
{
  "error": {
    "code": "PREDICTION_LOCKED",
    "message": "Predictions for this match closed at <kickoff − lock_window>.",
    "reason": "lock_window_passed"
  }
}
```

`reason` distinguishes the two BR-LOCK paths:
- `"lock_window_passed"` — BR-LOCK-002 / BR-LOCK-003 (remaining time ≤ lock_window).
- `"match_status_locked"` — BR-LOCK-004 (match status is in_progress / finished / postponed / cancelled). Message becomes "This match has already started — predictions are closed."

#### 422 Unprocessable Entity — score-upper-bound rejection from the SP

```jsonc
{ "error": { "code": "INVALID_SCORE", "message": "Score above configured upper bound." } }
```

#### 500 Internal Server Error — genuine infrastructure failure (Postgres unreachable)

```jsonc
{ "error": { "code": "INTERNAL", "message": "Please try again in a moment." } }
```

Eligibility decisions that *cannot* be made fail closed as 403, never as 500.

### Server behavior

1. Parse Supabase session cookie. Absent → 401.
2. Parse + validate body with a Zod schema (or equivalent): `{match_id: z.string().uuid(), home: z.number().int().min(0).max(<upper_bound>), away: z.number().int().min(0).max(<upper_bound>)}`. Read the upper bound from server-side `tournament_config` lookup on cold-cache; cache for the request. Validation failure → 400 BEFORE the eligibility check (timing-leakage avoidance).
3. `await requireEligible(client)`. On `EligibilityDeniedError` → 403 (Slice 001's `requireEligible` already writes the audit row).
4. Confirm the match exists and is visible: `SELECT 1 FROM matches WHERE id = body.match_id`. Returns zero rows → 404.
5. Invoke `client.rpc('submit_prediction', { p_participant_id: <caller's participants.id>, p_match_id, p_home, p_away, p_source: 'ui' })`. The SP runs as definer; the client passes the JWT-bound participant_id (the route handler resolves this from `requireEligible`'s return value).
6. Map SP exceptions to HTTP responses:
   - `RAISE EXCEPTION USING ERRCODE = 'WCM01'` (lock_window_passed) → 409 with reason `lock_window_passed`.
   - `RAISE EXCEPTION USING ERRCODE = 'WCM02'` (match_status_locked) → 409 with reason `match_status_locked`.
   - `RAISE EXCEPTION USING ERRCODE = 'WCM03'` (invalid_score — for safety even though route already validated) → 422.
   - `RAISE EXCEPTION USING ERRCODE = 'WCM04'` (invalid_match — match disappeared between step 4 and step 5) → 404.
   - `RAISE EXCEPTION USING ERRCODE = 'WCM05'` (ineligible — defense-in-depth) → 403.
   - Any other exception → 500 (log server-side, don't leak details to client).
7. On success: fetch the newly-inserted row by id; return 200 with the body shape above.

`Cache-Control: no-store` on every response (predictions are mutable participant state; client must not cache).

### Security invariants

- The handler **never** uses the service-role key. The user JWT drives every query; the SP's SECURITY DEFINER privilege is what lets it write.
- The handler MUST NOT honor a `participant_id` body param to write predictions on behalf of another participant. The SP's `p_participant_id` is set by the handler to the caller's `participants.id`; any other value triggers the SP's eligibility guard and returns 403.
- 403 / 404 / 409 bodies NEVER reveal participant identities, admin state, or which matches are visible to other participants.

## Stored procedure — `public.submit_prediction(...)` (locked cross-slice)

### Signature

```sql
CREATE OR REPLACE FUNCTION public.submit_prediction(
  p_participant_id uuid,
  p_match_id       uuid,
  p_home           int,
  p_away           int,
  p_source         text                    -- 'ui' | 'api' | 'admin_override'
) RETURNS uuid                              -- newly-inserted predictions.id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

The signature is **locked**. Adding optional parameters (with `DEFAULT`) is non-breaking; renaming, reordering, or changing types is breaking.

### Semantics

In order, within a single transaction:

1. `PERFORM pg_advisory_xact_lock(hashtext(p_participant_id::text || ':' || p_match_id::text));` — concurrency serialization per (participant, match) pair. Other pairs proceed in parallel.
2. Validate `p_source IN ('ui', 'api', 'admin_override')`. Else `RAISE EXCEPTION ... ERRCODE='WCM03'`.
3. Validate `p_home`, `p_away` non-negative and `<= tournament_config.score_upper_bound`. Else write `audit_log` row `prediction.rejected_invalid_score`, `RAISE EXCEPTION ... ERRCODE='WCM03'`.
4. Validate eligibility (defense-in-depth): `IF NOT public.is_eligible_nortal_participant((SELECT auth_user_id FROM public.participants WHERE id = p_participant_id)) THEN write audit + RAISE WCM05; END IF;`
5. Validate match existence: `SELECT 1 FROM matches WHERE id = p_match_id`. Else `RAISE WCM04`.
6. **Lock check**: `IF public.is_prediction_locked(p_match_id) THEN`:
   - Determine reason: if `matches.status <> 'scheduled'` → `'match_status_locked'` → write `prediction.rejected_locked` audit row with that reason → `RAISE WCM02`.
   - Else (lock-window crossed) → `'lock_window_passed'` → write audit row → `RAISE WCM01`.
7. SELECT existing active prediction `FOR UPDATE` (row-level lock for safety):
   ```sql
   SELECT id INTO v_existing FROM predictions
   WHERE participant_id = p_participant_id AND match_id = p_match_id AND superseded_at IS NULL
   FOR UPDATE;
   ```
8. INSERT new prediction row with `superseded_at = NULL`, `source = p_source`, `created_by = p_participant_id` (or for `source='admin_override'`, `created_by` would be the admin's `participants.id` passed differently — see § Admin path note). Capture `v_new_id`.
9. If `v_existing IS NOT NULL`: `UPDATE predictions SET superseded_at = now(), superseded_by = v_new_id WHERE id = v_existing;` Atomic with the INSERT in the same transaction.
10. Return `v_new_id`. The audit trigger on `predictions` emits `prediction.created` (and `prediction.superseded` for the OLD row) automatically.

### Admin path note

When `p_source = 'admin_override'`, the SP MUST be called by a function-caller whose JWT satisfies `is_admin(auth.uid())`. The SP itself does NOT verify `is_admin` directly — that's the wrapping RPC's job. This split lets `submit_prediction` stay a pure data operation; admin authorization is the wrapper's concern. Slice 006 will ship the wrapping RPC with:

```sql
-- Slice 006 preview
CREATE FUNCTION public.admin_submit_prediction(...) RETURNS uuid AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN public.submit_prediction(...);
END $$ SECURITY DEFINER;
```

The `created_by` field in `predictions` rows captures the admin's identity for audit trail when `source='admin_override'`.

### Concurrency guarantee (SC-003)

Under 1,000 concurrent submissions for the same `(participant, match)` pair:
- Advisory lock serializes them.
- Each transaction commits before the next acquires the lock.
- Final state: exactly one row with `superseded_at IS NULL`; chain of 999 superseded rows in order.
- The unique partial index `predictions_active_uk` is the hard backstop: even if the advisory lock somehow failed, Postgres would reject duplicate active rows at the storage layer.

### Test surface

Authored as pgTAP files; all RED-first per Constitution Principle IX:

| File | Test |
|---|---|
| `submit_prediction_create_happy.sql` | Pre-state: no prediction. Call SP with valid args. Assert single new row, `superseded_at IS NULL`, audit row `prediction.created` |
| `submit_prediction_update_supersedes.sql` | Pre-state: one active prediction. Call SP again. Assert OLD row has `superseded_at`, `superseded_by`; NEW row active; two audit rows `prediction.superseded` + `prediction.created` |
| `submit_prediction_locked_window.sql` | Pre-state: match at exactly `kickoff − lock_window`. Call SP. Assert EXCEPTION raised with ERRCODE=WCM01; audit row `prediction.rejected_locked, reason='lock_window_passed'`; no predictions row created |
| `submit_prediction_locked_status_in_progress.sql` | Pre-state: match.status='in_progress'. Call SP. Assert EXCEPTION ERRCODE=WCM02; audit row with reason='match_status_locked'; no predictions row |
| `submit_prediction_invalid_score.sql` | Call SP with `p_home = upper_bound + 1`. Assert EXCEPTION ERRCODE=WCM03; audit row `prediction.rejected_invalid_score`; no predictions row |
| `submit_prediction_invalid_match.sql` | Call SP with `p_match_id = gen_random_uuid()`. Assert EXCEPTION ERRCODE=WCM04; no predictions row |
| `submit_prediction_ineligible.sql` | Set up a participant with `status='deactivated'`. Call SP for them. Assert EXCEPTION ERRCODE=WCM05; no predictions row |
| `submit_prediction_serializes_concurrent.sql` | 1,000 concurrent transactions calling SP for same (participant, match). Assert exactly one active row, 999 superseded rows, full chain via `superseded_by` |
| `submit_prediction_audit_format.sql` | Verify audit_log row content for created/superseded actions matches spec FR-011 fields |
| `submit_prediction_admin_override.sql` | Call SP with `p_source='admin_override'` and `p_participant_id != admin's participant_id`. Assert the new row has `source='admin_override'` and `created_by = admin's participant_id`. (Slice 006 will ship the route handler / RPC; this is the SP-level happy path.) |

Plus Playwright tests covering the route handler (the HTTP-level surface):

| File | Test |
|---|---|
| `slice-003-submit-happy.spec.ts` | Sign in eligible; POST `/api/predictions` for an editable match; assert 200 + body |
| `slice-003-submit-locked.spec.ts` | Sign in eligible; POST for a match at exactly `kickoff − lock_window`; assert 409 with `reason='lock_window_passed'` |
| `slice-003-submit-status-locked.spec.ts` | Match status='in_progress'; POST; assert 409 with `reason='match_status_locked'` |
| `slice-003-submit-invalid-score.spec.ts` | POST with `home: -1` → 400; POST with `home: 21` → 422 |
| `slice-003-submit-unauthenticated.spec.ts` | POST with no cookies → 401 |
| `slice-003-submit-domain-removed.spec.ts` | Sign in eligible; admin removes domain; POST → 403 |
| `slice-003-submit-invalid-match.spec.ts` | POST with `match_id: gen_random_uuid()` → 404 |
| `slice-003-submit-update-supersedes.spec.ts` | Submit 1-0, then submit 2-1 same match; assert two rows in `predictions`, only one active |
| `slice-003-submit-concurrent-tabs.spec.ts` | Two browsers submit simultaneously; assert exactly one active row, the other in superseded chain |

## Cross-slice contract summary

| Surface | Locked? |
|---|---|
| `submit_prediction(uuid, uuid, int, int, text) RETURNS uuid` signature | **Locked** — Slice 006 admin path will call it |
| ERRCODE values `WCM01`–`WCM05` | **Locked** — route handler maps to HTTP codes; Slice 006 admin path may reuse |
| `audit_log` action labels `prediction.rejected_locked`, `prediction.rejected_invalid_score`, etc. | **Locked** — Slice 007 audit hardening preserves the labels |
| `POST /api/predictions` request/response body | **Locked** — Slice 003's own UI consumes it; future mobile clients will |
| `Cache-Control: no-store` on all responses | **Locked** — predictions are mutable, never cacheable |
