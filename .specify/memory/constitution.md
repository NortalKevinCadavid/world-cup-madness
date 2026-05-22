<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 1.1.0
Bump rationale: MINOR — three new non-negotiable principles added (TDD via BDD,
Vertical Slice Delivery, Regression-Gated Progress) and a new "Implementation Platform"
section declaring Supabase as the chosen backend platform. No existing principle was
removed or redefined; existing guidance is preserved.

Principles added in this amendment:
  IX.  Test-Driven Development via BDD (NON-NEGOTIABLE)
  X.   Vertical Slice Delivery
  XI.  Regression-Gated Progress (NON-NEGOTIABLE)

Sections added:
  - Implementation Platform (declares Supabase as the chosen backend platform; this is
    the formal closure of OD-007 for the backend/data layer)

Sections modified:
  - Development Workflow & Quality Gates — "Stack decisions" bullet updated to reflect
    that Supabase is now a ratified choice rather than a proposal.

Sections removed: none.

Earlier history (preserved for traceability):
  v1.0.0 (2026-05-15) — initial ratification of 8 principles from §3 of the Nortal
  architecture document plus Eligibility/Privacy/Compliance Constraints, Development
  Workflow & Quality Gates, and Governance sections.

Templates & docs reviewed for consistency:
  ✅ .specify/templates/plan-template.md       — "Constitution Check" gate is generic;
                                                  reviewers will now also check the new
                                                  TDD/vertical-slice/regression gates.
  ✅ .specify/templates/spec-template.md       — no constitution-specific edits needed.
  ✅ .specify/templates/tasks-template.md      — no edits; the new principles affect
                                                  HOW tasks are sequenced/gated, not
                                                  the template structure.
  ✅ .specify/templates/checklist-template.md  — generic; no edits.
  ⚠ docs/architecture/stack-decision.md        — pending: this ADR is still marked
                                                  "Proposed, not approved" but the
                                                  constitution now declares Supabase as
                                                  chosen. Recommend updating the ADR
                                                  status to "Accepted" in a follow-up
                                                  edit so the two docs agree.
  ⚠ docs/architecture/open-decisions.md        — pending: OD-007 (stack decision) should
                                                  be marked closed for the backend/data
                                                  layer, with a pointer to this
                                                  constitution as the ratifying artifact.

Deferred items / follow-ups: the two ⚠ items above are doc-sync tasks, not blockers.
All other open decisions (OD-001…OD-006, OD-008) remain open as tracked.
-->

# World Cup Madness Constitution

This constitution governs how the **World Cup Madness** prediction-pool application is
designed, built, operated, and changed. It is derived from §3 ("Architecture Principles")
of the Nortal-produced high-level architecture document
(`docs/architecture/high-level-architecture.md` and the authoritative `.docx`). If this
constitution and the architecture document ever disagree on a principle, the architecture
document wins and this constitution MUST be amended to match.

## Core Principles

### I. Technology Neutrality

The architecture MUST define capabilities, responsibilities, and interfaces without
mandating a specific implementation product, vendor, or framework at the architectural
layer. Concrete stack choices (e.g., Next.js, Supabase, Vercel) are recorded as ADRs in
`docs/architecture/stack-decision.md` and remain replaceable until formally approved.

**Rationale**: The Nortal architecture document is intentionally technology-agnostic so
that custom, low-code, and hybrid implementations can each be evaluated against objective
criteria. Hard-coding a stack at the architectural layer forecloses that evaluation.

**How to apply**: Architectural artifacts (specs, plans, contracts, data models) MUST be
expressed in vendor-neutral terms. Implementation-specific details belong in plan.md or
ADRs, not in spec.md or the data model.

### II. Security by Design

Eligibility, authorization, and rule enforcement MUST be applied server-side and at the
identity boundary — never only in the user interface. Every authenticated session and
every state-changing operation MUST validate that the caller belongs to an approved
Nortal corporate domain or tenant (FR-001, FR-002).

**Rationale**: A UI-only check is bypassable through direct API calls or front-end
manipulation. Domain restriction is a hard constraint of the product, not a usability
preference.

**How to apply**: Authorization checks belong in server-side handlers and database
policies. Front-end gating is permitted for UX but MUST NOT be the sole gate. Code review
MUST reject changes that introduce client-only enforcement of eligibility or locks.

### III. Rules Outside the UI

Locking, editability, scoring, and tie-breaker logic MUST be centralized in a single
reusable layer (server-side service, database function, or shared library) and MUST be
invoked identically by the UI, the API, and any background job. Match-prediction locks
(FR-008), final-prediction locks (FR-010), point calculation (FR-011, FR-012), and
leaderboard ordering (FR-013) all fall under this principle.

**Rationale**: If rules live in the UI or are duplicated across surfaces, users can
bypass them by manipulating the front-end or by calling the API directly, and rule
changes drift across implementations.

**How to apply**: New surfaces (admin tools, exports, notifications, future mobile) MUST
consume the same rule layer. PRs that re-implement locking or scoring outside the shared
layer MUST be rejected.

### IV. Provider Abstraction

External football data providers (e.g., football-data.org) MUST sit behind a stable
internal integration contract. The application's domain logic MUST NOT depend on any
specific provider's schema, identifiers, rate limits, or licensing model.

**Rationale**: Provider coverage, cost, reliability, and licensing terms change. A
provider must be replaceable without rewriting domain logic, and a fallback path must be
possible when the primary provider is degraded.

**How to apply**: The integration contract is defined in `docs/architecture/` and
exercised by FR-017. Adding a new provider MUST extend the contract, not bypass it.
Manual override paths (FR-015) MUST satisfy the same contract.

### V. Auditability

Every prediction creation, prediction update, lock event, score calculation, manual
override, and administrative action MUST be persisted to an immutable audit trail with
timestamp, actor, previous value, new value, and a reason where applicable (FR-018).

**Rationale**: Disputes — "my prediction was changed", "why was I locked early?", "why
did my score change?" — MUST be resolvable from evidence, not assumptions. Recalculations
(FR-016) and overrides (FR-015) are explicitly in scope precisely because they will
happen.

**How to apply**: Any write path that mutates predictions, scores, or tournament
configuration MUST emit an audit record in the same transaction. Audit records MUST NOT
be deletable through the application's normal write paths.

### VI. Time-Zone Correctness

All deadline decisions (match-prediction lock, final-prediction lock, recalculation
windows) MUST use trusted server time and UTC-normalized kickoff timestamps. Client
clocks MUST NOT be authoritative for any locking decision.

**Rationale**: Participants are distributed across regions; client clocks drift and can
be manipulated. The match lock (kickoff − 60 minutes, FR-008) and the final-prediction
lock at first kickoff (FR-010) MUST be globally consistent.

**How to apply**: Lock checks MUST read time from the server (or database) clock. User
display MAY localize times for readability, but display values MUST NOT feed back into
lock decisions.

### VII. Operational Resilience

The system MUST continue to function — at minimum in a degraded read mode plus admin
manual correction — when the external score provider is delayed, rate-limited, or
unavailable. Match-day write paths (prediction submission, leaderboard reads) MUST be
optimized for the deadline-driven traffic spike described in §5.3.

**Rationale**: External provider outages and rate limits are expected, not exceptional.
Losing the leaderboard or the ability to submit predictions during a match window is a
product-defining failure.

**How to apply**: Sync jobs MUST tolerate partial failure and retry idempotently. Manual
override (FR-015) and recalculation (FR-016) MUST remain available regardless of provider
state. Performance work MUST prioritize the read-heavy leaderboard path and the
deadline-sensitive write path.

### VIII. Extensibility & Configuration

Tournament settings, allowed corporate domains, lock windows, scoring values, active
phases, and provider settings MUST be configurable through admin tooling and MUST NOT
require a code change for routine adjustments (FR-020).

**Rationale**: This product is expected to be re-used for future tournaments and
potentially other internal pools. Hard-coding scoring constants, domain lists, or lock
windows would force a rebuild for each edition.

**How to apply**: New rule-shaped values (point thresholds, lock offsets, eligible
domains) MUST be added to the configuration surface, not embedded as code constants.
Migration of existing constants to configuration is in scope when the surrounding code
is touched.

### IX. Test-Driven Development via BDD (NON-NEGOTIABLE)

Every feature MUST be developed test-first using Behavior-Driven Development. Scenarios
MUST be authored in Given/When/Then form against the acceptance criteria in
`docs/architecture/acceptance-criteria.md` (§15) and the FRs they implement, BEFORE the
production code that satisfies them is written. **Playwright** is the end-to-end test
framework of record; unit-level tests MAY use any framework appropriate to the runtime
chosen in the implementation plan, but they MUST follow the same red-green-refactor
cycle.

Scenarios MUST cover both the happy path AND documented edge conditions — at minimum:
boundary times around lock windows (kickoff − 60 min ± 1 min, first-kickoff ± 1 min),
ineligible-domain access, duplicate prediction submission, provider outage / stale data,
admin override, and recalculation. Vague phrases like "should work" or "handles errors
gracefully" are not acceptable scenario language; every Then-clause MUST be a checkable
assertion.

**Rationale**: This product has hard temporal boundaries (locks), hard eligibility
boundaries (Nortal-only), and an integration that will fail in production. Tests written
after the fact systematically miss those edges. BDD scenarios also double as the audit
trail required by Principle V — they document why a behavior exists.

**How to apply**: A pull request that adds or changes a behavior MUST include the
Given/When/Then scenarios committed first (red), then the implementation that turns them
green. Reviewers MUST reject PRs that implement behavior without an accompanying scenario
or that omit edge-case coverage from the FR's scenarios in §15.

### X. Vertical Slice Delivery

Features MUST be built and shipped as complete vertical slices — UI + API + data
persistence + tests + observability — one feature at a time. A feature is "done" only
when its full vertical stack passes its BDD scenarios under Principle IX. The team MUST
NOT accumulate half-built features by working horizontally layer-by-layer across many
FRs.

**Rationale**: Horizontal layering produces apparent progress while leaving every FR
half-finished and untestable. Vertical slicing keeps the application demonstrable at
every step, makes regressions detectable immediately, and aligns with the Spec Kit
workflow (each `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` cycle scopes a
single slice).

**How to apply**: `spec.md` user stories MUST already be priority-ordered as independent
slices (the spec template enforces this). The implementation plan MUST treat each story
as a complete slice through every architectural layer. Starting a new slice before the
prior slice satisfies its acceptance scenarios is a constitutional violation regardless
of schedule pressure.

### XI. Regression-Gated Progress (NON-NEGOTIABLE)

The full regression suite — all previously-green BDD scenarios plus all unit and
integration tests — MUST be passing before any new task is started, any new slice is
begun, or any PR is merged. A failing regression is a stop-the-line condition: the next
work item is to restore green, not to add more behavior on top of a broken baseline.

**Rationale**: This product runs on hard kickoff deadlines; once the tournament starts,
there is no quiet window to fix accumulated regressions. The cost of moving on with a
red suite compounds quickly and undermines Principles V (auditability) and VII
(operational resilience).

**How to apply**: CI MUST run the full regression suite on every PR and on `main`. A red
suite blocks merges and blocks the start of the next task. If a regression is the result
of an intentional behavior change, the failing scenarios MUST be updated (with rationale
in the commit) in the same change set — they MUST NOT be deleted, skipped, or marked
xfail to silence them.

## Implementation Platform

This is a **Supabase project**. Supabase (Postgres, Auth, Row-Level Security, Storage,
Edge Functions, and Realtime as needed) is the chosen backend and data platform for
World Cup Madness. This declaration formally closes OD-007 for the backend/data layer.

What this means in practice — and how it interacts with Principle I (Technology
Neutrality):

- The **architectural layer** remains technology-neutral. Specs, the data model, and
  integration contracts MUST continue to be expressed in vendor-neutral terms; capability
  references (e.g., "row-level authorization") are preferred over product-specific
  references (e.g., "Supabase RLS policy") in `spec.md` and `data-model.md`.
- The **implementation layer** uses Supabase concretely. Plans (`plan.md`), data
  migrations, and code MAY and SHOULD reference Supabase primitives directly:
  Postgres schemas, RLS policies, `auth.users` / `auth.identities`, Edge Functions for
  server-side business logic, and the Supabase client SDK for application access.
- **Server-side rule enforcement** under Principle II and Principle III MUST be
  implemented through Postgres constraints, RLS policies, and Edge Functions —
  not through the application tier alone. RLS is the primary mechanism for enforcing
  Nortal-domain eligibility on data reads and writes.
- **Auditability** under Principle V MUST be implemented as append-only tables (or
  equivalent immutable structures) populated by triggers or transactional inserts, so
  that audit records share the write transaction with the action being audited.
- **Provider abstraction** under Principle IV is unaffected: the external football-data
  provider sits behind a contract regardless of where the consuming code runs (Edge
  Function, scheduled job, or app server).
- **Frontend, hosting, and other stack choices** outside the backend/data layer (e.g.,
  Next.js + Tailwind + Vercel from `stack-decision.md`) remain in their current
  Proposed/Accepted state in the ADRs and are NOT ratified by this section. Future
  amendments may close those decisions analogously.

## Eligibility, Privacy & Compliance Constraints

These constraints are not principles but hard rules that MUST be enforced regardless of
implementation choices:

- **Domain-restricted access**: Only users authenticated through an approved Nortal
  corporate identity, with an email belonging to a configured allowed domain, may read
  or write any participant-facing data (FR-001, FR-002). The exact domain list is tracked
  in `docs/architecture/open-decisions.md` (OD-001) and MUST be configurable per
  Principle VIII.
- **No gambling, no wagers**: The application MUST NOT support paid betting, money
  pools, or any monetary stake. This is a §5.2 out-of-scope constraint and overrides any
  feature request that would introduce financial transactions.
- **Data minimization**: Participant profiles MUST capture only the business attributes
  defined in FR-003 (display name, email, domain, region if available, participation
  status). Sensitive HR, payroll, or performance data MUST NOT be ingested.
- **Public API restriction**: No anonymous or non-Nortal public endpoint may expose
  participant identities, predictions, or leaderboard standings. Read-only public summary
  views, if ever added, require an explicit constitutional amendment.

## Development Workflow & Quality Gates

- **Architecture document is source of truth**: `docs/architecture/` (and the underlying
  `.docx`) is the authoritative product specification. Specs, plans, and tasks generated
  by the Spec Kit workflow MUST cite the relevant FR-IDs, NFRs, or §-sections they
  implement or modify.
- **Open decisions block dependent work**: OD-001 through OD-008 in
  `docs/architecture/open-decisions.md` represent unresolved questions. A feature that
  depends on an open decision MUST NOT be implemented until that decision is closed; the
  spec MUST surface the dependency explicitly.
- **Acceptance criteria gate**: The 14 core test scenarios and 8 acceptance criteria in
  `docs/architecture/acceptance-criteria.md` (§15) are the minimum quality bar for the
  affected functional areas. A PR that lands an FR MUST also satisfy the §15 scenarios
  tagged to that FR, either by automated test or by a documented manual verification
  step.
- **Scoring & locking changes**: Any change to `docs/architecture/scoring-model.md`
  (BR-LOCK-001…006, point values, tie-breaker order) is a constitutional-level change in
  effect: it MUST be accompanied by an updated audit-trail strategy (Principle V) and a
  recalculation plan (FR-016).
- **Stack decisions**: The backend/data layer is **Supabase** — formally ratified by
  the *Implementation Platform* section of this constitution and closing OD-007 for that
  layer. Other stack elements in `docs/architecture/stack-decision.md` (Next.js,
  Tailwind, Vercel) remain in their current ADR state and MUST be treated as replaceable
  under Principle I until separately ratified. The ADR document itself should be
  updated in a follow-up edit to reflect the Supabase decision.
- **Testing & delivery gates**: Principles IX (TDD/BDD/Playwright), X (Vertical Slice
  Delivery), and XI (Regression-Gated Progress) jointly define the minimum delivery
  workflow. A `/speckit-plan` output MUST reference these gates explicitly in its
  Constitution Check section. A `/speckit-tasks` output MUST place scenario-writing
  tasks (Given/When/Then) BEFORE implementation tasks for every slice.

## Governance

- **Authority**: This constitution supersedes ad-hoc development practices for this
  repository. Where this constitution and `docs/architecture/` disagree, the architecture
  document wins and this constitution MUST be amended within the same change set.
- **Amendment procedure**: Amendments are made by editing this file via the
  `/speckit-constitution` workflow. Each amendment MUST update the version line, refresh
  `Last Amended`, and prepend a Sync Impact Report comment describing what changed and
  which templates or docs were re-validated.
- **Versioning policy**: Semantic versioning applies to this document:
  - **MAJOR**: A principle is removed, redefined in a backward-incompatible way, or a
    governance rule is fundamentally changed.
  - **MINOR**: A new principle or section is added, or existing guidance is materially
    expanded.
  - **PATCH**: Clarifications, wording fixes, typo corrections, or non-semantic
    refinements.
- **Compliance review**: PR reviewers MUST verify that changes touching eligibility,
  locking, scoring, audit, or integration code remain consistent with Principles II–VII.
  Reviewers MAY request that a PR cite the FR(s) and principle(s) it implements when the
  link is not obvious.
- **Runtime guidance**: For day-to-day developer guidance not covered here, see
  `CLAUDE.md`, `docs/architecture/README.md`, and the Spec Kit templates under
  `.specify/templates/`.

**Version**: 1.1.0 | **Ratified**: 2026-05-15 | **Last Amended**: 2026-05-15
