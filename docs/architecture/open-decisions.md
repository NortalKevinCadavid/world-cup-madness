# Open Decisions

Extracted from §17.2 of [`high-level-architecture.md`](high-level-architecture.md). Each decision blocks part of the build until resolved.

## Status

All eight decisions are **Open** as of initial repository commit.

## Decision Log

### OD-001 — Approved email domains

**Question.** What exact Nortal domains or identity tenants are eligible?
**Owner.** Security / business sponsor
**Affects.** FR-001 (eligibility), FR-002 (rejected external access), FR-020 (configuration)
**Status.** Open
**Resolution.** _(pending)_

### OD-002 — Official score basis for knockouts

**Question.** For knockout matches, should predictions be evaluated on regular time, extra time included, or another official score basis?
**Owner.** Business sponsor / rules owner
**Affects.** FR-011 (scoring), FR-018 (audit), all knockout-round scoring scenarios
**Status.** Open
**Resolution.** _(pending)_

### OD-003 — Penalty shootouts

**Question.** Are penalty shootout scores excluded from score predictions?
**Owner.** Business sponsor / rules owner
**Affects.** FR-005 (prediction entry UX), FR-011 (scoring), data model for matches
**Status.** Open
**Resolution.** _(pending)_

### OD-004 — Top scorer ties

**Question.** If multiple players share top scorer status, should all be accepted as correct, or does an official tiebreaker rule pick one?
**Owner.** Business sponsor / rules owner
**Affects.** FR-012 (final prediction scoring)
**Status.** Open
**Resolution.** _(pending)_

### OD-005 — Best player source

**Question.** Which official source determines the tournament best player?
**Owner.** Business sponsor / admin owner
**Affects.** FR-012 (final prediction scoring), FR-017 (provider integration)
**Status.** Open
**Resolution.** _(pending)_

### OD-006 — Leaderboard visibility

**Question.** Can all participants see all names, or should visibility be limited (e.g. anonymized below top-N, or scoped to office/team)?
**Owner.** Privacy / business sponsor
**Affects.** FR-013 (leaderboard), FR-014 (personal breakdown), engagement features (team/office leagues)
**Status.** Open
**Resolution.** _(pending)_

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
