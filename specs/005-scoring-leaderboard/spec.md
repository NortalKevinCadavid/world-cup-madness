# Feature Specification: Scoring & Leaderboard

**Feature Branch**: `005-scoring-leaderboard`

**Created**: 2026-05-15

**Status**: Draft

**Input**: User description: "Vertical slice covering FR-011 (match scoring 10/5/0), FR-012 (final-prediction scoring 20 each), FR-013 (leaderboard with tie-breakers), and FR-014 (personal breakdown). Fills the §15 gaps for FR-012, FR-013."

**Architecture anchors**:

- Implements **FR-011, FR-012, FR-013, FR-014**
- Satisfies §15.1 scenarios: *Exact-score award*, *Correct-outcome award*, *Incorrect-outcome*; fills §15.3 gaps *(FR-012 needs explicit final-prediction scoring test, FR-013 needs explicit leaderboard / tie-breaker test)*
- Anchors to §7.2, §7.3, §7.4 from `scoring-model.md`
- All four open decisions affecting this slice (OD-002 knockout score basis, OD-004 top-scorer ties, OD-005 best-player source, OD-006 leaderboard visibility) were resolved on 2026-05-15 via `/speckit-clarify` — see the *Clarifications* section below. OD-003 was resolved as a consequence of OD-002.
- Constitution principles in force: III (Rules Outside the UI), V (Auditability), VII (Operational Resilience), VIII (Extensibility & Configuration)

## Clarifications

### Session 2026-05-15

- Q: Knockout match score basis (OD-002) → A: Regular time + extra time, excluding penalty shootouts. The official score used for prediction comparison is the score at end of extra time (when extra time is played) or end of regulation (when not); penalty shootout kicks are never counted. As a consequence (OD-003), participants predict only the on-pitch final score — there is no separate input for penalty shootouts.
- Q: Top-scorer ties policy (OD-004) → A: Follow FIFA's official Golden Boot tiebreaker (most goals → fewest minutes played → most assists). Exactly one player is the "official top scorer" for scoring purposes, and only participants who picked that player receive 20 points. Tied players who are not the officially-named Golden Boot winner do NOT count as correct picks.
- Q: Best player award source (OD-005) → A: FIFA Golden Ball — the official "Best Player of the Tournament" awarded by FIFA's Technical Study Group. The single named Golden Ball winner is the canonical correct answer for the best-player final-prediction item; only participants who picked that player receive 20 points.
- Q: Leaderboard visibility (OD-006) → A: Full participant display names are visible to all eligible participants on the global leaderboard. Eligibility is gated to Nortal employees (Slice 001), so the data stays inside the corporate boundary. No additional participant attributes beyond display name (already captured by FR-003) are exposed. The visibility policy remains a configurable value in Slice 008 so that a future regional privacy review or tournament edition can switch to anonymization or team-scoping without re-spec.
- Q: Peer-visible per-match breakdowns → A: Another participant's pick for a given match becomes visible to eligible peers ONLY after that match's prediction lock has passed (kickoff − lock_window per trusted server time, Slice 003 rules). Before lock, peer picks are strictly private. Final-tournament picks (Slice 004) follow the same rule against the first-match kickoff lock. Self-breakdowns are always visible to the participant. The visibility decision MUST be enforced server-side (Constitution Principle III).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Participant earns match points (10 / 5 / 0) (Priority: P1)

When a match finishes and its official score is available, each participant's prediction for that match is automatically scored: 10 points for exact score, 5 for correct outcome only, 0 otherwise. The participant sees the points reflected in their personal breakdown.

**Why this priority**: Match scoring is the dominant point source (theoretical max 1,040 of 1,120) and the most-watched live event. Every match generates score visibility.

**Independent Test**: Seed a finished match with an official score. Seed three participants with three predictions: exact, correct-outcome, incorrect. Trigger scoring. Verify each participant's breakdown shows 10, 5, 0 respectively, that totals roll up correctly, and that an audit event was created per scored prediction.

**Acceptance Scenarios**:

1. **Given** a finished match with official score 2-1 and a participant's prediction of 2-1, **When** scoring runs, **Then** the participant MUST be awarded exactly 10 points for that match (FR-011, §7.2).
2. **Given** a finished match with official score 2-1 and a participant's prediction of 3-2 (same outcome — home win, different exact score), **When** scoring runs, **Then** the participant MUST be awarded exactly 5 points for that match.
3. **Given** a finished match with official score 0-1 and a participant's prediction of 1-0, **When** scoring runs, **Then** the participant MUST be awarded exactly 0 points for that match.
4. **Given** a finished match and a participant with no valid prediction (never submitted, or invalidated by admin), **When** scoring runs, **Then** the participant MUST be awarded exactly 0 points for that match.
5. **Given** any scored prediction, **When** the score is calculated, **Then** an audit event MUST be recorded with prediction value, official score, points awarded, and the reason code (exact / correct-outcome / incorrect / no-prediction).

### User Story 2 - Participant earns final-prediction points (20 each) (Priority: P1)

After the tournament concludes (or as final-tournament awards become available), each participant's four final picks are scored: 20 points per correct pick (champion, runner-up, top scorer, best player), 0 otherwise. The participant sees these in their breakdown.

**Why this priority**: Final-prediction points contribute up to 80 of 1,120 and are the high-stakes, locked-at-first-kickoff picks that participants invest the most thought into.

**Independent Test**: Seed an official tournament result (champion = Team A, runner-up = Team B, top scorer = Player X, best player = Player Y). Seed participants with various correct/incorrect combinations. Run scoring. Verify each participant's total is exactly (correct_picks × 20) and that the breakdown shows which items were awarded.

**Acceptance Scenarios**:

1. **Given** an official champion = Team A and a participant who picked Team A as champion, **When** final scoring runs, **Then** the participant MUST receive exactly 20 points for the champion item.
2. **Given** an official runner-up = Team B and a participant who picked Team C as runner-up, **When** final scoring runs, **Then** the participant MUST receive exactly 0 points for the runner-up item.
3. **Given** all four items correct, **When** final scoring runs, **Then** the participant MUST receive exactly 80 points from final scoring.
4. **Given** the top-scorer item involves a tie on total goals among multiple players in the raw tournament data, **When** scoring runs, **Then** the system MUST resolve the tie using FIFA's official Golden Boot tiebreaker (most goals → fewest minutes played → most assists) to determine exactly one official top scorer, and only the participants who picked that single officially-named player MUST receive 20 points for the top-scorer item.

### User Story 3 - Participant sees the leaderboard ranked with deterministic tie-breakers (Priority: P1)

The leaderboard shows all eligible participants ranked by total points. When two or more participants have equal totals, deterministic tie-breakers apply in a fixed priority order; participants who remain tied after all configured tie-breakers share the same rank.

**Why this priority**: The leaderboard is the primary engagement surface — it drives day-to-day check-ins. Determinism (same ranking across reloads, across participants) is essential for trust.

**Independent Test**: Seed multiple participants with carefully chosen point profiles that exercise each tie-breaker level: pure point difference, tie broken by exact-score count, tie broken by correct-outcome count, tie broken by final-prediction points, and a residual tie that should be shared rank. Verify the rendered ranking and that two independent fetches return identical orderings.

**Acceptance Scenarios**:

1. **Given** any set of participants with different total points, **When** the leaderboard is rendered, **Then** participants MUST appear in strictly descending order by total points.
2. **Given** two participants tied on total points but with different exact-score counts, **When** the leaderboard is rendered, **Then** the participant with the higher exact-score count MUST rank higher (§7.4, tier 2).
3. **Given** two participants tied on total points AND exact-score count but with different correct-outcome counts, **When** the leaderboard is rendered, **Then** the participant with the higher correct-outcome count MUST rank higher (§7.4, tier 3).
4. **Given** two participants tied on the first three tiers, **When** the leaderboard is rendered, **Then** the participant with higher final-prediction points MUST rank higher (§7.4, tier 4).
5. **Given** two participants tied across all configured tie-breakers, **When** the leaderboard is rendered, **Then** they MUST share the same rank (§7.4, tier 6) and the next participant MUST take the appropriate skipped rank (standard "1, 2, 2, 4" pattern, unless dense ranking is configured).
6. **Given** the leaderboard is requested concurrently by many participants during a result-update window, **When** results refresh, **Then** every participant MUST see a consistent ordering for any given calculation version.

### User Story 4 - Participant sees a personal breakdown (Priority: P2)

The participant can see their points decomposed by match (with the reason code per match: exact / correct-outcome / incorrect / no-prediction) and by final-prediction item.

**Why this priority**: Provides the transparency that backs the leaderboard. Without breakdowns, the leaderboard feels opaque, which damages trust and engagement.

**Independent Test**: Sign in as a participant with a populated history, navigate to the personal breakdown, verify the sum of per-match points plus per-item points equals the total shown on the leaderboard. Verify the reason code per match matches the audit trail.

**Acceptance Scenarios**:

1. **Given** a participant with a populated scoring history, **When** they view their personal breakdown, **Then** they MUST see one row per match they participated in (or attempted to predict) with predicted score, official score, points awarded, and reason code.
2. **Given** the same participant, **When** they view their final-prediction breakdown, **Then** they MUST see one row per final item with their pick, the official result, points awarded.
3. **Given** the breakdown total, **When** it is summed, **Then** it MUST equal the participant's total on the global leaderboard.

### Edge Cases

- A match score is corrected after scoring already ran (Slice 006) → all affected participants MUST be re-scored; the prior scoring version MUST be retained in the audit trail; the leaderboard MUST reflect the new values within 1 minute of recalculation completing.
- A participant's score changes mid-leaderboard read by another user → readers MUST get a consistent view per calculation version; partial updates MUST NOT be visible.
- Raw goal totals are tied between two or more players → FIFA's official Golden Boot tiebreaker (goals → minutes → assists) selects exactly one official top scorer (OD-004 resolved). The audit trail MUST record the tiebreaker chain so disputes are resolvable.
- Knockout match goes to extra time → the end-of-extra-time score is the official score for prediction comparison (OD-002 resolved). Knockout match goes to penalty shootouts → the score at end of extra time is the official score; the shootout kicks MUST NOT be counted. The rule remains a configurable value in Slice 008 for future tournament editions.
- The FIFA Golden Ball award is delayed (typically named within hours of the final, but not always immediately) → admin (Slice 006) holds best-player scoring until FIFA's announcement is captured and confirmed; system MUST surface a "best-player scoring pending" state rather than guessing.
- A participant has no valid prediction for many matches (joined late, missed locks) → they appear on the leaderboard with the points they did earn; missed matches contribute 0.
- A participant is deactivated mid-tournament (e.g., left the company) → the participant MUST remain on the leaderboard with their display name for historical accuracy (OD-006 resolved) unless an administrator (Slice 006) explicitly hides them; the audit trail records both the deactivation and any administrative hiding.
- The leaderboard is requested before any matches have finished → it MUST render with all participants at 0 points, ordered by tie-breaker rules (all tied → all shared rank 1), without erroring.
- Out-of-order score arrivals from the provider (a later match scored before an earlier one) → scoring MUST be idempotent and order-independent; the final state must be identical regardless of arrival order.
- A configuration change to scoring values (e.g., 10/5/0 → 15/7/0) is applied mid-tournament → already-awarded points MUST be preserved in audit; future scoring uses new values; admin (Slice 006) may trigger a full re-score under the new values; the leaderboard surfaces the transition explicitly.
- A participant requests another participant's pick for a match at exactly kickoff − lock_window (the lock-boundary instant) → the visibility decision MUST use the same strict-greater-than rule as Slice 003 BR-LOCK-003: at the boundary the match is locked, so the peer pick MUST be visible. At lock_boundary − 1 second it MUST NOT be visible.
- A participant attempts to retrieve a peer's pick for an unlocked match via a direct API call → REJECT at the server boundary with the same denial as the UI; the rejection MUST be audited.
- A peer's pick was administratively invalidated (Slice 006) → the breakdown for that peer's match MUST display "no valid prediction" after lock, the same way it appears to that peer themselves; the underlying admin override MUST NOT be exposed to non-admin peers.
- Final-tournament picks viewed by peers before first kickoff → REJECT; visibility opens at first kickoff per Slice 004 lock.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST calculate match prediction points as: 10 for an exact-score match, 5 for correct-outcome-only, 0 for incorrect outcome or no valid prediction (architecture FR-011, §7.2).
- **FR-002**: System MUST calculate final-tournament prediction points as 20 per correctly predicted item (champion, runner-up, top scorer, best player), 0 otherwise (architecture FR-012, §7.3).
- **FR-003**: System MUST provide a leaderboard view ranked by total points across all eligible participants (architecture FR-013).
- **FR-004**: System MUST apply tie-breakers in this default priority order: (1) highest total points, (2) highest exact-score count, (3) highest correct-outcome count, (4) highest final-prediction points, (5) optional "earliest timestamp of last valid prediction" (only if approved per §7.4), (6) shared rank if still tied (§7.4).
- **FR-005**: System MUST allow the tie-breaker order to be reconfigured per Slice 008 (default §7.4 order).
- **FR-006**: System MUST provide each participant with a personal point breakdown showing per-match results (predicted score, official score, points awarded, reason code) and per-final-item results (pick, official result, points awarded) (architecture FR-014).
- **FR-007**: System MUST recalculate scoring when match results, final-tournament results, or scoring inputs change (architecture FR-016 — coordinated with Slice 006).
- **FR-008**: System MUST evaluate every knockout match prediction against the "regular time + extra time, excluding penalty shootouts" official score (resolved 2026-05-15, OD-002). When a knockout match is decided within regulation, the regulation result is the official score; when it goes to extra time, the end-of-extra-time score is the official score; penalty shootout kicks MUST never be counted. This rule MUST be uniformly applied across all knockout matches and MUST remain a configurable value in Slice 008 (so a future tournament can revisit the decision).
- **FR-009**: System MUST resolve top-scorer ties using FIFA's official Golden Boot tiebreaker (most goals → fewest minutes played → most assists), recognizing exactly one official top scorer per tournament (resolved 2026-05-15, OD-004). Only participants who picked the officially-named Golden Boot winner MUST receive the 20-point top-scorer award. The tiebreaker policy MUST remain a configurable value in Slice 008 for future tournaments.
- **FR-010**: System MUST use the **FIFA Golden Ball** (the official "Best Player of the Tournament" awarded by FIFA's Technical Study Group) as the canonical best-player source (resolved 2026-05-15, OD-005). Only participants whose best-player pick equals the officially-named Golden Ball winner MUST receive the 20-point best-player award. The source remains a configurable value in Slice 008 for future tournaments.
- **FR-011**: System MUST update the leaderboard within a bounded latency (default 1 minute) of any scoring or recalculation event.
- **FR-012**: System MUST present the leaderboard with a consistent ordering per calculation version (no partial-update flicker visible to readers).
- **FR-013**: System MUST record every score calculation, every recalculation, and every change in awarded points to the audit trail (Slice 007), with previous and new values.
- **FR-014**: System MUST display the global leaderboard with each participant's display name visible to every other eligible participant (resolved 2026-05-15, OD-006). No participant attributes beyond the display name captured by Slice 001 FR-003 MUST be exposed in the leaderboard view. The visibility policy MUST remain a configurable value in Slice 008 so a future privacy review or future tournament can switch to anonymization, top-N anonymization, team-scoping, or opt-in display without re-spec.
- **FR-015**: System MUST treat scoring values (10 / 5 / 0 / 20) as live configuration sourced from Slice 008; changes MUST trigger a configurable "re-score under new values" run via Slice 006.
- **FR-016**: System MUST allow an eligible participant to view another eligible participant's pick for a given match ONLY after that match's prediction lock has passed per trusted server time (kickoff − lock_window, Slice 003 rules) — resolved 2026-05-15. Before lock, peer picks for that match MUST NOT be exposed through any UI route or API. Final-tournament picks (Slice 004) MUST become peer-visible only after the first-match kickoff lock. Self-breakdowns are always visible to the participant regardless of lock state. The visibility decision MUST be enforced server-side; UI-only gating MUST NOT be the gate (Constitution Principle III).

### Key Entities

- **Score Record**: A scored result for one (participant, target) pair, where target is either a match or a final-prediction item. Attributes: participant, target kind, target id, predicted value, official value (or N/A), points awarded, reason code, calculated_at, calculation_version, source (auto / admin override).
- **Score Calculation Run**: A single execution of scoring or recalculation. Attributes: trigger (live result / admin recalc / configuration change), started_at, completed_at, affected score count, status. Written to the audit trail.
- **Leaderboard Entry (derived view)**: Per participant: total points, exact-score count, correct-outcome count, final-prediction points, rank, calculation_version. Derived from Score Records.
- **Tie-breaker Configuration (configuration reference)**: Ordered list of tie-breaker rules (default per §7.4). Managed in Slice 008.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Leaderboard for a representative seeded dataset matches an independently calculated expected result (§15.2) — verified by automated test fixtures.
- **SC-002**: A participant who scored exactly 10 + 5 + 0 in three respective matches plus one correct final pick has a total of exactly 35 in their breakdown.
- **SC-003**: Tied participants share rank deterministically across at least 10 consecutive reads under concurrent load (1,000 simulated readers).
- **SC-004**: Personal breakdown for a full tournament (104 matches + 4 final picks) loads in under 3 seconds under normal load.
- **SC-005**: After a corrected match score (Slice 006), every affected participant's leaderboard rank reflects the new value within 1 minute of recalculation completion.
- **SC-006**: Zero score records overwritten without an audit-trail entry; 100% of score changes have a corresponding audit event with previous and new values.
- **SC-007**: Scoring is idempotent: applying the same scoring run twice produces the same final state with no double-counting.
- **SC-008**: The leaderboard handles 1,000 concurrent reads during a result-update window without any reader seeing inconsistent partial updates.
- **SC-009**: 100% of attempts (UI and direct API) by one participant to view another participant's pick for a match whose lock has not yet passed are rejected at the server boundary and audited.

## Assumptions

- Match results and final-tournament results arrive from Slice 002 (provider sync) and may be administratively corrected via Slice 006.
- Tie-breaker order defaults to §7.4 but is reconfigurable per Slice 008.
- Scoring values (10 / 5 / 0 / 20) default to the architecture-document values and are reconfigurable per Slice 008.
- Open decisions affecting this slice: OD-002 knockout score basis, OD-003 penalty shootouts in predictions, OD-004 top-scorer ties, OD-005 best-player source, OD-006 leaderboard visibility — **all five resolved 2026-05-15 via `/speckit-clarify`; see Clarifications**. No spec-level open decisions remain for this slice. Implementation MUST still cross-check the parent `docs/architecture/open-decisions.md` to update OD-002…OD-006 status fields.
- Scoring is fully derivable from predictions plus official results; this slice does not store anything that cannot be recomputed from those inputs (except for audit history, which is immutable).
- Eligibility (Slice 001) governs who appears on the leaderboard; deactivated participants remain visible by name unless administratively hidden (OD-006 resolved; configurable via Slice 008).
