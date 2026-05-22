# Implementation Plan: Audit Trail (Slice 007)

**Branch**: `main` (no feature branches per repo convention) | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-audit-trail/spec.md`

## Summary

Close the audit-trail surface so it is **tamper-resistant**, **monotonically ordered**, and **searchable by admins** through a single locked read path. All state-changing slices (001–006) already write into `public.audit_log` via triggers + `SECURITY DEFINER` SP bodies; this slice freezes the table shape, adds a `bigserial sequence_id` for canonical ordering, REVOKEs UPDATE/DELETE from every application role, ships the `audit_search` + `count_audit_search` RPCs, builds the admin search UI + CSV export route, and seeds (without enforcing) retention configuration keys for Slice 008.

After this slice, `audit_log` is **locked**: future slices may add columns / config keys but cannot alter or drop existing columns, indexes, or privileges.

## Technical Context

**Language/Version**: TypeScript 5.4.x (Next.js 14 App Router) + SQL (Postgres 15 via Supabase)

**Primary Dependencies**: Next.js 14.2.x, React 18.3.x, `@supabase/supabase-js@2.45`, `@supabase/ssr@0.5`, `zod` (filter validation), `@playwright/test@1.60`. CSV streaming uses native Web Streams (no extra dep).

**Storage**: Postgres (Supabase). One table modified additively (`audit_log`). One sequence introduced (`audit_log_sequence_id_seq`). Three new indexes. New rows in `tournament_config` (3 keys; defaults only).

**Testing**: Playwright (browser-driven admin search + CSV export validation). pgTAP-style SQL tests via Supabase fixtures for tamper-resistance + `audit_search` ERRCODEs. RLS-deny regression tests for non-admin paths.

**Target Platform**: Next.js routes deployed on Vercel (Node.js runtime — not Edge, because the export streams response bodies that can exceed Edge memory limits). Supabase Postgres for DB layer.

**Project Type**: Web application (`apps/web/` Next.js project + Postgres migrations under `supabase/migrations/`).

**Performance Goals**:
- `audit_search` median ≤ 500 ms for filtered queries on tables up to 1M rows.
- CSV export sustained throughput ≥ 5000 rows/sec.
- Tamper-attempt rejection adds zero hot-path latency (Postgres permission check is constant-time).

**Constraints**:
- Append-only invariant must hold even against compromised `service_role` key (per Principle II + VII).
- `audit_search` MUST be the SINGLE admin read path; no direct SELECT grants on `audit_log` outside SECURITY DEFINER bodies.
- ERRCODE namespace WAT01–WAT03 owned by this slice; do not collide with WCM* (003), WFP* (004), or WAR* (006).

**Scale/Scope**: Audit log expected to grow ~50k–500k rows over a 32-day tournament. Indexes sized for 1M-row ceiling. CSV exports capped at 1M rows (hard limit); typical export 1k–10k rows for a given investigation.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Vendor-Neutral Architecture | PASS | Capability terms ("admin read RPC", "CSV stream") + concrete Postgres/Next.js mapping. |
| II. Security First | PASS | REVOKE UPDATE/DELETE at DB layer + admin gating via SECURITY DEFINER + zero direct SELECT grants. |
| III. Rules-Outside-UI | PASS | All access decisions in `audit_search` body + DB privileges; UI is a thin renderer. |
| IV. Realtime-First | N/A | Audit search is request/response, not realtime. Realtime feed deferred. |
| V. Auditability | **CORE** | This slice IS the auditability invariant. PASS. |
| VI. Time-Zone Correctness | PASS | `occurred_at` is `timestamptz`; admin UI displays in tournament timezone. |
| VII. Operational Resilience | PASS | Tamper-resistance enforced at DB layer, not application — survives key compromise. Operational alert webhook seeded (Slice 008 hooks delivery). |
| VIII. Anonymity-by-Default | PASS | `actor` references `participants.id` (stable, decoupled from email — Slice 001 design). |
| IX. TDD via BDD | PASS | Test plan covers tamper-attempt rejection (positive: 403; negative: SQL error), monotonic ordering, ERRCODE WAT01–03, CSV column order, audit-of-the-access-denial. |
| X. Single-Authoritative-Clock | PASS | `occurred_at DEFAULT now()` is server-side; UI display only converts. |
| XI. Regression-Gated | PASS | Action label catalog frozen; consuming queries listed; backwards-incompatible renames blocked by convention. |

**No violations. No Complexity Tracking entries.**

### Post-Phase-1 re-check

After Phase 1 design (data-model + contracts + quickstart), constitution check status is **unchanged**. No additional complexity introduced.

## Project Structure

### Documentation (this feature)

```text
specs/007-audit-trail/
├── plan.md              # This file
├── spec.md              # Feature spec (with Clarifications section)
├── research.md          # Phase 0 — 12 decisions (R-001..R-012)
├── data-model.md        # Phase 1 — final audit_log shape + RLS + cross-slice map
├── quickstart.md        # Phase 1 — end-to-end verification recipe
├── contracts/           # Phase 1
│   ├── audit-log.schema.md       # Final table shape + REVOKE + indexes
│   ├── audit-search.read.md      # SECURITY DEFINER RPC + ERRCODE WAT01-03
│   └── audit-export.stream.md    # CSV streaming route contract
└── tasks.md             # Phase 2 (NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/web/                                       # Next.js 14 App Router (Slice 001)
├── app/
│   ├── api/
│   │   └── admin/
│   │       └── audit/
│   │           └── export/
│   │               └── route.ts                # NEW — CSV streaming export
│   └── admin/
│       └── audit/
│           ├── page.tsx                        # extended from Slice 006 admin/audit landing
│           └── search/
│               ├── page.tsx                    # NEW — search filter form + results table
│               ├── AuditFiltersForm.tsx        # NEW
│               └── AuditResultsTable.tsx       # NEW
├── lib/
│   ├── audit-search.ts                         # NEW — typed RPC wrapper
│   └── csv.ts                                  # NEW — RFC 4180 CSV line encoder
└── tests/
    └── playwright/
        ├── audit-search.spec.ts                # NEW
        └── audit-export.spec.ts                # NEW

supabase/migrations/                            # Postgres migration files
└── 007_audit_trail.sql                         # NEW — adds sequence_id, indexes,
                                                #       REVOKE, RPCs, config keys

supabase/tests/                                 # pgTAP-style SQL tests
└── 007_audit_trail/
    ├── tamper_resistance.sql                   # NEW
    ├── audit_search_authorization.sql          # NEW
    ├── audit_search_errcodes.sql               # NEW
    ├── monotonic_ordering.sql                  # NEW
    └── action_label_catalog.sql                # NEW (assertion that no label was renamed)
```

**Structure Decision**: Extends the existing `apps/web/` Next.js project from Slice 001 + `supabase/migrations/` workflow established by prior slices. No new packages, no new project surfaces — Audit Trail is an additive slice on a well-established foundation.

## Phase 0 — Research (complete)

See [research.md](./research.md). 12 decisions resolving NEEDS CLARIFICATION:

| Decision | Outcome |
|---|---|
| R-001: Tamper-resistance mechanism | REVOKE UPDATE/DELETE at DB layer (not trigger-based) |
| R-002: Canonical ordering key | `bigserial sequence_id` column (new, this slice) |
| R-003: Retention enforcement | Config keys seeded only; enforcement deferred to ops |
| R-004: Admin read path | Single `audit_search` SECURITY DEFINER RPC + `count_audit_search` companion |
| R-005: ERRCODE namespace | WAT01 (not admin), WAT02 (invalid input), WAT03 (unbounded count refused) |
| R-006: CSV export — streaming vs buffered | ReadableStream + paging through `audit_search` |
| R-007: Stable participant identifier | Already satisfied by Slice 001 design (`participants.id` UUID, decoupled from email) |
| R-008: Search indexes | 3 new indexes: `actor_occurred`, `target` (entity_type + entity_id + sequence_id), `source_occurred` |
| R-009: Action label catalog freeze | 60+ labels across slices 001–006 enumerated; slice 008 may add under `tournament_config.*` prefix |
| R-010: Admin UI placement | Extend Slice 006's `/admin/audit*` surface; new `/admin/audit/search` route |
| R-011: Operational alert delivery | Config key seeded; webhook delivery deferred to Slice 008 |
| R-012: Capability contract list | 6 items locked at slice close (see data-model.md) |

## Phase 1 — Design & Contracts (complete)

### data-model.md

Cross-slice ownership map (table); final consolidated `audit_log` shape (12 columns including new `sequence_id`); index set; privilege posture (REVOKE statements); action label catalog (frozen at this slice); RLS posture summary (unchanged from prior slices); capability contracts locked; deferred questions.

### contracts/

- **`audit-log.schema.md`** — Final table DDL (additive `sequence_id`, REVOKE statements, new indexes), column reference, tamper-resistance posture, monotonic ordering invariant, frozen action label catalog, cross-slice writers/readers map.
- **`audit-search.read.md`** — `audit_search` + `count_audit_search` signatures (LOCKED), authorization flow with audit-the-denial, input validation rules, filter composition SQL, privilege model (SECURITY DEFINER + STABLE + search_path), ERRCODE WAT01-03 namespace, performance contract, client usage example.
- **`audit-export.stream.md`** — `GET /api/admin/audit/export` route signature, query parameters, authorization flow, streaming behavior (ReadableStream + paged `audit_search`), CSV column order (LOCKED), audit posture (writes `admin.audit_export` row on success), performance contract, error responses.

### quickstart.md

11-step verification recipe: preconditions → migration → tamper-resistance directly-against-DB → monotonic ordering → `audit_search` happy path / denial / validation failures → `count_audit_search` → CSV export (200 / 403 / 422 paths) → admin UI search surface → retention config seeded → constitutional checks → regression-of-prior-slices smoke.

### Agent context update

`CLAUDE.md` SPECKIT START/END marker block updated to reference this plan: `specs/007-audit-trail/plan.md`.

## Phase 2 — Tasks (NOT generated by `/speckit-plan`)

Run `/speckit-tasks` next to generate `tasks.md`. Expected scope (estimated):

- Phase 1 (Setup): 1–2 tasks (migration file scaffold)
- Phase 2 (Foundational): 3–5 tasks (`sequence_id` add, REVOKE, indexes, config seeding)
- Phase 3 (User Story 1 — Admin search): 8–12 tasks (RPCs + UI + Playwright tests)
- Phase 4 (User Story 2 — CSV export): 5–8 tasks (route handler + streaming + audit row + Playwright tests)
- Phase 5 (User Story 3 — Tamper-resistance verification): 3–5 tasks (pgTAP test files)
- Final phase (Polish): 2–3 tasks (action label catalog assertion test, regression smoke matrix)

Total estimate: ~25–35 tasks.

## Complexity Tracking

> No constitution violations. This section intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

## Cross-slice contracts locked at the close of this slice

1. `public.audit_log` final 12-column shape with `sequence_id bigserial UNIQUE NOT NULL`.
2. REVOKE UPDATE/DELETE on `audit_log` from `authenticated`, `anon`, `service_role` — never re-granted.
3. `audit_search(uuid, text, uuid, text, text, timestamptz, timestamptz, int, int)` signature + ERRCODE WAT01-03.
4. `count_audit_search(uuid, text, uuid, text, text, timestamptz, timestamptz)` signature.
5. `GET /api/admin/audit/export` route signature + CSV column order.
6. Action label catalog (60+ labels enumerated in data-model.md) — frozen, no renames.
7. New `tournament_config` keys: `audit.retention.policy_kind`, `audit.retention.tournament_end_buffer_months`, `notifications.audit_failure_webhook_url`.

After this slice ships, Slice 008 (Configuration) may extend (add columns, add config keys, add `tournament_config.<key>` action labels) but must not alter or drop any of the above.

## Open complexity / deferred items

- **Retention enforcement** — config keys ship; archival mechanism (move-to-cold-storage / purge) deferred to Slice 008+/ops decision per R-003.
- **Audit-write-failure webhook delivery** — config key `notifications.audit_failure_webhook_url` ships as nullable default; delivery glue deferred to Slice 008 per R-011.
- **Realtime audit subscriptions** — out of scope; investigators use polling/paged search instead.
- **Per-admin export rate limiting** — relies on Vercel platform-level throttle; explicit per-user counter deferred.
- **GDPR-style audit redaction** — out of scope; would require a new slice with lawful-basis review per `audit-log.schema.md` "Tamper-resistance posture (LOCKED)" guidance.
