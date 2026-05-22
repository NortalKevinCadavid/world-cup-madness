# Feature Specification: Admin Overrides & Recalculation

**Feature Branch**: `006-admin-overrides`

**Created**: 2026-05-15

**Status**: Draft

**Input**: User description: "Vertical slice covering FR-015 (administrative override) and FR-016 (recalculation). Enables tournament administrators to correct match data, final-tournament award data, or scoring inputs and to trigger or schedule recalculations."

**Architecture anchors**:

- Implements **FR-015, FR-016**
- Satisfies §15.1 scenarios: *Admin manual score correction*, *Score correction recalc*
- Constitution principles in force: II (Security by Design), III (Rules Outside the UI), V (Auditability), VII (Operational Resilience)

## Clarifications

### Session 2026-05-17

- Q: When an admin submits an override on a match whose status is `cancelled`, what is the locked behavior? → A: **Audit-only, no scoring.** The admin RPC MUST accept the override and persist the row (`match_results` updated, audit row written with `source='admin_rpc'`, `source_citation` captured). Slice 005's `score_match` MUST continue to skip matches whose `status='cancelled'` — no points are awarded to participants for cancelled-match overrides. The audit row exists so disputes are traceable; the leaderboard is unaffected. Rationale: matches spec's stated default ("spec assumes default is 'no scoring for cancelled matches'") verbatim; preserves audit value; defers a policy-flip toggle to Slice 008's admin UI if business ever wants posthumous scoring on cancelled matches.
- Q: SC-007 says interrupted recalculations resume cleanly within 10 seconds of restart. What's the locked resume mechanism? → A: **Edge Function self-scan at startup + slow pg_cron backup.** The `score-trigger` Edge Function MUST, as the first step of every invocation (cron-driven, admin-triggered, or auto-triggered), run `SELECT * FROM score_calculation_runs WHERE status='running' AND started_at < now() - INTERVAL '60 seconds'`; for each stale row, re-invoke itself (via `pg_net.http_post` with the same `run_id` so Slice 005's idempotency handles resumption). pg_cron schedules a backup reaper at 5-minute cadence as the eventual-fallback when no other Edge Function invocation happens. Effective resume after Edge Function restart: ~5 seconds (the next invocation handles cleanup). Meets SC-007 naturally without aggressive cron load.
- Q: Where does the "Admin Override Event" entity live in the data model? → A: **`audit_log` rows with `source='admin_rpc'`.** No dedicated `admin_override_events` table. Slice 001's `audit_log` (extended by this slice's additive `source_citation` column) captures every field FR-007 enumerates: `actor` (admin id), `entity_type` + `entity_id` (target), `previous_value`, `new_value`, `reason`, `source_citation`. Affected-score counts derive via JOIN on `score_calculation_runs.triggering_audit_log_id` (this slice's additive column on the Slice 005-owned table). All admin override queries (`/admin/audit`, `/admin/audit/by-target/[entity_type]/[entity_id]`) filter on `audit_log.source='admin_rpc'` or `action LIKE 'admin.%'`. Rationale: single audit surface; preserves cross-slice audit pattern (every Slice 001–005 writes to `audit_log`); no risk of drift between a parallel table and audit_log.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Administrator manually corrects a match score (Priority: P1)

A tournament administrator identifies that the provider-supplied score for a match is wrong (e.g., delayed, mis-recorded, disputed). They open the admin view, correct the home/away score, provide a reason and source citation, and submit. The system records the override, recalculates affected scoring, and updates the leaderboard.

**Why this priority**: Real-world data discrepancies are expected (Principle VII). Without an override path, scoring can be permanently wrong and disputes become unanswerable.

**Independent Test**: Seed a scored match. Sign in as an administrator, change the official score with a reason and a source URL, submit. Verify the override is persisted, the previous score is retained in audit, downstream scoring is recalculated, and every affected participant's leaderboard rank reflects the corrected value.

**Acceptance Scenarios**:

1. **Given** an authorized administrator and a scored match with provider score 2-1, **When** they submit an override changing the score to 2-2 with reason "official correction" and source "https://example.com/announcement", **Then** the override MUST be persisted, the previous score MUST be retained in audit history, a recalculation MUST be triggered for affected predictions, and an audit event MUST capture actor, target, previous value, new value, reason, and source.
2. **Given** an administrator submitting an override, **When** they omit the reason OR the source field, **Then** the override MUST be rejected with a clear validation error; the system MUST NOT accept overrides without justification.
3. **Given** an override is accepted, **When** scoring recalculation completes, **Then** every participant whose points changed MUST have an audit record per affected score with previous-points / new-points and a pointer back to the override event.

### User Story 2 - Administrator triggers a full recalculation (Priority: P1)

When official tournament data changes — e.g., a corrected match score, a new final-tournament award announcement, or a scoring-value configuration change — an administrator (or a scheduled process) triggers a recalculation. The recalculation is idempotent, resumable, and produces a new calculation version while preserving all prior versions.

**Why this priority**: FR-016 explicitly requires recalculation. Without it, overrides cannot meaningfully take effect, and configuration changes to scoring values (Slice 008) cannot be reflected.

**Independent Test**: Seed a tournament with mid-state scoring. Apply an override OR change a scoring configuration value. Trigger recalculation. Verify all affected score records are recalculated, prior values preserved in audit, the leaderboard reflects the new values within 1 minute, and re-running the same recalculation produces no further changes (idempotency).

**Acceptance Scenarios**:

1. **Given** a corrected match score (manual or provider), **When** an administrator triggers a recalculation, **Then** all affected predictions MUST be re-scored using the corrected official score, prior score records MUST be retained as immutable history, and the leaderboard MUST reflect the new values within 1 minute of completion.
2. **Given** a recalculation in progress, **When** it is interrupted (server restart, timeout), **Then** it MUST be resumable from the interrupt point and MUST NOT leave the leaderboard in a partially-updated state visible to participants.
3. **Given** the same recalculation triggered twice in sequence with no intervening changes, **When** both complete, **Then** the final state MUST be identical and no duplicate score records MUST be created (idempotency).
4. **Given** a recalculation triggered after a scoring-value configuration change (e.g., 10/5/0 → 15/7/0), **When** it runs, **Then** all already-awarded points MUST be recomputed under the new values, the prior calculation_version MUST be retained, and the leaderboard surfaces the transition.

### User Story 3 - Administrator corrects final-tournament awards (Priority: P1)

The official top scorer, best player, champion, or runner-up award is disputed, delayed, or corrected after Slice 005 has already scored. An administrator submits the corrected value, the system retains the prior award, and a recalculation re-scores all four final-prediction items for every participant.

**Why this priority**: The four final items each carry 20 points and have publicly-watched correctness. A wrong award that goes uncorrected is highly visible.

**Independent Test**: Seed final-tournament awards (champion, runner-up, top scorer, best player), score all participants. Administer a correction to one award (e.g., top scorer). Verify scoring for that item is recomputed for every participant, prior scoring is retained, and audit events identify each participant whose score changed.

**Acceptance Scenarios**:

1. **Given** scored final predictions and an administrator submitting a corrected top-scorer value with reason and source, **When** the override is accepted, **Then** a recalculation MUST re-score the top-scorer item for every participant, prior scoring values MUST be preserved, and audit events MUST capture per-participant before/after.
2. **Given** an override that re-introduces an officially-tied top scorer (OD-004 territory), **When** scoring runs, **Then** the system MUST apply the configured top-scorer-tie policy from Slice 008 / OD-004 and surface the policy in the audit reason.

### User Story 4 - Unauthorized access is rejected at UI and API (Priority: P1)

Non-administrators must not be able to call admin endpoints or perform overrides — through UI, through deep links, or through direct API. Authorization is enforced server-side at the same boundary as eligibility.

**Why this priority**: Constitution Principle II (Security by Design). UI-only gating is bypassable.

**Independent Test**: Sign in as a non-admin eligible participant. Navigate to any admin URL — verify access denied. Capture session token and call admin endpoints directly — verify access denied. Verify each denial is audited.

**Acceptance Scenarios**:

1. **Given** an eligible participant who is NOT an administrator, **When** they attempt to access any admin UI route, **Then** access MUST be denied; no admin data MUST be served.
2. **Given** the same participant, **When** they call any admin API endpoint directly with their session token, **Then** the API MUST reject the request with the same denial regardless of route.
3. **Given** any rejection from this slice, **When** it occurs, **Then** an audit event MUST be recorded with actor, attempted action, source (UI / API), and reason.

### Edge Cases

- Administrator submits an override that has no effect (e.g., setting the score to the same value as the current score) → behavior MUST be deterministic: the spec accepts the operation but produces an audit event noting "no value change," allowing audit traceability of the action regardless.
- Two administrators submit conflicting overrides for the same target within seconds → exactly one MUST be the active value; the other MUST become a superseded version with full audit; the system MUST NOT silently merge them.
- A recalculation is triggered while a previous recalculation is still running → only one recalculation per scope MUST run at a time; the second MUST queue or be skipped with a clear status.
- An override is applied to a match that has not yet started → allowed but flagged in audit (this typically indicates schedule data was wrong, not score data).
- An override reverts a prior provider-sync correction → allowed; the audit chain reconstructs the full sequence.
- A recalculation produces score changes that drop a participant's total significantly → no special handling required at this layer; the leaderboard simply reflects the new values, but a configurable notification (Slice 008 / OD-008) MAY inform the affected participant.
- A scoring-value configuration change is applied without a subsequent recalculation → the leaderboard MUST surface a "scoring values changed; recalculation pending" state until an administrator triggers the re-score.
- Recalculation runs for a very large participant base near a result-arrival burst → the recalc MUST complete within the SC-002 budget and MUST NOT block participant reads.
- An administrator account is deactivated mid-override-edit → the active session MUST lose authorization immediately on next request; pending edits MUST be discarded; the deactivation MUST be audited.
- Override applied to a match whose status is "cancelled" → per Clarifications 2026-05-17, the override MUST be accepted (data persisted, audit row written with `source_citation` captured), but Slice 005's `score_match` MUST continue to skip matches with `status='cancelled'`. No points are awarded for cancelled-match overrides. The audit row exists so disputes are traceable; the leaderboard is unaffected. Slice 008 may later expose a `tournament_config` toggle to flip the policy if business needs posthumous scoring.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow authorized administrators to correct match data (home score, away score, status, kickoff time), final-tournament award data (champion, runner-up, top scorer, best player), and scoring inputs (architecture FR-015).
- **FR-002**: System MUST require reason (free text) and source (citation, URL, or document reference) on every administrative override; submissions missing either MUST be rejected.
- **FR-003**: System MUST allow authorized administrators or scheduled processes to recalculate points after match results, final-tournament results, or scoring-value configuration changes (architecture FR-016).
- **FR-004**: System MUST preserve prior scoring as immutable history when a recalculation produces new values (Constitution Principle V).
- **FR-005**: System MUST enforce admin role server-side at both UI and API; UI gating MUST NOT be the sole or primary gate (Constitution Principle II, Principle III).
- **FR-006**: System MUST ensure recalculation is idempotent (running it twice with no intervening changes produces the same final state) and resumable from interruption.
- **FR-007**: System MUST emit an audit event for every override and every recalculation, including target, previous value, new value, reason, source, actor, and affected-score counts (Slice 007).
- **FR-008**: System MUST allow only one recalculation per scope (e.g., per tournament, per match) to run at a time; concurrent triggers MUST queue or be skipped, never run in parallel against the same dataset.
- **FR-009**: System MUST treat the admin role assignment as configuration (Slice 008) backed by the corporate identity boundary; an administrator who has been deactivated MUST lose access immediately on next request.
- **FR-010**: System MUST surface a "recalculation pending" state on the leaderboard or admin view when scoring-affecting configuration has changed and a re-score has not yet completed.
- **FR-011**: System MUST allow an administrator to view, search, and inspect the full override history for any target.

### Key Entities

- **Admin Override Event**: A single administrative correction. Attributes: actor (admin identity), target kind (match / final-item / scoring-input), target id, previous value, new value, reason, source citation, submitted_at. Per Clarifications 2026-05-17, this entity is realized as `audit_log` rows with `source='admin_rpc'` and `action='admin.*'` rather than a dedicated table. Slice 001's `audit_log` columns plus this slice's additive `source_citation` column capture every attribute; queries filter on `source='admin_rpc'` or `action LIKE 'admin.%'`. Affected-score counts derive via JOIN on `score_calculation_runs.triggering_audit_log_id`.
- **Recalculation Run**: A single recalculation execution. Attributes: trigger (override / configuration change / scheduled / manual), scope (full / match-scoped / participant-scoped), started_at, completed_at, status (running / completed / failed / interrupted), affected score count, calculation_version produced.
- **Admin Identity (configuration reference)**: The set of participant identifiers granted administrator role. Managed in Slice 008.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of administrative overrides are persisted with non-empty reason and source, or rejected.
- **SC-002**: A full recalculation of 1,000 participants × 104 matches + 4 final picks completes within 5 minutes under normal load.
- **SC-003**: After an override and recalculation completes, every affected participant's leaderboard rank reflects the new value within 1 minute of completion.
- **SC-004**: Prior scoring versions remain retrievable indefinitely for every recalculation; no recalculation MUST delete a prior version.
- **SC-005**: 100% of admin UI / API access attempts by non-admin users are rejected at the server boundary and audited.
- **SC-006**: Re-running the same recalculation with no intervening changes produces zero additional changes (idempotency, verified by hash-equality of resulting score records).
- **SC-007**: Interrupted recalculations resume cleanly within 10 seconds of restart with no duplicate records and no missed records. Per Clarifications 2026-05-17, the resume mechanism is the score-trigger Edge Function's self-scan at startup (re-invokes any stale `score_calculation_runs` rows older than 60 seconds via the same `run_id` for idempotency), plus a pg_cron backup reaper at 5-minute cadence as eventual-fallback.

## Assumptions

- Admin role assignment is managed via Slice 008 against the corporate identity boundary established in Slice 001.
- Recalculation is incremental where possible (only affected scores) and full as a fallback for configuration-value changes.
- Reason and source field formats are open text plus optional URL; their content discipline is governed by the administrator team, not enforced by validation rules beyond non-empty.
- Notification of significant score changes to affected participants (OD-008) is governed by Slice 008; this slice produces the audit and signal, but not the channel.
- Eligibility (Slice 001) and audit (Slice 007) are in place; admin authorization layers on top of eligibility.
