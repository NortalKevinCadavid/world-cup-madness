# Implementation Plan: Admin Overrides & Recalculation

**Branch**: `006-admin-overrides` | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-admin-overrides/spec.md`

## Summary

Implement the integration / orchestration slice that gives tournament administrators authority
to correct data and trigger recalculations across every prior slice's surface. This slice
**replaces Slice 001's permissive `is_admin(uuid)` stub with a real body** that reads from a
new `admin_roles` table (which Slice 008 will eventually expose an admin assignment UI for),
ships a family of seven SECURITY DEFINER RPC wrappers (`admin_record_match_result`,
`admin_update_match`, `admin_submit_prediction`, `admin_submit_final_prediction`,
`admin_update_tournament_award`, `admin_resolve_match_pending_review`, `admin_trigger_recalc`)
that each pre-check admin role + reason/source + advisory lock then delegate to the locked SPs
shipped by Slices 002/003/004/005, and a dedicated `/admin/*` Next.js route tree gated by a new
`requireAdmin(client)` helper. Recalculation orchestration reuses Slice 005's `score-trigger`
Edge Function (FR-016 + idempotency + advisory lock); a Postgres pg_cron reaper job handles
SC-007 resumability of interrupted runs. The `audit_log` table gains an additive
`source_citation` column for FR-002 compliance, and a new `pending_recalc_state` view drives
FR-010's "configuration changed — recalculation pending" indicator on the admin dashboard.

## Technical Context

**Language/Version**: TypeScript 5.x (Next.js App Router); SQL (PostgreSQL 15+, Supabase-managed) for `is_admin` body, the seven `admin_*` RPCs, the reaper function, the `pending_recalc_state` view, and the additive column / RLS changes.

**Primary Dependencies** (additive over Slices 001–005):
- **Backend / data**: Supabase (Postgres, RLS, advisory locks, audit triggers, Edge Functions, pg_cron, pg_net) — all already in place.
- **Frontend**: Next.js 14+ App Router with React + TypeScript + Tailwind CSS + `cmdk` (typeahead from Slice 004) — already in place.
- **Form validation**: `zod` (from Slice 003).
- **Supabase Realtime**: subscription to `score_calculation_runs` for live recalc status on `/admin/recalc`. No new library — uses `@supabase/supabase-js`'s built-in Realtime client.

**Storage**: Supabase Postgres. New / modified artifacts:
- New tables: `admin_roles` (locked cross-slice; Slice 008 ships assignment UI but cannot alter shape).
- Replaced function body: `is_admin(uuid)` — signature unchanged from Slice 001 stub; body now reads `admin_roles`.
- New functions: 7 admin RPC wrappers + 2 sibling bypass-lock SPs + `reap_stale_recalc_runs()`.
- New view: `pending_recalc_state`.
- Additive columns:
  - `audit_log.source_citation text NULL` (additive over Slice 001 stub).
  - `score_calculation_runs.triggering_audit_log_id uuid NULL` (additive over Slice 005 shape).
- New audit-row INSERT policy on `audit_log` for `admin.access_denied` rows (analogous to Slice 003's `api_guard` policy).
- New pg_cron schedule for the reaper job (every 30s).
- Seed: bootstrap admin row in `admin_roles` (operator-configured via `tournament_config.admin.bootstrap_participant_email`).

Existing artifacts consumed:
- From Slice 001: `participants`, `is_eligible_nortal_participant`, `audit_log` (stub shape), `tournament_config` (stub shape), `requireEligible` helper.
- From Slice 002: `matches`, `match_results`, `tournament_award` (Slice 005 owns; Slice 002 references), `match_pending_review`, `record_match_result` SP.
- From Slice 003: `predictions`, `submit_prediction` SP, `is_prediction_locked`.
- From Slice 004: `final_predictions`, `players`, `submit_final_prediction` SP, `is_final_prediction_locked`.
- From Slice 005: `score_calculation_runs`, `score_records`, `tournament_award`, `score-trigger` Edge Function.

**Testing**:
- **E2E (Constitution Principle IX)**: Playwright. Per-RPC happy + auth-rejection tests (~14 specs) + admin page tests (~15 specs) + recalc resilience tests (interrupt + resume, idempotency, concurrent blocked).
- **DB / unit**: pgTAP for `is_admin` body (9 files), each admin RPC (~17 files), reaper function (2 files), `pending_recalc_state` view (1 file).
- **Integration**: validates cross-slice contracts (Slice 005's score-trigger receives admin recalc POST; Slice 003's submit_prediction receives admin-override calls; etc.).

**Target Platform**: same as prior slices — Vercel-hosted Next.js + Supabase managed Postgres.

**Project Type**: Web application — extends prior slices.

**Performance Goals** (anchored to spec SCs):
- `is_admin(uuid)` p95 < 5 ms — called by every admin route guard + every RLS policy that filters on admin. Same budget as Slice 001's stub.
- Admin RPC end-to-end p95 < 500 ms (includes admin check + reason validation + advisory lock + delegate + audit emission).
- Full recalc of 1,000 × 104 + 4 finals < 5 minutes (SC-002) — delegated to Slice 005's score-trigger, which is already designed for this scale.
- Recalc-pending banner appears < 5 seconds after a scoring-config change (SC-005 derived).
- Interrupted recalc resumes within 30-60 seconds via pg_cron reaper (SC-007 — note: spec says "10 seconds of restart"; reaper cadence is the conservative compromise — see Open complexity below).
- 100% of admin actions audited with reason + source_citation (SC-001 / SC-005 / FR-002).

**Constraints**:
- The `is_admin(uuid)` signature is **locked** — body replacement is the only allowable change. Every Slice 001–005 caller continues to work.
- All `admin_*` RPCs are **SECURITY DEFINER** — they enforce admin role + reason/source server-side. Route handlers + RLS are belt-and-braces but the SP body is the canonical gate.
- The `admin_*` RPC family signatures + ERRCODE values WAR01–WAR06 are **locked cross-slice**.
- The `audit_log.source_citation` additive column is **locked** once added — Slice 007 hardens but cannot drop.
- The participant `is_prediction_locked` and `is_final_prediction_locked` predicates from Slices 003/004 are NOT modified — admin lock-bypass paths use sibling SPs (`admin_submit_prediction_bypass_lock`, `admin_submit_final_prediction_bypass_lock`) that perform the same INSERT + supersede without the lock check.
- Recalc concurrency uses Slice 005's existing advisory lock — one recalc in flight at a time (per spec FR-008 interpretation).
- The pg_cron reaper runs as a SECURITY DEFINER function with elevated privilege; participant clients never see or invoke it.
- No service-role key in client bundles.

**Scale/Scope**:
- ~5-10 admin participants per tournament. Tiny dataset for `admin_roles`.
- Override frequency: bounded — handful per day during the tournament; spikes around major matches.
- Recalc frequency: 1-3 per day during active tournament; 0 outside live windows. Each recalc touches up to ~54,000 rows (Slice 005's scale).
- Audit-log volume: every admin action writes 1-3 rows (the action audit + propagated score audit per affected score_record); estimated ~500 rows/day at peak during the tournament. Trivial for Postgres.

## Constitution Check

*GATE: MUST pass before Phase 0 research. Re-evaluated at the end of Phase 1.*

The constitution under review is v1.1.0 (`.specify/memory/constitution.md`). Each principle is evaluated.

| # | Principle | Evaluation | Status |
|---|-----------|------------|--------|
| I | Technology Neutrality | `spec.md` is vendor-neutral. This plan keeps Supabase / Next.js / Realtime details in the implementation layer. Data model uses capability language ("admin role assignment", "audit override event"); product names appear only in plan/research/contracts/quickstart. | ✅ |
| II | Security by Design | Every `admin_*` RPC pre-checks `is_admin(auth.uid())` at the SP body — server-side enforcement of admin role. `requireAdmin(client)` in the route handler is belt-and-braces. RLS on `admin_roles` is admin-only-read. The new audit-row INSERT policy on `audit_log` is narrowly scoped to `admin.access_denied` with `actor = caller's id`. Service-role key never on client. Lock-bypass is admin-only and requires extra confirmation. | ✅ |
| III | Rules Outside the UI | `is_admin(uuid)` is the single named predicate every consumer calls. Reason + source validation is in the SP body (not just route handler). Recalc orchestration delegates to Slice 005's locked Edge Function (not re-implemented). | ✅ |
| IV | Provider Abstraction | Not directly applicable. No external provider in this slice. Admin overrides feed back through the same SPs as auto-sync (`record_match_result`, etc.), preserving the abstraction. | ✅ |
| V | Auditability | Every admin RPC emits one `audit_log` row in the same transaction. The new `source_citation` column captures the URL/document reference. The `triggering_audit_log_id` column on `score_calculation_runs` provides end-to-end traceability from recalc-affected score back to the override event. The reaper job audits its own resumption (audit row `admin.recalc_resumed`). | ✅ |
| VI | Time-Zone Correctness | Slice 005's `score-trigger` already uses Postgres `now()`. This slice's RPCs use `now()` for `granted_at`, `revoked_at`, `set_at`. No client clock participates anywhere. | ✅ |
| VII | Operational Resilience | Concurrency: Slice 005's advisory lock + this slice's per-target advisory lock for non-recalc actions. Idempotency: Slice 005's run_id design (this slice inherits). Resumability: pg_cron reaper polls every 30s for interrupted runs. Admin revocation latency: next call after revoke (DB state, not JWT). | ✅ |
| VIII | Extensibility & Configuration | `admin_roles` is managed configuration (Slice 008 admin UI). `tournament_config.admin.bootstrap_participant_email` is operator-configured. Scoring-affecting config keys are read by `pending_recalc_state` view. No hard-coded admin lists. | ✅ |
| IX | TDD via BDD (NON-NEGOTIABLE) | Playwright scenarios committed FIRST (RED) covering every Acceptance Scenario in `spec.md` (US1 × 3, US2 × 4, US3 × 2, US4 × 3) plus the 10 spec Edge Cases. Boundary tests at recalc interrupt-resume + revoke-mid-session explicit. pgTAP covers `is_admin` (9 files) + each of the 7 admin RPCs (~17 files) + reaper + view (~3 files). | ✅ |
| X | Vertical Slice Delivery | Each user story is its own complete vertical: US1 (manual score correction) → admin RPC + page + audit; US2 (full recalc) → admin RPC + page + Realtime subscription + reaper; US3 (final award correction) → admin RPC + page; US4 (unauthorized rejected) → requireAdmin + denial page + audit. US1 is shippable independently; US2 layers in the orchestrator; US3 reuses the orchestrator for finals scope; US4 adds the security gate. Admin assignment UI deferred to Slice 008. Notification channels deferred to Slice 008 / OD-008. Audit retention hardening deferred to Slice 007. | ✅ |
| XI | Regression-Gated Progress (NON-NEGOTIABLE) | Slices 001–005 regression suites MUST stay green throughout this slice's work. The cross-slice test surface migration (any tests that synthesize JWTs with `{"role":"admin"}` to satisfy the Slice 001 stub MUST be updated to insert `admin_roles` rows) is an explicit task. The locked cross-slice contracts (`is_admin` body, `admin_*` RPC family, `audit_log.source_citation`, `admin_roles` shape, audit action labels) become Slices 007 + 008's regression baseline. | ✅ |

**Eligibility / Privacy / Compliance constraints** (non-principle hard rules):
- **Domain-restricted access** ✅ — `requireAdmin` composes `requireEligible` (Slice 001) with admin check.
- **No gambling** ✅ — no monetary fields.
- **Data minimization** ✅ — `admin_roles` columns are exactly what's needed: who, when, granted-by, revoked details, free-text reason. No HR data.
- **Public API restriction** ✅ — every admin endpoint requires authenticated Nortal session + admin role.

**Verdict**: ✅ No violations. Proceed to Phase 0.

### Post-Phase-1 re-check

| Principle | Post-design | Notes |
|---|---|---|
| I | ✅ | Vendor-neutral data-model + contract language; product names contained to implementation layer. |
| II | ✅ | `contracts/is-admin.predicate.sql.md` + `contracts/admin-rpcs.write.md` enforce SECURITY DEFINER + SP-level admin check + RLS belt-and-braces. |
| III | ✅ | Recalc orchestration delegates to Slice 005's locked Edge Function. `is_admin` is the single home for admin-role rule. |
| IV | ✅ | N/A. |
| V | ✅ | Audit emission + reason + source_citation enforced at SP body; `triggering_audit_log_id` cross-link for full traceability. |
| VI | ✅ | All timestamps `timestamptz`; Postgres `now()` only. |
| VII | ✅ | Advisory lock + idempotency + reaper job per `data-model.md` § Reaper function. |
| VIII | ✅ | `admin_roles` table is configuration backed by Slice 008's eventual admin UI. |
| IX | ✅ | Test files catalogued per contract; cross-slice test migration tracked. |
| X | ✅ | US1→US2→US3→US4 each independently demonstrable; deferred concerns explicit. |
| XI | ✅ | quickstart Definition of Done requires all prior + this slice's tests GREEN; cross-slice test migration is an explicit task in `tasks.md`. |

**Verdict (post-design)**: ✅ No new violations. Ready for `/speckit-tasks`.

### Open complexity

- **Reaper cadence vs SC-007**: Spec SC-007 says "interrupted recalculations resume cleanly within 10 seconds of restart." The pg_cron reaper polls every 30s; a worst-case resume is ~30-60s. Two options:
  - (a) Accept the gap as a known limitation; document in `quickstart-verification.md`. The 10s target is aspirational; 30-60s is operationally acceptable.
  - (b) Reduce reaper cadence to every 5s.
  - Decision: **(a)** — reaper at 30s. Spec rationale notes "approximate" semantics for SC-007; cron at higher cadence creates unnecessary background load. This is the only minor SC-deviation in the slice and is documented in research § R-007.

## Project Structure

### Documentation (this feature)

```text
specs/006-admin-overrides/
├── plan.md              # This file
├── research.md          # Phase 0 output (16 decisions, R-001…R-016)
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output (16-step manual verification)
├── contracts/           # Phase 1 output
│   ├── is-admin.predicate.sql.md       # locked predicate body replacement
│   ├── admin-rpcs.write.md             # 7 admin RPC family + ERRCODE WAR01-06
│   ├── admin-ui.surface.md             # /admin/* page tree + requireAdmin helper
│   └── admin-audit.read.md             # admin audit search + linkage
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

Extends prior slices. **(new)** = introduced here; **(modify)** = extends existing.

```text
apps/
└── web/                                  # (existing)
    ├── app/
    │   ├── admin/                        # (new) admin route tree
    │   │   ├── layout.tsx                # gate via requireAdmin
    │   │   ├── page.tsx                  # /admin dashboard
    │   │   ├── denied/page.tsx           # /admin/denied
    │   │   ├── matches/
    │   │   │   ├── page.tsx              # /admin/matches list
    │   │   │   └── [id]/page.tsx         # /admin/matches/[id] detail
    │   │   ├── finals/page.tsx           # /admin/finals
    │   │   ├── predictions/[participant]/page.tsx  # /admin/predictions/[id]
    │   │   ├── recalc/page.tsx           # /admin/recalc with Realtime
    │   │   ├── audit/
    │   │   │   ├── page.tsx              # /admin/audit search
    │   │   │   ├── [id]/page.tsx         # /admin/audit/[id] detail
    │   │   │   └── by-target/[entity_type]/[entity_id]/page.tsx
    │   │   └── pending-review/page.tsx   # /admin/pending-review
    │   └── api/
    │       └── admin/                    # (new) admin API route handlers
    │           ├── match-results/route.ts        # POST admin_record_match_result
    │           ├── matches/[id]/route.ts         # POST admin_update_match
    │           ├── predictions/route.ts          # POST admin_submit_prediction
    │           ├── final-predictions/route.ts    # POST admin_submit_final_prediction
    │           ├── tournament-award/route.ts     # POST admin_update_tournament_award
    │           ├── pending-review/[id]/route.ts  # POST admin_resolve_match_pending_review
    │           ├── recalc/route.ts               # POST admin_trigger_recalc
    │           └── audit/
    │               ├── route.ts                  # GET search
    │               ├── [id]/route.ts             # GET detail
    │               └── by-target/[entity_type]/[entity_id]/route.ts
    ├── lib/
    │   ├── auth/
    │   │   └── requireAdmin.ts           # (new) admin guard helper
    │   ├── admin/
    │   │   ├── rpcs.ts                   # (new) typed wrappers around admin_* RPCs
    │   │   ├── audit.ts                  # (new) audit search client
    │   │   ├── recalc.ts                 # (new) recalc trigger + Realtime subscription helper
    │   │   └── types.ts                  # (new) AdminAction, AdminAuditRow, etc.
    │   └── (existing libs for participants/catalog/predictions/final-predictions)
    └── tests/
        └── playwright/
            ├── slice-006-is-admin-uses-db-state-not-jwt.spec.ts
            ├── slice-006-admin-dashboard-*.spec.ts (3)
            ├── slice-006-admin-matches-*.spec.ts (3)
            ├── slice-006-admin-match-correct-score-*.spec.ts (3)
            ├── slice-006-admin-match-update-status-*.spec.ts (1)
            ├── slice-006-admin-prediction-*.spec.ts (2)
            ├── slice-006-admin-finals-*.spec.ts (2)
            ├── slice-006-admin-pending-*.spec.ts (2)
            ├── slice-006-admin-recalc-*.spec.ts (3)
            ├── slice-006-admin-audit-*.spec.ts (4)
            ├── slice-006-non-admin-rejected-ui.spec.ts
            ├── slice-006-non-admin-rejected-api.spec.ts
            ├── slice-006-admin-role-revoked-mid-session.spec.ts
            └── slice-006-recalc-pending-banner.spec.ts

supabase/
├── migrations/                            # (existing)
│   ├── 0047_admin_roles.sql                              # (new) admin_roles + RLS + audit trigger
│   ├── 0048_audit_log_source_citation.sql                # (new) ADD COLUMN source_citation
│   ├── 0049_is_admin_real_body.sql                       # (new) CREATE OR REPLACE — replaces Slice 001 stub
│   ├── 0050_score_calculation_runs_triggering_audit.sql  # (new) ADD COLUMN triggering_audit_log_id
│   ├── 0051_admin_record_match_result.sql                # (new)
│   ├── 0052_admin_update_match.sql                       # (new)
│   ├── 0053_admin_submit_prediction.sql                  # (new) + bypass-lock sibling
│   ├── 0054_admin_submit_final_prediction.sql            # (new) + bypass-lock sibling
│   ├── 0055_admin_update_tournament_award.sql            # (new)
│   ├── 0056_admin_resolve_match_pending_review.sql       # (new)
│   ├── 0057_admin_trigger_recalc.sql                     # (new)
│   ├── 0058_pending_recalc_state_view.sql                # (new)
│   ├── 0059_reap_stale_recalc_runs.sql                   # (new) + pg_cron schedule
│   └── 0060_audit_log_admin_access_denied_insert_policy.sql  # (new) narrow INSERT policy
├── seed/
│   └── slice-006-fixture.sql              # (new) bootstrap admin + sample audit rows
└── tests/
    └── pgtap/
        ├── is_admin_active_grant.sql
        ├── is_admin_revoked_grant.sql
        ├── is_admin_no_grant.sql
        ├── is_admin_deactivated_participant.sql
        ├── is_admin_unknown_uid.sql
        ├── is_admin_null_uid.sql
        ├── is_admin_revoke_then_regrant.sql
        ├── is_admin_uses_db_state_not_jwt.sql
        ├── is_admin_perf.sql
        ├── admin_record_match_result_happy.sql
        ├── admin_record_match_result_not_admin.sql
        ├── admin_record_match_result_missing_reason.sql
        ├── admin_record_match_result_missing_source.sql
        ├── admin_record_match_result_invariant_propagates.sql
        ├── admin_update_match_happy.sql
        ├── admin_update_match_kickoff_fans_out.sql
        ├── admin_submit_prediction_bypass_locked.sql
        ├── admin_submit_prediction_unlocked.sql
        ├── admin_submit_final_prediction_bypass_locked.sql
        ├── admin_update_tournament_award_happy.sql
        ├── admin_resolve_match_pending_review_accept_provider.sql
        ├── admin_resolve_match_pending_review_reject_provider.sql
        ├── admin_resolve_match_pending_review_manual_override.sql
        ├── admin_trigger_recalc_scope_all.sql
        ├── admin_trigger_recalc_concurrent.sql
        ├── admin_trigger_recalc_audit_links_run.sql
        ├── reap_stale_recalc_runs.sql
        ├── pending_recalc_state_view.sql
        └── cross_slice_test_migration_audit.sql           # (new) verifies Slice 002-005 tests still pass with the new is_admin body
```

**Structure Decision**: **Option 2 (web application)** — same as prior slices. This slice is integration / orchestration over existing artifacts; the new authoritative business logic (admin-role check + override invariants) lives in `supabase/migrations/` per Constitution Principle III. The Next.js layer is the admin presentation surface. Tests live with the layer they validate.

## Complexity Tracking

> Reaper cadence vs SC-007 documented; see Open complexity above.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Reaper at 30s instead of 5s for SC-007 | SC-007's "10 seconds" target is aspirational; 30-60s effective resume is operationally acceptable | 5s reaper creates background load with minimal real-world benefit |
