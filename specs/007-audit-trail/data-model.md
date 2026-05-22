# Phase 1 Data Model: Audit Trail

**Feature**: 007-audit-trail
**Date**: 2026-05-17
**Status**: Draft (Phase 1 output)
**Vendor-neutral**: Capability terms (Principle I).

## Cross-slice ownership map

| Artifact | Owner / Producer slice | This slice's responsibility |
|---|---|---|
| `public.audit_log` table base shape | Slice 001 (stub) | Add `sequence_id bigserial` column; REVOKE UPDATE/DELETE; finalize indexes |
| `audit_log.source_citation` column | Slice 006 (added) | Preserve (locked) |
| Per-slice INSERT policies on `audit_log` | Slices 001 / 003 / 006 | Preserve all existing policies |
| `audit_log` writers (triggers + SECURITY DEFINER functions) | Slices 001 / 002 / 003 / 004 / 005 / 006 | Read-only consumer; never modify producers |
| Action label catalog | Slices 001–006 emit | Freeze the namespace; document the catalog |
| `audit_search(...)` SECURITY DEFINER RPC | **007 (this slice)** | Create |
| `count_audit_search(...)` SECURITY DEFINER RPC | **007 (this slice)** | Create |
| `GET /api/admin/audit/export` CSV streaming endpoint | **007 (this slice)** | Create |
| `tournament_config.audit.retention.*` keys | **007 (this slice seeds)** | Slice 008 admin UI later |
| `tournament_config.notifications.audit_failure_webhook_url` | **007 (this slice seeds NULL)** | Slice 008 admin UI later |
| Operational runbook for audit-failure alerts | **007 (this slice documents)** | Slice 008 hooks up actual webhook delivery |
| `is_admin(uuid)` real body | Slice 006 | Read-only consumer (gates `audit_search`) |
| `tournament_config` table | Slice 008 (Slice 001 stubs) | Seed audit-related keys |

After this slice ships, the audit infrastructure is **locked**. Slice 008 may add columns / config keys; cannot alter or drop existing.

## Entities

### 1. Audit Event (the final consolidated `audit_log` table shape)

**Purpose**. One row per state-changing action, append-only.

Final consolidated schema (after Slice 001 stub + Slice 006's `source_citation` additive + this slice's `sequence_id` additive):

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | Identifier; useful for direct linkage (e.g., `score_calculation_runs.triggering_audit_log_id` from Slice 006) |
| **`sequence_id`** | bigserial | **NOT NULL, UNIQUE** | **NEW in this slice.** Postgres SEQUENCE; monotonic-incrementing. Per-target ordering uses `ORDER BY sequence_id`. |
| `actor` | UUID | NULL allowed | `participants.id` of the actor; NULL for system events (e.g., scheduled sync) |
| `action` | text | NOT NULL | One of the catalog labels (R-009) |
| `entity_type` | text | NULL allowed | E.g., `participant`, `match`, `prediction`, `final_prediction`, `score_record`, `tournament_award`, `match_result`, `auth_attempt`, `admin_role`, `score_calculation_run`, etc. |
| `entity_id` | UUID | NULL allowed | Row id within the entity_type |
| `previous_value` | jsonb | NULL allowed | OLD row (or relevant fields) — for state-change events |
| `new_value` | jsonb | NULL allowed | NEW row (or relevant fields) |
| `reason` | text | NULL allowed | Free-text reason; required for admin RPCs (FR-002 of Slice 006) |
| `source_citation` | text | NULL allowed | URL/document reference; required for admin RPCs (Slice 006 additive column) |
| `source` | text | NOT NULL | One of `auth_hook`, `trigger`, `rls`, `api_guard`, `admin_rpc`, `ui`, `system` |
| `occurred_at` | timestamptz | NOT NULL, server-default `now()` | Single authoritative clock |

**Validation rules** (preserved from prior slices):
- CHECK: `source IN ('auth_hook', 'trigger', 'rls', 'api_guard', 'admin_rpc', 'ui', 'system')`.
- For `action='admin.*'` rows: `reason IS NOT NULL` is enforced by the admin RPCs at the SP-body level (Slice 006).

**State transitions**.
- INSERT only. UPDATE and DELETE revoked at the DB level by this slice (R-001).

**Relationships**.
- N:1 → `participants` (via `actor`).
- N:1 → various tables (via `entity_type` + `entity_id`).
- 1:N from `score_calculation_runs.triggering_audit_log_id` (Slice 006's additive column).

**Indexes** (final, consolidated):

| Index | Columns | Owner slice |
|---|---|---|
| `audit_log_pkey` | `(id)` PK | Slice 001 |
| `audit_log_sequence_id_uk` | `(sequence_id)` UNIQUE | **This slice** (implicit via bigserial) |
| `audit_log_occurred_at_idx` | `(occurred_at DESC)` | Slice 001 |
| `audit_log_action_occurred_idx` | `(action, occurred_at DESC)` | Slice 001 |
| `audit_log_actor_occurred_idx` | `(actor, occurred_at DESC) WHERE actor IS NOT NULL` | **This slice** (new) |
| `audit_log_target_idx` | `(entity_type, entity_id, sequence_id ASC) WHERE entity_id IS NOT NULL` | **This slice** (new) |
| `audit_log_source_occurred_idx` | `(source, occurred_at DESC)` | **This slice** (new) |

**Privilege posture** (final, after this slice's REVOKE):

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `authenticated` | per RLS (narrow per-action policies from Slices 001/003/006) | per RLS | **REVOKED** | **REVOKED** |
| `anon` | per RLS | per RLS | **REVOKED** | **REVOKED** |
| `service_role` | yes | yes (used by triggers + SECURITY DEFINER functions) | **REVOKED** | **REVOKED** |
| `postgres` (platform owner) | yes | yes | yes (operational) | yes (operational — out-of-scope for app logic) |

The narrow RLS policies (Slice 001's audit-row INSERTs from auth-hook; Slice 003's `access.denied` INSERT for participant clients; Slice 006's `admin.access_denied` INSERT for the requireAdmin guard) all continue to function — they grant INSERT, not UPDATE/DELETE.

**Audit posture (recursive)**.
- This table IS the audit. No "audit-the-audit" — would be infinite recursion.
- Attempts to UPDATE or DELETE that hit the REVOKE wall return `insufficient_privilege` errors. The route handler / RPC layer captures these as 403 / 500.

---

### 2. Audit Search Query (admin-side request shape; not a stored entity)

**Purpose**. Per FR-005. Describes the parameter shape consumed by `audit_search(...)` RPC.

| Attribute | Type | Notes |
|---|---|---|
| `actor` | uuid (optional) | Filter by actor |
| `entity_type` | text (optional) | Filter by target kind |
| `entity_id` | uuid (optional) | Filter by target id |
| `action_pattern` | text (optional) | LIKE pattern, e.g., `'admin.%'` or `'prediction.created'` |
| `source` | text (optional) | Filter by source |
| `from`, `to` | timestamptz (optional) | Date range |
| `limit`, `offset` | int (defaults 50, 0) | Pagination |

Returns a result set of audit_log rows ordered by `sequence_id ASC`.

---

### 3. Audit Retention Policy (configuration reference)

**Purpose**. Per FR-007. Configuration only; the policy is read but not enforced by this slice (archival deferred per R-003).

| `tournament_config` key | Default | Notes |
|---|---|---|
| `audit.retention.tournament_end_buffer_months` | `12` | How long past tournament end to retain |
| `audit.retention.policy_kind` | `"keep"` | One of `"keep"`, `"archive"`, `"purge"`. Default: keep forever. |
| `notifications.audit_failure_webhook_url` | `null::jsonb` | Optional webhook for audit-write-failure alerts; Slice 008 admin UI sets |

This slice seeds defaults; Slice 008 admin UI mutates.

---

## Action label catalog (final, frozen at end of this slice)

The complete catalog of `audit_log.action` values produced across slices 001–006:

| Action label | Producer slice | Trigger / writer |
|---|---|---|
| `access.granted`, `access.denied` | 001, 003, 006 | Auth hook + RLS + API guards |
| `participant.created`, `participant.updated`, `participant.email_drift` | 001 | Auth hook + trigger |
| `match.created`, `match.updated`, `match.deleted`, `match.status_changed`, `match.conflict_quarantined`, `match.conflict_resolved` | 002 | Trigger + sync coordinator + admin RPC |
| `match_result.recorded`, `match_result.corrected` | 002 | Trigger + admin RPC |
| `team.created`, `team.updated`, `team.deleted` | 002 | Trigger |
| `provider.sync_no_changes`, `provider.outage_alert_emitted`, `provider.recovered` | 002 | Sync coordinator |
| `prediction.created`, `prediction.superseded`, `prediction.rejected_locked`, `prediction.rejected_invalid_score`, `prediction.rejected_invalid_match`, `prediction.rejected_ineligible`, `prediction.kickoff_correction_crossed_lock` | 003 | Trigger + SP body |
| `final_prediction.created`, `final_prediction.superseded`, `final_prediction.rejected_locked`, `final_prediction.rejected_invalid_target`, `final_prediction.rejected_invalid_input`, `final_prediction.rejected_ineligible`, `final_prediction.rejected_identical_champion_runner_up`, `final_prediction.target_player_removed`, `final_prediction.first_kickoff_corrected` | 004 | Trigger + SP body + players-remove fan-out |
| `tournament.first_kickoff_corrected` | 002 / 004 | tournament_config-update fan-out trigger |
| `player.created`, `player.updated`, `player.removed` | 004 | Sync coordinator |
| `score_record.insert`, `score_record.update`, `score_record.delete` | 005 | Trigger |
| `tournament_award.set`, `tournament_award.confirmed`, `tournament_award.changed` | 005 | Trigger |
| `admin.match_result_corrected`, `admin.match_updated`, `admin.prediction_submitted`, `admin.final_prediction_submitted`, `admin.award_updated`, `admin.pending_review_resolved`, `admin.recalc_triggered`, `admin.role_granted`, `admin.role_revoked`, `admin.access_denied` | 006 | Admin RPC bodies + audit triggers on admin_roles |
| `admin.audit_export` | **007 (this slice)** | CSV export of audit_log results by admin (T021 route handler) |
| `score_trigger.self_scan_resumed_runs` | 005 / 006 | Edge Function self-scan (Slice 006 T024 extension) |
| `tournament_config.*` (per-key prefix, e.g., `tournament_config.scoring.match_points.exact`) | 008 (future) | Will be added by Slice 008's config-change audit trigger |

This catalog is **frozen** at slice close. Slice 008 may add new `tournament_config.*` labels following the established prefix pattern; future slices may add new labels with new prefixes via documented extension. Renaming an existing label is **breaking** and requires coordinated regression updates across consuming queries / admin UI dropdowns.

---

## RLS posture summary (final)

Already enforced by prior slices; this slice changes nothing in RLS — only DB privileges (R-001).

| Policy | Type | Predicate | Owner |
|---|---|---|---|
| `participant_access_denied_self_insert` | INSERT | narrow scope to participant's own access-denied audit | Slice 001 |
| `audit_log_admin_access_denied_insert` | INSERT | narrow scope to caller's own admin.access_denied | Slice 006 |
| `audit_log_admin_read` (implicit via `audit_search` SECURITY DEFINER) | SELECT | gated by `is_admin(auth.uid())` at SP body | This slice (RPC-only access path) |
| (no UPDATE / DELETE policies) | — | REVOKED at DB level | This slice |

---

## Capability contracts owned / locked by this slice

1. **`audit_log` final shape**: id + sequence_id + actor + action + entity_type + entity_id + previous_value + new_value + reason + source_citation + source + occurred_at. Slice 008 may add columns; cannot alter/drop these.
2. **`audit_log` tamper-resistance**: REVOKE UPDATE, DELETE locked from `authenticated`, `anon`, `service_role`. No future slice may re-GRANT.
3. **`audit_log.sequence_id` monotonic invariant**: bigserial guarantees per-row monotonic increment globally.
4. **`audit_search(uuid, text, uuid, text, text, timestamptz, timestamptz, int, int)` RPC signature** + ERRCODE WAT01–WAT03.
5. **`GET /api/admin/audit/export` CSV response shape** + column order.
6. **Action label catalog** (frozen at this slice).

## Open questions deferred

| Question | Owner | This slice |
|---|---|---|
| Archival mechanism for expired audit rows | Slice 008 / future ops | Config keys ship here |
| Audit-failure webhook delivery | Slice 008 + operations | Config key + runbook here |
| Personal-data deletion requests | Privacy policy | Out of scope (spec assumption) |
| Real-time audit Realtime subscriptions | future | Not in this slice |
