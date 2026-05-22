---
description: "Task list for slice 006 (Admin Overrides & Recalculation) — each task is a self-contained agent prompt"
---

# Tasks: Admin Overrides & Recalculation (Slice 006)

**Input**: Design documents in `specs/006-admin-overrides/`

**Prerequisites**: `spec.md` (with Clarifications 2026-05-17), `plan.md`, `research.md`, `data-model.md`, all four files under `contracts/`, `quickstart.md` (all present). **Slices 001 + 002 + 003 + 004 + 005 regression baselines MUST be GREEN before this slice starts** (Constitution Principle XI).

**Test posture**: Tests MANDATORY per Principle IX (RED-first). Full regression (Slices 001 + 002 + 003 + 004 + 005 + 006) GREEN before next task or merge per Principle XI.

**Special status — integration / orchestration slice**: Consumes locked SPs from Slices 002 (`record_match_result`), 003 (`submit_prediction` + `is_prediction_locked`), 004 (`submit_final_prediction` + `is_final_prediction_locked`), 005 (`score-trigger` Edge Function + `score_calculation_runs`). **Replaces Slice 001's permissive `is_admin(uuid)` stub** with the real body reading the new `admin_roles` table. Ships 7 SECURITY DEFINER `admin_*` RPC wrappers + 2 bypass-lock sibling SPs + `/admin/*` page tree.

## How to read this file

Each task is a self-contained agent prompt. Paste any task into a fresh subagent — it has everything it needs.

Format conventions:
- **`[P]`** parallel-safe.
- **`[US#]`** user story phase tasks only. Setup / Foundational / Polish unmarked.
- **`Blocked-by:`** task IDs that MUST be done first.
- **`Parallel-safe with:`** task IDs sharing no write paths.
- **`Definition of done:`** exactly one checkable assertion.

Path conventions per `plan.md` § Source Code:
- Migrations → `supabase/migrations/`
- pgTAP → `supabase/tests/pgtap/`
- Web app → `apps/web/`
- Playwright → `apps/web/tests/playwright/`

Constitution refresher:
- **II (Security)**: every admin RPC is SECURITY DEFINER + pre-checks `is_admin`.
- **III (Rules outside UI)**: `is_admin(uuid)` is the single named predicate; reason+source validated at SP body.
- **V (Auditability)**: every admin action emits `audit_log` row with `source='admin_rpc'` + `source_citation` in same transaction.
- **VII (Operational Resilience)**: Slice 005 advisory lock + this slice's per-target advisory lock + Edge Function self-scan resume (per Clarifications Q2) + slow pg_cron backup.
- **IX (TDD via BDD, NON-NEGOTIABLE)**: scenario → RED → implement.
- **XI (Regression-Gated)**: full suite GREEN before next task or merge.

---

## Phase 1: Setup

- [X] T001 Verify Slices 001 + 002 + 003 + 004 + 005 regression baselines are GREEN — `specs/006-admin-overrides/regression-baseline-from-prior-slices.md`

**Agent prompt:**

> **Goal**: Confirm every prior-slice test (Playwright + pgTAP + Deno + perf assertions) is GREEN. Per Constitution Principle XI, Slice 006 cannot start with any prior-slice suite in a red state.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle XI
> - `specs/00{1,2,3,4,5}-*/regression-final.md` (the five prior-slice final gate outputs)
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/regression-baseline-from-prior-slices.md` (new) — table with every Slice 001–005 test + pass/fail + duration.
>
> **What to do**:
> 1. Enumerate every prior-slice Playwright + pgTAP + Deno test (per each slice's quickstart.md § Run automated tests).
> 2. Run each. Record pass/fail.
> 3. If any are red, STOP — file a bug; do not proceed.
>
> **Acceptance criteria**: File exists with every prior-slice test recorded as `pass`.
>
> **Constitution**: XI (NON-NEGOTIABLE).

**Blocked-by**: _(none — gate)_
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-baseline-from-prior-slices.md` lists all prior-slice tests as `pass`.

---

- [X] T002 Cross-slice `is_admin` test migration audit — `specs/006-admin-overrides/is-admin-test-migration.md`

**Agent prompt:**

> **Goal**: Slice 001's `is_admin(uuid)` stub returns `auth.jwt() ->> 'role' = 'admin'`. Many Slice 002–005 pgTAP and Playwright tests synthesize JWTs with `{"role": "admin"}` claims to satisfy this stub. This slice replaces the function body with one that reads the `admin_roles` table — those tests MUST be updated to ALSO insert an `admin_roles` row for their admin participant. This task identifies every affected test and documents the migration plan.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/is-admin.predicate.sql.md` § Difference from Slice 001 stub
> - Slice 001's `data-model.md` § RLS posture (the original `is_admin` stub)
> - All Slice 002–005 pgTAP + Playwright tests that reference `role.*admin` (grep)
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/is-admin-test-migration.md` (new) — table with every affected test file, the JWT claim it sets, and the `admin_roles` INSERT it MUST add.
>
> **What to do**:
> 1. `grep -rn "role.*admin\|is_admin" supabase/tests/pgtap/ apps/web/tests/playwright/` and identify every test that depends on the stub semantic.
> 2. For each, document: file path; current JWT/setup; required INSERT INTO admin_roles after T009 ships.
> 3. T008 (this slice) will apply the migration to every identified test.
>
> **Acceptance criteria**: File exists with complete affected-test inventory + per-test migration plan.
>
> **Do NOT**: modify any test in this task — that's T008. This is a survey + plan only.
>
> **Constitution**: XI (test migration is part of the cross-slice contract change).

**Blocked-by**: T001
**Parallel-safe with**: _(none — survey output drives later tasks)_
**Definition of done**: `is-admin-test-migration.md` enumerates every affected Slice 002–005 test + the required INSERT.

---

**Setup checkpoint**: T001–T002 done. Prior baseline green; cross-slice migration plan ready.

---

## Phase 2: Foundational (BLOCKING)

This phase creates `admin_roles`, the additive `audit_log.source_citation` column, the additive `score_calculation_runs.triggering_audit_log_id` column, the narrow `audit_log` INSERT policy for `admin.access_denied`, **replaces Slice 001's `is_admin(uuid)` stub body**, applies the cross-slice test migration, and ships the bootstrap admin seed.

- [X] T003 [P] Migration 0047: `admin_roles` table + RLS + audit trigger (`supabase/migrations/0047_admin_roles.sql`)

**Agent prompt:**

> **Goal**: Create `public.admin_roles` per `data-model.md` § Entity 1 + RLS per § RLS posture summary + audit trigger emitting `admin.role_granted` / `admin.role_revoked` rows.
>
> **Read first**:
> - `specs/006-admin-overrides/data-model.md` § Entity 1 (Admin Role)
> - `specs/006-admin-overrides/research.md` § R-002
> - Slice 001's `participants` table for FK target reference
>
> **Files to create or modify**:
> - `supabase/migrations/0047_admin_roles.sql` (new)
>
> **What to do**:
> 1. `CREATE TABLE public.admin_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE RESTRICT, granted_at timestamptz NOT NULL DEFAULT now(), granted_by uuid NULL REFERENCES participants(id), revoked_at timestamptz NULL, revoked_by uuid NULL REFERENCES participants(id), revoke_reason text NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)));`
> 2. `CREATE UNIQUE INDEX admin_roles_active_uk ON admin_roles(participant_id) WHERE revoked_at IS NULL;`
> 3. Index `admin_roles_participant_idx` on `(participant_id, granted_at DESC)`.
> 4. `BEFORE UPDATE` trigger for `updated_at`.
> 5. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`. Policy `admin_roles_admin_read` SELECT `USING (public.is_admin(auth.uid()))`. Policy `admin_roles_admin_write` INSERT/UPDATE `WITH CHECK (public.is_admin(auth.uid()))`. NO DELETE policy.
> 6. Audit trigger function `log_admin_role_change()` SECURITY DEFINER. On INSERT → `admin.role_granted`; on UPDATE setting `revoked_at` → `admin.role_revoked`. Recursion guard.
> 7. Header comment: `-- Slice 006 / FR-009 / data-model.md § Entity 1 / cross-slice locked: admin_roles is read by is_admin (T007); Slice 008 will ship the assignment UI but cannot alter shape.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - Unique partial index rejects a second active row for same participant.
> - CHECK rejects `revoked_at` set with `revoked_by` NULL.
> - INSERT emits `admin.role_granted` audit row.
>
> **Do NOT**: replace the is_admin body here — T007 does.
>
> **Constitution**: II, V, XI.

**Blocked-by**: T002
**Parallel-safe with**: T004, T005, T006
**Definition of done**: `supabase db reset` succeeds AND the unique partial index + CHECK + audit trigger all enforce correctly.

---

- [X] T004 [P] Migration 0048: `ADD COLUMN audit_log.source_citation` (`supabase/migrations/0048_audit_log_source_citation.sql`)

**Agent prompt:**

> **Goal**: Additive `source_citation text NULL` column on Slice 001's stub `audit_log` table per `data-model.md` § Entity 2.
>
> **Read first**:
> - `specs/006-admin-overrides/data-model.md` § Entity 2 (Admin Override Event)
> - `specs/006-admin-overrides/research.md` § R-004 (audit_log not separate table)
>
> **Files to create or modify**:
> - `supabase/migrations/0048_audit_log_source_citation.sql` (new)
>
> **What to do**:
> 1. `ALTER TABLE public.audit_log ADD COLUMN source_citation text NULL;`
> 2. Header comment: `-- Slice 006 / FR-002 / Clarifications 2026-05-17 Q3 / additive over Slice 001 audit_log stub. Slice 007 hardening MUST preserve this column.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - Existing Slice 001/002/003/004/005 audit_log INSERTs continue working (no validation added).
> - INSERT into audit_log with `source_citation = 'https://...'` succeeds.
>
> **Constitution**: V, XI (additive).

**Blocked-by**: T002
**Parallel-safe with**: T003, T005, T006
**Definition of done**: Column exists; prior audit_log writers unaffected.

---

- [X] T005 [P] Migration 0050: `ADD COLUMN score_calculation_runs.triggering_audit_log_id` (`supabase/migrations/0050_score_calculation_runs_triggering_audit.sql`)

**Agent prompt:**

> **Goal**: Additive `triggering_audit_log_id uuid NULL REFERENCES audit_log(id)` column on Slice 005's `score_calculation_runs` table per `data-model.md` § Entity 3.
>
> **Read first**:
> - `specs/006-admin-overrides/data-model.md` § Entity 3
> - `specs/006-admin-overrides/research.md` § R-013
>
> **Files to create or modify**:
> - `supabase/migrations/0050_score_calculation_runs_triggering_audit.sql` (new)
>
> **What to do**:
> 1. `ALTER TABLE public.score_calculation_runs ADD COLUMN triggering_audit_log_id uuid NULL REFERENCES audit_log(id);`
> 2. Index `score_calculation_runs_triggering_audit_idx` on `(triggering_audit_log_id)`.
> 3. Header comment: `-- Slice 006 / FR-007 / US1.3 / research § R-013 / additive over Slice 005 score_calculation_runs shape. Enables JOIN: affected score_records.run_id → score_calculation_runs.id → triggering_audit_log_id → audit_log.id (the admin override audit row).`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - Slice 005's existing run-creation paths continue working (column is nullable; old code paths leave it NULL).
>
> **Constitution**: V (audit traceability), XI.

**Blocked-by**: T002
**Parallel-safe with**: T003, T004, T006
**Definition of done**: Column + index exist; Slice 005's existing writes unaffected.

---

- [X] T006 [P] Migration 0060: `audit_log` narrow INSERT policy for `admin.access_denied` (`supabase/migrations/0060_audit_log_admin_access_denied_insert_policy.sql`)

**Agent prompt:**

> **Goal**: Grant the `authenticated` role permission to INSERT a single `audit_log` row with `action='admin.access_denied'` and `actor` = caller's participants.id. This is needed so `requireAdmin` can write the audit row from the route handler (running as the user-JWT-bound client).
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-ui.surface.md` § requireAdmin helper
> - Slice 001 + Slice 003 narrow audit-log INSERT policies (mirror pattern)
>
> **Files to create or modify**:
> - `supabase/migrations/0060_audit_log_admin_access_denied_insert_policy.sql` (new)
>
> **What to do**:
> 1. `CREATE POLICY audit_log_admin_access_denied_insert ON public.audit_log FOR INSERT TO authenticated WITH CHECK (action = 'admin.access_denied' AND source = 'api_guard' AND actor = (SELECT id FROM participants WHERE auth_user_id = auth.uid()));`
> 2. Header comment.
>
> **Acceptance criteria**:
> - `psql -c "INSERT INTO audit_log(actor, action, source) VALUES (<self>, 'admin.access_denied', 'api_guard')"` under participant JWT succeeds.
> - `INSERT INTO audit_log(action, source) VALUES ('participant.created', 'trigger')` under participant JWT fails (policy doesn't cover this action).
>
> **Constitution**: II.

**Blocked-by**: T002
**Parallel-safe with**: T003, T004, T005
**Definition of done**: The narrow policy permits only `admin.access_denied / api_guard / actor=self` rows.

---

- [X] T007 Migration 0049: `is_admin(uuid)` real body — replaces Slice 001 stub (`supabase/migrations/0049_is_admin_real_body.sql`)

**Agent prompt:**

> **Goal**: Replace Slice 001's permissive-stub `is_admin(uuid)` with the real body per `contracts/is-admin.predicate.sql.md` § Signature. Signature unchanged; body reads `admin_roles`.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/is-admin.predicate.sql.md` (entire file — byte-for-byte what you implement)
> - Slice 001's `is_admin` stub for the existing signature
>
> **Files to create or modify**:
> - `supabase/migrations/0049_is_admin_real_body.sql` (new)
>
> **What to do**:
> 1. Copy the function body **exactly** from the contract.
> 2. `CREATE OR REPLACE FUNCTION public.is_admin(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$ ... $$;` — same signature, new body.
> 3. Header comment (verbatim): `-- Slice 006 / contracts/is-admin.predicate.sql.md — REPLACES Slice 001 stub body. Signature UNCHANGED (uuid → boolean STABLE). Slices 001-005 consumers (RLS, etc.) continue working. Body now reads admin_roles + participants instead of JWT claim. Cross-slice test migration is T008 (this slice).`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - `SELECT is_admin('00000000-0000-0000-0000-000000000000')` returns `false` (no admin row → not admin).
> - A JWT with `{"role":"admin"}` claim that has NO active admin_roles row gets `is_admin()=false` (proves new behavior).
>
> **Do NOT**: change the signature. Do NOT alter how participants/admin_roles RLS interacts with the function (it uses SECURITY INVOKER).
>
> **Constitution**: II, III, XI (cross-slice locked signature).

**Blocked-by**: T003 (admin_roles must exist)
**Parallel-safe with**: T004, T005, T006 (different files; T007 reads admin_roles created in T003 but doesn't write any of the other tables)
**Definition of done**: Function body replaced; `is_admin()` returns true iff active admin_roles row exists for caller's participant.

---

- [X] T008 Apply cross-slice `is_admin` test migration (modify Slice 002–005 tests to INSERT admin_roles rows alongside JWT claim setup)

**Agent prompt:**

> **Goal**: Update every Slice 002–005 test identified in T002's audit (`is-admin-test-migration.md`) to ALSO insert an `admin_roles` row for any test participant that needs admin authority. The JWT `{"role":"admin"}` claim setup MAY remain (harmless) but the new INSERT is required.
>
> **Read first**:
> - `specs/006-admin-overrides/is-admin-test-migration.md` (T002's output — the affected-test inventory)
>
> **Files to create or modify**:
> - Each test file listed in `is-admin-test-migration.md` (estimated ~10-20 files across pgTAP + Playwright)
>
> **What to do**:
> 1. For each pgTAP test: at the top of the setup block, `INSERT INTO admin_roles (participant_id, granted_at) VALUES ((SELECT id FROM participants WHERE email='admin1@nortal.com'), now()) ON CONFLICT DO NOTHING;`. Same pattern for any other admin test identities.
> 2. For each Playwright test: use the fixture loader to ensure `admin_roles` rows exist for admin test identities before the test asserts admin-only behaviors.
> 3. Verify: re-run the affected tests; assert they still GREEN with the new is_admin body.
>
> **Acceptance criteria**:
> - All Slice 002–005 tests previously identified in T002 now pass with the real `is_admin` body.
> - No prior-slice test asserts admin authority via JWT claim alone — the admin_roles row is the source of truth.
>
> **Do NOT**: weaken assertions; if a test fails because the admin_roles INSERT was insufficient (e.g., the test depends on a non-admin participant having admin claim), file a bug and pause.
>
> **Constitution**: XI (NON-NEGOTIABLE regression preservation across the contract change).

**Blocked-by**: T003, T007
**Parallel-safe with**: _(none — multi-file modification across slices)_
**Definition of done**: All affected Slice 002–005 tests pass with the real is_admin body; T002's inventory marked complete.

---

- [X] T009 Bootstrap admin seed migration (`supabase/migrations/0061_admin_bootstrap.sql`)

**Agent prompt:**

> **Goal**: Seed the first admin per `research.md` § R-002. Operator-configured via `tournament_config.admin.bootstrap_participant_email`.
>
> **Read first**:
> - `specs/006-admin-overrides/research.md` § R-002 (bootstrap mechanism)
>
> **Files to create or modify**:
> - `supabase/migrations/0061_admin_bootstrap.sql` (new)
>
> **What to do**:
> 1. `INSERT INTO public.tournament_config (key, value) VALUES ('admin.bootstrap_participant_email', '"admin1@nortal.com"'::jsonb) ON CONFLICT (key) DO NOTHING;` — default for local dev (Slice 001 fixture's admin participant). Production operator MUST set this to a real Nortal email BEFORE first deploy.
> 2. Conditional INSERT: `INSERT INTO public.admin_roles (participant_id, granted_at, revoke_reason) SELECT p.id, now(), NULL FROM participants p WHERE p.email = (SELECT (value::text) FROM tournament_config WHERE key = 'admin.bootstrap_participant_email')::text::citext ON CONFLICT (participant_id) WHERE revoked_at IS NULL DO NOTHING;` — only inserts if the participant exists (i.e., they've signed in at least once via Slice 001's auth flow).
> 3. Header comment documenting the operator workflow: "Operator sets `admin.bootstrap_participant_email` config; first sign-in of that participant + next migration run grants admin role. Slice 008 admin UI takes over from there."
>
> **Acceptance criteria**:
> - If `admin1@nortal.com` already exists in `participants` (Slice 001 fixture loaded): exactly one admin_roles row created.
> - If `admin1@nortal.com` does not yet exist: migration succeeds; no admin_roles row created (will be picked up later).
> - Re-running migration is safe (`ON CONFLICT DO NOTHING`).
>
> **Constitution**: II, VIII (operator-config-driven).

**Blocked-by**: T003, T007, T008
**Parallel-safe with**: _(none)_
**Definition of done**: After fixture load + this migration, `SELECT count(*) FROM admin_roles WHERE revoked_at IS NULL` returns 1.

---

**Foundational checkpoint**: T001–T009 done. `admin_roles` exists; `is_admin` real body shipped; cross-slice tests migrated; bootstrap admin seeded; additive columns + policies in place. User-story phases can now start.

---

## Phase 3: User Story 1 — Admin manually corrects match score (Priority: P1)

**Story goal**: Admin corrects a provider-supplied match score with reason + source; Slice 005 auto-recalcs (`spec.md` US1).

- [X] T010 [P] [US1] Author pgTAP for `admin_record_match_result` happy + 4 rejection paths (RED) — `supabase/tests/pgtap/admin_record_match_result_*.sql`

**Agent prompt:**

> **Goal**: Author the 5 pgTAP files per `contracts/admin-rpcs.write.md` § Test surface (admin_record_match_result rows).
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` § `admin_record_match_result` + § Test surface
> - `specs/006-admin-overrides/spec.md` § Clarifications 2026-05-17 (Q1 cancelled audit-only)
>
> **Files to create or modify** (5 new):
> - `supabase/tests/pgtap/admin_record_match_result_happy.sql`
> - `supabase/tests/pgtap/admin_record_match_result_not_admin.sql`
> - `supabase/tests/pgtap/admin_record_match_result_missing_reason.sql`
> - `supabase/tests/pgtap/admin_record_match_result_missing_source.sql`
> - `supabase/tests/pgtap/admin_record_match_result_invariant_propagates.sql`
>
> **What to do**:
> 1. `happy.sql`: pre-state M1 with existing match_result 2-1; admin calls SP with new 2-2 + reason + source_citation. Assert match_results row updated; audit_log row `admin.match_result_corrected` exists with source_citation; Slice 005's `match_results_recorded` notification fires.
> 2. `not_admin.sql`: non-admin participant calls SP. Assert EXCEPTION ERRCODE='WAR01'; audit row `admin.access_denied`.
> 3. `missing_reason.sql`: reason='' → WAR02.
> 4. `missing_source.sql`: source_citation='' → WAR03.
> 5. `invariant_propagates.sql`: home_score_for_scoring > home_score_official → underlying Slice 002 SP raises; admin RPC propagates as WAR05.
>
> **Acceptance criteria**: 5 RED pgTAP files.
>
> **Constitution**: IX, II, V.

**Blocked-by**: T009
**Parallel-safe with**: T011
**Definition of done**: 5 RED pgTAP files.

---

- [X] T011 [P] [US1] Author Playwright for /admin dashboard + match correction + non-admin rejection (RED) — `apps/web/tests/playwright/slice-006-*.spec.ts` (~6 files)

**Agent prompt:**

> **Goal**: Author the route-handler + page-level Playwright tests for US1 + US4 entry points per `contracts/admin-ui.surface.md`.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-ui.surface.md` § `/admin/matches/[id]` + § `requireAdmin(client)`
> - `specs/006-admin-overrides/spec.md` § US1 + § US4 (the auth-rejection paths are critical at every admin entry)
>
> **Files to create or modify** (6 new):
> - `slice-006-admin-dashboard-eligible-admin.spec.ts`
> - `slice-006-admin-match-correct-score-happy.spec.ts`
> - `slice-006-admin-match-correct-score-missing-reason.spec.ts`
> - `slice-006-non-admin-rejected-ui.spec.ts`
> - `slice-006-non-admin-rejected-api.spec.ts`
> - `slice-006-admin-role-revoked-mid-session.spec.ts`
>
> **What to do** per each file:
> 1. Dashboard: sign in as admin1; visit `/admin`; assert layout sections render.
> 2. Match correction happy: visit `/admin/matches/M1`; fill form (score, reason, source); submit; assert 200 + audit row + match_results updated.
> 3. Missing reason: empty reason; submit → 400 with field-level error.
> 4. Non-admin UI: sign in as alpha (not admin); visit `/admin` → redirect to `/admin/denied`; assert audit row `admin.access_denied`.
> 5. Non-admin API: as alpha, `curl POST /api/admin/match-results` → 403 with audit row.
> 6. Revoked mid-session: as admin1, navigate to /admin (auth OK); in side session psql `UPDATE admin_roles SET revoked_at=now()...`; refresh page; assert redirect to `/admin/denied`.
>
> **Acceptance criteria**: 6 RED Playwright tests.
>
> **Constitution**: IX, II.

**Blocked-by**: T009
**Parallel-safe with**: T010
**Definition of done**: 6 RED Playwright tests.

---

- [X] T012 [US1] Verify all US1 RED tests RED — `specs/006-admin-overrides/red-gate-us1.md`

**Agent prompt:**

> **Goal**: Principle IX gate. Run T010 + T011; confirm RED.
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/red-gate-us1.md` (new)
>
> **Acceptance criteria**: All 11 tests RED.
>
> **Constitution**: IX (gate).

**Blocked-by**: T010, T011
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us1.md` lists every US1 test as RED.

---

- [X] T013 [US1] Migration 0051: `admin_record_match_result` SP (`supabase/migrations/0051_admin_record_match_result.sql`)

**Agent prompt:**

> **Goal**: Implement `admin_record_match_result` per `contracts/admin-rpcs.write.md` § `admin_record_match_result` — admin RPC wrapping Slice 002's `record_match_result` SP with reason/source validation + audit emission.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` § `admin_record_match_result` (byte-for-byte semantics)
> - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` § Shared concerns (pre-flight steps + ERRCODE map)
> - The pgTAP files from T010 (assertions you must satisfy)
>
> **Files to create or modify**:
> - `supabase/migrations/0051_admin_record_match_result.sql` (new)
>
> **What to do**:
> 1. Function signature exactly per contract: `admin_record_match_result(p_match_id uuid, p_home_score_official int, p_away_score_official int, p_home_score_for_scoring int, p_away_score_for_scoring int, p_result_status text, p_reason text, p_source_citation text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp`.
> 2. Body per contract:
>    a. `IF NOT public.is_admin(auth.uid()) THEN audit + RAISE WAR01; END IF;`
>    b. Validate `length(trim(p_reason)) > 0` → else audit + RAISE WAR02.
>    c. Validate `length(trim(p_source_citation)) > 0` → else audit + RAISE WAR03.
>    d. `v_admin_id := (SELECT id FROM participants WHERE auth_user_id = auth.uid())`.
>    e. `pg_advisory_xact_lock(hashtext('admin_match_result:' || p_match_id::text))`.
>    f. Capture `v_old := (SELECT row_to_json(t) FROM match_results t WHERE match_id = p_match_id)` (NULL if no prior).
>    g. Delegate to Slice 002's `record_match_result(p_match_id, p_home_score_official, p_away_score_official, p_home_score_for_scoring, p_away_score_for_scoring, p_result_status, 'admin_correction', v_admin_id)`. On SP exception (e.g., ERRCODE for invariant violation): propagate as WAR05 with original ERRCODE in MESSAGE.
>    h. Emit `audit_log` row `action='admin.match_result_corrected'`, `entity_type='match_result'`, `entity_id=p_match_id`, `previous_value=v_old::jsonb`, `new_value=<new match_results row>::jsonb`, `reason=p_reason`, `source_citation=p_source_citation`, `source='admin_rpc'`, `actor=v_admin_id`. Capture the audit row's `id` for potential reference by callers.
>    i. RETURN `p_match_id`.
> 3. Note: Slice 005's `match_results_recorded` NOTIFY fires from `record_match_result` automatically — no explicit recalc trigger here.
> 4. Header comment: `-- Slice 006 / FR-001 / US1 / contracts/admin-rpcs.write.md — LOCKED CROSS-SLICE SP signature. Slice 005's score-trigger handles auto-recalc via match_results_recorded LISTEN.`
>
> **Acceptance criteria**:
> - All 5 pgTAP files from T010 GREEN.
> - Slice 005's score-trigger fires automatically after the admin RPC succeeds (verifiable via `psql -c "SELECT count(*) FROM score_calculation_runs WHERE trigger='match_finish'"` after RPC).
>
> **Do NOT**: implement other admin RPCs here (T021 / T030 / T040 own those). Do NOT bypass the underlying SP.
>
> **Constitution**: II, III, V, XI.

**Blocked-by**: T012
**Parallel-safe with**: T014, T015 (different files)
**Definition of done**: All 5 admin_record_match_result pgTAP files GREEN.

---

- [X] T014 [P] [US1] Implement `requireAdmin` helper + admin libs (`apps/web/lib/auth/requireAdmin.ts` + `apps/web/lib/admin/{rpcs,types,audit,recalc}.ts`)

**Agent prompt:**

> **Goal**: Create the TypeScript scaffolding for the admin surface.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-ui.surface.md` § `requireAdmin(client)` helper
> - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` § Pre-flight steps + ERRCODE map
> - Slice 001's `requireEligible.ts` (canonical pattern)
>
> **Files to create or modify**:
> - `apps/web/lib/auth/requireAdmin.ts` (new) — composes `requireEligible` + `is_admin` RPC + audit on denial
> - `apps/web/lib/admin/types.ts` (new) — `AdminAction`, `AdminAuditRow`, `AdminRPCResponse`, etc.
> - `apps/web/lib/admin/rpcs.ts` (new) — typed wrappers around each admin_* RPC + ERRCODE → HTTP mapping
> - `apps/web/lib/admin/audit.ts` (new) — `getAdminAuditLog`, `getAuditDetail`, `getAuditByTarget` client helpers
> - `apps/web/lib/admin/recalc.ts` (new) — `triggerRecalc` + Realtime subscription helper
>
> **What to do**:
> 1. `requireAdmin`: per the contract — call `requireEligible(client)` first, then `client.rpc('is_admin', { p_uid: ... })`; if false, write the audit row + throw `AdminAccessDeniedError`. Return the admin's participant on success.
> 2. `rpcs.ts`: one typed function per admin RPC; consistent ERRCODE → HTTP code mapping.
> 3. `audit.ts`: thin wrappers over `/api/admin/audit*` endpoints.
> 4. `recalc.ts`: `triggerRecalc(scope, reason)` + `subscribeRecalcStatus(runId, onUpdate)` for Realtime.
>
> **Acceptance criteria**:
> - `pnpm -F web typecheck` GREEN.
> - `requireAdmin` correctly denies non-admin participants (verifiable via unit test if you add one).
>
> **Constitution**: II, III.

**Blocked-by**: T012
**Parallel-safe with**: T013
**Definition of done**: All five lib files exist; typecheck GREEN.

---

- [X] T015 [US1] Implement route handlers: POST `/api/admin/match-results` + POST `/api/admin/matches/[id]` + admin layout + denied page

**Agent prompt:**

> **Goal**: Create the route handler for admin match-result corrections and admin status/kickoff updates; create the `/admin` layout (gates all admin routes via `requireAdmin`); create the `/admin/denied` page.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-ui.surface.md` § route definitions
> - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` § ERRCODE → HTTP mapping
>
> **Files to create or modify**:
> - `apps/web/app/admin/layout.tsx` (new) — gates via `requireAdmin`; redirects to `/admin/denied` on denial
> - `apps/web/app/admin/denied/page.tsx` (new) — static denial screen
> - `apps/web/app/api/admin/match-results/route.ts` (new) — POST handler
> - `apps/web/app/api/admin/matches/[id]/route.ts` (new) — POST handler for admin_update_match (US3 territory; can stub here, wire fully in T030)
>
> **What to do**:
> 1. `layout.tsx`: server component; `await requireAdmin(client)`; render `<div className="admin-shell">{children}</div>`.
> 2. `denied/page.tsx`: static "You don't have administrator access for this application." No detail leakage.
> 3. `/api/admin/match-results/route.ts`: parse session → 401 if missing; `await requireAdmin(client)` → 403 on denial; zod validate body `{match_id, home_score_official, away_score_official, home_score_for_scoring, away_score_for_scoring, result_status, reason, source_citation}`; `client.rpc('admin_record_match_result', {...})`; map WAR01-06 ERRCODEs to HTTP; return 200 with response shape.
> 4. `/api/admin/matches/[id]/route.ts`: stub for now (full implementation in T030); for US1 just enable the basic shape so the route doesn't 404.
>
> **Acceptance criteria**:
> - `slice-006-non-admin-rejected-api.spec.ts` GREEN (route guards work).
> - `slice-006-admin-match-correct-score-happy.spec.ts` GREEN (when paired with T013's SP).
> - `slice-006-admin-match-correct-score-missing-reason.spec.ts` GREEN.
>
> **Constitution**: II, III.

**Blocked-by**: T013, T014
**Parallel-safe with**: T016
**Definition of done**: 3 US1 Playwright tests GREEN; non-admin tests GREEN.

---

- [X] T016 [US1] Implement /admin dashboard + /admin/matches/[id] page

**Agent prompt:**

> **Goal**: Build the admin dashboard (per `contracts/admin-ui.surface.md` § /admin layout) and the match-detail page with the correction form.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-ui.surface.md` § /admin dashboard + § /admin/matches/[id]
> - `apps/web/lib/admin/rpcs.ts` + `audit.ts` from T014
>
> **Files to create or modify**:
> - `apps/web/app/admin/page.tsx` (new) — dashboard server component
> - `apps/web/app/admin/matches/[id]/page.tsx` (new) — match detail with correction form
> - `apps/web/app/admin/matches/[id]/components/MatchCorrectionForm.tsx` (new) — client component
>
> **What to do**:
> 1. Dashboard: fetch `pending_review_count`, `recent_overrides`, `last_recalc`, `pending_recalc_state`, `current_admin_count`. Render the 4-quadrant grid per contract.
> 2. Match detail: fetch match details + match_results + audit_log filtered to this match. Render correction form + status update + "View Predictions" link.
> 3. Form: home/away score inputs, reason (multiline), source_citation (URL input), Submit. On submit: `submitMatchCorrection(...)` from lib; on success: refresh; on error: inline message.
> 4. Accessibility: form labels, keyboard nav, aria-live error region.
>
> **Acceptance criteria**:
> - `slice-006-admin-dashboard-eligible-admin.spec.ts` GREEN.
> - All 3 US1 match-correction Playwright tests GREEN.
> - `pnpm -F web build` GREEN.
>
> **Constitution**: III.

**Blocked-by**: T015
**Parallel-safe with**: _(none — page + form components are bundled)_
**Definition of done**: Dashboard + match-detail render with all expected sections; US1 Playwright tests all GREEN.

---

- [X] T017 [US1] Regression checkpoint after US1 — `specs/006-admin-overrides/regression-checkpoint-us1.md`

**Agent prompt:**

> **Goal**: Run all prior + US1 tests; confirm GREEN.
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/regression-checkpoint-us1.md` (new)
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T016
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us1.md` shows everything GREEN.

---

**US1 CHECKPOINT**: Admin manual score correction works end-to-end. Slice demonstrable.

---

## Phase 4: User Story 2 — Full recalc trigger + idempotency + resumability (Priority: P1)

**Story goal**: Admin (or scheduled process) triggers a full recalculation; idempotent + resumable (`spec.md` US2). **Per Clarifications 2026-05-17 Q2, resumability uses Edge Function self-scan + slow pg_cron backup.**

- [X] T018 [P] [US2] Author pgTAP for recalc + pending_recalc_state + reaper (RED) — 5 files

**Agent prompt:**

> **Goal**: Author pgTAP per `contracts/admin-rpcs.write.md` § `admin_trigger_recalc` + `data-model.md` § Pending Recalc State VIEW + § Reaper function.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` § `admin_trigger_recalc` (Test surface rows)
> - `specs/006-admin-overrides/spec.md` § Clarifications 2026-05-17 Q2 (Edge Function self-scan + slow cron)
> - `specs/006-admin-overrides/data-model.md` § Pending Recalc State VIEW
>
> **Files to create or modify** (5 new):
> - `supabase/tests/pgtap/admin_trigger_recalc_scope_all.sql`
> - `supabase/tests/pgtap/admin_trigger_recalc_concurrent.sql`
> - `supabase/tests/pgtap/admin_trigger_recalc_audit_links_run.sql`
> - `supabase/tests/pgtap/reap_stale_recalc_runs.sql`
> - `supabase/tests/pgtap/pending_recalc_state_view.sql`
>
> **What to do**:
> 1. `scope_all.sql`: admin calls SP with scope='all'; assert run_id returned; score_calculation_runs row INSERTed; pg_net captured POST to Slice 005's score-trigger.
> 2. `concurrent.sql`: hold `pg_advisory_lock(hashtext('scoring'), ...)` in side connection; admin calls SP; assert WAR06.
> 3. `audit_links_run.sql`: admin calls SP; assert `score_calculation_runs.triggering_audit_log_id` points at the `admin.recalc_triggered` audit row.
> 4. `reap_stale_recalc_runs.sql`: setup a "stale running" row (started_at = now() - 2 min, status='running'); call `reap_stale_recalc_runs()`; assert it re-POSTs via pg_net; the function returns 1 (one row reaped).
> 5. `pending_recalc_state_view.sql`: setup scoring config change after last successful recalc; SELECT FROM pending_recalc_state; assert `recalc_pending = true`. Then run a recalc; assert `recalc_pending = false`.
>
> **Acceptance criteria**: 5 RED pgTAP files.
>
> **Constitution**: IX, VII.

**Blocked-by**: T017
**Parallel-safe with**: T019
**Definition of done**: 5 RED pgTAP files.

---

- [X] T019 [P] [US2] Author Playwright for recalc UI + Realtime status + interrupt-resume (RED) — 4 files

**Agent prompt:**

> **Goal**: Per `contracts/admin-ui.surface.md` § /admin/recalc + Test surface rows.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-ui.surface.md` § /admin/recalc
> - `specs/006-admin-overrides/spec.md` § US2 + § SC-007
>
> **Files to create or modify** (4 new):
> - `slice-006-admin-recalc-full-happy.spec.ts`
> - `slice-006-admin-recalc-concurrent-blocked.spec.ts`
> - `slice-006-admin-recalc-resumes-after-interrupt.spec.ts`
> - `slice-006-recalc-pending-banner.spec.ts`
>
> **What to do**:
> 1. `recalc-full-happy.spec.ts`: admin clicks "Trigger Full Recalc" on `/admin/recalc`; status transitions `running → succeeded` visible via Realtime; total time < 5 minutes for fixture.
> 2. `concurrent-blocked.spec.ts`: trigger one; before it completes trigger another → 409 inline error.
> 3. `resumes-after-interrupt.spec.ts`: trigger; kill Edge Function process; restart; assert next Edge Function invocation runs the self-scan (per Clarifications Q2) and the run resumes within 10 seconds of restart.
> 4. `recalc-pending-banner.spec.ts`: mutate `tournament_config.match_points.exact`; refresh `/admin`; assert banner appears; click trigger; banner disappears after completion.
>
> **Acceptance criteria**: 4 RED Playwright tests.
>
> **Constitution**: IX, VII (resumability per Clarifications Q2).

**Blocked-by**: T017
**Parallel-safe with**: T018
**Definition of done**: 4 RED Playwright tests.

---

- [X] T020 [US2] Verify all US2 RED tests RED — `specs/006-admin-overrides/red-gate-us2.md`

**Agent prompt:**

> **Goal**: Principle IX gate. Run T018 + T019.
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/red-gate-us2.md` (new)
>
> **Acceptance criteria**: All 9 tests RED.
>
> **Constitution**: IX.

**Blocked-by**: T018, T019
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us2.md` lists every US2 test as RED.

---

- [X] T021 [US2] Migration 0057: `admin_trigger_recalc` SP (`supabase/migrations/0057_admin_trigger_recalc.sql`)

**Agent prompt:**

> **Goal**: Per `contracts/admin-rpcs.write.md` § `admin_trigger_recalc`. Two-step audit + run insert (audit FIRST so `triggering_audit_log_id` references it), then `pg_net.http_post` to Slice 005's score-trigger.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` § `admin_trigger_recalc`
> - `specs/006-admin-overrides/research.md` § R-005, R-006, R-013
>
> **Files to create or modify**:
> - `supabase/migrations/0057_admin_trigger_recalc.sql` (new)
>
> **What to do**:
> 1. Function signature per contract.
> 2. Body: admin pre-check (WAR01); reason validation (WAR02; source_citation is OPTIONAL per contract). Generate `v_run_id := gen_random_uuid()`. INSERT audit_log row `action='admin.recalc_triggered'`, `entity_type='score_calculation_run'`, `entity_id=v_run_id`, `reason=p_reason`, `source_citation=p_source_citation`. Capture `v_audit_id := <inserted id>`. INSERT score_calculation_runs row `(id=v_run_id, scope=p_scope, target_id=p_target_id, trigger='admin_recalc', triggered_by=v_admin_id, status='running', started_at=now(), triggering_audit_log_id=v_audit_id)`. Call `pg_net.http_post(url := current_setting('app.score_trigger_url'), headers := jsonb_build_object('X-Internal-Auth', current_setting('app.score_trigger_secret')), body := jsonb_build_object('scope', p_scope, 'target_id', p_target_id, 'trigger', 'admin_recalc', 'run_id', v_run_id, 'reason', p_reason, 'triggered_by', v_admin_id))`. RETURN v_run_id.
> 3. Handle 409 from score-trigger (advisory lock contention) → WAR06.
> 4. Header comment.
>
> **Acceptance criteria**:
> - 3 admin_trigger_recalc pgTAP files GREEN.
>
> **Constitution**: III, V, VII.

**Blocked-by**: T020
**Parallel-safe with**: T022, T023, T024
**Definition of done**: 3 admin_trigger_recalc pgTAP files GREEN.

---

- [X] T022 [P] [US2] Migration 0058: `pending_recalc_state` VIEW (`supabase/migrations/0058_pending_recalc_state_view.sql`)

**Agent prompt:**

> **Goal**: Per `data-model.md` § Pending Recalc State VIEW.
>
> **Read first**:
> - `specs/006-admin-overrides/data-model.md` § Pending Recalc State (VIEW; not a table)
> - `specs/006-admin-overrides/research.md` § R-012
>
> **Files to create or modify**:
> - `supabase/migrations/0058_pending_recalc_state_view.sql` (new)
>
> **What to do**:
> 1. CREATE OR REPLACE VIEW per the contract — computes `recalc_pending` and supporting fields from `audit_log` + `score_calculation_runs`.
> 2. Header comment documenting the cross-slice expectation: Slice 008's tournament_config audit MUST emit `action='tournament_config.scoring.<key>'` for the view's LIKE filter to match.
>
> **Acceptance criteria**:
> - `pending_recalc_state_view.sql` pgTAP file (from T018) GREEN.
>
> **Constitution**: III, VIII.

**Blocked-by**: T020
**Parallel-safe with**: T021, T023, T024
**Definition of done**: View exists; pgTAP test GREEN.

---

- [X] T023 [P] [US2] Migration 0059: `reap_stale_recalc_runs()` + pg_cron at 5-minute cadence (per Clarifications Q2) (`supabase/migrations/0059_reap_stale_recalc_runs.sql`)

**Agent prompt:**

> **Goal**: Per `data-model.md` § Reaper function + spec Clarifications 2026-05-17 Q2 (5-minute cadence — slow backup; primary resume is Edge Function self-scan in T024).
>
> **Read first**:
> - `specs/006-admin-overrides/data-model.md` § Reaper function
> - `specs/006-admin-overrides/spec.md` § Clarifications 2026-05-17 Q2 (locked mechanism)
> - `specs/006-admin-overrides/research.md` § R-007 (updated per clarifications)
>
> **Files to create or modify**:
> - `supabase/migrations/0059_reap_stale_recalc_runs.sql` (new)
>
> **What to do**:
> 1. `CREATE OR REPLACE FUNCTION public.reap_stale_recalc_runs() RETURNS int LANGUAGE plpgsql SECURITY DEFINER ... AS $$ ... $$;` per contract.
> 2. `SELECT cron.schedule('reap-stale-recalcs', '*/5 * * * *', 'SELECT public.reap_stale_recalc_runs();');` — **5-minute cadence** per Clarifications Q2 (slow backup; primary resume is Edge Function self-scan).
> 3. Header comment (verbatim): `-- Slice 006 / SC-007 / Clarifications 2026-05-17 Q2 — SLOW BACKUP REAPER (5-min cadence). Primary resume mechanism is the score-trigger Edge Function's self-scan at startup (T024). This reaper handles the case where no Edge Function invocation happens for >5 minutes after an interrupt.`
>
> **Acceptance criteria**:
> - `reap_stale_recalc_runs.sql` pgTAP file (from T018) GREEN.
> - `SELECT * FROM cron.job WHERE jobname = 'reap-stale-recalcs'` returns one row with the 5-min schedule.
>
> **Constitution**: VII.

**Blocked-by**: T020
**Parallel-safe with**: T021, T022, T024
**Definition of done**: Reaper + 5-min cron schedule exist; pgTAP test GREEN.

---

- [X] T024 [P] [US2] Modify Slice 005 `score-trigger` Edge Function to add self-scan at startup (per Clarifications 2026-05-17 Q2)

**Agent prompt:**

> **Goal**: The PRIMARY resume mechanism per Clarifications Q2. Modify Slice 005's `score-trigger/index.ts` so every invocation, BEFORE processing its incoming request, first checks for stale `score_calculation_runs` and re-invokes itself for each. This achieves the SC-007 "within 10 seconds of restart" target.
>
> **Read first**:
> - `specs/006-admin-overrides/spec.md` § Clarifications 2026-05-17 Q2 (the locked mechanism)
> - `specs/006-admin-overrides/research.md` § R-007 (post-clarification)
> - Slice 005's `supabase/functions/score-trigger/index.ts` (the file to modify)
>
> **Files to create or modify**:
> - `supabase/functions/score-trigger/index.ts` (modify — add self-scan as first step)
> - `supabase/functions/score-trigger/tests/self_scan_resumes_stale.test.ts` (new Deno test)
>
> **What to do**:
> 1. At the very top of the Edge Function handler (after auth parse but before any other work):
>    ```typescript
>    const staleRuns = await supabase.from('score_calculation_runs')
>      .select('id, scope, target_id')
>      .eq('status', 'running')
>      .lt('started_at', new Date(Date.now() - 60_000).toISOString());
>    for (const run of staleRuns.data ?? []) {
>      // Fire-and-forget re-invoke via pg_net (don't block the original request)
>      await fetch(SCORE_TRIGGER_URL, {
>        method: 'POST',
>        headers: { 'X-Internal-Auth': INTERNAL_SECRET, 'Content-Type': 'application/json' },
>        body: JSON.stringify({ scope: run.scope, target_id: run.target_id, trigger: 'self_scan_resume', run_id: run.id })
>      }).catch(() => {});
>    }
>    ```
> 2. Write `audit_log` row `action='score_trigger.self_scan_resumed_runs'` with the list of resumed run_ids.
> 3. New Deno test: pre-state has a 2-minute-old `status='running'` row; POST any new request to the function; assert the Edge Function POSTs back to itself for the stale run.
> 4. Do NOT modify Slice 005's existing test suite — augment by adding the new test.
>
> **Acceptance criteria**:
> - The new Deno test GREEN.
> - Slice 005's existing Deno tests STILL GREEN (no regression in the score-trigger's normal request handling).
> - The Playwright `slice-006-admin-recalc-resumes-after-interrupt.spec.ts` GREEN (the primary SC-007 surface).
>
> **Do NOT**: change Slice 005's locked Edge Function CONTRACT (the request/response shape stays the same). This is an additive behavior at the top of the handler.
>
> **Constitution**: VII (SC-007 primary mechanism), XI (additive over Slice 005).

**Blocked-by**: T020
**Parallel-safe with**: T021, T022, T023
**Definition of done**: Slice 005's score-trigger function self-scans at startup; new Deno test GREEN; SC-007 Playwright test GREEN.

---

- [X] T025 [US2] Implement /api/admin/recalc + /admin/recalc page with Realtime subscription

**Agent prompt:**

> **Goal**: The recalc trigger endpoint + UI per `contracts/admin-ui.surface.md` § /admin/recalc.
>
> **Read first**:
> - `specs/006-admin-overrides/contracts/admin-ui.surface.md` § /admin/recalc
> - `apps/web/lib/admin/recalc.ts` from T014 (Realtime subscription helper)
>
> **Files to create or modify**:
> - `apps/web/app/api/admin/recalc/route.ts` (new) — POST handler
> - `apps/web/app/admin/recalc/page.tsx` (new) — server component
> - `apps/web/app/admin/recalc/components/RecalcStatusLive.tsx` (new) — client component with Realtime subscription
>
> **What to do**:
> 1. Route handler: zod-validate `{scope, target_id?, reason}`; requireAdmin; `client.rpc('admin_trigger_recalc', {...})`; map WAR06 → 409; return `{run_id}`.
> 2. Page: SSR fetch last 10 runs + `pending_recalc_state`. Render trigger button + live status component.
> 3. Live component: on mount, `subscribeRecalcStatus(runId, ...)` from lib; render status transitions.
> 4. Dashboard `/admin` ALSO uses the `RecalcPendingBanner` when `pending_recalc_state.recalc_pending = true`.
>
> **Acceptance criteria**:
> - All 4 US2 Playwright tests GREEN.
>
> **Constitution**: III.

**Blocked-by**: T021, T022, T023, T024
**Parallel-safe with**: _(none)_
**Definition of done**: 4 US2 Playwright tests GREEN; `/admin/recalc` works end-to-end including Realtime live status.

---

- [X] T026 [US2] Regression checkpoint after US2 — `specs/006-admin-overrides/regression-checkpoint-us2.md`

**Agent prompt:**

> **Goal**: Run all prior + US1 + US2 tests; confirm GREEN.
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/regression-checkpoint-us2.md` (new)
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T025
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us2.md` shows everything GREEN.

---

## Phase 5: User Story 3 — Final tournament award correction (Priority: P1)

**Story goal**: Admin corrects a tournament award (champion, runner_up, top_scorer, best_player); Slice 005's score-trigger fires for finals scope (`spec.md` US3).

- [X] T027 [P] [US3] Author pgTAP for admin_update_tournament_award + admin_update_match (RED) — 3 files

**Agent prompt:**

> **Goal**: Per `contracts/admin-rpcs.write.md` § Test surface (admin_update_tournament_award + admin_update_match rows).
>
> **Files to create or modify** (3 new):
> - `supabase/tests/pgtap/admin_update_tournament_award_happy.sql`
> - `supabase/tests/pgtap/admin_update_match_happy.sql`
> - `supabase/tests/pgtap/admin_update_match_kickoff_fans_out.sql`
>
> **What to do**:
> 1. `update_tournament_award_happy.sql`: admin updates top_scorer with reason + source; assert tournament_award row updated; assert Slice 005's award_confirmed trigger fires `score-trigger` for `scope='finals'`.
> 2. `update_match_happy.sql`: admin updates match status from 'scheduled' to 'postponed'; assert matches row updated; assert Slice 002's audit trigger fires AND Slice 003's kickoff-correction-crossed-lock fan-out fires (since kickoff is unchanged but status changed — actually only Slice 002's audit fires; Slice 003's trigger fires only on kickoff change. Verify this nuance in the test).
> 3. `update_match_kickoff_fans_out.sql`: admin updates kickoff_utc; assert Slice 003's kickoff-correction trigger fires per active prediction; assert Slice 004's first_kickoff_correction trigger fires per active final_prediction (since first_kickoff_utc derives from min(matches.kickoff_utc) if Slice 002 sync re-runs; the trigger fan-out captures the change).
>
> **Acceptance criteria**: 3 RED pgTAP files.
>
> **Constitution**: IX.

**Blocked-by**: T026
**Parallel-safe with**: T028
**Definition of done**: 3 RED pgTAP files.

---

- [X] T028 [P] [US3] Author Playwright for /admin/finals + match update (RED) — 3 files

**Agent prompt:**

> **Goal**: Per `contracts/admin-ui.surface.md` § /admin/finals + Test surface.
>
> **Files to create or modify** (3 new):
> - `slice-006-admin-finals-correct-top-scorer.spec.ts`
> - `slice-006-admin-finals-confirm-pending.spec.ts`
> - `slice-006-admin-match-update-status-postponed.spec.ts`
>
> **What to do**:
> 1. Correct top_scorer; assert Slice 005 `scope='finals'` recalc fires.
> 2. Flip best_player status from 'pending' to 'confirmed'; assert recalc fires.
> 3. Update match status to 'postponed'; assert audit row written; assert Slice 005's `score_match` will skip this match (since status changed away from 'finished').
>
> **Acceptance criteria**: 3 RED Playwright tests.
>
> **Constitution**: IX.

**Blocked-by**: T026
**Parallel-safe with**: T027
**Definition of done**: 3 RED Playwright tests.

---

- [X] T029 [US3] Verify all US3 RED tests RED — `specs/006-admin-overrides/red-gate-us3.md`

**Agent prompt:**

> **Goal**: Principle IX gate.
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/red-gate-us3.md` (new)
>
> **Acceptance criteria**: All 6 tests RED.
>
> **Constitution**: IX.

**Blocked-by**: T027, T028
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us3.md` lists every US3 test as RED.

---

- [X] T030 [US3] Migration 0052 + 0055: `admin_update_match` + `admin_update_tournament_award` SPs — On-disk slots 0065 + 0068 per D-026.


**Agent prompt:**

> **Goal**: Per `contracts/admin-rpcs.write.md` § `admin_update_match` + § `admin_update_tournament_award`.
>
> **Files to create or modify**:
> - `supabase/migrations/0052_admin_update_match.sql` (new)
> - `supabase/migrations/0055_admin_update_tournament_award.sql` (new)
>
> **What to do** per each SP — follow shared pre-flight + the SP-specific body per contract.
>
> **Acceptance criteria**: All 3 US3 pgTAP files GREEN.
>
> **Constitution**: II, III, V, VI.

**Blocked-by**: T029
**Parallel-safe with**: T031
**Definition of done**: 3 US3 pgTAP files GREEN.

---

- [X] T031 [US3] Implement /api/admin/tournament-award + /admin/finals page + /admin/matches/[id] status update affordance

**Agent prompt:**

> **Goal**: Per `contracts/admin-ui.surface.md` § /admin/finals + match-detail update affordance.
>
> **Files to create or modify**:
> - `apps/web/app/api/admin/tournament-award/route.ts` (new) — POST handler
> - `apps/web/app/admin/finals/page.tsx` (new) — server component
> - `apps/web/app/admin/finals/components/AwardCorrectionForm.tsx` (new) — client component
> - `apps/web/app/admin/matches/[id]/components/MatchUpdateForm.tsx` (new) — client component (status + kickoff)
> - `apps/web/app/api/admin/matches/[id]/route.ts` (modify from T015 stub — full implementation now)
>
> **Acceptance criteria**: All 3 US3 Playwright tests GREEN.
>
> **Constitution**: III.

**Blocked-by**: T030
**Parallel-safe with**: _(none)_
**Definition of done**: 3 US3 Playwright tests GREEN.

---

- [X] T032 [US3] Regression checkpoint after US3 — `specs/006-admin-overrides/regression-checkpoint-us3.md`

**Agent prompt:**

> **Goal**: Same shape as T017 / T026.
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/regression-checkpoint-us3.md` (new)
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T031
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us3.md` shows everything GREEN.

---

## Phase 6: User Story 4 — Unauthorized access rejected (Priority: P1)

**Story goal**: Non-admins blocked at UI + API (`spec.md` US4 / SC-005). Note: foundational coverage already exists via T011 (non-admin-rejected specs) + T015's requireAdmin gate. This phase adds the comprehensive `is_admin` boundary tests + denial-page polish.

- [X] T033 [P] [US4] Author pgTAP for `is_admin` real body (RED) — 9 files

**Agent prompt:**

> **Goal**: Per `contracts/is-admin.predicate.sql.md` § Test surface (9 files). These should be RED until T007 is verified (most should be GREEN by the time we run them — T007 already shipped). This phase confirms the real body's correctness.
>
> **Files to create or modify** (9 new):
> - `is_admin_active_grant.sql`, `is_admin_revoked_grant.sql`, `is_admin_no_grant.sql`, `is_admin_deactivated_participant.sql`, `is_admin_unknown_uid.sql`, `is_admin_null_uid.sql`, `is_admin_revoke_then_regrant.sql`, `is_admin_uses_db_state_not_jwt.sql`, `is_admin_perf.sql`
>
> **What to do**: Per the contract's Test surface table — one file per row.
>
> **Acceptance criteria**: 9 files exist. Most likely GREEN immediately (T007 implemented the body); document status in T035's red-gate.
>
> **Constitution**: IX.

**Blocked-by**: T032
**Parallel-safe with**: T034
**Definition of done**: 9 pgTAP files exist.

---

- [X] T034 [P] [US4] Author Playwright for is_admin behavior + denial page (RED) — 2 files

**Agent prompt:**

> **Goal**: Per `spec.md` § US4 Acceptance Scenarios.
>
> **Files to create or modify** (2 new):
> - `slice-006-is-admin-uses-db-state-not-jwt.spec.ts` — synthesize JWT with `{"role":"admin"}` but no `admin_roles` row; assert 403 (proves new body)
> - `slice-006-admin-denied-page-no-leak.spec.ts` — visit `/admin/denied?reason=anything`; assert generic denial message; no admin info leakage
>
> **Acceptance criteria**: 2 RED Playwright tests.
>
> **Constitution**: IX, II.

**Blocked-by**: T032
**Parallel-safe with**: T033
**Definition of done**: 2 RED Playwright tests.

---

- [X] T035 [US4] Red-gate + verify pass after T007/T015 already shipped is_admin and denied page — `specs/006-admin-overrides/red-gate-us4.md`

**Agent prompt:**

> **Goal**: Most US4 tests should GREEN immediately given T007/T011/T015 already shipped the gate. This task documents the status (note: many tests will already pass; that's expected since the implementation came first by necessity — the gate from T011 needed something to deny against, and T007 ships the real predicate).
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/red-gate-us4.md` (new)
>
> **Acceptance criteria**: All US4 tests status documented; any actually-RED tests get T036 to GREEN them.
>
> **Constitution**: IX.

**Blocked-by**: T033, T034
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us4.md` exists.

---

- [X] T036 [US4] Fix any boundary edge cases → all US4 tests GREEN — Patched is_admin body to filter on participants.status='active'. D-028 candidate logged.

**Agent prompt:**

> **Goal**: Address any RED test from T035. Likely fixes: `/admin/denied` page polish, audit row format adjustments.
>
> **Files to create or modify**: TBD based on T035's RED inventory.
>
> **Acceptance criteria**: All 11 US4 tests GREEN.
>
> **Constitution**: IX, XI.

**Blocked-by**: T035
**Parallel-safe with**: _(none)_
**Definition of done**: All US4 tests GREEN.

---

- [X] T037 [US4] Regression checkpoint after US4 — `specs/006-admin-overrides/regression-checkpoint-us4.md`

**Agent prompt:**

> **Goal**: Run all tests.
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/regression-checkpoint-us4.md` (new)
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T036
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us4.md` shows everything GREEN.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T038 [P] Implement remaining admin RPCs: `admin_submit_prediction` + `admin_submit_final_prediction` + 2 bypass-lock sibling SPs + `admin_resolve_match_pending_review` — Migrations 0053, 0054, 0056

**Agent prompt:**

> **Goal**: Per `contracts/admin-rpcs.write.md` § `admin_submit_prediction` + `admin_submit_final_prediction` + § `admin_resolve_match_pending_review`. Includes bypass-lock siblings.
>
> **Files to create or modify**:
> - `supabase/migrations/0053_admin_submit_prediction.sql` (new — wraps Slice 003 SP; bypass-lock sibling SP)
> - `supabase/migrations/0054_admin_submit_final_prediction.sql` (new — wraps Slice 004 SP; bypass-lock sibling SP)
> - `supabase/migrations/0056_admin_resolve_match_pending_review.sql` (new)
> - Corresponding pgTAP test files (`admin_submit_prediction_*.sql`, `admin_submit_final_prediction_*.sql`, `admin_resolve_match_pending_review_*.sql` — ~7 files)
>
> **What to do**: Per contract semantics for each.
>
> **Acceptance criteria**: All 7 pgTAP files GREEN.
>
> **Constitution**: II, III, V, XI.

**Blocked-by**: T037
**Parallel-safe with**: T039, T040, T041
**Definition of done**: 7 admin-RPC pgTAP files GREEN.

---

- [X] T039 [P] Implement remaining admin pages: /admin/predictions/[participant] + /admin/pending-review + /admin/audit{,/[id],/by-target/...} + route handlers

**Agent prompt:**

> **Goal**: Per `contracts/admin-ui.surface.md` + `contracts/admin-audit.read.md`.
>
> **Files to create or modify**:
> - `apps/web/app/admin/predictions/[participant]/page.tsx` (new)
> - `apps/web/app/admin/pending-review/page.tsx` (new)
> - `apps/web/app/admin/audit/page.tsx` (new) — search
> - `apps/web/app/admin/audit/[id]/page.tsx` (new) — detail with linkage
> - `apps/web/app/admin/audit/by-target/[entity_type]/[entity_id]/page.tsx` (new) — target history
> - `apps/web/app/api/admin/predictions/route.ts` (new)
> - `apps/web/app/api/admin/final-predictions/route.ts` (new)
> - `apps/web/app/api/admin/pending-review/[id]/route.ts` (new)
> - `apps/web/app/api/admin/audit/route.ts` (new)
> - `apps/web/app/api/admin/audit/[id]/route.ts` (new)
> - `apps/web/app/api/admin/audit/by-target/[entity_type]/[entity_id]/route.ts` (new)
> - Corresponding Playwright tests (~6 specs from `contracts/admin-ui.surface.md` § Test surface + `admin-audit.read.md` § Test surface)
>
> **Acceptance criteria**: All ~6 Playwright tests GREEN.
>
> **Constitution**: III.

**Blocked-by**: T037, T038
**Parallel-safe with**: T040, T041
**Definition of done**: All polish-phase Playwright tests GREEN.

---

- [X] T040 [P] Manual quickstart verification — `specs/006-admin-overrides/quickstart-verification.md`

**Agent prompt:**

> **Goal**: Execute every step in `quickstart.md` § Manual verification checklist (steps 1–16). Record results.
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/quickstart-verification.md` (new)
>
> **Acceptance criteria**: 16/16 PASS.
>
> **Constitution**: X.

**Blocked-by**: T039
**Parallel-safe with**: T038, T041
**Definition of done**: 16/16 PASS.

---

- [X] T041 Final regression gate — `specs/006-admin-overrides/regression-final.md`

**Agent prompt:**

> **Goal**: Full-suite GREEN check across Slices 001 + 002 + 003 + 004 + 005 + 006 before merge.
>
> **Files to create or modify**:
> - `specs/006-admin-overrides/regression-final.md` (new)
>
> **What to do**: Run every Playwright + pgTAP + Deno + typecheck + build. Tabulate. Confirm CI green.
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI (NON-NEGOTIABLE final gate).

**Blocked-by**: T038, T039, T040
**Parallel-safe with**: _(none — final gate)_
**Definition of done**: `regression-final.md` shows 100% GREEN.

---

## Dependency graph (terse)

```
T001 → T002 → T003 ∥ T004 ∥ T005 ∥ T006 → T007 → T008 → T009
T009 → T010 ∥ T011 → T012 → T013 ∥ T014 → T015 → T016 → T017
T017 → T018 ∥ T019 → T020 → T021 ∥ T022 ∥ T023 ∥ T024 → T025 → T026
T026 → T027 ∥ T028 → T029 → T030 ∥ T031 → T032
T032 → T033 ∥ T034 → T035 → T036 → T037
T037 → T038 ∥ T039 ∥ T040 → T041 (final gate)
```

## Parallel-execution recipes

**Foundational (after T002):** T003, T004, T005, T006 — four independent files.
**Foundational gate (after T007):** T008 cross-slice test migration (sequential), then T009 bootstrap seed.
**US1 tests (after T009):** T010 (pgTAP) ∥ T011 (Playwright).
**US1 impl (after T012):** T013 (SP) ∥ T014 (lib), then T015 (routes), then T016 (pages).
**US2 tests (after T017):** T018, T019.
**US2 impl (after T020):** T021, T022, T023, T024 — 4-way; T021 has the SP, T022 the view, T023 the reaper, T024 the Slice 005 self-scan extension.
**US3 tests (after T026):** T027, T028.
**US4 tests (after T032):** T033, T034.
**Polish (after T037):** T038, T039, T040.

## Implementation strategy

- **MVP scope = Phase 1 + Phase 2 + Phase 3 (US1).** After T017, admin can manually correct match scores end-to-end. Demo-ready.
- **P1 stories = Phases 4 + 5 + 6.** US2 adds recalc + resumability per Clarifications Q2 (Edge Function self-scan + slow pg_cron). US3 adds finals correction. US4 hardens the gate.
- **Polish = Phase 7.** Remaining admin RPCs (admin_submit_*, pending-review) + admin pages + manual quickstart + final regression gate.

## Notes for the orchestrator

- The 4-way Foundational fan-out (T003–T006) is the highest parallelism opportunity.
- T008 (cross-slice test migration) is the riskiest task — it modifies tests across 4 prior slices to insert `admin_roles` rows. Run carefully; expect some test failures during migration; document each fix.
- T024 (Slice 005 self-scan extension) is THE key task for SC-007 per Clarifications Q2. Without it, SC-007 fails. The Slice 005 contract permits additive behavior at the top of the Edge Function (the request/response shape is unchanged).
- **Cross-slice contract locks** ship at:
  - T003 (`admin_roles` shape)
  - T004 (`audit_log.source_citation` additive)
  - T005 (`score_calculation_runs.triggering_audit_log_id` additive)
  - T007 (`is_admin` real body; signature unchanged)
  - T013, T021, T030, T038 (the 7 admin_* RPC signatures + ERRCODE WAR01-06)
  - T024 (Slice 005 Edge Function self-scan additive behavior)
- After T041, any change to these requires coordinated regression updates across Slices 007 + 008 per Constitution Principle XI.
- **Spec Clarifications 2026-05-17 are first-class test cases**:
  - Q1 (cancelled audit-only): T010's `admin_record_match_result_happy.sql` covers; quickstart step 1 manually verifies.
  - Q2 (Edge Function self-scan + 5min cron): T023 (cron) + T024 (self-scan) + T019's `slice-006-admin-recalc-resumes-after-interrupt.spec.ts`.
  - Q3 (audit_log rows): implicit in every admin RPC — no separate admin_override_events table task exists.
- This file MUST NOT be edited to "make things work" — if any task's acceptance criteria appears impossible, file a bug or revise the plan; do not silently weaken a criterion.
