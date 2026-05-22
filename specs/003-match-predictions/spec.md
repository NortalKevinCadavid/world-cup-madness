# Feature Specification: Match Predictions with Locking

**Feature Branch**: `003-match-predictions`

**Created**: 2026-05-15

**Status**: Draft

**Input**: User description: "Vertical slice covering FR-005 (prediction entry), FR-006 (single active prediction per match), FR-007 (update before lock), and FR-008 (60-minute lock). Implements the BR-LOCK-001…004 rules and is the highest-value behavioral feature."

**Architecture anchors**:

- Implements **FR-005, FR-006, FR-007, FR-008**
- Satisfies §15.1 scenarios: *Submit > 60 min before kickoff*, *Edit at exactly kickoff − 60 min*, *Edit at 59 min before kickoff*, *Edit at 61 min before kickoff*; fills the §15.3 gap *(FR-006 needs explicit single-active-prediction test)*
- Anchors to BR-LOCK-001, BR-LOCK-002, BR-LOCK-003, BR-LOCK-004 from `scoring-model.md`
- Constitution principles in force: II (Security by Design), III (Rules Outside the UI), V (Auditability), VI (Time-Zone Correctness), VIII (Extensibility & Configuration)

## Clarifications

### Session 2026-05-16

- Q: What happens when a participant submits the same scores they already have stored (no-op submit)? → A: **Accept and emit an audit no-op event.** The submission MUST be accepted with `200 OK`, MUST insert a new row in the prediction chain (the next link, with `superseded_at IS NULL`; the prior identical row is superseded normally), and MUST emit an `audit_log` row with `action='prediction.created'` whose `previous_value` and `new_value` carry the same scores. The UI MUST render the response identically to a value-changing edit. Rationale: matches the spec's stated assumption verbatim, preserves a complete audit trail of every confirmation intent (useful when participants ask "did my submission go through?"), and avoids a confusing UX where the "Submit" button silently does nothing.
- Q: When Slice 002 reports a kickoff correction that crosses a lock boundary AFTER predictions were already submitted, what is the locked behavior? → A: **Predicate-based + per-affected-prediction audit.** The `is_prediction_locked(match_id)` predicate always reads the **current** `matches.kickoff_utc`, so subsequent edit attempts are gated by the latest state automatically (BR-LOCK-002 / BR-LOCK-003 against the new kickoff). Existing predictions remain in their last-submitted state — they are NOT auto-superseded and are NOT retroactively invalidated. A trigger on `matches` (`AFTER UPDATE WHEN OLD.kickoff_utc IS DISTINCT FROM NEW.kickoff_utc`) emits one `audit_log` row per active prediction on the affected match, with `action='prediction.kickoff_correction_crossed_lock'`, `previous_value={kickoff_utc: OLD}`, `new_value={kickoff_utc: NEW}`. Slice 006's admin UI consumes these audit rows and exposes a per-affected-participant reopen / re-lock decision according to administrator policy. This slice does NOT make policy choices on behalf of administrators; it makes the data visible. Rationale: matches the spec's "administrators may need to manually reopen or close predictions according to policy" phrasing — policy lives in Slice 006; visibility lives here.
- Q: Where does the participant-visible prediction-history surface live? → A: **Active-only in this slice; full history surface in Slice 005.** `GET /api/me/predictions` (this slice) returns only the participant's currently-active prediction per match (`superseded_at IS NULL`). The full prediction chain (every superseded version) is surfaced to the participant by Slice 005's `/me/breakdown` page, which already joins predictions with scoring history and composes the data naturally. This slice does NOT expose `?include_history=true` or `/api/me/predictions/<match>/history` endpoints — that surface area is Slice 005's to own. Rationale: keeps Slice 003 focused on operational state (what's my current pick?), avoids cross-slice contract churn when Slice 005 ships its richer surface, and consolidates the participant's "full activity" view in one place.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Participant submits a prediction for an upcoming match (Priority: P1)

An eligible participant browses the match catalog, picks an upcoming match whose lock has not yet passed, enters predicted home and away scores, and submits. The application persists the prediction, confirms it back to the participant, and records the action in the audit trail.

**Why this priority**: Submitting predictions is the core participant action of the entire product. No other downstream value (scoring, leaderboard, breakdown) exists without it.

**Independent Test**: Sign in as an eligible participant, pick a match whose canonical kickoff is comfortably more than 60 minutes in the future, submit a score (e.g., 2-1), refresh the page, and verify the prediction is still shown as the active prediction. Verify an audit event was recorded with the submission.

**Acceptance Scenarios**:

1. **Given** an eligible participant and a match whose canonical UTC kickoff is more than 60 minutes from trusted server time, **When** the participant submits a valid prediction (non-negative integer home and away scores within the configured upper bound), **Then** the prediction MUST be persisted as the active prediction for that (participant, match) pair, returned to the participant in confirmation, and recorded in the audit trail with timestamp, actor, previous value (null), new value, and source (UI / API).
2. **Given** no prior prediction for a (participant, match) pair and a match more than 60 minutes from kickoff, **When** two predictions arrive concurrently from the same participant (e.g., two browser tabs submitting simultaneously), **Then** exactly one MUST become the active prediction and the other MUST be recorded as a superseded version in the audit history; the system MUST NOT create two active records.
3. **Given** an eligible participant, **When** they attempt to submit a prediction for a match they are not authorized to predict on (e.g., the match does not exist or has been cancelled), **Then** the request MUST be rejected with a clear reason and no record MUST be created.

### User Story 2 - Participant updates a prediction before lock (Priority: P1)

A participant has already submitted a prediction. They return to the application, change their mind, and submit a new prediction for the same match. The application replaces the active prediction with the new one, preserves the prior version in the audit history, and confirms the update.

**Why this priority**: Editability before lock is part of FR-007 and is one of the most-exercised behaviors during the tournament. The single-active-prediction-plus-history pattern (FR-006) is established here.

**Independent Test**: Submit a prediction (e.g., 1-0), then before lock submit a different prediction for the same match (e.g., 2-1). Verify the active prediction is now 2-1, that the previous 1-0 is retrievable as superseded history, and that exactly one active record exists per (participant, match).

**Acceptance Scenarios**:

1. **Given** an existing active prediction and remaining time to kickoff strictly greater than 60 minutes, **When** the participant submits a new prediction for the same match, **Then** the new prediction MUST become the active record, the previous prediction MUST be retained as a superseded version (not deleted), and an audit event MUST capture previous and new values.
2. **Given** an existing active prediction, **When** any update is persisted, **Then** there MUST be exactly one active prediction for the (participant, match) pair at any point in time (FR-006).
3. **Given** the participant views a previously-submitted prediction, **When** they look at the match's lock state, **Then** the UI MUST display the lock state derived from trusted server time, and the API MUST return the same lock state regardless of UI behavior.

### User Story 3 - System rejects edits inside the lock window (Priority: P1)

When trusted server time is within 60 minutes of a match's canonical kickoff (i.e., remaining_time ≤ 60 minutes), no participant may create or modify a prediction for that match — not through the UI, not through the API, not by exploiting a UI display lag. Rejection is consistent and uses server time only.

**Why this priority**: This is the most-scrutinized behavior in the product. The 60-minute boundary (BR-LOCK-002, BR-LOCK-003) is non-negotiable, and Constitution Principle III (Rules Outside the UI) demands identical enforcement at UI and API.

**Independent Test**: Schedule a match with a known kickoff time. Attempt to submit and to edit predictions at trusted-server-time offsets of -60:01 (1 second before lock), -60:00 (exactly at lock), -59:59 (1 second inside lock), and -59:00 (well inside lock). Verify the -60:01 case is ACCEPTED and the other three are REJECTED, via both UI and direct API. Verify the rejection cannot be bypassed by manipulating client clock or by replaying a stale signed request.

**Acceptance Scenarios**:

1. **Given** trusted server time equal to (kickoff − 60 minutes) exactly, **When** the participant attempts to create or modify a prediction, **Then** the request MUST be rejected because the rule is strict: remaining time must be GREATER THAN 60 minutes (BR-LOCK-003).
2. **Given** trusted server time within the lock window (e.g., kickoff − 59 minutes), **When** the participant attempts to create or modify a prediction via the UI, **Then** the request MUST be rejected, no record MUST be created or updated, and an audit event MUST capture the denied attempt.
3. **Given** trusted server time within the lock window, **When** the participant attempts the same operation via a direct API call (e.g., bypassing UI gating), **Then** the API MUST reject the request with the same denial reason — UI-only gating MUST NOT be the gate (Constitution Principle III).
4. **Given** a client clock that disagrees with the server (drift, manipulation, time-zone tricks), **When** the participant attempts an edit at any time, **Then** the lock decision MUST use trusted server time only (BR-LOCK-001) and the client clock MUST be ignored.
5. **Given** trusted server time at (kickoff − 60 minutes + 1 second), **When** the participant submits a valid edit, **Then** the edit MUST be accepted and audited.

### User Story 4 - Participant sees per-match lock state (Priority: P2)

The participant sees, per match, whether the prediction is currently editable, with an indication of how long remains until lock. The display is informational; the server-side lock decision is authoritative.

**Why this priority**: Helps participants make informed decisions, reduces support load near deadlines, but is purely an information display — locking enforcement does not depend on it.

**Independent Test**: View the match list at various offsets to kickoff (well before lock, just before lock, after lock, after kickoff). Verify the displayed state matches the server's lock decision in every case.

**Acceptance Scenarios**:

1. **Given** any participant viewing the match list, **When** the UI renders each match's lock state, **Then** the state MUST be derived from trusted server time (either pushed from the server or fetched live) and MUST match the API's authoritative decision.
2. **Given** the display becomes stale (e.g., participant leaves the page open across the boundary), **When** they attempt to submit after stale-display lock-open suggestion, **Then** the server MUST still reject based on trusted server time and the UI MUST surface the corrected state.

### Edge Cases

- A match's canonical kickoff time is corrected by the provider (Slice 002) AFTER a prediction was already submitted and AFTER the match had already entered its lock window → per Clarifications 2026-05-16, lock decisions for subsequent edits MUST follow the corrected kickoff (the predicate reads the current `matches.kickoff_utc` on every call). Existing predictions MUST remain in their last-submitted state (not auto-superseded, not retroactively invalidated). One audit event MUST be emitted per affected active prediction with `action='prediction.kickoff_correction_crossed_lock'` capturing the old and new kickoff. Slice 006's admin UI consumes those audit rows and exposes a per-participant reopen / re-lock decision; this slice does not auto-act on the policy decision.
- A participant submits a prediction for a match that has already started (status moved past scheduled) → the request MUST be rejected even if 60 minutes have not yet elapsed since the original kickoff (BR-LOCK-004).
- A participant submits non-integer or negative scores → the request MUST be rejected with a validation error; no record MUST be created.
- A participant submits a score above the configured upper bound (e.g., 100-0) → the request MUST be rejected.
- Two browser tabs from the same participant submit different predictions for the same match within the same second → exactly one MUST win and be active; the other MUST be a superseded version. No race condition MUST produce two active records.
- A direct API request reuses a session token after the participant has been deactivated → the request MUST be rejected by the eligibility check from Slice 001 before reaching the lock logic.
- A scheduled match is cancelled or postponed indefinitely → existing predictions MUST be preserved for audit but MUST NOT be scored; downstream slice 005 handles the scoring policy.
- Clock skew between application instances → all lock decisions MUST consult the same authoritative server clock (e.g., the database server) to ensure consistent rulings across instances.
- A participant attempts to "submit" a no-op (same values as existing) → behavior MUST be deterministic per Clarifications 2026-05-16: the submission is accepted (`200 OK`), a new prediction row is inserted (the prior identical row is superseded normally), and an `audit_log` row is emitted with `action='prediction.created'` and matching `previous_value` / `new_value` scores.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow each eligible participant to submit a score prediction (home score, away score) for any match in the catalog whose remaining time to kickoff is strictly greater than the configured lock window (default 60 minutes), based on trusted server time (architecture FR-005, BR-LOCK-001, BR-LOCK-002).
- **FR-002**: System MUST maintain exactly one ACTIVE match prediction per (participant, match) pair at all times, while preserving every prior version as immutable history (architecture FR-006).
- **FR-003**: System MUST allow updates to an existing match prediction only when remaining time to kickoff is strictly greater than the configured lock window (architecture FR-007).
- **FR-004**: System MUST reject creation or modification of a match prediction when trusted server time is at or inside the lock window (strict boundary: kickoff − lock_window) — BR-LOCK-003 (architecture FR-008).
- **FR-005**: System MUST reject creation or modification of a match prediction for a match whose status is in-progress, finished, or cancelled, regardless of the lock-window calculation (BR-LOCK-004).
- **FR-006**: System MUST enforce lock decisions identically at the UI and at the API; UI gating MUST NOT be the sole or primary gate (Constitution Principle III).
- **FR-007**: System MUST consult only trusted server time (or the authoritative database clock) for every lock decision; client-supplied time MUST be ignored (BR-LOCK-001).
- **FR-008**: System MUST validate score values as non-negative integers within the configured upper bound; invalid values MUST be rejected before any persistence side-effect.
- **FR-009**: System MUST handle concurrent submissions for the same (participant, match) pair such that exactly one ends up active and the others become superseded versions; the system MUST NOT produce two active records.
- **FR-010**: System MUST present the per-match lock state to participants based on the same trusted server time used by the API for enforcement.
- **FR-011**: System MUST record every prediction create, update, and rejected attempt to the audit trail (Slice 007) with timestamp, actor, match, previous value, new value, source (UI / API / admin), and reason where applicable.
- **FR-012**: System MUST treat the lock window length (default 60 minutes) and the score upper bound as live configuration sourced from Slice 008; changes MUST take effect within 1 minute for new lock evaluations.
- **FR-013**: System MUST follow a corrected kickoff time from Slice 002 for subsequent lock decisions on that match and MUST emit an audit event identifying participants affected when the correction crosses a lock boundary.

### Key Entities

- **Match Prediction (active)**: The currently effective prediction for a (participant, match) pair. Attributes: participant identifier, match identifier, home score, away score, submitted_at, last_edited_at, source.
- **Match Prediction Version (history)**: An immutable record of a prior submission, retained for audit. Attributes: same as active, plus superseded_at and the audit event id that captured the supersession. Per Clarifications 2026-05-16, participant-visible access to the full version chain is **out of scope for this slice** — Slice 005's `/me/breakdown` surface owns the participant history view; this slice's `GET /api/me/predictions` returns active rows only.
- **Lock Decision Event (audit reference)**: Recorded for rejected attempts inside the lock window or for kickoff corrections that crossed a lock boundary. Includes outcome, reason, server time consulted, kickoff at decision time. Written to Slice 007.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of edit attempts at or after (kickoff − lock_window) are rejected; 100% of edit attempts at (kickoff − lock_window + 1 second) are accepted — verified by automated boundary tests at -lock:00, -lock:01, +0:01 inside lock, and several wider offsets.
- **SC-002**: 100% of direct-API edit attempts inside the lock window receive the same denial as UI attempts inside the lock window.
- **SC-003**: Across 1,000 simulated concurrent submissions for the same (participant, match) pair, exactly one active prediction exists at the end and every submitted version is retrievable from history.
- **SC-004**: A participant can submit or edit a valid prediction in under 30 seconds from clicking the match to seeing confirmation, under normal load.
- **SC-005**: A configured change to the lock window (e.g., 60 → 90 minutes) takes effect for new lock evaluations within 1 minute of save, with no code deploy.
- **SC-006**: Zero prediction records lost across at least 10,000 simulated submit/edit cycles, including boundary timings.
- **SC-007**: 100% of prediction create, update, and rejected attempts produce a corresponding audit event in the same transaction.

## Assumptions

- Trusted server time is sourced from the authoritative database clock (or a comparable monotonic, NTP-synchronized server source) — never from the client.
- The lock window is configurable per Slice 008 with a default of 60 minutes; the strict-greater-than rule is preserved regardless of the configured value.
- Score upper bound is configurable per Slice 008 with a sensible default (e.g., 20) sufficient for all plausible football outcomes.
- Eligibility (Slice 001) is satisfied for every participant interaction in this slice; the lock logic does not re-implement eligibility but assumes it has already gated the request.
- Audit recording (Slice 007) is in place; this slice writes audit events in the same transaction as the underlying mutation.
- This slice does not handle final tournament predictions (champion, runner-up, top scorer, best player) — that is Slice 004 with its own lock at first kickoff (BR-LOCK-005).
