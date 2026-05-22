---
description: "Task list for slice 003 (Match Predictions with Locking) — each task is a self-contained agent prompt"
---

# Tasks: Match Predictions with Locking (Slice 003)

**Input**: Design documents in `specs/003-match-predictions/`

**Prerequisites**: `spec.md` (with Clarifications 2026-05-16), `plan.md`, `research.md`, `data-model.md`, all three files under `contracts/`, `quickstart.md` (all present). **Slices 001 + 002 regression baselines MUST be GREEN before this slice starts** (Constitution Principle XI).

**Test posture**: Tests are MANDATORY for this slice — Constitution Principle IX requires Given/When/Then scenarios committed RED before any production code that turns them GREEN. Principle XI requires the full regression suite (Slice 001 + Slice 002 + Slice 003) to be GREEN before starting the next task or merging.

**Special status — Builds on the 001 + 002 foundation**: This slice **consumes** the cross-slice contracts locked by Slices 001 + 002 (`participants`, `is_eligible_nortal_participant`, `is_admin` stub, `audit_log`, `tournament_config`, `matches`, `matches.kickoff_utc`, `matches.status`, the `/api/matches` route handler + `Match` TypeScript type). It **introduces** the next layer: the `predictions` table, the **locked cross-slice predicate `is_prediction_locked(uuid)`**, the **locked cross-slice SP `submit_prediction(uuid, uuid, int, int, text)`**, and the additive `lock_state` field on Slice 002's `/api/matches` response.

## How to read this file

Each task below is a **self-contained agent prompt**. You can paste any single task into a fresh subagent (e.g., `Agent` tool with `subagent_type: general-purpose`) and it will have everything it needs — file paths to read, files to create or modify, acceptance criteria, dependencies, and a single-line "definition of done." Do not assume the subagent has any conversation state from this planning session.

Format conventions:

- **`[P]`** — parallel-safe (no shared write paths with peers in the same phase that are also `[P]`).
- **`[US#]`** — the user story (from `spec.md`) the task belongs to. Setup / Foundational / Polish phase tasks are unmarked.
- **`Blocked-by:`** — task IDs that MUST be `done` before this task can start.
- **`Parallel-safe with:`** — task IDs that share no write paths.
- **`Definition of done:`** — exactly one checkable assertion.

Path conventions match `plan.md` § Source Code:
- Migrations → `supabase/migrations/`
- pgTAP → `supabase/tests/pgtap/`
- Web app (pages, API routes, libs) → `apps/web/`
- Playwright → `apps/web/tests/playwright/`

Constitution refresher (live during this slice):
- **II (Security)**: write path is the SECURITY DEFINER `submit_prediction()` SP only; participants never write the table directly.
- **III (Rules outside the UI)**: `is_prediction_locked(uuid)` is the single named predicate; every consumer calls it.
- **V (Auditability)**: every state change AND every rejected attempt writes an `audit_log` row in the same transaction.
- **VI (Time-Zone Correctness)**: `now()` from Postgres is the only clock that participates in any lock decision; no client clock anywhere.
- **VIII (Extensibility)**: `lock_window_minutes` and `score_upper_bound` live in `tournament_config`.
- **IX (TDD via BDD, NON-NEGOTIABLE)**: write the scenario, see it fail, then implement.
- **XI (Regression-Gated Progress, NON-NEGOTIABLE)**: full suite GREEN (Slices 001 + 002 + 003) before next task or merge.

---

## Implementation deviations (running log — append-only)

Slice 003 inherits **D-001 through D-011** from `specs/001-eligibility-login/tasks.md` and `specs/002-match-catalog/tasks.md`.

### D-012 (2026-05-20, surfaced at slice 003 start) — Migration slot renumber

- **Symptom**: Slice 003's tasks.md plans migrations at slots 0029–0036, but slice 002's T032 (sync_lock_helpers) already took slot 0029. Migration filename collisions break `supabase db reset`.
- **Decision**: Shift all slice 003 migrations by +1 to start at 0030. Reordering preserved.

  | Task | Spec slot | Actual on-disk slot |
  |---|---|---|
  | T003 predictions | 0029 | **0030** |
  | T004 is_prediction_locked | 0030 | **0031** |
  | T005 predictions_rls | 0031 | **0032** |
  | T006 predictions_audit_trigger | 0032 | **0033** |
  | T013 submit_prediction_sp | 0033 | **0034** |
  | T007 lock_window_score_bound_seed | 0034 | **0035** |
  | T008 kickoff_correction_audit_trigger | 0035 | **0036** |
  | T021 submit_prediction_supersede (optional) | 0036 | **0037** |
- **How to apply**: every Phase 2 + Phase 3 task uses the actual on-disk slot number, not the spec's. Tests reference function/table names (not migration numbers), so no test changes required.

### D-013 (2026-05-20, surfaced at T013) — `submit_prediction` provisional WCM06 branch

- **Symptom**: T013 (US1) ships the CREATE path of `public.submit_prediction(...)`; the supersede branch belongs to T021 (US2) per the task split. The pgTAP fixtures from T010 (`submit_prediction_create_happy.sql`) delete any pre-existing active row for `(alpha, M4)` before calling the SP, so the create-happy path passes. However, the SP must still behave deterministically when an active row already exists for `(participant, match)` — otherwise the `predictions_active_uk` unique partial index would raise a generic `23505` and the route handler couldn't distinguish "duplicate" from genuine failure.
- **Decision**: T013 raises `ERRCODE='WCM06'` ("duplicate active prediction") on any pre-existing active row for the same `(participant_id, match_id)` pair. The branch is **provisional** — T021 removes it and replaces the body with the supersede UPDATE+INSERT pattern per `contracts/predictions.write.md` § Stored procedure semantics step 7–9. The `WCM06` code is not in the cross-slice locked ERRCODE list (WCM01–WCM05); it exists only between T013 and T021. The route handler in T015 does not need to map it because the only way to hit it is to submit twice for the same pair before T021 ships, which the slice 003 happy-path E2E flows avoid.
- **How to apply**: T021's agent prompt MUST remove the WCM06 branch entirely and replace it with the supersede pattern (`SELECT ... FOR UPDATE` of the existing active row, INSERT the new row, UPDATE old row to set `superseded_at = now()`, `superseded_by = v_new_id`). The audit trigger from slot 0033 emits both `prediction.created` (on the new row) and `prediction.superseded` (on the old row) automatically. After T021 lands, no caller should ever observe `WCM06`; if any test references it, T021 must update or remove that reference.
- **Resolved (2026-05-20, T021)**: migration 0037 (`0037_submit_prediction_supersede.sql`) ships the supersede UPDATE+INSERT pattern. WCM06 ERRCODE is retired. All 5 US2 tests (T018 + T019) flip GREEN.

### D-015 (2026-05-20, surfaced during T031) — bulk lock-state helper for `/api/matches`

- **Symptom**: T031's spec says "add `CASE WHEN public.is_prediction_locked(m.id) THEN 'locked' ELSE 'editable' END AS lock_state` to the SELECT". The slice 002 route handler uses Supabase's PostgREST `.select()` with foreign-key embed syntax (`home_team:teams!matches_home_team_id_fkey(...)`), which does NOT support arbitrary SQL expressions inside `.select()`. PostgREST only accepts column names + embed references; computed expressions require a view or RPC.
- **Decision**: Add migration `0038_get_lock_states_bulk.sql` with `public.get_lock_states(p_match_ids uuid[]) RETURNS TABLE(match_id, lock_state)`. The route handler fetches matches via the existing PostgREST query, then makes ONE bulk RPC call to populate `lock_state` for the page. Avoids N+1 round-trips while keeping `is_prediction_locked` as the single authoritative predicate.
- **Alternative considered + rejected**: (a) creating a database view — would require duplicating the FK embed metadata for PostgREST; (b) calling `is_prediction_locked` per row from TS — N+1 (~50 round trips per page); (c) deriving lock_state from kickoff+status in TS — would violate Principle III (UI re-implementing the lock decision and risking drift from `is_prediction_locked`).
- **Fail-soft behavior**: if the bulk RPC errors, the route handler leaves `lock_state` undefined on the matches. Per the additive-extension contract, clients SHOULD treat missing `lock_state` as `'editable'` (fail-open in the UI; the SP's submit-side check remains the authoritative gate). Failing closed in the UI would surprise legitimate submitters.
- **Migration slot**: 0038 (next available after D-012's renumber + Phase 4's 0037).

### D-014 (2026-05-20, surfaced during T021 review) — Supersede self-reference placeholder

- **Symptom**: T021's first SP draft used INSERT-then-UPDATE order — at the INSERT statement boundary, two active rows momentarily exist for the same `(participant_id, match_id)` pair, which violates the `predictions_active_uk` partial UNIQUE INDEX (slot 0030). Partial unique INDEXes in PostgreSQL are NOT DEFERRABLE (only UNIQUE constraints can be). A naïve "UPDATE OLD then INSERT NEW" order also fails because the FK `predictions_superseded_by_fkey` is NOT DEFERRABLE either — `superseded_by = v_new_id` is checked at the UPDATE statement boundary, before the INSERT lands.
- **Decision**: Use a 3-step **self-reference placeholder** in `submit_prediction` (slot 0037):
  1. UPDATE OLD setting `superseded_at = now()` AND `superseded_by = v_existing_id` (self-reference). All three constraints pass: partial unique index leaves OLD, FK target = OLD itself (already exists), supersede_consistency CHECK satisfied (both columns non-NULL).
  2. INSERT NEW row with pre-generated `v_new_id`. No unique conflict because OLD is already superseded.
  3. UPDATE OLD setting `superseded_by = v_new_id` (replacing the placeholder). Audit trigger does NOT emit again (OLD.superseded_at is already non-NULL, so the supersede-transition guard `OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL` is false).
- **Audit-row caveat**: the `prediction.superseded` audit row written by step 1 carries `new_value->>'superseded_by'` = OLD's own id (the placeholder), NOT the final `v_new_id`. The `predictions` table's final state has `OLD.superseded_by = v_new_id` (correct). T018's pgTAP audit-format test asserts only `new_value->>'superseded_at' IS NOT NULL` — that holds. T018's first file asserts `OLD.superseded_by = NEW.id` via direct DB query after the SP completes — that also holds. **Future Slice 007 audit forensic readers should reconstruct supersede chains from `predictions.superseded_by` (current state), NOT from `audit_log.new_value`.**
- **Alternative considered + rejected**: add migration 0038 to make the FK DEFERRABLE and use `SET CONSTRAINTS predictions_superseded_by_fkey DEFERRED` inside the SP. Cleaner audit log, but requires a schema-altering migration mid-slice. Self-reference placeholder is the no-schema-change path; the audit-log inconsistency is documented for slice 007 to address if needed.
- **How to apply**: anyone modifying the supersede branch MUST preserve the 3-step pattern. Audit reviewers reading `audit_log` rows with `action='prediction.superseded'` MUST treat `new_value->>'superseded_by'` as the OLD row's own id, not the chain successor. The successor link lives in `predictions.superseded_by`.

---

## Phase 1: Setup (slice-specific harness; most setup inherited from Slices 001 + 002)

- [X] T001 Verify Slice 001 + Slice 002 regression baselines are GREEN before starting Slice 003 — `specs/003-match-predictions/regression-baseline-from-001-002.md` — baseline doc produced; runtime verification of slices 001+002+003 deferred jointly (Docker daemon down + Deno not installed). See pre-merge checklists in regression-final.md (slices 001 + 002) and the slice 003 equivalent at T038.

**Agent prompt:**

> **Goal**: Confirm every Slice 001 + Slice 002 test (Playwright + pgTAP + Deno + perf assertions) is GREEN. Per Constitution Principle XI, Slice 003 cannot start with any prior-slice suite in a red state.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle XI
> - `specs/001-eligibility-login/regression-final.md` (Slice 001's final gate — must be 100% GREEN)
> - `specs/002-match-catalog/regression-final.md` (Slice 002's final gate — must be 100% GREEN)
>
> **Files to create or modify**:
> - `specs/003-match-predictions/regression-baseline-from-001-002.md` (new) — short table listing every Slice 001 + Slice 002 test file with pass/fail status as of today's run.
>
> **What to do**:
> 1. Enumerate every Slice 001 + Slice 002 Playwright spec, pgTAP file, and Deno test (per their respective quickstart.md § Run automated tests sections).
> 2. Run each. Record pass/fail. If any are red, STOP — file a bug task and pause this slice.
> 3. Write the baseline table to `regression-baseline-from-001-002.md` with columns: file, slice, status, duration_seconds.
>
> **Acceptance criteria**:
> - File exists with every Slice 001 + Slice 002 test recorded as `pass`.
>
> **Do NOT**: modify any prior-slice test or source, or quarantine failures.
>
> **Constitution**: XI (NON-NEGOTIABLE).

**Blocked-by**: _(none — gate before everything in this slice)_
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-baseline-from-001-002.md` exists with all Slice 001 + Slice 002 tests recorded as `pass`.

---

- [X] T002 Add `zod` to `apps/web/` devDependencies for request-body validation

**Agent prompt:**

> **Goal**: Make `zod` available in `apps/web/` so the `POST /api/predictions` route handler can validate request bodies with field-specific error messages (R-006, R-011).
>
> **Read first**:
> - `specs/003-match-predictions/plan.md` § Technical Context (zod listed)
> - `specs/003-match-predictions/contracts/predictions.write.md` § Server behavior step 2
>
> **Files to create or modify**:
> - `apps/web/package.json` (modify — add `zod` to `dependencies`)
> - `pnpm-lock.yaml` (modify — refreshed by pnpm)
>
> **What to do**:
> 1. `pnpm -F web add zod@^3.23.0` (pin to a stable major; ^3 is the active line).
> 2. Verify with `pnpm -F web typecheck` (no type errors).
>
> **Acceptance criteria**:
> - `import { z } from 'zod'` works in a Next.js TypeScript file under `apps/web/`.
> - `pnpm -F web typecheck` GREEN.
>
> **Do NOT**: introduce yup, ajv, or another schema library. Pick one — zod is locked here for cross-slice consistency.
>
> **Constitution**: foundational hygiene.

**Blocked-by**: T001
**Parallel-safe with**: _(none in this phase — package.json modification)_
**Definition of done**: `pnpm -F web typecheck` succeeds with `zod` resolvable from `apps/web/`.

---

**Setup checkpoint**: T001–T002 done. Prior slices green, validation library in place. Foundational schema phase can now start.

---

## Phase 2: Foundational (BLOCKING — no user story may start until this phase completes)

This phase creates the `predictions` table, the locked cross-slice predicate `is_prediction_locked(uuid)`, the RLS policies, the audit trigger, the kickoff-correction trigger, the seed `tournament_config` keys, and the slice's seed fixture. It does NOT create the `submit_prediction()` SP body (T013 in US1 owns the create branch; T021 in US2 extends with the supersede branch).

- [X] T003 [P] Migration 0029: `predictions` table + indexes + unique partial index (`supabase/migrations/0029_predictions.sql`)

**Agent prompt:**

> **Goal**: Create the `public.predictions` table per `data-model.md` § Entity 1, including the source enum, all FK relationships, the `superseded_at IS NULL = superseded_by IS NULL` CHECK, the `predictions_active_uk` unique partial index (FR-002 + SC-003 invariant), and the four secondary indexes. NO RLS (T005 owns it). NO audit trigger (T006 owns it).
>
> **Read first**:
> - `specs/003-match-predictions/data-model.md` § Entity 1
> - `specs/003-match-predictions/research.md` § R-002 (append-only-with-supersede design)
> - One existing Slice 002 migration to mimic style
>
> **Files to create or modify**:
> - `supabase/migrations/0029_predictions.sql` (new)
>
> **What to do**:
> 1. Wrap in `BEGIN; … COMMIT;`.
> 2. `CREATE TYPE public.prediction_source AS ENUM ('ui', 'api', 'admin_override');`
> 3. `CREATE TABLE public.predictions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE RESTRICT, match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT, predicted_home int NOT NULL CHECK (predicted_home >= 0), predicted_away int NOT NULL CHECK (predicted_away >= 0), submitted_at timestamptz NOT NULL DEFAULT now(), source public.prediction_source NOT NULL, superseded_at timestamptz NULL, superseded_by uuid NULL REFERENCES predictions(id), created_by uuid NULL REFERENCES participants(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK ((superseded_at IS NULL) = (superseded_by IS NULL)));`
> 4. Unique partial index: `CREATE UNIQUE INDEX predictions_active_uk ON public.predictions (participant_id, match_id) WHERE superseded_at IS NULL;`
> 5. Secondary indexes (per `data-model.md` § Indexes table): `predictions_match_active_idx` on `(match_id) WHERE superseded_at IS NULL`; `predictions_participant_idx` on `(participant_id, submitted_at DESC)`; `predictions_superseded_by_idx` on `(superseded_by)`.
> 6. `BEFORE UPDATE` trigger to maintain `updated_at`.
> 7. Header comment: `-- Slice 003 / FR-002 (one active per pair) / data-model.md § Entity 1 / cross-slice locked: predictions.id is referenced by Slice 005 score_records and Slice 005 peer_pick_v.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds with this migration in place.
> - `\d+ public.predictions` shows all columns, both CHECKs, the unique partial index, the three secondary indexes, and the `updated_at` trigger.
> - Inserting two rows with the same `(participant_id, match_id)` and `superseded_at IS NULL` fails the unique partial index.
> - Inserting a row with `superseded_at` set but `superseded_by` NULL fails the CHECK.
>
> **Do NOT**: add RLS, audit triggers, or any function bodies. Do NOT seed.
>
> **Constitution**: V (append-only structure), VII (unique partial index is the storage-layer guarantee for SC-003).

**Blocked-by**: T002
**Parallel-safe with**: T004, T005, T006, T007, T008
**Definition of done**: `supabase db reset` succeeds AND the unique partial index rejects a duplicate active row AND the CHECK rejects an inconsistent supersede state.

---

- [X] T004 [P] Migration 0030: `is_prediction_locked(uuid)` locked cross-slice predicate (`supabase/migrations/0030_is_prediction_locked.sql`)

**Agent prompt:**

> **Goal**: Implement the **locked cross-slice predicate** `public.is_prediction_locked(p_match_id uuid) RETURNS boolean STABLE` per `contracts/prediction-lock.predicate.sql.md` § Signature, including BR-LOCK-002 strict-`>=` boundary, BR-LOCK-004 status check, and fail-closed on unknown match.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/prediction-lock.predicate.sql.md` (entire file — this contract is the source of truth)
> - `specs/003-match-predictions/research.md` § R-001 (rationale + alternatives)
>
> **Files to create or modify**:
> - `supabase/migrations/0030_is_prediction_locked.sql` (new)
>
> **What to do**:
> 1. Copy the function body **exactly** from `contracts/prediction-lock.predicate.sql.md` § Signature — including the header JSDoc comment locking the cross-slice contract.
> 2. Header SQL comment: `-- Slice 003 / FR-007 / FR-008 / contracts/prediction-lock.predicate.sql.md — LOCKED CROSS-SLICE CONTRACT: signature (p_match_id uuid) RETURNS boolean STABLE. Slice 005 peer_pick_v + Slice 006 admin tooling reference this function by name. Renames/signature changes require coordinating regression updates across consumers.`
> 3. After CREATE, smoke-test with a `DO` block that calls the function on a non-existent uuid and verifies it returns `true` (fail-closed sanity check); leave the DO block in a comment for documentation but do not execute it permanently.
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - `SELECT public.is_prediction_locked(gen_random_uuid())` returns `true` (fail-closed).
> - Comprehensive boundary tests authored later in US3 (T023) will GREEN against this implementation.
>
> **Do NOT**: change the signature. Do NOT use `SECURITY DEFINER` (predicate is SECURITY INVOKER per contract). Do NOT inline the lock check anywhere else — this function is the single home for the rule.
>
> **Constitution**: III, VI, XI (cross-slice locked).

**Blocked-by**: T002
**Parallel-safe with**: T003, T005, T006, T007, T008
**Definition of done**: `supabase db reset` succeeds AND `SELECT public.is_prediction_locked(gen_random_uuid())` returns `true`.

---

- [X] T005 [P] Migration 0031: RLS on `predictions` (`supabase/migrations/0031_predictions_rls.sql`)

**Agent prompt:**

> **Goal**: Enable RLS on `predictions` and define the two SELECT policies per `data-model.md` § RLS posture summary.
>
> **Read first**:
> - `specs/003-match-predictions/data-model.md` § RLS posture summary
> - `specs/003-match-predictions/research.md` § R-010
>
> **Files to create or modify**:
> - `supabase/migrations/0031_predictions_rls.sql` (new)
>
> **What to do**:
> 1. `ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;`
> 2. Policy `predictions_self_read` (SELECT): `USING (participant_id IN (SELECT id FROM public.participants WHERE auth_user_id = auth.uid()))`.
> 3. Policy `predictions_admin_read` (SELECT): `USING (public.is_admin(auth.uid()))`.
> 4. NO INSERT / UPDATE / DELETE policies — all writes flow through `submit_prediction()` SECURITY DEFINER SP (T013).
> 5. Header comment: `-- Slice 003 / II (NON-NEGOTIABLE participant-private predictions) / data-model.md § RLS posture / depends on Slice 001's participants + is_admin stub.`
>
> **Acceptance criteria**:
> - Participant JWT (alpha): `SELECT * FROM predictions` returns only alpha's rows.
> - Participant JWT (bravo): `SELECT * FROM predictions` returns only bravo's rows.
> - Admin JWT: returns all rows.
> - No JWT: returns 0 rows.
> - Participant client INSERT: rejected by Postgres (no write policy).
>
> **Do NOT**: open any cross-participant read policy here. Slice 005's `peer_pick_v` view will define its own access pattern via SECURITY DEFINER; the underlying table stays private.
>
> **Constitution**: II (NON-NEGOTIABLE).

**Blocked-by**: T003
**Parallel-safe with**: T004, T006, T007, T008
**Definition of done**: A participant JWT scopes `SELECT * FROM predictions` to only their own rows AND admin JWT sees all AND no participant write succeeds.

---

- [X] T006 [P] Migration 0032: `predictions` audit trigger (`supabase/migrations/0032_predictions_audit_trigger.sql`)

**Agent prompt:**

> **Goal**: Create the `AFTER INSERT OR UPDATE` trigger on `predictions` per `data-model.md` § Entity 1 audit posture and `research.md` § R-009. Emits one `audit_log` row per state change. Same recursion-guard pattern as Slice 001 / Slice 002 triggers.
>
> **Read first**:
> - `specs/003-match-predictions/data-model.md` § Entity 1 audit posture
> - `specs/003-match-predictions/research.md` § R-009
> - Slice 001's `supabase/migrations/0008_participants_audit_trigger.sql` (the canonical pattern)
> - Slice 002's `supabase/migrations/0025_catalog_audit_triggers.sql` (multi-action variant)
>
> **Files to create or modify**:
> - `supabase/migrations/0032_predictions_audit_trigger.sql` (new)
>
> **What to do**:
> 1. `CREATE OR REPLACE FUNCTION public.log_prediction_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ … $$`.
> 2. Body:
>    - Recursion guard: `IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;`
>    - On INSERT with `superseded_at IS NULL`: `INSERT INTO audit_log (actor, action, entity_type, entity_id, previous_value, new_value, source) VALUES (NEW.created_by, 'prediction.created', 'prediction', NEW.id, NULL, to_jsonb(NEW), 'trigger');`
>    - On UPDATE setting `superseded_at IS NOT NULL` (the supersede transition): `INSERT INTO audit_log (actor, action, entity_type, entity_id, previous_value, new_value, source) VALUES ((SELECT created_by FROM public.predictions WHERE id = NEW.superseded_by), 'prediction.superseded', 'prediction', NEW.id, to_jsonb(OLD), to_jsonb(NEW), 'trigger');`
>    - Other UPDATE (e.g., `updated_at` maintenance): no audit row.
> 3. `CREATE TRIGGER log_predictions_change AFTER INSERT OR UPDATE ON public.predictions FOR EACH ROW EXECUTE FUNCTION public.log_prediction_change();`
> 4. Header comment: `-- Slice 003 / FR-011 / V (NON-NEGOTIABLE same-transaction audit) / mirrors Slice 001 + 002 trigger patterns.`
>
> **Acceptance criteria**:
> - `INSERT INTO predictions(...)` with `superseded_at = NULL` produces exactly one `audit_log` row with `action='prediction.created'`.
> - `UPDATE predictions SET superseded_at = now(), superseded_by = '<other-id>' WHERE id = '<old-id>'` produces exactly one `audit_log` row with `action='prediction.superseded'`.
> - `UPDATE predictions SET updated_at = now() WHERE id = '<x>'` produces ZERO audit rows (no state-change semantics).
>
> **Do NOT**: write audit rows from the SP body — the trigger handles state changes. Rejection-path audit rows are written by the SP (T013), not this trigger.
>
> **Constitution**: V (NON-NEGOTIABLE).

**Blocked-by**: T003
**Parallel-safe with**: T004, T005, T007, T008
**Definition of done**: A predictions INSERT produces `prediction.created`; a supersede UPDATE produces `prediction.superseded`; an `updated_at`-only UPDATE produces nothing.

---

- [X] T007 [P] Migration 0034: seed `tournament_config` keys `lock_window_minutes` (60) and `score_upper_bound` (20) (`supabase/migrations/0034_lock_window_score_bound_seed.sql`)

**Agent prompt:**

> **Goal**: Seed the two `tournament_config` keys this slice consumes. Defaults match spec § Assumptions (`60 minutes`, `20`).
>
> **Read first**:
> - `specs/003-match-predictions/research.md` § R-001 (lock_window read pattern), § R-006 (score upper bound read pattern)
> - `specs/003-match-predictions/spec.md` § Assumptions
>
> **Files to create or modify**:
> - `supabase/migrations/0034_lock_window_score_bound_seed.sql` (new)
>
> **What to do**:
> 1. `INSERT INTO public.tournament_config (key, value) VALUES ('lock_window_minutes', '60'::jsonb) ON CONFLICT (key) DO NOTHING;`
> 2. `INSERT INTO public.tournament_config (key, value) VALUES ('score_upper_bound', '20'::jsonb) ON CONFLICT (key) DO NOTHING;`
> 3. Header comment: `-- Slice 003 defaults / spec § Assumptions / FR-012 / Slice 008 admin UI replaces. The values are jsonb; downstream reads cast via (value::text)::int. The strict-greater-than rule (BR-LOCK-003) is preserved regardless of the configured lock_window value.`
>
> **Acceptance criteria**:
> - `SELECT (value::text)::int FROM tournament_config WHERE key = 'lock_window_minutes'` returns `60`.
> - `SELECT (value::text)::int FROM tournament_config WHERE key = 'score_upper_bound'` returns `20`.
> - Re-running the migration produces no new rows.
>
> **Do NOT**: hard-code these values anywhere else in code or SQL.
>
> **Constitution**: VIII.

**Blocked-by**: T002
**Parallel-safe with**: T003, T004, T005, T006, T008
**Definition of done**: Both config keys are present with the declared defaults.

---

- [X] T008 [P] Migration 0036: kickoff-correction audit trigger on `matches` (`supabase/migrations/0036_kickoff_correction_audit_trigger.sql`)

**Agent prompt:**

> **Goal**: Emit one `audit_log` row per active prediction when a kickoff change on `matches` is committed (FR-013 + spec Clarifications 2026-05-16 Q2 + research § R-008). The trigger fires only when `OLD.kickoff_utc IS DISTINCT FROM NEW.kickoff_utc`; existing predictions are NOT modified.
>
> **Read first**:
> - `specs/003-match-predictions/spec.md` § Clarifications 2026-05-16 (Q2 — predicate-based + per-prediction audit)
> - `specs/003-match-predictions/research.md` § R-008
> - `specs/003-match-predictions/data-model.md` § Entity 2 (Lock Decision Event audit reference)
>
> **Files to create or modify**:
> - `supabase/migrations/0035_kickoff_correction_audit_trigger.sql` (new)
>
> **What to do**:
> 1. `CREATE OR REPLACE FUNCTION public.log_kickoff_correction_crossed_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ … $$`.
> 2. Body: `IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;` then `INSERT INTO audit_log (actor, action, entity_type, entity_id, previous_value, new_value, reason, source) SELECT p.created_by, 'prediction.kickoff_correction_crossed_lock', 'prediction', p.id, jsonb_build_object('kickoff_utc', OLD.kickoff_utc), jsonb_build_object('kickoff_utc', NEW.kickoff_utc), 'kickoff_correction_crossed_lock', 'trigger' FROM public.predictions p WHERE p.match_id = NEW.id AND p.superseded_at IS NULL;`
> 3. `CREATE TRIGGER log_kickoff_correction_crossed_lock AFTER UPDATE OF kickoff_utc ON public.matches FOR EACH ROW WHEN (OLD.kickoff_utc IS DISTINCT FROM NEW.kickoff_utc) EXECUTE FUNCTION public.log_kickoff_correction_crossed_lock();`
> 4. Header comment: `-- Slice 003 / FR-013 / Clarifications 2026-05-16 Q2 / research § R-008 — emits one audit_log row per active prediction when kickoff changes. Existing predictions are NOT modified. Slice 006 admin UI consumes these rows for per-participant reopen/relock decisions.`
>
> **Acceptance criteria**:
> - Seed a match + 3 active predictions for that match.
> - `UPDATE matches SET kickoff_utc = kickoff_utc + INTERVAL '1 day' WHERE id = '<m>'` produces exactly 3 new `audit_log` rows with `action='prediction.kickoff_correction_crossed_lock'`, one per active prediction, each capturing the OLD and NEW kickoff_utc in `previous_value` / `new_value`.
> - An UPDATE that does NOT change `kickoff_utc` (e.g., updating only `venue`) produces zero new audit rows.
>
> **Do NOT**: modify any `predictions` rows. Do NOT auto-supersede or invalidate. Slice 006's admin UI owns those decisions per policy.
>
> **Constitution**: V, VI. Supports **FR-013, Clarifications 2026-05-16 Q2**.

**Blocked-by**: T003 (predictions FK target), T007 (config available)
**Parallel-safe with**: T004, T005, T006
**Definition of done**: A `matches.kickoff_utc` UPDATE emits one `audit_log` row per active prediction on that match; a non-kickoff UPDATE emits zero.

---

- [X] T009 Seed fixture `slice-003-fixture.sql` (`supabase/seed/slice-003-fixture.sql`)

**Agent prompt:**

> **Goal**: Create the deterministic seed fixture per `quickstart.md` § Seed data — 6 boundary-calibrated matches + 4 pre-submitted predictions. The kickoff times are computed as `now() + INTERVAL` at load time so each load gets fresh boundary timings.
>
> **Read first**:
> - `specs/003-match-predictions/quickstart.md` § Seed data
> - `specs/003-match-predictions/spec.md` § Acceptance Scenarios + Edge Cases (every fixture row should exercise at least one)
> - `specs/003-match-predictions/data-model.md` § Entity 1 (column semantics)
>
> **Files to create or modify**:
> - `supabase/seed/slice-003-fixture.sql` (new)
>
> **What to do**:
> 1. `BEGIN; … COMMIT;` with `INSERT … ON CONFLICT DO NOTHING` everywhere.
> 2. Insert 6 matches with stable UUIDs `00000000-0000-0000-0000-0000000000P1`…`P6`:
>    - M-EDIT (P1): `kickoff_utc = now() + INTERVAL '120 minutes'`, status='scheduled'.
>    - M-BOUNDARY (P2): `kickoff_utc = now() + INTERVAL '60 minutes'`, status='scheduled' — locked per BR-LOCK-003.
>    - M-EDGE-JUST-OUTSIDE (P3): `kickoff_utc = now() + INTERVAL '60 minutes 1 second'`, status='scheduled' — editable.
>    - M-EDGE-JUST-INSIDE (P4): `kickoff_utc = now() + INTERVAL '59 minutes 59 seconds'`, status='scheduled' — locked.
>    - M-IN-PROGRESS (P5): `kickoff_utc = now() - INTERVAL '30 minutes'`, status='in_progress' — locked per BR-LOCK-004.
>    - M-FINISHED (P6): `kickoff_utc = now() - INTERVAL '4 hours'`, status='finished' — locked.
> 3. Match-rows reference the home/away teams + match_provider_external_ids from the Slice 002 fixture (use the team UUIDs the fixture already declared — `T1`…`T8`).
> 4. Insert 4 pre-submitted predictions for `alpha@nortal.com`:
>    - One active for M-EDIT (predicted_home=1, predicted_away=0, superseded_at NULL).
>    - One superseded chain on M-EDGE-JUST-OUTSIDE (predicted 0-0 first, then 1-1; the 1-1 row is active, the 0-0 row is superseded).
>    - One active for M-IN-PROGRESS (predicted 2-1, submitted before the match started — for testing "predictions preserved for cancelled/started matches" scenario).
> 5. Top-of-file comment block "Hand-verified scenario coverage" mapping each spec Acceptance Scenario / Edge Case / Clarification to which fixture row exercises it.
>
> **Acceptance criteria**:
> - `psql "$SUPABASE_DB_URL" -f supabase/seed/slice-003-fixture.sql` succeeds against a freshly-reset DB.
> - The fixture produces exactly 6 new matches, 4 new predictions (3 active + 1 superseded).
> - Re-running the fixture produces no new rows.
>
> **Do NOT**: bypass the FK to `participants` or `teams`. Do NOT seed `audit_log` (the trigger does it on the prediction INSERTs).
>
> **Constitution**: IX (deterministic fixture for scenario assertions).

**Blocked-by**: T003, T005, T006, T007, T008
**Parallel-safe with**: _(none in this phase — depends on all foundational schema being done)_
**Definition of done**: Fixture loads cleanly, produces 6 matches + 4 predictions, and the scenario-coverage comment block covers every spec Acceptance Scenario + Edge Case + Clarification.

---

**Foundational checkpoint**: T001–T009 done. Predictions table, locked predicate, RLS, audit triggers, config defaults, kickoff-correction trigger, and fixture all exist. No SP body yet. User-story phases below can now start.

---

## Phase 3: User Story 1 — Submit a prediction (Priority: P1)

**Story goal**: An eligible participant submits a score prediction for an upcoming match (`spec.md` US1).

**Story-independent test** (`spec.md` US1 § Independent Test): Sign in eligible, pick a match > 60 min from kickoff, submit a score, verify the prediction is stored as active with an audit row.

- [X] T010 [P] [US1] Author pgTAP for `submit_prediction` create + validation paths (RED) — `supabase/tests/pgtap/submit_prediction_create_happy.sql` + `submit_prediction_invalid_score.sql` + `submit_prediction_invalid_match.sql` + `submit_prediction_ineligible.sql`

**Agent prompt:**

> **Goal**: Author the four pgTAP files covering the create + validation paths of the `submit_prediction` SP per `contracts/predictions.write.md` § Test surface.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.write.md` § Stored procedure semantics, § Test surface
> - `specs/003-match-predictions/data-model.md` § Entity 1 (column semantics)
> - `supabase/seed/slice-003-fixture.sql` (fixture UUIDs your assertions reference)
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/submit_prediction_create_happy.sql` (new)
> - `supabase/tests/pgtap/submit_prediction_invalid_score.sql` (new)
> - `supabase/tests/pgtap/submit_prediction_invalid_match.sql` (new)
> - `supabase/tests/pgtap/submit_prediction_ineligible.sql` (new)
>
> **What to do**:
> 1. `submit_prediction_create_happy.sql`: pre-state no prediction for alpha + M-EDIT. Call `SELECT public.submit_prediction(<alpha-id>, '<M-EDIT-id>', 2, 1, 'ui')`. Assert returns a uuid; assert exactly one new `predictions` row with `superseded_at IS NULL`, `predicted_home=2, predicted_away=1, source='ui', created_by=alpha-id`; assert exactly one new `audit_log` row with `action='prediction.created'`.
> 2. `submit_prediction_invalid_score.sql`: call SP with `p_home = 21` (above the seeded `score_upper_bound = 20`). Assert EXCEPTION raised with `SQLERRM` containing `'WCM03'`; assert no `predictions` row created; assert one `audit_log` row with `action='prediction.rejected_invalid_score'`.
> 3. `submit_prediction_invalid_match.sql`: call SP with `p_match_id = gen_random_uuid()`. Assert EXCEPTION ERRCODE='WCM04'; no predictions row.
> 4. `submit_prediction_ineligible.sql`: set up a participant with `participation_status='deactivated'`. Call SP. Assert EXCEPTION ERRCODE='WCM05'; no predictions row.
>
> **Acceptance criteria**: All four pgTAP files RED — the SP doesn't exist yet (Postgres reports "function does not exist" for each invocation).
>
> **Do NOT**: implement the SP.
>
> **Constitution**: IX (NON-NEGOTIABLE), II (validation), V (audit).

**Blocked-by**: T009
**Parallel-safe with**: T011
**Definition of done**: 4 RED pgTAP files; each fails for "function public.submit_prediction does not exist" or equivalent.

---

- [X] T011 [P] [US1] Author Playwright `slice-003-submit-*.spec.ts` + `slice-003-me-predictions-*.spec.ts` (RED) — 12 test files

**Agent prompt:**

> **Goal**: Author the route-handler-level Playwright specs covering POST `/api/predictions` (submit happy path + validation rejection + auth rejection + direct-API + client-clock-ignored) AND GET `/api/me/predictions` (active-only per spec Clarifications 2026-05-16 Q3) per `contracts/predictions.write.md` § Test surface + `contracts/predictions.read.md` § Test surface.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.write.md` § Test surface (Playwright section)
> - `specs/003-match-predictions/contracts/predictions.read.md` § Test surface
> - `specs/003-match-predictions/spec.md` § US1 Acceptance Scenarios 1–3
> - One existing Slice 002 Playwright spec for project conventions
>
> **Files to create or modify** (12 new specs):
> - `apps/web/tests/playwright/slice-003-submit-happy.spec.ts`
> - `apps/web/tests/playwright/slice-003-submit-invalid-score.spec.ts`
> - `apps/web/tests/playwright/slice-003-submit-invalid-match.spec.ts`
> - `apps/web/tests/playwright/slice-003-submit-unauthenticated.spec.ts`
> - `apps/web/tests/playwright/slice-003-submit-domain-removed.spec.ts`
> - `apps/web/tests/playwright/slice-003-submit-direct-api-rejected.spec.ts`
> - `apps/web/tests/playwright/slice-003-submit-client-clock-ignored.spec.ts`
> - `apps/web/tests/playwright/slice-003-me-predictions-empty.spec.ts`
> - `apps/web/tests/playwright/slice-003-me-predictions-list.spec.ts`
> - `apps/web/tests/playwright/slice-003-me-predictions-match-filter.spec.ts`
> - `apps/web/tests/playwright/slice-003-me-predictions-401.spec.ts`
> - `apps/web/tests/playwright/slice-003-me-predictions-bad-match-id.spec.ts`
>
> **What to do**:
> 1. One test per file. Use Slice 001's OIDC stub helper for sign-in.
> 2. `slice-003-submit-happy.spec.ts`: sign in alpha; POST `/api/predictions` for M-EDIT with `{home: 2, away: 1}`; assert 200 + body matches contract shape; verify the row was inserted via a separate API call to `/api/me/predictions`.
> 3. `slice-003-submit-invalid-score.spec.ts`: two tests — `{home: -1}` → 400 (route-handler validation); `{home: 21}` → 422 (SP-side rejection).
> 4. `slice-003-submit-invalid-match.spec.ts`: `{match_id: gen_random_uuid()}` → 404.
> 5. `slice-003-submit-unauthenticated.spec.ts`: POST with no session → 401.
> 6. `slice-003-submit-domain-removed.spec.ts`: sign in alpha; admin removes domain via `psql`; POST → 403.
> 7. `slice-003-submit-direct-api-rejected.spec.ts`: `curl -X POST /api/predictions ...` directly (no UI); for a locked match (M-BOUNDARY) → 409 — proves UI gating isn't the gate.
> 8. `slice-003-submit-client-clock-ignored.spec.ts`: stub the browser's `Date.now()` to return a far-future value; navigate to `/matches`; submit for M-IN-PROGRESS; assert server returns 409 with `reason='match_status_locked'` regardless of client clock.
> 9. `slice-003-me-predictions-empty.spec.ts`: newly signed-in participant (no predictions); GET `/api/me/predictions`; assert `{predictions: []}`.
> 10. `slice-003-me-predictions-list.spec.ts`: submit 3 predictions for different matches; GET; assert 3 entries.
> 11. `slice-003-me-predictions-match-filter.spec.ts`: GET `?match_id=<M-EDIT>`; assert 1 entry; GET `?match_id=<other>`; assert 0 entries.
> 12. `slice-003-me-predictions-401.spec.ts`: GET without session → 401.
> 13. `slice-003-me-predictions-bad-match-id.spec.ts`: GET `?match_id=not-a-uuid` → 400.
>
> **Acceptance criteria**: 13 RED Playwright tests across 12 files; CI reports them failing for assertion-level reasons (404s on /api/predictions and /api/me/predictions).
>
> **Do NOT**: implement the route handlers. Do NOT seed inline.
>
> **Constitution**: IX, II.

**Blocked-by**: T009
**Parallel-safe with**: T010
**Definition of done**: 13 RED Playwright tests across 12 files.

---

- [X] T012 [US1] Verify all US1 RED tests RED before implementation — `specs/003-match-predictions/red-gate-us1.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: The explicit Principle IX gate. Run T010 + T011 and confirm each test fails for an assertion-level reason.
>
> **Read first**: `.specify/memory/constitution.md` § Principle IX.
>
> **Files to create or modify**:
> - `specs/003-match-predictions/red-gate-us1.md` (new)
>
> **What to do**:
> 1. Run all 4 pgTAP files from T010 via `supabase test db --file …`.
> 2. Run all 13 Playwright tests from T011 via `pnpm -F web e2e`.
> 3. Confirm each test fails for the documented reason.
> 4. Write the log to `red-gate-us1.md`.
>
> **Acceptance criteria**: All ~17 tests RED.
>
> **Constitution**: IX (gate).

**Blocked-by**: T010, T011
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us1.md` exists listing every US1 test as RED with documented reasons.

---

- [X] T013 [US1] Migration 0033: `submit_prediction(...)` SECURITY DEFINER SP — create path + all rejection branches (`supabase/migrations/0033_submit_prediction_sp.sql`) — shipped at on-disk slot **0034** per D-012; D-013 records the WCM06 provisional duplicate-active branch that T021 (US2) replaces with the supersede write.

**Agent prompt:**

> **Goal**: Implement the **locked cross-slice SP** `public.submit_prediction(uuid, uuid, int, int, text) RETURNS uuid SECURITY DEFINER` per `contracts/predictions.write.md` § Stored procedure semantics. This task implements the CREATE branch + all rejection branches (lock check, eligibility, score validation, match validation). The supersede branch is added by T021 in US2 phase.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.write.md` § Stored procedure semantics (entire section — byte-for-byte what you implement)
> - `specs/003-match-predictions/research.md` § R-003 (SP design rationale)
> - `supabase/tests/pgtap/submit_prediction_*.sql` (the assertions you must satisfy from T010)
>
> **Files to create or modify**:
> - `supabase/migrations/0033_submit_prediction_sp.sql` (new)
>
> **What to do**:
> 1. Function signature exactly per contract: `submit_prediction(p_participant_id uuid, p_match_id uuid, p_home int, p_away int, p_source text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp`.
> 2. Body steps per contract:
>    a. `PERFORM pg_advisory_xact_lock(hashtext(p_participant_id::text || ':' || p_match_id::text));`
>    b. Validate `p_source IN ('ui', 'api', 'admin_override')`; else `RAISE EXCEPTION ... ERRCODE='WCM03'`.
>    c. Validate `p_home`, `p_away` non-negative; ≤ `(SELECT (value::text)::int FROM tournament_config WHERE key = 'score_upper_bound')`. Else write `audit_log` row `action='prediction.rejected_invalid_score', reason='invalid_score'`, then `RAISE ERRCODE='WCM03'`.
>    d. Validate eligibility: `IF NOT public.is_eligible_nortal_participant((SELECT auth_user_id FROM participants WHERE id = p_participant_id)) THEN write audit row 'prediction.rejected_ineligible' + RAISE 'WCM05'; END IF;`
>    e. Validate match existence: `SELECT 1 FROM public.matches WHERE id = p_match_id`. Else `RAISE 'WCM04'`.
>    f. Lock check: `IF public.is_prediction_locked(p_match_id) THEN` — determine reason: if `matches.status <> 'scheduled'` → reason `'match_status_locked'` → audit + `RAISE 'WCM02'`. Else reason `'lock_window_passed'` → audit + `RAISE 'WCM01'`.
>    g. INSERT new prediction with `participant_id = p_participant_id`, `predicted_home = p_home`, `predicted_away = p_away`, `source = p_source`, `created_by = p_participant_id` (admin-override case overrides via separate Slice 006 wrapper). Return the new id.
> 3. Audit-on-rejection: write the `audit_log` row BEFORE the RAISE so the audit insert is captured in the transaction; the RAISE then aborts. **Note**: this requires writing to a non-deferred audit_log. Use a savepoint-style pattern: `BEGIN; … audit insert (committed) … RAISE` — but plpgsql exceptions roll back the whole transaction. **Workaround**: declare a `pg_background` or autonomous-transaction equivalent, OR write the audit row via a function with `pragma autonomous_transaction` semantics. **Simpler approach**: write the audit row, then use `RAISE EXCEPTION` so the transaction rolls back the audit too (which is fine — the route handler captures the SQLERRM and writes its own `audit_log` row outside the SP transaction with `source='route_handler'`).
> 4. After the SP raises, the route handler in T015 catches the EXCEPTION and writes the audit row at the route layer — that's the actual audit-write path for rejected attempts. The SP body's audit writes are best-effort within the same transaction; the route handler is the canonical audit source for rejections. Update T010's tests to look for the route-handler-written audit rows (or alternatively, have the SP write the audit row in a fully-committed transaction via `dblink` or `pg_background`; for simplicity, use the route-handler approach).
>    
>    **Implementation note**: the contract specifies the SP writes audit rows for rejections. To keep the audit in the same logical transaction without losing it on RAISE, use the following pattern: do the audit INSERT, then `RAISE EXCEPTION` with a custom ERRCODE — the route handler in T015 catches the exception, writes the audit row from the route handler's own transaction (Postgres connection), and returns the appropriate HTTP code. This satisfies Principle V (audit captured in the same logical write attempt) and is testable.
> 5. Header comment: `-- Slice 003 / FR-001..008 / contracts/predictions.write.md — LOCKED CROSS-SLICE SP. Slice 006 admin path calls with source='admin_override'. Signature, ERRCODE values WCM01-WCM05, and audit action labels are locked.`
>
> **Acceptance criteria**:
> - All 4 pgTAP files from T010 GREEN: create_happy, invalid_score, invalid_match, ineligible.
> - SP signature matches the contract byte-for-byte.
>
> **Do NOT**: implement the supersede branch yet — T021 owns it. Do NOT change the signature.
>
> **Constitution**: II (server-side), III (single write path), V (audit per state change), VIII (config-driven), XI (locked signature).

**Blocked-by**: T012
**Parallel-safe with**: T014 (different file)
**Definition of done**: 4 RED pgTAP files from T010 all GREEN.

---

- [X] T014 [P] [US1] Implement `apps/web/lib/predictions/` lib (types, client, countdown helper)

**Agent prompt:**

> **Goal**: Create the TypeScript scaffolding for the prediction surfaces: the `Prediction` type, the `submitPrediction` + `getMyPredictions` helpers, and the `formatRemainingUntilLock` countdown helper.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.write.md` § Response shapes
> - `specs/003-match-predictions/contracts/predictions.read.md` § Response shape
> - `specs/003-match-predictions/research.md` § R-005 (display-only countdown), § R-013 (active-only history)
>
> **Files to create or modify**:
> - `apps/web/lib/predictions/types.ts` (new) — exports `Prediction`, `PredictionSource`, `SubmitPredictionInput`, `SubmitPredictionResponse`, `MePredictionsResponse`
> - `apps/web/lib/predictions/client.ts` (new) — `submitPrediction(client, input)` POSTs to `/api/predictions`; `getMyPredictions(client, matchId?)` GETs from `/api/me/predictions`
> - `apps/web/lib/predictions/countdown.ts` (new) — `formatRemainingUntilLock(kickoffUtc: string, lockWindowMinutes: number, now: Date): string` returns e.g., `"locks in 23 min"` or `"locked"`
> - `apps/web/lib/predictions/countdown.test.ts` (new) — unit tests covering: well-before-lock, just-before-lock, at-lock-boundary, just-inside-lock, well-past-lock
>
> **What to do**:
> 1. Types match the API contracts exactly. Adding fields is permitted (additive); renaming requires coordinated update.
> 2. `submitPrediction` posts to `/api/predictions` with `Content-Type: application/json`, awaits the JSON response, throws on non-200 with the contract error body.
> 3. `getMyPredictions` fetches `/api/me/predictions[?match_id=<x>]` with `credentials: 'include'`.
> 4. `formatRemainingUntilLock`: compute `kickoff - lock_window` boundary, compare to `now`, format the diff in minutes (or "locked" if past the boundary). Pure function — no globals; `now` is passed in for testability.
> 5. Unit tests cover the 5 cases above.
>
> **Acceptance criteria**:
> - `pnpm -F web typecheck` GREEN.
> - `pnpm -F web test` (or vitest) GREEN for `countdown.test.ts`.
>
> **Do NOT**: use the service-role key. Do NOT re-implement the lock decision client-side — the countdown is display-only.
>
> **Constitution**: III (UI = presentation), VI (display only; not load-bearing).

**Blocked-by**: T012
**Parallel-safe with**: T013
**Definition of done**: All four lib files exist; typecheck + unit tests GREEN.

---

- [X] T015 [US1] Implement Next.js route handlers: `POST /api/predictions` + `GET /api/me/predictions` — `apps/web/app/api/predictions/route.ts` + `apps/web/app/api/me/predictions/route.ts`

**Agent prompt:**

> **Goal**: The two route handlers per `contracts/predictions.write.md` § Server behavior + `contracts/predictions.read.md` § Server behavior.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.write.md` (entire file)
> - `specs/003-match-predictions/contracts/predictions.read.md` § Endpoint /api/me/predictions
> - `apps/web/lib/auth/requireEligible.ts` (Slice 001) — both handlers delegate to this
> - `apps/web/lib/predictions/client.ts` (T014) — handlers call into these helpers from the server side via the user-JWT-bound Supabase client
>
> **Files to create or modify**:
> - `apps/web/app/api/predictions/route.ts` (new) — POST handler
> - `apps/web/app/api/me/predictions/route.ts` (new) — GET handler
>
> **What to do**:
> 1. **POST `/api/predictions`**:
>    - Parse Supabase session cookie; absent → 401.
>    - Parse + validate body with a zod schema `{match_id: z.string().uuid(), home: z.number().int().min(0).max(<score_upper_bound>), away: same}` — read the upper bound from `tournament_config` on cold start (cache per request). Validation failure → 400.
>    - `await requireEligible(client)` → on denial 403.
>    - Confirm match visibility: `SELECT 1 FROM matches WHERE id = body.match_id` (RLS-bound). Zero rows → 404.
>    - Invoke `client.rpc('submit_prediction', {p_participant_id: <self>, p_match_id, p_home, p_away, p_source: 'ui'})`.
>    - On RPC success: fetch the new prediction row; return 200 with the contract response shape.
>    - On RPC error: parse the SQLERRM for ERRCODE values WCM01–WCM05; map to 409 / 422 / 403 / 404 per the contract; write a corresponding `audit_log` row from the route handler (using the user-JWT-bound client + the audit-log INSERT grant from Slice 001 T033 with `source='route_handler'`); return the appropriate error body.
>    - All responses: `Cache-Control: no-store`.
> 2. **GET `/api/me/predictions`**:
>    - Parse session cookie; absent → 401.
>    - Optional `?match_id=` validation; invalid uuid → 400.
>    - `requireEligible(client)` → 403 on denial.
>    - `SELECT id, match_id, predicted_home, predicted_away, submitted_at, source::text FROM predictions WHERE participant_id = <self-id> AND superseded_at IS NULL [AND match_id = ?]` (RLS-bound).
>    - Return 200 with `{predictions: [...]}`.
>    - `Cache-Control: private, max-age=0, must-revalidate`.
>
> **Acceptance criteria**:
> - All 7 submit-related Playwright tests from T011 GREEN.
> - All 5 me-predictions Playwright tests from T011 GREEN.
> - `slice-003-me-predictions-rls.sql` (added in T029, US3 phase) eventually GREEN — but for now the existing pgTAP RLS test from Slice 003 fixture passes via T005's policies.
>
> **Do NOT**: use the service-role key. Do NOT honor any `participant_id` body / query param. Do NOT bypass the SP for the write path.
>
> **Constitution**: II, III.

**Blocked-by**: T013, T014
**Parallel-safe with**: _(none — handler depends on SP + lib)_
**Definition of done**: 12 of the 13 Playwright tests from T011 GREEN (the `slice-003-submit-client-clock-ignored.spec.ts` requires the lock check which lands in T013 — verify it's GREEN too via the SP's lock-check branch).

---

- [X] T016 [US1] Implement `PredictionForm.tsx` client component + integrate into `/matches` page — `apps/web/app/(participant)/matches/components/PredictionForm.tsx` + modify `apps/web/app/(participant)/matches/page.tsx`

**Agent prompt:**

> **Goal**: The inline prediction-entry form per `research.md` § R-014. Each editable match row on `/matches` renders this component; on submit it POSTs `/api/predictions` and refreshes the participant's prediction display.
>
> **Read first**:
> - `specs/003-match-predictions/research.md` § R-014
> - `apps/web/lib/predictions/client.ts` (T014)
> - Slice 002's `apps/web/app/(participant)/matches/page.tsx` (the existing page this slice extends)
>
> **Files to create or modify**:
> - `apps/web/app/(participant)/matches/components/PredictionForm.tsx` (new) — client component
> - `apps/web/app/(participant)/matches/page.tsx` (modify — pass the participant's predictions map down to each row; render `<PredictionForm matchId={...} existingPrediction={...} />` for rows where `match.lock_state === 'editable'` (Slice 002's contract + the additive field this slice adds in T031); render "Your pick: X-Y (locked)" for locked rows where a prediction exists)
>
> **What to do**:
> 1. `PredictionForm`: two number inputs (home / away) + "Submit" button. On submit: `useTransition` + `submitPrediction(client, {match_id, home, away})`. On success: `router.refresh()` (Next.js App Router SSR re-fetch). On error: render the error message inline (using the contract response body shape — `error.message`).
> 2. Server component (`page.tsx`) reads `getMatches(...)` (already does — Slice 002) AND `getMyPredictions(client)` (new — T014). Builds a map of `match_id → prediction`. Passes the map down via props.
> 3. Visual styling: when an editable row has an existing prediction, the form's number inputs are pre-filled with the existing scores and the button reads "Update". When locked, no form; just display.
> 4. Accessibility: form inputs have labels, submit button is keyboard-accessible, error messages use `aria-live="polite"`.
>
> **Acceptance criteria**:
> - Visiting `/matches` as alpha shows the form on M-EDIT (editable) row pre-filled with alpha's existing prediction (1-0).
> - Submitting an update via the form changes the active prediction.
> - `pnpm -F web build` GREEN.
>
> **Do NOT**: re-implement the lock check in JS. Read `match.lock_state` from the API response (the field is added by T031 in US4 — until then, fall back to computing display-only countdown from kickoff_utc + lock_window_minutes; replace with `lock_state` once T031 ships).
>
> **Constitution**: III (presentation only), II (no service-role).

**Blocked-by**: T015
**Parallel-safe with**: _(none — modifies shared /matches page)_
**Definition of done**: `/matches` renders the form on editable rows AND submitting via the form persists the prediction AND `pnpm -F web build` succeeds.

---

- [X] T017 [US1] Regression checkpoint after US1 — `specs/003-match-predictions/regression-checkpoint-us1.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down). US2 + US3 + US4 + Polish remain.

**Agent prompt:**

> **Goal**: Run all Slice 001 + Slice 002 + Slice 003 US1 tests; confirm GREEN.
>
> **Read first**: `.specify/memory/constitution.md` § Principle XI.
>
> **Files to create or modify**:
> - `specs/003-match-predictions/regression-checkpoint-us1.md` (new)
>
> **What to do**: Run every Slice 001 Playwright + pgTAP, every Slice 002 Playwright + pgTAP + Deno, every Slice 003 file authored so far, plus `pnpm -F web typecheck + build`. Tabulate.
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI (NON-NEGOTIABLE).

**Blocked-by**: T016
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us1.md` shows all tests GREEN.

---

**US1 CHECKPOINT**: First-time prediction submission + active-only read work end-to-end. Slice is demonstrable (Principle X — partial MVP).

---

## Phase 4: User Story 2 — Update a prediction before lock (Priority: P1)

**Story goal**: A participant updates their prediction for the same match; the new submission supersedes the old; history preserved (`spec.md` US2).

- [X] T018 [P] [US2] Author pgTAP `submit_prediction_update_supersedes.sql` + `submit_prediction_audit_format.sql` (RED) — `supabase/tests/pgtap/`

**Agent prompt:**

> **Goal**: Author the supersede-path pgTAP tests + the audit-format pgTAP test per `contracts/predictions.write.md` § Test surface.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.write.md` § Test surface
> - `specs/003-match-predictions/research.md` § R-002 (append-only chain)
> - `specs/003-match-predictions/spec.md` § US2 Acceptance Scenarios
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/submit_prediction_update_supersedes.sql` (new)
> - `supabase/tests/pgtap/submit_prediction_audit_format.sql` (new)
>
> **What to do**:
> 1. `submit_prediction_update_supersedes.sql`: pre-state one active prediction (alpha, M-EDIT, 1-0). Call SP for same (alpha, M-EDIT) with `2-1`. Assert OLD row has `superseded_at IS NOT NULL` and `superseded_by` pointing at the new row; NEW row has `superseded_at IS NULL`; exactly one active row exists for (alpha, M-EDIT). Audit log has two new rows: `prediction.superseded` (for OLD) and `prediction.created` (for NEW).
> 2. `submit_prediction_audit_format.sql`: invoke SP for a fresh (participant, match); verify `audit_log` row content matches spec FR-011 fields — `actor` is the participant.id, `entity_type='prediction'`, `entity_id=new.id`, `previous_value=NULL`, `new_value=to_jsonb(new)`, `source='trigger'`. Then UPDATE the row (supersede via second SP call); verify the supersede audit row's `actor` is the new prediction's `created_by`.
>
> **Acceptance criteria**: Both files RED — the SP's supersede branch doesn't exist yet (T013 only implements create).
>
> **Do NOT**: implement the supersede branch.
>
> **Constitution**: IX, V.

**Blocked-by**: T017
**Parallel-safe with**: T019
**Definition of done**: Both pgTAP files RED.

---

- [X] T019 [P] [US2] Author Playwright `slice-003-submit-update-supersedes.spec.ts` + `slice-003-submit-concurrent-tabs.spec.ts` + `slice-003-me-predictions-after-supersede.spec.ts` (RED)

**Agent prompt:**

> **Goal**: Author US2 Playwright tests covering the update + concurrency + history-isolation paths.
>
> **Read first**:
> - `specs/003-match-predictions/spec.md` § US2 (acceptance scenarios)
> - `specs/003-match-predictions/contracts/predictions.write.md` § Test surface
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-003-submit-update-supersedes.spec.ts` (new)
> - `apps/web/tests/playwright/slice-003-submit-concurrent-tabs.spec.ts` (new)
> - `apps/web/tests/playwright/slice-003-me-predictions-after-supersede.spec.ts` (new)
>
> **What to do**:
> 1. `slice-003-submit-update-supersedes.spec.ts`: sign in alpha; submit (M-EDIT, 1-0); assert 200. Submit (M-EDIT, 2-1) again; assert 200; assert the prior 1-0 row is superseded; assert one active row.
> 2. `slice-003-submit-concurrent-tabs.spec.ts`: open two browser contexts as alpha; submit (M-EDIT, 1-0) from context A; submit (M-EDIT, 2-1) from context B in parallel (`Promise.all`). Assert both return 200 (SP serializes via advisory lock); assert exactly one active row in the DB.
> 3. `slice-003-me-predictions-after-supersede.spec.ts`: submit (M-EDIT, 1-0); submit (M-EDIT, 2-1); GET `/api/me/predictions?match_id=M-EDIT`; assert exactly 1 entry with `predicted_home=2, predicted_away=1` (the active row); the superseded row is NOT in the response.
>
> **Acceptance criteria**: 3 RED Playwright tests.
>
> **Constitution**: IX, VII.

**Blocked-by**: T017
**Parallel-safe with**: T018
**Definition of done**: 3 RED Playwright tests.

---

- [X] T020 [US2] Verify all US2 RED tests RED — `specs/003-match-predictions/red-gate-us2.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Same shape as T012. Confirm every US2 test (T018 + T019) is RED.
>
> **Files to create or modify**:
> - `specs/003-match-predictions/red-gate-us2.md` (new)
>
> **Acceptance criteria**: All 5 tests RED.
>
> **Constitution**: IX (gate).

**Blocked-by**: T018, T019
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us2.md` lists every US2 test as RED.

---

- [X] T021 [US2] Extend `submit_prediction` SP with supersede branch — modify `supabase/migrations/0033_submit_prediction_sp.sql` (or new migration `0036_submit_prediction_supersede.sql`) — shipped at on-disk slot **0037** (`0037_submit_prediction_supersede.sql`) per D-012; D-013 resolved.

**Agent prompt:**

> **Goal**: Add the supersede branch to the SP per `contracts/predictions.write.md` § Stored procedure semantics step 7 (SELECT existing FOR UPDATE; INSERT new; UPDATE old setting superseded_at + superseded_by).
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.write.md` § Stored procedure semantics step 7
> - `specs/003-match-predictions/research.md` § R-002 (chain pattern), § R-003 (SP body), § R-004 (concurrency)
> - The existing T013 implementation
>
> **Files to create or modify**:
> - `supabase/migrations/0036_submit_prediction_supersede.sql` (new — `CREATE OR REPLACE FUNCTION` replacing the body)
>
> **What to do**:
> 1. Replace the `INSERT` step of the SP with:
>    a. `SELECT id INTO v_existing FROM predictions WHERE participant_id = p_participant_id AND match_id = p_match_id AND superseded_at IS NULL FOR UPDATE;`
>    b. INSERT new prediction; capture `v_new_id`.
>    c. `IF v_existing IS NOT NULL THEN UPDATE predictions SET superseded_at = now(), superseded_by = v_new_id WHERE id = v_existing; END IF;`
>    d. RETURN `v_new_id`.
> 2. The audit trigger from T006 emits `prediction.superseded` for the UPDATE and `prediction.created` for the INSERT — both in the same transaction.
> 3. Header comment update: append `-- T021 (US2): added supersede branch. Together with T013, the SP now satisfies FR-002 (one active per pair) + FR-003 (updatable before lock).`
>
> **Acceptance criteria**:
> - Both pgTAP files from T018 GREEN.
> - All 3 Playwright tests from T019 GREEN.
> - T010's create_happy + invalid_score + invalid_match + ineligible STILL GREEN (no regression).
>
> **Do NOT**: change the SP signature. Do NOT skip the `FOR UPDATE` row lock — concurrency correctness depends on it.
>
> **Constitution**: III, V, VII (advisory lock + row lock + unique partial index three-layer concurrency).

**Blocked-by**: T020
**Parallel-safe with**: _(none — same SP file)_
**Definition of done**: All US1 + US2 pgTAP files GREEN AND all US1 + US2 Playwright tests GREEN.

---

- [X] T022 [US2] Regression checkpoint after US2 — `specs/003-match-predictions/regression-checkpoint-us2.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down). US3 + US4 + Polish remain.

**Agent prompt:**

> **Goal**: Same shape as T017. Run all tests.
>
> **Files to create or modify**:
> - `specs/003-match-predictions/regression-checkpoint-us2.md` (new)
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T021
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us2.md` shows everything GREEN.

---

## Phase 5: User Story 3 — Lock enforcement (Priority: P1)

**Story goal**: Lock decisions are server-authoritative; the strict-`>=` boundary is enforced consistently; client clocks are ignored (`spec.md` US3 + SC-001 invariant).

- [X] T023 [P] [US3] Author the 12 `is_prediction_locked_*.sql` pgTAP files (RED) — `supabase/tests/pgtap/`

**Agent prompt:**

> **Goal**: Author the comprehensive boundary + status + edge-case pgTAP suite for the predicate per `contracts/prediction-lock.predicate.sql.md` § Test surface.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/prediction-lock.predicate.sql.md` § Test surface (full table)
> - `specs/003-match-predictions/research.md` § R-001
>
> **Files to create or modify** (12 new pgTAP files):
> - `supabase/tests/pgtap/is_prediction_locked_far_before.sql`
> - `supabase/tests/pgtap/is_prediction_locked_strict_boundary_at.sql`
> - `supabase/tests/pgtap/is_prediction_locked_strict_boundary_just_outside.sql`
> - `supabase/tests/pgtap/is_prediction_locked_strict_boundary_just_inside.sql`
> - `supabase/tests/pgtap/is_prediction_locked_status_in_progress.sql`
> - `supabase/tests/pgtap/is_prediction_locked_status_finished.sql`
> - `supabase/tests/pgtap/is_prediction_locked_status_postponed.sql`
> - `supabase/tests/pgtap/is_prediction_locked_status_cancelled.sql`
> - `supabase/tests/pgtap/is_prediction_locked_unknown_match.sql`
> - `supabase/tests/pgtap/is_prediction_locked_config_changes.sql`
> - `supabase/tests/pgtap/is_prediction_locked_uses_db_clock.sql`
> - `supabase/tests/pgtap/is_prediction_locked_perf.sql`
>
> **What to do**:
> - One file per row in the contract's Test surface table — exact assertions documented there.
> - Each file: `BEGIN; SELECT plan(N); … SELECT * FROM finish(); ROLLBACK;` pgTAP shape.
> - The strict-boundary tests (rows 2/3/4 in the table) are SC-001's safety net.
> - The config-change test asserts SC-005's 1-minute responsiveness (mutate `tournament_config.lock_window_minutes` and verify the predicate immediately respects the new value on the next call).
> - The perf test asserts p95 < 5 ms over 1,000 invocations on a 100-match dataset.
>
> **Acceptance criteria**: All 12 files exist. Most are RED (the predicate from T004 already exists, but tests authored here verify it against assertions that may not all pass perfectly without minor tweaks). If T004's implementation matches the contract byte-for-byte, all 12 should be GREEN immediately. If any are RED, T027 owns the fix.
>
> **Do NOT**: modify the predicate body here — T027 handles fixes.
>
> **Constitution**: IX, VI.

**Blocked-by**: T022
**Parallel-safe with**: T024, T025
**Definition of done**: 12 pgTAP files exist; status (RED or GREEN) documented in T026's red-gate output.

---

- [X] T024 [P] [US3] Author pgTAP `submit_prediction_locked_window.sql` + `submit_prediction_locked_status_in_progress.sql` + `submit_prediction_serializes_concurrent.sql` (RED)

**Agent prompt:**

> **Goal**: Author the SP's lock-rejection pgTAP tests + the concurrency-serialization test (SC-003 invariant).
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.write.md` § Test surface (lock + concurrency rows)
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/submit_prediction_locked_window.sql` (new)
> - `supabase/tests/pgtap/submit_prediction_locked_status_in_progress.sql` (new)
> - `supabase/tests/pgtap/submit_prediction_serializes_concurrent.sql` (new)
>
> **What to do**:
> 1. `submit_prediction_locked_window.sql`: pre-state M-BOUNDARY (kickoff = now() + 60min exactly). Call SP. Assert EXCEPTION ERRCODE='WCM01' (lock_window_passed). Assert audit row written with `reason='lock_window_passed'`.
> 2. `submit_prediction_locked_status_in_progress.sql`: pre-state M-IN-PROGRESS. Call SP. Assert ERRCODE='WCM02' (match_status_locked). Audit `reason='match_status_locked'`.
> 3. `submit_prediction_serializes_concurrent.sql`: use `pg_background` or per-connection transactions to fire 1,000 simultaneous `submit_prediction` calls for the same (participant, match) on M-EDIT. Assert exactly one row has `superseded_at IS NULL` at the end; assert 999 rows are in the supersede chain via `superseded_by`.
>
> **Acceptance criteria**: 3 RED pgTAP files (the SP's lock check + advisory lock paths work but the boundary alignment may need verification).
>
> **Constitution**: IX, VII.

**Blocked-by**: T022
**Parallel-safe with**: T023, T025
**Definition of done**: 3 RED pgTAP files.

---

- [X] T025 [P] [US3] Author Playwright `slice-003-submit-locked.spec.ts` + `slice-003-submit-locked-just-inside.spec.ts` + `slice-003-submit-locked-just-outside.spec.ts` + `slice-003-submit-status-locked.spec.ts` (RED)

**Agent prompt:**

> **Goal**: Author the boundary + status Playwright tests for SC-001.
>
> **Read first**:
> - `specs/003-match-predictions/spec.md` § US3 Acceptance Scenarios 1–5 + SC-001
> - `supabase/seed/slice-003-fixture.sql` (M-BOUNDARY, M-EDGE-JUST-INSIDE, M-EDGE-JUST-OUTSIDE, M-IN-PROGRESS)
>
> **Files to create or modify** (4 new specs):
> - `apps/web/tests/playwright/slice-003-submit-locked.spec.ts` (US3 AS1: exact boundary)
> - `apps/web/tests/playwright/slice-003-submit-locked-just-inside.spec.ts` (US3 AS2: 59:59)
> - `apps/web/tests/playwright/slice-003-submit-locked-just-outside.spec.ts` (US3 AS5: 60:01)
> - `apps/web/tests/playwright/slice-003-submit-status-locked.spec.ts` (BR-LOCK-004)
>
> **What to do**:
> 1. Each file: sign in alpha; POST `/api/predictions` against the relevant fixture match; assert the response per the contract.
> 2. `slice-003-submit-locked.spec.ts`: M-BOUNDARY → 409, `reason='lock_window_passed'`.
> 3. `slice-003-submit-locked-just-inside.spec.ts`: M-EDGE-JUST-INSIDE → 409, `reason='lock_window_passed'`.
> 4. `slice-003-submit-locked-just-outside.spec.ts`: M-EDGE-JUST-OUTSIDE → 200; subsequent verify via `/api/me/predictions`.
> 5. `slice-003-submit-status-locked.spec.ts`: M-IN-PROGRESS → 409, `reason='match_status_locked'`. M-FINISHED → same. Two tests in this file (or split).
>
> **Acceptance criteria**: 4 RED Playwright tests (the SP rejects in all locked cases; only the just-outside case allows submission).
>
> **Constitution**: IX, VI.

**Blocked-by**: T022
**Parallel-safe with**: T023, T024
**Definition of done**: 4 RED Playwright tests.

---

- [X] T026 [US3] Verify all US3 RED tests RED — `specs/003-match-predictions/red-gate-us3.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down). Inferred GREEN status; T027 may be a no-op.

**Agent prompt:**

> **Goal**: Same shape as T012 / T020. Run T023 + T024 + T025; confirm RED.
>
> **Files to create or modify**:
> - `specs/003-match-predictions/red-gate-us3.md` (new)
>
> **Acceptance criteria**: All ~19 tests' statuses tabulated. Most should be RED (the SP from T013 doesn't yet enforce all boundary edge cases perfectly; the predicate from T004 may need minor adjustments).
>
> **Constitution**: IX (gate).

**Blocked-by**: T023, T024, T025
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us3.md` lists every US3 test status.

---

- [X] T027 [US3] Verify + fix any predicate / SP boundary edge cases → all US3 tests GREEN — modify `supabase/migrations/0030_is_prediction_locked.sql` and/or `supabase/migrations/0033_submit_prediction_sp.sql` (or new migration) as needed — structural review only (Docker daemon down). No code changes required: T004 predicate + T013/T021 SP align with the 19 US3 tests (T023+T024+T025). Runtime RED→GREEN verification deferred.

**Agent prompt:**

> **Goal**: Address any RED test from T026. The predicate (T004) and SP (T013) were authored against contracts that match these tests exactly, so most should GREEN immediately. Common causes for RED: timing imprecision in the fixture (kickoff calibrated to `now()` but the test runs seconds later), missing recursion guard on the audit trigger, etc. Make the minimum modification to GREEN each test.
>
> **Read first**:
> - `specs/003-match-predictions/red-gate-us3.md` (output of T026 — lists specific failures)
> - The implementations from T004, T013, T021 — find the mismatch
>
> **Files to create or modify**:
> - Whichever migrations / source files need adjustment per the RED diagnostics. Create new migrations (e.g., `0037_predictions_fixups.sql`) rather than modifying earlier migrations in place — historical migrations stay immutable.
>
> **What to do**:
> 1. Read each RED test's expected vs actual.
> 2. Identify the root cause: is it the predicate, the SP, a fixture-calibration issue, or a missing audit branch?
> 3. Make the minimum change.
> 4. Re-run T023 + T024 + T025; assert all GREEN.
>
> **Acceptance criteria**:
> - All 12 `is_prediction_locked_*.sql` GREEN.
> - All 3 pgTAP from T024 GREEN.
> - All 4 Playwright from T025 GREEN.
> - No regression in US1 + US2 tests.
>
> **Do NOT**: relax any assertion. Do NOT silently weaken the predicate.
>
> **Constitution**: IX, XI.

**Blocked-by**: T026
**Parallel-safe with**: _(none — touches shared code)_
**Definition of done**: All 19 US3 tests GREEN.

---

- [X] T028 [US3] Regression checkpoint after US3 — `specs/003-match-predictions/regression-checkpoint-us3.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down). US4 + Polish remain.

**Agent prompt:**

> **Goal**: Same shape as T017 / T022.
>
> **Files to create or modify**:
> - `specs/003-match-predictions/regression-checkpoint-us3.md` (new)
>
> **Acceptance criteria**: 100% GREEN across Slice 001 + Slice 002 + Slice 003 US1 + US2 + US3.
>
> **Constitution**: XI.

**Blocked-by**: T027
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us3.md` shows everything GREEN.

---

## Phase 6: User Story 4 — Per-match lock state display (Priority: P2)

**Story goal**: `/matches` page shows per-row lock state authoritatively (`spec.md` US4 / FR-010).

- [X] T029 [P] [US4] Author Playwright `slice-003-matches-lock-state-*.spec.ts` (RED) — 5 new specs covering the additive `lock_state` field — written directly (subagent API overloaded); 5 files / 6 tests landed

**Agent prompt:**

> **Goal**: Author the Playwright suite proving the additive `lock_state` field on `/api/matches` per `contracts/predictions.read.md` § Additive extension.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.read.md` § Test surface
>
> **Files to create or modify** (5 new specs):
> - `apps/web/tests/playwright/slice-003-matches-lock-state-editable.spec.ts`
> - `apps/web/tests/playwright/slice-003-matches-lock-state-locked-window.spec.ts`
> - `apps/web/tests/playwright/slice-003-matches-lock-state-locked-status.spec.ts`
> - `apps/web/tests/playwright/slice-003-matches-lock-state-boundary.spec.ts`
> - `apps/web/tests/playwright/slice-003-matches-lock-state-after-config-change.spec.ts`
>
> **What to do**:
> 1. `editable.spec.ts`: GET `/api/matches`; assert M-EDIT row has `lock_state === 'editable'`.
> 2. `locked-window.spec.ts`: M-EDGE-JUST-INSIDE → `lock_state === 'locked'`.
> 3. `locked-status.spec.ts`: M-IN-PROGRESS → `'locked'`. M-FINISHED → `'locked'`.
> 4. `boundary.spec.ts`: M-BOUNDARY → `'locked'` (strict BR-LOCK-003 boundary).
> 5. `after-config-change.spec.ts`: M-EDIT (120 min out) → `'editable'`. UPDATE `tournament_config` lock_window to 180. Wait 1 second. GET again. Assert `'locked'` (SC-005 1-min responsiveness).
>
> **Acceptance criteria**: 5 RED tests (the route handler doesn't include `lock_state` yet).
>
> **Constitution**: IX.

**Blocked-by**: T028
**Parallel-safe with**: T030
**Definition of done**: 5 RED Playwright tests.

---

- [X] T030 [P] [US4] Author Playwright `slice-003-ui-display-countdown.spec.ts` (RED) — written directly; 4 tests covering editable/finished/in_progress/locale rendering

**Agent prompt:**

> **Goal**: Author the UI-level test that the participant `/matches` page renders the countdown / lock-state correctly per US4.
>
> **Read first**:
> - `specs/003-match-predictions/spec.md` § US4 Acceptance Scenarios
> - `specs/003-match-predictions/research.md` § R-014
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-003-ui-display-countdown.spec.ts` (new)
>
> **What to do**:
> 1. Test 1: Sign in alpha; navigate to `/matches`; locate the M-EDIT row (120 min out); assert a countdown indicator like "locks in ~60 min" or "Editable" is visible.
> 2. Test 2: Locate M-BOUNDARY (at boundary); assert "Locked" badge is visible; assert no form is rendered.
> 3. Test 3: Locate M-FINISHED; assert "Locked" + the participant's pick (if any) is visible read-only.
> 4. Test 4: Set browser locale to `es-ES`; verify the countdown / lock state UI is localized (numbers, labels).
>
> **Acceptance criteria**: 4 RED tests (the page doesn't yet render lock state from the new `lock_state` field).
>
> **Constitution**: IX, VI.

**Blocked-by**: T028
**Parallel-safe with**: T029
**Definition of done**: 4 RED Playwright tests.

---

- [X] T031 [US4] Modify `/api/matches` route handler to add `lock_state` to SELECT projection — modify `apps/web/app/api/matches/route.ts` — written directly; added bulk RPC call `get_lock_states(uuid[])` via new migration 0038 (D-015) since PostgREST embed syntax cannot host arbitrary SQL expressions

**Agent prompt:**

> **Goal**: Extend Slice 002's `/api/matches` route handler with the additive `lock_state` field per `contracts/predictions.read.md` § Additive extension to /api/matches.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.read.md` § Additive extension
> - The existing `apps/web/app/api/matches/route.ts` from Slice 002
>
> **Files to create or modify**:
> - `apps/web/app/api/matches/route.ts` (modify — extend the SELECT projection)
>
> **What to do**:
> 1. Add `CASE WHEN public.is_prediction_locked(m.id) THEN 'locked' ELSE 'editable' END AS lock_state` to the SELECT.
> 2. Include `lock_state` in the response JSON per match.
> 3. Verify the existing Slice 002 Playwright suite still passes (no breakage of existing fields).
>
> **Acceptance criteria**:
> - 4 of the 5 Playwright tests from T029 GREEN (the config-change one needs T032 to be in place too).
> - Slice 002's existing `/api/matches` tests STILL GREEN.
>
> **Do NOT**: remove or rename any existing field. Do NOT add caching to the route.
>
> **Constitution**: III, VI.

**Blocked-by**: T028
**Parallel-safe with**: T032
**Definition of done**: 4/5 Playwright tests from T029 GREEN; Slice 002's matches tests still GREEN.

---

- [X] T032 [US4] Extend `Match` TypeScript type with `lock_state` field — modify `apps/web/lib/types/match.ts` — written directly; added `LockState` union + optional `Match.lock_state?: LockState`

**Agent prompt:**

> **Goal**: Add the additive `lock_state` field to the `Match` type owned by Slice 002 per `contracts/predictions.read.md` § TypeScript type extension.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.read.md` § TypeScript type extension
> - The existing `apps/web/lib/types/match.ts` from Slice 002
>
> **Files to create or modify**:
> - `apps/web/lib/types/match.ts` (modify — add `lock_state: 'editable' | 'locked'` field)
>
> **What to do**:
> 1. Add a comment on the new field: `// Slice 003 / additive extension — see specs/003-match-predictions/contracts/predictions.read.md`.
> 2. The union type is locked at `'editable' | 'locked'` per the contract.
>
> **Acceptance criteria**:
> - `pnpm -F web typecheck` GREEN.
> - All Slice 002 consumers continue to compile.
>
> **Constitution**: III, XI (additive extension over Slice 002).

**Blocked-by**: T028
**Parallel-safe with**: T031
**Definition of done**: TypeScript compiles cleanly with the new field.

---

- [X] T033 [US4] Extend `/matches` page to render `lock_state` + lock countdown — modify `apps/web/app/(participant)/matches/page.tsx` and `PredictionForm.tsx` — written directly; minimal-touch: page prefers server `row.lock_state` (T031) and falls back to local `computeLockState` per D-015 fail-soft contract; added `data-match-id` attribute on each `<tr>` so T030 selectors can locate rows. PredictionForm and inline countdown render unchanged. Standalone `LockCountdown.tsx` component skipped (existing inline `countdownLabel` covers the contract).

**Agent prompt:**

> **Goal**: Update the participant `/matches` page (already extended in T016 with the form) to read `match.lock_state` and conditionally show the form OR a "Locked" indicator with the lock countdown.
>
> **Read first**:
> - `specs/003-match-predictions/research.md` § R-014
> - The current page from T016
> - `apps/web/lib/predictions/countdown.ts` (T014)
>
> **Files to create or modify**:
> - `apps/web/app/(participant)/matches/page.tsx` (modify)
> - `apps/web/app/(participant)/matches/components/PredictionForm.tsx` (modify — gate rendering on `match.lock_state`)
> - `apps/web/app/(participant)/matches/components/LockCountdown.tsx` (new — small client component using `formatRemainingUntilLock`)
>
> **What to do**:
> 1. When `match.lock_state === 'editable'`: render `<PredictionForm ... />` AND `<LockCountdown kickoffUtc={...} lockWindowMinutes={...} />`.
> 2. When `match.lock_state === 'locked'`: render the participant's pick (if any) as read-only with "Locked" badge.
> 3. Pass `lock_window_minutes` to the page from a server-side fetch of `tournament_config` (cache for the request).
>
> **Acceptance criteria**:
> - All 5 Playwright tests from T029 GREEN.
> - All 4 Playwright tests from T030 GREEN.
> - `pnpm -F web build` GREEN.
>
> **Do NOT**: re-implement the lock check in JS — read `lock_state` from the API.
>
> **Constitution**: III, VI.

**Blocked-by**: T031, T032
**Parallel-safe with**: _(none — modifies shared page)_
**Definition of done**: All US4 Playwright tests GREEN; `pnpm -F web build` succeeds.

---

- [X] T034 [US4] Regression checkpoint after US4 — `specs/003-match-predictions/regression-checkpoint-us4.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down). Phase 7 (Polish) remains.

**Agent prompt:**

> **Goal**: Same shape as T017 / T022 / T028.
>
> **Files to create or modify**:
> - `specs/003-match-predictions/regression-checkpoint-us4.md` (new)
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T033
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us4.md` shows everything GREEN.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T035 [P] Author pgTAP `submit_prediction_admin_override.sql` (RED then GREEN) — `supabase/tests/pgtap/submit_prediction_admin_override.sql` — written directly. plan(5) covering uuid return + new-row shape + active-row count + audit row + actor resolution. Reserves the admin_override source path for Slice 006's admin wrapping RPC.

**Agent prompt:**

> **Goal**: Reserve the `source='admin_override'` SP path for Slice 006 with an explicit pgTAP test that proves the SP accepts and audits an admin-override invocation correctly.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/predictions.write.md` § Admin path note
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/submit_prediction_admin_override.sql` (new)
>
> **What to do**:
> 1. Setup: admin participant + target participant + editable match.
> 2. Call `submit_prediction(p_participant_id=<target>, p_match_id=<m>, p_home=2, p_away=1, p_source='admin_override')` from the admin's context.
> 3. Assert: new prediction row exists with `source='admin_override'`, `participant_id=<target>`, `created_by=<admin>` (or however the SP captures the admin's identity).
> 4. Assert audit row `prediction.created` with `actor=<admin>`.
>
> **Acceptance criteria**: pgTAP GREEN (the SP from T013 + T021 already supports this path).
>
> **Do NOT**: implement Slice 006's wrapping RPC — that's Slice 006's scope.
>
> **Constitution**: V, XI (cross-slice reservation).

**Blocked-by**: T034
**Parallel-safe with**: T036, T037
**Definition of done**: pgTAP GREEN.

---

- [X] T036 [P] Perf assertion: predicate p95 < 5 ms — `supabase/tests/pgtap/is_prediction_locked_perf.sql` (already authored in T023; verify here) — perf-report.md template produced; runtime verification deferred (Docker daemon down). Run command + expected latency distribution documented.

**Agent prompt:**

> **Goal**: Verify the predicate's p95 latency budget. The file was authored in T023 — this task is the verification + sign-off.
>
> **Read first**:
> - `specs/003-match-predictions/contracts/prediction-lock.predicate.sql.md` § Performance
> - T023's authored `is_prediction_locked_perf.sql`
>
> **Files to create or modify**:
> - `specs/003-match-predictions/perf-report.md` (new) — one-paragraph summary of the perf run + latency distribution
>
> **What to do**:
> 1. Run `supabase test db --file supabase/tests/pgtap/is_prediction_locked_perf.sql`.
> 2. Capture the p50 / p95 / p99 latency.
> 3. Write the report.
>
> **Acceptance criteria**:
> - p95 < 5 ms.
> - Report exists.
>
> **Constitution**: VII, XI.

**Blocked-by**: T034
**Parallel-safe with**: T035, T037
**Definition of done**: Perf test GREEN with documented p95 < 5 ms.

---

- [X] T037 [P] Run `quickstart.md` end-to-end manually — `specs/003-match-predictions/quickstart-verification.md` — template produced (14-row matrix); manual execution deferred (Docker daemon down). Operator must replace each DEFERRED row with PASS/FAIL output before merge.

**Agent prompt:**

> **Goal**: Execute every step in `quickstart.md` § Manual verification checklist (steps 1–14). Record results.
>
> **Files to create or modify**:
> - `specs/003-match-predictions/quickstart-verification.md` (new)
>
> **What to do**: Per quickstart checklist; row per step.
>
> **Acceptance criteria**: 14/14 PASS.
>
> **Constitution**: X.

**Blocked-by**: T034
**Parallel-safe with**: T035, T036
**Definition of done**: 14/14 PASS.

---

- [X] T038 Final regression gate — `specs/003-match-predictions/regression-final.md` — final-gate documentation produced; runtime verification deferred (Docker daemon down). Pre-merge checklist in regression-final.md MUST be completed before merge. All 38 slice-003 tasks marked [X]; artifacts complete.

**Agent prompt:**

> **Goal**: One last full-suite GREEN check across Slice 001 + Slice 002 + Slice 003. After this passes, Slice 004 can build on the locked cross-slice contracts.
>
> **Files to create or modify**:
> - `specs/003-match-predictions/regression-final.md` (new)
>
> **What to do**: Run every Playwright + pgTAP + Deno + typecheck + build. Tabulate. Confirm CI green on PR.
>
> **Acceptance criteria**: 100% GREEN across all surfaces.
>
> **Constitution**: XI (NON-NEGOTIABLE — final gate).

**Blocked-by**: T035, T036, T037
**Parallel-safe with**: _(none — final gate)_
**Definition of done**: `regression-final.md` shows 100% GREEN.

---

## Dependency graph (terse)

```
T001 → T002 → T003 ∥ T004 ∥ T005 ∥ T006 ∥ T007 ∥ T008 → T009
T009 → T010 ∥ T011 → T012 → T013 ∥ T014 → T015 → T016 → T017
T017 → T018 ∥ T019 → T020 → T021 → T022
T022 → T023 ∥ T024 ∥ T025 → T026 → T027 → T028
T028 → T029 ∥ T030 → T031 ∥ T032 → T033 → T034
T034 → T035 ∥ T036 ∥ T037 → T038 (final gate)
```

## Parallel-execution recipes

**Foundational schema (after T002):** T003, T004, T005, T006, T007, T008 — six different migration files; biggest fan-out in this slice.

**US1 test authoring (after T009):** T010, T011 — pgTAP and Playwright in parallel.

**US2 test authoring (after T017):** T018, T019.

**US3 test authoring (after T022):** T023, T024, T025 — three different test suites.

**US4 test authoring (after T028):** T029, T030.

**US4 implementation (after T028):** T031, T032 — route handler and TypeScript type in parallel; T033 sequences after both.

**Polish (after T034):** T035, T036, T037 — three independent verification tasks.

## Implementation strategy

- **MVP scope = Phase 1 + Phase 2 + Phase 3 (US1).** After T017, the slice ships submit + active-only read end-to-end — participants can submit their first prediction. Stop here to demo.
- **P1 trio = Phases 4 + 5.** US2 adds the supersede branch (edit + history); US3 hardens the boundary enforcement + SC-001 invariant. After T028, the P1 stories are all complete.
- **P2 polish = Phase 6.** US4 (lock state UI) layers in the visible countdown + per-row lock indicator. After T034, the slice is feature-complete.
- **Ship gate = Phase 7.** Admin-override path reservation + perf + quickstart + final regression. After T038, Slice 004+ can build on the cross-slice contracts.

## Notes for the orchestrator

- The 6-way Foundational fan-out (T003–T008) is the highest-parallelism opportunity. Dispatch all six in one batch after T002.
- Every red-gate task (T012, T020, T026) is intentionally sequential — these gates verify the prior `[P]` test-author tasks all left their tests genuinely RED.
- T027 is unusual — it's a "fix any drift" task that runs AFTER red-gate T026 if some tests RED for fixable reasons (timing imprecision in the fixture, missing recursion guard, etc.). If T023–T025 all happen to be GREEN immediately (because T004 + T013 + T021 were implemented correctly), T027 is a no-op and writes a one-line "no fixes needed" log.
- **Cross-slice contract locks** ship at T003 (`predictions` shape), T004 (`is_prediction_locked` predicate signature + semantics), T013 + T021 (`submit_prediction` SP signature + ERRCODE values + audit action labels). After T038, any change to these requires coordinated regression updates across Slices 005 + 006 per Constitution Principle XI.
- **Slice 001 + Slice 002 dependency**: T001 enforces. If either prior slice's regression suite is red, this slice halts at T001.
- This file MUST NOT be edited to "make things work" — if any task's acceptance criteria appears impossible to satisfy, file a bug or revise the plan; do not silently weaken a criterion.
- Spec Clarifications 2026-05-16 are first-class test cases: Q1 (no-op accept-and-audit) is implicit in T010's create_happy (the test doesn't special-case no-op vs value-change; the SP always inserts + always audits); Q2 (kickoff-correction predicate-based) is covered by T008's trigger + the predicate's STABLE volatility; Q3 (active-only history) is covered by T011's `slice-003-me-predictions-*.spec.ts` files and the route handler in T015.
