# Implementation Plan: Match Predictions with Locking

**Branch**: `003-match-predictions` | **Date**: 2026-05-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-match-predictions/spec.md`

## Summary

Implement the vertical slice that turns the match catalog into something participants actually
interact with: per-match score predictions with strict 60-minute lock enforcement (FR-001
through FR-008 + BR-LOCK-001…004). Every lock decision is server-authoritative via a single
locked predicate `is_prediction_locked(uuid)` invoked identically by the write path, the
catalog-read extension, and Slice 005's eventual peer-pick view (Constitution Principle III).
The prediction store is append-only with a unique-active partial index plus a SECURITY DEFINER
SP `submit_prediction(...)` that serializes per-(participant, match) submissions via advisory
lock — exactly-one-active under 1,000 concurrent submitters is a storage-layer guarantee
(SC-003). Every state transition and every rejected attempt emits an `audit_log` row in the
same transaction (Principle V). The participant UI extends Slice 002's `/matches` page with
inline prediction entry per editable row, locale-aware countdown to lock, and a personal
"my predictions" surface read from `/api/me/predictions`.

## Technical Context

**Language/Version**: TypeScript 5.x (Next.js App Router); SQL (PostgreSQL 15+, Supabase-managed) for the lock predicate, the `submit_prediction` SP, RLS, and audit triggers.

**Primary Dependencies** (additive over Slices 001 + 002):
- **Backend / data**: Supabase (Postgres, RLS, advisory locks, audit triggers) — already in place from prior slices.
- **Frontend**: Next.js 14+ (App Router) with React + TypeScript + Tailwind CSS — already in place from Slice 001 / 002.
- **Form validation**: `zod` for request-body schema validation in the route handler (new devDep at `apps/web`).
- **Optimistic-update / state**: React `useOptimistic` (or equivalent) on the participant inline-edit form. No new state-management library.

**Storage**: Supabase Postgres. New artifacts:
- Tables: `predictions` (append-only chain).
- Functions: `is_prediction_locked(uuid) RETURNS boolean STABLE` (locked cross-slice); `submit_prediction(uuid, uuid, int, int, text) RETURNS uuid` SECURITY DEFINER (locked cross-slice).
- Triggers: audit-row trigger on `predictions`; `matches.kickoff_utc`-update trigger for FR-013 kickoff-correction-crossed-lock audit (mirrors Slice 002's pattern).
- Seed: extends `tournament_config` with `lock_window_minutes` (default 60) and `score_upper_bound` (default 20).

Existing artifacts consumed:
- From Slice 001: `public.participants`, `public.is_eligible_nortal_participant(uuid)`, `public.is_admin(uuid)` (stub), `public.audit_log`, `public.tournament_config`.
- From Slice 002: `public.matches`, `public.matches.kickoff_utc` (UTC timestamptz), `public.matches.status` enum (`scheduled / in_progress / finished / postponed / cancelled`), the `/api/matches` route handler (extended by this slice with the additive `lock_state` field), `apps/web/lib/types/match.ts` (extended with the additive `lock_state` field), `apps/web/lib/catalog/format.ts`, `apps/web/app/(participant)/matches/page.tsx` (extended with inline prediction form + countdown).

**Testing**:
- **E2E (Constitution Principle IX)**: Playwright. Scenarios authored Given/When/Then against `spec.md` US1/US2/US3/US4 acceptance scenarios plus the 8 spec Edge Cases. Boundary tests at `kickoff − lock:00`, `kickoff − lock:01`, `kickoff − lock + 0:01` are non-negotiable (SC-001).
- **DB / unit**: pgTAP for the lock predicate (12 files covering all boundary + status branches + perf assertion), the `submit_prediction` SP (10 files covering happy / supersede / lock / invalid-score / invalid-match / ineligible / concurrent / audit-format / admin-override), and the RLS isolation.
- **Concurrency**: explicit pgTAP test using `dblink` or `pg_background` to run 1,000 simultaneous `submit_prediction` calls for the same (participant, match) and assert exactly-one-active (SC-003).

**Target Platform**:
- Frontend: Vercel-hosted Next.js, evergreen browsers (last two majors of Chrome, Edge, Firefox, Safari).
- Backend: Supabase managed Postgres (Pro tier during tournament for SLA per `stack-decision.md`).

**Project Type**: Web application — extends Slice 001 + Slice 002 layout.

**Performance Goals** (anchored to spec SCs + [research.md § R-001 / § R-006](./research.md)):
- `is_prediction_locked(uuid)` p95 < 5 ms — called inline by every write check and every catalog row's `lock_state` computation.
- `submit_prediction(...)` p95 < 100 ms end-to-end (advisory lock acquisition + lock check + INSERT + supersede UPDATE + audit + COMMIT).
- POST `/api/predictions` p95 < 30 s under normal load including auth / requireEligible / SP (SC-004).
- 1,000 concurrent submissions for the same (participant, match) all complete with exactly-one-active (SC-003).
- Config-change to `lock_window_minutes` takes effect within 1 minute for new evaluations (SC-005) — guaranteed by reading `tournament_config` fresh on every predicate call; no app-tier cache.
- 10,000 simulated submit/edit cycles produce zero record losses (SC-006) — guaranteed by append-only design + FK ON DELETE RESTRICT.

**Constraints**:
- Trusted server time only — Postgres `now()` in `is_prediction_locked` and `submit_prediction`. Client clocks NEVER feed any decision (Principle VI, BR-LOCK-001).
- All writes go through `submit_prediction()` SECURITY DEFINER — no direct INSERT/UPDATE/DELETE from any client (Principle II + III).
- All catalog mutations (existing from Slice 002) AND all prediction mutations (this slice) emit `audit_log` rows in the same transaction (Principle V).
- The `is_prediction_locked(uuid)` and `submit_prediction(...)` signatures are **locked cross-slice contracts** — changes require coordinating regression updates across Slices 005 + 006 + this slice (Principle XI).
- `lock_window_minutes` and `score_upper_bound` live in `tournament_config` — Principle VIII.
- The Next.js route handlers (`POST /api/predictions`, `GET /api/me/predictions`) NEVER use the service-role key. Only the SP's SECURITY DEFINER privilege writes data.

**Scale/Scope**:
- ~500 participants × ~104 matches = ~52,000 potential active predictions. Plus history rows (~1-3 per active per participant typical) = ~150,000 total prediction rows at the upper bound. Comfortably small for Postgres.
- Write spike: prediction-deadline traffic concentrates in the hour before each kickoff. Architecture §5.3 traffic-spike requirement: the advisory-lock-per-(participant, match) pattern parallelizes across pairs and serializes within pairs — write throughput scales with distinct pairs.
- Catalog reads (extended `/api/matches`): same access pattern as Slice 002, but every row now also computes `is_prediction_locked()` — STABLE memoization keeps the cost bounded.

## Constitution Check

*GATE: MUST pass before Phase 0 research. Re-evaluated at the end of Phase 1.*

The constitution under review is v1.1.0 (`.specify/memory/constitution.md`, last amended 2026-05-15). Each principle is evaluated against this slice's design.

| # | Principle | Evaluation | Status |
|---|-----------|------------|--------|
| I | Technology Neutrality | `spec.md` is vendor-neutral. This plan keeps Supabase / Next.js details in the implementation layer. The data model uses capability language ("score prediction", "lock state predicate", "audit reference"); product names appear only in `plan.md`, `research.md`, `contracts/*`, `quickstart.md`. The `is_prediction_locked(uuid)` predicate is named for its capability, not its implementation. | ✅ |
| II | Security by Design | All prediction writes go through `submit_prediction()` SECURITY DEFINER — no direct table writes from any client. Eligibility is checked at four layers: (1) Slice 001's auth-hook gate at the auth tier; (2) the route handler's `requireEligible()` call; (3) RLS on `predictions` (`predictions_self_read`); (4) defense-in-depth `is_eligible_nortal_participant` check INSIDE the SP body. Service-role key stays in Edge Function env, never in client bundles. The route handler MUST NOT accept a `participant_id` body param — the SP receives the caller's participant_id from server-side context. | ✅ |
| III | Rules Outside the UI | `is_prediction_locked(uuid)` is the single named predicate every consumer calls — the SP write path, the `/api/matches` `lock_state` computation, Slice 005's peer-pick view, future admin tooling. No re-implementation in TypeScript anywhere. Score-upper-bound and lock-window-minutes are config-driven, never code constants. The participant `/matches` page is presentation-only. | ✅ |
| IV | Provider Abstraction | Not directly applicable to this slice (no external provider). The slice consumes Slice 002's normalized `matches` and `tournament_config` — both already provider-agnostic via Slice 002's `MatchDataProviderAdapter` contract. | ✅ (N/A) |
| V | Auditability | Every prediction state change (INSERT, supersede UPDATE) emits an `audit_log` row in the same transaction via the row trigger. Every rejected attempt (locked, invalid-score, invalid-match, ineligible) emits an `audit_log` row from inside the SP body, in the same transaction the EXCEPTION aborts (the audit insert is committed via a sub-transaction pattern). Kickoff-correction-crossed-lock events from Slice 002 propagate via a trigger on `matches` that emits one `audit_log` row per affected active prediction (FR-013). | ✅ |
| VI | Time-Zone Correctness | `is_prediction_locked()` uses Postgres `now()` exclusively. The strict boundary (BR-LOCK-003) uses `>=` so at exactly `kickoff − lock_window` the match is locked. UI countdown is informational only; the API's `lock_state` field is authoritative. `submit_prediction()` re-checks `is_prediction_locked()` inside its own transaction so write decisions also use DB-clock time. `matches.kickoff_utc` is `timestamptz` stored in UTC by Slice 002. No client clock participates anywhere. | ✅ |
| VII | Operational Resilience | Concurrency: advisory lock per (participant, match) serializes within the contention dimension; unique partial index is the hard backstop. SC-003 (1,000 concurrent → exactly one active) is guaranteed at the storage layer. SC-006 (10,000 cycles, zero lost records) is guaranteed by append-only design + ON DELETE RESTRICT. Postgres MVCC means readers see consistent state across the supersede transition (no half-applied state visible). | ✅ |
| VIII | Extensibility & Configuration | `lock_window_minutes` and `score_upper_bound` live in `tournament_config`; defaults seeded by this slice (60 minutes, 20). Slice 008's admin UI replaces. SC-005 (1-minute config-change responsiveness) is guaranteed by reading config fresh on every predicate call. No hard-coded lock-window or score-bound constants in code or SQL. | ✅ |
| IX | TDD via BDD (NON-NEGOTIABLE) | Playwright Given/When/Then scenarios authored FIRST (RED), covering every Acceptance Scenario in `spec.md` (US1 × 3, US2 × 3, US3 × 5, US4 × 2) plus the 8 spec Edge Cases. The boundary tests at `kickoff − lock:00`, `kickoff − lock:01`, `kickoff − lock + 0:01` are explicit (SC-001 invariant). pgTAP scenarios cover the lock predicate (12 files) and the SP (10 files including 1,000-concurrent serialization). Reviewers MUST reject any change to the prediction / lock surface that lacks a matching red-first scenario. | ✅ |
| X | Vertical Slice Delivery | Each user story is its own complete vertical: US1 (submit) → table + SP + route handler + `/matches` extension; US2 (edit/supersede) → SP supersede branch + audit trigger; US3 (lock enforcement) → predicate + SP rejection paths + UI rendering; US4 (per-match lock state display) → `/api/matches` extension + UI countdown. US1 + US2 are shippable independently of US3/US4 (the SP enforces lock regardless of UI rendering); US3 is shippable as the safety net even before US4's UX polish lands. Admin manual entry and final-tournament predictions are **deliberately deferred** to Slices 006 and 004 respectively. | ✅ |
| XI | Regression-Gated Progress (NON-NEGOTIABLE) | Slice 001 + Slice 002 regression suites MUST stay green throughout this slice's work; no regression in participants/auth, matches/sync, audit_log, or tournament_config is tolerated. The `tasks.md` produced by `/speckit-tasks` MUST place red-gate verification before any implementation task and MUST include a "Slices 001 + 002 still green" gate at the start of US3 (lock enforcement). The locked cross-slice contracts (`is_prediction_locked`, `submit_prediction`, `predictions` table shape) are this slice's regression baseline for Slice 004+ to keep green. | ✅ |

**Eligibility / Privacy / Compliance constraints** (non-principle hard rules):
- **Domain-restricted access** ✅ — every write path checks `requireEligible(client)` AND `is_eligible_nortal_participant()` inside the SP (defense-in-depth).
- **No gambling** ✅ — predictions are integer score values only; no monetary fields anywhere.
- **Data minimization** ✅ — `predictions` columns are exactly what FR-002 + spec § Key Entities require; no extra participant attributes joined in.
- **Public API restriction** ✅ — every prediction endpoint requires an authenticated Nortal session.

**Verdict**: ✅ No violations. Proceed to Phase 0.

### Post-Phase-1 re-check (after `research.md`, `data-model.md`, `contracts/`, `quickstart.md`)

| Principle | Post-design status | Notes |
|---|---|---|
| I | ✅ | `data-model.md` is vendor-neutral; product names contained to plan/research/contracts/quickstart. The locked predicate name `is_prediction_locked` is capability-named. |
| II | ✅ | `contracts/predictions.write.md` enforces SECURITY DEFINER SP as the single write path. `contracts/predictions.read.md` enforces RLS-bound reads. No service-role on any client surface. |
| III | ✅ | `contracts/prediction-lock.predicate.sql.md` is the single home for the lock rule. Slice 003's SP, `/api/matches` extension, Slice 005's `peer_pick_v` view, and Slice 006 admin tooling all reference the predicate by name. |
| IV | ✅ | N/A — no external provider in this slice. |
| V | ✅ | Audit trigger + SP-body rejection audit jointly guarantee same-transaction audit for every state change AND every rejected attempt. |
| VI | ✅ | `is_prediction_locked` body uses `now()` exclusively; strict `>=` boundary documented in the contract and exercised by 4 boundary pgTAP tests. |
| VII | ✅ | Advisory lock + unique partial index + serializable isolation (per-transaction); explicit 1,000-concurrent test in `submit_prediction_serializes_concurrent.sql`. |
| VIII | ✅ | `lock_window_minutes` and `score_upper_bound` config-keys seeded with documented defaults; configurable per Slice 008. `is_prediction_locked_config_changes.sql` pgTAP test asserts 1-minute responsiveness. |
| IX | ✅ | Test files catalogued in every contract's "Test surface" section; boundary tests for SC-001 explicit. |
| X | ✅ | US1 → US2 → US3 → US4 each independently demonstrable; quickstart Definition of Done confirms slice-level completeness. Final-tournament predictions and admin manual entry deferred per `research.md` § R-015. |
| XI | ✅ | `quickstart.md` Definition of Done requires Slice 001 + Slice 002 regression suites + this slice's Playwright + pgTAP all GREEN before Slice 004 starts. |

**Verdict (post-design)**: ✅ No new violations introduced. Plan is ready for `/speckit-tasks`.

(Complexity Tracking section omitted — no violations to justify.)

## Project Structure

### Documentation (this feature)

```text
specs/003-match-predictions/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan)
├── data-model.md        # Phase 1 output (/speckit-plan)
├── quickstart.md        # Phase 1 output (/speckit-plan)
├── contracts/           # Phase 1 output (/speckit-plan)
│   ├── prediction-lock.predicate.sql.md  # locked cross-slice predicate
│   ├── predictions.write.md              # POST /api/predictions + submit_prediction SP
│   └── predictions.read.md               # GET /api/me/predictions + /api/matches lock_state
├── checklists/
│   └── requirements.md  # already exists (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

This slice extends the layout established by Slices 001 + 002. Directories marked **(new)** are introduced here; **(modify)** indicates an existing artifact this slice extends.

```text
apps/
└── web/                                  # (existing — Slice 001 / 002)
    ├── app/
    │   ├── (participant)/
    │   │   └── matches/
    │   │       ├── page.tsx              # (modify) extend with inline prediction form + countdown
    │   │       └── components/
    │   │           ├── PredictionForm.tsx     # (new) client component — inline submit form per editable row
    │   │           └── LockCountdown.tsx      # (new) client component — minutes-until-lock display
    │   └── api/
    │       ├── predictions/
    │       │   └── route.ts                   # (new) POST /api/predictions
    │       ├── me/
    │       │   └── predictions/
    │       │       └── route.ts               # (new) GET /api/me/predictions
    │       └── matches/
    │           └── route.ts                   # (modify) add lock_state to SELECT projection
    ├── lib/
    │   ├── predictions/
    │   │   ├── client.ts                 # (new) supabase-js wrapper for submit + read
    │   │   ├── types.ts                  # (new) Prediction TypeScript type
    │   │   └── countdown.ts              # (new) formatRemainingUntilLock(kickoff_utc, lock_window, now): string
    │   └── types/
    │       └── match.ts                  # (modify) add lock_state field to Match type
    └── tests/
        └── playwright/
            ├── slice-003-submit-happy.spec.ts                       # US1.1
            ├── slice-003-submit-update-supersedes.spec.ts           # US2.1
            ├── slice-003-submit-locked.spec.ts                      # US3.1 boundary
            ├── slice-003-submit-locked-just-inside.spec.ts          # US3.2 inside-window
            ├── slice-003-submit-locked-just-outside.spec.ts         # US3.5 just-outside
            ├── slice-003-submit-status-locked.spec.ts               # BR-LOCK-004
            ├── slice-003-submit-invalid-score.spec.ts               # FR-008
            ├── slice-003-submit-invalid-match.spec.ts               # US1.3
            ├── slice-003-submit-unauthenticated.spec.ts             # 401
            ├── slice-003-submit-domain-removed.spec.ts              # 403
            ├── slice-003-submit-concurrent-tabs.spec.ts             # FR-009 / SC-003
            ├── slice-003-submit-direct-api-rejected.spec.ts         # US3.3
            ├── slice-003-submit-client-clock-ignored.spec.ts        # US3.4 / BR-LOCK-001
            ├── slice-003-me-predictions-empty.spec.ts               # R-013
            ├── slice-003-me-predictions-list.spec.ts                # R-013
            ├── slice-003-me-predictions-match-filter.spec.ts        # R-013
            ├── slice-003-me-predictions-after-supersede.spec.ts     # R-013
            ├── slice-003-me-predictions-401.spec.ts                 # 401
            ├── slice-003-me-predictions-403.spec.ts                 # 403
            ├── slice-003-me-predictions-bad-match-id.spec.ts        # 400
            ├── slice-003-matches-lock-state-editable.spec.ts        # R-012
            ├── slice-003-matches-lock-state-locked-window.spec.ts   # R-012
            ├── slice-003-matches-lock-state-locked-status.spec.ts   # R-012
            ├── slice-003-matches-lock-state-boundary.spec.ts        # R-012 / SC-001
            ├── slice-003-matches-lock-state-after-config-change.spec.ts  # SC-005
            └── slice-003-ui-display-countdown.spec.ts               # US4 / R-014

supabase/
├── migrations/                            # (existing — Slices 001 / 002 already populated)
│   ├── 0029_predictions.sql               # (new) predictions table + indexes + unique partial index
│   ├── 0030_is_prediction_locked.sql      # (new) locked cross-slice predicate function
│   ├── 0031_predictions_rls.sql           # (new) RLS on predictions
│   ├── 0032_predictions_audit_trigger.sql # (new) AFTER INSERT/UPDATE on predictions → audit_log
│   ├── 0033_submit_prediction_sp.sql      # (new) locked cross-slice SP
│   ├── 0034_lock_window_score_bound_seed.sql  # (new) seed tournament_config keys lock_window_minutes (60) + score_upper_bound (20)
│   └── 0035_kickoff_correction_audit_trigger.sql  # (new) AFTER UPDATE on matches → audit_log entries per affected prediction (FR-013)
├── seed/
│   └── slice-003-fixture.sql              # (new) 6 boundary-calibrated matches + 4 pre-submitted predictions
└── tests/
    └── pgtap/
        ├── is_prediction_locked_far_before.sql
        ├── is_prediction_locked_strict_boundary_at.sql
        ├── is_prediction_locked_strict_boundary_just_outside.sql
        ├── is_prediction_locked_strict_boundary_just_inside.sql
        ├── is_prediction_locked_status_in_progress.sql
        ├── is_prediction_locked_status_finished.sql
        ├── is_prediction_locked_status_postponed.sql
        ├── is_prediction_locked_status_cancelled.sql
        ├── is_prediction_locked_unknown_match.sql
        ├── is_prediction_locked_config_changes.sql
        ├── is_prediction_locked_uses_db_clock.sql
        ├── is_prediction_locked_perf.sql
        ├── submit_prediction_create_happy.sql
        ├── submit_prediction_update_supersedes.sql
        ├── submit_prediction_locked_window.sql
        ├── submit_prediction_locked_status_in_progress.sql
        ├── submit_prediction_invalid_score.sql
        ├── submit_prediction_invalid_match.sql
        ├── submit_prediction_ineligible.sql
        ├── submit_prediction_serializes_concurrent.sql
        ├── submit_prediction_audit_format.sql
        ├── submit_prediction_admin_override.sql
        └── slice-003-me-predictions-rls.sql
```

**Structure Decision**: **Option 2 (web application)** — same as Slices 001 + 002. The slice's authoritative business logic lives in `supabase/migrations/` (SP + predicate + RLS + audit) per Constitution Principle III; the Next.js layer is read-only presentation + a thin write-path route handler that delegates entirely to the SP. Tests live with the layer they validate.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | _(none)_   | _(none)_                            |
