# Acceptance Criteria & Test Scenarios

Extracted from §15 of [`high-level-architecture.md`](high-level-architecture.md). The `.docx` is the source of truth if anything diverges.

## §15.1 Core Test Scenarios

Each scenario below is tagged with the FR(s) it validates. Use as a flat checklist when building test coverage.

### Access

- [ ] **Approved domain login** — User with approved Nortal domain can access the app → access granted, profile created or updated. *(FR-001, FR-003)*
- [ ] **Rejected domain login** — User with non-approved domain attempts access → access denied, no profile created, event logged. *(FR-001, FR-002, FR-018)*

### Match prediction lock boundaries

- [ ] **Submit > 60 min before kickoff** — User submits a prediction more than one hour before kickoff → prediction saved successfully. *(FR-005, FR-007)*
- [ ] **Edit at exactly kickoff − 60 min** — User attempts to edit at the boundary → edit rejected (lock is strict: must be *greater than* 60 minutes). *(FR-008, BR-LOCK-003)*
- [ ] **Edit at 59 min before kickoff** — User attempts to edit inside the lock window → edit rejected. *(FR-008)*
- [ ] **Edit at 61 min before kickoff** — User edits just outside lock window → edit accepted, audit history preserved. *(FR-007, FR-018)*

### Final predictions

- [ ] **Submit final predictions before first kickoff** — User submits champion, runner-up, top scorer, best player before first match → all four saved successfully. *(FR-009)*
- [ ] **Edit final predictions after first kickoff** — User attempts to modify after first match starts → edit rejected. *(FR-010, BR-LOCK-005)*

### Scoring

- [ ] **Exact-score award** — Predicted score equals official score → **10 points** awarded. *(FR-011)*
- [ ] **Correct-outcome award** — Predicted winner/draw is correct but exact score differs → **5 points** awarded. *(FR-011)*
- [ ] **Incorrect-outcome** — Predicted outcome is incorrect → **0 points** awarded. *(FR-011)*

### Recalculation & integration

- [ ] **Score correction recalc** — Official score is corrected after initial scoring → previous scoring preserved in audit history; new scoring is calculated. *(FR-015, FR-016, FR-018)*
- [ ] **Provider API failure** — Provider API fails temporarily → system retries per policy, alerts administrators if failure persists. *(FR-017, NFR-011, NFR-012)*

### Admin

- [ ] **Admin manual score correction** — Administrator manually corrects a score → correction requires reason/source and creates audit log entry. *(FR-015, FR-018)*

## §15.2 Acceptance Criteria

All bullets below are required before tournament launch:

- [ ] All **must-have** functional requirements have test evidence.
- [ ] All lock-related rules are verified around **boundary times**, including exactly 60 minutes before kickoff.
- [ ] All scoring scenarios are verified using known examples.
- [ ] Access with non-approved domains is blocked through **both UI and direct API attempts**.
- [ ] Audit logs are produced for prediction changes, administrative corrections, and recalculations.
- [ ] Leaderboard results match independently calculated expected values for a representative data set.
- [ ] Manual fallback procedures are tested before the tournament starts.
- [ ] The selected implementation platform passes security and operational readiness review.

## Cross-reference

Every must-have FR (FR-001 through FR-020 with priority "Must have") should map to at least one scenario above. Gaps below should be filled with additional scenarios during build planning:

| FR | Covered by | Status |
|---|---|---|
| FR-001 | Approved/Rejected domain login | ✅ |
| FR-002 | Rejected domain login | ✅ |
| FR-003 | Approved domain login | ✅ |
| FR-004 | *(implicit in all match scenarios — needs explicit catalog-sync test)* | ⚠️ Gap |
| FR-005 | Submit > 60 min before kickoff | ✅ |
| FR-006 | *(needs explicit "single active prediction" test)* | ⚠️ Gap |
| FR-007 | Edit 61 min before kickoff | ✅ |
| FR-008 | Boundary scenarios (60 / 59 min) | ✅ |
| FR-009 | Submit final predictions | ✅ |
| FR-010 | Edit final predictions after first kickoff | ✅ |
| FR-011 | Exact / correct-outcome / incorrect scoring | ✅ |
| FR-012 | *(needs explicit final-prediction scoring test)* | ⚠️ Gap |
| FR-013 | *(needs explicit leaderboard / tie-breaker test)* | ⚠️ Gap |
| FR-015 | Admin manual score correction | ✅ |
| FR-016 | Score correction recalc | ✅ |
| FR-018 | Multiple scenarios | ✅ |
| FR-020 | *(needs explicit configuration test)* | ⚠️ Gap |
