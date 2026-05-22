# Phase 1 Data Model: Match Predictions with Locking

**Feature**: 003-match-predictions
**Date**: 2026-05-16
**Status**: Draft (Phase 1 output)
**Vendor-neutral**: Entities described in capability terms (Principle I). Concrete Supabase/Postgres details live in `plan.md` § Source Code and in `contracts/`.

## Cross-slice ownership map

This slice **owns** one new table (`predictions`), one new locked predicate (`is_prediction_locked`), one new SECURITY DEFINER SP (`submit_prediction`), one extension to Slice 002's `tournament_config` seed (the `lock_window_minutes` and `score_upper_bound` keys), and one extension to Slice 002's `/api/matches` response (the `lock_state` field).

| Artifact | Owner slice | This slice's responsibility |
|---|---|---|
| `public.predictions` | **003 (this slice)** | Create, RLS, indexes, audit trigger |
| `public.is_prediction_locked(uuid)` | **003 (this slice)** | Define; locked cross-slice contract |
| `public.submit_prediction(uuid, uuid, int, int, text)` SP | **003 (this slice)** | Define; locked cross-slice contract |
| `audit_log` actions `prediction.*` | **003 (this slice writes)** | Write rows; shape inherited from Slice 001's `audit_log` |
| `tournament_config.lock_window_minutes` (default 60) | **003 (this slice seeds)** | Seed default; Slice 008 admin replaces |
| `tournament_config.score_upper_bound` (default 20) | **003 (this slice seeds)** | Seed default; Slice 008 admin replaces |
| `participants` | 001 | Read-only consumer (FK target, RLS predicate) |
| `is_eligible_nortal_participant(uuid)` | 001 | Read-only consumer (defense-in-depth in SP) |
| `is_admin(uuid)` | 001 stub / 006 real | Read-only consumer (admin RLS) |
| `audit_log` | 007 (Slice 001 stubs) | Write target |
| `matches` | 002 | Read-only consumer (lock check; FK target) |
| `matches.kickoff_utc`, `matches.status` | 002 | Lock-decision inputs |
| `tournament_config` table shape | 008 (Slice 001 stubs) | Seed slice-specific keys |

After this slice ships, the `predictions` table shape, the two function signatures, and the audit action labels are **locked cross-slice contracts** (Constitution Principle XI). Body changes require coordinated updates across consumers (Slices 005, 006, 007).

## Entities introduced by this slice

### 1. Prediction

**Purpose**. A single submission of a score prediction for a (participant, match) pair. Append-only: each submit/edit INSERTs a new row and chains the previous active row via `superseded_at` + `superseded_by`. The active row for a (participant, match) is the one with `superseded_at IS NULL`.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | Stable identifier; referenced by `superseded_by` and by Slice 005's score_records |
| `participant_id` | UUID | NOT NULL, FK → `participants(id)` ON DELETE RESTRICT | |
| `match_id` | UUID | NOT NULL, FK → `matches(id)` ON DELETE RESTRICT | |
| `predicted_home` | int | NOT NULL, CHECK ≥ 0 | Score upper bound enforced by SP, not table (config-driven per R-006) |
| `predicted_away` | int | NOT NULL, CHECK ≥ 0 | Same |
| `submitted_at` | timestamptz | NOT NULL, server-default `now()` | Immutable per row |
| `source` | enum (`'ui'`, `'api'`, `'admin_override'`) | NOT NULL | `ui` from participant via Next.js form; `api` from direct POST; `admin_override` reserved for Slice 006 |
| `superseded_at` | timestamptz | NULL when row is active | Set to `now()` when superseded by a later submission |
| `superseded_by` | UUID | NULL when active; FK → `predictions(id)` when set | The row that replaced this one |
| `created_by` | UUID | NULL allowed; FK → `participants(id)` | Differs from `participant_id` only when `source='admin_override'`; otherwise equals `participant_id` (set by SP) |
| `created_at` | timestamptz | NOT NULL, server-default `now()` | Trigger immutable |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | Trigger-maintained; updates only on the supersede UPDATE |

**Validation rules**.
- Table-level CHECKs: `predicted_home >= 0`, `predicted_away >= 0`.
- Trigger-enforced: a row with `superseded_at IS NOT NULL` MUST have `superseded_by IS NOT NULL` and vice versa (`CHECK ((superseded_at IS NULL) = (superseded_by IS NULL))`).
- SP-enforced (`submit_prediction`): `predicted_home <= tournament_config.score_upper_bound` AND `predicted_away <= tournament_config.score_upper_bound`.
- SP-enforced: `source` is in the allowed enum; `created_by` matches `participant_id` unless `source='admin_override'`.
- SP-enforced: `is_prediction_locked(match_id) = false` at the moment of INSERT.

**State transitions**.
- **Active → Superseded**: UPDATE sets `superseded_at = now()`, `superseded_by = <new prediction id>`. Terminal — once superseded, the row never returns to active.
- No DELETE path (append-only by convention; FK to `participants` is ON DELETE RESTRICT so deleting a participant's auth account doesn't drop predictions).

**Relationships**.
- N:1 → `participants` (via `participant_id`).
- N:1 → `matches` (via `match_id`).
- 1:0..1 → `predictions` (self, via `superseded_by`).
- 1:N → `audit_log` (one row per state transition).

**Indexes and access patterns**.

| Index | Columns | Purpose |
|---|---|---|
| `predictions_pkey` | `(id)` PRIMARY KEY | Lookup by id (audit references, score_records joins) |
| `predictions_active_uk` | `(participant_id, match_id) WHERE superseded_at IS NULL` UNIQUE PARTIAL | Enforces exactly one active row per pair (FR-002 / SC-003); also the primary lookup path for "my current prediction for match M" |
| `predictions_match_active_idx` | `(match_id) WHERE superseded_at IS NULL` | Slice 005 score_match scans active predictions per match |
| `predictions_participant_idx` | `(participant_id, submitted_at DESC)` | Personal prediction history feed |
| `predictions_superseded_by_idx` | `(superseded_by)` | Chain walking ("which row replaced which") |

**Audit posture**. `AFTER INSERT OR UPDATE` trigger writes one `audit_log` row per change:

| Trigger event | Action label | Notes |
|---|---|---|
| INSERT with `superseded_at IS NULL` | `prediction.created` | `previous_value=NULL, new_value=to_jsonb(NEW)`, `actor = NEW.created_by`, `source='trigger'` |
| UPDATE setting `superseded_at IS NOT NULL` | `prediction.superseded` | `previous_value=to_jsonb(OLD), new_value=to_jsonb(NEW)`, `actor = NEW.superseded_by`'s `created_by` (resolved by the trigger via a SELECT), `source='trigger'` |

The SP additionally writes `prediction.rejected_*` rows directly for denied attempts (when the SP raises an EXCEPTION, the audit row is committed in the same transaction the exception aborts — the audit-write is a no-throw side-effect using `RAISE NOTICE` and a separate transactional INSERT-then-RAISE pattern). Reason codes: `lock_window_passed`, `match_status_locked`, `invalid_score`, `invalid_match`, `ineligible`.

Recursion guard: `IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;` at the top of the trigger function.

---

### 2. Lock Decision Event (audit reference)

**Purpose**. The `audit_log` rows with `action='prediction.rejected_*'` (rejected attempts) and `action='prediction.kickoff_correction_crossed_lock'` (kickoff-correction crossings per FR-013).

**Schema** (inherited from Slice 001 / extended at Slice 007):

| Attribute | Source | Notes |
|---|---|---|
| `action` | this slice writes | `prediction.created` / `prediction.superseded` / `prediction.rejected_locked` / `prediction.rejected_invalid_score` / `prediction.rejected_invalid_match` / `prediction.rejected_ineligible` / `prediction.kickoff_correction_crossed_lock` |
| `actor` | this slice writes | `participants.id` of the participant who attempted, OR NULL for system-driven events (kickoff correction crossing) |
| `entity_type` | this slice writes | `'prediction'` (data rows) OR `'match'` (kickoff correction) OR `'auth_attempt'` (rejected before any data wrote) |
| `entity_id` | this slice writes | `predictions.id` when applicable, else `matches.id` for kickoff-correction events |
| `previous_value` / `new_value` | this slice writes | Full row JSON per the data change |
| `reason` | this slice writes | `'lock_window_passed'`, `'match_status_locked'`, `'invalid_score'`, `'invalid_match'`, `'ineligible'`, `'kickoff_correction_crossed_lock'` |
| `source` | this slice writes | `'trigger'` (data-change-driven), `'sp'` (SP-driven rejection), or `'route_handler'` (Next.js route's pre-SP validation rejection) |

**Cross-slice contract**. Slice 007 will harden retention; the column shape this slice writes to is locked. Slice 005's `score_match` reads `audit_log` indirectly via spec FR-018 dispute-resolution flows; Slice 006's admin UI reads `prediction.rejected_*` rows to surface "this participant tried to edit X times during the lock window."

---

## Helper functions owned by this slice

### `is_prediction_locked(p_match_id uuid) RETURNS boolean STABLE` (locked cross-slice)

The canonical lock-state predicate. Returns `true` when the match cannot accept new predictions; `false` when it can.

```sql
CREATE OR REPLACE FUNCTION public.is_prediction_locked(p_match_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status            text;
  v_kickoff_utc       timestamptz;
  v_lock_window_min   int;
BEGIN
  SELECT status::text, kickoff_utc INTO v_status, v_kickoff_utc FROM public.matches WHERE id = p_match_id;
  IF v_status IS NULL THEN RETURN true; END IF;                       -- match not found → fail-closed (locked)
  IF v_status <> 'scheduled' THEN RETURN true; END IF;                -- BR-LOCK-004
  SELECT COALESCE((value::text)::int, 60) INTO v_lock_window_min
  FROM public.tournament_config WHERE key = 'lock_window_minutes';
  RETURN now() >= v_kickoff_utc - (v_lock_window_min * INTERVAL '1 minute');  -- BR-LOCK-002 / BR-LOCK-003 (strict boundary on >=)
END $$;
```

**Locked cross-slice signature**: `is_prediction_locked(uuid) RETURNS boolean STABLE`. Slice 005's `peer_pick_v` filters via this function; Slice 006's admin UI calls it to determine whether manual reopening is needed. Renaming or signature changes after this slice ships require coordinated regression updates across Slices 005 + 006 (Principle XI).

### `submit_prediction(p_participant_id, p_match_id, p_home, p_away, p_source) RETURNS uuid` (locked cross-slice)

The single write path for predictions. SECURITY DEFINER. Body per research § R-003. Signature locked.

---

## RLS posture summary

| Table | Policy name | Type | Predicate |
|---|---|---|---|
| `predictions` | `predictions_self_read` | SELECT | `participant_id IN (SELECT id FROM public.participants WHERE auth_user_id = auth.uid())` |
| `predictions` | `predictions_admin_read` | SELECT | `public.is_admin(auth.uid())` |
| `predictions` | _(no INSERT/UPDATE/DELETE policies)_ | — | All writes via `submit_prediction()` SECURITY DEFINER SP |

**Note on Slice 005 peer-pick access**: Slice 005's `peer_pick_v` is a view that needs to read other participants' predictions when `is_prediction_locked(match_id) = true`. The view will use `security_invoker = false` (i.e., it runs as its owner role, not the calling user). The view's SELECT filter encodes the lock predicate so visibility is gated at the view definition; the underlying `predictions` table's RLS continues to deny direct cross-participant access. This slice's contract surface to Slice 005 is: **read access happens only through the view, never via direct table SELECT**.

---

## Capability contracts owned by this slice

1. **`predictions` table shape** — locked. Slice 005's `score_match` reads `predicted_home` / `predicted_away` by name; Slice 005's `peer_pick_v` reads same plus `submitted_at`.
2. **`is_prediction_locked(uuid)` predicate** — locked signature and semantics; Slice 005 `peer_pick_v` and Slice 006 admin tooling reference it.
3. **`submit_prediction(uuid, uuid, int, int, text)` SP** — locked signature; Slice 006 admin manual-entry calls it.
4. **`audit_log` actions `prediction.*`** — locked action labels; Slice 007 hardens retention but the label set is fixed.
5. **`Match.lock_state` field on `/api/matches` response** — additive extension of Slice 002's contract; new consumers can rely on the field's presence.

These five together extend the cross-slice foundation laid by Slices 001 + 002.

## Open questions deferred to other slices

| Question | Owner slice | This slice's posture |
|---|---|---|
| Admin manual-entry UI invoking `submit_prediction(..., source='admin_override')` | 006 | SP signature reserves the parameter; UI deferred |
| Final-tournament predictions (champion, runner-up, top scorer, best player) | 004 | Separate `final_predictions` table owned by Slice 004; lock at first kickoff |
| Personal prediction history surface (full chain visible to participant) | 005 | Slice 005's `/me/breakdown` surface includes scored history; this slice exposes only active rows |
| Real-time leaderboard or per-match prediction counts | 005 | Out of scope here |
| Real `is_admin(uuid)` body | 006 | Permissive stub from Slice 001 |
