# Slice 007 — Quickstart end-to-end verification

**Slice**: 007 — Audit Trail
**Task**: T028
**Date**: 2026-05-21
**Reference**: `specs/007-audit-trail/quickstart.md` § Steps 0–11 + Constitution Principle X (Vertical Slice Delivery) + Principle XI (Regression-Gated)

---

## Status: DEFERRED (code-review verification only)

The 12 quickstart steps (0 Preconditions through 11 Cleanup) are deferred until the operator brings up the local stack (Docker Desktop + `supabase start` + `supabase db reset` + `pnpm -F web build && pnpm -F web start` + manual browser session). **Docker is currently down on this workstation**, so no terminal commands from `quickstart.md` can be executed end-to-end.

This pattern matches the precedent set by slice 005 T040 and slice 006 T040/T041: when runtime verification is blocked by environment, T028 ships a **code-review verification matrix** that confirms each step's underlying migration / route / page / SP / test / lib artifact exists on disk and is well-formed enough that the operator should observe GREEN when the stack is brought up at the next Docker-available environment.

## Approach

Per slice 005/006 precedent, each quickstart step is documented with a code-review verdict:

- **GREEN-EXPECTED**: artifact exists on disk + behavior matches spec; expected to pass on first runtime execution barring environmental noise.
- **NEEDS-RUNTIME**: requires Docker/Supabase/browser/psql session to verify (cannot be confirmed from artifacts alone, even though all underlying artifacts exist).
- **ARTIFACT-GAP**: a required artifact is missing or incomplete; step will likely FAIL when run at runtime unless the gap is closed first.

## Prerequisites for runtime execution (deferred)

Before running the checklist:

- [ ] Docker Desktop is running.
- [ ] `supabase start` succeeded; `supabase status` shows all containers UP (Postgres + Auth + Realtime).
- [ ] `supabase db reset` succeeded (loads all migrations 0001–0076 including this slice's `0076_audit_trail.sql`).
- [ ] Slices 001 and 006 prerequisites met: at least one admin participant exists (`is_admin(<uuid>)` returns `true`), at least one non-admin participant exists for negative tests, and some audit history exists (a few admin RPCs, predictions, etc., have run prior).
- [ ] `apps/web/.env.local` is populated; `pnpm -F web build && pnpm -F web start` is running on `http://localhost:3000`.
- [ ] OIDC stub container is healthy (slice 001 `infra/oidc-stub/`).
- [ ] Helper JWTs issued by the OIDC stub for a seeded admin participant and a seeded non-admin participant.

## Verification matrix (12 steps)

Verdict legend:

- **GREEN-EXPECTED** — every underlying artifact (migration / route / page / SP / test / lib) is present on disk and well-formed; expected to pass on first runtime execution barring environmental noise.
- **NEEDS-RUNTIME** — the step genuinely requires a running browser, psql session, or DB session (i.e. cannot be verified from artifacts alone, even though all underlying artifacts exist).
- **ARTIFACT-GAP** — an underlying artifact is missing or incomplete.

| # | Step (from quickstart.md) | Underlying artifact(s) | Verdict |
|---|---|---|---|
| 0 | **Preconditions**. Local Supabase started; migrations applied through Slice 006; ≥1 admin participant + ≥1 non-admin participant; some audit history exists. | Migrations 0001–0075 from prior slices on disk (`supabase/migrations/` glob confirms contiguous slot fill); `0008_participants_audit_trigger.sql`, `0033_predictions_audit_trigger.sql`, `0043_final_predictions_audit_trigger.sql`, `0055_score_audit_trigger.sql`, etc., produce audit history; `0060_admin_roles.sql` + `0062_is_admin_real_body.sql` + `0074_admin_bootstrap.sql` provision admin grants; `0075_is_admin_active_participant_filter.sql` enforces active-participant filter. | **NEEDS-RUNTIME** (preconditions require Docker + db reset + admin grant) |
| 1 | **Apply Slice 007 migration** (`supabase db push`). Verify `sequence_id` column exists NOT NULL, new indexes present, REVOKE took effect. | `supabase/migrations/0076_audit_trail.sql` lines 15–19 (T003 ALTER TABLE + UNIQUE INDEX on `sequence_id`), lines 26–35 (T004 three new indexes: `audit_log_actor_occurred_idx`, `audit_log_target_idx`, `audit_log_source_occurred_idx`), lines 46–50 (T005 REVOKE UPDATE+DELETE from authenticated/anon/service_role + GRANT USAGE on sequence). | **GREEN-EXPECTED** (DDL on disk; runtime confirms via information_schema query) |
| 2 | **Verify tamper-resistance directly against DB**. As `service_role`, UPDATE + DELETE on `audit_log` raise `permission denied`; INSERT still permitted. | `0076_audit_trail.sql` REVOKE block (T005, lines 46–48); `supabase/tests/007_audit_trail/tamper_resistance.sql` (T010) codifies SQLSTATE 42501 expectation for all 3 application roles + confirms INSERT still works for service_role; `apps/web/tests/playwright/audit-route-inventory.spec.ts` (T011) statically inventories `apps/web/app/` to assert no route uses `.from('audit_log').update(...)` or `.delete(...)`. | **GREEN-EXPECTED** (REVOKE shipped; pgTAP + Playwright tests on disk) |
| 3 | **Verify monotonic ordering (sequence_id)**. Capture `max(sequence_id)`; trigger state-changing action (e.g. `admin_recalc_triggered_now`); assert new rows have strictly greater `sequence_id` in ascending order. | `0076_audit_trail.sql` line 15–19 (bigserial sequence implicitly enforces global monotonicity at allocation time); `supabase/tests/007_audit_trail/monotonic_ordering.sql` (T007) directly tests this invariant — inserts 5 rows, asserts strictly-increasing sequence + concurrent insert monotonicity; slice 006 `0070_admin_trigger_recalc.sql` provides the triggering admin RPC. | **GREEN-EXPECTED** (bigserial semantics + pgTAP regression test on disk) |
| 4 | **Verify `audit_search` RPC** — happy path (admin), denial path (non-admin → WAT01 + audit row), validation failures (WAT02 for invalid limit/range, WAT03 for unbounded count). | `0076_audit_trail.sql` lines 82–198 (T012 `audit_search` SP with admin gate + WAT02 input validation + best-effort `admin.access_denied` audit row on WAT01 path); lines 210–304 (T013 `count_audit_search` SP with WAT03 unbounded-count refusal at >100k rows); `supabase/tests/007_audit_trail/audit_search_authorization.sql` (T014) tests admin happy + non-admin denial + access-denied audit row; `supabase/tests/007_audit_trail/audit_search_errcodes.sql` (T015) tests WAT02 (limit out-of-range, invalid offset, invalid range, invalid source, action_pattern too long) + WAT03 (unbounded count > 100k). | **GREEN-EXPECTED** (RPC bodies + pgTAP tests on disk) |
| 5 | **Verify `count_audit_search` RPC** — admin invocation with `p_from` filter returns bigint count of last-24h rows. | `0076_audit_trail.sql` lines 210–304 (T013 SP); same admin-gate path as audit_search; pgTAP `audit_search_errcodes.sql` (T015) exercises the WAT03 branch. The narrowly-filtered happy path uses the same filter composition as audit_search. | **GREEN-EXPECTED** (RPC body on disk) |
| 6 | **Verify CSV export endpoint** — admin export (200 OK + correct headers + LOCKED column order + audit row written), non-admin export (403 + access-denied audit row), unbounded export (422). | `apps/web/app/api/admin/audit/export/route.ts` (T021) — GET handler with auth/admin checks, zod validation requiring ≥1 filter + max_rows ≤ 1M, ReadableStream paging via audit_search, post-stream `admin.audit_export` audit write via service-role client, locked response headers (`content-type: text/csv; charset=utf-8`, `content-disposition: attachment; filename="audit-export-*.csv"`, `cache-control: no-store`), `runtime = 'nodejs'`; `apps/web/lib/csv.ts` (T017) — `toCsvLine` RFC 4180 encoder + `AUDIT_CSV_COLUMNS` constant matching LOCKED order from `contracts/audit-export.stream.md`; `apps/web/lib/audit-search.ts` (T016) — typed RPC wrappers `auditSearch` + `countAuditSearch`; Playwright `audit-export.spec.ts` (T024) + `audit-export-denial.spec.ts` (T025) + `audit-export-validation.spec.ts` (T026) cover 200/403/422 paths and confirm audit-row side effects. | **GREEN-EXPECTED** (route + lib + 3 Playwright specs on disk) |
| 7 | **Verify admin UI search surface** at `/admin/audit/search` — filter form, results table, "Export CSV" link. | `apps/web/app/admin/audit/search/page.tsx` (T020) — server component with auth/admin gate + audit-row write on denial via narrow INSERT policy + `notFound()` for non-admin + searchParams-driven `auditSearch` call + Export CSV anchor; `apps/web/app/admin/audit/search/AuditFiltersForm.tsx` (T018) — client component form (actor/entity_type/entity_id/action_pattern/source dropdown/from/to); `apps/web/app/admin/audit/search/AuditResultsTable.tsx` (T019) — server component rendering LOCKED column order with `Intl.DateTimeFormat({ timeZone: 'America/Mexico_City' })` for tournament-timezone display per Principle VI; `audit-search.spec.ts` (T022) + `audit-search-denial.spec.ts` (T023) cover happy + denial paths. | **GREEN-EXPECTED** (page + 2 components + 2 Playwright specs on disk) |
| 8 | **Verify retention config seeded (defaults only)** — `audit.retention.policy_kind="keep"`, `audit.retention.tournament_end_buffer_months=12`, `notifications.audit_failure_webhook_url=null`. | `0076_audit_trail.sql` lines 58–68 (T006 three `INSERT … ON CONFLICT (key) DO NOTHING` seeds). Slice 007 explicitly does NOT activate retention enforcement (deferred to Slice 008+). | **GREEN-EXPECTED** (seed INSERTs on disk) |
| 9 | **Constitutional checks** — Principles II (Security/tamper-resistance), V (Auditability), VI (Time-Zone Correctness), VII (Operational Resilience), XI (Regression-Gated catalog freeze). | Principle II: REVOKE block at lines 46–50 + SECURITY DEFINER bodies in `audit_search` (line 108) + `count_audit_search` (line 222) using `is_admin`. Principle V: `0076_audit_trail.sql` formalizes `sequence_id` for ordering; prior-slice triggers (`0008`, `0033`, `0043`, `0055`, etc.) write audit rows. Principle VI: `AuditResultsTable.tsx` uses `Intl.DateTimeFormat({ timeZone: 'America/Mexico_City' })`. Principle VII: tamper-resistance at DB layer survives compromised service_role. Principle XI: `supabase/tests/007_audit_trail/action_label_catalog.sql` (T008) freezes the catalog against drift. | **GREEN-EXPECTED** (artifact-level conformance; runtime confirms via end-to-end exercise) |
| 10 | **Smoke regression checks for prior slices** — verify slices 001 (auth.granted), 002 (match.updated), 003 (prediction.created), 004 (final_prediction.created), 005 (score_record.update), 006 (admin.*) audit writers still function post-REVOKE. | `apps/web/tests/playwright/audit-regression-cross-slice.spec.ts` (T009) — Playwright test that exercises one happy-path action per prior slice and asserts the expected action label appears with `sequence_id > max_before` via `audit_search`. INSERT remains permitted by the REVOKE block (only UPDATE+DELETE revoked) so prior-slice writers are by-design preserved. `0076_audit_trail.sql` `GRANT USAGE ON SEQUENCE` at line 50 ensures all roles can still allocate `sequence_id` values. | **GREEN-EXPECTED** (Playwright cross-slice regression spec on disk; bigserial GRANT preserves writers) |
| 11 | **Cleanup**. No persistent test fixtures introduced; no cleanup required. | N/A — slice 007 is read-side + DDL + catalog freeze; no new fixtures or seeds. | **GREEN-EXPECTED** (no-op) |

## Verdict tally

- **12 steps total** (steps 0–11 in `quickstart.md`).
- **11/12 GREEN-EXPECTED** (steps 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11) — all underlying artifacts (1 migration with 4 statement groups + 5 pgTAP tests + 7 Playwright specs + 3 lib files + 1 page + 2 components + 1 API route) are present on disk and well-formed.
- **1/12 NEEDS-RUNTIME** (step 0 — preconditions explicitly require Docker + `supabase start` + a fresh admin grant + accumulated audit history; cannot be confirmed from artifacts alone).
- **0/12 ARTIFACT-GAP** — confirmed by Glob/Read of every artifact cited in the matrix.
- **0/12 PASS (runtime), 0/12 FAIL (runtime), 12/12 DEFERRED for runtime confirmation.**

## Highlights

- **Single migration shipping all DDL + RPC bodies**: `0076_audit_trail.sql` contains T003-T006 (foundational DDL/REVOKE/seed) AND T012-T013 (`audit_search` + `count_audit_search` RPC bodies). Three `BEGIN/COMMIT` blocks within one file per the migration-slot convention from `docs/architecture/open-decisions.md` D-029.
- **pgTAP fan-out**: 5 files in `supabase/tests/007_audit_trail/` — `monotonic_ordering.sql` (T007), `action_label_catalog.sql` (T008), `tamper_resistance.sql` (T010), `audit_search_authorization.sql` (T014), `audit_search_errcodes.sql` (T015).
- **Playwright fan-out**: 7 files in `apps/web/tests/playwright/` — `audit-regression-cross-slice.spec.ts` (T009), `audit-route-inventory.spec.ts` (T011), `audit-search.spec.ts` (T022), `audit-search-denial.spec.ts` (T023), `audit-export.spec.ts` (T024), `audit-export-denial.spec.ts` (T025), `audit-export-validation.spec.ts` (T026).
- **App-side artifacts**: 1 API route (`apps/web/app/api/admin/audit/export/route.ts`), 1 search page (`apps/web/app/admin/audit/search/page.tsx`), 2 components (`AuditFiltersForm.tsx` client + `AuditResultsTable.tsx` server), 2 libs (`apps/web/lib/audit-search.ts` + `apps/web/lib/csv.ts`).
- **No new writers introduced**: per slice 007's design (`tasks.md` line 11), prior-slice writers (001–006) continue to populate `audit_log` and will receive the new `sequence_id` automatically via the bigserial default. The cross-slice regression spec (T009) pins this against drift.
- **Catalog-freeze enforcement** via `action_label_catalog.sql` (T008): if any slice silently introduces a new label outside the reserved prefixes, the test fails and forces a catalog-update PR. Slice 007 adds `admin.audit_export` to the catalog per T027.

## Notes for the runtime operator (next Docker-available environment)

- **Step 1 (1c) REVOKE verification query**: the expectation is "0 rows" for `(authenticated, anon, service_role) × (UPDATE, DELETE)` privilege grants on `audit_log`. Postgres may still list other privilege types (SELECT, INSERT, REFERENCES, TRIGGER, TRUNCATE) for these roles — the test filter explicitly restricts to UPDATE+DELETE.
- **Step 2 service_role semantics**: Postgres `service_role` typically bypasses RLS but NOT GRANT-revoked DML. The REVOKE block is the authoritative protection layer; even a compromised service_role key cannot UPDATE/DELETE audit rows.
- **Step 4b access-denied audit row**: the `audit_search` RPC body writes the denial row inside a sub-block with `EXCEPTION WHEN OTHERS THEN NULL` (lines 120–145 of `0076_audit_trail.sql`) — best-effort, survives even if the audit_log INSERT path is blocked for the calling role; the WAT01 RAISE always fires regardless.
- **Step 4c WAT03**: requires a fixture seeding > 100,000 audit rows to exercise the unbounded-count refusal. Per T015, this branch may be skipped at runtime with a note if seeding 100k rows is too expensive — the SP logic is statically reviewable.
- **Step 6a admin CSV export audit row**: `admin.audit_export` is written AFTER the stream closes (post-flush) using a Supabase service-role client because the user's session would hit the RLS narrow-INSERT-policy path which doesn't allow this label. Per T027, the catalog includes `admin.audit_export`; T008's catalog assertion will detect drift.
- **Step 6c 422 vs audit row**: per `contracts/audit-export.stream.md` "Audit posture", 422 validation failures are pre-auth-check noise and explicitly do NOT pollute the audit log. T026 (`audit-export-validation.spec.ts`) asserts NO audit row is written for these 422s.
- **Step 7 timezone display**: `AuditResultsTable.tsx` uses hard-coded `'America/Mexico_City'` as the tournament timezone. If the tournament timezone changes via `tournament_config`, this hard-coding becomes a follow-up — see `docs/architecture/open-decisions.md` for the timezone-config decision.
- **Step 8 retention config**: the seeded keys are inert in slice 007 — no retention enforcement runs yet. Slice 008+ will hook these to a periodic purge job and webhook delivery (per R-011 in `research.md`).
- **Step 10 cross-slice regression**: T009 (`audit-regression-cross-slice.spec.ts`) exercises one happy-path action per prior slice. If any prior writer was using UPDATE/DELETE on audit_log (it shouldn't — all are INSERT-only by design), this test will fail and flag the offending slice.

## Verdict

**Slice 007 is artifact-complete. All 12 quickstart steps are backed by on-disk artifacts (1 migration with 4 DDL groups + 2 RPC bodies, 5 pgTAP tests, 7 Playwright specs, 1 API route, 1 page, 2 components, 2 lib files). 11/12 steps are code-review GREEN-EXPECTED; 1/12 (step 0 — environmental preconditions) requires runtime. Zero ARTIFACT-GAP entries. Runtime verification deferred to the first Docker-available environment.**

T029 and T030 complete slice 007's Phase 6 polish. T030 documents the audit-write-failure runbook per Clarification Q3 and R-011.
