# Phase 1 Data Model: Tournament Configuration

**Feature**: 008-configuration
**Date**: 2026-05-17
**Status**: Draft (Phase 1 output)
**Vendor-neutral**: capability terms (Principle I).

## Cross-slice ownership map

| Artifact | Owner / Producer slice | This slice's responsibility |
|---|---|---|
| `tournament_config` table base shape (key, value jsonb, …) | Slice 001 (stubbed) | Preserve; seed remaining keys; finalize the configuration namespace |
| `tournament_config.first_kickoff_at_utc` key | Slice 002 / 004 | Preserve; expose in admin UI |
| `tournament_config.audit.retention.*` keys | Slice 007 (seeded NULL) | Expose in admin UI |
| `tournament_config.notifications.audit_failure_webhook_url` | Slice 007 (seeded NULL) | Expose in admin UI; **ship webhook delivery glue** |
| `tournament_config_versions` (version history log) | **This slice** | Create + populate via write triggers |
| `admin_roles` table | Slice 006 | **Read-only** (UI wrapper); call Slice 006's locked SPs |
| `is_admin(uuid)` predicate | Slice 006 | **Read-only** consumer (gates admin config RPCs) |
| `is_eligible_nortal_participant(uuid)` | Slice 001 | **Body migrated by this slice** to read from `tournament_config` |
| `is_prediction_locked(uuid)` lock window | Slice 003 | **Body migrated by this slice** to read window from config |
| `is_final_prediction_locked()` | Slice 004 | No change (driven by `first_kickoff_at_utc` key already in config) |
| `compute_match_score(...)` scoring values | Slice 005 | **Body migrated by this slice** to read 4 keys (exact / correct-outcome / incorrect / final-pick) |
| Leaderboard tie-breaker view | Slice 005 | **View definition migrated** to read tie-breaker order from config |
| `audit_log` table | Slice 007 | **Read-only consumer**; writes config-change rows under `tournament_config.<key>` action prefix |
| `audit_search`, `count_audit_search` RPCs | Slice 007 | **No change** |
| `admin_config_*` SECURITY DEFINER RPC family (new) | **This slice** | Create (`upsert`, `preview`, `rollback`, `grant_admin_role` / `revoke_admin_role` wrappers, `get_secret`, `import`, `export`) |
| `config_read(p_key, p_default)` helper | **This slice** | Create (fail-closed read pattern, R-011) |
| `pg_notify` trigger on `tournament_config` | **This slice** | Create (R-009) |
| `pg_cron` webhook-delivery job | **This slice** | Create; reads `notifications.audit_failure_webhook_url`; closes Slice 007's deferred SC-007 |

After this slice closes, the World Cup Madness data model is **fully sealed**. No further slice in the v1 roadmap.

## Entities

### 1. Configuration Setting — final consolidated `tournament_config` shape

**Purpose**. Single source of truth for every administrator-adjustable setting in the system.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `key` | text | PK | Dot-notation namespace (e.g., `eligibility.allowed_domains`, `scoring.match_points.exact`) |
| `value` | jsonb | NOT NULL | Heterogeneous: array (domains), integer (lock window), object (provider settings), bool, etc. |
| `value_type` | text | NOT NULL, CHECK in `('text','integer','number','boolean','array','object','duration_minutes','duration_seconds','timestamptz','uuid','jsonb')` | Used by validator dispatch and admin UI control rendering |
| `updated_at` | timestamptz | NOT NULL, default `now()` | Last-write timestamp |
| `updated_by` | uuid | NULL allowed | participant_id of writer; NULL for system-seeded defaults |
| `version_id` | bigint | NOT NULL | FK to `tournament_config_versions.version_id` of the row that produced this state |

**Validation rules** (enforced by `admin_config_upsert` body before write):
- `value` MUST conform to `value_type` (e.g., `value_type='integer'` requires `jsonb_typeof(value) = 'number'` and integer-valued; arrays must be jsonb arrays of expected element type).
- Per-key validators defined inline in the RPC body via a CASE on `key` (e.g., `locking.match_prediction_window_minutes` → integer > 0 and ≤ 1440).

**State transitions**. Update only (no delete in normal operation). Every UPDATE captures `previous_value` into `tournament_config_versions`.

**Relationships**.
- 1:N from `tournament_config_versions` (history).

**Indexes**:
- PK on `key`.
- Index on `updated_at DESC` for the "recently changed" admin view.

**Privilege posture (final)**:

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `authenticated` | per RLS (admin-only for secret keys, all-read for non-secret) | denied | denied (admin-only via RPC) | **REVOKED** |
| `anon` | denied | denied | denied | denied |
| `service_role` | yes | yes (via SECURITY DEFINER RPCs) | yes (via RPCs) | denied |

DELETE is REVOKED from all roles to preserve the invariant that every key has a history.

### 2. Configuration Version — `tournament_config_versions`

**Purpose**. Append-only log of every configuration write. Powers version history + rollback (User Story 5).

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `version_id` | bigserial | PK | Monotonic ordering key |
| `key` | text | NOT NULL | Mirrors `tournament_config.key` (no FK because keys may be deleted in extreme cases; the history is preserved) |
| `previous_value` | jsonb | NULL allowed | NULL for the initial seed of a new key |
| `new_value` | jsonb | NOT NULL | The applied value |
| `change_kind` | text | NOT NULL, CHECK in `('initial_seed','admin_upsert','admin_rollback','import_bulk')` | Distinguishes the write source |
| `actor` | uuid | NULL allowed | `participants.id`; NULL for system seed |
| `reason` | text | NULL allowed | Free-text justification (required for `admin_upsert` and `admin_rollback`) |
| `source_citation` | text | NULL allowed | URL/document reference; required for changes affecting scoring or eligibility |
| `audit_log_id` | uuid | NULL allowed, FK to `audit_log.id` (no cascade) | Links to the canonical audit row |
| `parent_version_id` | bigint | NULL allowed, FK to `tournament_config_versions.version_id` | Set for rollbacks (parent = the version being rolled back to) |
| `acknowledge_token_used` | uuid | NULL allowed | For affecting-data writes (R-010); NULL otherwise |
| `created_at` | timestamptz | NOT NULL, default `now()` | |

**State transitions**. INSERT only. `REVOKE UPDATE, DELETE` from all app roles (same posture as `audit_log` from Slice 007).

**Indexes**:
- PK on `version_id`.
- Index on `(key, version_id DESC)` for "history of this key" queries.
- Index on `(created_at DESC)` for the "recent changes" admin view.
- Partial index on `(change_kind, version_id DESC) WHERE change_kind = 'admin_rollback'` for rollback-event queries.

**Validation rules**:
- `previous_value IS NULL` only allowed when `change_kind = 'initial_seed'`.
- `parent_version_id IS NOT NULL` only allowed when `change_kind = 'admin_rollback'`.
- `reason IS NOT NULL` enforced for `change_kind IN ('admin_upsert', 'admin_rollback')` at the RPC body level.

**Privilege posture**: identical to `audit_log` — INSERT allowed for `service_role` (via SECURITY DEFINER RPCs); UPDATE, DELETE REVOKED.

### 3. Admin Role Assignment — `admin_roles` (Slice 006-owned; this slice references)

This slice does NOT modify `admin_roles`. The admin UI under `/admin/config/admin-roles` calls Slice 006's locked SPs (`admin_grant_admin_role`, `admin_revoke_admin_role`). For unified version history, the admin UI also writes a row to `tournament_config_versions` with `change_kind = 'admin_upsert'`, `key = 'admin_roles.<participant_id>'`, `previous_value = <previous granted/revoked state>`, `new_value = <new state>`.

This double-write is acceptable because:
1. `admin_roles` is the source-of-truth for `is_admin(uuid)` (Slice 006 contract).
2. `tournament_config_versions` is the source-of-truth for "what config changed when".

The two are linked via `audit_log_id` — both writes share a single `audit_log.action = 'admin.role_granted'` (or `admin.role_revoked`) row that Slice 006's triggers already produce.

### 4. Provider Adapter Reference (configuration-only)

Provider adapters are *registered in code* (Slice 002's adapter classes). This slice does not store adapter binaries — only their *configuration*. Each provider gets a `tournament_config` key family:

- `providers.registered.<provider_id>` → object with display name, contract version
- `providers.active` → string, one of the registered ids
- `providers.<provider_id>.retry.max_attempts` → integer
- `providers.<provider_id>.retry.backoff_seconds_base` → integer
- `providers.<provider_id>.alert.threshold_consecutive_failures` → integer
- `providers.<provider_id>.credentials.api_key` → `{secret: true, value: "<cipher_or_plain>"}` jsonb

The full registered-provider list is seeded by this slice's migration; production deployments must include at least the `football-data-org` adapter.

## Helper functions owned by this slice

### `config_read(p_key text, p_default jsonb) RETURNS jsonb STABLE`

Body:
```sql
DECLARE
  v jsonb;
BEGIN
  SELECT value INTO v FROM public.tournament_config WHERE key = p_key;
  IF v IS NULL THEN
    IF p_default IS NULL THEN
      RAISE EXCEPTION 'Configuration key % not found and no default provided', p_key
        USING ERRCODE = 'WCG06';
    END IF;
    RETURN p_default;
  END IF;
  RETURN v;
END;
```

Privilege: `GRANT EXECUTE TO authenticated, service_role;`. STABLE volatility (deterministic within a transaction; mirrors how `is_admin` is declared).

### `config_read_admin_bypass(p_key text) RETURNS jsonb STABLE SECURITY DEFINER`

Body: returns either the value OR a jsonb-encoded "expected schema" descriptor when value missing, instead of raising. Used by the admin UI in degraded mode (R-011 alternative).

Privilege: gated by `is_admin(auth.uid())`, mirrors Slice 007's `audit_search`.

## RLS posture (final, post-slice-008)

| Policy | Type | Predicate | Owner |
|---|---|---|---|
| `tournament_config_authenticated_read` | SELECT | `is_admin(auth.uid()) OR NOT key_is_secret(key)` | This slice |
| `tournament_config_no_write_direct` | INSERT/UPDATE | `false` (writes only via SECURITY DEFINER RPCs) | This slice |
| `tournament_config_versions_admin_read` | SELECT | `is_admin(auth.uid())` | This slice |
| `tournament_config_versions_no_write_direct` | INSERT/UPDATE/DELETE | `false` (writes only via SECURITY DEFINER RPCs) | This slice |

`key_is_secret(text)` helper: returns `true` when key matches `'providers.%.credentials.%'`, else `false`. Defined as IMMUTABLE for index-friendly use.

## Audit posture

Every write to `tournament_config` produces:
1. A row in `tournament_config_versions` (operational record).
2. A row in `audit_log` with `action = 'tournament_config.<key>'`, `source = 'admin_rpc'`, full previous/new value, actor, reason, source_citation (regulatory record).
3. The `audit_log_id` on the version row links 1 → 2.

The `audit_log` write is the same INSERT path Slice 007 protected — `sequence_id` auto-allocated, `source_citation` carried.

## Capability contracts owned / locked by this slice

1. `tournament_config_versions` table final shape with `bigserial version_id`.
2. The full namespace catalog (~30 keys) listed below — frozen at slice close; renames or removals are breaking and require coordinated migration.
3. `admin_config_upsert(p_key, p_value, p_expected_version_id, p_reason, p_source_citation, p_acknowledge_token)` SP signature.
4. `admin_config_preview(p_key, p_new_value)` SP signature.
5. `admin_config_rollback(p_target_version_id, p_reason, p_source_citation)` SP signature.
6. `admin_config_get_secret(p_key)` SP signature.
7. `admin_config_import(p_envelope jsonb, p_reason)` SP signature.
8. `admin_config_export()` (returns jsonb envelope) SP signature.
9. ERRCODE WCG01–WCG08 namespace.
10. `config_read(p_key, p_default)` helper signature and STABLE volatility.
11. `pg_notify` channel name `'tournament_config_changed'` and payload format (= the changed `key`).
12. Webhook envelope shape POSTed to `notifications.audit_failure_webhook_url`.
13. Import/export JSON envelope schema (`schema_version: "1.0.0"`).

## Configuration namespace catalog (FROZEN at slice close)

| Key | value_type | Default value | Consumer |
|---|---|---|---|
| `eligibility.allowed_domains` | array | `["nortal.com"]` | Slice 001 |
| `locking.match_prediction_window_minutes` | integer | `60` | Slice 003 |
| `locking.final_prediction_anchor` | text | `"first_kickoff"` | Slice 004 |
| `scoring.match_points.exact` | integer | `10` | Slice 005 |
| `scoring.match_points.correct_outcome` | integer | `5` | Slice 005 |
| `scoring.match_points.incorrect` | integer | `0` | Slice 005 |
| `scoring.final_pick_points` | integer | `20` | Slice 005 |
| `scoring.score_upper_bound` | integer | `99` | Slice 003 |
| `scoring.knockout_match_basis` | text | `"regular_time"` (blocks on OD-002) | Slice 005 |
| `scoring.top_scorer_tie_policy` | text | `"all_qualify"` (blocks on OD-004) | Slice 005 |
| `scoring.best_player_source` | text | `"official_tournament_award"` (blocks on OD-005) | Slice 005 |
| `scoring.tie_breaker_order` | array | `["points_total","exact_match_count","final_pick_correct","earliest_submission"]` | Slice 005 |
| `leaderboard.visibility_policy` | text | `"all_participants_visible"` (blocks on OD-006) | Slice 005 |
| `tournament.phase.current` | text | `"pre_tournament"` (one of `pre_tournament`, `group_stage`, `knockout`, `completed`) | global |
| `tournament.first_kickoff_at_utc` | timestamptz | NULL (set by admin pre-tournament) | Slices 002 / 004 |
| `providers.active` | text | `"football_data_org"` | Slice 002 |
| `providers.registered.football_data_org` | object | `{display_name: "football-data.org", contract_version: "v4"}` | Slice 002 |
| `providers.football_data_org.retry.max_attempts` | integer | `3` | Slice 002 |
| `providers.football_data_org.retry.backoff_seconds_base` | integer | `2` | Slice 002 |
| `providers.football_data_org.alert.threshold_consecutive_failures` | integer | `5` | Slice 002 |
| `providers.football_data_org.credentials.api_key` | object (secret) | `{secret: true, value: null}` | Slice 002 (admin sets pre-launch) |
| `audit.retention.policy_kind` | text | `"keep"` | Slice 007 (seeded; this slice exposes UI) |
| `audit.retention.tournament_end_buffer_months` | integer | `12` | Slice 007 |
| `notifications.audit_failure_webhook_url` | text | NULL | Slice 007 (seeded; this slice activates delivery) |
| `notifications.deadline_reminders.enabled` | boolean | `false` (OD-008; not implemented in v1) | future / FR-019 |

The catalog is **frozen**: adding new keys is forward-compatible (Slice 008's RPCs accept any well-formed jsonb under a known key), but removing a key (without a deprecation period) is breaking.

## Open questions deferred

| Question | Owner | This slice |
|---|---|---|
| OD-002 knockout basis | Architecture | Default seeded; live UI lets admin change pre-launch |
| OD-004 top-scorer tie policy | Architecture | Default seeded; live UI lets admin change pre-launch |
| OD-005 best player source | Architecture | Default seeded; live UI lets admin change pre-launch |
| OD-006 leaderboard visibility | Architecture | Default seeded; live UI lets admin change pre-launch |
| OD-008 notification channels | Future slice | Config keys seeded; v1 does not implement delivery for these |
| KMS-backed credential storage | Future infra slice | Out of scope; jsonb `{secret: true, value}` envelope is the v1 posture |
