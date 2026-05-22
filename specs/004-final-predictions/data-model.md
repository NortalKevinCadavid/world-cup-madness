# Phase 1 Data Model: Final Tournament Predictions

**Feature**: 004-final-predictions
**Date**: 2026-05-16
**Status**: Draft (Phase 1 output)
**Vendor-neutral**: Capability terms (Principle I). Concrete Supabase/Postgres details live in `plan.md` § Source Code and `contracts/`.

## Cross-slice ownership map

| Artifact | Owner slice | This slice's responsibility |
|---|---|---|
| `public.final_predictions` | **004 (this slice)** | Create, RLS, indexes, unique partial index, audit trigger |
| `public.players` | **004 (this slice)** | Create, RLS, audit trigger (for `removed_at` transitions) |
| `public.player_provider_external_ids` | **004 (this slice)** | Create (mirrors `team_provider_external_ids` from Slice 002) |
| `public.is_final_prediction_locked()` | **004 (this slice)** | Define; locked cross-slice contract |
| `public.submit_final_prediction(...)` SP | **004 (this slice)** | Define; locked cross-slice contract |
| `audit_log` actions `final_prediction.*`, `tournament.first_kickoff_corrected`, `final_prediction.target_player_removed`, `final_prediction.first_kickoff_corrected` | **004 (this slice writes)** | Write rows; shape inherited from Slice 001 |
| `tournament_config.first_kickoff_utc` | Slice 002 produces (sync coordinator UPSERTs); **004 consumes** | Read-only in predicate |
| `tournament_config.predictions.allow_identical_champion_runner_up` | **004 (this slice seeds)** with default `false` | Slice 008 admin UI toggles |
| `MatchDataProviderAdapter.fetchPlayers?` | Slice 002 reserves; **004 activates** | This slice's task list includes extending Slice 002's sync coordinator with `case 'players':` |
| `participants` / `is_eligible_nortal_participant` / `is_admin` (stub) | 001 | Read-only consumer |
| `teams` | 002 | Read-only consumer (FK target for `target_team_id`) |
| `audit_log` table | 007 (Slice 001 stubs) | Write target |

After this slice ships, the `final_predictions` + `players` table shapes, the two function signatures, and the audit action labels are **locked cross-slice contracts**.

## Entities introduced by this slice

### 1. Final Prediction

**Purpose**. A single submission for one of the four final-tournament items per participant. Append-only: each submit/edit INSERTs a new row and chains the previous active row via `superseded_at` + `superseded_by`. Independent supersede chains per `(participant_id, item_kind)` pair.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `participant_id` | UUID | NOT NULL, FK → `participants(id)` ON DELETE RESTRICT | |
| `item_kind` | enum (`champion`, `runner_up`, `top_scorer`, `best_player`) | NOT NULL | |
| `target_team_id` | UUID | NULL when item is player-kind, FK → `teams(id)` when item is team-kind | |
| `target_player_id` | UUID | NULL when item is team-kind, FK → `players(id)` when item is player-kind | |
| `submitted_at` | timestamptz | NOT NULL, server-default `now()` | Immutable per row |
| `source` | enum (`'ui'`, `'api'`, `'admin_override'`) | NOT NULL | |
| `superseded_at` | timestamptz | NULL when active | |
| `superseded_by` | UUID | NULL when active, FK → `final_predictions(id)` | |
| `created_by` | UUID | NULL allowed, FK → `participants(id)` | Equals `participant_id` for non-admin sources; admin's id for `source='admin_override'` |
| `created_at` | timestamptz | NOT NULL, server-default `now()` | |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | Trigger-maintained |

**Validation rules**.
- Table CHECK: `((item_kind IN ('champion','runner_up')) = (target_team_id IS NOT NULL AND target_player_id IS NULL))` AND `((item_kind IN ('top_scorer','best_player')) = (target_player_id IS NOT NULL AND target_team_id IS NULL))`. Exactly one target column populated per item kind.
- Table CHECK: `((superseded_at IS NULL) = (superseded_by IS NULL))`.
- SP-enforced: target exists in the right table (teams or players); player target has `removed_at IS NULL`; lock not fired (`is_final_prediction_locked() = false`); eligibility (`is_eligible_nortal_participant`).
- SP-enforced: when `item_kind='runner_up'` and `tournament_config.predictions.allow_identical_champion_runner_up = false`, the target_team_id MUST differ from the participant's active champion target_team_id. Symmetric check on `item_kind='champion'`.

**State transitions**.
- **Active → Superseded**: SP UPDATE sets `superseded_at = now()`, `superseded_by = <new row's id>`. Terminal.

**Relationships**.
- N:1 → `participants` (via `participant_id`).
- N:1 → `teams` (when team-kind).
- N:1 → `players` (when player-kind).
- 1:0..1 → `final_predictions` (self, via `superseded_by`).
- 1:N → `audit_log`.

**Indexes**.

| Index | Columns | Purpose |
|---|---|---|
| `final_predictions_pkey` | `(id)` PK | Lookup by id |
| `final_predictions_active_uk` | `(participant_id, item_kind) WHERE superseded_at IS NULL` UNIQUE PARTIAL | Enforces exactly one active per pair (FR-010 / SC-004) |
| `final_predictions_participant_idx` | `(participant_id, item_kind, submitted_at DESC)` | Personal history feed |
| `final_predictions_target_team_idx` | `(target_team_id) WHERE superseded_at IS NULL AND target_team_id IS NOT NULL` | Slice 005 score_finals: "all active champion picks for team X" |
| `final_predictions_target_player_idx` | `(target_player_id) WHERE superseded_at IS NULL AND target_player_id IS NOT NULL` | Slice 005 score_finals: "all active top_scorer picks for player Y" |

**Audit posture**. `AFTER INSERT OR UPDATE` trigger writes one `audit_log` row per state change:
- INSERT with `superseded_at IS NULL` → `final_prediction.created`.
- UPDATE setting `superseded_at IS NOT NULL` → `final_prediction.superseded`.

SP additionally writes `final_prediction.rejected_*` rows for denied attempts (lock_window_passed, invalid_target, invalid_input, ineligible, identical_champion_runner_up). Recursion guard via `pg_trigger_depth() = 1`.

---

### 2. Player

**Purpose**. A player eligible to be picked as `top_scorer` or `best_player`. Populated via Slice 002's sync coordinator extension (R-004) which calls the previously-reserved `MatchDataProviderAdapter.fetchPlayers?()` method.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | Internal stable identifier |
| `full_name` | text | NOT NULL | |
| `team_id` | UUID | NULL allowed, FK → `teams(id)` | NULL for free agents / pre-roster picks |
| `aliases` | text[] | NULL allowed | Manual disambiguation against provider name variants |
| `removed_at` | timestamptz | NULL when active | Set when the player is removed from a roster (R-013) |
| `created_at` | timestamptz | NOT NULL, server-default `now()` | |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | Trigger-maintained |

Plus `public.player_provider_external_ids (id uuid PK, player_id uuid FK, provider_name text, provider_player_id text, UNIQUE (provider_name, provider_player_id))` — mirror of Slice 002's team-mapping table.

**Validation rules**.
- `length(trim(full_name)) > 0` (CHECK).
- `team_id` FK enforced.

**State transitions**.
- **Active → Removed**: `removed_at` set when provider stops returning the player. Trigger emits `audit_log` rows per affected `final_predictions` row (R-013).

**Relationships**.
- N:1 → `teams` (optional).
- 1:N → `final_predictions` (when team-kind picks reference them).
- 1:N → `player_provider_external_ids`.

**Indexes**.

| Index | Columns | Purpose |
|---|---|---|
| `players_team_active_idx` | `(team_id) WHERE removed_at IS NULL` | Picker filtering by team |
| `players_name_search_idx` | GIN on `(full_name, array_to_string(aliases, ' '))` for substring search | `/api/players?q=` typeahead |
| `players_removed_at_idx` | `(removed_at)` | Soft-delete reporting |

**Audit posture**. INSERT / UPDATE via sync coordinator writes `audit_log` rows `player.created` / `player.updated` / `player.removed` (when `removed_at` transitions from NULL to non-NULL). The transition trigger additionally emits one `audit_log` row per active `final_predictions` row that references the now-removed player (R-013).

---

### 3. First Kickoff Reference (configuration consumed)

Not a table — a `tournament_config` key:

```jsonc
{
  "key": "first_kickoff_utc",
  "value": "2026-06-12T16:00:00Z"   // ISO-8601 UTC string in jsonb
}
```

Produced by Slice 002's sync coordinator post-UPSERT: `min(matches.kickoff_utc) WHERE status = 'scheduled'`. Consumed by this slice's `is_final_prediction_locked()`. Slice 008 admin UI may override.

When the value changes, Slice 002's coordinator emits `audit_log` row `action='tournament.first_kickoff_corrected'`. A trigger in **this slice** on `tournament_config` (`AFTER UPDATE WHEN OLD.value <> NEW.value AND key = 'first_kickoff_utc'`) additionally emits one `final_prediction.first_kickoff_corrected` audit row per active `final_predictions` row — for Slice 006 admin reopen-tooling.

---

## Helper functions owned by this slice

### `is_final_prediction_locked() RETURNS boolean STABLE` (locked cross-slice)

The global lock predicate. Returns `true` when no participant can edit any final prediction; `false` when editing is allowed. Reads `tournament_config.first_kickoff_utc`; fail-closed.

```sql
CREATE OR REPLACE FUNCTION public.is_final_prediction_locked()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first_kickoff timestamptz;
BEGIN
  SELECT (value::text)::timestamptz INTO v_first_kickoff
  FROM public.tournament_config WHERE key = 'first_kickoff_utc';
  IF v_first_kickoff IS NULL THEN RETURN true; END IF;   -- fail-closed
  RETURN now() >= v_first_kickoff;                       -- BR-LOCK-005 strict boundary
END $$;
```

**Locked cross-slice signature**: `is_final_prediction_locked() RETURNS boolean STABLE` (no args). Slice 005's `peer_final_pick_v` filter calls this. Renames or signature changes require coordinated regression updates.

### `submit_final_prediction(uuid, text, uuid, uuid, text) RETURNS uuid` (locked cross-slice)

The single write path. SECURITY DEFINER. Body per research § R-003. Signature locked.

---

## RLS posture summary

| Table | Policy | Type | Predicate |
|---|---|---|---|
| `final_predictions` | `final_predictions_self_read` | SELECT | `participant_id IN (SELECT id FROM participants WHERE auth_user_id = auth.uid())` |
| `final_predictions` | `final_predictions_admin_read` | SELECT | `public.is_admin(auth.uid())` |
| `final_predictions` | _(no INSERT/UPDATE/DELETE policies)_ | — | All writes via `submit_final_prediction()` SECURITY DEFINER SP |
| `players` | `players_eligible_read` | SELECT | `public.is_eligible_nortal_participant(auth.uid())` — every eligible participant reads roster for picker UI |
| `players` | _(no write policies)_ | — | Sync coordinator only via service role |
| `player_provider_external_ids` | `player_provider_external_ids_admin_read` | SELECT | `public.is_admin(auth.uid())` |

Slice 005's `peer_final_pick_v` view will use a SECURITY DEFINER access pattern (same approach as `peer_pick_v`) to expose other participants' final predictions after lock — the underlying table's self-only RLS is preserved.

---

## Capability contracts owned by this slice

1. **`final_predictions` table shape** — locked. Slice 005's `score_finals` and `peer_final_pick_v` read columns by name.
2. **`players` table shape** — locked. Slice 005 + Slice 006 consume.
3. **`is_final_prediction_locked()`** — locked signature; Slice 005's peer view filter.
4. **`submit_final_prediction(...)`** — locked SP signature + ERRCODE WFP01–WFP06.
5. **`audit_log` action labels** `final_prediction.*` + `tournament.first_kickoff_corrected` + `final_prediction.first_kickoff_corrected` + `final_prediction.target_player_removed` — locked label set.
6. **`tournament_config.first_kickoff_utc`** consumer contract — Slice 002 produces, this slice consumes. The producer formalization happens here.
7. **`MatchDataProviderAdapter.fetchPlayers?` activation** — Slice 002 reserved the optional method; this slice's tasks extend Slice 002's sync coordinator with `case 'players':`.

These seven together extend the cross-slice foundation laid by Slices 001 + 002 + 003.

## Open questions deferred

| Question | Owner slice | This slice's posture |
|---|---|---|
| Scoring of final predictions (point computation, tie resolution) | 005 | Score-time concern; this slice produces the data |
| OD-004 top-scorer ties | 005 | Scoring-time |
| OD-005 best-player source | 005 | Scoring-time |
| Admin manual override of finals | 006 | SP signature reserves `source='admin_override'` |
| Notification channels (player-removed, kickoff-corrected) | 008 | Audit emission only; transport deferred |
| Real `is_admin(uuid)` body | 006 | Permissive stub from Slice 001 |
