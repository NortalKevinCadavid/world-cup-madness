# Phase 1 Data Model: Match Catalog & Provider Sync

**Feature**: 002-match-catalog
**Date**: 2026-05-15
**Status**: Draft (Phase 1 output)
**Vendor-neutral**: This document describes capabilities and entities (Principle I). Concrete Supabase/Postgres/Deno details live in `plan.md` § Source Code and in `contracts/`.

## Cross-slice ownership map

This slice **owns** five new tables (`teams`, `matches`, `match_results`, `provider_sync_runs`, `provider_sync_state`, `match_pending_review`, `match_provider_external_ids`) and one new TypeScript interface (`MatchDataProviderAdapter`). It **reads** `participants` and `tournament_config` (owned by Slices 001 + 008) and **writes** to `audit_log` (Slice 007).

| Artifact | Owner slice | This slice's responsibility |
|---|---|---|
| `public.teams` | **002 (this slice)** | Create, RLS, indexes |
| `public.matches` | **002 (this slice)** | Create, RLS, indexes |
| `public.match_results` | **002 (this slice)** | Create, RLS, indexes (with `home_score_for_scoring` column referenced by Slice 005) |
| `public.match_provider_external_ids` | **002 (this slice)** | Create, internal-only |
| `public.provider_sync_runs` | **002 (this slice)** | Create (audit ledger for sync runs) |
| `public.provider_sync_state` | **002 (this slice)** | Create (alert-dedup state per provider) |
| `public.match_pending_review` | **002 (this slice)** | Create (conflict quarantine; Slice 006 reads + resolves) |
| `MatchDataProviderAdapter` TS interface | **002 (this slice)** | Define under `supabase/functions/_shared/providers/types.ts` — locked cross-slice |
| `public.participants` | 001 | Read-only consumer (RLS predicate target) |
| `public.is_eligible_nortal_participant(uuid)` | 001 | Read-only consumer (RLS) |
| `public.is_admin(uuid)` | 001 (stubbed) / 006 (real) | Read-only consumer (RLS) |
| `public.tournament_config` | 008 (Slice 001 stubs) | Read-only consumer; this slice extends seed values |
| `public.audit_log` | 007 (Slice 001 stubs) | Write-only consumer for `sync.*` and `match.*` actions |

The `matches` / `match_results` / `teams` table shapes and the `MatchDataProviderAdapter` interface are **locked** by this slice as cross-slice contracts. Slices 003–008 build on them.

## Entities introduced by this slice

### 1. Team

**Purpose**. A participating national team — display + identity record used by `matches` (home/away), Slice 004 final-prediction `champion_team_id` / `runner_up_team_id`, and Slice 005 `tournament_award`.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | Internal stable identifier |
| `name` | text | NOT NULL | E.g., "Argentina" |
| `short_code` | text | NOT NULL, UNIQUE | E.g., "ARG" — FIFA three-letter code |
| `flag_url` | text | NULL allowed | Optional CDN flag URL for display |
| `created_at` | timestamptz | NOT NULL, server-default `now()` | |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | Trigger-maintained |

**Validation rules**.
- `length(trim(name)) > 0`.
- `short_code` matches `^[A-Z]{3}$` (CHECK).

**Indexes**.

| Index | Columns | Purpose |
|---|---|---|
| `teams_short_code_uk` | `(short_code)` UNIQUE | Adapter UPSERT lookup; participant-facing display joins |

**Audit posture**. INSERTs and UPDATEs flow through the sync coordinator (R-001/R-002). Audit row format: `action='team.created' / 'team.updated'`, `source='sync'`. No direct INSERT/UPDATE from participant or admin clients (admin overrides come later via Slice 006).

---

### 2. Match (catalog row)

**Purpose**. A single tournament fixture. The catalog row that every other slice references. Always exists once the provider has reported the fixture, regardless of whether the match has been played.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | Internal stable identifier — the cross-slice FK target |
| `home_team_id` | UUID | NOT NULL, FK → `teams(id)` | |
| `away_team_id` | UUID | NOT NULL, FK → `teams(id)`, CHECK `home_team_id <> away_team_id` | |
| `stage` | enum | NOT NULL | One of `group`, `r16`, `qf`, `sf`, `final`, `third_place` |
| `group_id` | text | NULL when `stage <> 'group'`, NOT NULL otherwise | E.g., `'A'`…`'L'`; CHECK `(stage = 'group') = (group_id IS NOT NULL)` |
| `kickoff_utc` | timestamptz | NOT NULL | Canonical UTC kickoff time. The lock-decision input for Slice 003 |
| `venue` | text | NULL allowed | E.g., "MetLife Stadium" |
| `status` | enum | NOT NULL, default `scheduled` | `scheduled` / `in_progress` / `finished` / `postponed` / `cancelled` |
| `last_synced_at` | timestamptz | NOT NULL, server-default `now()` | Updated by every sync that touches the row |
| `created_at` | timestamptz | NOT NULL, server-default `now()` | |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | Trigger-maintained |

**Validation rules**.
- `kickoff_utc IS NOT NULL`.
- Allowed status transitions enforced by trigger: `scheduled → in_progress | postponed | cancelled`; `in_progress → finished | postponed | cancelled`; `postponed → scheduled | cancelled`; `cancelled → (terminal)`; `finished → (terminal except via admin override in Slice 006)`. Backward transitions in normal sync paths fall into the conflict-quarantine path (R-005).

**State transitions**. See validation rules above. Slice 003 reads `status` and `kickoff_utc` for lock decisions. Slice 005 reads `status='finished'` as the trigger for `score-trigger` invocation (per Slice 005 tasks.md T042's auto-trigger).

**Relationships**.
- N:1 → `teams` twice (home + away).
- 1:0..1 → `match_results` (results row exists only post-match).
- 1:N → `match_provider_external_ids` (one provider mapping per provider).
- 1:N → `match_pending_review` (zero or more open conflicts).

**Indexes and access patterns**.

| Index | Columns | Purpose |
|---|---|---|
| `matches_kickoff_utc_idx` | `(kickoff_utc)` | Date-window filter on `/api/matches`; Slice 003's lock-window query |
| `matches_stage_group_idx` | `(stage, group_id)` | Group-stage filter on `/api/matches` |
| `matches_status_kickoff_idx` | `(status, kickoff_utc)` | Live-window / upcoming filter |
| `matches_home_team_idx` | `(home_team_id, kickoff_utc DESC)` | Team-page filter |
| `matches_away_team_idx` | `(away_team_id, kickoff_utc DESC)` | Team-page filter |

**Audit posture**. `AFTER INSERT OR UPDATE` trigger writes to `audit_log` with `action='match.created' / 'match.updated' / 'match.status_changed'`, `source='sync'` (or `'admin'` once Slice 006 introduces the admin path). Same `pg_trigger_depth() = 1` recursion guard as Slice 001's `participants` trigger.

---

### 3. Match Result (post-match data)

**Purpose**. The official + for-scoring scores for a finished match. INSERTed when the match transitions to `status='finished'`. Slice 005's scoring engine reads `home_score_for_scoring` / `away_score_for_scoring` exclusively (per Slice 005 data-model.md § Entity 1 footnote).

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `match_id` | UUID | PK, FK → `matches(id)` ON DELETE RESTRICT | One result row per match |
| `home_score_official` | int | NOT NULL, ≥ 0 | The published score (incl. shootouts where applicable). Display-only. |
| `away_score_official` | int | NOT NULL, ≥ 0 | Same |
| `home_score_for_scoring` | int | NOT NULL, ≥ 0 | The score Slice 005's prediction-points engine consumes. Regulation + extra time, excluding penalty shootouts per OD-002 resolution (Slice 005 Clarifications 2026-05-15). |
| `away_score_for_scoring` | int | NOT NULL, ≥ 0 | Same |
| `result_status` | enum | NOT NULL | `regulation` / `extra_time` / `penalties_shootout`. Tells the UI how to render the score and tells the scoring engine that `_official` may differ from `_for_scoring`. |
| `source` | enum | NOT NULL | `sync` / `admin_correction` (Slice 006) |
| `approved_at` | timestamptz | NOT NULL, server-default `now()` | When the result was confirmed for scoring use |
| `approved_by` | UUID | NULL for `source='sync'`; NOT NULL for `source='admin_correction'`, FK → `participants(id)` | Audit-trail attribution |
| `created_at` | timestamptz | NOT NULL, server-default `now()` | |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | Trigger-maintained |

**Validation rules**.
- `home_score_for_scoring ≤ home_score_official` AND `away_score_for_scoring ≤ away_score_official` (the for-scoring value can never exceed the official value).
- When `result_status='penalties_shootout'`: `home_score_for_scoring = away_score_for_scoring` (the match was level after extra time, hence the shootout) AND `(home_score_official > away_score_official) <> (away_score_official > home_score_official)` (a shootout produces a winner). CHECK enforced.
- `source='admin_correction'` requires `approved_by IS NOT NULL`.
- INSERT only when the parent `matches.status = 'finished'`; trigger enforces.

**State transitions**. Append-only by convention; UPDATEs only via Slice 006 admin correction (which writes a new row with `source='admin_correction'` — see Slice 006's data model when it ships). Slice 005's `score_match` reads the most-recent row by `approved_at`.

**Relationships**.
- 1:1 → `matches`.
- 1:N → `audit_log` rows (every INSERT/UPDATE emits one).

**Indexes and access patterns**.

| Index | Columns | Purpose |
|---|---|---|
| `match_results_pkey` | `(match_id)` PRIMARY KEY | Single-row lookup by match |
| `match_results_approved_at_idx` | `(approved_at DESC)` | Slice 005's scoring run picks "results approved since last scoring" |

**Audit posture**. `AFTER INSERT OR UPDATE` trigger writes `audit_log` row with `action='match_result.recorded' / 'match_result.corrected'`. The audit row's `new_value` includes both `_official` and `_for_scoring` columns so disputes can be resolved from history alone.

---

### 4. Match Provider External IDs (mapping)

**Purpose**. Maps internal `match_id` to one or more provider-specific identifiers (R-003). Internal-only — never exposed to participant clients.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `match_id` | UUID | NOT NULL, FK → `matches(id)` ON DELETE CASCADE | |
| `provider_name` | text | NOT NULL | e.g., `'footballdata'` |
| `provider_match_id` | text | NOT NULL | The provider's native identifier |
| `mapped_at` | timestamptz | NOT NULL, server-default `now()` | |

**Unique constraint**. `(provider_name, provider_match_id)` UNIQUE — the sync coordinator's idempotency key.

**Indexes**.

| Index | Columns | Purpose |
|---|---|---|
| `match_provider_external_ids_provider_uk` | `(provider_name, provider_match_id)` UNIQUE | Sync coordinator UPSERT lookup |
| `match_provider_external_ids_match_idx` | `(match_id)` | Reverse lookup (admin debug) |

**Audit posture**. No audit (these rows are internal plumbing, not business state). Recreating them on `match_id` delete is fine; the parent `matches` row's audit captures the lifecycle.

A parallel table `team_provider_external_ids` follows the same shape for `teams` (omitted from this section for brevity; same shape, same constraints).

---

### 5. Provider Sync Run (audit ledger)

**Purpose**. One row per sync invocation. Records what was attempted, when, by whom (which provider), and what changed. Slice 007 hardens retention; Slice 006's admin UI surfaces recent runs.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `provider_name` | text | NOT NULL | e.g., `'footballdata'` |
| `trigger` | enum | NOT NULL | `cron` / `admin_manual` / `recovery` |
| `triggered_by` | UUID | NULL for `cron`; NOT NULL for `admin_manual`, FK → `participants(id)` | Admin attribution |
| `started_at` | timestamptz | NOT NULL, server-default `now()` | |
| `finished_at` | timestamptz | NULL until completion | |
| `outcome` | enum | NULL until completion | `success` / `success_no_changes` / `partial` / `client_error` / `exhausted_retries` / `rejected_empty` / `rejected_undersized` / `rejected_duplicate_in_payload` / `conflict_quarantined` |
| `attempts` | int | NOT NULL, default `1` | Retry counter |
| `counts` | jsonb | NULL until completion | `{ created: 0, updated: 0, unchanged: 0, rejected: 0, quarantined: 0 }` |
| `error_reason` | text | NULL | Free-form on failure (truncated to 1KB to bound storage) |
| `notes` | text | NULL | e.g., "honored Retry-After: 60s" |

**Validation rules**.
- `finished_at >= started_at` when set (CHECK).
- `outcome IS NOT NULL` requires `finished_at IS NOT NULL` and vice versa.
- `trigger='admin_manual'` requires `triggered_by IS NOT NULL`.

**State transitions**.
- INSERTed with `outcome=NULL`, `finished_at=NULL`. Updated on completion. Terminal.

**Indexes**.

| Index | Columns | Purpose |
|---|---|---|
| `provider_sync_runs_started_at_idx` | `(started_at DESC)` | Admin "recent runs" view |
| `provider_sync_runs_provider_outcome_idx` | `(provider_name, outcome, started_at DESC)` | Outage forensics |

**Audit posture**. The `provider_sync_runs` row IS the audit record for the sync invocation. The sync coordinator also writes per-affected-row `audit_log` entries (`action='match.created' / 'match.updated' / 'match.conflict_quarantined' / 'provider.outage_alert_emitted' / 'provider.recovered'`).

---

### 6. Provider Sync State (alert dedup)

**Purpose**. Holds the per-provider state needed for "exactly once per sustained outage" alert dedup (R-008).

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `provider_name` | text | PK | One row per provider |
| `last_success_at` | timestamptz | NULL allowed | Most recent successful sync |
| `first_failure_after_success_at` | timestamptz | NULL allowed | Tracks outage start |
| `outage_alerted_at` | timestamptz | NULL allowed | Tracks alert emission (NULL means "not yet alerted in this outage") |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | |

**Validation rules**.
- If `outage_alerted_at IS NOT NULL` then `first_failure_after_success_at IS NOT NULL` (CHECK — can't alert if no outage tracked).

**State transitions**.
- Set `first_failure_after_success_at = now()` on the first failure after a `last_success_at`.
- Set `outage_alerted_at = now()` on alert emission.
- Clear both on the next success; set `last_success_at = now()`.

**Indexes**. None beyond PK — the table holds at most a handful of rows.

**Audit posture**. State-machine transitions are captured indirectly via `provider_sync_runs.outcome` + the `audit_log` `provider.outage_alert_emitted` / `provider.recovered` events. The state table itself is operational, not audit.

---

### 7. Match Pending Review (conflict quarantine)

**Purpose**. When the sync coordinator detects a conflicting change it cannot auto-apply (R-005), it inserts a row here for admin resolution (Slice 006).

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `match_id` | UUID | NOT NULL, FK → `matches(id)` | |
| `provider_observation` | jsonb | NOT NULL | The provider's payload that triggered the quarantine |
| `existing_row_snapshot` | jsonb | NOT NULL | The `matches` row as it stood when the conflict was detected |
| `conflict_kind` | enum | NOT NULL | `team_assignment_changed` / `status_backward_transition` / `score_before_kickoff` / `kickoff_change_after_lock` / `unknown` |
| `observed_at` | timestamptz | NOT NULL, server-default `now()` | |
| `reviewed_at` | timestamptz | NULL until resolved | |
| `reviewer` | UUID | NULL until resolved, FK → `participants(id)` | |
| `resolution` | enum | NULL until resolved | `accept_provider` / `reject_provider` / `manual_override` |
| `resolution_notes` | text | NULL | Admin reason |

**State transitions**.
- INSERTed with all `reviewed_at` / `reviewer` / `resolution` NULL.
- UPDATEd by Slice 006's admin UI to set the review fields. Terminal.

**Indexes**.

| Index | Columns | Purpose |
|---|---|---|
| `match_pending_review_unresolved_idx` | `(observed_at DESC) WHERE reviewed_at IS NULL` | Admin "open conflicts" dashboard |
| `match_pending_review_match_idx` | `(match_id)` | Per-match conflict history |

**Audit posture**. INSERT writes `audit_log` `action='match.conflict_quarantined'`. UPDATE on resolution writes `audit_log` `action='match.conflict_resolved'` with the admin's decision. Resolution writes to `matches` happen via the audit-trail SECURITY DEFINER path; the sync coordinator never auto-resolves.

---

## RLS posture summary

| Table | Policy | Type | Predicate |
|---|---|---|---|
| `teams` | `teams_eligible_read` | SELECT | `public.is_eligible_nortal_participant(auth.uid())` |
| `teams` | (no write policies) | — | Sync coordinator writes via `SECURITY DEFINER`; admin path is Slice 006 |
| `matches` | `matches_eligible_read` | SELECT | `public.is_eligible_nortal_participant(auth.uid())` |
| `matches` | (no write policies) | — | Same as `teams` |
| `match_results` | `match_results_eligible_read` | SELECT | `public.is_eligible_nortal_participant(auth.uid())` |
| `match_results` | (no write policies) | — | Same |
| `match_provider_external_ids` | `match_provider_external_ids_admin_read` | SELECT | `public.is_admin(auth.uid())` |
| `match_provider_external_ids` | (no write policies) | — | Sync coordinator only |
| `provider_sync_runs` | `provider_sync_runs_admin_read` | SELECT | `public.is_admin(auth.uid())` |
| `provider_sync_runs` | (no write policies) | — | Sync coordinator only |
| `provider_sync_state` | `provider_sync_state_admin_read` | SELECT | `public.is_admin(auth.uid())` |
| `provider_sync_state` | (no write policies) | — | Sync coordinator only |
| `match_pending_review` | `match_pending_review_admin_read` | SELECT | `public.is_admin(auth.uid())` |
| `match_pending_review` | `match_pending_review_admin_update` | UPDATE | `public.is_admin(auth.uid())` (Slice 006 resolves) |

**Cross-slice stub note**: `is_admin(auth.uid())` is Slice 001's permissive stub (`auth.jwt() ->> 'role' = 'admin'`); Slice 006 replaces the body. Tests in this slice synthesize JWTs with `role=admin` for admin-path assertions; Slice 006 will update those tests when it replaces the function.

**Note on `participants` access**: this slice does NOT modify `participants` RLS. Slice 001 owns it.

---

## Capability contracts owned by this slice

1. **`MatchDataProviderAdapter` TypeScript interface** (locked) — every concrete adapter implements this; downstream code never imports a concrete adapter directly.
2. **`matches` table shape** (locked) — every downstream slice FKs to `matches(id)`.
3. **`match_results.home_score_for_scoring` + `away_score_for_scoring`** (locked) — Slice 005 reads these columns by name.
4. **`teams` table shape** (locked) — Slices 004 + 005 reference `teams(id)`.
5. **`provider_sync_runs` ledger shape** (locked subset) — Slice 007 may add columns; cannot alter or drop these.

These five contracts together extend the cross-slice foundation established by Slice 001. Body / column changes after this slice ships require coordinated regression updates across slices 003–008 (Constitution Principle XI).

## Open questions deferred to other slices

| Question | Owner slice | This slice's posture |
|---|---|---|
| OD-007 (actual provider selection) | future / Slice 008 | Abstraction ready; default seed uses `footballdata` placeholder |
| Real `is_admin(uid)` body | 006 | Permissive stub from Slice 001 |
| Player-roster ingest | 004 | Adapter contract includes `fetchPlayers()` placeholder; storage out of scope |
| Admin manual-result entry UI | 006 | `match_results.source='admin_correction'` reserved; UI deferred |
| Notification channels (alert webhook target) | 008 | Alert payload shape locked here; transport mechanism deferred |
| Provider fallback / failover | future | Abstraction supports it; not exercised in this slice |
