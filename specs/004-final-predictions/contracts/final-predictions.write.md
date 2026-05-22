# Contract: Final Predictions write path

**Slice**: 004-final-predictions
**Date**: 2026-05-16
**Status**: Phase 1 (Plan).

How participant final predictions are created and updated. Two layers (mirror Slice 003 pattern):

1. **`POST /api/final-predictions`** — Next.js route handler. Single client-accessible write surface.
2. **`public.submit_final_prediction(uuid, text, uuid, uuid, text) RETURNS uuid`** — SECURITY DEFINER SP. Locked cross-slice signature.

## Endpoint — `POST /api/final-predictions`

### Request

```
POST /api/final-predictions
Authorization: Bearer <supabase-session-jwt>   (or cookies)
Content-Type: application/json

{
  "item_kind": "champion" | "runner_up" | "top_scorer" | "best_player",
  "target_team_id": "uuid",       // required for champion/runner_up; null/absent otherwise
  "target_player_id": "uuid"      // required for top_scorer/best_player; null/absent otherwise
}
```

| Field | Type | Constraints |
|---|---|---|
| `item_kind` | enum | Required. One of the four values. |
| `target_team_id` | uuid \| null | Required iff `item_kind IN ('champion','runner_up')`. |
| `target_player_id` | uuid \| null | Required iff `item_kind IN ('top_scorer','best_player')`. |

### Response shapes

#### 200 OK — submission accepted

```jsonc
{
  "final_prediction": {
    "id": "uuid",
    "item_kind": "champion",
    "target_team_id": "uuid",
    "target_player_id": null,
    "submitted_at": "2026-06-12T15:00:00Z",
    "source": "ui",
    "superseded_at": null
  }
}
```

#### 400 Bad Request — malformed body or kind/target mismatch

```jsonc
{ "error": { "code": "BAD_REQUEST", "message": "champion picks require target_team_id" } }
```

#### 401 Unauthorized — no session

```jsonc
{ "error": { "code": "UNAUTHENTICATED", "message": "Sign in to continue." } }
```

#### 403 Forbidden — caller no longer eligible

```jsonc
{ "error": { "code": "DOMAIN_NOT_APPROVED", "message": "..." } }
```

#### 404 Not Found — target team or player does not exist (or player is removed)

```jsonc
{
  "error": {
    "code": "INVALID_TARGET",
    "message": "Top scorer pick must reference an active tournament player.",
    "reason": "player_not_found"     // or "team_not_found" or "player_removed"
  }
}
```

#### 409 Conflict — locked OR identical champion/runner-up

```jsonc
{
  "error": {
    "code": "FINAL_PREDICTIONS_LOCKED",
    "message": "Final tournament predictions closed at <first_kickoff_utc>.",
    "reason": "lock_window_passed"
  }
}
```

Or:

```jsonc
{
  "error": {
    "code": "IDENTICAL_CHAMPION_RUNNER_UP",
    "message": "Champion and runner-up cannot be the same team.",
    "reason": "identical_champion_runner_up"
  }
}
```

#### 422 Unprocessable Entity — input shape valid but semantically invalid (very rare; mostly caught by 400)

#### 500 Internal Server Error — genuine infrastructure failure

### Server behavior

1. Parse session cookie → 401 if missing.
2. Parse + validate body with a Zod schema enforcing kind/target consistency. Failure → 400 BEFORE eligibility check.
3. `await requireEligible(client)` → 403 on denial.
4. Confirm target exists + is active:
   - Team kinds: `SELECT 1 FROM teams WHERE id = body.target_team_id`. Zero rows → 404 with `reason='team_not_found'`.
   - Player kinds: `SELECT 1 FROM players WHERE id = body.target_player_id AND removed_at IS NULL`. Zero rows → 404 (distinguish `player_not_found` vs `player_removed` by a second query if needed).
5. Invoke `client.rpc('submit_final_prediction', {p_participant_id: <caller's participants.id>, p_item_kind, p_target_team_id, p_target_player_id, p_source: 'ui'})`.
6. Map SP exceptions to HTTP:
   - `ERRCODE='WFP01'` (lock_window_passed) → 409 with reason `lock_window_passed`.
   - `ERRCODE='WFP03'` (invalid_input — bad enum / wrong target combination) → 400.
   - `ERRCODE='WFP04'` (invalid_target) → 404.
   - `ERRCODE='WFP05'` (ineligible — defense-in-depth) → 403.
   - `ERRCODE='WFP06'` (identical_champion_runner_up) → 409 with reason `identical_champion_runner_up`.
   - Any other → 500.
7. On success: fetch the newly-inserted row by id; return 200.

`Cache-Control: no-store` on every response.

### Security invariants

- Handler **never** uses the service-role key.
- The SP's `p_participant_id` is set from server-side context (`requireEligible`'s return); body params NEVER override it.
- The 404 body distinguishes `team_not_found` vs `player_not_found` vs `player_removed` so participants get actionable feedback without leaking other participants' state.

## Stored procedure — `public.submit_final_prediction(...)` (locked cross-slice)

### Signature

```sql
CREATE OR REPLACE FUNCTION public.submit_final_prediction(
  p_participant_id   uuid,
  p_item_kind        text,                    -- 'champion' | 'runner_up' | 'top_scorer' | 'best_player'
  p_target_team_id   uuid,                    -- non-NULL iff p_item_kind in ('champion','runner_up')
  p_target_player_id uuid,                    -- non-NULL iff p_item_kind in ('top_scorer','best_player')
  p_source           text                     -- 'ui' | 'api' | 'admin_override'
) RETURNS uuid                                -- the newly-inserted final_predictions.id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

The signature is **locked**. Adding optional parameters with `DEFAULT` is non-breaking; renaming, reordering, or changing types is breaking.

### Semantics

In order, within a single transaction:

1. `PERFORM pg_advisory_xact_lock(hashtext(p_participant_id::text || ':' || p_item_kind));` — concurrency serialization per (participant, item_kind). Different items in parallel.
2. Validate enum values + kind/target shape. Else write audit row `final_prediction.rejected_invalid_input`, `RAISE ... ERRCODE='WFP03'`.
3. Validate target existence (teams or players, players must have `removed_at IS NULL`). Else `final_prediction.rejected_invalid_target`, `RAISE ERRCODE='WFP04'`.
4. Defense-in-depth eligibility check. Else `RAISE ERRCODE='WFP05'`.
5. **Lock check**: `IF public.is_final_prediction_locked() THEN write audit + RAISE ERRCODE='WFP01';`
6. **Disjoint check** (FR-007): if `p_item_kind='runner_up'`, lookup active champion for this participant. If the same team AND `tournament_config.predictions.allow_identical_champion_runner_up = false`, write audit + `RAISE ERRCODE='WFP06'`. Symmetric on champion submission.
7. SELECT existing active row `FOR UPDATE` for `(p_participant_id, p_item_kind)`.
8. INSERT new row. Capture `v_new_id`.
9. IF v_existing IS NOT NULL: UPDATE old `SET superseded_at = now(), superseded_by = v_new_id`.
10. RETURN `v_new_id`. The trigger emits `final_prediction.created` + `final_prediction.superseded` rows.

### Admin path note

`p_source = 'admin_override'` MUST be called from a wrapper that pre-checks `is_admin(auth.uid())`. Slice 006's wrapping RPC:

```sql
-- Slice 006 preview
CREATE FUNCTION public.admin_submit_final_prediction(...) RETURNS uuid AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN public.submit_final_prediction(...);
END $$ SECURITY DEFINER;
```

The SP itself does NOT verify `is_admin` directly — separation of concerns.

### Test surface

pgTAP files:

| File | Test |
|---|---|
| `submit_final_prediction_create_champion_happy.sql` | First-time champion pick. Assert new row + audit |
| `submit_final_prediction_create_top_scorer_happy.sql` | First-time top_scorer pick |
| `submit_final_prediction_update_supersedes.sql` | Second champion submission supersedes the first; chain via `superseded_by` |
| `submit_final_prediction_locked.sql` | At `now() >= first_kickoff_utc`, SP raises ERRCODE='WFP01'; no row created; audit row written |
| `submit_final_prediction_invalid_kind.sql` | `p_item_kind='nonsense'` → ERRCODE='WFP03' |
| `submit_final_prediction_invalid_target_shape.sql` | `p_item_kind='champion'` with `p_target_player_id` set → ERRCODE='WFP03' |
| `submit_final_prediction_invalid_target_missing.sql` | `p_target_team_id` references a non-existent team → ERRCODE='WFP04' |
| `submit_final_prediction_invalid_target_removed_player.sql` | `p_target_player_id` references a player with `removed_at IS NOT NULL` → ERRCODE='WFP04' |
| `submit_final_prediction_identical_champion_runner_up.sql` | Existing champion = team_X; submit team_X as runner_up → ERRCODE='WFP06'; config flag flip allows it |
| `submit_final_prediction_serializes_concurrent.sql` | 1,000 concurrent SP calls for same (participant, item); exactly one active row, 999-row supersede chain (SC-004) |
| `submit_final_prediction_audit_format.sql` | Audit row content matches spec FR-011 fields |
| `submit_final_prediction_admin_override.sql` | `p_source='admin_override'` records `created_by` differently from `participant_id` |

Playwright (HTTP-level):

| File | Test |
|---|---|
| `slice-004-submit-champion-happy.spec.ts` | Submit champion; 200 + body |
| `slice-004-submit-top-scorer-happy.spec.ts` | Submit top_scorer |
| `slice-004-submit-all-four.spec.ts` | Submit champion → runner_up → top_scorer → best_player → 4 active rows |
| `slice-004-submit-update-supersedes.spec.ts` | Submit champion = A; submit champion = B → exactly 1 active row, B |
| `slice-004-submit-locked.spec.ts` | Set first_kickoff_utc to now(); submit → 409 with `reason='lock_window_passed'` |
| `slice-004-submit-locked-just-after.spec.ts` | first_kickoff_utc = now() - 1 second; submit → 409 |
| `slice-004-submit-just-before-lock.spec.ts` | first_kickoff_utc = now() + 1 second; submit → 200 (SC-001) |
| `slice-004-submit-invalid-team.spec.ts` | `target_team_id = gen_random_uuid()` → 404 with `team_not_found` |
| `slice-004-submit-invalid-player.spec.ts` | `target_player_id = gen_random_uuid()` → 404 with `player_not_found` |
| `slice-004-submit-removed-player.spec.ts` | Player exists with `removed_at IS NOT NULL`; submit → 404 with `player_removed` |
| `slice-004-submit-identical-champ-runner.spec.ts` | Submit champion = A; submit runner_up = A → 409 with `identical_champion_runner_up`. Toggle config; same submission → 200 |
| `slice-004-submit-unauthenticated.spec.ts` | No session → 401 |
| `slice-004-submit-domain-removed.spec.ts` | Sign in; admin removes domain; submit → 403 |
| `slice-004-submit-concurrent-tabs.spec.ts` | Two tabs submit same item concurrently; exactly one active row (SC-004) |
| `slice-004-submit-bad-body.spec.ts` | Missing item_kind → 400; wrong kind/target combination → 400 |

All authored RED-first per Constitution Principle IX.

## Cross-slice contract summary

| Surface | Locked? |
|---|---|
| `submit_final_prediction(uuid, text, uuid, uuid, text) RETURNS uuid` signature | **Locked** — Slice 006 admin wrapper will call |
| ERRCODE values `WFP01`–`WFP06` | **Locked** — route handler maps to HTTP; Slice 006 admin path reuses |
| `audit_log` action labels `final_prediction.created`, `final_prediction.superseded`, `final_prediction.rejected_*` | **Locked** — Slice 007 audit hardening preserves |
| `POST /api/final-predictions` request/response body | **Locked** — Slice 004's own UI consumes; future mobile + admin tooling may |
| `Cache-Control: no-store` on all responses | **Locked** — mutable participant state |
