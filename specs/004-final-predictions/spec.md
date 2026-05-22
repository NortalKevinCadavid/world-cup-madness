# Feature Specification: Final Tournament Predictions

**Feature Branch**: `004-final-predictions`

**Created**: 2026-05-15

**Status**: Draft

**Input**: User description: "Vertical slice covering FR-009 (submission of champion, runner-up, top scorer, and best player picks before first kickoff) and FR-010 (immutability at first kickoff). Implements BR-LOCK-005."

**Architecture anchors**:

- Implements **FR-009, FR-010**
- Satisfies §15.1 scenarios: *Submit final predictions before first kickoff*, *Edit final predictions after first kickoff*
- Anchors to BR-LOCK-001, BR-LOCK-005 from `scoring-model.md`
- Depends on OD-004 (top-scorer ties) and OD-005 (best-player source) — both are *scoring* decisions, deferred to Slice 005; this slice only governs submission and lock
- Constitution principles in force: II (Security by Design), III (Rules Outside the UI), V (Auditability), VI (Time-Zone Correctness)

## Clarifications

### Session 2026-05-17

- Q: When a player is removed from a roster AFTER a participant picked them but BEFORE lock, what does "the pick MUST become invalid" mean operationally? → A: **Keep the row active; evaluate at score time.** The `final_predictions` row referencing the removed player is NOT mutated, NOT auto-superseded, and NO `invalidated_*` column is added. The system MUST: (1) emit a `final_prediction.target_player_removed` `audit_log` row at the moment the player is marked removed (one row per affected active prediction), (2) surface an in-app warning banner on the participant's final-predictions page reading "Your pick is no longer on the roster — please re-pick", (3) at scoring time (Slice 005), join `players.removed_at IS NULL` and treat any rows pointing at removed players as `no_valid_prediction` → 0 points. Rationale: preserves the participant's submission history without data mutation, leverages the existing `players.removed_at` soft-delete column, and gives the participant explicit agency to re-pick or accept the invalidation. The "invalid" state is a runtime evaluation (player has `removed_at IS NOT NULL`), not a stored state on the pick row.
- Q: Can a participant pick the same player as BOTH `top_scorer` AND `best_player`? → A: **Yes — allowed.** Unlike champion/runner-up (which MUST be distinct teams because the runner-up by definition is not the champion), the Golden Boot (top scorer) and Golden Ball (best player) are independent awards that the same player has historically won (e.g., 1982 Paolo Rossi). The `submit_final_prediction` SP MUST NOT enforce a disjoint check between `top_scorer` and `best_player`. UI MAY render an informational note when the participant has picked the same player for both, but MUST NOT block submission. Rationale: forbidding would prevent realistic forecasts; the awards are conceptually distinct.
- Q: How is an unsubmitted pick at lock time "recorded explicitly" per FR-008? → A: **Inferred by absence at score time; no placeholder rows.** The system MUST NOT insert placeholder `final_predictions` rows for unsubmitted items at lock time. No sweep job, no trigger-driven insert, no NULL-target rows. Slice 005's `score_finals(run_id)` MUST iterate the (participants × item_kinds) cross product and LEFT JOIN against `final_predictions WHERE superseded_at IS NULL`; rows with no match MUST be scored 0 with `reason_code='no_valid_prediction'`. The "explicit record" is satisfied by the audit log's absence of any `final_prediction.created` row for that (participant, item) pair — itself an auditable fact. Rationale: simplest implementation; no special-case code; aligns with how scheduled-but-unfinished matches are handled in Slice 003 (absence at scoring time → 0 points).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Participant submits four final predictions before first kickoff (Priority: P1)

An eligible participant chooses their four picks — champion team, runner-up team, top scorer (player), best player (player) — and submits them before the first official tournament match starts. The application persists them and confirms.

**Why this priority**: These four picks contribute up to 80 points (FR-012) and are the participant's most-deliberated decisions. Without working submission, no tournament-wide engagement happens.

**Independent Test**: Sign in as an eligible participant well before first kickoff, submit four picks, verify they persist across sign-out / sign-in, and verify all four appear in the participant's profile area as the active final-prediction set.

**Acceptance Scenarios**:

1. **Given** an eligible participant and trusted server time strictly before the first match's canonical UTC kickoff, **When** they submit a complete set of four final predictions (champion team, runner-up team, top scorer player, best player player), **Then** the set MUST be persisted as the active final-prediction set, returned in confirmation, and recorded in the audit trail with previous and new values.
2. **Given** an eligible participant before first kickoff, **When** they submit only some of the four picks (e.g., champion and runner-up but not top scorer or best player), **Then** the submitted picks MUST be persisted individually and the unset picks MUST remain unset; the four items MUST be independently editable.
3. **Given** an eligible participant before first kickoff with an existing final-prediction set, **When** they submit a new pick for any single item, **Then** that item MUST be replaced and the prior value preserved as superseded history, while the other three items remain unchanged.

### User Story 2 - System rejects edits after first kickoff (Priority: P1)

Once trusted server time reaches the first official match's kickoff, all four final predictions become immutable globally. No participant — through UI or API — may add, change, or remove a pick after that instant.

**Why this priority**: The first-kickoff lock (BR-LOCK-005, FR-010) is hard product law and is the most-watched scoring boundary in the product.

**Independent Test**: At an offset of -1 second from first kickoff, submit a final-prediction edit and verify ACCEPT. At exactly first kickoff and +1 second, attempt to edit via UI and via direct API and verify REJECT in both cases. Verify the rejection is audited.

**Acceptance Scenarios**:

1. **Given** trusted server time equal to the first match's canonical UTC kickoff, **When** any participant attempts to create or modify any final prediction (UI or API), **Then** the request MUST be rejected (BR-LOCK-005); no record MUST be created or updated.
2. **Given** trusted server time after the first match's kickoff, **When** any participant attempts to modify any final prediction, **Then** the request MUST be rejected with the same denial reason regardless of entry path (UI / API / direct database — server enforcement only).
3. **Given** trusted server time at first_kickoff − 1 second, **When** a participant submits a valid edit, **Then** the edit MUST be accepted and audited.
4. **Given** unsubmitted picks at the moment of first kickoff, **When** the lock fires, **Then** those picks MUST remain unset and MUST be treated by Slice 005 as "no valid prediction" (0 points).

### User Story 3 - Participant updates final predictions any number of times before lock (Priority: P2)

A participant may edit any of their four picks repeatedly before first kickoff. Each edit replaces the active value, retains the prior value as audit history, and is independent across the four items.

**Why this priority**: Final predictions are typically refined as more information comes out before the tournament (roster announcements, friendly results). Re-editing is expected behavior, not exceptional.

**Independent Test**: Submit champion = Team A. Later edit to Team B. Later edit to Team C. Verify Team C is the active champion pick, Teams A and B are retrievable as superseded versions, and the other three picks are unaffected.

**Acceptance Scenarios**:

1. **Given** an existing final-prediction set, **When** the participant edits any one item, **Then** that item's prior value MUST be preserved as a superseded version with timestamp and the new value MUST become active.
2. **Given** repeated edits to the same item, **When** the participant views their final-prediction history, **Then** the full ordered sequence MUST be reconstructible from audit data.

### Edge Cases

- Participant attempts to submit at exactly first kickoff (UTC equal) → REJECT (strict boundary).
- Participant attempts to submit at first_kickoff + 1 millisecond → REJECT.
- First match is postponed and a different match becomes the new "first" → the lock MUST follow the new first kickoff per BR-LOCK-005 and the catalog correction from Slice 002; an audit event MUST identify the change.
- Participant picks the same team for champion AND runner-up → REJECT by default; the spec assumes default policy is "reject identical champion/runner-up". This is a configurable rule per Slice 008.
- Participant picks a player as top scorer or best player who is not on any tournament roster (e.g., a name typo or a player who was cut) → REJECT with a validation error; the player must exist in the roster reference data sourced via Slice 002.
- A player is removed from a roster AFTER a participant picked them but BEFORE lock → per Clarifications 2026-05-17, the `final_predictions` row MUST remain active and unmutated; an `audit_log` row with `action='final_prediction.target_player_removed'` MUST be emitted at the moment of player removal; an in-app warning banner MUST be surfaced on the participant's final-predictions page; the participant MAY re-pick a different player before lock; if not re-picked, scoring at Slice 005 MUST evaluate `players.removed_at IS NOT NULL` and treat the pick as `no_valid_prediction` (0 points). The participant's pick row itself is NOT modified by the player removal.
- A participant picks the same player as both top scorer AND best player → ALLOWED per Clarifications 2026-05-17 (Golden Boot and Golden Ball can go to the same player historically). The `submit_final_prediction` SP MUST NOT enforce a disjoint check between `top_scorer` and `best_player`. UI MAY render an informational note but MUST NOT block.
- A team is eliminated from the tournament before the runner-up determination AND a participant had picked them as runner-up → handled at scoring time (Slice 005); this slice does not invalidate retroactively, but DOES allow the participant to re-pick if remaining time permits.
- Concurrent edits from the same participant to the same final-prediction item from two tabs → exactly one MUST be the active value; the other MUST be a superseded version.
- Direct API attempt to insert/modify a final prediction after lock with a token from a participant who never submitted before → REJECT (lock is global).
- The first-kickoff time itself is corrected by the provider after some participants have already locked in → the new lock time MUST be applied; audit event MUST identify participants whose status changed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow each eligible participant to submit predictions for four independently-editable items — champion team, runner-up team, top scorer player, best player player — before the canonical UTC kickoff of the first official tournament match (architecture FR-009).
- **FR-002**: System MUST treat the four items as independently editable: any one can be set, updated, or left unset without affecting the others.
- **FR-003**: System MUST prevent creation or modification of any final prediction once trusted server time is at or after the first official match's canonical UTC kickoff (BR-LOCK-005, architecture FR-010).
- **FR-004**: System MUST enforce the lock identically at UI and API; UI gating alone is insufficient (Constitution Principle III).
- **FR-005**: System MUST consult only trusted server time for the lock decision; client-supplied time MUST be ignored (BR-LOCK-001).
- **FR-006**: System MUST validate that team picks (champion, runner-up) reference teams that exist in the catalog and that player picks (top scorer, best player) reference players that exist in the roster reference data.
- **FR-007**: System MUST by default reject identical champion and runner-up picks; this validation rule MUST be configurable per Slice 008.
- **FR-008**: System MUST treat any unsubmitted pick at lock time as "no valid prediction." Per Clarifications 2026-05-17, the system MUST NOT insert placeholder `final_predictions` rows for unsubmitted items; scoring (Slice 005's `score_finals`) MUST iterate the (participants × item_kinds) cross product and LEFT JOIN against `final_predictions WHERE superseded_at IS NULL`, treating non-matching rows as `reason_code='no_valid_prediction'` (0 points). The "explicit record" required by FR-011 is satisfied by the audit log's absence of any `final_prediction.created` row for that (participant, item) pair.
- **FR-009**: System MUST follow a corrected first-kickoff time from Slice 002 for the global lock decision and MUST emit an audit event identifying any pick that flipped state (open ↔ locked) as a result.
- **FR-010**: System MUST maintain exactly one active value per (participant, item) pair while preserving every prior submission as immutable history.
- **FR-011**: System MUST record every final-prediction create, update, lock-time decision, and rejected attempt to the audit trail (Slice 007).
- **FR-012**: System MUST handle the case where a referenced player is removed from a roster after submission but before lock by invalidating the pick and signaling the participant; this is informational — Slice 008 governs notification policy.

### Key Entities

- **Final Prediction Set (active)**: The currently effective four picks for a participant. Attributes: participant, champion team (optional until set), runner-up team (optional until set), top scorer player (optional until set), best player player (optional until set), last_edited_at per item.
- **Final Prediction Version (history)**: An immutable record of a prior pick for one item, retained for audit. Attributes: participant, item kind, previous value, new value, edited_at, audit event id.
- **First Kickoff Reference**: The canonical UTC kickoff of the first official match, sourced from Slice 002. Determines the global lock instant for this slice.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of edit attempts at or after first kickoff are rejected; 100% of edit attempts at first_kickoff − 1 second are accepted — verified by automated boundary tests.
- **SC-002**: 100% of direct-API attempts to modify final predictions after lock receive the same denial as UI attempts.
- **SC-003**: A participant can submit or edit all four picks in under 90 seconds from sign-in to confirmation, under normal load.
- **SC-004**: Across 1,000 simulated concurrent edits to the same (participant, item) pair, exactly one active value exists at the end and every submitted version is retrievable.
- **SC-005**: A first-kickoff correction from Slice 002 takes effect for new lock decisions within 1 minute and is fully audited.
- **SC-006**: 100% of final-prediction create, update, and rejected attempts produce a corresponding audit event in the same transaction.

## Assumptions

- The catalog (Slice 002) maintains team and player reference data sufficient to validate team and player picks; this slice does not maintain its own roster source.
- The default "reject identical champion/runner-up" rule is documented as configurable per Slice 008; sponsors may choose to allow it.
- Notification policy (e.g., "tell the participant their picked player was removed from a roster") is governed by Slice 008 and the open OD-008 decision; this slice produces the signal but does not own the channel.
- Top-scorer ties and best-player source (OD-004, OD-005) are *scoring-time* decisions handled in Slice 005; this slice does not pre-resolve them.
- Eligibility (Slice 001) is satisfied for every participant interaction.
