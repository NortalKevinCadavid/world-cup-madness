# Implementation Plan: Match Catalog & Provider Sync

**Branch**: `002-match-catalog` | **Date**: 2026-05-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-match-catalog/spec.md`

## Summary

Implement the vertical slice that turns the FIFA World Cup 2026 official schedule into a queryable
internal catalog (FR-001) and keeps that catalog in sync with an external provider through a
**provider-agnostic abstraction** (FR-003, FR-004, FR-005). All canonical timestamps are stored
in UTC (FR-002, Constitution Principle VI). The slice ships the cross-slice contracts every
downstream slice depends on — the `matches` table, the `match_results` table (including the
`home_score_for_scoring` columns Slice 005's scoring engine reads by name), the `teams` table,
the `MatchDataProviderAdapter` TypeScript interface, and the `record_match_result` stored
procedure. Provider failure paths (US3) are first-class: the catalog continues to serve
last-known-good data through outages, sustained-outage alerts fire exactly once per outage, and
inconsistent payloads (empty, duplicate, conflicting) are quarantined rather than auto-applied.

## Technical Context

**Language/Version**: TypeScript 5.x (Next.js + Edge Functions); SQL (PostgreSQL 15+, Supabase-managed) for the catalog schema, RLS, and the `record_match_result` stored procedure.

**Primary Dependencies** (additive over Slice 001):
- **Backend / data**: Supabase (Postgres, Edge Functions, `pg_cron`, `pg_net`) — ratified by the Constitution's *Implementation Platform* section.
- **Frontend**: Next.js 14+ (App Router) — already present from Slice 001.
- **Provider adapter runtime**: Deno (Supabase Edge Function); each concrete adapter is a Deno module under `supabase/functions/_shared/providers/<name>/`.
- **`pg_cron` extension**: enabled in `supabase/config.toml` for scheduled sync invocation.
- **`pg_net` extension**: already enabled by Slice 001 (for the auth-hook + audit chain) or enabled here if not.

**Storage**: Supabase Postgres. New artifacts:
- Tables: `teams`, `matches`, `match_results`, `match_provider_external_ids`, `team_provider_external_ids`, `provider_sync_runs`, `provider_sync_state`, `match_pending_review`.
- Stored procedure: `public.record_match_result(...)` (SECURITY DEFINER — locked cross-slice contract).
- Triggers: audit-row trigger on `matches`, on `match_results`, on `teams` (mirrors Slice 001's pattern).
- Seed: extends `tournament_config` with the keys from `research.md` § R-013.

Existing artifacts consumed (from Slice 001):
- `public.participants`, `public.is_eligible_nortal_participant(uuid)`, `public.is_admin(uuid)` (stub), `public.audit_log`, `public.tournament_config`.

**Testing**:
- **E2E (Constitution Principle IX)**: Playwright. Scenarios authored Given/When/Then against `spec.md` US1/US2/US3 acceptance scenarios plus the 9 spec Edge Cases. RED before implementation.
- **DB / unit**: pgTAP for the `record_match_result` SP, the RLS policies, the conflict-quarantine flow.
- **Edge Function**: Deno tests for the `sync-catalog` Edge Function (advisory lock, retry policy, outage dedup, payload sanity checks, provider swap).

**Target Platform**:
- Frontend: Vercel-hosted Next.js.
- Backend: Supabase managed Postgres + Edge Functions; Pro tier during tournament for `pg_cron` reliability per `stack-decision.md`.
- Browsers: evergreen (last two majors of Chrome, Edge, Firefox, Safari).

**Project Type**: Web application — extending the Slice 001 layout.

**Performance Goals** (anchored to spec SCs and [research.md § R-002 / § R-007](./research.md)):
- Sync end-to-end p95 < 30 s (well under the 60 s Edge Function ceiling; supports SC-001's 5-min trigger-to-reflect).
- Catalog read (`GET /api/matches`, default page_size 50) p95 < 500 ms for ~104 matches with ~1,000 concurrent readers.
- Catalog reflects approved provider schedule update within 5 minutes of trigger (SC-001).
- Sustained-outage alert latency: < 15 min from threshold crossing to alert emission (SC-003).
- Provider swap: zero code changes outside the new adapter file (SC-005).
- 24h provider unavailability: zero participant-visible errors (SC-002).

**Constraints**:
- Trusted server-side time only — every timestamp is UTC, every decision reads from Postgres `now()` (Principle VI, BR-LOCK-006).
- All catalog writes go through SECURITY DEFINER paths (sync coordinator + admin RPC) — no direct INSERT/UPDATE from participant or admin clients (Principle II).
- Provider-specific schemas MUST stay inside adapter modules; the domain layer (slices 003–008) consumes only `NormalizedFixture` / `NormalizedResult` / `NormalizedTeam` / `NormalizedPlayer` (Principle IV).
- All catalog mutations MUST emit an `audit_log` row in the same transaction (Principle V).
- Scoring constants live elsewhere: `home_score_for_scoring` is the column the scoring engine reads; this slice's `record_match_result` enforces CHECK invariants but does NOT compute points.
- The `MatchDataProviderAdapter` signature is a **locked cross-slice contract**.
- `service_role` key stays server-side. The Edge Function uses `SERVICE_ROLE_KEY` only for service-bypass; participant + admin clients NEVER see it.

**Scale/Scope**:
- ~104 matches × ~32 teams = bounded dataset. Catalog reads are the highest-traffic surface (every page view of the participant UI lists upcoming matches).
- Sync write volume: every 5 minutes during live windows, with most syncs producing `success_no_changes`. Peak write burst = ~104 row UPDATEs in a single sync (final-day kickoff time corrections).
- `provider_sync_runs` ledger: ~288 runs/day at 5-min cadence × tournament duration ≈ ~10k rows. Trivial for Postgres.

## Constitution Check

*GATE: MUST pass before Phase 0 research. Re-evaluated at the end of Phase 1.*

The constitution under review is v1.1.0 (`.specify/memory/constitution.md`, last amended 2026-05-15). Each principle is evaluated against this slice's design.

| # | Principle | Evaluation | Status |
|---|-----------|------------|--------|
| I | Technology Neutrality | `spec.md` is vendor-neutral; this plan keeps Supabase / Deno / Next.js details in the implementation layer. The data model uses capability language ("normalized fixture", "configuration store", "provider sync ledger") — product names appear only in `plan.md`, `research.md`, `contracts/`, and `quickstart.md`. The `MatchDataProviderAdapter` interface is provider-agnostic by construction. | ✅ |
| II | Security by Design | Every catalog write goes through SECURITY DEFINER paths (sync coordinator + `record_match_result` SP). Participants and admins NEVER have direct INSERT/UPDATE on `matches` / `match_results` / `teams`. Internal-auth header (`X-Internal-Auth`) gates the scheduled-trigger path; admin path requires `is_admin(auth.uid())`. Service-role key stays in Edge Function env, never in client bundles. Catalog reads enforce eligibility via `is_eligible_nortal_participant(auth.uid())` from Slice 001. | ✅ |
| III | Rules Outside the UI | Catalog filtering / pagination is plain SQL behind the route handler. The score-handling invariants (CHECK `_for_scoring <= _official`, shootout level-check) live in the SP body. Conflict-quarantine logic lives in the coordinator + SP, not in the UI. The Next.js participant UI is presentation-only. | ✅ |
| IV | Provider Abstraction | The `MatchDataProviderAdapter` interface ([contracts/provider-adapter.contract.md](./contracts/provider-adapter.contract.md)) is the single point of decoupling. Adapters never write to Postgres; they convert provider-specific JSON into normalized internal types. Domain code (slices 003–008) imports only the `Normalized*` types. SC-005's provider-swap test validates this contract. | ✅ |
| V | Auditability | Every catalog mutation (`team`, `match`, `match_result`) writes an `audit_log` row in the same transaction via row triggers (mirrors Slice 001's participant-trigger pattern). The `provider_sync_runs` ledger captures every sync invocation. Conflict-quarantined rows produce `audit_log` `action='match.conflict_quarantined'`. Outage alerts produce `action='provider.outage_alert_emitted'` / `'provider.recovered'`. | ✅ |
| VI | Time-Zone Correctness | All timestamps are `timestamptz` stored in UTC. Postgres session timezone is set to UTC in `supabase/config.toml`. Client uses `Intl.DateTimeFormat` to localize for display only. Lock decisions (Slice 003's domain) operate on `matches.kickoff_utc` directly; no localized representation feeds any decision. SC-004 (zero wrong-locale displays across 1,000 simulated reads) is verified by `slice-002-catalog-locale-display.spec.ts`. | ✅ |
| VII | Operational Resilience | Sync is **idempotent under retry** (R-003: UPSERT keyed by `(provider_name, provider_match_id)` mapping). The coordinator uses an advisory lock to serialize sync runs per provider (R-006). Empty / undersized / duplicate payloads are rejected without mutating the catalog (R-004 / R-005). The catalog continues serving last-known-good data through provider outages (SC-002). Sustained-outage alert dedup is exactly-once per outage via `provider_sync_state` (R-008 / SC-003). The Edge Function operates within Supabase's 60-s ceiling; longer syncs split across cycles. | ✅ |
| VIII | Extensibility & Configuration | Provider selection (`provider.active`), retry policy, outage threshold, undersized threshold, kickoff tolerance, knockout score basis, and sync cadence all live in `tournament_config`. No hard-coded constants in code or SQL. Slice 008 will own the admin UI for these keys. | ✅ |
| IX | TDD via BDD (NON-NEGOTIABLE) | Playwright Given/When/Then scenarios committed FIRST (red), covering every Acceptance Scenario in `spec.md` (US1 × 3, US2 × 3, US3 × 3) plus the 9 spec Edge Cases. pgTAP scenarios cover the `record_match_result` SP and the RLS. Deno tests cover the `sync-catalog` Edge Function (advisory lock, retry, payload sanity, conflict quarantine, outage dedup, provider swap). Reviewers MUST reject any change to the sync/catalog surface that lacks a matching red-first scenario. | ✅ |
| X | Vertical Slice Delivery | Each user story is its own complete vertical: US1 (catalog read) → schema + RLS + route handler + UI page; US2 (provider abstraction) → adapter interface + coordinator + swap test; US3 (failure resilience) → payload sanity + advisory lock + outage dedup + alert. US1 is shippable on its own; US2 layers in the abstraction; US3 hardens the failure paths. Player ingest (Slice 004) and admin manual-result UI (Slice 006) are **deliberately deferred** ([research.md § R-015](./research.md#r-015--out-of-scope-intentionally-deferred)). | ✅ |
| XI | Regression-Gated Progress (NON-NEGOTIABLE) | Slice 001's full regression suite MUST stay green throughout this slice's work; no `participants`, `is_eligible_nortal_participant`, or `audit_log` regression is tolerated. The `tasks.md` produced by `/speckit-tasks` MUST place red-gate verification before any implementation task and MUST include a "Slice 001 still green" gate between user stories. The five cross-slice contracts (table shapes, adapter interface, SP signature) are locked at merge and form Slice 003's regression baseline. | ✅ |

**Eligibility / Privacy / Compliance constraints** (non-principle hard rules):
- **Domain-restricted access** ✅ — catalog reads gated by `is_eligible_nortal_participant(auth.uid())`.
- **No gambling** ✅ — no monetary fields anywhere; not applicable.
- **Data minimization** ✅ — `teams` carries only `(name, short_code, flag_url)`; `players` is deferred to Slice 004 with the same data-minimization posture.
- **Public API restriction** ✅ — every route requires an authenticated Nortal session; the sync Edge Function requires either internal-auth or admin JWT.

**Verdict**: ✅ No violations. Proceed to Phase 0.

### Post-Phase-1 re-check (after `research.md`, `data-model.md`, `contracts/`, `quickstart.md`)

| Principle | Post-design status | Notes |
|---|---|---|
| I | ✅ | `data-model.md` is vendor-neutral; product names contained to plan/research/contracts/quickstart. |
| II | ✅ | `contracts/sync-runner.scheduled.md` enforces internal-auth + admin checks; `contracts/match-results.write.md` enforces SP-level invariants. RLS posture in `data-model.md` covers all eight tables. |
| III | ✅ | All rule logic in SQL (the SP and the CHECKs) plus the coordinator's conflict logic; Next.js layer is read-only. |
| IV | ✅ | `contracts/provider-adapter.contract.md` is the locked single-point-of-decoupling. SC-005's swap test in `contracts/sync-runner.scheduled.md` § Test surface validates. |
| V | ✅ | Row triggers + `provider_sync_runs` ledger + `audit_log` rows for every catalog mutation. |
| VI | ✅ | All timestamps `timestamptz`; `Intl.DateTimeFormat` for display; explicit pgTAP + Playwright tests for SC-004. |
| VII | ✅ | Idempotency (R-003), advisory lock (R-006), retry policy (R-007), outage dedup (R-008), last-known-good preservation (R-004). |
| VIII | ✅ | All operationally-flexible values in `tournament_config`; `research.md` R-013 enumerates. |
| IX | ✅ | Playwright + pgTAP + Deno scenarios catalogued in every contract's "Test surface" section. |
| X | ✅ | US1 → US2 → US3 each independently demonstrable; quickstart confirms slice-level completeness. Player + admin UI deferred per R-015. |
| XI | ✅ | `quickstart.md` Definition of Done requires Slice 001's regression suite to remain green and this slice's Playwright + pgTAP + Deno all GREEN before downstream slices start. |

**Verdict (post-design)**: ✅ No new violations introduced. Plan is ready for `/speckit-tasks`.

(Complexity Tracking section omitted — no violations to justify.)

## Project Structure

### Documentation (this feature)

```text
specs/002-match-catalog/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan)
├── data-model.md        # Phase 1 output (/speckit-plan)
├── quickstart.md        # Phase 1 output (/speckit-plan)
├── contracts/           # Phase 1 output (/speckit-plan)
│   ├── provider-adapter.contract.md  # locked cross-slice TS interface
│   ├── match-catalog.read.md         # GET /api/matches
│   ├── sync-runner.scheduled.md      # sync-catalog Edge Function
│   └── match-results.write.md        # record_match_result SP
├── checklists/
│   └── requirements.md  # already exists (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

This slice extends the layout introduced by Slice 001. Directories marked **(new)** are introduced here.

```text
apps/
└── web/                                  # (existing — Slice 001)
    ├── app/
    │   ├── (participant)/
    │   │   └── matches/page.tsx          # (new) match-list participant UI
    │   └── api/
    │       └── matches/route.ts          # (new) GET /api/matches
    ├── lib/
    │   ├── catalog/                      # (new) thin client/server helpers (read-only)
    │   │   ├── client.ts                 # supabase-js wrapper for the catalog
    │   │   └── format.ts                 # locale-aware kickoff display helpers
    │   └── types/
    │       └── match.ts                  # (new) cross-slice Match/MatchResult TypeScript types
    └── tests/
        └── playwright/
            ├── slice-002-catalog-eligible-200.spec.ts
            ├── slice-002-catalog-401.spec.ts
            ├── slice-002-catalog-403-domain-removed.spec.ts
            ├── slice-002-catalog-filters.spec.ts
            ├── slice-002-catalog-pagination.spec.ts
            ├── slice-002-catalog-bad-params.spec.ts
            ├── slice-002-catalog-no-leak.spec.ts
            ├── slice-002-catalog-locale-display.spec.ts
            ├── slice-002-late-fixture-appears.spec.ts          # US1.3
            ├── slice-002-provider-swap.spec.ts                 # SC-005
            ├── slice-002-empty-payload-served-last-known.spec.ts # US3.1 / SC-002
            ├── slice-002-conflict-quarantined.spec.ts          # US2 Edge Case + FR-009
            └── slice-002-outage-alert-dedup.spec.ts            # US3.2 / SC-003

supabase/
├── migrations/                            # (existing — Slice 001 already populated)
│   ├── 0019_teams.sql                     # (new) teams + team_provider_external_ids + indexes
│   ├── 0020_matches.sql                   # (new) matches + match_provider_external_ids + indexes
│   ├── 0021_match_results.sql             # (new) match_results table + CHECK invariants
│   ├── 0022_provider_sync_tables.sql      # (new) provider_sync_runs + provider_sync_state
│   ├── 0023_match_pending_review.sql      # (new) conflict quarantine table
│   ├── 0024_record_match_result_sp.sql    # (new) SECURITY DEFINER SP + pg_notify channel
│   ├── 0025_catalog_audit_triggers.sql    # (new) AFTER INSERT/UPDATE on teams/matches/match_results → audit_log
│   ├── 0026_catalog_rls.sql               # (new) RLS on all eight tables
│   ├── 0027_pg_cron_sync_schedule.sql     # (new) pg_cron schedule + trigger_sync_catalog wrapper
│   └── 0028_provider_config_defaults.sql  # (new) seed tournament_config keys per research § R-013
├── functions/
│   ├── _shared/
│   │   └── providers/                     # (new) the adapter directory
│   │       ├── types.ts                   # the locked MatchDataProviderAdapter interface
│   │       ├── footballdata/
│   │       │   └── index.ts               # football-data.org adapter
│   │       └── stub/
│   │           ├── index.ts               # stub provider for tests
│   │           └── fixtures/wc2026-snapshot.json
│   └── sync-catalog/                      # (new) the coordinator Edge Function
│       ├── index.ts
│       └── tests/
│           ├── single_sync_happy.test.ts
│           ├── idempotent_retry.test.ts
│           ├── advisory_lock_returns_409.test.ts
│           ├── non_admin_returns_403.test.ts
│           ├── internal_auth_path.test.ts
│           ├── empty_payload_rejected.test.ts
│           ├── undersized_payload_rejected.test.ts
│           ├── duplicate_in_payload_rejected.test.ts
│           ├── cross_run_conflict_quarantined.test.ts
│           ├── score_before_kickoff_quarantined.test.ts
│           ├── outage_alert_dedup.test.ts
│           ├── recovery_clears_outage_state.test.ts
│           └── provider_swap.test.ts
├── seed/
│   └── slice-002-fixture.sql              # (new) 8 teams + 4 matches + 1 pending-review row
└── tests/
    └── pgtap/                              # (existing — Slice 001 populated)
        ├── record_match_result_happy.sql
        ├── record_match_result_rejects_pre_finished.sql
        ├── record_match_result_enforces_for_scoring_invariant.sql
        ├── record_match_result_enforces_shootout_invariant.sql
        ├── record_match_result_admin_correction_requires_approver.sql
        ├── record_match_result_admin_correction_requires_admin.sql
        ├── record_match_result_emits_notification.sql
        ├── record_match_result_audit_format.sql
        └── slice-002-catalog-rls.sql
```

**Structure Decision**: **Option 2 (web application)** — same as Slice 001. The product is a
participant-facing web app (Next.js on Vercel) plus a server-side data/business-rules tier
(Supabase Postgres + Edge Functions). This slice's authoritative business logic lives in
`supabase/migrations/` (the SP, RLS, audit triggers) and `supabase/functions/sync-catalog/`
(the coordinator); the Next.js layer is read-only presentation over Postgres views and the
route handler. Tests live with the layer they validate: pgTAP next to SQL, Deno next to
Edge Functions, Playwright next to UI.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | _(none)_   | _(none)_                            |
