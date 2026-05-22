# Phase 0 Research: Final Tournament Predictions

**Feature**: 004-final-predictions
**Date**: 2026-05-16
**Status**: Complete — no spec-level `[NEEDS CLARIFICATION]` markers remain. All lock + visibility decisions anchored to trusted server time (Constitution Principle VI). Scoring-time decisions (OD-004 top-scorer ties, OD-005 best-player source) are intentionally deferred to Slice 005 per spec § Architecture anchors.

## Scope of this document

Each entry follows `Decision / Rationale / Alternatives considered / Constitution anchor`. Decisions that resolve to a spec FR / SC / BR-LOCK rule are tagged.

This slice depends on **Slice 001** (eligibility, participants, audit_log, tournament_config), **Slice 002** (teams, the reserved `MatchDataProviderAdapter.fetchPlayers?` method, the catalog's first_kickoff_utc derivation), and **Slice 003** (the lock + audit + SP design pattern this slice mirrors). It ships the cross-slice contracts: the `players` table shape, the `final_predictions` table shape, the **`is_final_prediction_locked()` locked predicate** (referenced by Slice 005's `peer_final_pick_v` view + `score_finals` function), and the **`submit_final_prediction(...)` locked SP** (referenced by Slice 006's admin manual-entry path).

---

## R-001 — Per-item storage model for the four final predictions

**Decision**. `public.final_predictions` is a single table where each row represents **one** of the four item kinds (`champion`, `runner_up`, `top_scorer`, `best_player`) for one participant. Each item has its own append-only supersede chain — UPDATEing the champion pick does not touch the runner-up pick. Schema:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `participant_id` | uuid | FK → `participants(id)`, NOT NULL |
| `item_kind` | enum (`champion`, `runner_up`, `top_scorer`, `best_player`) | NOT NULL |
| `target_team_id` | uuid | FK → `teams(id)` — set only when `item_kind IN ('champion','runner_up')`; otherwise NULL |
| `target_player_id` | uuid | FK → `players(id)` — set only when `item_kind IN ('top_scorer','best_player')`; otherwise NULL |
| `submitted_at` | timestamptz | NOT NULL, server-default `now()` |
| `source` | enum (`ui`, `api`, `admin_override`) | NOT NULL |
| `superseded_at` | timestamptz | NULL when active |
| `superseded_by` | uuid | FK → `final_predictions(id)` when set |
| `created_by` | uuid | FK → `participants(id)`; equals `participant_id` unless `source='admin_override'` |
| `created_at` / `updated_at` | timestamptz | trigger-maintained |

**Unique partial index**: `CREATE UNIQUE INDEX final_predictions_active_uk ON final_predictions(participant_id, item_kind) WHERE superseded_at IS NULL;` — enforces exactly one active row per (participant, item_kind) pair. SC-004's "1,000 concurrent edits, exactly one active" is a storage-layer guarantee.

CHECK constraints:
- `((item_kind IN ('champion','runner_up')) = (target_team_id IS NOT NULL))` AND `((item_kind IN ('top_scorer','best_player')) = (target_player_id IS NOT NULL))` — exactly one target column populated per row, matching the item kind.
- `((superseded_at IS NULL) = (superseded_by IS NULL))` — consistent supersede state.

**Rationale**.
- Spec FR-002 + US1.2: items are **independently editable**. One row per (participant, item_kind) is the natural model — you can supersede the champion pick without touching the other three.
- Spec § Key Entities explicitly lists "Final Prediction Set (active)" AND "Final Prediction Version (history)" — the supersede chain models both inside one table (same pattern as Slice 003).
- Unique partial index + advisory lock in the SP (R-003) gives the same SC-004 guarantee Slice 003 achieves.
- The `target_team_id` / `target_player_id` split with CHECK constraint is a cleaner data model than a polymorphic `target_id uuid` column (which would lose FK enforcement and require runtime kind-dispatching everywhere).

**Alternatives considered**.
- *One row per participant with four columns (`champion_team_id`, `runner_up_team_id`, `top_scorer_player_id`, `best_player_player_id`)*. Rejected: makes "individually editable history" harder (each item needs its own version chain; a wide row's audit becomes ambiguous). Wide-row also makes the "unsubmitted item" semantics implicit (NULL means unset) instead of explicit (no row exists), which interferes with Slice 005's "no valid prediction → 0 points" scoring.
- *Four separate tables (`final_pick_champion`, `final_pick_runner_up`, `final_pick_top_scorer`, `final_pick_best_player`).* Rejected: 4× the schema surface for trivial differentiation; the `item_kind` enum gives the same per-item semantics with one table.
- *Polymorphic `target_id uuid` (no team/player split).* Rejected: loses Postgres FK validation; runtime kind-dispatching needed to know whether to JOIN teams or players.

**Constitution anchor**. V (Auditability — append-only structure), VII (unique partial index as hard storage-layer guarantee).

---

## R-002 — Global lock predicate `is_final_prediction_locked()` (locked cross-slice)

**Decision**. Define one PL/pgSQL function `public.is_final_prediction_locked() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER`. No parameter — the lock is **global** (single instant for all participants and all four items). Returns `true` iff `now() >= (SELECT (value)::text::timestamptz FROM tournament_config WHERE key = 'first_kickoff_utc')`. Fail-closed: returns `true` if the config row is missing.

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

Slice 005's `peer_final_pick_v` view filters `WHERE public.is_final_prediction_locked() = true` to expose peer picks only after lock. This slice's write paths reject when this returns `true`.

**Rationale**.
- Spec FR-003: the lock is global, fires once at first kickoff. Single function with no parameter is the simplest possible shape.
- Same pattern as Slice 003's `is_prediction_locked(uuid)` — STABLE, SECURITY INVOKER, fail-closed, `now()`-driven (BR-LOCK-001 trusted server time only).
- BR-LOCK-005 strict boundary: at exactly `first_kickoff_utc` the lock fires. `now() >= first_kickoff_utc` encodes this exactly.
- Cross-slice contract: Slice 005 referenced this in its data-model § "Slice 008 owns `first_kickoff_utc`" planning note. The function is named for its capability, locked for the slice's lifetime.

**Alternatives considered**.
- *`is_final_prediction_locked(p_participant_id uuid)` per-participant.* Rejected: lock is global; per-participant signature suggests it varies, which it doesn't. Misleading.
- *Materialized state column on `tournament_config` (`final_predictions_locked boolean`)* refreshed via cron. Rejected: introduces a staleness window; the function approach is always fresh.
- *Inline the comparison in every write path.* Rejected: violates Principle III; the rule must live in one place.

**Constitution anchor**. III (Rules Outside the UI), VI (Time-Zone Correctness). Cross-slice locked contract — Slice 005's `peer_final_pick_v` references.

---

## R-003 — `submit_final_prediction(...)` SECURITY DEFINER SP (locked cross-slice)

**Decision**. All writes to `final_predictions` flow through one PL/pgSQL function:

```sql
CREATE OR REPLACE FUNCTION public.submit_final_prediction(
  p_participant_id   uuid,
  p_item_kind        text,              -- 'champion' | 'runner_up' | 'top_scorer' | 'best_player'
  p_target_team_id   uuid,              -- non-NULL for champion/runner_up; NULL otherwise
  p_target_player_id uuid,              -- non-NULL for top_scorer/best_player; NULL otherwise
  p_source           text               -- 'ui' | 'api' | 'admin_override'
) RETURNS uuid                          -- the newly-inserted final_predictions.id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

Body steps (analogous to Slice 003's `submit_prediction`):

1. `PERFORM pg_advisory_xact_lock(hashtext(p_participant_id::text || ':' || p_item_kind));` — per-(participant, item) lock so concurrent edits to the same item serialize; concurrent edits to different items run in parallel.
2. Validate `p_item_kind IN ('champion','runner_up','top_scorer','best_player')`. Else `RAISE EXCEPTION ... ERRCODE='WFP03'`.
3. Validate `p_source IN ('ui','api','admin_override')`. Else `RAISE EXCEPTION ... ERRCODE='WFP03'`.
4. Validate target shape: team kinds require `p_target_team_id IS NOT NULL AND p_target_player_id IS NULL`; player kinds require the inverse. Else `RAISE EXCEPTION ... ERRCODE='WFP03'`.
5. Validate target existence: for team kinds `SELECT 1 FROM teams WHERE id = p_target_team_id`; for player kinds `SELECT 1 FROM players WHERE id = p_target_player_id AND removed_at IS NULL` (R-013 — picks must reference active roster players). Missing → `RAISE ... ERRCODE='WFP04'` (`invalid_target`).
6. Defense-in-depth eligibility check: `is_eligible_nortal_participant((SELECT auth_user_id FROM participants WHERE id = p_participant_id))`. Else `RAISE ... ERRCODE='WFP05'`.
7. **Lock check**: `IF public.is_final_prediction_locked() THEN write audit + RAISE ERRCODE='WFP01';` (lock has fired globally).
8. **Disjoint check** (FR-007): if `p_item_kind = 'runner_up'`, look up the participant's active champion pick. If the same team is already champion AND `tournament_config.predictions.allow_identical_champion_runner_up` (default `false`) is `false`, `RAISE ... ERRCODE='WFP06'` (`identical_champion_runner_up`). Symmetric check on champion submission against existing runner-up.
9. SELECT existing active `FOR UPDATE` for `(p_participant_id, p_item_kind)`.
10. INSERT new row (`participant_id = p_participant_id`, `item_kind = p_item_kind`, target column per kind, `superseded_at = NULL`, `source = p_source`, `created_by = p_participant_id`). Capture `v_new_id`.
11. If existing row: UPDATE old `SET superseded_at = now(), superseded_by = v_new_id`.
12. RETURN `v_new_id`. The audit trigger emits `final_prediction.created` / `final_prediction.superseded` rows automatically.

ERRCODE values are **locked** as `WFP01`–`WFP06` (mirrors Slice 003's WCM01–WCM05 pattern). Route handler maps them to HTTP responses.

**Rationale**.
- Centralized write path means every surface (Slice 004 route handler, Slice 006 admin manual-entry, future bulk admin tools) goes through the same validation + lock check + audit emission.
- Per-(participant, item_kind) advisory lock = maximally concurrent across distinct (participant, item) pairs while serializing within them.
- Locked signature matches Slice 003's submit_prediction shape — both slices serve as the template for Slice 006's admin manual-entry path.

**Alternatives considered**.
- *Two SPs (`submit_team_pick` + `submit_player_pick`).* Rejected: duplicates the validation + lock + audit boilerplate; the kind enum is enough.
- *Submit all four at once (single SP with four target_* params, all 4 items submitted in one transaction).* Rejected: spec FR-002 requires independent editing; bundling forces "you must submit all four together" UX.

**Constitution anchor**. II, III, V, VII, VIII, XI (locked cross-slice). Mirrors Slice 003 R-003 pattern.

---

## R-004 — `players` table ownership + `MatchDataProviderAdapter.fetchPlayers?` ingest path

**Decision**. This slice owns the `public.players` table. Slice 002 reserved `fetchPlayers?(): Promise<NormalizedPlayer[]>` as an **optional** method on `MatchDataProviderAdapter` — this slice flips the optional bit and starts calling it. The sync coordinator (Slice 002's `supabase/functions/sync-catalog/index.ts`) is **extended** by this slice with a new `case 'players':` branch in its UPSERT loop that consumes `fetchPlayers()` output and UPSERTs into `players`.

Schema:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `full_name` | text | NOT NULL |
| `team_id` | uuid | FK → `teams(id)`; NULL if unattributed (free agents, undeclared at fixture time) |
| `aliases` | text[] | For manual disambiguation against provider name variations |
| `removed_at` | timestamptz | NULL when active; set when the player is removed from a roster after submission (R-013) |
| `created_at` / `updated_at` | timestamptz | trigger-maintained |

Plus `player_provider_external_ids` mapping table (mirrors `team_provider_external_ids` from Slice 002 R-003), keyed `(provider_name, provider_player_id)`.

**Rationale**.
- Slice 002's `provider-adapter.contract.md` § Interface explicitly reserved `fetchPlayers?` for "Slice 004's consumption." Slice 004 is the first slice that needs player roster data (for top_scorer + best_player picks).
- Adding the `case 'players':` branch to the sync coordinator preserves the locked `MatchDataProviderAdapter` interface — no contract change.
- `removed_at` column supports R-013's "player removed before lock" handling without dropping audit-able history.

**Alternatives considered**.
- *Slice 002 ingests players from day one.* Rejected: spec § Out of scope for Slice 002 explicitly deferred. Slice 002's contract reserved the method exactly for this purpose.
- *Roster data sourced directly by Slice 004's route handler (separate from the sync coordinator).* Rejected: violates Principle IV (provider abstraction); admin manual entry (Slice 006) wouldn't have the same path.

**Constitution anchor**. IV (Provider Abstraction — Slice 002's interface is the single ingest contract), I (vendor-neutral player entity).

---

## R-005 — Disjoint champion/runner-up enforcement (FR-007)

**Decision**. The SP body's step 8 (see R-003) enforces "no identical champion/runner-up by default" via `tournament_config.predictions.allow_identical_champion_runner_up` (default `false`). When `false`, attempting to submit `team_X` as runner-up while `team_X` is already the participant's champion (or vice versa) raises `WFP06` → 409 with `reason='identical_champion_runner_up'`.

This config key is **seeded by this slice** (default `false` per spec FR-007). Slice 008 admin UI may toggle it.

**Rationale**.
- Spec FR-007 explicitly: "by default reject identical champion/runner-up; this validation rule MUST be configurable per Slice 008."
- Default-deny is the safer posture (most prediction pools forbid; sponsors can permit if they choose).
- Per-(participant, item) advisory lock from R-003 makes the disjoint check race-safe — a participant cannot concurrently submit `team_X` as both champion and runner-up because the advisory lock serializes the two SP invocations.

**Alternatives considered**.
- *Always allow.* Rejected: violates FR-007 default.
- *Always reject (no config).* Rejected: spec is explicit that the rule is configurable.
- *Trigger-level enforcement instead of SP-body.* Rejected: trigger would raise an exception that the route handler couldn't differentiate from other CHECK violations; SP-body raises a typed ERRCODE.

**Constitution anchor**. II, VIII.

---

## R-006 — `first_kickoff_utc` config key source

**Decision**. `tournament_config.first_kickoff_utc` (`jsonb` storing an ISO-8601 string) is the canonical first-kickoff reference. It is **populated by Slice 002's sync coordinator** in a post-UPSERT step: after each successful sync, the coordinator computes `SELECT min(kickoff_utc) FROM matches WHERE status = 'scheduled'` and UPSERTs into `tournament_config`. If the value changes, it emits an `audit_log` row with `action='tournament.first_kickoff_corrected'` referencing the OLD and NEW value (FR-009 + SC-005).

Slice 004's `is_final_prediction_locked()` reads this key on every call. Slice 008's admin UI may also UPDATE the key directly (manual override for edge cases).

**Note**: Slice 005's research § R-014 already mentioned `first_kickoff_utc` as a deferred concern. This slice formally owns the producer (Slice 002 sync) and the primary consumer (Slice 004 lock).

**Rationale**.
- SC-005 (1-minute correction responsiveness): the sync coordinator updates the value on every catalog sync; the lock predicate reads it fresh on every call. No cache, no staleness.
- Spec FR-009 + Edge Case "first-kickoff time corrected after some participants have already locked in": the audit row captures the correction; Slice 006 admin tooling consumes it.
- Computing `min(kickoff_utc) WHERE status = 'scheduled'` is the canonical "first match that hasn't started yet." If the original first match gets postponed/cancelled, the next-earliest scheduled match automatically becomes the new "first" — exactly the spec Edge Case behavior.

**Alternatives considered**.
- *Admin sets the value manually (no automatic computation).* Rejected: error-prone; the catalog is the source of truth.
- *Compute on read (`SELECT min(kickoff_utc) ...` inside `is_final_prediction_locked()`).* Rejected: more expensive (joins on every lock call); cached + correction-emitting approach is cleaner.

**Constitution anchor**. VI (UTC source-of-truth), VIII (config-driven), V (audit on correction).

---

## R-007 — Audit pattern (`final_prediction.*` actions)

**Decision**. `AFTER INSERT OR UPDATE ON final_predictions` trigger emits one `audit_log` row per state change:

| Trigger event | Action label | previous_value | new_value | reason |
|---|---|---|---|---|
| INSERT with `superseded_at IS NULL` | `final_prediction.created` | NULL | new row | NULL |
| UPDATE setting `superseded_at IS NOT NULL` | `final_prediction.superseded` | old row | new row | NULL |

The SP additionally emits `final_prediction.rejected_*` rows for rejected attempts (analogous to Slice 003). Reason field: `lock_window_passed` (BR-LOCK-005), `invalid_target` (player/team doesn't exist), `invalid_input` (bad params), `ineligible`, `identical_champion_runner_up`.

Plus the first-kickoff-correction audit (R-006) writes `tournament.first_kickoff_corrected` rows from Slice 002's sync coordinator. Slice 005's scoring engine reads these to compute its own audit narrative.

Recursion guard: `pg_trigger_depth() = 1` (same pattern as Slice 001 / 002 / 003).

**Constitution anchor**. V (NON-NEGOTIABLE).

---

## R-008 — RLS posture on `final_predictions` + `players`

**Decision**.

`final_predictions`:
- `final_predictions_self_read` (SELECT): `participant_id IN (SELECT id FROM participants WHERE auth_user_id = auth.uid())`.
- `final_predictions_admin_read` (SELECT): `is_admin(auth.uid())`.
- No write policies — SP-only via SECURITY DEFINER.

`players`:
- `players_eligible_read` (SELECT): `is_eligible_nortal_participant(auth.uid())` — every eligible participant can read the roster (needed to render the picker UI).
- No write policies — sync-coordinator-only via service role.

Slice 005's `peer_final_pick_v` view will surface other participants' final predictions when `is_final_prediction_locked() = true`. The view will be created in Slice 005 and use the same `SECURITY DEFINER` access pattern Slice 005 already uses for `peer_pick_v` (the underlying `final_predictions` table's self-only RLS is preserved).

**Constitution anchor**. II (NON-NEGOTIABLE).

---

## R-009 — Submit endpoint shape (`POST /api/final-predictions`)

**Decision**. The route handler at `apps/web/app/api/final-predictions/route.ts`:

| Aspect | Value |
|---|---|
| Method | `POST` |
| Auth | Supabase session cookie + `requireEligible(client)` (Slice 001) |
| Body | `{ item_kind: 'champion'\|'runner_up'\|'top_scorer'\|'best_player', target_team_id?: uuid, target_player_id?: uuid }` |
| Validation | Zod schema; exactly one of `target_team_id` / `target_player_id` present per `item_kind` |
| Server action | `client.rpc('submit_final_prediction', {p_participant_id: <self>, p_item_kind, p_target_team_id, p_target_player_id, p_source: 'ui'})` |
| Success | 200 with `{ final_prediction: { id, item_kind, target_team_id, target_player_id, submitted_at, source } }` |
| Errors | 400 (bad body) / 401 (no session) / 403 (not eligible) / 404 (target doesn't exist) / 409 (locked / identical champion-runner-up) / 422 (invalid input) |

One endpoint per item kind would inflate the surface area without benefit; the discriminated union via `item_kind` is cleaner.

**Constitution anchor**. III.

---

## R-010 — Personal final-predictions read (`GET /api/me/final-predictions`)

**Decision**. New route handler `apps/web/app/api/me/final-predictions/route.ts`:

| Aspect | Value |
|---|---|
| Method | `GET` |
| Auth | session cookie + `requireEligible(client)` |
| Server action | `SELECT id, item_kind, target_team_id, target_player_id, submitted_at, source FROM final_predictions WHERE participant_id = <self> AND superseded_at IS NULL` (RLS-bound) |
| Response | `{ final_predictions: [...] }` — array of up to 4 entries; unset items absent from the array |

The response also embeds `lock_state: 'editable' | 'locked'` at the top level, computed from `is_final_prediction_locked()`. This is the final-prediction analogue to Slice 003's `Match.lock_state` field.

History (superseded versions) is NOT exposed by this endpoint — same posture as Slice 003 (Clarifications 2026-05-16 Q3 mirror). Slice 005's `/me/breakdown` surface owns the full history view.

**Constitution anchor**. II, III.

---

## R-011 — UI scope: dedicated `/me/finals` page (new) + integration with `/matches`

**Decision**. This slice ships a new participant-facing page at `apps/web/app/(participant)/me/finals/page.tsx`. The architecture document (§14.1 *Participant Experience Requirements*: "Final tournament predictions should have a separate prominent section with its own deadline and explanation") motivates a dedicated page rather than inline integration on `/matches`.

The page renders:
- A clearly-labeled header ("Tournament Predictions") with the global lock countdown.
- Four input components — two team pickers (champion + runner-up) and two player pickers (top scorer + best player).
- Each picker shows the participant's current active pick (if any) and lets them update.
- A "Locked" banner replaces the form once `is_final_prediction_locked() = true`.

A small visual indicator on `/matches` (Slice 002+003 page) links to `/me/finals` when the lock state is editable AND any of the four picks is unset.

**Rationale**.
- Architecture §14.1 explicitly: "separate prominent section with its own deadline and explanation."
- Spec § Independent Test US1: "verify all four appear in the participant's profile area as the active final-prediction set" — implies a profile-area page.
- Keeps `/matches` focused on per-match prediction; finals UX is conceptually distinct (single deadline, 4 picks).

**Constitution anchor**. X.

---

## R-012 — Team / player picker UI affordance

**Decision**. The team picker is a typeahead/autocomplete input that queries `/api/teams` (a thin GET endpoint introduced here that wraps Slice 002's `teams` table — RLS-gated). The player picker is similar against `/api/players` (new endpoint).

The `/api/players` endpoint supports `?team_id=<uuid>` filtering and `?q=<text>` substring search on `full_name` + `aliases`. Both endpoints return active rows only (`removed_at IS NULL`).

For ~32 teams: typeahead is overkill but accessible; for ~700+ tournament players: typeahead is essential.

**Constitution anchor**. III (presentation-only UI), II (RLS-gated endpoint).

---

## R-013 — Player removed between submission and lock

**Decision**. When Slice 002's sync coordinator detects a player removal (provider stopped returning a player who was previously present), it sets `players.removed_at = now()` instead of deleting the row. A trigger on `players` (`AFTER UPDATE WHEN OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL`) emits one `audit_log` row per active `final_predictions` row that references the player, with `action='final_prediction.target_player_removed'` and `reason='player_removed_from_roster'`.

The participant's pick row is **not modified** — they may re-pick a different player while the lock is open, or leave it; if still pointing at a removed player at lock time, Slice 005's `score_finals` will treat it as "no valid prediction" (0 points) per FR-008.

A separate UI surface (the `/me/finals` page) reads these audit rows and renders a warning banner "Your top scorer pick is no longer on the roster — please re-pick."

**Rationale**.
- Spec Edge Case "player removed AFTER submission BUT BEFORE lock": invalidate the pick and notify the participant.
- Spec FR-012: "informational — Slice 008 governs notification policy." This slice produces the signal; Slice 008 owns the channel.
- Soft-delete (`removed_at` column) over hard delete preserves FK integrity for `final_predictions.target_player_id` referencing the removed player.

**Constitution anchor**. V, VII.

---

## R-014 — First-kickoff-correction propagation (FR-009 / SC-005)

**Decision**. Slice 002's sync coordinator computes `first_kickoff_utc` after each sync (R-006). When it changes, the coordinator's UPDATE on `tournament_config` triggers an audit row `action='tournament.first_kickoff_corrected'`. A separate trigger on `tournament_config` (`AFTER UPDATE WHEN OLD.value != NEW.value AND key = 'first_kickoff_utc'`) emits one additional audit row per active `final_predictions` row, with `action='final_prediction.first_kickoff_corrected'` — Slice 006 admin UI consumes these for per-participant communication.

**Constitution anchor**. V, VI. Supports **FR-009, SC-005**.

---

## R-015 — Out of scope (intentionally deferred)

- **Scoring** of final predictions: Slice 005's `score_finals(run_id)` reads `final_predictions` (active rows) and joins `tournament_award` (Slice 005-owned table) to compute points. This slice ships only the submission + lock + history surface; no points computed.
- **Notification channels** for "player removed from your pick" / "first kickoff moved": Slice 008 governs (OD-008).
- **Admin manual override** of finals: Slice 006 wraps `submit_final_prediction(..., source='admin_override')` with an admin RPC + UI.
- **Top-scorer ties / best-player source** (OD-004 / OD-005): scoring-time decisions, Slice 005's territory.
- **Public leaderboard of "most popular champion pick"**: out of scope; raises privacy questions handled at Slice 008's admin UI level.

**Constitution anchor**. X. Tracked deferrals: Slice 005 (scoring + ties), Slice 006 (admin manual entry), Slice 008 (notifications + admin overrides of config).

---

## R-016 — Cross-slice contract locks introduced

| Contract | Locking task | Consumers |
|---|---|---|
| `final_predictions` table shape | This slice | Slice 005's `score_finals` reads `target_team_id` / `target_player_id` / `item_kind` by name; Slice 005's `peer_final_pick_v` view reads same |
| `players` table shape | This slice | Slice 005's `score_finals` joins for top_scorer / best_player resolution; Slice 006 admin UI references |
| **`is_final_prediction_locked() RETURNS boolean STABLE`** predicate | This slice | Slice 005's `peer_final_pick_v` view filter; Slice 006 admin reopen tooling |
| **`submit_final_prediction(uuid, text, uuid, uuid, text) RETURNS uuid`** SP signature + ERRCODE values WFP01–WFP06 | This slice | Slice 006's `admin_submit_final_prediction` wrapper |
| `audit_log` action labels `final_prediction.*`, `tournament.first_kickoff_corrected` | This slice | Slice 005 scoring narrative; Slice 006 admin UI; Slice 007 audit hardening |
| `tournament_config.first_kickoff_utc` (produced by Slice 002 sync; consumed by this slice's predicate) | Slice 002 sync coordinator (already exists in Slice 002 fetch loop; this slice formalizes the producer-consumer contract) | Slice 005's `peer_final_pick_v` lock filter |
| `MatchDataProviderAdapter.fetchPlayers?` activation (Slice 002 reserved the optional method; this slice flips it to required-for-final-predictions) | This slice | Slice 002's sync coordinator's `case 'players'` branch |

---

## Summary

All implementation-pattern unknowns are resolved. Constitution check in `plan.md` references these decisions by ID. The slice mirrors Slice 003's pattern (locked predicate + locked SP + append-only chain + RLS + audit) adapted for the global-lock + four-item-kind shape.
