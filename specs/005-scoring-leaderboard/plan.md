# Implementation Plan: Scoring & Leaderboard

**Branch**: `005-scoring-leaderboard` | **Date**: 2026-05-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-scoring-leaderboard/spec.md`

## Summary

Implement the vertical slice that turns finished match results and official tournament awards
into points (FR-011, FR-012), aggregates them into a deterministic global leaderboard
(FR-013), and exposes each participant's personal breakdown (FR-014). Scoring is centralized
in Postgres functions (Constitution Principle III); the leaderboard is a derived view
with deterministic tie-breakers per §7.4; peer-pick visibility is server-enforced via RLS
keyed off the same match-lock state used by Slice 003. Recalculation triggered by Slice 006
(admin overrides) runs through the same Postgres entry point and is idempotent and audited
(Principle V, Principle VII).

## Technical Context

**Language/Version**: TypeScript 5.x (frontend + Edge Functions); SQL (PostgreSQL 15+, Supabase-managed) for scoring functions, RLS, and views

**Primary Dependencies**:
- **Backend / data**: Supabase (Postgres, Auth, RLS, Edge Functions, Realtime) — ratified by the Constitution's *Implementation Platform* section.
- **Frontend**: Next.js 14+ (App Router) with React + TypeScript + Tailwind CSS — per `docs/architecture/stack-decision.md` (Proposed).
- **Server SDK / DB access**: `@supabase/supabase-js` (and `@supabase/auth-helpers-nextjs` for server components).
- **Background scoring trigger**: Supabase Edge Function invoking a `score_match()` / `score_finals()` SQL function via the service role (transactional, RLS-bypassing scoring writer; never shipped to the client).

**Storage**: Supabase Postgres. New tables/views added by this slice:
- `score_records` (append-only-by-version per participant×target)
- `score_calculation_runs` (one row per scoring/recalc invocation)
- `leaderboard_v` (Postgres VIEW derived from `score_records` + `participants`)
- `tournament_award` (single-row holder for champion, runner-up, top scorer, best player, with `set_at`, `set_by`, `pending` flags)
- `audit_log` rows for every awarded/changed point (Slice 007 owns the table; this slice writes to it)

Existing tables consumed (owned by other slices, MUST NOT be modified here):
- `participants` (Slice 001), `matches`, `match_results` (Slice 002), `predictions`, `final_predictions` (Slices 003/004), `tournament_config` (Slice 008).

**Testing**:
- **E2E (mandated by Constitution Principle IX)**: Playwright. Scenarios authored Given/When/Then against §15.1 plus the spec's edge cases, RED before any production code.
- **DB/unit**: pgTAP for Postgres functions (`score_match`, `score_finals`, `leaderboard_v` ordering, RLS policies) — same red-green-refactor cycle.
- **Contract**: HTTP-level tests against the leaderboard read endpoint, personal-breakdown endpoint, peer-pick endpoint, and the scoring-trigger Edge Function, using a Supabase test project.

**Target Platform**:
- Frontend: Vercel-hosted Next.js (web; mobile-friendly responsive).
- Backend: Supabase managed Postgres (Pro tier during tournament for SLA per `stack-decision.md`); Edge Functions on Supabase Deno runtime.
- Browsers: evergreen (last two majors of Chrome, Edge, Firefox, Safari).

**Project Type**: Web application — single Next.js app (participant + admin routes) on top of Supabase.

**Performance Goals** (anchored to SC-003, SC-004, SC-005, SC-008 and §12.1):
- Leaderboard read p95 < 1 s for ~500 participants (1,000 concurrent simulated readers).
- Personal breakdown for a full tournament (104 matches + 4 final items) loads in under 3 s (SC-004).
- Score recalculation for all 104 matches completes within 60 s (SC-005 latency budget).
- Score idempotency: re-running `score_match` for the same `(match_id, calculation_version)` produces the same final state (SC-007).

**Constraints**:
- Trusted server time only — every lock or visibility decision MUST read time from Postgres `now()` or Edge Function clock; client clocks MUST NOT feed the decision (Principle VI, BR-LOCK-001).
- All write paths that change points MUST emit an `audit_log` row in the same transaction (Principle V).
- Peer-pick read paths MUST be enforced at the database/RLS layer, not just in app code (Principle III, FR-016).
- Scoring constants (10/5/0/20), tie-breaker order, knockout score basis, top-scorer-tie policy, best-player source, and leaderboard visibility MUST resolve through Slice 008 configuration — not as code constants (Principle VIII, FR-015).
- `service_role` key MUST stay server-side (Vercel env / Edge Function env) and MUST NOT appear in any client bundle.

**Scale/Scope**:
- ~500 participants × 104 matches = ~52,000 `score_records` for match scoring; +500×4 = 2,000 final-item records. Comfortably small for Postgres.
- Read fanout: leaderboard page is the highest-traffic surface; reads spike during result-update windows (§5.3).
- Recalculation: a full re-score touches up to ~54,000 rows in a single transaction; well within Pro-tier Postgres limits.

## Constitution Check

*GATE: MUST pass before Phase 0 research. Re-evaluated at the end of Phase 1.*

The constitution under review is v1.1.0 (`.specify/memory/constitution.md`, last amended 2026-05-15). Each principle is evaluated against this slice's design.

| # | Principle | Evaluation | Status |
|---|-----------|------------|--------|
| I | Technology Neutrality | `spec.md` is vendor-neutral; this plan keeps Supabase/Next.js details in the implementation layer (here), not in spec or data-model. Capability language ("row-level authorization", "server-side scoring function") is preserved in the data model; product names appear only in plan/contracts/quickstart. | ✅ |
| II | Security by Design | All scoring writes go through Postgres functions invoked by Edge Functions running with `service_role`; participant clients can never write `score_records`. Leaderboard reads are RLS-gated to eligible Nortal-domain participants only (Slice 001's policy is reused). Peer-pick reads are RLS-gated by lock state. | ✅ |
| III | Rules Outside the UI | Scoring math, leaderboard ranking, and tie-breaker order all live in Postgres (`score_match()`, `score_finals()`, `leaderboard_v`). The UI calls these; it does not re-implement them. Admin recalc (Slice 006) and Edge-Function scoring use the same SQL entry points. | ✅ |
| IV | Provider Abstraction | This slice consumes `match_results` and `tournament_award` rows that have already been normalized by Slice 002; it never reads from any provider directly. The `top scorer` and `best player` columns hold internal player IDs (FR-009/FR-010) — provider IDs are kept only for traceability on the upstream `players` table. | ✅ |
| V | Auditability | Every score insert/update emits an `audit_log` row in the same transaction (via `AFTER INSERT/UPDATE` trigger on `score_records`). `score_calculation_runs` retains every invocation with trigger, started_at, completed_at, affected count. The prior `calculation_version` of each `score_record` is preserved (append-only). | ✅ |
| VI | Time-Zone Correctness | Lock-based visibility (FR-016 / Edge Case at kickoff − lock_window boundary) is decided via `matches.kickoff_utc - INTERVAL <lock_window>` compared to Postgres `now()`. No client timestamp participates in the decision. Tournament-final visibility uses the `first_kickoff_utc` cached on `tournament_config`. | ✅ |
| VII | Operational Resilience | Scoring is **idempotent and order-independent**: `score_match(match_id, run_id)` deletes-then-inserts rows tagged with the new `calculation_version`; the prior version remains in audit. A failed Edge Function invocation can be retried without double-counting. Leaderboard reads serve the last successful `calculation_version` and never block on in-flight recalculation (readers see consistent ordering per version). | ✅ |
| VIII | Extensibility & Configuration | Scoring constants (10/5/0/20), tie-breaker order, knockout score basis, top-scorer-tie source, best-player source, and leaderboard-visibility policy are all read from `tournament_config` (Slice 008) at scoring time. No constants are hard-coded; defaults match §7.2/§7.3/§7.4 and the Clarifications in `spec.md`. | ✅ |
| IX | TDD via BDD (NON-NEGOTIABLE) | Playwright Given/When/Then scenarios are committed FIRST (red), covering every Acceptance Scenario in `spec.md` plus the §15.1 *Exact / Correct-outcome / Incorrect* trio and the §15.3 *FR-012* and *FR-013* gaps that this slice fills. Edge cases (knockout extra time, Golden Boot tiebreaker, mid-tournament config change, recalc latency, lock-boundary peer-pick visibility) each get an explicit scenario. pgTAP tests cover the SQL layer. Reviewers MUST reject any scoring/leaderboard PR without a matching red-first scenario. | ✅ |
| X | Vertical Slice Delivery | Each user story (US1 match scoring → US2 final-prediction scoring → US3 leaderboard → US4 breakdown) is its own complete vertical: scenario → SQL function/view → Edge Function trigger (where needed) → Next.js page/API → audit. US1 is shippable independently (it demonstrably awards points), then US2 layers in, then US3, then US4. No story is half-built before the next starts. | ✅ |
| XI | Regression-Gated Progress (NON-NEGOTIABLE) | CI runs Playwright + pgTAP + Slice 001/002/003/004 regression suites on every PR. A red suite blocks both the merge AND the start of the next task. The `tasks.md` produced by `/speckit-tasks` MUST sequence scenario-writing BEFORE implementation per Principle IX and MUST include a "regression green" gate between stories. | ✅ |

**Eligibility / Privacy / Compliance constraints** (non-principle hard rules):
- Domain-restricted access ✅ — leaderboard RLS reuses Slice 001's eligibility predicate.
- No gambling ✅ — slice produces points only, no monetary fields.
- Data minimization ✅ — leaderboard exposes only `display_name` + points (per FR-014, OD-006 resolution); no email, no region.
- Public API restriction ✅ — every endpoint requires an authenticated Nortal-domain session; no anonymous routes.

**Verdict**: ✅ No violations. Proceed to Phase 0.

### Post-Phase-1 re-check (after `research.md`, `data-model.md`, `contracts/`, `quickstart.md`)

| Principle | Post-design status | Notes |
|---|---|---|
| I | ✅ | `data-model.md` is vendor-neutral; Supabase/Next.js named only in `plan.md`, `contracts/`, `quickstart.md`. |
| II | ✅ | `contracts/scoring-trigger.edge-fn.md` enforces admin-role check + service-role-only writes. RLS on `score_records`, `leaderboard_v`, `personal_breakdown_v`, `peer_pick_v` all defined in `data-model.md` § RLS posture. |
| III | ✅ | Confirmed via `research.md` R-001, R-010 — all rules in SQL. UI/Edge Function never re-implements math. |
| IV | ✅ | Confirmed via `research.md` R-006 — score basis lives in Slice 002's normalized `match_results`. |
| V | ✅ | Trigger + `score_calculation_runs` ledger defined in `data-model.md` entities 1, 2. |
| VI | ✅ | All timestamps `timestamptz`; lock condition uses `now()` (see `contracts/peer-pick.read.md` § Server-side gate). |
| VII | ✅ | `research.md` R-002 (idempotency), R-003 (calculation_version flip), R-011 (advisory lock). |
| VIII | ✅ | All rule-shaped values in `tournament_config`; defaults seeded but overridable via Slice 008 (`research.md` R-014). |
| IX | ✅ | Playwright + pgTAP scenarios catalogued in every contract's "Test surface" section, anchored to spec Acceptance Scenarios and SCs. |
| X | ✅ | US1→US2→US3→US4 each independent; quickstart verification steps confirm slice-level completeness. |
| XI | ✅ | `quickstart.md` Definition of Done requires full regression green before merge. |

**Verdict (post-design)**: ✅ No new violations introduced. Plan is ready for `/speckit-tasks`.

(Complexity Tracking section omitted — no violations to justify.)

## Project Structure

### Documentation (this feature)

```text
specs/005-scoring-leaderboard/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan)
├── data-model.md        # Phase 1 output (/speckit-plan)
├── quickstart.md        # Phase 1 output (/speckit-plan)
├── contracts/           # Phase 1 output (/speckit-plan)
│   ├── leaderboard.read.md
│   ├── personal-breakdown.read.md
│   ├── peer-pick.read.md
│   └── scoring-trigger.edge-fn.md
├── checklists/
│   └── requirements.md  # already exists (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

This slice adds code to an existing Next.js + Supabase repo layout. Directories marked **(new)**
are introduced by this slice; the others MUST already exist by the time this slice starts (they
are the home for slices 001–004 / 006–008 outputs).

```text
apps/
└── web/                              # Next.js App Router (slices 001–004 already live here)
    ├── app/
    │   ├── (participant)/
    │   │   ├── leaderboard/
    │   │   │   └── page.tsx          # (new) leaderboard page — US3
    │   │   └── me/breakdown/
    │   │       └── page.tsx          # (new) personal breakdown — US4
    │   └── api/
    │       ├── peer-pick/
    │       │   └── [match_id]/route.ts            # (new) peer match-pick endpoint — US3 server gate (FR-016 match variant)
    │       └── peer-final-pick/
    │           └── [participant_id]/route.ts      # (new) peer final-pick endpoint — US3 server gate (FR-016 final-tournament variant)
    ├── lib/
    │   └── scoring/                   # (new) thin client/server helpers (read-only)
    │       ├── leaderboard.ts         # supabase-js wrapper over leaderboard_v
    │       └── breakdown.ts           # supabase-js wrapper over personal_breakdown_v
    └── tests/
        └── playwright/
            ├── slice-005-match-scoring.spec.ts        # (new) US1
            ├── slice-005-final-scoring.spec.ts        # (new) US2
            ├── slice-005-leaderboard.spec.ts          # (new) US3 + tie-breakers
            ├── slice-005-breakdown.spec.ts            # (new) US4 + SC-004 perf gate
            └── slice-005-peer-pick-visibility.spec.ts # (new) FR-016 server-side gate (both match + final variants)

loadtest/
├── slice-005-leaderboard-consistency.k6.ts   # (new) SC-003 / SC-008 — 1,000-VU leaderboard consistency probe
└── README.md                                  # (new) run instructions

supabase/
├── migrations/
│   ├── 0050_score_records.sql            # (new) score_records table + indexes
│   ├── 0051_score_calculation_runs.sql   # (new) runs table
│   ├── 0052_tournament_award.sql         # (new) tournament_award table (champion / runner-up / top scorer / best player)
│   ├── 0053_score_match_fn.sql           # (new) PL/pgSQL score_match(match_id, run_id)
│   ├── 0054_score_finals_fn.sql          # (new) PL/pgSQL score_finals(run_id)
│   ├── 0055_leaderboard_view.sql         # (new) leaderboard_v + peer_pick_v + peer_final_pick_v
│   ├── 0055b_personal_breakdown_view.sql # (new) personal_breakdown_v (split out so leaderboard view migration stays cohesive)
│   ├── 0056_score_audit_trigger.sql      # (new) AFTER INSERT/UPDATE on score_records → audit_log
│   ├── 0057_score_rls.sql                # (new) RLS on score_records, score_calculation_runs, tournament_award
│   ├── 0058_score_config_defaults.sql    # (new) seed default 10/5/0/20 + tie-breaker order + first_kickoff_utc + recalc_latency_target_minutes into tournament_config
│   └── 0059_score_auto_trigger.sql       # (new) DB triggers on match_results + tournament_award → invoke score-trigger Edge Function via pg_net (FR-007 auto-path)
├── functions/
│   └── score-trigger/                    # (new) Edge Function — called on match finish, award confirm, admin recalc, or config change
│       └── index.ts
├── seed/
│   ├── slice-005-fixture.sql             # (new) deterministic 6-participant fixture for unit/E2E
│   ├── slice-005-loadtest-fixture.sql    # (new) 500-participant fixture for SC-003 / SC-008 k6 load test
│   └── slice-005-full-tournament-fixture.sql # (new) 500-participant × 104-match × 4-final fixture for SC-004 / SC-005 perf gates
└── tests/
    └── pgtap/
        ├── score_match_idempotent.sql            # (new)
        ├── score_match_award_table.sql           # (new) 10/5/0 truth table
        ├── score_finals_golden_boot_tie.sql      # (new) Golden Boot tiebreaker behaviour
        ├── leaderboard_tie_breakers.sql          # (new) §7.4 tier ordering
        ├── leaderboard_shared_rank.sql           # (new) shared rank + 1-2-2-4 pattern
        ├── leaderboard_calc_version_consistency.sql  # (new) SC-008 invariant
        └── peer_pick_rls_lock_boundary.sql       # (new) FR-016 (both match + final variants) + lock-boundary edge case
```

**Structure Decision**: **Option 2 (web application)**. The product is a participant-facing
web app (Next.js on Vercel) plus a server-side data/business-rules tier (Supabase Postgres
+ Edge Functions). This slice's authoritative business logic lives in `supabase/migrations/`
(SQL functions + RLS) per Constitution Principle III; the Next.js layer is read-only
presentation over Supabase views. Tests live with the layer they validate: pgTAP next to the
SQL it tests, Playwright next to the UI it tests.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | _(none)_   | _(none)_                            |
