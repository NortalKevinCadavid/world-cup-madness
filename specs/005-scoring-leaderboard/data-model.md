# Phase 1 Data Model: Scoring & Leaderboard

**Feature**: 005-scoring-leaderboard
**Date**: 2026-05-15
**Status**: Draft (Phase 1 output)
**Vendor-neutral**: This document describes capabilities and entities (Principle I). Concrete Supabase/Postgres details live in `plan.md` § Source Code and in `contracts/`.

## Entities introduced by this slice

### 1. Score Record

**Purpose**. The awarded points for one (participant, target) pair, where target is either a finished match or a final-tournament item. Append-only by `(calculation_version, participant_id, target_kind, target_id)` — newer versions supersede older ones, but the older rows MUST be preserved (audit history).

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `participant_id` | UUID | FK → `participants(id)`, NOT NULL | |
| `target_kind` | enum | one of `match`, `final` | `final` covers all four final items via `target_id` referencing `final_item_kind` |
| `target_id` | UUID | NOT NULL | FK to `matches(id)` if `target_kind='match'`; FK to a synthetic `final_items` lookup if `target_kind='final'`. Validated by a CHECK against `target_kind`. |
| `final_item_kind` | enum or NULL | one of `champion`, `runner_up`, `top_scorer`, `best_player`; NULL when `target_kind='match'` | |
| `predicted_home` | int or NULL | for `match` rows only | non-negative |
| `predicted_away` | int or NULL | for `match` rows only | non-negative |
| `predicted_team_or_player_id` | UUID or NULL | for `final` rows only | FK to `teams(id)` for champion/runner-up; FK to `players(id)` for top-scorer/best-player |
| `official_home` | int or NULL | for `match` rows only | populated from `match_results.home_score_for_scoring`. **Terminology note**: the spec uses the phrase "official score" for this value; the column name in `match_results` is `home_score_for_scoring` because Slice 002 owns the resolution of OD-002 (knockout score basis — regular time + extra time, excluding penalty shootouts; see [research.md § R-006](./research.md#r-006--knockout-score-basis-od-002-implementation-surface)). The two terms refer to the same value. |
| `official_away` | int or NULL | for `match` rows only | populated from `match_results.away_score_for_scoring` (same terminology bridge as `official_home`). |
| `official_team_or_player_id` | UUID or NULL | for `final` rows only | populated from `tournament_award.*` |
| `points` | int | NOT NULL, ≥ 0 | one of 0, 5, 10 (match) or 0, 20 (final). Validated against `tournament_config` at write time. |
| `reason_code` | enum | NOT NULL | one of `exact`, `outcome`, `incorrect`, `none`, `final_correct`, `final_incorrect`, `final_pending` |
| `calculation_version` | int | NOT NULL | bumped per scoring run; readers filter `WHERE calculation_version = tournament_config.current_calculation_version` |
| `calculated_at` | timestamptz | NOT NULL, server-default `now()` | |
| `run_id` | UUID | FK → `score_calculation_runs(id)`, NOT NULL | |
| `source` | enum | one of `auto`, `admin_override`, `recalc` | |

**Unique constraint**. `(participant_id, target_kind, target_id, calculation_version)` — exactly one row per participant per target per calculation version.

**Validation rules**.
- For `target_kind='match'`: `predicted_home`, `predicted_away` MUST be non-negative integers; `official_home`, `official_away` MUST be non-NULL when `reason_code != 'none'`.
- For `target_kind='final'`: `predicted_team_or_player_id` MUST be non-NULL OR `reason_code='none'`; `official_team_or_player_id` MUST be non-NULL when `reason_code IN ('final_correct','final_incorrect')`.
- `points` MUST equal the value implied by `reason_code` + active `tournament_config` (CHECK or trigger-validated; spec FR-001/FR-002/FR-015).

**State transitions**. None — append-only. Replacing a row means inserting a new one with a higher `calculation_version`; the old row stays.

**Relationships**.
- N:1 → `participants` (a participant has many score records).
- N:1 → `matches` (when `target_kind='match'`).
- N:1 → `teams` / `players` (when `target_kind='final'`).
- N:1 → `score_calculation_runs` (every row belongs to exactly one run).
- 1:N → `audit_log` (each insert/update emits ≥ 1 audit row).

---

### 2. Score Calculation Run

**Purpose**. One row per execution of `score_match` or `score_finals`, capturing what was scored, why, by whom, when, and what changed.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | passed by the caller for idempotency |
| `scope` | enum | one of `match`, `finals`, `all` | |
| `target_id` | UUID or NULL | for `scope='match'` only | matches(id) |
| `trigger` | enum | one of `match_finish`, `award_confirmed`, `admin_recalc`, `config_change` | |
| `triggered_by` | UUID | NOT NULL | participants(id) for admins; a synthetic `system` participant for auto triggers |
| `reason` | text | NULL allowed for auto triggers; NOT NULL for `admin_recalc` and `config_change` | enforces audit clarity |
| `started_at` | timestamptz | NOT NULL, server-default `now()` | |
| `completed_at` | timestamptz | NULL until completion | |
| `status` | enum | one of `running`, `succeeded`, `failed` | |
| `affected_record_count` | int | NULL until completion | |
| `calculation_version_written` | int | NULL until completion | the new version this run produced |
| `notes` | text | NULL | e.g. `best_player_pending` |

**Validation rules**.
- `completed_at >= started_at` when set.
- `admin_recalc` and `config_change` MUST have `reason`.

**State transitions**.
- INSERT with `status='running'`, no `completed_at`.
- UPDATE to `status='succeeded'` (sets `completed_at`, `affected_record_count`, `calculation_version_written`) — terminal.
- UPDATE to `status='failed'` (sets `completed_at`, `notes`) — terminal, no version bump.

**Relationships**.
- 1:N → `score_records` (rows produced).
- 1:N → `audit_log` (start + complete = 2 audit rows minimum).

---

### 3. Tournament Award

**Purpose**. Single-row holder for the four final-tournament truth values (champion team, runner-up team, top scorer, best player) per tournament. Owned by Slice 006 (admin sets/confirms) with input from Slice 002 sync; consumed read-only by `score_finals`.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `tournament_id` | UUID | PK | one row per tournament |
| `champion_team_id` | UUID or NULL | FK → `teams(id)` | NULL until tournament concludes |
| `champion_status` | enum | one of `pending`, `confirmed` | |
| `runner_up_team_id` | UUID or NULL | FK → `teams(id)` | |
| `runner_up_status` | enum | one of `pending`, `confirmed` | |
| `top_scorer_player_id` | UUID or NULL | FK → `players(id)` | the officially-named FIFA Golden Boot winner (single) |
| `top_scorer_status` | enum | one of `pending`, `confirmed` | |
| `best_player_player_id` | UUID or NULL | FK → `players(id)` | the officially-named FIFA Golden Ball winner |
| `best_player_status` | enum | one of `pending`, `confirmed` | |
| `set_at` | timestamptz | NOT NULL, server-default `now()`, auto-updated | last write |
| `set_by` | UUID | FK → `participants(id)` | admin or system identity |

**Validation rules**. When `*_status = 'confirmed'`, the corresponding `*_id` MUST be NOT NULL. The reverse is permitted ("we know the value but haven't confirmed it" — used during the FIFA Golden Ball delay edge case).

**State transitions**. Each of the four `(team_or_player_id, status)` pairs transitions independently:
- `(NULL, pending)` → `(X, pending)` → `(X, confirmed)`. A jump from `(NULL, pending)` straight to `(X, confirmed)` is also valid for items announced atomically (typically champion / runner-up).
- A confirmed value MAY be corrected to a new value via Slice 006 (admin override), which produces an audit row and triggers a new scoring run.

**Relationships**.
- N:1 → `tournaments`.
- N:1 → `teams` / `players`.

---

### 4. Leaderboard Entry (derived VIEW, not a table)

**Purpose**. The ranked, tie-broken global leaderboard. Materialized at read time from `score_records` filtered by `current_calculation_version`.

| Attribute | Type | Source |
|---|---|---|
| `participant_id` | UUID | `participants.id` |
| `display_name` | text | `participants.display_name`, OR `'Participant ' || rank::text` if `tournament_config.leaderboard_visibility='anonymized'` |
| `total_points` | int | `SUM(score_records.points)` per participant |
| `exact_count` | int | `SUM(CASE WHEN reason_code='exact' THEN 1 ELSE 0 END)` |
| `outcome_count` | int | `SUM(CASE WHEN reason_code='outcome' THEN 1 ELSE 0 END)` |
| `final_points` | int | `SUM(CASE WHEN target_kind='final' THEN points ELSE 0 END)` |
| `last_valid_prediction_at` | timestamptz | MAX over `predictions.submitted_at` for that participant (used only if tier 5 enabled per FR-005) |
| `rank` | int | `RANK() OVER (ORDER BY total_points DESC, exact_count DESC, outcome_count DESC, final_points DESC [, last_valid_prediction_at ASC])` |
| `calculation_version` | int | `tournament_config.current_calculation_version` (constant per read) |

**Notes**.
- This is a logical view, NOT a snapshot table. Storage is in `score_records`; the view is recomputed per read.
- For ~500 participants and ~54k underlying rows, a `GROUP BY participant_id` + window function runs in well under one second on a managed Postgres of modest size.
- All eligible participants (per Slice 001's eligibility predicate) appear in the view, including those who scored 0 (Acceptance Scenario US3 edge: "before any matches have finished, all tied at 0").

---

### 5a. Peer Pick (derived VIEW, not a table)

**Purpose**. Expose one eligible participant's match-pick to another eligible participant — but ONLY after the relevant match's prediction lock has passed per trusted server time (FR-016, BR-LOCK-002). The view replaces any participant-tier visibility check at the API or UI layer (Constitution Principle III).

| Attribute | Type | Source |
|---|---|---|
| `match_id` | UUID | `matches.id` |
| `participant_id` | UUID | `predictions.participant_id` — the picker, never the caller (filtered by `participant_id <> auth.uid()`) |
| `display_name` | text | masked per `tournament_config.leaderboard_visibility` |
| `predicted_home` | int or NULL | `predictions.predicted_home`; NULL when the participant had no valid prediction or was admin-invalidated |
| `predicted_away` | int or NULL | same |
| `submitted_at` | timestamptz or NULL | `predictions.submitted_at`; NULL on invalidated rows |

**Lock predicate** (server-side, in the view definition, not in app code):
`now() >= matches.kickoff_utc - (config_value('lock_window_minutes')::int || ' minutes')::interval`

**Notes**.
- Admin-invalidated picks return `NULL` for `predicted_*` and `submitted_at` so non-admin peers cannot infer that an admin override occurred.
- View is `SECURITY INVOKER` (PostgreSQL 15+); RLS on `predictions` is honored automatically; the additional self-exclusion (`participant_id <> auth.uid()`) lives in the view body.

---

### 5b. Peer Final Pick (derived VIEW, not a table)

**Purpose**. Expose one eligible participant's final-tournament-pick set to another eligible participant — but ONLY after the first match has kicked off (FR-016, BR-LOCK-005). Mirror of `peer_pick_v` for the four-item final-prediction set rather than for a single match.

| Attribute | Type | Source |
|---|---|---|
| `participant_id` | UUID | `final_predictions.participant_id` — the picker, never the caller (filtered by `participant_id <> auth.uid()`) |
| `display_name` | text | masked per `tournament_config.leaderboard_visibility` |
| `champion_team_id` | UUID or NULL | `final_predictions.champion_team_id`; NULL on admin-invalidated rows |
| `runner_up_team_id` | UUID or NULL | same |
| `top_scorer_player_id` | UUID or NULL | same |
| `best_player_player_id` | UUID or NULL | same |
| `submitted_at` | timestamptz or NULL | |

**Lock predicate** (server-side, in the view definition):
`now() >= (SELECT (value #>> '{}')::timestamptz FROM tournament_config WHERE key = 'first_kickoff_utc')`

**Notes**.
- Returns at most one row per peer participant (a participant has exactly one final-prediction set).
- The `first_kickoff_utc` value is owned by Slice 002 / Slice 008 (configurable) — this view treats it as input.
- Admin-invalidated finals (Slice 006) → all four FK columns NULL, mirroring `peer_pick_v`'s admin-invalidated behavior.

---

### 5. Personal Breakdown (derived VIEW, not a table)

**Purpose**. The per-participant decomposition of points, with per-match and per-final-item rows. Slice 005 owns this; Slice 006 admin views may extend it.

| Attribute | Type | Source |
|---|---|---|
| `participant_id` | UUID | filter |
| `target_kind` | enum | `match` or `final` |
| `target_id` | UUID | matches(id) or final-item id |
| `target_label` | text | `'<Home> vs <Away> · <Stage>'` for matches; `'Champion'`/`'Runner-up'`/`'Top Scorer'`/`'Best Player'` for finals |
| `predicted_display` | text | `'<H>-<A>'` for matches; team or player name for finals |
| `official_display` | text or NULL | `'<H>-<A>'` for matches; team or player name for finals; NULL if status is `pending` |
| `points` | int | from `score_records.points` |
| `reason_code` | enum | from `score_records.reason_code` |
| `calculation_version` | int | filter (always `current_calculation_version`) |

**Notes**. Returns one row per match the participant *could have predicted* (i.e., every finished match in the tournament) — including matches where the participant had no valid prediction (Acceptance Scenario US1.4: 0 points + `reason_code='none'`). The view LEFT JOINs `score_records` against the cartesian of `participants × finished_matches`, defaulting `points=0, reason_code='none'` where no record exists. (Implementation note in `contracts/personal-breakdown.read.md`.)

---

### 6. Tie-breaker Configuration (configuration reference, not a new entity)

**Purpose**. Documents the configuration keys this slice consumes from `tournament_config` (owned by Slice 008). No new table — these are rows in `tournament_config(key, value, updated_at, updated_by)`.

| Config key | Default | Spec anchor |
|---|---|---|
| `tiebreaker.order` | `['total','exact_count','outcome_count','final_points']` | §7.4, FR-004 |
| `tiebreaker.tier5_enabled` | `false` | §7.4 (optional tier 5), FR-005 |
| `tiebreaker.rank_function` | `'rank'` (vs. `'dense_rank'`) | §7.4 + R-004 deferral note |
| `match_points.exact` | `10` | §7.2, FR-015 |
| `match_points.outcome` | `5` | §7.2, FR-015 |
| `match_points.incorrect` | `0` | §7.2, FR-015 |
| `final_points.each_item` | `20` | §7.3, FR-015 |
| `knockout_score_basis` | `'reg_plus_extra'` | OD-002, FR-008 |
| `top_scorer_source` | `'fifa_golden_boot'` | OD-004, FR-009 |
| `best_player_source` | `'fifa_golden_ball'` | OD-005, FR-010 |
| `leaderboard_visibility` | `'full_names'` | OD-006, FR-014 |
| `current_calculation_version` | `0` (bumps on each successful run) | R-003 |
| `first_kickoff_utc` | (canonical 2026 World Cup opening match UTC timestamp) | FR-010, FR-016 final-tournament variant — used by `peer_final_pick_v`'s lock predicate |
| `recalc_latency_target_minutes` | `1` | FR-011, SC-005 — informational target surfaced for perf gates |

Changes to `match_points.*`, `final_points.each_item`, or `tiebreaker.order` MUST trigger a `config_change` `score_calculation_runs` row and a full re-score per FR-015.

---

## Entities consumed read-only (owned by other slices)

| Entity | Owner slice | What we read |
|---|---|---|
| `participants` | 001 | `id, display_name, eligibility status, email_domain` (for RLS predicate reuse) |
| `matches` | 002 | `id, kickoff_utc, status, home_team_id, away_team_id, stage, group` |
| `match_results` | 002 | `match_id, home_score_for_scoring, away_score_for_scoring, source, approved_at` (R-006) |
| `predictions` | 003 | `participant_id, match_id, predicted_home, predicted_away, submitted_at, is_active` |
| `final_predictions` | 004 | `participant_id, champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id, submitted_at` |
| `teams`, `players` | 002 | identity-only (id, name) for `personal_breakdown_v.official_display` |
| `tournament_config` | 008 | the keys listed in §6 above (seeded by this slice's migration 0058 if Slice 008 has not shipped) |
| `audit_log` | 007 | write-only via trigger; no read in this slice |

---

## Indexes and access patterns

| Read pattern | Index | Rationale |
|---|---|---|
| Leaderboard: `SELECT … FROM score_records WHERE calculation_version = ? GROUP BY participant_id` | `(calculation_version, participant_id)` | covers the leaderboard view recomputation in one B-tree scan |
| Personal breakdown: `SELECT … FROM score_records WHERE participant_id = ? AND calculation_version = ?` | `(participant_id, calculation_version, target_kind)` | covers the breakdown view; supports US4 SC-004 (<3 s) |
| Audit lookup: `SELECT … FROM score_records WHERE target_kind='match' AND target_id=?` | `(target_kind, target_id, calculation_version)` | for admin investigation of a single match's scoring history |
| Peer-pick: `SELECT … FROM peer_pick_v WHERE match_id = ?` | inherited from `predictions(match_id, participant_id)` + `matches(id)` PK | the view is a join; no new index needed |

---

## RLS posture summary

| Object | Read | Write |
|---|---|---|
| `score_records` | eligible Nortal participant (Slice 001 predicate) — but only their own rows for non-admin; full read for admins | service_role only (via Edge Function → SQL functions) |
| `score_calculation_runs` | admins only | service_role only |
| `tournament_award` | eligible Nortal participant (read for self-breakdown) + admins (full) | admins (Slice 006) |
| `leaderboard_v` | eligible Nortal participant | n/a (view) |
| `personal_breakdown_v` | eligible Nortal participant, filtered to `participant_id = auth.uid()` | n/a (view) |
| `peer_pick_v` | eligible Nortal participant, filtered by `now() >= matches.kickoff_utc - lock_window` AND `participant_id <> auth.uid()` (self-exclusion) | n/a (view) |
| `peer_final_pick_v` | eligible Nortal participant, filtered by `now() >= first_kickoff_utc` AND `participant_id <> auth.uid()` (self-exclusion) | n/a (view) |

The full RLS policies are defined in migration `0057_score_rls.sql` (see `plan.md`).

---

## Constitution alignment summary

- **Principle I (Technology Neutrality)**: capabilities and field semantics described above; product names quarantined to `plan.md`.
- **Principle III (Rules Outside the UI)**: scoring math lives in `score_match`/`score_finals`; ranking lives in `leaderboard_v`; peer-pick gate lives in `peer_pick_v`. UI calls these.
- **Principle V (Auditability)**: append-only `score_records` + same-transaction `audit_log` trigger + `score_calculation_runs` ledger.
- **Principle VI (Time-Zone Correctness)**: all timestamps `timestamptz`, all comparisons use Postgres `now()`.
- **Principle VII (Operational Resilience)**: `calculation_version` flip-the-pointer pattern guarantees readers never see partial state.
- **Principle VIII (Extensibility & Configuration)**: every rule-shaped constant is a `tournament_config` row, not a code constant.
