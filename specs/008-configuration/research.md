# Phase 0 Research: Tournament Configuration

**Feature**: 008-configuration
**Date**: 2026-05-17
**Status**: Phase 0 complete

This research resolves all NEEDS CLARIFICATION items raised by `plan.md` Technical Context. Each decision is paired with rationale and alternatives.

This slice is the FINAL slice in the World Cup Madness product roadmap. It is also the most *cross-cutting*: it owns the configuration surface that every prior slice (001-007) reads from. Several decisions here finalize earlier stubs.

## R-001 — Storage shape: single `tournament_config` table with jsonb values

**Decision**. Continue using the single `public.tournament_config (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NULL)` table that Slice 001 stubbed and Slice 007 already extended.

**Rationale**. (a) Already in use across slices 002, 004, 006, 007 — replacing it would force coordinated migrations. (b) The Constitution's *Implementation Platform* section endorses Postgres + jsonb as the configuration surface. (c) `jsonb` lets each key carry a heterogeneous value (string, integer, array, object) without separate columns per type. (d) RLS-friendly: one policy guards the whole namespace.

**Alternatives considered**. Per-section tables (`lock_windows`, `scoring_values`, `domains`) — rejected because the proliferation of tables would force per-table RLS, per-table audit triggers, and per-table admin UI plumbing. Single typed columns (separate `int_value`, `text_value`, etc.) — rejected because jsonb already provides type flexibility without forcing schema changes for new value shapes.

## R-002 — Versioning + rollback strategy: append-only `tournament_config_versions` change log + restore RPC

**Decision**. Introduce a NEW table `public.tournament_config_versions` that records every change as an immutable row: `(version_id bigserial PK, key text, previous_value jsonb, new_value jsonb, change_kind text, actor uuid, reason text, source_citation text, audit_log_id uuid, created_at timestamptz)`. Rollback is implemented as `admin_config_rollback(p_version_id, p_reason)` SECURITY DEFINER RPC that re-applies the `previous_value` of the named version as a NEW write (new version_id, new audit_log row, never a delete). The current state of `tournament_config` remains the single read source (no replay needed for reads).

**Rationale**. (a) FR-006 mandates rollback as a *new audit event*, not a deletion. (b) Append-only log fits Principle V (Auditability). (c) Single-state read avoids the cost of replaying history on every read (which would be needed if we stored only deltas). (d) The change log doubles as the version history view for User Story 5. (e) `version_id bigserial` mirrors Slice 007's `audit_log.sequence_id` pattern for canonical ordering.

**Alternatives considered**. Snapshot every change (full `tournament_config` state per version) — rejected because storage cost grows quadratically and the per-key change log already gives time-travel via `ORDER BY version_id`. SCD-Type-2 in-table (validity ranges) — rejected because the read query for "current value of key X" becomes more complex than the simple `SELECT value FROM tournament_config WHERE key = $1`.

**Cross-slice implication**. Slice 007's `audit_log` has the action label catalog frozen with the `tournament_config.<key>` prefix reserved for this slice. Each row inserted into `tournament_config_versions` ALSO writes a row to `audit_log` with `action = 'tournament_config.<key>'` (e.g., `tournament_config.scoring.match_points.exact`), linked via `audit_log_id`. The `tournament_config_versions` row is the operational record; the `audit_log` row is the regulatory record. The two are joined via FK for investigation.

## R-003 — Concurrent-edit conflict resolution: optimistic concurrency via `expected_version_id`

**Decision**. Every write RPC takes an `p_expected_version_id bigint` parameter. The RPC body acquires `pg_advisory_xact_lock(hashtext(p_key))` to serialize writes per key, then verifies the latest `tournament_config_versions.version_id WHERE key = p_key` equals `p_expected_version_id`. If not, raise `WCG01` ("Concurrent edit; reload and retry"). The losing edit is NOT silently merged.

**Rationale**. (a) FR-010 mandates "exactly one becomes the active version, others become superseded versions in audit, no silent merge". (b) Optimistic locking with explicit error is the standard pattern for admin-UI edits where conflicts are rare. (c) Advisory xact lock prevents the read-modify-write race within a single key. (d) The losing admin sees a clear error message and a "reload" affordance in the UI.

**Alternatives considered**. Last-writer-wins — rejected (silent overwrite violates FR-010). Three-way merge — rejected (configuration values are atomic; merge semantics are undefined). Pessimistic locking via persistent row lock — rejected (would block readers and complicate the read path).

## R-004 — ERRCODE namespace: `WCG01..WCG08`

**Decision**. This slice owns SQLSTATE codes `WCG01` through `WCG08` (W = Wcm, CG = Configuration). Allocations:

| Code | Meaning |
|---|---|
| WCG01 | Concurrent edit; expected_version_id stale |
| WCG02 | Invalid configuration value (validation failure) |
| WCG03 | Unknown configuration key |
| WCG04 | Rollback target version exceeds retention horizon |
| WCG05 | Affecting-data warning unacknowledged (FR-005) |
| WCG06 | Configuration store unreachable (fail-closed signal) |
| WCG07 | Caller is not admin (mirrors WAT01 / WAR01 family) |
| WCG08 | Bulk import validation aggregate failure |

Does not collide with: `WCM01-05` (Slice 003), `WFP01-06` (Slice 004), `WAR01-06` (Slice 006), `WAT01-03` (Slice 007).

**Rationale**. Distinct prefix avoids namespace collision; ranges chosen to leave room for future codes within the prefix.

## R-005 — Admin UI structure: tabbed sections under `/admin/config/*`

**Decision**. Single landing `/admin/config` with tabbed sub-routes for each functional grouping:

- `/admin/config/domains` — approved corporate domains
- `/admin/config/scoring` — match values, final-pick value, tie-breaker order, score upper bound, knockout basis
- `/admin/config/locking` — match-prediction lock window
- `/admin/config/providers` — active provider, retry/backoff/alert thresholds, credentials (admin-read-only)
- `/admin/config/admin-roles` — admin role assignments
- `/admin/config/phases` — current tournament phase
- `/admin/config/retention` — audit retention policy + notification webhook
- `/admin/config/history` — version history + rollback affordance
- `/admin/config/import-export` — JSON import/export

Each section reads its own slice of `tournament_config` keys and writes via the RPC family.

**Rationale**. (a) Grouping by functional area matches the spec's User Story decomposition (US1 domains, US2 lock window, US3 scoring, US4 providers + roles + phases, US5 rollback). (b) Each section can be developed and tested independently per Principle X. (c) Admins do not need to learn the underlying key-naming scheme.

**Alternatives considered**. Flat key-value editor — rejected (poor UX for non-engineers; no validation context). Form-per-key with deep linking — rejected (proliferates routes without aiding workflow).

## R-006 — Approved domains storage: jsonb array under `eligibility.allowed_domains` key

**Decision**. Store the approved domain list as a single `tournament_config` row: `key = 'eligibility.allowed_domains', value = '["nortal.com","example.nortal.com"]'::jsonb`. Slice 001's `is_eligible_nortal_participant(uuid)` predicate is migrated by this slice to read from `tournament_config` instead of its current hardcoded list.

**Rationale**. (a) Avoids creating a new table just for a list. (b) Single-key updates flow through the same RPC family used for all config writes (consistent audit, versioning, validation). (c) jsonb array is efficient enough at the expected scale (10s of domains, not 10s of thousands). (d) Honors Principle VIII ("approved corporate domain list MUST be configurable per Principle VIII").

**Cross-slice migration**. Slice 008's migration includes an `ALTER FUNCTION is_eligible_nortal_participant(uuid) ...` redefinition: read the JSON array from `tournament_config WHERE key = 'eligibility.allowed_domains'`, lower-case + trim, check participant's domain membership. The predicate signature is preserved — Slice 001's tests continue to pass.

**Alternatives considered**. Separate `allowed_domains (domain text PK)` table — rejected (separate write path, separate audit triggers, separate RLS). Hardcoded list with admin-managed override list — rejected (violates Principle VIII for the canonical list itself).

## R-007 — Admin role assignments: consolidate ownership at this slice; Slice 006's `admin_roles` table preserved

**Decision**. Slice 006's `admin_roles (participant_id uuid PK, granted_by uuid, granted_at timestamptz, revoked_at timestamptz NULL)` table is the source-of-truth. This slice ships the *admin UI* for managing admin roles but does NOT rewrite the data model. The `is_admin(uuid)` predicate (Slice 006's body) is unchanged. The new admin role write RPCs in this slice (`admin_config_grant_admin_role(p_participant_id, p_reason, p_source_citation)`, `admin_config_revoke_admin_role(p_participant_id, p_reason, p_source_citation)`) call Slice 006's `admin_grant_admin_role` and `admin_revoke_admin_role` SPs verbatim. The `tournament_config_versions` log gets a row per role change for unified version history; the `audit_log` rows continue to be written by Slice 006's existing triggers (no double-write).

**Rationale**. (a) Avoid breaking Slice 006's locked contracts (`admin_grant_admin_role`, `admin_revoke_admin_role` SP signatures are frozen). (b) Admin roles ARE configuration (per spec FR-001 bullet "admin role assignments") and SHOULD be visible in the same version history view. (c) Centralizing the UI in this slice gives admins one place to administer the tournament without losing the Slice 006 separation of policy from UI.

**Alternatives considered**. Move `admin_roles` table ownership to this slice — rejected (breaks Slice 006's locked surface; net no value). Duplicate role data in `tournament_config` — rejected (dual source of truth invites drift).

## R-008 — Provider credential posture: jsonb value with `secret: true` field-level marker + admin-only RLS

**Decision**. Provider credentials live as `tournament_config` rows under the key family `providers.<provider_id>.credentials.*`. Each credential row's jsonb value carries a top-level `{"secret": true, "value": "<cipher_or_plain>"}` structure. The read RPC body redacts the `value` field for non-admin callers (returns `{"secret": true, "value": null}`) AND a separate admin-only RPC `admin_config_get_secret(p_key)` returns the actual value, writing an `admin.config_secret_accessed` audit row on every call.

**Rationale**. (a) Constitution Principle II (Security by Design) + spec FR-007. (b) The platform (Supabase Postgres) handles encryption-at-rest. (c) Field-level redaction keeps the key visible in normal config listings (so admins know it exists) without leaking the value. (d) Every secret read is audited individually, providing a forensic trail of who looked at which credential when.

**Alternatives considered**. Separate `tournament_secrets` table — rejected (different write path, harder to keep version history coherent). Application-layer encryption — rejected (Constitution's *Implementation Platform* defers encryption-at-rest to Supabase). Vault / KMS integration — out of scope for v1 (deferred to a future infrastructure slice if needed).

## R-009 — Read-path caching: in-memory LRU per Next.js process + Postgres LISTEN/NOTIFY invalidation

**Decision**. Each Next.js server process maintains a small in-memory LRU cache (`Map<key, { value: jsonb; cached_at: number }>`) for `tournament_config` reads, sized at 64 keys with a 60-second TTL. A Postgres trigger on `tournament_config` updates a `pg_notify('tournament_config_changed', NEW.key)`. Long-lived Next.js processes subscribe via a single connection's `LISTEN tournament_config_changed` and invalidate the cache on receipt. This satisfies the FR-002 "within 1 minute" target with significant read-load reduction.

For the SQL layer (Edge Functions, trigger predicates like `is_eligible_nortal_participant`), no caching — the read is a single PK lookup on `tournament_config` (indexed) which is fast enough.

**Rationale**. (a) FR-002 mandates "within 1 minute"; 60-second TTL satisfies the worst case even without LISTEN (the TTL alone is the guarantee). (b) LISTEN/NOTIFY gives near-instant propagation when available. (c) Per-process cache avoids cross-process coherence; the TTL bounds drift. (d) Edge Functions (short-lived, per-request) skip the cache entirely; their read is direct.

**Alternatives considered**. Redis cache layer — rejected (extra infrastructure, no clear need at scale). Webhook-driven invalidation — rejected (LISTEN/NOTIFY is built-in). Indefinite cache with explicit "config changed; restart pods" alert — rejected (operationally fragile).

## R-010 — Affecting-existing-data warnings: precompute + acknowledge token pattern

**Decision**. Spec FR-005 requires a "clear warning when a configuration change would affect existing data" with explicit confirmation. Implementation:

1. Admin UI initiates `admin_config_preview(p_key, p_new_value)` RPC. The body computes consequences for known-impactful keys:
   - `eligibility.allowed_domains` removal → SELECT participants whose domain is removed, count + sample 5
   - `locking.match_prediction_window_minutes` increase → SELECT matches whose `lock_at_old` is now in past but `lock_at_new` is in future (re-opens locked matches)
   - `scoring.score_upper_bound` decrease → SELECT predictions whose score exceeds the new bound
   - `scoring.match_points.*` change → SELECT count of score_records that would change on recalc
2. Response: `{ affecting: true|false, summary: text, sample: jsonb, acknowledge_token: uuid }`. The token is signed (HMAC with `pg_session_jwt_secret` equivalent) and TTL'd 5 minutes.
3. The actual write RPC takes `p_acknowledge_token uuid` parameter. If `affecting=true` but `p_acknowledge_token` is null/wrong/expired → raise `WCG05` ("Affecting-data warning unacknowledged"). If `affecting=false`, the token may be NULL.

**Rationale**. (a) Two-step (preview → confirm) gives the admin a chance to bail. (b) Token mechanism prevents the UI from suppressing the warning client-side (acknowledgment must round-trip the server). (c) Computed preview shows exactly what changes — better than a generic "are you sure?" dialog.

**Alternatives considered**. Always-warn UI dialog — rejected (client-only enforcement violates Principle II). Inline preview without token — rejected (no enforcement that admin actually saw the warning). Multi-step wizard — rejected (over-engineering for what is fundamentally a single state-change).

## R-011 — Fail-closed semantics: read-side circuit + denial audit + admin-bypass token

**Decision**. Spec FR-008 mandates fail-closed behavior. Implementation:

1. The shared SQL helper `public.config_read(p_key text, p_default jsonb)` returns `tournament_config.value` if found, else raises `WCG06` ("Configuration store unreachable for required key").
2. Every consuming slice's SECURITY DEFINER bodies that read configuration MUST use `config_read` with `p_default=NULL` for security-critical keys (`eligibility.allowed_domains`, `locking.*`, `admin_roles.*`). For non-critical keys (display-only values), the consumer MAY pass a fallback default.
3. On `WCG06` propagation:
   - Slice 001's `is_eligible_nortal_participant` → returns `false` → user is denied login (fail-closed for eligibility).
   - Slice 003's `is_prediction_locked` → returns `true` → all writes refused (fail-closed for locking).
   - Slice 002's sync coordinator → halts and writes `provider.sync_no_changes` with reason `config_unavailable`.
4. Each fail-closed event writes `system.config_unavailable` audit row.
5. An operational alert is queued for the webhook (`notifications.audit_failure_webhook_url` if non-null) — this slice ships the webhook delivery glue, satisfying the previously-deferred SC-007 from Slice 007.

**Rationale**. (a) Fail-closed is the security default (Principle II + Eligibility constraint). (b) Distinguishing critical vs. non-critical keys avoids degrading the whole app for a cosmetic config miss. (c) Forwarding to the operator alert path closes the audit-failure webhook loop that Slice 007 deferred.

**Alternatives considered**. Application-tier fallback to in-code defaults — rejected (defaults drift from the configured values silently; violates Principle VIII). Read-only mode bypass for admin — rejected (admin needs read access to config to fix the problem, so config reads must work even when fail-closed; the helper provides a separate `config_read_admin_bypass(p_key)` that allows an admin to read the *expected* schema regardless of value presence, used by the admin UI in degraded mode).

## R-012 — Import/export format: signed JSON envelope with version history

**Decision**. Export format: a single JSON file `world-cup-madness-config-<env>-<timestamp>.json` containing:

```json
{
  "schema_version": "1.0.0",
  "exported_at": "<ISO8601>",
  "exported_by": "<participant_id>",
  "environment": "<inferred from hostname>",
  "current_config": { "<key>": <value>, ... },
  "version_history": [ { version_id, key, previous_value, new_value, actor, reason, created_at }, ... ],
  "signature": "<HMAC-SHA256 of body using server-side secret>"
}
```

Import validates the signature (rejecting tampered files), validates each key against current validators, applies the full snapshot as a single transaction with a single `admin.config_imported` audit row capturing the source environment + caller + sample of changes. The version history is appended (not replaced) — imported versions get NEW version_ids local to the target environment, with `source_citation` referencing the originating environment.

**Rationale**. (a) Signed envelope deters accidental cross-environment imports. (b) Single-transaction import satisfies FR-009's "single bulk change with source identified". (c) Including version history in the export gives the target environment full historical context.

**Alternatives considered**. YAML — rejected (no native jsonb mapping; less standard for tool integration). Per-key SQL dump — rejected (loses the auditing structure). CSV — rejected (cannot represent nested values).

## R-013 — Action label catalog extension: `tournament_config.<key>` (already reserved by Slice 007)

**Decision**. Slice 007 froze the audit action label catalog with the namespace prefix `tournament_config.*` reserved for this slice. Every config write produces an `audit_log.action` row with label `tournament_config.<key>`, where `<key>` is the exact `tournament_config.key` value (dotted). Examples:

- `tournament_config.eligibility.allowed_domains`
- `tournament_config.locking.match_prediction_window_minutes`
- `tournament_config.scoring.match_points.exact`
- `tournament_config.scoring.tie_breaker_order`
- `tournament_config.providers.active`
- `tournament_config.phases.current`
- `tournament_config.audit.retention.policy_kind`

The catalog is extended at this slice's close to include the full enumerated list. Slice 007's catalog-assertion test (T008 of slice 007's tasks.md) is updated to recognize these labels.

**Rationale**. (a) Pre-reserved by Slice 007. (b) Mirroring the key in the label gives investigators direct grep-ability between audit and config. (c) Append to catalog is the documented extension path; no rename of existing labels.

## R-014 — Cross-slice consumer migration plan

This is the most operationally sensitive research item. Each consumer slice has hardcoded or stubbed values that this slice MUST migrate to `tournament_config` reads without regression.

| Consumer | Current source | Migration mechanism |
|---|---|---|
| Slice 001 `is_eligible_nortal_participant(uuid)` | Hardcoded array in function body | Replace body to read `tournament_config WHERE key='eligibility.allowed_domains'`. Same signature, same return type. Slice 001's regression tests must continue to pass on the same seed data. |
| Slice 003 `is_prediction_locked(uuid)` lock window | Hardcoded `INTERVAL '60 minutes'` | Replace body to read `tournament_config WHERE key='locking.match_prediction_window_minutes'`, cast to interval. Same signature, same STABLE volatility. |
| Slice 003 score upper bound | Hardcoded `CHECK (score >= 0 AND score <= 99)` | Add validator at SP `submit_prediction` body level using `tournament_config WHERE key='scoring.score_upper_bound'`. Keep the existing CHECK constraint as a hard backstop (defense-in-depth); update its bound to a generous maximum (e.g., 999) to avoid accidentally blocking config-allowed values. |
| Slice 005 `scoring.match_points.*` | Hardcoded `10/5/0` in `compute_match_score(...)` | Replace body to read 3 keys at once. SAME volatility, SAME signature. |
| Slice 005 `scoring.final_pick_points` | Hardcoded `20` | Same pattern. |
| Slice 005 `scoring.tie_breaker_order` | Hardcoded list in leaderboard view definition | Replace view definition to read tie-breaker order from config. View signature preserved. |
| Slice 002 active provider + thresholds | Hardcoded in Edge Function code | Read from `tournament_config WHERE key='providers.active'` and per-provider settings keys on each sync run. |
| Slice 006 `is_admin(uuid)` | Already config-aware via `admin_roles` table | No change; this slice's admin-role UI wraps Slice 006's SPs. |
| Slice 007 audit retention | Already seeded via Slice 007 with default keys | This slice ships the admin UI to mutate them. No data migration. |
| Slice 007 `notifications.audit_failure_webhook_url` | Seeded NULL by Slice 007 | This slice ships the webhook delivery glue + admin UI. |

**Migration order in this slice's migration file**:

1. Create `tournament_config_versions` table + indexes.
2. Seed `tournament_config` with default values for every key NOT already present (idempotent `ON CONFLICT (key) DO NOTHING`).
3. ALTER each consumer function body in dependency order: Slice 001's `is_eligible_nortal_participant` first (most foundational), then Slice 003's lock predicate, then Slice 005's scoring functions, then Slice 002's coordinator (Edge Function code, separate from migration).
4. Add the new `admin_config_*` SECURITY DEFINER RPC family.
5. Add the `pg_notify` trigger on `tournament_config`.
6. Add the webhook-delivery `pg_cron` job (60-second cadence) per R-011.

**Regression gate (Principle XI)**. The full prior-slice regression suite MUST pass after each ALTER FUNCTION step. The migration file structures each step as a separate `BEGIN; ALTER FUNCTION ...; -- self-check via SELECT against fixtures; COMMIT;` block, so a failure halts the migration.

**Rationale**. Linear order ensures cross-function dependencies (Slice 005's scoring reads from `tournament_config`, but Slice 001's eligibility predicate is read by Slice 003 which is read by Slice 005's writers...) are not violated mid-migration.

**Alternatives considered**. Feature-flag style flip (both old and new code paths gated by a `config.feature_flag.use_dynamic_config` bool) — rejected as over-engineering for a one-shot consolidation. Per-consumer separate slices — rejected because the spec is explicit that this is a single vertical slice owning ALL configuration.

## Summary of decisions

| # | Topic | Outcome |
|---|---|---|
| R-001 | Storage shape | Single `tournament_config (key, value jsonb)` table (existing) |
| R-002 | Versioning + rollback | New `tournament_config_versions` append-only log + restore RPC |
| R-003 | Concurrency | Optimistic concurrency via `expected_version_id` + advisory xact lock |
| R-004 | ERRCODE namespace | `WCG01..WCG08` |
| R-005 | Admin UI structure | Tabbed sections under `/admin/config/*` |
| R-006 | Domain list storage | jsonb array under `eligibility.allowed_domains` key |
| R-007 | Admin role consolidation | Slice 006's table preserved; this slice ships only the UI wrapper |
| R-008 | Provider credentials | jsonb `{secret: true, value}` + admin-only redaction + per-access audit |
| R-009 | Read-path caching | Per-process LRU + Postgres LISTEN/NOTIFY invalidation |
| R-010 | Affecting-data warnings | Two-step preview → acknowledge token → write |
| R-011 | Fail-closed | Shared `config_read` helper raising `WCG06`; system alert path activated |
| R-012 | Import/export | Signed JSON envelope with version history |
| R-013 | Action label catalog | `tournament_config.<key>` prefix (pre-reserved by Slice 007) |
| R-014 | Cross-slice migration | Single migration file with ordered ALTER FUNCTION steps + regression gate |
