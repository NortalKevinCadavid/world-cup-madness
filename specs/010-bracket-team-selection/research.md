# Phase 0 Research: World Cup Bracket Team Selection

All NEEDS CLARIFICATION items from the spec were resolved in the clarification session (2026-05-26). This document records the technical decisions that flow from the spec + the project's established patterns.

## R-001 — Lock signal source

**Decision**: Reuse `tournament_config.first_kickoff_utc` (BR-LOCK-005) as the single submissions-close / game-starts boundary. Submissions are open while `now() < first_kickoff_utc`; the bracket locks at/after it.

**Rationale**: The project already centralizes the tournament-start lock for slice-004 final predictions and slice-005 peer visibility. Introducing a separate bracket deadline would violate Principle VI (one globally consistent lock) and duplicate config surface.

**Alternatives considered**: A dedicated `bracket.submission_deadline` config key — rejected; adds a second source of truth for "game started" with no product reason to diverge.

## R-002 — Cross-participant privacy enforcement

**Decision**: Two views. `bracket_v` (self-only, `security_invoker = true`, gated by the picks table's self-RLS) for own-bracket reads. `bracket_peer_v` (`security_invoker = false` / DEFINER) for post-lock peer reads, with the lock predicate (`now() >= first_kickoff_utc`) AND self-exclusion in the view body — exactly the posture slice-005's `peer_pick_v` / `peer_final_pick_v` landed on after the migration-0082 follow-up.

**Rationale**: Bracket picks live in a self-only RLS table (like predictions). A peer view that aggregates across participants must run DEFINER or the underlying self-RLS collapses every non-admin caller's result to their own rows (the exact bug fixed in `follow-up-peer-views-rls-design-gap.md` this session). Starting DEFINER avoids re-discovering that.

**Alternatives considered**: `security_invoker = true` peer view — rejected, proven broken in slice 005. Admin-only peer reads — rejected, the product wants public post-lock viewing (FR-019).

## R-003 — Server-side completeness validation

**Decision**: A `submit_bracket(p_run_token)` SECURITY DEFINER RPC that, in one transaction: (1) checks the caller is eligible; (2) checks `now() < first_kickoff_utc` (not locked); (3) recomputes completeness from `bracket_matchups` + `bracket_picks` (all 31 required matchups have a valid winner whose competitors match the resolved bracket); (4) writes/updates `bracket_submissions` to `submitted`; (5) emits an `audit_log` row in the same transaction. Returns the new submission state or a typed error code.

**Rationale**: Principle II/III — the gate cannot be client-only (FR-013). Recomputing server-side defends against stale client state (spec edge case "stale completion state"). Same-transaction audit satisfies Principle V.

**Alternatives considered**: Trusting a client-sent `isComplete` flag — rejected outright (client-only gate). A DB CHECK constraint on a "submitted" column — rejected; can't express the 31-matchup cross-row completeness rule cleanly.

## R-004 — Single status calculation (one source of truth)

**Decision**: A `bracket_status(p_participant_id)` SQL function returns `(total_required, completed, is_complete, missing_matchup_ids[], submission_status)`. `bracket_v` projects it so the API returns status alongside picks. The client `lib/bracket/status.ts` mirrors the SAME shape for instant in-progress display while editing, but the server value is authoritative on read and submit (FR-014).

**Rationale**: Principle III — one reusable layer. Header, submit button, badge, mobile footer, review, and confirmation all consume the one server-projected shape; the client mirror is display-only and never gates submission.

**Alternatives considered**: Client-only status — rejected (Principle III). Per-surface recomputation — rejected (the inconsistency FR-014/SC-004 explicitly forbid).

## R-005 — Downstream-pick cascade on change

**Decision**: When a participant changes an earlier-round winner, any later pick whose chosen team can no longer reach that matchup is cleared. Client computes the cascade for instant UX (`lib/bracket/cascade.ts`); the pick-write endpoint re-derives and persists the authoritative cleared set so a refresh shows the corrected bracket.

**Rationale**: Spec edge cases ("pick reversal cascade", "team eliminated then re-selected") require the impossible-advanced-pick to clear, not silently persist. Doing it both client (UX) and server (truth) keeps the count honest (SC-006) without a client-only authority.

**Alternatives considered**: Block earlier changes once later picks exist — rejected, hostile UX. Clear the entire downstream subtree unconditionally — rejected; only picks made *impossible* by the change should clear (a later pick for a team still able to reach that slot stays valid).

## R-006 — Bracket structure as seed data

**Decision**: `bracket_matchups` stores the fixed tournament shape: 31 rows (16 R32, 8 R16, 4 QF, 2 SF, 1 Final), each with `round`, `position`, `next_matchup_id`, `next_slot` (A/B), and — for the 16 R32 rows — the two seeded `team_a_id` / `team_b_id`. Later rounds' competitors are resolved from upstream winners, not stored statically.

**Rationale**: Principle VIII — structure is data, not hard-coded UI. A future group-stage-prediction slice can repopulate R32 seeds per participant without touching the knockout logic. The fixed-seed decision (Q1) means R32 competitors are global, not per-participant.

**Alternatives considered**: Hard-coding the bracket tree in the frontend — rejected (Principle VIII, and it would duplicate the structure the server must validate against).

## R-007 — Frontend component reuse

**Decision**: Build `FlagImage` on top of the slice-009 `Flag` component where its API fits; build `MatchupCard`/`TeamOption` from slice-009 `Card`/`Button` primitives. The status surfaces (`BracketProgressSummary`, `BracketStatusBadge`, `SubmitBracketButton`) consume the one status shape (R-004).

**Rationale**: Principle X + slice-009's design-system contract (frozen primitive set). Avoids a parallel component library and keeps theme/motion/i18n consistent.

**Alternatives considered**: New bespoke flag/card components — rejected; slice 009 already froze these primitives for cross-slice reuse.

## R-008 — Test strategy (RED-first)

**Decision**: Per Constitution IX, each user story gets RED-first specs before implementation: Playwright for the UI + API boundary (`slice-010-*.spec.ts`), pgTAP for the status function, submit RPC, RLS, and peer-view lock gating. The peer-privacy story additionally tests the direct `/rest/v1/bracket_peer_v` boundary (SC-005), mirroring slice-005's SC-009 approach.

**Rationale**: Privacy (SC-005) and completeness (SC-002) are security guarantees that must be proven at the server boundary, not just the UI. The session's cookie-forwarding + DEFINER lessons are folded in from the start (tests forward `sb-*-auth-token` cookies; peer view is DEFINER).

**Alternatives considered**: UI-only tests — rejected; they cannot prove the server boundary refuses crafted requests.
