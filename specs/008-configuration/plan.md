# Implementation Plan: Tournament Configuration (Slice 008)

**Branch**: `main` (no feature branches per repo convention) | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-configuration/spec.md`

## Summary

The final and most cross-cutting slice in the World Cup Madness product roadmap. This slice owns the **live-configuration surface** every prior slice consumes. It (a) finalizes the `tournament_config` table that Slice 001 stubbed by adding `value_type`, `updated_by`, `version_id`, and an append-only `tournament_config_versions` history log; (b) ships a `admin_config_*` SECURITY DEFINER RPC family covering upsert / preview / rollback / get_secret / grant-admin-role / revoke-admin-role / import / export; (c) migrates ALL prior slices' hardcoded values (Slice 001 domain list, Slice 003 lock window + score upper bound, Slice 005 scoring values + tie-breaker order, Slice 002 provider settings) to read from `tournament_config` via a single `config_read` helper that fails closed (raises `WCG06`); (d) ships the admin UI under `/admin/config/*` with tabbed sections per functional area; (e) closes Slice 007's deferred SC-007 by wiring `pg_cron` + `pg_net` webhook delivery for audit-write-failure alerts.

After this slice ships, the v1 product is feature-complete.

## Technical Context

**Language/Version**: TypeScript 5.4.x (Next.js 14 App Router) + SQL (Postgres 15 via Supabase) + plpgsql.

**Primary Dependencies**: Next.js 14.2.x, React 18.3.x, `@supabase/supabase-js@2.45`, `@supabase/ssr@0.5`, `zod` (validators), `@playwright/test@1.60`. Postgres extensions: `pgcrypto` (HMAC), `pg_cron` (worker scheduling), `pg_net` (outbound HTTP).

**Storage**: Postgres. Tables created/extended: `tournament_config` (extended), `tournament_config_versions` (NEW), `notification_dispatch_queue` (NEW). Functions: 7 `admin_config_*` RPCs, 2 helpers (`config_read`, `key_is_secret`), 3 outbound-alert glue functions. Trigger: `notify_tournament_config_change`. Cron job: `tournament-config-alert-dispatcher` (every 30s).

**Testing**: Playwright for admin UI (tab-by-tab); pgTAP-style SQL tests for RPC ERRCODE behavior, concurrency, rollback, fail-closed, secret access; cross-slice regression matrix verifying slices 001–007 continue to pass after consumer-function bodies are migrated.

**Target Platform**: Next.js routes on Vercel (Node.js runtime for export route; Edge runtime acceptable for read-only history view). Supabase Postgres + pg_cron + pg_net for DB + delivery.

**Project Type**: Web application (extending `apps/web/` from Slice 001 + `supabase/migrations/` from prior slices).

**Performance Goals**:
- `admin_config_upsert` p95 ≤ 200 ms.
- `admin_config_preview` p95 ≤ 2 s (may scan large tables for impact analysis).
- Config-change propagation to consumers ≤ 60 s (FR-002 + R-009 LRU + LISTEN/NOTIFY).
- Audit-failure webhook delivery ≤ 5 min from first failure (R-011 closes Slice 007 SC-007).

**Constraints**:
- Migration MUST be regression-gated: each `ALTER FUNCTION` step must include an in-line smoke check.
- ERRCODE namespace `WCG01..WCG08` owned by this slice (no collision with WCM*/WFP*/WAR*/WAT*).
- Slice 006's locked SP signatures (`admin_grant_admin_role`, etc.) MUST NOT be modified — wrappers only.
- All hardcoded values in slices 001/003/005 MUST be migrated; the test suite is the verification.

**Scale/Scope**: ~30 configuration keys at launch (catalog in `data-model.md`). `tournament_config_versions` expected to grow ~50–500 rows per tournament. Concurrent admins: ≤ 5; concurrency tested up to 100 per SC-007.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Technology Neutrality | PASS | Spec + data-model expressed in capability terms; plan + contracts reference Postgres/Supabase concretely (per the *Implementation Platform* section). |
| II. Security by Design | PASS | Admin gating at every RPC body via `is_admin`; secrets redacted at RLS level; REVOKE UPDATE/DELETE on versions table mirrors Slice 007's audit_log posture. |
| III. Rules Outside the UI | **CORE** | This slice IS the rules-outside-the-UI surface. Every previously-hardcoded value moves to `tournament_config`. PASS. |
| IV. Provider Abstraction | PASS | Provider settings are config; the active-provider switch goes through this slice's RPC family; Slice 002's adapter contract is unchanged. |
| V. Auditability | PASS | Every config write produces TWO rows in the same transaction: a `tournament_config_versions` row + an `audit_log` row with `action = 'tournament_config.<key>'`. |
| VI. Time-Zone Correctness | PASS | `updated_at`, `created_at` are `timestamptz`; admin UI displays in tournament timezone. |
| VII. Operational Resilience | PASS | Fail-closed via `config_read` raising `WCG06`; webhook delivery via `pg_cron` + `pg_net` is queue-backed with retry. |
| VIII. Extensibility & Configuration | **CORE** | This slice IS the extensibility surface. PASS. |
| IX. TDD via BDD | PASS | Test plan covers ERRCODEs (WCG01-08), concurrency, rollback, fail-closed, secret access, import/export round-trip, cross-slice regression. |
| X. Vertical Slice Delivery | PASS | All ~30 config keys, all consumer-slice migrations, admin UI, and audit-failure webhook delivery ship together. |
| XI. Regression-Gated Progress | PASS | Migration file embeds smoke checks after each ALTER FUNCTION step; CI runs the full prior-slice suite. |

**No violations. No Complexity Tracking entries required.**

### Post-Phase-1 re-check

After Phase 1 design (data-model + contracts + quickstart), constitution check status is **unchanged**. No additional complexity introduced.

## Project Structure

### Documentation (this feature)

```text
specs/008-configuration/
├── plan.md              # This file
├── spec.md              # Feature spec
├── research.md          # Phase 0 — 14 decisions (R-001..R-014)
├── data-model.md        # Phase 1 — final tournament_config shape + history + cross-slice map
├── quickstart.md        # Phase 1 — 14-step verification recipe
├── contracts/           # Phase 1
│   ├── tournament-config.schema.md           # Final table shapes + REVOKE + RLS + helpers
│   ├── admin-config-rpcs.write.md            # 6 admin_config_* RPCs + ERRCODE WCG01-08
│   ├── config-version-history.read.md        # History view + export envelope
│   ├── config-import.write.md                # Bulk import contract
│   └── audit-failure-webhook.outbound.md     # pg_cron + pg_net webhook delivery (closes Slice 007 SC-007)
└── tasks.md             # Phase 2 (NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/web/                                       # Next.js 14 App Router (Slice 001)
├── app/
│   ├── api/
│   │   └── admin/
│   │       └── config/
│   │           ├── export/route.ts            # NEW — JSON export endpoint
│   │           └── import/route.ts            # NEW — JSON import endpoint
│   └── admin/
│       └── config/
│           ├── page.tsx                       # NEW — tabbed landing
│           ├── domains/page.tsx               # NEW — eligibility.allowed_domains
│           ├── locking/page.tsx               # NEW — locking.match_prediction_window_minutes
│           ├── scoring/page.tsx               # NEW — scoring.* + tie-breaker
│           ├── providers/page.tsx             # NEW — providers.* + secret reveal
│           ├── admin-roles/page.tsx           # NEW — wraps Slice 006 SPs
│           ├── phases/page.tsx                # NEW — tournament.phase.current
│           ├── retention/page.tsx             # NEW — audit.retention.* + webhook URL
│           ├── history/page.tsx               # NEW — version history + rollback
│           ├── import-export/page.tsx         # NEW — JSON envelope import/export UI
│           ├── ConfigField.tsx                # NEW — generic value editor by value_type
│           ├── PreviewWarning.tsx             # NEW — affecting-data dialog
│           └── VersionTimeline.tsx            # NEW — history per key
├── lib/
│   ├── config-client.ts                       # NEW — typed RPC wrappers + LRU cache + LISTEN
│   ├── config-validators.ts                   # NEW — zod schemas per key
│   └── hmac.ts                                # NEW — signature verification helper
└── tests/
    └── playwright/
        ├── config-domains.spec.ts
        ├── config-locking.spec.ts
        ├── config-scoring.spec.ts
        ├── config-providers.spec.ts
        ├── config-admin-roles.spec.ts
        ├── config-phases.spec.ts
        ├── config-retention.spec.ts
        ├── config-history-rollback.spec.ts
        ├── config-import-export.spec.ts
        ├── config-concurrent-edit.spec.ts
        ├── config-fail-closed.spec.ts
        ├── config-secret-access.spec.ts
        └── config-cross-slice-regression.spec.ts

supabase/migrations/
└── 008_configuration.sql                       # NEW — large migration; ordered per data-model.md §migration ordering

supabase/tests/
└── 008_configuration/
    ├── upsert_authorization.sql
    ├── upsert_validation.sql
    ├── upsert_concurrency.sql
    ├── preview_affecting_data.sql
    ├── rollback_happy.sql
    ├── rollback_retention.sql
    ├── get_secret_audit.sql
    ├── import_signature.sql
    ├── import_validation_aggregate.sql
    ├── config_read_fail_closed.sql
    ├── webhook_dispatch.sql
    ├── consumer_migrations.sql                  # Verifies slices 001/003/005 still pass after ALTER FUNCTION
    └── action_label_catalog_extension.sql      # Extends Slice 007's catalog test
```

**Structure Decision**: Extends the existing `apps/web/` and `supabase/migrations/` workflow. The admin UI grows substantially (10 new pages); admin routes are co-located with existing Slice 006 admin pages. No new packages or workspaces.

## Phase 0 — Research (complete)

See [research.md](./research.md). 14 decisions resolving NEEDS CLARIFICATION:

| # | Topic | Outcome |
|---|---|---|
| R-001 | Storage shape | Single `tournament_config (key, value jsonb)` table (existing) |
| R-002 | Versioning + rollback | New append-only `tournament_config_versions` log + restore RPC |
| R-003 | Concurrency | Optimistic concurrency via `expected_version_id` + advisory xact lock |
| R-004 | ERRCODE namespace | `WCG01..WCG08` |
| R-005 | Admin UI structure | Tabbed sections under `/admin/config/*` |
| R-006 | Domain list storage | jsonb array under `eligibility.allowed_domains` key |
| R-007 | Admin role consolidation | Slice 006 table preserved; this slice ships only UI wrappers |
| R-008 | Provider credentials | jsonb `{secret: true, value}` + admin-only redaction + per-access audit |
| R-009 | Read-path caching | Per-process LRU + Postgres LISTEN/NOTIFY invalidation |
| R-010 | Affecting-data warnings | Two-step preview → acknowledge token → write |
| R-011 | Fail-closed | Shared `config_read` helper raising `WCG06`; webhook alert path activated |
| R-012 | Import/export | Signed JSON envelope with version history; HMAC-SHA256 signature |
| R-013 | Action label catalog | `tournament_config.<key>` prefix (pre-reserved by Slice 007) |
| R-014 | Cross-slice migration | Single migration file with ordered ALTER FUNCTION steps + regression gates |

## Phase 1 — Design & Contracts (complete)

### data-model.md

Cross-slice ownership map (table); final consolidated `tournament_config` shape with new `value_type` + `version_id`; new `tournament_config_versions` append-only log; helper functions (`config_read`, `key_is_secret`); RLS posture (admin-only writes; non-admin can read non-secret keys); ~30-entry configuration namespace catalog (frozen at slice close); capability contracts locked at slice close.

### contracts/

- **`tournament-config.schema.md`** — Final DDL for `tournament_config` (additive columns + index + REVOKE DELETE) + `tournament_config_versions` (new table); RLS policies; `config_read` + `key_is_secret` helpers; `pg_notify` trigger; migration ordering map.
- **`admin-config-rpcs.write.md`** — 6 SECURITY DEFINER RPCs: `admin_config_upsert`, `admin_config_preview`, `admin_config_rollback`, `admin_config_get_secret`, `admin_config_grant_admin_role`, `admin_config_revoke_admin_role`. ERRCODE WCG01-08. Behavior: authorization + validation + concurrency + acknowledge-token + atomic write (versions + config + audit).
- **`config-version-history.read.md`** — `config_version_history` paged read + `admin_config_export` jsonb envelope.
- **`config-import.write.md`** — `admin_config_import(envelope, reason)` bulk-write RPC; HMAC signature verification; per-key validation aggregate; single audit row.
- **`audit-failure-webhook.outbound.md`** — `notification_dispatch_queue` table + `enqueue_alert` + `dispatch_pending_alerts` (pg_cron 30s) + `pg_net` HTTP POST. Closes Slice 007's deferred SC-007.

### quickstart.md

14-step verification: migration → consumer regression → 5 admin UI user stories → concurrent edit → secret access → import/export → fail-closed → webhook delivery → constitutional checks → regression matrix.

### Agent context update

`CLAUDE.md` SPECKIT START/END marker block updated to point at this plan: `specs/008-configuration/plan.md`.

## Phase 2 — Tasks (NOT generated by `/speckit-plan`)

Run `/speckit-tasks` next to generate `tasks.md`. Expected scope (estimated):

- Phase 1 (Setup): 2 tasks
- Phase 2 (Foundational): 8–10 tasks — migration file structure, table creation, RLS, helpers, defaults seeding, consumer-slice ALTER FUNCTION steps
- Phase 3 (US1 — domains): 4–5 tasks
- Phase 4 (US2 — locking): 4–5 tasks
- Phase 5 (US3 — scoring + tie-breaker): 5–6 tasks
- Phase 6 (US4 — providers + admin roles + phases): 8–10 tasks
- Phase 7 (US5 — rollback + history): 4–5 tasks
- Phase 8 (Polish): 5–7 tasks — webhook delivery integration test, import/export tests, runbook updates, INDEX.md regeneration

Total estimate: ~45–55 tasks.

## Complexity Tracking

> No constitution violations. Sections intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

## Cross-slice contracts LOCKED at the close of this slice

1. `tournament_config` final 6-column shape (`key`, `value`, `value_type`, `updated_at`, `updated_by`, `version_id`).
2. `tournament_config_versions` final 12-column shape with `bigserial version_id`, append-only (`REVOKE UPDATE, DELETE`).
3. ~30-key configuration namespace catalog (data-model.md §catalog) — frozen.
4. ERRCODE namespace `WCG01..WCG08`.
5. `config_read(text, jsonb) RETURNS jsonb STABLE` helper signature + fail-closed behavior.
6. 6 `admin_config_*` RPC signatures + behavior contracts.
7. `pg_notify` channel `'tournament_config_changed'` + payload format.
8. Export/import JSON envelope schema `1.0.0` + HMAC signature.
9. Webhook payload envelope schema `1.0.0`.
10. Consumer-slice function bodies (Slice 001 `is_eligible_nortal_participant`, Slice 003 `is_prediction_locked`, Slice 005 `compute_match_score` + leaderboard view) now config-driven via `config_read`.

After this slice ships, the v1 product is feature-complete. Future product slices may extend the namespace catalog under the documented forward-compatible protocol; renames or removals remain breaking and require coordinated migrations.

## Open complexity / deferred items

- **OD-002 (knockout match basis)**, **OD-004 (top-scorer tie policy)**, **OD-005 (best player source)**, **OD-006 (leaderboard visibility)** — defaults seeded; live admin UI lets the tournament organizer change them pre-launch. No code change needed.
- **OD-008 (notification channels)** — config keys seeded (`notifications.deadline_reminders.enabled`); delivery for participant-facing notifications (deadline reminders, score updates) is NOT implemented in v1.
- **KMS-backed credential storage** — out of scope for v1; provider credentials use jsonb `{secret: true, value}` envelopes with admin-only redaction + per-access audit. A future infrastructure slice may add Vault/KMS integration.
- **Configuration-import re-signing tool** — admins who edit an exported file before re-import need a dev-mode utility to re-compute the HMAC; this is a CLI script (`scripts/config/sign-import.sh`) — task-level scope, not blocking.
- **Per-admin rate limiting** — relies on platform-level throttle; explicit per-user counters deferred.
