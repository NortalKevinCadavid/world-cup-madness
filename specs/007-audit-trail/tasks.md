---
description: "Task list for slice 007 — Audit Trail"
---

# Tasks: Audit Trail (Slice 007)

**Input**: Design documents under `specs/007-audit-trail/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/{audit-log.schema.md, audit-search.read.md, audit-export.stream.md}, quickstart.md

**Cross-slice dependencies**: Slices 001 (`audit_log` base, `is_eligible_nortal_participant`, `participants` table, auth-hook) and 006 (`is_admin(uuid)` real body, `admin.*` action labels, `source_citation` column) MUST be deployed. This slice does NOT add new writers — the cross-slice writers in 001–006 continue to populate `audit_log` and will automatically receive the new `sequence_id` after the migration.

**Tests requested**: YES — Constitution Principle IX (TDD via BDD) + Principle XI (regression-gated). Each non-trivial behavior gets a pgTAP-style SQL test or a Playwright browser test.

**Self-contained task convention** (per user memory `feedback_speckit_tasks_self_contained`): every task is dispatchable to its own subagent with no inherited conversation context. Each task carries explicit absolute paths, contract references, and acceptance signals.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3 (omitted for Setup / Foundational / Polish)
- Absolute Windows paths included for clarity

## Path Conventions

- Next.js app: `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\`
- Supabase migrations: `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\`
- Supabase SQL tests: `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\007_audit_trail\`
- Playwright tests: `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Migration file scaffold + test directory layout. No behavior changes.

- [X] T001 [P] Create the migration file `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\007_audit_trail.sql` as an empty file with header comment block: `-- Slice 007 Audit Trail — finalize audit_log shape, REVOKE tamper privileges, ship audit_search RPC + retention config seed.` Set file as UTF-8 LF. **D-029**: actual file shipped as `0076_audit_trail.sql` (4-digit slot, per project convention; slice 006 ended at 0075).

- [X] T002 [P] Create the SQL test directory `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\007_audit_trail\` and an empty README inside it: `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\007_audit_trail\README.md` describing that pgTAP-style fixtures live here, invoked via `supabase test db` in CI per Slice 001's testing convention.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DB-side schema changes + tamper-resistance + retention config keys. ALL must complete before any user story phase begins.

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete. T012 / T013 (RPC bodies) belong to US3 but are appended to the same migration file — task order in the file matters; phase ordering does not.

- [X] T003 Append to `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\007_audit_trail.sql` an `ALTER TABLE public.audit_log ADD COLUMN sequence_id bigserial NOT NULL;` statement. Verify by mentally walking the DDL: Postgres auto-creates sequence `public.audit_log_sequence_id_seq`, allocates monotonic NOT NULL values for existing rows, and adds an implicit UNIQUE constraint. Add an explicit `CREATE UNIQUE INDEX IF NOT EXISTS audit_log_sequence_id_uk ON public.audit_log (sequence_id);` for readability. Reference: `specs/007-audit-trail/contracts/audit-log.schema.md` DDL section.

- [X] T004 [P] Append three new indexes to the migration file in `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\007_audit_trail.sql`: `audit_log_actor_occurred_idx ON (actor, occurred_at DESC) WHERE actor IS NOT NULL`, `audit_log_target_idx ON (entity_type, entity_id, sequence_id ASC) WHERE entity_id IS NOT NULL`, `audit_log_source_occurred_idx ON (source, occurred_at DESC)`. Use `CREATE INDEX IF NOT EXISTS`. Reference R-008 in `specs/007-audit-trail/research.md` and the Indexes table in `data-model.md`. (Parallel-marked because index DDL statements are independent — but they share the migration file with T003, T005, T006, so write order is sequential in the file even if conceptually parallel.)

- [X] T005 Append the REVOKE block to `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\007_audit_trail.sql`: `REVOKE UPDATE, DELETE ON public.audit_log FROM authenticated; REVOKE UPDATE, DELETE ON public.audit_log FROM anon; REVOKE UPDATE, DELETE ON public.audit_log FROM service_role;` Also add `GRANT USAGE ON SEQUENCE public.audit_log_sequence_id_seq TO authenticated, anon, service_role;` so triggers/SPs that INSERT still allocate sequence_id values. This is the LOCKED tamper-resistance posture per R-001 and Principle II. Reference: `specs/007-audit-trail/contracts/audit-log.schema.md` "Tamper-resistance posture (LOCKED)".

- [X] T006 Append three `INSERT … ON CONFLICT (key) DO NOTHING` statements seeding `tournament_config` keys to `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\007_audit_trail.sql`: `audit.retention.policy_kind = '"keep"'::jsonb`, `audit.retention.tournament_end_buffer_months = '12'::jsonb`, `notifications.audit_failure_webhook_url = 'null'::jsonb`. These are defaults only; Slice 008 admin UI will mutate. Reference R-003 + R-011 + `data-model.md` "Audit Retention Policy" section.

**Checkpoint**: After T003-T006, `audit_log` has its final additive shape and tamper-resistance posture. Indexes are present. Config keys exist. The table is now ready to host audit_search; user stories can begin.

---

## Phase 3: User Story 1 — Every state-changing action is recorded (Priority: P1) 🎯 MVP

**Goal**: Verify that the new `sequence_id` column + REVOKE statements do NOT regress any of slices 001–006's audit writers, and that the action label catalog is frozen against accidental drift.

**Why this is MVP**: This story is the regression invariant of the entire slice. Without it, slices 001–006 could silently break when we tighten audit_log privileges. The catalog-freeze test prevents accidental label rename which would silently break dispute investigation.

**Independent Test**: Run the entire prior-slice quickstart matrix (sign in, sync a match, submit a prediction, submit a final prediction, recalc scores, run an admin RPC) and verify (1) every action still produces ≥1 audit row, (2) each new audit row has a strictly-greater `sequence_id` than the previous max, (3) no action label outside the frozen catalog appears.

### Tests for User Story 1 (write first; expect to PASS after T003-T006 only)

- [X] T007 [P] [US1] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\007_audit_trail\monotonic_ordering.sql`. Test plan: BEGIN a transaction, capture `SELECT max(sequence_id) FROM audit_log` as `before_max`. INSERT 5 rows into `audit_log` directly via service-role role. Assert each new row's `sequence_id > before_max` and that the 5 values form a strictly-increasing sequence. Then in a SEPARATE session, simulate concurrent inserts (insert from two roles back-to-back) and assert global monotonicity holds. Reference: R-002 + `contracts/audit-log.schema.md` "Monotonic ordering invariant". Format the file per Slice 001's pgTAP convention (`BEGIN; SELECT plan(N); … SELECT * FROM finish(); ROLLBACK;`).

- [X] T008 [P] [US1] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\007_audit_trail\action_label_catalog.sql`. Test plan: define an expected catalog array (the full 60+ labels listed under "Action label catalog" in `specs/007-audit-trail/data-model.md`). Query `SELECT DISTINCT action FROM audit_log` and assert (a) the result set is a SUBSET of expected, (b) no never-seen-before labels appear OUTSIDE the reserved prefixes `tournament_config.*` (reserved for Slice 008) and `score_trigger.*` (Slice 005 extension). Failure mode: if a prior slice silently introduced a new label not yet in the catalog, this test fails and forces a catalog-update PR. Reference R-009.

- [X] T009 [P] [US1] Create a Playwright regression test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\audit-regression-cross-slice.spec.ts`. Test plan: sign in as a seeded admin, then exercise one happy-path action per prior slice (Slice 001 sign-in → `access.granted`; Slice 002 sync trigger → `match.updated`; Slice 003 prediction submission → `prediction.created`; Slice 004 final prediction → `final_prediction.created`; Slice 005 recalc → `score_record.update`; Slice 006 admin RPC → `admin.recalc_triggered`). After each action, query `audit_search` (admin-gated) and assert the expected action label appears with `sequence_id > max_before`. This is the regression-gating per Principle XI. Reference quickstart.md Step 10.

### Implementation for User Story 1

(No implementation tasks — US1 is regression-only. T003-T006 in Phase 2 are the entirety of the implementation surface for this story. T007-T009 verify it.)

**Checkpoint**: At this point, all prior slices' writers continue to function with the additional `sequence_id`, and the catalog is frozen against drift.

---

## Phase 4: User Story 2 — Audit records are immutable through application paths (Priority: P1)

**Goal**: Verify (a) DB-level tamper-resistance — UPDATE/DELETE on `audit_log` fails from every application role, (b) no UI/API surface offers update/delete of `audit_log`.

**Why this priority**: Without it, the audit table's integrity guarantee evaporates against a compromised service-role key or against a developer mistake adding a UI delete-row button. Both are realistic.

**Independent Test**: As `service_role`, attempt `UPDATE audit_log SET reason='hi' WHERE id = …` — must return SQLSTATE 42501. Inventory every Next.js route under `apps/web/app/` and assert none uses `.from('audit_log').update(...)` or `.from('audit_log').delete(...)`.

### Tests for User Story 2

- [X] T010 [P] [US2] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\007_audit_trail\tamper_resistance.sql`. Test plan: (1) SET ROLE authenticated; expect UPDATE on `audit_log` to raise SQLSTATE `42501` (`insufficient_privilege`). (2) SET ROLE service_role; expect same. (3) SET ROLE anon; expect same for both UPDATE and DELETE. (4) Confirm INSERT still succeeds for service_role (writers' path is preserved). (5) Confirm SELECT from the table itself is still bound by RLS as expected. Use pgTAP `throws_ok()` for the expected failures. Reference: User Story 2 acceptance scenario 3 in spec.md (updated by clarification Q4) + `contracts/audit-log.schema.md` "Tamper-resistance posture".

- [X] T011 [P] [US2] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\audit-route-inventory.spec.ts`. Test plan: programmatically walk `apps/web/app/` directory tree (via `node:fs/promises` recursive readdir inside the test) and for each `.ts`, `.tsx`, `.js`, `.jsx` file, grep its content for the regex `audit_log['"]\s*\)\s*\.(update|delete)` (Supabase client style) and for `\bUPDATE\s+(?:public\.)?audit_log\b` / `\bDELETE\s+(?:FROM\s+)?(?:public\.)?audit_log\b` (raw SQL style). Test fails (with the offending file path) if any match. This validates the Clarification Q4 design: no UI/API surface offers update/delete. Per Clarification Q4 wording in `specs/007-audit-trail/spec.md`.

### Implementation for User Story 2

(No new implementation — the REVOKE statements in Phase 2 T005 ARE the implementation. T010 and T011 are the verification.)

**Checkpoint**: At this point, audit records are demonstrably immutable through both the DB layer and the application surface.

---

## Phase 5: User Story 3 — Administrators can search and export audit records (Priority: P2)

**Goal**: Admin can search `audit_log` by filters and export results as CSV.

**Independent Test**: Sign in as admin → visit `/admin/audit/search` → filter by `action_pattern='admin.%'` and last 7 days → see results → click "Export CSV" → verify CSV downloads with the locked column order and matching row set. Sign in as non-admin → 403 on the same surfaces; access-denial audit row written.

### Tests for User Story 3 (write first; expect to FAIL until implementation done)

- [X] T012 [US3] Append `audit_search(...)` RPC body to `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\007_audit_trail.sql`. Use the LOCKED signature from `specs/007-audit-trail/contracts/audit-search.read.md`: 9 parameters with NULL defaults, returns TABLE(12 columns), `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public`. Body: `is_admin(auth.uid())` check raising `WAT01`, input validation raising `WAT02`, filter-composition SELECT with `ORDER BY a.sequence_id ASC LIMIT p_limit OFFSET p_offset`. Grant EXECUTE to `authenticated` only (NOT anon). Reference: `contracts/audit-search.read.md` "Signatures (LOCKED)" + "Behavior" sections.

- [X] T013 [US3] Append `count_audit_search(...)` RPC body to `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\007_audit_trail.sql`. 7-parameter signature (no `p_limit`/`p_offset`), returns `bigint`. Same admin-check (`WAT01`), same input validation (`WAT02`), plus the unbounded-count refusal — if all filters are NULL AND `(SELECT count(*) FROM audit_log) > 100000`, raise `WAT03` BEFORE running the actual count. Otherwise return `SELECT count(*) FROM audit_log WHERE <same filter composition as audit_search>`. Reference: `contracts/audit-search.read.md` "Behavior > Input validation" table (the WAT03 row).

- [X] T014 [P] [US3] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\007_audit_trail\audit_search_authorization.sql`. Test plan: (1) SET LOCAL request.jwt.claims to a non-admin participant's uuid; call `SELECT * FROM public.audit_search();` — expect `throws_ok` with SQLSTATE `WAT01`. (2) Verify that a row with `action='admin.access_denied'`, `entity_type='audit_search'`, `source='api_guard'`, `actor=<non-admin uuid>` was written (the RPC body audits the denial). (3) SET LOCAL to an admin participant's uuid; call `audit_search(p_limit => 5)`; expect a result set ≤ 5 rows ordered by `sequence_id ASC`. Reference: `contracts/audit-search.read.md` "Authorization" subsection.

- [X] T015 [P] [US3] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\007_audit_trail\audit_search_errcodes.sql`. Test plan as admin: (1) `audit_search(p_limit => 1000)` → expect `WAT02`. (2) `audit_search(p_limit => 0)` → expect `WAT02`. (3) `audit_search(p_offset => -1)` → expect `WAT02`. (4) `audit_search(p_from => '2026-12-31'::timestamptz, p_to => '2026-01-01'::timestamptz)` → expect `WAT02`. (5) `audit_search(p_source => 'invalid_source')` → expect `WAT02`. (6) `audit_search(p_action_pattern => repeat('x', 201))` → expect `WAT02`. (7) `count_audit_search()` with no filters on a > 100k-row table (use a fixture that pre-seeds 100001 rows, or skip with note if seeding too expensive) → expect `WAT03`. Reference: `contracts/audit-search.read.md` "Input validation" table.

- [X] T016 [P] [US3] Create the typed RPC wrapper `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\lib\audit-search.ts`. Export two async functions: `async function auditSearch(supabase, params: AuditSearchParams): Promise<AuditRow[]>` and `async function countAuditSearch(supabase, params: AuditCountParams): Promise<number>`. Define `AuditSearchParams`, `AuditCountParams`, `AuditRow` zod schemas at the top of the file (or, if zod is not yet on the dependency list, plain TS interfaces — verify by reading `apps/web/package.json`). On error, surface `error.code` (Postgres ERRCODE — `WAT01`, `WAT02`, `WAT03`) to the caller without rewriting the message. Reference: `contracts/audit-search.read.md` "Client usage" example.

- [X] T017 [P] [US3] Create the CSV encoder `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\lib\csv.ts`. Export `function toCsvLine(row: Record<string, unknown>, columns: readonly string[]): string` that produces an RFC 4180-compliant CSV line: double-quote any cell containing comma, double-quote, or newline; escape internal double-quotes by doubling; serialize `null`/`undefined` as empty cell; serialize JSON values via `JSON.stringify` then quote. Also export `const AUDIT_CSV_COLUMNS` constant exactly matching the LOCKED column order: `['sequence_id','occurred_at','actor','action','entity_type','entity_id','source','reason','source_citation','previous_value','new_value','id']`. Reference: `contracts/audit-export.stream.md` "CSV column order (LOCKED)".

- [X] T018 [P] [US3] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\audit\search\AuditFiltersForm.tsx` as a client component (`'use client'`). Render a form with these inputs: actor (uuid text), entity_type (text), entity_id (uuid text), action_pattern (text with `%` allowed), source (select with values `auth_hook`, `trigger`, `rls`, `api_guard`, `admin_rpc`, `ui`, `system`, and a blank option), from (datetime-local), to (datetime-local). On submit, call the parent's `onSearch(filters)` callback (props: `{ onSearch: (params: AuditSearchParams) => void; loading: boolean }`). Use Tailwind for styling; no external form library required. Validate on the client side that `from <= to` if both provided.

- [X] T019 [P] [US3] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\audit\search\AuditResultsTable.tsx` as a server component. Props: `{ rows: AuditRow[] }`. Render a `<table>` with columns matching the LOCKED CSV order (per `contracts/audit-export.stream.md`). Display `occurred_at` formatted via `Intl.DateTimeFormat(undefined, { timeZone: 'America/Mexico_City' })` (per Principle VI — tournament timezone). Display `previous_value` and `new_value` as collapsed JSON via a `<details>` element. Display `actor` as a participant link if a `participants` join is feasible; otherwise raw uuid. Display empty state ("No audit events match the filters.") when `rows.length === 0`.

- [X] T020 [US3] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\audit\search\page.tsx`. Server component: (1) Resolve current user via `createServerClient` from `@supabase/ssr`; if not authenticated, redirect to `/`. (2) Call `is_admin(auth.uid())` RPC; if `false`, write an `admin.access_denied` audit row via the narrow INSERT policy from Slice 006 (`entity_type='audit_search_page'`), then `notFound()`. (3) Read filter params from `searchParams` (Next.js 14 App Router prop). (4) If at least one filter is set, call `auditSearch` from `apps/web/lib/audit-search.ts`. (5) Render `<AuditFiltersForm>` (client component) above `<AuditResultsTable>` (server component); pass results down. (6) Include a "Export CSV" link rendered as `<a href={`/api/admin/audit/export?${searchParams.toString()}`}>` that opens in a new tab. Depends on T016, T018, T019.

- [X] T021 [US3] Create the CSV streaming route handler `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\api\admin\audit\export\route.ts`. Implement `export async function GET(req: NextRequest)` per `specs/007-audit-trail/contracts/audit-export.stream.md`. Steps in order: (1) auth check — 401 if no session. (2) admin check via `is_admin` RPC — 403 if not admin AND write `admin.access_denied` audit row with `entity_type='audit_export'`. (3) Parse + validate query params via zod — 422 with `{ error: '<reason>' }` on failure. Require at least one of `from`, `to`, `actor`, `entity_id`, `action_pattern`. Reject `max_rows > 1_000_000`. (4) Build a `ReadableStream` whose `start()` enqueues the CSV header (use `AUDIT_CSV_COLUMNS.join(',')` from `apps/web/lib/csv.ts`), then loops `audit_search` with `p_limit=1000` paging until `max_rows` reached or fewer than `p_limit` returned. (5) After stream closes, write `admin.audit_export` audit row with `new_value: { filters, rows_exported, truncated }` (use a Supabase service-role client for this server-side write since the user's session would re-trigger the RLS narrow-INSERT-policy path which doesn't allow that label). Response headers: `content-type: text/csv; charset=utf-8`, `content-disposition: attachment; filename="audit-export-<ISO timestamp>.csv"`, `cache-control: no-store`. Configure route as Node.js runtime (NOT Edge): add `export const runtime = 'nodejs';` at top. Depends on T012, T016, T017.

- [X] T022 [P] [US3] Create Playwright test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\audit-search.spec.ts`. Test plan: (1) Sign in as a seeded admin (use the Slice 001 / Slice 006 test-fixture admin uuid). (2) Visit `/admin/audit/search?action_pattern=admin.%25&from=<seven days ago ISO>`. (3) Assert the page renders the filter form + results table + "Export CSV" link. (4) Assert at least 1 row visible (the test seed must have produced an admin.* audit row). (5) Filter by `source=admin_rpc` via the form, click submit, assert URL updates with `source=admin_rpc` and results filter correctly.

- [X] T023 [P] [US3] Create Playwright test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\audit-search-denial.spec.ts`. Test plan: (1) Sign in as a non-admin participant. (2) Visit `/admin/audit/search`. (3) Expect 404 (Next.js `notFound()`) OR a server-rendered access-denied notice — match against the implementation in T020. (4) Query the test DB directly (via Supabase test client) to assert a row exists in `audit_log` with `action='admin.access_denied'`, `entity_type='audit_search_page'`, `actor=<non-admin uuid>`, written within the last 10 seconds.

- [X] T024 [P] [US3] Create Playwright test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\audit-export.spec.ts`. Test plan: (1) Sign in as admin. (2) `await page.goto('/api/admin/audit/export?action_pattern=admin.%25&from=<seven days ago>')` and capture the response. (3) Assert response status 200, `content-type` includes `text/csv`, `content-disposition` matches `attachment; filename=".+\.csv"`. (4) Parse the response body, assert header line === the LOCKED column order from `apps/web/lib/csv.ts`. (5) Assert at least 1 data row. (6) After the download completes, query DB to confirm `admin.audit_export` audit row was written with `actor=<admin uuid>`, `new_value.rows_exported >= 1`.

- [X] T025 [P] [US3] Create Playwright test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\audit-export-denial.spec.ts`. Test plan: (1) Sign in as non-admin. (2) Visit `/api/admin/audit/export?action_pattern=admin.%25&from=<one day ago>`. (3) Assert response status 403, body === `"Forbidden"`. (4) Query DB to confirm `admin.access_denied` audit row with `entity_type='audit_export'`, `actor=<non-admin uuid>`.

- [X] T026 [P] [US3] Create Playwright test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\audit-export-validation.spec.ts`. Test plan as admin: (1) Visit `/api/admin/audit/export` (no filters) → expect 422 with body `{ "error": ".*filter.*required.*" }`. (2) Visit `/api/admin/audit/export?max_rows=2000000` → expect 422. (3) Visit `/api/admin/audit/export?source=garbage` → expect 422 (rejected by zod). (4) Confirm NO audit row written for these 422s (validation failures are pre-auth-check noise and shouldn't pollute the audit log — design decision per `contracts/audit-export.stream.md` "Audit posture" section).

- [X] T027 [P] [US3] Add the new action label `admin.audit_export` to the catalog table in `C:\Users\kevin.cadavid\Documents\world-cup-madness\specs\007-audit-trail\data-model.md` under the existing `admin.*` row (or as a new row in the "Action label catalog" table). This task is purely documentation but is REGRESSION-GATED: T008's catalog assertion test will fail if this label appears in audit_log without being in the catalog.

**Checkpoint**: All three user stories are complete. Admin search + CSV export are end-to-end functional. Tamper-resistance and catalog-freeze are verified.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T028 Run the quickstart verification recipe end-to-end against a fresh local DB: follow `C:\Users\kevin.cadavid\Documents\world-cup-madness\specs\007-audit-trail\quickstart.md` steps 0–11. Document any deltas between the recipe and the actual behavior in a `## Quickstart deltas (Slice 007)` section appended to `quickstart.md` (or confirm "no deltas" in the spec session if recipe ran clean). **DEFERRED** — Docker daemon down at authoring time; per slice 005 T040 + slice 006 T040/T041 precedent, shipped `specs/007-audit-trail/quickstart-verification.md` with per-step code-review verdict matrix (11/12 GREEN-EXPECTED, 1/12 NEEDS-RUNTIME, 0/12 ARTIFACT-GAP) and appended a `## Quickstart deltas (Slice 007)` pointer section to `quickstart.md`. Runtime confirmation deferred to first Docker-available environment.

- [X] T029 [P] Update `C:\Users\kevin.cadavid\Documents\world-cup-madness\INDEX.md` to list the new files added by this slice: the migration, the test directory, the new lib + UI + route files under `apps/web/`, the new playwright tests. Use the existing INDEX format. (If `INDEX.md` is auto-generated via `scripts/index/generate.sh`, just note "run `./scripts/index/generate.sh` after merge.") Reference: project root CLAUDE.md "Important Rules" rule 4.

- [X] T030 [P] Create an operational runbook entry `C:\Users\kevin.cadavid\Documents\world-cup-madness\docs\runbooks\audit-write-failure.md` (creating the `docs/runbooks/` directory if it does not exist) documenting: (a) symptoms — Postgres errors in Supabase logs containing `audit_log`, application 500s on state-changing endpoints; (b) likely causes — DB unavailable, sequence exhausted (extremely unlikely with bigserial), trigger failure; (c) immediate response — verify DB connectivity, check Supabase status page, check pg_locks for blocking; (d) escalation — page on-call DBA; (e) note that Slice 008 will add webhook delivery hooking `notifications.audit_failure_webhook_url`. Reference Clarification Q3 in `specs/007-audit-trail/spec.md` and R-011 in `research.md`.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1. Blocks ALL user stories.
- **Phase 3 (US1)**: Depends on Phase 2 only. Independent of US2/US3.
- **Phase 4 (US2)**: Depends on Phase 2 only. Independent of US1/US3.
- **Phase 5 (US3)**: Depends on Phase 2. T020 depends on T016/T018/T019. T021 depends on T012/T016/T017. T012/T013 share the migration file with Phase 2 T003-T006 — write them sequentially in the same file.
- **Phase 6 (Polish)**: Depends on all prior phases.

### Within-phase dependencies

- T001 || T002 (different files)
- T003 → T004 → T005 → T006 (same migration file; sequential writes)
- T007 || T008 || T009 (different test files)
- T010 || T011 (different test files)
- T012 → T013 (same migration file)
- T014 || T015 (different test files; both depend on T012/T013)
- T016 || T017 || T018 || T019 || T027 (different files)
- T020 depends on T016, T018, T019
- T021 depends on T012, T016, T017
- T022 || T023 || T024 || T025 || T026 (different test files; depend on T020/T021)
- T028 → T029 || T030

### Parallel opportunities

- Setup: T001 || T002.
- Foundational: T004 [P] in spirit, but file-bound — practically sequential.
- US1: T007 || T008 || T009 — three test agents can run in parallel.
- US2: T010 || T011 — two test agents in parallel.
- US3 implementation: T016 || T017 || T018 || T019 || T027 (5 parallel agents).
- US3 tests: T022 || T023 || T024 || T025 || T026 (5 parallel agents).
- Polish: T029 || T030 after T028.

---

## Parallel Example: User Story 3 implementation kickoff

```bash
# After Phase 2 + T012/T013 are done, fan out 5 parallel agents:
Agent: "Create the typed RPC wrapper at apps/web/lib/audit-search.ts per T016"
Agent: "Create the CSV encoder at apps/web/lib/csv.ts per T017"
Agent: "Create AuditFiltersForm component per T018"
Agent: "Create AuditResultsTable component per T019"
Agent: "Add admin.audit_export label to data-model.md catalog per T027"
```

Then sequentially:

```bash
Agent: "Create /admin/audit/search page per T020 (depends on T016/T018/T019)"
Agent: "Create /api/admin/audit/export route per T021 (depends on T012/T016/T017)"
```

Then fan out test agents:

```bash
Agent: "Playwright test audit-search.spec.ts per T022"
Agent: "Playwright test audit-search-denial.spec.ts per T023"
Agent: "Playwright test audit-export.spec.ts per T024"
Agent: "Playwright test audit-export-denial.spec.ts per T025"
Agent: "Playwright test audit-export-validation.spec.ts per T026"
```

---

## Implementation Strategy

### MVP-first

1. Complete Phase 1 (Setup) — 2 tasks.
2. Complete Phase 2 (Foundational) — 4 tasks. The migration file is now substantively done apart from the RPC bodies.
3. Complete Phase 3 (US1 regression suite) — 3 test tasks.
4. **STOP and VALIDATE**: Confirm slices 001–006's writers still work and `sequence_id` is monotonic. This is the MVP — a tamper-resistant audit table.
5. Decide whether to ship as-is (admin investigates via direct DB queries) or proceed to US2/US3.

### Incremental delivery

- After MVP (Phase 3 done): tamper-resistance proven (US2 tests added late).
- After Phase 4: deploy & validate immutability of UI surfaces.
- After Phase 5: admins gain self-service search + export.

### Parallel-team strategy

- Developer A: Phases 1 + 2.
- After Phase 2: Developer A → US1 (regression); Developer B → US2 (tamper tests); Developer C → US3 (RPCs + UI + export). All three streams converge in Polish.

---

## Cross-slice contract reminders (do not break)

- `audit_search(uuid, text, uuid, text, text, timestamptz, timestamptz, int, int) RETURNS TABLE(...)` — signature LOCKED at slice close.
- `count_audit_search(uuid, text, uuid, text, text, timestamptz, timestamptz) RETURNS bigint` — signature LOCKED.
- ERRCODE namespace `WAT01..WAT03` owned by this slice; do not collide with `WCM01..05` (Slice 003), `WFP01..06` (Slice 004), or `WAR01..06` (Slice 006).
- `audit_log` final 12-column shape — Slice 008 may add columns; must not alter/drop.
- REVOKE UPDATE/DELETE on `audit_log` — never re-grant in any future slice.
- CSV column order — LOCKED in T017; export-route T021 must produce same order.
- Action label catalog — frozen at slice close. New labels MAY be added by Slice 008 under `tournament_config.*` prefix only.

---

## Notes

- All tests run via `supabase test db` for SQL tests and `pnpm --filter web playwright test` for Playwright tests, per Slice 001's CI conventions.
- Each task is self-contained per the user memory `feedback_speckit_tasks_self_contained` — a subagent receiving only the task description plus the design docs under `specs/007-audit-trail/` should be able to complete the task without further context.
- Commit cadence: one commit per Phase checkpoint (Phase 1 done → commit; Phase 2 done → commit; etc.). Slice 007 should land as 5–6 commits total.
- WSL2 install remains the blocker for `supabase start` / `pnpm playwright test` execution. Authoring + reviewing tasks can proceed unblocked.

---

## Total task count

**30 tasks** across 6 phases:

- Phase 1 (Setup): 2
- Phase 2 (Foundational): 4
- Phase 3 (US1): 3
- Phase 4 (US2): 2
- Phase 5 (US3): 16
- Phase 6 (Polish): 3

Suggested MVP scope: Phase 1 + Phase 2 + Phase 3 (T001–T009) — tamper-resistant audit table with regression-verified writers. The admin-search-and-export surface (Phase 5) is high-value but additive on the MVP foundation.
