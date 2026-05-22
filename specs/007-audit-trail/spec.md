# Feature Specification: Audit Trail

**Feature Branch**: `007-audit-trail`

**Created**: 2026-05-15

**Status**: Draft

**Input**: User description: "Cross-cutting vertical slice covering FR-018 (audit trail). Records every state-changing action across slices 001–008 with timestamp, actor, previous value, new value, and reason, and provides administrator search/export."

**Architecture anchors**:

- Implements **FR-018**
- Cross-references every other slice (each slice writes audit events into this slice's store)
- Constitution principles in force: V (Auditability — primary), II (Security by Design), VII (Operational Resilience), VIII (Extensibility & Configuration)
- Anchors to architecture §11 (Security and Privacy) data minimization commitments

## Clarifications

### Session 2026-05-17

- Q: Event type taxonomy — coarse 9-value list vs. fine-grained 60+ label catalog? → A: Fine-grained labels are canonical; FR-002's coarse list is illustrative grouping only, and the frozen catalog lives in `data-model.md` under "Action label catalog".
- Q: Large export "surface progress" — in-app progress bar vs. browser-native download UI? → A: Browser-native download indicator (bytes received) is the canonical progress surface; no separate in-app row counter or job-id polling shipped in this slice.
- Q: Audit-write-failure alert delivery — ship in this slice or defer to Slice 008? → A: Slice 007 ships only the webhook config key (`notifications.audit_failure_webhook_url`, default `null`) plus a runbook entry. Webhook delivery — and therefore SC-007's 5-minute target — is deferred to Slice 008. In the interim, audit-write failures surface via platform logs (Supabase + Vercel) that operations already monitor.
- Q: Tamper-attempt audit — defensive API-layer guard or rely on absence-of-route + DB REVOKE? → A: Absence-of-route plus DB-level `REVOKE UPDATE, DELETE` satisfies the spec; no defensive API-layer guard is shipped. Acceptance is verified by a route-inventory test asserting no UI/API surface offers UPDATE or DELETE on `audit_log`. The "MUST be audited" requirement applies only to rejections from routes that actually exist (e.g., non-admin `audit_search` / `audit_export` denials).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every state-changing action is recorded (Priority: P1)

When any other slice performs a state-changing action — prediction create/update, lock decision, scoring calculation, recalculation, admin override, configuration change, denied access — the audit trail records the event with timestamp, actor (or system identity), target, previous value, new value, and reason. The audit write is transactional with the underlying action: if the audit cannot be written, the underlying action MUST also fail.

**Why this priority**: Disputes during a high-engagement tournament are inevitable. Without complete audit trails, "why did my points change?" or "who deleted my prediction?" cannot be answered, and Principle V is violated.

**Independent Test**: For each upstream slice (001–008), perform a representative state-changing action and verify exactly one audit event is recorded with the required fields. Force the audit-write path to fail under a controlled fault and verify the underlying action also fails (no half-committed state).

**Acceptance Scenarios**:

1. **Given** any state-changing action originating from any other slice, **When** the action commits, **Then** an audit event MUST be persisted with: event id, event type (create / update / lock-decision / scoring / recalc / override / config-change / access-denied / other), actor identity (participant id or system identity), occurred_at (server UTC), target kind, target id, previous value (where applicable, structured), new value (where applicable, structured), reason (where applicable), source (UI / API / system / admin).
2. **Given** the underlying database transaction that performs the action, **When** the audit insert is included, **Then** both the action and the audit MUST commit or both MUST roll back; partial commits MUST be impossible.
3. **Given** a synthetic fault injected into the audit insert path, **When** an action attempts to commit, **Then** the action MUST also fail and the user MUST receive a clear error; no orphaned state MUST result.

### User Story 2 - Audit records are immutable through application paths (Priority: P1)

No UI route or API endpoint may modify or delete an existing audit record. Audit records are append-only from the application's perspective. Direct database-level destructive operations are out of scope for this slice (governed by platform/operational controls, not application logic).

**Why this priority**: The value of an audit trail evaporates the moment it can be quietly rewritten. The append-only invariant is part of what makes Principle V meaningful.

**Independent Test**: Attempt to delete or modify an audit record via every available UI route and API endpoint (admin and participant). Verify each attempt is either rejected at the application boundary or unavailable in the API surface entirely.

**Acceptance Scenarios**:

1. **Given** any audit record, **When** any participant or administrator attempts to delete it through any UI route, **Then** the route MUST NOT EXIST. Verified by an exhaustive route-inventory test enumerating every UI/API surface and asserting none offers UPDATE or DELETE on `audit_log`. The "audited rejection" requirement applies only to denials from routes that exist (e.g., non-admin `audit_search` / `audit_export` calls — see User Story 3).
2. **Given** any audit record, **When** any participant or administrator attempts to modify it through any API endpoint, **Then** the route MUST NOT EXIST. Same verification as scenario 1.
3. **Given** the database schema and constraints, **When** an audit insert succeeds, **Then** the record MUST be protected by `REVOKE UPDATE, DELETE` at the database layer such that any update or delete attempt from `authenticated`, `anon`, or `service_role` is rejected with `insufficient_privilege` (SQLSTATE 42501) — including attempts made with a compromised service-role key.

### User Story 3 - Administrators can search and export audit records (Priority: P2)

A tournament administrator investigating a dispute can search the audit trail by date range, actor, target kind, target id, event type, and source, and can export the result set for offline review. Search is scoped to admin role only.

**Why this priority**: A complete audit trail that cannot be queried efficiently is not actionable. Dispute resolution must complete in minutes, not hours.

**Independent Test**: Sign in as an administrator, search for "all events for participant X in the last 7 days," verify results are accurate and complete. Export the result set, verify the export contains every required field and is human-readable.

**Acceptance Scenarios**:

1. **Given** an authorized administrator and a populated audit trail, **When** they search by date range, actor, target kind, target id, event type, and/or source, **Then** results MUST include every matching event with full field detail and MUST exclude no matching event.
2. **Given** the same administrator, **When** they export the search results, **Then** the export MUST contain every field required by FR-001 above in a human-readable format suitable for dispute resolution.
3. **Given** any non-admin attempting to access the audit search or export, **When** they make the request through any route, **Then** access MUST be denied at the server boundary and the denial MUST itself be audited.

### Edge Cases

- An audit write fails because the underlying storage is full or unavailable → the underlying action MUST also fail (transactional inclusion); the user MUST receive a clear error; an out-of-band system alert MUST be raised.
- Concurrent writes to the same target produce a strictly ordered audit sequence → audit events MUST be monotonically ordered per (target kind, target id), even under high concurrency.
- A very large export request (e.g., the full tournament's events for all participants) → the export MUST stream to avoid memory or timeout issues; progress is surfaced by the browser's native download indicator (bytes received). No in-app progress card or background-job polling is shipped in this slice.
- An audit record references a participant who has since been deactivated → the record MUST remain readable; participant identity references MUST resolve to a stable identifier independent of activation status.
- A participant requests to "delete their data" under a privacy request → out of scope for this slice; the application's policy MUST distinguish between operational audit retention and personal-data-deletion requests, and this slice MUST surface what is and isn't deletable per the configured retention policy.
- Audit storage approaches its retention horizon → events older than the configured retention period MAY be archived or purged per Slice 008 policy; the spec assumes default retention is "full tournament plus 12 months."
- Clock skew between application instances → audit timestamps MUST come from a single authoritative server clock (e.g., the database clock) to ensure monotonic ordering per target.
- Provider-sync events generate high audit volume → audit infrastructure MUST handle high write throughput during sync windows without degrading other slices' write paths.
- An audit search query is malformed or impossibly broad → the search MUST return a clear error or paginate, not crash or hang.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST record an audit event for every state-changing action originating from any slice: prediction create/update, lock decision (allowed or denied), scoring calculation, recalculation, admin override, configuration change, eligibility denial, sync event, role-change.
- **FR-002**: Each audit event MUST include: event id, action label (drawn from the frozen fine-grained catalog defined in `data-model.md` — e.g., `prediction.created`, `admin.role_granted`, `match.conflict_quarantined`; the namespace prefixes `participant.*`, `match.*`, `match_result.*`, `team.*`, `player.*`, `prediction.*`, `final_prediction.*`, `score_record.*`, `tournament_award.*`, `tournament_config.*`, `admin.*`, `provider.*`, `access.*`, `tournament.*`, `score_trigger.*` group the catalog), actor identity (or system identity), occurred_at (server timestamptz), target kind (entity_type), target id (entity_id), previous value (where applicable, jsonb), new value (where applicable, jsonb), reason (where applicable), source (one of `auth_hook`, `trigger`, `rls`, `api_guard`, `admin_rpc`, `ui`, `system`).
- **FR-003**: Audit writes MUST share the database transaction with the action they audit; failure to audit MUST cause the underlying action to fail (Constitution Principle V).
- **FR-004**: Audit records MUST be append-only through application paths; no UI route or API endpoint MUST modify or delete an existing audit record.
- **FR-005**: System MUST provide administrator-only search by date range, actor, target kind, target id, event type, and source.
- **FR-006**: System MUST provide administrator-only export of search results in a human-readable, structured format suitable for dispute resolution.
- **FR-007**: Audit retention MUST be configurable (Slice 008) with a default of "full tournament plus 12 months."
- **FR-008**: System MUST guarantee monotonic ordering of audit events per (target kind, target id), even under concurrent writes.
- **FR-009**: Audit search and export MUST be scoped to admin role only; non-admin attempts MUST be denied at the server boundary and the denial MUST itself be audited.
- **FR-010**: System MUST surface audit-write failures to operators out-of-band. In this slice, the surfacing mechanism is platform-level logging (Supabase + Vercel logs) that operations already monitor; additionally, a configuration key `notifications.audit_failure_webhook_url` (default `null`) is seeded so Slice 008 can hook structured webhook delivery without further schema changes.
- **FR-011**: System MUST preserve audit references to participants and other entities even after those entities are deactivated; identifiers MUST be stable and historical references MUST remain readable.

### Key Entities

- **Audit Event**: A single immutable record of one state-changing action. Attributes: event id (unique), event type, actor identity, occurred_at (server UTC), target kind, target id, previous value (structured, nullable), new value (structured, nullable), reason (text, nullable), source.
- **Audit Search Query**: Administrator-facing query with date range, actor, target kind, target id, event type, source filters; returns an ordered set of matching Audit Events.
- **Audit Retention Policy (configuration reference)**: Default "tournament + 12 months," configurable per Slice 008.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of state-changing actions across slices 001–008 produce a corresponding audit event committed in the same transaction.
- **SC-002**: Audit records survive 100% of injected fault scenarios (storage failure, transaction abort, instance restart) with no "auditless action" possible.
- **SC-003**: Full audit reconstruction of any single prediction's history (create + updates + locks + scoring + recalcs) is retrievable within 5 minutes by an administrator search.
- **SC-004**: Audit export of one participant's full history completes in under 30 seconds for the full tournament under normal load.
- **SC-005**: 100% of non-admin attempts to read, modify, or delete audit data are rejected at the server boundary and themselves audited.
- **SC-006**: Audit ordering is strictly monotonic per (target kind, target id) under 1,000 concurrent simulated writers, verified by an automated stress test.
- **SC-007**: *(Deferred to Slice 008)* Operational alerts for audit-write failures reach configured operators within 5 minutes of first failure. Slice 007 ships the `notifications.audit_failure_webhook_url` config key; Slice 008 wires actual delivery through its notification framework and validates the 5-minute target there.

## Assumptions

- Audit storage shares the same data store as the rest of the application's transactional data (Postgres / Supabase per Constitution), enabling true transactional inclusion of audit writes.
- The application's database clock is the single authoritative server clock used for both lock decisions and audit timestamps, ensuring consistency between Principle V and Principle VI.
- Personally-identifiable information in audit records is governed by the data minimization commitments in §11 of the architecture document; this slice does not expand the participant attribute set defined in Slice 001 (FR-003).
- Personal-data deletion requests (e.g., GDPR-style) are out of scope for this slice; the application's broader privacy policy MUST distinguish operational audit retention from personal-data deletion and any conflict MUST be resolved at the policy level.
- High audit volume from provider syncs (Slice 002) is expected; sizing the audit store and indexing for this volume is an implementation concern but spec-level success criteria (SC-002, SC-006) MUST be met.
