# Open Decisions

Extracted from §17.2 of [`high-level-architecture.md`](high-level-architecture.md). Each decision blocks part of the build until resolved.

## Status

Five of the eight decisions (OD-002, OD-003, OD-004, OD-005, OD-006) were resolved on 2026-05-15 via Slice 005's clarification session. OD-001, OD-007, and OD-008 remain **Open**.

## Decision Log

### OD-001 — Approved email domains

**Question.** What exact Nortal domains or identity tenants are eligible?
**Owner.** Security / business sponsor
**Affects.** FR-001 (eligibility), FR-002 (rejected external access), FR-020 (configuration)
**Status.** Open
**Resolution.** _(pending)_

**Status update (2026-05-19).** Mechanism resolved by Slice 001: the approved-domain list lives in `tournament_config.eligibility.approved_domains` (jsonb array, seeded with `["nortal.com"]` in `supabase/migrations/0002_tournament_config_stub.sql`). The **actual list** for production launch remains an Open decision until Slice 008's admin UI ships and Security signs off on the final set of domains. Pointer: `specs/001-eligibility-login/research.md` § R-005.

### OD-002 — Official score basis for knockouts

**Question.** For knockout matches, should predictions be evaluated on regular time, extra time included, or another official score basis?
**Owner.** Business sponsor / rules owner
**Affects.** FR-011 (scoring), FR-018 (audit), all knockout-round scoring scenarios
**Status.** Resolved (2026-05-15)
**Resolution.** Knockout matches are evaluated on regular time + extra time (end-of-extra-time when played, else end-of-regulation); penalty shootout kicks are never counted (per `specs/005-scoring-leaderboard/spec.md` § Clarifications).

### OD-003 — Penalty shootouts

**Question.** Are penalty shootout scores excluded from score predictions?
**Owner.** Business sponsor / rules owner
**Affects.** FR-005 (prediction entry UX), FR-011 (scoring), data model for matches
**Status.** Resolved (2026-05-15)
**Resolution.** Penalty shootouts are excluded from score predictions as a consequence of OD-002; participants predict only the on-pitch final score with no separate shootout input (per `specs/005-scoring-leaderboard/spec.md` § Clarifications).

### OD-004 — Top scorer ties

**Question.** If multiple players share top scorer status, should all be accepted as correct, or does an official tiebreaker rule pick one?
**Owner.** Business sponsor / rules owner
**Affects.** FR-012 (final prediction scoring)
**Status.** Resolved (2026-05-15)
**Resolution.** Top-scorer ties are resolved using FIFA's official Golden Boot tiebreaker (goals → fewest minutes → most assists); only the single officially-named Golden Boot winner counts as the correct pick (per `specs/005-scoring-leaderboard/spec.md` § Clarifications).

### OD-005 — Best player source

**Question.** Which official source determines the tournament best player?
**Owner.** Business sponsor / admin owner
**Affects.** FR-012 (final prediction scoring), FR-017 (provider integration)
**Status.** Resolved (2026-05-15)
**Resolution.** Best player is sourced from the FIFA Golden Ball (FIFA Technical Study Group's "Best Player of the Tournament"); only the single named winner counts, with best-player scoring held in a pending state until FIFA's announcement (per `specs/005-scoring-leaderboard/spec.md` § Clarifications).

### OD-006 — Leaderboard visibility

**Question.** Can all participants see all names, or should visibility be limited (e.g. anonymized below top-N, or scoped to office/team)?
**Owner.** Privacy / business sponsor
**Affects.** FR-013 (leaderboard), FR-014 (personal breakdown), engagement features (team/office leagues)
**Status.** Resolved (2026-05-15)
**Resolution.** Default leaderboard shows full participant display names to all eligible (Nortal-gated) participants; anonymization and team-scoping remain configurable in Slice 008 for future privacy reviews (per `specs/005-scoring-leaderboard/spec.md` § Clarifications).

### OD-007 — Implementation approach

**Question.** Which technology stack or platform will be selected after evaluating options?
**Owner.** Architecture board / engineering
**Affects.** All NFRs, hosting, deployment, secret management, identity integration
**Status.** Open — see [`stack-decision.md`](stack-decision.md) for the current proposal (Next.js + Tailwind + Vercel + Supabase). Not yet approved.
**Resolution.** _(pending formal approval)_

### OD-008 — Notification channels

**Question.** Which internal channels (Slack, Teams, email, in-app) are approved for reminders and announcements?
**Owner.** Business sponsor / communications
**Affects.** FR-019 (notifications), engagement enhancements (deadline reminders)
**Status.** Open
**Resolution.** _(pending)_

## How to use this file

When resolving a decision:

1. Update **Status** to one of: Open / In review / Resolved / Deferred / Wontfix.
2. Fill in **Resolution** with the decision and a brief rationale.
3. Reference any commit, PR, or external document that captures the decision.
4. Cross-link affected FRs in the build if the resolution changes scope.
