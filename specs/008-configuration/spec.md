# Feature Specification: Tournament Configuration

**Feature Branch**: `008-configuration`

**Created**: 2026-05-15

**Status**: Draft

**Input**: User description: "Vertical slice covering FR-020 (administrator-configurable tournament settings). Fills the §15 gap for FR-020 by providing the live-configuration surface every other slice depends on: allowed domains, lock windows, scoring values, tie-breaker order, tournament phases, provider settings, admin role assignments, notification policy, and retention policy."

**Architecture anchors**:

- Implements **FR-020**
- Fills §15.3 gap *(FR-020 needs explicit configuration test)*
- Constitution principles in force: VIII (Extensibility & Configuration — primary), II (Security by Design), III (Rules Outside the UI), V (Auditability)
- Cross-cuts every other slice (each slice reads values managed here)

## Clarifications

### Session 2026-05-17

- Q: Version-history shape — per-key change log vs. full per-write snapshot? → A: Per-key change log. Each row records one key's `previous_value` + `new_value`. Rollback is per-key ("restore this key to value-at-version-X"), not global. Avoids snapshot-storage cost and prevents rollbacks from inadvertently reverting unrelated keys.
- Q: Concurrent edit resolution — error on conflict or persist loser as "superseded"? → A: Error on conflict via optimistic concurrency. The losing admin's write fails with `WCG01` and the UI prompts them to reload + retry. Only the winner's write is persisted to `tournament_config_versions`. No "superseded" rows are written.
- Q: Fail-closed posture — all keys, none, or an enumerated critical-key list? → A: Enumerated critical-key prefixes. Reads of `eligibility.*`, `locking.*`, `scoring.*`, `admin_roles.*`, `providers.active`, and `providers.<id>.credentials.*` MUST raise `WCG06` (halt the operation) on miss. Other keys MAY fall back to in-code defaults to keep cosmetic surfaces alive. Consumers pass NULL default to `config_read` for critical keys; non-NULL for non-critical.
- Q: Configuration import — environment-direction policy + secret handling? → A: Direction-aware secret-stripping at the export side. The export RPC always redacts secret-bearing keys (`providers.<id>.credentials.*`) to `{secret: true, value: null}` regardless of source environment; the export envelope carries an `environment` label for forensic context. The import RPC accepts envelopes from any source environment provided the HMAC signature is intact, and skips the redacted-secret entries during import. Target-environment admins supply secret values out-of-band via `admin_config_upsert`. No directional restrictions.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Administrator changes allowed corporate domains (Priority: P1)

A tournament administrator updates the list of approved corporate domains (e.g., adds a newly-acquired Nortal entity domain, or removes a deprecated one). The change takes effect for new eligibility evaluations within 1 minute and without a code deploy. Slice 001 immediately honors the new list.

**Why this priority**: The approved-domain list is the gate to the entire product (FR-001). Changing it is a routine, hot-path administrative task that must not require engineering involvement.

**Independent Test**: As administrator, add a new domain. Within 1 minute, sign in as a user from that domain — verify access granted. Remove a previously-allowed domain. Within 1 minute, sign in as a user from that domain — verify access denied. Verify both changes are audited.

**Acceptance Scenarios**:

1. **Given** an authorized administrator and an existing approved-domain list, **When** they add a new domain string, **Then** the list MUST be updated, the change MUST be audited, and within 1 minute new eligibility evaluations MUST honor the new domain.
2. **Given** the same administrator removing a domain, **When** the change is saved, **Then** within 1 minute new eligibility evaluations MUST deny that domain; existing participant profiles from that domain MUST be preserved for audit (Slice 001 governs the user-facing policy for already-signed-in users).
3. **Given** a removed domain that still has active participants with submitted predictions, **When** the administrator confirms the removal, **Then** the system MUST surface a warning listing the affected participants before persisting the change, and proceeding MUST be an explicit second action.

### User Story 2 - Administrator changes the match-prediction lock window (Priority: P1)

The match-prediction lock window defaults to 60 minutes (BR-LOCK-002). An administrator may change it (e.g., to 90 minutes for a special tournament edition). The change takes effect for new lock evaluations within 1 minute, without a code deploy. Slice 003 honors the new value immediately for new decisions; existing locks are not retroactively reopened.

**Why this priority**: The lock window is a core scoring-engine parameter. Changing it during the tournament should be possible (e.g., to extend after a provider outage) but must be cleanly audited.

**Independent Test**: As administrator, change the lock window from 60 to 90 minutes. For a match whose kickoff is 75 minutes away, verify a participant can edit (which was not possible under 60-minute rule). For a match whose kickoff is 45 minutes away, verify edits remain rejected.

**Acceptance Scenarios**:

1. **Given** an administrator changing the lock window from 60 to 90 minutes, **When** the change is saved, **Then** within 1 minute new lock decisions in Slice 003 MUST use 90 minutes, and the change MUST be audited with previous and new values.
2. **Given** a lock-window change to a value that would re-open already-locked matches (e.g., kickoff was 70 minutes away, lock changes from 60 to 90 → match is now "inside" the lock under the new rule, but had previously been "open" under the old rule), **When** the change is saved, **Then** the system MUST surface a warning about the affected matches and the policy on retroactive locks MUST be explicit (default: existing predictions remain; new edits follow the new rule).
3. **Given** an invalid lock-window value (negative, non-integer, zero), **When** the administrator attempts to save, **Then** the change MUST be rejected with a clear validation error.

### User Story 3 - Administrator changes scoring values or tie-breaker order (Priority: P1)

The scoring values (10 / 5 / 0 for matches, 20 for final picks) and the tie-breaker order (§7.4) are configurable. Changing them triggers a "scoring values changed; re-score pending" state on the leaderboard (Slice 005), and an administrator may then trigger a recalculation (Slice 006) under the new values.

**Why this priority**: These values define what "winning" means. Changing them is rare but must be possible (e.g., a configuration error caught before launch, or a future tournament edition).

**Independent Test**: Change a scoring value. Verify the leaderboard surfaces the "re-score pending" state. Trigger recalculation. Verify all scores are recomputed under the new value and prior values are audited. Re-order tie-breakers and verify Slice 005 honors the new order.

**Acceptance Scenarios**:

1. **Given** an administrator changing match scoring values from 10/5/0 to 15/7/0, **When** the change is saved, **Then** the leaderboard MUST surface a "re-score pending" indicator, future scoring decisions MUST use the new values, and the change MUST be audited.
2. **Given** an administrator reordering tie-breakers, **When** the change is saved, **Then** within 1 minute new leaderboard renderings MUST use the new order.
3. **Given** invalid scoring values (negative, non-integer), **When** the administrator attempts to save, **Then** the change MUST be rejected.

### User Story 4 - Administrator manages provider settings, admin roles, and tournament phases (Priority: P2)

Administrators configure: which external provider is active, the provider's retry/backoff/alert policy, the assignment of admin roles to participant identities, and the tournament's active phase (e.g., pre-tournament / group-stage / knockout / completed). Sensitive provider credentials are admin-read-only.

**Why this priority**: These settings cluster the "tournament operations" surface. They are configured before launch and rarely change during the tournament, but each is essential and must be admin-configurable.

**Independent Test**: As administrator, assign and revoke admin roles, verify Slice 006 honors the changes immediately. Switch the active provider, verify Slice 002 begins using the new adapter. Change the tournament phase, verify the application surface adapts (e.g., hides not-yet-relevant UI).

**Acceptance Scenarios**:

1. **Given** an administrator assigning the admin role to an eligible participant, **When** the change is saved, **Then** within 1 minute that participant MUST be able to perform admin actions in Slice 006, and the change MUST be audited.
2. **Given** an administrator revoking the admin role, **When** the change is saved, **Then** the affected participant MUST lose admin capabilities on their next request, and any in-progress admin session MUST lose authorization on next authenticated request.
3. **Given** an administrator switching the active provider in Slice 002 to a different contract-compliant provider, **When** the change is saved, **Then** the next scheduled sync MUST use the new provider, and the switch MUST be audited.
4. **Given** an administrator viewing or editing sensitive provider credentials, **When** the operation occurs, **Then** the credential value MUST be admin-only and the access MUST be audited.

### User Story 5 - Administrator rolls back a bad configuration change (Priority: P2)

A configuration change has been made and produces an unexpected outcome (e.g., a typo in a domain string, an accidental lock-window change to 0). The administrator rolls back to the prior version. Rollback takes effect within 1 minute.

**Why this priority**: Configuration mistakes happen. Rollback is the safety net that makes the live-configuration model trustworthy.

**Independent Test**: Make any configuration change. Roll back. Verify the previous values are restored and within 1 minute downstream slices honor the restored values. Verify both the original change and the rollback are audited.

**Acceptance Scenarios**:

1. **Given** an administrator with a recent configuration change and a desire to revert, **When** they trigger a rollback to the prior version, **Then** the prior values MUST be restored, the rollback itself MUST be a new audit event (not a deletion of the prior change), and within 1 minute downstream slices MUST honor the restored values.
2. **Given** a long history of configuration changes, **When** the administrator views the version history, **Then** they MUST be able to identify the version they want and roll back to it specifically.

### Edge Cases

- An administrator removes a domain that has active participants with submitted predictions → system surfaces a warning listing affected participants; proceed requires explicit confirmation; data is preserved.
- An administrator lowers the score upper bound below an existing prediction's value → existing predictions are preserved; the new bound applies only to new submissions; the system MUST surface a warning of affected predictions before saving.
- Two administrators submit conflicting configuration edits within seconds → exactly one MUST become the active version. The losing write MUST fail with error code `WCG01` (concurrent-edit conflict) and the loser's admin UI MUST prompt them to reload and retry. The losing write MUST NOT be silently merged and MUST NOT be persisted as a "superseded" row — only the winner's write lands in `tournament_config_versions`.
- Configuration change is applied during a lock-window boundary moment for some matches → the new rule applies to lock decisions evaluated AFTER the configuration change commits; in-flight evaluations use the value at the start of their evaluation.
- A non-admin user attempts to read provider credentials or admin role assignments → REJECTED at the server boundary; denial is audited.
- Configuration import / export (for environment promotion or backup): supported as an admin operation, the export MUST include version history; importing MUST be audited as a single bulk change with the source identified.
- Tournament phase is changed backward (e.g., from "completed" back to "knockout") → allowed but flagged; downstream slices MUST be tolerant of phase transitions in either direction.
- Configuration value is changed to a malformed value (e.g., regex domain string) → REJECTED with validation error before any persistence.
- The configuration store is unreachable on read → downstream slices MUST fail closed (deny by default for eligibility, refuse new lock decisions); operator alert MUST be raised.
- A rollback target version is older than the retention horizon for configuration history → REJECTED with a clear error; older versions MUST be archived rather than purged in normal operation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow authorized administrators to configure all of the following settings without a code deploy (architecture FR-020):
  - approved corporate domains list (used by Slice 001)
  - match-prediction lock window in minutes (used by Slice 003, default 60)
  - score upper bound (used by Slice 003)
  - scoring values for match outcomes (exact / correct-outcome / incorrect, default 10 / 5 / 0; used by Slice 005)
  - scoring value for final-tournament picks (default 20; used by Slice 005)
  - tie-breaker order (default per §7.4; used by Slice 005)
  - knockout-match score basis (regular / extra-time / final-excluding-shootouts; used by Slice 005, blocks on OD-002)
  - top-scorer-tie policy (used by Slice 005, blocks on OD-004)
  - best-player source (used by Slice 005, blocks on OD-005)
  - leaderboard visibility policy (used by Slice 005, blocks on OD-006)
  - active provider identity and per-provider settings (retry/backoff/alert thresholds; used by Slice 002)
  - admin role assignments (used by Slice 006)
  - tournament phase (pre-tournament / group-stage / knockout / completed)
  - notification policy (channels, deadlines, cadence; OD-008, used by FR-019 — not implemented in v1)
  - audit retention policy (used by Slice 007, default "tournament + 12 months")
- **FR-002**: Configuration changes MUST take effect for new evaluations downstream within 1 minute of save, without a code deploy.
- **FR-003**: All configuration writes MUST be audited per Slice 007 with actor, previous value, new value, reason (optional), and source.
- **FR-004**: System MUST validate configuration values against integrity rules before save (e.g., lock window > 0 integer, scoring values non-negative integers, domain strings are well-formed, provider settings reference a known provider adapter).
- **FR-005**: System MUST surface a clear warning when a configuration change would affect existing data (removing a domain with active participants, lowering a bound below existing values, re-opening already-locked matches). Proceeding MUST require explicit confirmation.
- **FR-006**: System MUST allow rollback to any prior configuration version within the retention window; rollback MUST be itself a new audit event, not a deletion of the prior version.
- **FR-007**: System MUST scope sensitive configuration (provider credentials, admin role assignments) to administrator-only read and write; non-admin attempts MUST be denied at the server boundary and audited.
- **FR-008**: System MUST fail closed if the configuration store is unreachable on read for **critical keys**. Critical-key prefixes are: `eligibility.*`, `locking.*`, `scoring.*`, `admin_roles.*`, `providers.active`, and `providers.<id>.credentials.*`. Reads of critical keys MUST raise an error and halt the operation; consuming slices MUST deny access (return false from eligibility predicates) or refuse writes. Non-critical keys (display labels, cosmetic defaults, retention buffer values) MAY fall back to in-code defaults so cosmetic surfaces remain available. Read-time policy is enforced by passing NULL default to the shared `config_read` helper for critical keys and an in-code constant otherwise.
- **FR-009**: System MUST support configuration export and import as admin operations for environment promotion and backup. Exports MUST include the version history. Secret-bearing keys (`providers.<id>.credentials.*`) MUST be redacted to `{secret: true, value: null}` in the exported envelope regardless of source environment. Exports MUST be signed (HMAC-SHA256) with a server-side secret so that tampered envelopes are rejected at import. Imports MUST be audited as a single bulk change with the source environment identified; redacted secret entries MUST be skipped during import and target-environment admins MUST supply secret values out-of-band via standard upsert flow. No directional restrictions are imposed beyond signature verification.
- **FR-010**: System MUST resolve concurrent configuration edits deterministically: exactly one becomes the active version, others become superseded versions in audit, no silent merge.
- **FR-011**: System MUST treat the admin role assignment as the source-of-truth for the role check used by Slices 006, 007, and 008 itself; revocation MUST take effect on the next request.

### Key Entities

- **Configuration Setting**: A single configuration key-value pair. Attributes: key, value (structured), value type, version number, last_updated_by, last_updated_at.
- **Configuration Version**: One entry in an append-only per-key change log. Attributes: version id (monotonic), key, previous_value, new_value, change_kind (initial_seed / admin_upsert / admin_rollback / import_bulk), actor, reason, source_citation, audit_log_id (link to canonical audit row), parent_version_id (set only for rollbacks; points to the version being restored), acknowledge_token_used, created_at. Rollback selects a target version_id and writes a NEW version row that re-applies that target's `new_value` for the same key.
- **Admin Role Assignment**: A participant identity granted administrator role. Attributes: participant id, granted_at, granted_by, revoked_at (nullable).
- **Provider Adapter Reference**: A registered provider integration that satisfies the Slice 002 contract. Attributes: provider id, display name, contract version, active flag.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of FR-020 settings are administrator-configurable without a code deploy.
- **SC-002**: Configuration changes take effect for downstream new-evaluation decisions within 1 minute of save (verified by automated tests against each consuming slice).
- **SC-003**: 100% of configuration writes produce a corresponding audit event in the same transaction.
- **SC-004**: A rollback to a prior configuration version restores prior values and takes effect within 1 minute.
- **SC-005**: 100% of non-admin attempts to read sensitive configuration (provider credentials, admin roles) are rejected at the server boundary and audited.
- **SC-006**: Configuration validation rejects 100% of integrity-violating values in automated test sweeps (negative numbers, malformed strings, unknown provider references).
- **SC-007**: Concurrent edits to the same setting from two admins produce exactly one active version with full audit, verified by stress testing 100 concurrent writers.

## Assumptions

- The configuration store is part of the application data layer (Supabase Postgres per Constitution) and shares the transactional boundary with the audit trail (Slice 007).
- Sensitive configuration (provider credentials) is encrypted at rest by the underlying platform; this spec does not require an application-layer encryption scheme beyond access control.
- Notification policy and channels (FR-019, OD-008) are not implemented in v1 — only the configuration shape is defined here.
- Tournament phase is a single global value, not per-region or per-tenant.
- Configuration import / export is for operational use (environment promotion, disaster recovery) and is not a participant-facing feature.
- Eligibility (Slice 001) governs *who* may even reach the admin configuration UI; admin role (this slice) governs *which* of those may modify configuration.
