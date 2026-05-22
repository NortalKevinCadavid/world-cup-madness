# Implementation Plan: Eligibility & Login

**Branch**: `001-eligibility-login` | **Date**: 2026-05-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-eligibility-login/spec.md`

## Summary

Implement the foundation vertical slice that gates the entire application: corporate-IdP sign-in
(FR-001), server-side rejection of non-approved domains at every entry path (FR-002), and
participant-profile provisioning on first eligible login (FR-003) with idempotent refresh on
returning logins (FR-004). The slice ships **the cross-slice eligibility primitives** every
downstream slice depends on — the `participants` table, the `is_eligible_nortal_participant(uuid)`
SQL function, and the `audit_log` write pattern. Eligibility is enforced at four layers
(Supabase Auth provider config → Auth Hook → Postgres RLS → API route guard) per architecture
§11.2 control 27–31, so no single misconfiguration can let an ineligible user through. All
denials are audited in the same transaction as the decision (Constitution Principle V).

## Technical Context

**Language/Version**: TypeScript 5.x (Next.js App Router + Edge Functions if any); SQL (PostgreSQL 15+, Supabase-managed) for the eligibility predicate, RLS, and the auth hook.

**Primary Dependencies**:
- **Backend / data**: Supabase (Postgres, Auth, RLS, Edge Functions) — ratified by the Constitution's *Implementation Platform* section.
- **Frontend**: Next.js 14+ (App Router) with React + TypeScript + Tailwind CSS — per `docs/architecture/stack-decision.md` (Proposed for the frontend; ratified for backend).
- **Auth**: Supabase Auth + an external OIDC provider. Production: **Microsoft Entra ID (Azure AD)**. Local/CI: a stubbed OIDC provider sidecar (see `quickstart.md` § Auth provider setup).
- **Server SDK / DB access**: `@supabase/supabase-js` and `@supabase/auth-helpers-nextjs` for server components.
- **Citext extension** for case-insensitive email storage.

**Storage**: Supabase Postgres. New artifacts in this slice:
- `public.participants` (one row per eligible Nortal collaborator)
- `public.is_eligible_nortal_participant(uuid) RETURNS boolean STABLE` — locked cross-slice contract
- `public.is_approved_domain(text) RETURNS boolean STABLE` — internal helper
- `public.is_admin(uuid) RETURNS boolean STABLE` — permissive stub; replaced by Slice 006
- `public.handle_auth_user_created(jsonb) RETURNS jsonb SECURITY DEFINER` — auth hook (first login)
- `public.handle_auth_user_signed_in(jsonb) RETURNS jsonb SECURITY DEFINER` — auth hook (returning)
- `public.tournament_config` table — **stubbed** by this slice (Slice 008 owns; this slice creates it if missing and seeds `eligibility.approved_domains = ["nortal.com"]`).
- `public.audit_log` table — **stubbed** by this slice (Slice 007 owns; this slice creates it if missing and writes the slice's `access.*` and `participant.*` rows).

Existing artifacts consumed (none from prior slices — this **is** the foundation):
- `auth.users`, `auth.identities` (Supabase Auth managed).

**Testing**:
- **E2E (Constitution Principle IX)**: Playwright. Scenarios authored Given/When/Then against `spec.md` US1 / US2 / US3 acceptance scenarios plus the seven spec Edge Cases (mapped in [research.md § R-011](./research.md#r-011--edge-case-handling-matrix)). RED before any production code.
- **DB / unit**: pgTAP for the eligibility predicate, the auth hooks, and the RLS policies — same red-green-refactor cycle.
- **Contract**: HTTP-level tests against `/api/me` and the `/auth/callback` + `/auth/denied` pages.

**Target Platform**:
- Frontend: Vercel-hosted Next.js (web; mobile-friendly responsive).
- Backend: Supabase managed Postgres + Auth (Pro tier during tournament for SLA per `stack-decision.md`); Edge Functions on the Supabase Deno runtime if any are added (this slice ships none — all hook logic is in-Postgres).
- Browsers: evergreen (last two majors of Chrome, Edge, Firefox, Safari).

**Project Type**: Web application — single Next.js app (participant + eventual admin routes) on top of Supabase.

**Performance Goals** (anchored to SC-002 and to [research.md § R-012](./research.md#r-012--performance-and-sla-posture)):
- Auth-hook latency: < 200 ms p95.
- `is_eligible_nortal_participant(uuid)`: < 5 ms p95 — every other slice's RLS calls this inline.
- Returning-user → dashboard end-to-end: < 10 s p95 (SC-002).
- Zero duplicate `participants` rows under 1,000 concurrent returning sign-ins for the same identity (SC-005) — guaranteed by `participants.auth_user_id UNIQUE` + Postgres MVCC.
- Approved-domain config change → effective for new evaluations within 1 minute (SC-004 / FR-007) — guaranteed by reading `tournament_config` fresh on every check; no app-tier cache.

**Constraints**:
- Trusted server-side enforcement only — RLS + auth hook + API guard. UI-only gating MUST NOT be the sole gate (FR-002, Principle II).
- `service_role` key MUST stay server-side (Supabase env, never in client bundles).
- Fail-closed on every eligibility-decision input being unavailable (FR-008, Principle II).
- All access-decision writes MUST emit an `audit_log` row in the **same transaction** (FR-006, FR-018, Principle V — NON-NEGOTIABLE).
- The `is_eligible_nortal_participant(uuid)` signature and semantics are a **locked cross-slice contract** after this slice ships (Principle XI).
- No HR / payroll / performance attributes ingested (FR-009, *Data minimization* hard rule).

**Scale/Scope**:
- ~500 participants total across the tournament; ~1,000 logins/day at peak (returning users).
- Audit volume: ~1 row per login + ~1 row per profile mutation. Bounded to ~2,000 rows/day at peak — trivial for Postgres.
- The `participants` table is queried by every RLS predicate in every other slice; the access pattern is "single-row lookup by `auth_user_id`" — supported by a UNIQUE index, no scan path.

## Constitution Check

*GATE: MUST pass before Phase 0 research. Re-evaluated at the end of Phase 1.*

The constitution under review is v1.1.0 (`.specify/memory/constitution.md`, last amended 2026-05-15). Each principle is evaluated against this slice's design.

| # | Principle | Evaluation | Status |
|---|-----------|------------|--------|
| I | Technology Neutrality | `spec.md` is vendor-neutral; this plan keeps Supabase/Next.js/Entra ID details in the implementation layer (here + research.md + contracts), not in spec or data-model. The data model uses capability language ("row-level authorization", "server-side authentication hook", "configuration store") — product names appear only in `plan.md`, `research.md`, `contracts/`, and `quickstart.md`. | ✅ |
| II | Security by Design | Domain eligibility is enforced at four server-side layers (R-002): Supabase Auth provider config, the auth hook (the gate that turns "authenticated" into "eligible"), Postgres RLS (the safety net), and an explicit per-handler `requireEligible()` check (R-009). UI gating is permitted for UX but is never the sole gate. Service-role key stays server-side. Fail-closed on every input being unavailable (R-007). | ✅ |
| III | Rules Outside the UI | `is_eligible_nortal_participant(uuid)` lives in Postgres as a single function (R-006). Every slice from 002 onward references it; new surfaces (admin tools, eventual mobile, exports) consume the same function. No re-implementation in TypeScript anywhere. The auth-hook decision and the API-guard decision both call `is_approved_domain()` — same source of truth. | ✅ |
| IV | Provider Abstraction | This slice treats the IdP (Entra ID today, Okta / Google Workspace tomorrow) as one OIDC provider behind Supabase Auth's adapter (R-001). Domain-logic code in the eligibility predicate references only normalized internal columns (`participants.email`, `tournament_config.value`); it never reads provider-specific claims. Replacing the IdP is a Supabase Auth config change. | ✅ |
| V | Auditability | Every access decision (granted/denied) and every profile mutation writes an `audit_log` row in the same transaction as the action (R-008). The auth hook is `SECURITY DEFINER` running in-Postgres, so the audit insert shares the transaction with the participant write. The `participants` row trigger emits a defensive second audit row (`pg_trigger_depth() = 1` prevents recursion). Audit table is append-only via the RLS posture (no UPDATE / DELETE policies). | ✅ |
| VI | Time-Zone Correctness | All timestamps (`first_login_at`, `last_login_at`, `audit_log.occurred_at`) are `timestamptz` and defaulted to Postgres `now()`. No client clock participates in any decision. (Lock semantics are not in this slice's scope; covered by slices 003 + 004.) | ✅ |
| VII | Operational Resilience | The slice's failure paths all fail closed — no allow-by-default exists anywhere in the auth pipeline (R-007). The auth hook is idempotent on race: `participants_email_uk` + `participants_auth_user_id_uk` serialize concurrent first-logins for the same identity, guaranteeing SC-005's zero-duplicate invariant. No external dependencies (this slice has no provider integrations) — degraded modes are not applicable. | ✅ |
| VIII | Extensibility & Configuration | Approved-domain list lives in `tournament_config` and is changeable via Slice 008 admin UI without a code deploy (FR-007 / SC-004). No hard-coded domain strings in code or migrations beyond the seed default `["nortal.com"]`, which is explicitly a placeholder for OD-001. The auth-hook decision threshold ("must match an approved domain") is the only rule; if business adds a "must also be in a roles table" rule later, it's a body change in one SQL function. | ✅ |
| IX | TDD via BDD (NON-NEGOTIABLE) | Playwright Given/When/Then scenarios are committed FIRST (red), covering every Acceptance Scenario in `spec.md` (US1 × 3, US2 × 3, US3 × 2) plus the seven spec Edge Cases (E-1…E-7, mapped 1:1 to test files in `research.md` § R-011). pgTAP scenarios cover the predicate, the auth hook, and RLS. Reviewers MUST reject any change to the eligibility surface that lacks a matching red-first scenario. | ✅ |
| X | Vertical Slice Delivery | Each user story (US1 → first eligible login, US2 → ineligible denied at UI + API, US3 → returning user with changed attributes) is its own complete vertical: scenario → SQL function or auth hook → Next.js page/API → audit. US1 is shippable on its own (it demonstrably provisions a profile end-to-end), then US2 layers in (denial paths), then US3 (refresh). No story is half-built before the next starts. Admin-side work (role enforcement, Slice 008 config UI) is **deliberately deferred** out of scope (spec §Assumptions, [research.md § R-013](./research.md#r-013--out-of-scope-intentionally-deferred)). | ✅ |
| XI | Regression-Gated Progress (NON-NEGOTIABLE) | This is the *first* slice — there is no prior baseline to keep green. Instead, this slice **establishes** the baseline. The `tasks.md` produced by `/speckit-tasks` MUST require: (1) red-gate before implementation, (2) every Playwright + pgTAP test passing in CI before merge, (3) a `regression-baseline.md` artifact in this slice's folder that subsequent slices reference. The locked cross-slice contracts (the SQL predicate, the table shape, the audit shape) form the durable invariant Slices 002–008 will regress-test against. | ✅ |

**Eligibility / Privacy / Compliance constraints** (non-principle hard rules):
- **Domain-restricted access** ✅ — enforced at four layers (R-002).
- **No gambling** ✅ — no monetary fields anywhere in this slice; not applicable.
- **Data minimization** ✅ — `participants` columns exactly match FR-003 (display_name, email, domain, region, status, first_login_at, last_login_at); no HR fields. FR-009 enforced by spec + code review.
- **Public API restriction** ✅ — every route requires an authenticated Nortal session via the auth-hook gate. `/api/me` returns 401 on missing JWT; no anonymous routes.

**Verdict**: ✅ No violations. Proceed to Phase 0.

### Post-Phase-1 re-check (after `research.md`, `data-model.md`, `contracts/`, `quickstart.md`)

| Principle | Post-design status | Notes |
|---|---|---|
| I | ✅ | `data-model.md` is vendor-neutral; Supabase/Next.js/Entra ID named only in `plan.md`, `research.md`, `contracts/*`, `quickstart.md`. The entities (Participant, Approved Domain, Access Decision Event) use capability language. |
| II | ✅ | `contracts/auth-hook.sql.md` enforces the gate inside the auth transaction. `contracts/eligibility-predicate.sql.md` locks the cross-slice predicate. `contracts/participant-me.read.md` enforces user-JWT-only reads (no service-role). RLS posture in `data-model.md` covers all three new tables. |
| III | ✅ | Confirmed via `research.md` R-006 and `contracts/eligibility-predicate.sql.md` — the predicate is the single source of truth for "is this caller eligible?" Every slice from 002+ references it. |
| IV | ✅ | Confirmed via `research.md` R-001 — IdP is replaceable via Supabase Auth provider config. The eligibility predicate reads only `participants` and `tournament_config`, never IdP claims. |
| V | ✅ | Auth-hook + `participants` trigger jointly guarantee same-transaction audit. `data-model.md` § 3 documents the write paths. |
| VI | ✅ | All timestamps `timestamptz`; auth-hook reads `now()` from Postgres; no client timestamp is ever load-bearing. |
| VII | ✅ | `research.md` R-007 (fail-closed) and R-012 (perf) plus the `auth_hook_fails_closed_on_missing_config.sql` pgTAP test cover degraded modes. |
| VIII | ✅ | `data-model.md` § 2 + `research.md` R-005 confirm `tournament_config.eligibility.approved_domains` is the rule source. Default seed exists; admin UI replaces. |
| IX | ✅ | Playwright + pgTAP scenarios catalogued in every contract's "Test surface" section, anchored to spec Acceptance Scenarios and SCs and to the seven Edge Cases in R-011. |
| X | ✅ | US1 → US2 → US3 each independently demonstrable; quickstart verification steps confirm slice-level completeness. Admin and configuration UIs deferred (R-013) and tracked. |
| XI | ✅ | `quickstart.md` Definition of Done requires every Playwright + pgTAP test GREEN before downstream slices start. The cross-slice contracts (predicate, table, audit shape) are explicitly locked. |

**Verdict (post-design)**: ✅ No new violations introduced. Plan is ready for `/speckit-tasks`.

(Complexity Tracking section omitted — no violations to justify.)

## Project Structure

### Documentation (this feature)

```text
specs/001-eligibility-login/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan)
├── data-model.md        # Phase 1 output (/speckit-plan)
├── quickstart.md        # Phase 1 output (/speckit-plan)
├── contracts/           # Phase 1 output (/speckit-plan)
│   ├── eligibility-predicate.sql.md     # cross-slice locked contract
│   ├── auth-hook.sql.md                 # the primary eligibility gate
│   ├── auth-callback.page.md            # Next.js post-IdP routing
│   └── participant-me.read.md           # GET /api/me self-profile read
├── checklists/
│   └── requirements.md  # already exists (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

This slice **introduces** the Next.js + Supabase repo layout. Every later slice consumes what this slice creates. Directories marked **(new)** are introduced here.

```text
apps/
└── web/                                    # (new) Next.js App Router
    ├── app/
    │   ├── auth/
    │   │   ├── callback/page.tsx           # (new) /auth/callback (server component)
    │   │   └── denied/page.tsx             # (new) /auth/denied (server component)
    │   ├── dashboard/page.tsx              # (new) placeholder Welcome page (slices 002+ replace)
    │   ├── api/
    │   │   └── me/route.ts                 # (new) GET /api/me
    │   └── layout.tsx                      # (new) root layout
    ├── lib/
    │   ├── auth/
    │   │   ├── requireEligible.ts          # (new) the cross-slice handler-guard helper
    │   │   └── getCurrentParticipant.ts    # (new) thin client over /api/me
    │   └── types/
    │       └── participant.ts              # (new) cross-slice Participant TypeScript type
    ├── tests/
    │   └── playwright/
    │       ├── slice-001-login-approved.spec.ts             # (new) US1
    │       ├── slice-001-login-denied-domain.spec.ts        # (new) US2 UI path
    │       ├── slice-001-login-missing-claims.spec.ts       # (new) Edge E-1
    │       ├── slice-001-returning-login-refresh.spec.ts    # (new) US3
    │       ├── slice-001-email-drift.spec.ts                # (new) R-010
    │       ├── slice-001-domain-removed-mid-session.spec.ts # (new) Edge E-3 / FR-007
    │       ├── slice-001-api-me-200.spec.ts                 # (new) /api/me happy
    │       ├── slice-001-api-me-401.spec.ts                 # (new) /api/me no-jwt
    │       ├── slice-001-api-me-403-domain-removed.spec.ts  # (new) Edge E-2 / FR-002 API path
    │       ├── slice-001-api-me-no-leak.spec.ts             # (new) US2 no-info-leak
    │       ├── slice-001-callback-success.spec.ts           # (new) callback page happy
    │       ├── slice-001-callback-denied-domain.spec.ts     # (new) callback denial redirect
    │       ├── slice-001-denied-no-leak.spec.ts             # (new) denial-screen no-info-leak
    │       ├── slice-001-denied-renders-without-session.spec.ts # (new) denial-screen reachable
    │       └── slice-001-callback-no-code.spec.ts           # (new) callback robustness
    ├── package.json                        # (new) declares Playwright, Next.js, supabase-js deps
    ├── playwright.config.ts                # (new) Playwright harness
    └── tsconfig.json                       # (new)

supabase/
├── migrations/
│   ├── 0001_participants.sql                       # (new) participants table + indexes + trigger
│   ├── 0002_tournament_config_stub.sql             # (new) tournament_config table stub + seed default
│   ├── 0003_audit_log_stub.sql                     # (new) audit_log table stub (Slice 007 extends)
│   ├── 0004_is_approved_domain.sql                 # (new) helper function
│   ├── 0005_is_eligible_nortal_participant.sql     # (new) cross-slice locked predicate
│   ├── 0006_is_admin_stub.sql                      # (new) permissive stub (Slice 006 replaces)
│   ├── 0007_participants_rls.sql                   # (new) RLS on participants + audit_log + config
│   ├── 0008_participants_audit_trigger.sql         # (new) AFTER INSERT/UPDATE → audit_log
│   └── 0009_auth_hooks.sql                         # (new) handle_auth_user_created + handle_auth_user_signed_in
├── functions/                                       # (new — empty for this slice)
├── seed/
│   └── slice-001-fixture.sql                       # (new) deterministic 5-account fixture
├── tests/
│   └── pgtap/
│       ├── is_eligible_active_approved.sql                  # (new)
│       ├── is_eligible_deactivated.sql                      # (new)
│       ├── is_eligible_unknown_uid.sql                      # (new)
│       ├── is_eligible_null_uid.sql                         # (new)
│       ├── is_eligible_domain_removed.sql                   # (new) FR-007 mid-tournament
│       ├── is_eligible_config_missing.sql                   # (new) Edge E-5 fail-closed
│       ├── is_eligible_rls_applied.sql                      # (new)
│       ├── is_eligible_perf.sql                             # (new) p95 < 5 ms
│       ├── auth_hook_first_login.sql                        # (new)
│       ├── auth_hook_returning_login.sql                    # (new)
│       ├── auth_hook_fails_closed_on_missing_config.sql     # (new) Edge E-5
│       └── slice-001-api-me-rls.sql                         # (new) /api/me RLS isolation
└── config.toml                              # (new) Supabase project config including [auth.hook.*]
```

**Structure Decision**: **Option 2 (web application)**. The product is a participant-facing web app
(Next.js on Vercel) plus a server-side data/business-rules tier (Supabase Postgres + Auth Hooks).
This slice's authoritative business logic lives in `supabase/migrations/` (auth hooks + the
eligibility predicate + RLS) per Constitution Principle III; the Next.js layer is the read /
session-management surface. Tests live with the layer they validate: pgTAP next to the SQL it
tests, Playwright next to the UI it tests.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | _(none)_   | _(none)_                            |
