# Feature Specification: World Cup Bracket Team Selection

**Feature Branch**: `010-bracket-team-selection`

**Created**: 2026-05-26

**Status**: Draft

**Input**: User description: `C:\Users\kevin.cadavid\Downloads\worldcup_bracket_team_selection_spec.md` — "March Madness-style World Cup bracket game frontend: view all teams with flags, complete full bracket selections, see clear completion status, submit only when complete, and keep other players' brackets private until the game starts and submissions close."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View all teams with flags (Priority: P1)

A player opens the bracket and sees every team that participates in the knockout bracket, each shown with its name and flag, so they can recognize and choose teams confidently.

**Why this priority**: Nothing else in the bracket is usable until teams render legibly. It is the foundation every other story builds on, and it is independently demonstrable.

**Independent Test**: Load the bracket as an eligible player with no picks made; confirm every bracket team appears with a name and a flag (or a clear fallback when a flag is missing), and that the same team is rendered identically wherever it reappears in later rounds.

**Acceptance Scenarios**:

1. **Given** the bracket has loaded, **When** the player views it, **Then** every team assigned to the bracket is displayed with its name and flag.
2. **Given** a team has no flag available, **When** that team is displayed, **Then** a neutral fallback placeholder is shown in place of the flag with accessible alternative text.
3. **Given** a team that has advanced into a later round, **When** it appears again, **Then** it is rendered with the same visual treatment as in earlier rounds.
4. **Given** team data is still loading, **When** the player opens the bracket, **Then** a loading state is shown and no partial or incorrect team data is displayed.

---

### User Story 2 - Build the bracket by selecting winners (Priority: P1)

A player picks a winner for each matchup; the chosen team advances to the next round, and the bracket stays internally consistent as picks change.

**Why this priority**: This is the core game loop. Without winner selection and round advancement there is no bracket to complete or submit.

**Independent Test**: Starting from an empty bracket, select a winner in an early-round matchup and confirm that team appears as a competitor in the correct next-round matchup; then change the earlier pick and confirm dependent later-round picks that are no longer valid are cleared.

**Acceptance Scenarios**:

1. **Given** a matchup with two known teams, **When** the player selects one as the winner, **Then** that team advances into the dependent next-round matchup.
2. **Given** a later-round pick that depends on an earlier pick, **When** the player changes the earlier pick to a different team, **Then** any later picks that are no longer reachable are cleared.
3. **Given** a matchup whose competitors are not yet determined, **When** the player views it, **Then** it is shown as pending and cannot be selected.
4. **Given** a matchup with both competitors known, **When** the player interacts with it, **Then** exactly one winner can be selected at a time.
5. **Given** the bracket is locked or already submitted, **When** the player views any matchup, **Then** selections are read-only and cannot be changed.

---

### User Story 3 - Know completion status and submit only when complete (Priority: P1)

A player can always see how many picks are done versus required, is prevented from submitting an incomplete bracket, and can submit once every required matchup has a winner.

**Why this priority**: The product's integrity depends on never accepting an incomplete bracket. This story enforces the rule the whole game rests on.

**Independent Test**: With an incomplete bracket, confirm the submit control is disabled and the missing-pick count is shown; complete the final required pick and confirm the control enables; submit and confirm the bracket is revalidated before being accepted.

**Acceptance Scenarios**:

1. **Given** an incomplete bracket, **When** the player views the submit control, **Then** it is disabled and the number of completed-versus-required picks (and how many remain) is shown.
2. **Given** every required matchup has a winner, **When** the player views the bracket, **Then** it is marked complete and the submit control is enabled.
3. **Given** a complete bracket, **When** the player submits, **Then** the system revalidates completeness before saving and rejects the submission if it is not actually complete.
4. **Given** a submitted bracket, **When** the player returns before the lock deadline, **Then** the bracket is shown as submitted but remains editable; changing a pick and re-submitting supersedes the prior submission (FR-028).
5. **Given** submissions have closed (lock deadline passed), **When** the player views the bracket, **Then** it is shown as locked and cannot be edited; a complete bracket that was never explicitly submitted is auto-accepted, while an incomplete one is frozen as incomplete (FR-029).

---

### User Story 4 - Other players' brackets stay private until lock (Priority: P1)

Before the game starts and submissions close, a player can see only their own bracket; no other player's picks, links, names, or previews are reachable. After lock, public viewing may open (if the product allows it).

**Why this priority**: This is a security and fairness guarantee. A leak before lock would let players copy or counter others' predictions, undermining the whole pool. It must hold at the server boundary, not just visually.

**Independent Test**: As player A with submissions open, attempt to reach player B's bracket by every available path (navigation, direct link, any preview surface); confirm none expose B's data and that a direct request for B's bracket is refused at the server. After the lock deadline with the game started, confirm viewing other brackets behaves per the product's public-viewing rule.

**Acceptance Scenarios**:

1. **Given** submissions are open, **When** player A is anywhere in the app, **Then** no other player's bracket data, links, previews, names, or pick details are shown.
2. **Given** the game has not started, **When** player A attempts to open player B's bracket directly, **Then** the system shows an access-denied or unavailable message and reveals nothing about B's bracket.
3. **Given** a direct server request for another player's bracket before lock, **When** it is received, **Then** the server refuses it regardless of how the request was crafted (visual hiding alone is insufficient).
4. **Given** submissions are closed and the game has started, **When** the product permits public viewing, **Then** other players' brackets may be viewed read-only.

---

### User Story 5 - Consistent status everywhere from one source (Priority: P2)

Every place the bracket's progress or state appears — header indicator, submit control, warnings, mobile footer, review screen, confirmation screen — shows the same figures and state, derived from a single shared calculation.

**Why this priority**: Inconsistent counts ("12 of 31" in the header but a disabled submit button labeled "complete") erode trust and create support load. It is important but depends on Stories 2 and 3 existing first, so it is P2.

**Independent Test**: Change a single pick and confirm the completed/required counts and the complete/incomplete/submitted/locked state update identically in every location that displays them, with no location lagging or disagreeing.

**Acceptance Scenarios**:

1. **Given** bracket progress is shown in multiple places, **When** the player views them at the same moment, **Then** all show identical completed/required counts and the same submission state.
2. **Given** the player changes a pick, **When** the change is applied, **Then** every progress display updates consistently.
3. **Given** the bracket transitions to complete, **When** the player observes the UI, **Then** the header, submit control, status badge, and review screen all reflect "complete" together.
4. **Given** the bracket becomes locked, **When** the player observes any status surface, **Then** the locked state is shown consistently everywhere.

---

### Edge Cases

- **Mid-bracket pick reversal cascade**: changing an early-round winner must invalidate every downstream pick that relied on that team reaching a later round — including the champion — and the completion count must drop accordingly.
- **Team eliminated then re-selected**: if a player picks team X as champion, then changes an earlier round so X can no longer reach the final, the champion pick must clear rather than silently persist an impossible outcome.
- **Submission race at the deadline**: a player submits at the instant the lock deadline passes — the system must apply the lock boundary consistently (a submission accepted just before lock stands; one arriving at/after lock is refused).
- **Stale completion state**: a bracket marked "ready to submit" in the client, then submitted after the server's required-matchup set changed, must be revalidated server-side and refused if no longer complete.
- **Empty team set**: if no teams are available yet, the player sees a clear "not available yet" message rather than an empty or broken bracket.
- **Load/submit failure**: if team or bracket data fails to load, or a submission fails, the player sees an error with a retry path and their in-progress picks are preserved where possible.
- **Direct-link probing for another bracket**: a crafted request for another player's bracket before lock returns an access-denied result and leaks nothing (existence, owner identity, or contents).

## Requirements *(mandatory)*

### Functional Requirements

**Team display**

- **FR-001**: System MUST display every team assigned to the knockout bracket, each with its name and flag.
- **FR-002**: System MUST render a neutral fallback placeholder, with accessible alternative text, when a team's flag is unavailable.
- **FR-003**: System MUST render the same team identically wherever it appears across rounds.

**Bracket selection**

- **FR-004**: Users MUST be able to select exactly one winner per matchup that has two known competitors.
- **FR-005**: System MUST advance a selected winner into the correct dependent next-round matchup.
- **FR-006**: System MUST clear any later-round picks that become invalid when an earlier pick changes.
- **FR-007**: System MUST present matchups whose competitors are not yet determined as pending and non-selectable.
- **FR-008**: System MUST prevent any edit to a bracket once the lock deadline (first kickoff) has passed. Before the lock deadline, a submitted bracket remains editable (see FR-028) — submission alone does not freeze it.

**Completion & submission**

- **FR-009**: System MUST treat a bracket as complete only when every required matchup has a selected winner.
- **FR-010**: System MUST keep the submit control disabled while the bracket is incomplete or locked. When the bracket is complete (whether or not already submitted), the control is enabled and labeled to reflect submit-vs-resubmit, since re-submission is permitted until lock (FR-028).
- **FR-011**: System MUST show, at all times, how many picks are completed versus required and how many remain.
- **FR-012**: System MUST revalidate completeness at submission time and reject a submission that is not actually complete.
- **FR-013**: System MUST enforce completeness and edit-lock rules at the server boundary, independently of any client-side checks.

**Consistent status**

- **FR-014**: System MUST derive every progress/state display from a single shared status calculation so all surfaces agree.
- **FR-015**: System MUST update all status surfaces consistently whenever a pick changes or the submission state transitions (draft → complete → submitted → locked).

**Privacy & visibility**

- **FR-016**: System MUST allow a player to view only their own bracket while submissions are open.
- **FR-017**: System MUST hide all other players' bracket data, links, previews, names, and pick details before the game starts and submissions close.
- **FR-018**: System MUST refuse, at the server boundary, any request for another player's bracket before the lock condition (game started AND submissions closed) is met, without leaking existence, ownership, or contents.
- **FR-019**: System MUST provide read-only viewing of other players' brackets after the lock (game started AND submissions closed). This post-lock peer-view surface is in scope for this slice (per Q5) and is gated server-side; before lock it returns nothing (FR-018).
- **FR-020**: System MUST make submitted brackets read-only once the submission deadline has passed.

**Resilience & accessibility**

- **FR-021**: System MUST show a loading state while team and bracket data are fetched, and MUST NOT allow submission or display partial bracket data during loading.
- **FR-022**: System MUST show a clear empty-state message when no teams are available, and retry affordances when team data, bracket data, or a submission fails — preserving in-progress picks where possible.
- **FR-023**: System MUST make team selection keyboard-accessible, convey selected state without relying on color alone, provide meaningful flag alternative text and button labels, explain why a disabled submit control is unavailable, and expose status messages to assistive technology.
- **FR-024**: System MUST be usable on mobile, keeping completion status visible or easily accessible and avoiding horizontal scrolling where possible (or providing clear round-to-round navigation when a horizontal layout is necessary).

**Scope integration**

- **FR-025**: System MUST treat this bracket as a standalone game, independent of the existing final-tournament predictions (champion / runner-up / top-scorer / best-player). It MUST NOT read from, write to, or alter those predictions; the two coexist without coupling. (Resolved: Q2 → standalone.)
- **FR-026**: System MUST start the bracket from a fixed, pre-seeded Round-of-32 field (the 32 qualifiers and their bracket positions are defined by seed/admin data, not predicted by the player). The bracket covers knockout rounds only: Round of 32 → Round of 16 → Quarterfinals → Semifinals → Final → Champion. Group-stage advancement prediction is out of scope. (Resolved: Q1 → fixed R32 seeding.)
- **FR-027**: System MUST require a winner for every knockout matchup from the Round of 32 through the Final (31 matchups for a 32-team single-elimination bracket); the Champion is the Final's winner and is not a separate required pick.

**Submission lifecycle** *(resolved via Q3, Q4)*

- **FR-028**: System MUST allow a participant to re-submit (edit then submit again) any number of times before the lock deadline; each submission supersedes the prior one. Submission does not make the bracket read-only — only the lock deadline does (FR-008).
- **FR-029**: At the lock deadline, System MUST auto-accept a complete-but-unsubmitted bracket as its final submission, and MUST freeze an incomplete bracket read-only in its incomplete state (it is NOT auto-completed and is not treated as a valid submission). All brackets become read-only at lock regardless of prior submit state.

**Seeding source** *(resolved via Q6)*

- **FR-030**: System MUST source the fixed Round-of-32 field (the 32 qualifiers and their bracket positions) from seed/configuration data loaded outside the participant flow. No participant- or admin-facing seeding interface is in scope for this slice.

### Key Entities *(include if feature involves data)*

- **Team**: a national side eligible to appear in the bracket. Attributes: display name, flag (with graceful absence), and optional metadata such as seed, ranking, or group. Reused wherever the team appears.
- **Matchup**: a single pairing within a round. Attributes: the round it belongs to, its position, its (possibly not-yet-known) two competitors, the selected winner, and which next-round matchup the winner feeds into.
- **Pick**: a player's selection of a winner for one matchup.
- **Bracket (per player)**: the full set of a player's matchups and picks plus its derived status and visibility state.
- **Bracket Status**: the single source of truth for progress — total required picks, completed picks, completeness flag, which picks are missing, and submission state (draft / complete / submitted / locked).
- **Visibility State**: the conditions governing what a player may view — own-bracket access, other-bracket access, whether submissions are open, whether the game has started, and whether the bracket is locked.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of bracket teams render with a recognizable flag or an explicit fallback placeholder; no team renders blank.
- **SC-002**: 0% of incomplete brackets can be submitted — every submission attempt below 100% required picks is refused both in the UI and at the server.
- **SC-003**: At least 95% of players who start a bracket can complete every required pick without assistance (no support contact, no error dead-end).
- **SC-004**: Completed-versus-required counts and submission state are identical across every surface that displays them, with no observable disagreement during normal use.
- **SC-005**: 0% of attempts to view another player's bracket before lock succeed — neither through the interface nor through direct server requests — and no other-player data is present in delivered client data before lock.
- **SC-006**: A pick change that invalidates downstream picks reflects the corrected (lower) completion count immediately, with no impossible advanced picks left selected.
- **SC-007**: The bracket is fully operable by keyboard and screen reader, and on a 375px-wide mobile viewport without horizontal scrolling on the primary completion flow.

## Assumptions

- **Reuses the existing tournament lock**: "the game starts / submissions close" maps to the project's existing first-kickoff lock signal rather than introducing a new deadline mechanism.
- **Eligibility reuses existing access control**: only approved, signed-in pool participants can open a bracket; the bracket inherits the project's existing participant eligibility gate.
- **Fixed Round-of-32 seeding (Q1)**: the 32 qualifiers and their bracket positions come from seed/admin data; players do not predict group-stage advancement. The knockout field is known before bracket-fill begins.
- **Standalone game (Q2)**: this bracket does not read, write, or replace the existing slice-004 final-tournament predictions; the two run independently.
- **One bracket per player per tournament**: each player maintains a single bracket; multiple competing entries per player are out of scope.
- **Submission is reversible until lock; lock is the only freeze point (Q3)**: re-submission supersedes; complete drafts auto-submit at lock; incomplete brackets freeze read-only as incomplete (Q4).
- **Post-lock public viewing is in scope (Q5)**: the peer-view surface ships this slice, server-gated to post-lock only.
- **R32 seeding is seed/config data, no admin UI (Q6)**: the knockout field is loaded outside the participant flow.
- **Standard responsive-web expectations**: loading, empty, and error states follow common web conventions; no native mobile app is in scope.

## Clarifications

### Session 2026-05-26

- **Q1 — First-round field**: Does the bracket start from a fixed, already-seeded Round-of-32 field, or must the player first predict group-stage advancement (48 → 32) before the knockout picks begin? → **A: Fixed, pre-seeded Round-of-32 field.** Players pick knockout winners only (R32 → Champion); group-stage prediction is out of scope. Binds FR-026, FR-027.
- **Q2 — Relationship to existing final predictions**: Is this bracket a standalone game, or does it integrate with / replace the existing slice-004 final-tournament predictions? → **A: Standalone new game.** Independent data, lock, and submission; no coupling to slice-004 finals. Binds FR-025.
- **Q3 — Edit after submit, before lock**: Can a participant edit their bracket after submitting but before the lock (first kickoff)? → **A: Yes, editable until lock.** Re-submission is allowed any time before `first_kickoff_utc` (mirrors slice-003/004 supersede behavior); only the lock is final. Binds FR-008, FR-010, FR-028.
- **Q4 — Unsubmitted bracket at lock**: At lock, what happens to a bracket never explicitly submitted? → **A: Complete drafts auto-submit; incomplete are locked as-incomplete.** A complete-but-unsubmitted bracket is auto-accepted at lock; an incomplete one is frozen read-only in its incomplete state (not auto-completed). Binds FR-029.
- **Q5 — Post-lock public viewing scope**: Is post-lock public viewing of other players' brackets in scope for this slice? → **A: Yes, build it now.** The post-lock peer view + route ship this slice (gated, server-enforced, post-lock only). Binds FR-019 (now in-scope, not merely "MAY").
- **Q6 — R32 seed source**: Where does the fixed Round-of-32 seeding come from this slice? → **A: Seed/config data only.** The 32 qualifiers + bracket positions are loaded via seed/migration + `tournament_config`; no admin seeding UI this slice. Binds FR-026, FR-030.

## Non-Goals

- Does not compute real match results or determine actual tournament outcomes.
- Does not score brackets or rank players against actual results.
- Does not manage admin team seeding or group assignment.
- Does not handle payments, prizes, or entry fees.
- Does not expose any other player's picks before the game starts and submissions close.
