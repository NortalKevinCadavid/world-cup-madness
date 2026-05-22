# Regression checkpoint — Slice 003, Phase 4 (US2)

- **Slice**: `003-match-predictions`
- **Phase**: 4 (US2 — "Eligible participant updates an in-window prediction; prior submission retained as superseded history")
- **Date**: 2026-05-20
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T022 (`specs/003-match-predictions/tasks.md`)
- **Companion artifacts**:
  - `specs/003-match-predictions/regression-baseline-from-001-002.md` (T001 — slice-001 + slice-002 carry-forward baseline)
  - `specs/003-match-predictions/red-gate-us1.md` (T012 — RED-gate inventory for US1)
  - `specs/003-match-predictions/regression-checkpoint-us1.md` (T017 — Phase-3 sibling that this document extends)
  - `specs/003-match-predictions/red-gate-us2.md` (T020 — sibling RED-gate inventory for the same US2 test set)
  - `specs/001-eligibility-login/regression-checkpoint-us1.md` + `specs/002-match-catalog/regression-checkpoint-us1.md` (cross-slice templates this document mirrors)
- **Purpose**: Record the cumulative state of the slice-001 + slice-002 + slice-003-so-far test suite at the moment Phase 4 (US2) lands, inventory every test surface added through US2, and hand the exact verification commands to whoever next has a working Docker daemon + Deno toolchain. Per Principle XI, US3 (Phase 5), US4 (Phase 6), and the Polish phase MAY NOT start, and the slice MAY NOT merge to `main`, until all verification commands below land GREEN.

---

## Status: DEFERRED

Both the Docker daemon (required by `supabase start`, `supabase db reset`, `supabase test db`, and by every Playwright fixture that boots the local Supabase stack) and the Deno toolchain (required by slice-002's `provider-stub.test.ts` carry-forward suite) were **unavailable at execution time**. `supabase start`, `supabase db reset`, `supabase test db`, the Next.js dev server (which Playwright fixtures depend on), the Playwright suite, and `deno test` therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added through Phase 4 (cumulative with slices 001 + 002 + slice-003 Phase 3), and hands the exact commands the user MUST run locally (or in CI, once slice 001's T007 ships) before Phase 5 (US3) begins or the slice can merge. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 8 have all returned GREEN.

---

## 1. Suite inventory (post-Phase-4 / US2, cumulative across slices 001 + 002 + 003)

### 1a. pgTAP tests — `supabase/tests/pgtap/`

**Slice 001 carry-forward** — 12 files unchanged from the slice-001 baseline. Full inventory in `specs/001-eligibility-login/regression-final.md § 2`. Headline: 1 harness probe + 8 functional + 2 RLS-isolation + 1 perf = 12 files.

**Slice 002 carry-forward** — 9 files unchanged from the slice-002 final gate. Full inventory in `specs/002-match-catalog/regression-final.md § 1a`.

**Slice 003 — Phase 3 (US1)** — 4 files authored by T010 (RED-first), GREEN against T013's CREATE branch. Full inventory in `regression-checkpoint-us1.md § 1a`:
- `submit_prediction_create_happy.sql` (`plan(6)`)
- `submit_prediction_invalid_score.sql` (`plan(3)`)
- `submit_prediction_invalid_match.sql` (`plan(2)`)
- `submit_prediction_ineligible.sql` (`plan(2)`)

**Slice 003 — Phase 4 (US2)** — 2 new files, authored by T018 (RED-first), expected GREEN against T021's supersede branch (slot 0037).

| # | File | `plan(N)` | Purpose | Authored by |
|---|------|-----------|---------|-------------|
| 5 | `supabase/tests/pgtap/submit_prediction_update_supersedes.sql` | `plan(6)` | A1 OLD row carries `superseded_at IS NOT NULL`. A2 OLD row's `superseded_by` points at the NEW row's id (queried directly from `predictions`, after the SP returns). A3 NEW row is active (`superseded_at IS NULL`). A4 NEW row carries `(predicted_home=2, predicted_away=1, source='ui')`. A5 exactly one active row exists for `(alpha, M4)`. A6 audit-log contains both a `prediction.superseded` row (for OLD) and a `prediction.created` row (for NEW). | T018 |
| 6 | `supabase/tests/pgtap/submit_prediction_audit_format.sql` | `plan(5)` | A1 + A2 fresh-INSERT audit-row shape (FR-011): `prediction.created` carries `actor=created_by`, `entity_type='prediction'`, `entity_id=new.id`, `previous_value=NULL`, `new_value=to_jsonb(new)`, `source='trigger'`. A3 supersede audit row carries `new_value->>'superseded_at' IS NOT NULL`. A4 actor on the supersede row equals the new prediction's `created_by`. A5 total audit-row count = 3 (2 `prediction.created` + 1 `prediction.superseded`). | T018 |

**Slice 003 pgTAP aggregate (cumulative Phase 3 + Phase 4)**: 4 + 2 = **6 files**, planned assertions `6 + 3 + 2 + 2 + 6 + 5 = 24`.

**Cumulative pgTAP aggregate at end of Phase 4**: 12 (slice 001) + 9 (slice 002) + 6 (slice 003) = **27 pgTAP files**.

### 1b. Playwright tests — `apps/web/tests/playwright/`

**Slice 001 carry-forward** — 15 spec files (14 `@slice-001` + 1 untagged `smoke.spec.ts`).

**Slice 002 carry-forward** — 12 spec files (`slice-002-*`).

**Slice 003 — Phase 3 (US1)** — 12 spec files / 13 tests tagged `@slice-003 @us1` (T011), GREEN-implemented by T015 + T016. Full inventory in `regression-checkpoint-us1.md § 1b`.

**Slice 003 — Phase 4 (US2)** — 3 new spec files / 3 tests, all tagged `@slice-003 @us2`, authored by T019 (RED-first), expected GREEN against T021's supersede branch.

| # | File | Tests | Tags | Authored by |
|---|------|-------|------|-------------|
| 13 | `slice-003-submit-update-supersedes.spec.ts` | 1 (sequential same-pair: first 200 → second 200; old `superseded_at` set + `superseded_by` linked; exactly one active row) | `@slice-003 @us2` | T019 |
| 14 | `slice-003-submit-concurrent-tabs.spec.ts` | 1 (two browser contexts as alpha; `Promise.all` POSTs on the same `(alpha, M6)` pair; advisory lock serializes; both 200; exactly one active row in DB) | `@slice-003 @us2` | T019 |
| 15 | `slice-003-me-predictions-after-supersede.spec.ts` | 1 (after a supersede, `GET /api/me/predictions?match_id=M6` returns exactly 1 entry — the active one; the superseded id is absent from the unfiltered list too) | `@slice-003 @us2` | T019 |

**Slice-003 Playwright test-count aggregate (US1 + US2)**: 13 (US1) + 3 (US2) = **16 tests across 15 spec files**.

**Cumulative Playwright aggregate at end of Phase 4**: 15 (slice 001) + 12 (slice 002) + 15 (slice 003) = **42 spec files**.

### 1c. Deno tests — `supabase/functions/`

**Slice 002 carry-forward** — unchanged. Slice 003 ships zero Edge Functions, so the Deno test set is unchanged from the slice-002 final gate. Re-running `deno test` is included in § 8 for completeness; slice-003 Phase 4 cannot regress these.

### 1d. node:test unit tests — `apps/web/lib/`

- `apps/web/lib/catalog/format.test.ts` (slice-002 T019, carry-forward).
- `apps/web/lib/predictions/countdown.test.ts` (slice-003 T014, carry-forward from Phase 3 — 5 boundary cases for `formatRemainingUntilLock`).

**Phase 4 added zero node:test files.**

### 1e. TypeScript compile

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web exec tsc --noEmit` | Project-wide strict compile of `apps/web/`. Phase 4 added **zero** app-code files — the only Phase 4 production change is migration 0037 (Postgres-side SP body). No TS surface changed since T016 / Phase 3. | **GREEN locally** per T015 + T016 implementation reports (no Docker dependency). |

### 1f. Next.js build

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web build` | Production-mode `next build`. Phase 4 introduced no new route handlers, lib files, or components — the existing `/api/predictions` POST handler (T015) calls the same `submit_prediction` SP whose **body** changed via migration 0037 but whose **signature** + ERRCODE surface (WCM01–WCM05) is byte-for-byte stable. | **GREEN locally** per T016 implementation report (no Docker dependency). |

---

## 2. Migration inventory — `supabase/migrations/`

**Slice 001 carry-forward** — 11 migrations (`0001`…`0011`), unchanged.

**Slice 002 carry-forward** — 12 migrations (`0018`…`0029`), unchanged.

**Slice 003 — cumulative through Phase 4** — **8 new migrations** (slots 0030…0037 per D-012 renumber). Phase 4 added exactly one: **0037**.

| # | File | T# | Phase | Summary |
|---|------|----|-------|---------|
| 0030 | `0030_predictions.sql` | T003 | 2 (Foundational) | Creates `public.prediction_source` enum (`ui` / `api` / `admin_override`), `public.predictions` table (UUID PK, FKs to `participants` + `matches`, non-negative score CHECKs, `source` enum, `superseded_at` / `superseded_by` nullable pair + `(superseded_at IS NULL) = (superseded_by IS NULL)` CHECK, audit columns), the `predictions_active_uk` unique partial index on `(participant_id, match_id) WHERE superseded_at IS NULL`, three secondary indexes, and a BEFORE-UPDATE trigger for `updated_at`. |
| 0031 | `0031_is_prediction_locked.sql` | T004 | 2 | Creates `public.is_prediction_locked(p_match_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE`. **LOCKED cross-slice predicate** — slice 004 / 005 / 006 consumers depend on this signature. |
| 0032 | `0032_predictions_rls.sql` | T005 | 2 | Enables + FORCEs RLS on `predictions`. SELECT policy `predictions_self_read` + admin SELECT policy. No INSERT/UPDATE/DELETE policies — only the SECURITY DEFINER SP may write. |
| 0033 | `0033_predictions_audit_trigger.sql` | T006 | 2 | AFTER INSERT / AFTER UPDATE of `superseded_at` SECURITY DEFINER trigger. Emits `prediction.created` (INSERT with `superseded_at IS NULL`) and `prediction.superseded` (UPDATE transitioning `superseded_at` from NULL → non-NULL). Recursion-guarded via `pg_trigger_depth()`. |
| 0034 | `0034_submit_prediction_sp.sql` | T013 | 3 (US1) | **Locked cross-slice SP** `public.submit_prediction(p_participant_id, p_match_id, p_home, p_away, p_source) RETURNS uuid SECURITY DEFINER`. T013 ships the CREATE branch + all 5 rejection branches (WCM01..WCM05). Provisional D-013 WCM06 branch on existing-active-row collision — **retired by T021** at slot 0037. |
| 0035 | `0035_lock_window_score_bound_seed.sql` | T007 | 2 | Inserts default `tournament_config` rows: `lock_window_minutes = 60`, `score_upper_bound = 20`. |
| 0036 | `0036_kickoff_correction_audit_trigger.sql` | T008 | 2 | AFTER UPDATE OF `kickoff_utc` trigger on `matches`. Emits one `audit_log` row (`action='prediction.kickoff_correction_crossed_lock'`) per active prediction on the affected match. Does NOT modify any `predictions` row — slice 006 admin tooling owns reopen/relock decisions. |
| **0037** | **`0037_submit_prediction_supersede.sql`** | **T021** | **4 (US2)** | **`CREATE OR REPLACE FUNCTION public.submit_prediction(...)`** — replaces the function body to add the supersede branch per `contracts/predictions.write.md` § Stored procedure semantics step 7. The signature is byte-identical to slot 0034. Implements the **3-step self-reference placeholder pattern** (see § 7 D-014 callout): (1) `UPDATE OLD SET superseded_at=now(), superseded_by=v_existing_id` (self-reference placeholder); (2) `INSERT NEW` with pre-generated `v_new_id`; (3) `UPDATE OLD SET superseded_by=v_new_id` (overwrite placeholder; audit trigger does NOT re-emit). **WCM06 ERRCODE is RETIRED** — the SP no longer raises it. D-013 marked **resolved**. |

**Slice 003 migrations aggregate**: **8 files** (0030–0037).

**Cumulative migration totals at end of Phase 4**: 11 (slice 001) + 12 (slice 002) + 8 (slice 003) = **31 migrations** on disk.

**Seed fixtures**: 3 files — `supabase/seed/slice-001-fixture.sql` (carry-forward) + `supabase/seed/slice-002-fixture.sql` (carry-forward) + `supabase/seed/slice-003-fixture.sql` (T009, carry-forward).

---

## 3. App code inventory — slice 003 additions

Slice 001's 7 app files and slice 002's 8 app files are unchanged. Slice 003 added 8 first-party app file touches in **Phase 3** (T014 + T015 + T016):

### 3a. Phase 3 — shared lib (T014)

| File | T# | Role |
|---|---|---|
| `apps/web/lib/predictions/types.ts` | T014 | Cross-slice `Prediction` / `PredictionSource` / `SubmitPredictionInput` / `SubmitPredictionResponse` / `MePredictionsResponse` TS shapes. |
| `apps/web/lib/predictions/client.ts` | T014 | `submitPrediction(client, input)` POSTs to `/api/predictions`; `getMyPredictions(client, matchId?)` GETs from `/api/me/predictions`. |
| `apps/web/lib/predictions/countdown.ts` | T014 | Pure-function `formatRemainingUntilLock(...)` — display-only countdown. |
| `apps/web/lib/predictions/countdown.test.ts` | T014 | `node:test` unit tests — 5 boundary cases. |

### 3b. Phase 3 — API routes (T015)

| File | T# | Role |
|---|---|---|
| `apps/web/app/api/predictions/route.ts` | T015 | `POST /api/predictions`. zod body validation, `requireEligible()`, calls `submit_prediction(...)` RPC, maps WCM01–WCM05 SQLSTATEs to 409 / 422 / 403 / 404. |
| `apps/web/app/api/me/predictions/route.ts` | T015 | `GET /api/me/predictions[?match_id=<uuid>]`. RLS-bound, `superseded_at IS NULL` filter. |

### 3c. Phase 3 — UI (T016)

| File | T# | Role |
|---|---|---|
| `apps/web/app/(participant)/matches/components/PredictionForm.tsx` | T016 (new) | `'use client'` form with home/away inputs + Submit. |
| `apps/web/app/(participant)/matches/page.tsx` | T016 (modified) | Reads `getMyPredictions(client)`; renders `<PredictionForm>` for editable rows. |

### 3d. Phase 4 — app code

**Phase 4 added ZERO new app code.** The Phase-4 production change is **migration 0037 only** — a `CREATE OR REPLACE FUNCTION` that swaps the SP body to add the supersede branch. The route handler in T015 catches the SP's return value (now a uuid pointing at either a freshly-inserted CREATE row or a freshly-inserted SUPERSEDE row) and returns the contract-shape response without code changes; the `/api/me/predictions` handler in T015 already filters `superseded_at IS NULL` so the active-row read shape is unchanged.

### 3e. App code summary

**Slice 003 app file touches (cumulative through Phase 4)**: 7 new + 1 modified (all from Phase 3) = **8 first-party app file touches**. Phase 4 adds **0**.

---

## 4. Expected GREEN state per test file (inferred, not observed)

Predictions below are inferred from file-level inspection of every authored test against the implementations now landed (T013 SP body + T015 routes + T016 UI + T021 supersede branch at slot 0037). Until Docker + Deno are up they are NOT observed.

### 4a. pgTAP — slice 003 US1 carry-forward (Phase 3)

All 4 files from `regression-checkpoint-us1.md § 4a` remain GREEN once Docker + db reset. The supersede branch added by slot 0037 does **not** regress any of them — `submit_prediction_create_happy.sql` still pre-deletes any active row for `(alpha, M4)` and the SP's new `v_existing_id IS NULL` ELSE branch performs the same plain INSERT as the T013 body. Validation + rejection branches (WCM01..WCM05) are untouched.

### 4b. pgTAP — slice 003 US2 additions (Phase 4)

- `submit_prediction_update_supersedes.sql` (`plan(6)`) → **GREEN once Docker + db reset**. Phase-4 SP body at slot 0037 supersedes OLD via the 3-step pattern; OLD's final `superseded_by = v_new_id` (set in step c.3); the slot-0033 audit trigger emits `prediction.superseded` (step c.1) and `prediction.created` (step c.2) in the same transaction.
- `submit_prediction_audit_format.sql` (`plan(5)`) → **GREEN once Docker + db reset**, subject to the **D-014 caveat below**. A3 asserts `new_value->>'superseded_at' IS NOT NULL` — that holds (step c.1 sets `superseded_at = now()` AND the trigger captures the post-UPDATE row). A4 actor on the supersede audit row = `(SELECT created_by FROM predictions WHERE id = NEW.superseded_by)` — at step c.1 the trigger reads `NEW.superseded_by = v_existing_id` (the placeholder), so the actor is OLD's own `created_by` = alpha (correct for this assertion since both rows are alpha's). A5 audit-row count = 3 (2 `prediction.created` + 1 `prediction.superseded`). **D-014 caveat**: the assertion file does NOT compare `new_value->>'superseded_by'` against `v_new_id`; if a future revision of this pgTAP file adds such an assertion, it WILL FAIL because the audit row carries the self-reference placeholder, not the final chain successor. Document the workaround in § 7.

### 4c. pgTAP — slices 001 + 002 carry-forward

All 21 carry-forward pgTAP files (12 slice-001 + 9 slice-002) expected GREEN exactly as documented in `specs/001-eligibility-login/regression-final.md` and `specs/002-match-catalog/regression-final.md`. Phase 4 did not modify any slice-001 / slice-002 function, table, RLS policy, audit trigger, or seed.

### 4d. Playwright — slice 003 US1 carry-forward (Phase 3)

All 13 tests across 12 spec files from `regression-checkpoint-us1.md § 4c` remain GREEN. Phase 4 introduced zero route-handler / UI changes; the SP signature + ERRCODE surface is byte-stable; the supersede branch does not fire on any US1 happy path (US1 tests target either a fresh `(participant, match)` pair or assert a rejection ERRCODE before any INSERT could occur).

### 4e. Playwright — slice 003 US2 additions (Phase 4)

- `slice-003-submit-update-supersedes.spec.ts` → **GREEN once Docker + dev running**. First POST `(alpha, M6, 1, 0)` returns 200 (CREATE branch, `v_existing_id IS NULL`). Second POST `(alpha, M6, 2, 1)` returns 200 (SUPERSEDE branch, `v_existing_id` = first row). Direct DB check confirms first row has `superseded_at IS NOT NULL` + `superseded_by` linking to the second row; exactly one active row exists for `(alpha, M6)`.
- `slice-003-submit-concurrent-tabs.spec.ts` → **GREEN once Docker + dev running**. Per-pair advisory lock (`pg_advisory_xact_lock`) serializes the two concurrent POSTs; the winner's INSERT goes through the CREATE branch, the loser sees an active row and goes through the SUPERSEDE branch. Both return 200. Final DB state: 1 active + 1 superseded = 2 rows.
- `slice-003-me-predictions-after-supersede.spec.ts` → **GREEN once Docker + dev running**. After a supersede, `GET /api/me/predictions[?match_id=M6]` returns only the active row (T015's `superseded_at IS NULL` SQL filter — unchanged in Phase 4).

### 4f. Playwright — slices 001 + 002 carry-forward

All 27 carry-forward Playwright spec files (15 slice-001 + 12 slice-002) expected GREEN per their final gates. Phase 4 did not modify any slice-001 / slice-002 surface.

### 4g. Static + build + node:test

- `pnpm -F web exec tsc --noEmit` → **GREEN**, last-known (no Phase-4 TS changes).
- `pnpm -F web build` → **GREEN**, last-known (no Phase-4 build surface changes).
- `pnpm -F web exec node --test apps/web/lib/predictions/countdown.test.ts` → **GREEN**, last-known.

---

## 5. Aggregate totals at end of Phase 4

| Surface | Slice 001 | Slice 002 | Slice 003 (US1 + US2 cumulative) | Total |
|---|---|---|---|---|
| Migrations | 11 | 12 | 8 | **31** |
| pgTAP files | 12 | 9 | 6 | **27** |
| Playwright specs | 15 | 12 | 15 | **42** |
| Playwright tests (slice-003 only) | — | — | 16 (13 US1 + 3 US2) | — |
| node:test unit files | 0 | 1 | 1 | 2 |
| First-party app files | 7 | 8 | 7 new + 1 modified (all Phase 3) | **22 new + 1 modified** |
| Seed fixtures | 1 | 1 | 1 | 3 |

---

## 6. Cross-slice contracts now locked by slice 003 Phase 4

In addition to the contracts locked by slices 001 + 002 (`is_eligible_nortal_participant`, `is_admin`, `participants`, `audit_log`, `tournament_config`, `matches`, the catalog route, etc.) AND the slice-003 Phase-3 locks documented in `regression-checkpoint-us1.md § 6` (the `predictions` table column names, the `prediction_source` enum body, the `is_prediction_locked(uuid)` signature, the `submit_prediction(...)` signature, the WCM01–WCM05 ERRCODE list, the `POST /api/predictions` + `GET /api/me/predictions` wire shapes, the `audit_log.action` vocabulary), **Phase 4 adds the following lock**:

| Symbol / shape | Lock | Consumers |
|---|---|---|
| **Supersede pattern semantics in `submit_prediction(...)` body** — the 3-step self-reference placeholder (UPDATE OLD with `superseded_by=v_existing_id`; INSERT NEW with pre-generated `v_new_id`; UPDATE OLD with `superseded_by=v_new_id`) is the canonical supersede implementation. **Any future slice modifying the SP MUST preserve this 3-step ordering OR add a separate migration first to make the `predictions_superseded_by_fkey` FK + the `predictions_active_uk` partial unique index DEFERRABLE** (and PARTIAL UNIQUE INDEXES are never DEFERRABLE in Postgres — only UNIQUE CONSTRAINTS are — so the alternative path requires converting the unique partial index to a partial UNIQUE constraint first, which is a non-trivial schema-altering migration). | Slice 006 (admin override path — when implementing `source='admin_override'` writes via the SP); any future slice that issues bulk corrections; any future migration that touches the supersede branch. |

The Phase-3 locks remain in force. In particular, the WCM01–WCM05 ERRCODE list is **still** the locked cross-slice ERRCODE list — Phase 4 retires WCM06 (it was never cross-slice locked per D-013) and does not introduce any new ERRCODE.

---

## 7. D-014 callout — supersede self-reference placeholder caveat

**D-014 (surfaced during T021 review, 2026-05-20)**: T021's supersede SP body cannot use a naïve "UPDATE OLD then INSERT NEW" ordering because the `predictions_active_uk` partial UNIQUE INDEX (slot 0030) is **non-deferrable** (PostgreSQL partial unique indexes are never deferrable — only UNIQUE constraints can be) and the `predictions_superseded_by_fkey` FK is also non-deferrable. The 3-step **self-reference placeholder** is the no-schema-change workaround:

1. **Step c.1 — UPDATE OLD `SET superseded_at = now(), superseded_by = v_existing_id` (self-reference).** Satisfies all three constraints: OLD now leaves the partial unique index (superseded_at is non-NULL); the FK `superseded_by = v_existing_id` points at OLD itself (already exists); the table CHECK `(superseded_at IS NULL) = (superseded_by IS NULL)` is satisfied (both non-NULL).
2. **Step c.2 — INSERT NEW** with pre-generated `v_new_id`. No unique-index conflict because OLD is already superseded.
3. **Step c.3 — UPDATE OLD `SET superseded_by = v_new_id`.** Replaces the placeholder. The audit trigger does NOT re-emit (`OLD.superseded_at IS NOT NULL` already, so the supersede-transition guard `OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL` is false).

**Audit-row inconsistency** (the unavoidable cost of the workaround): the `prediction.superseded` audit row emitted by step c.1 carries `new_value->>'superseded_by'` = `v_existing_id` (OLD's **own** id, the placeholder), **NOT** the final `v_new_id`. The `predictions` table's final state is correct (step c.3 sets `OLD.superseded_by = v_new_id`); only the audit-row JSON snapshot captured at step c.1 carries the stale placeholder.

**Impact on T018 audit-format pgTAP test**: the file authored by T018 (`submit_prediction_audit_format.sql`) asserts `new_value->>'superseded_at' IS NOT NULL` on the supersede row — that **holds** (step c.1 sets it). It does NOT assert `new_value->>'superseded_by' = v_new_id`, so the test is **safe**. **A future revision of this file MUST NOT add that assertion**; if it must, the assertion has to compare against `v_existing_id` (the placeholder) or query `predictions.superseded_by` directly.

**Slice 007 (and any future audit-forensic reader) guidance**: reconstruct supersede chains from `predictions.superseded_by` (the **current-state** column on the table), **NOT** from `audit_log.new_value->>'superseded_by'`. The audit log captures the placeholder, not the chain successor. Cross-reference: the corresponding `prediction.created` audit row carries the real `v_new_id` in `entity_id`, so a JOIN of `audit_log` filtered to `(entity_type='prediction', action='prediction.created')` against the OLD `prediction.superseded` row via timestamp + actor is the recommended forensic reconstruction path; alternatively (cleaner), trust `predictions.superseded_by` as the source of truth.

**Alternative considered + rejected** (also recorded in D-014 in `tasks.md`): add a separate migration 0038 to make `predictions_superseded_by_fkey` DEFERRABLE and `SET CONSTRAINTS … DEFERRED` inside the SP. Cleaner audit log, but (a) the partial unique index `predictions_active_uk` is **still** non-deferrable so the migration must additionally convert it to a partial UNIQUE constraint, doubling the schema-altering surface mid-slice; (b) it pushes the supersede branch outside the slice-3-tasks scope without a compelling reason. Self-reference placeholder is the chosen path; the audit-log inconsistency is documented here and in D-014 (`tasks.md` § Implementation deviations) for slice 007 to address if a forensic need actually surfaces.

---

## 8. Verification commands (operator runbook)

Run from the repo root on branch `003-match-predictions` in order. Stop on the first non-zero exit. PowerShell variants given; bash equivalents follow.

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all 31 migrations
#    (slice 001's 0001..0011 + slice 002's 0018..0029 + slice 003's 0030..0037
#    per D-012 renumber) and loads the three seed fixtures
#    (supabase/seed/slice-001-fixture.sql + slice-002-fixture.sql + slice-003-fixture.sql).
supabase db reset

# 3a. Run every slice-003 submit_prediction pgTAP file (6 files — 4 US1 + 2 US2).
Get-ChildItem supabase/tests/pgtap -Filter 'submit_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 3b. Carry-forward regression sweep — every slice-001 + slice-002 pgTAP file (21 files).
Get-ChildItem supabase/tests/pgtap -Filter '*.sql' -Exclude 'submit_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 4. TypeScript strict compile of the web app (last-known GREEN; no Phase-4 TS surface changes).
pnpm -F web exec tsc --noEmit

# 5. Production-mode Next.js build (last-known GREEN; no Phase-4 build surface changes).
pnpm -F web build

# 6. node:test unit suite — countdown helper (carry-forward from Phase 3).
pnpm -F web exec node --test apps/web/lib/predictions/countdown.test.ts

# 7. Start the Next.js dev server (Playwright fixtures depend on it).
#    Run in a separate terminal; the suite will tear it down after.
pnpm -F web dev

# 8. Playwright suite — slice-003 US1 + US2 scope (expect 16/16 GREEN: 13 US1 + 3 US2).
pnpm -F web e2e -- --grep '@slice-003 (@us1|@us2)'

# 9. Optional cross-slice regression sweep.
pnpm -F web e2e -- --grep '@slice-001'
pnpm -F web e2e -- --grep '@slice-002'

# 10. Slice-002 Deno carry-forward (requires Deno toolchain installed).
deno test supabase/functions/
```

Bash equivalents (run instead of steps 3a / 3b on a POSIX shell):

```bash
for f in supabase/tests/pgtap/submit_prediction_*.sql; do supabase test db "$f" || exit 1; done
for f in supabase/tests/pgtap/*.sql; do
  case "$(basename "$f")" in submit_prediction_*) ;; *) supabase test db "$f" || exit 1 ;; esac
done
```

A passing run produces:

- **Step 3a**: 6 files; `ok 1..6` / `ok 1..3` / `ok 1..2` / `ok 1..2` / `ok 1..6` / `ok 1..5` respectively = **24 ok assertions** across `submit_prediction_*`.
- **Step 3b**: 21 files green at the totals documented in slice 001's `regression-final.md` and slice 002's `regression-final.md`.
- **Step 4**: no output, exit 0.
- **Step 5**: build succeeds; the route-handler manifest is unchanged from Phase 3 (no new routes in Phase 4).
- **Step 6**: 5 `ok` lines from `countdown.test.ts`.
- **Step 8**: 16 of 16 slice-003 US1+US2 tests passed (13 US1 + 3 US2).
- **Step 9**: 14/15 slice-001 (smoke is untagged) + slice-002 set per their gates.
- **Step 10**: every Deno suite green (no slice-003 additions).

---

## 9. Open deferred work blocking a fully observed GREEN

The following items were authored or invoked but their **execution-time verification** was deferred due to Docker being down or Deno not being installed. None block this documentation artifact — they block the runtime confirmation that the suite is observably GREEN.

### 9a. Slice 001 carry-forward (9 items, unchanged from slice 001's final gate)

| Task | Why deferred | What still needs running |
|---|---|---|
| T005 (slice 001) | pgTAP harness smoke — Docker down | `supabase test db supabase/tests/pgtap/_harness_smoke.sql`. |
| T006 (slice 001) | OIDC stub `supabase start` boot — Docker down | Confirm OIDC sidecar URL reachable. |
| T007 (slice 001) | CI workflow PR-trigger verification — repo not yet pushed | Open a PR; observe `.github/workflows/ci.yml`. |
| T021 (slice 001) | US1 RED-gate runtime — Docker down | Slice-001 stash-and-test recipe. |
| T031 (slice 001) | US2 RED-gate runtime — Docker down | Slice-001 stash-and-test for US2. |
| T035 (slice 001) | US2 regression-checkpoint runtime — Docker down | Slice 001's § 7 commands. |
| T039 (slice 001) | US3 RED-gate runtime — Docker down | Slice-001 stash-and-test for US3. |
| T041 (slice 001) | US3 regression-checkpoint runtime — Docker down | Slice 001's § 7 commands. |
| T044 (slice 001) | Quickstart 8-step manual — Docker down | `specs/001-eligibility-login/quickstart-verification.md` steps 1–8. |

### 9b. Slice 002 carry-forward (4 Docker-dependent + Deno items, unchanged from slice 002's final gate)

| Task | Why deferred | What still needs running |
|---|---|---|
| T001 (slice 002) | Joint baseline runtime | Implicit in steps 1–3b of § 8. |
| T002 (slice 002) | `pg_cron` + `pg_net` extension boot — Docker down | `supabase start && psql -c "SELECT extname FROM pg_extension"`. |
| T018 (slice 002) | US1 RED-gate runtime — Docker down | Slice-002 stash-and-test for US1. |
| T022 (slice 002) | Slice-002 US1 regression checkpoint — Docker down | Slice-002 § 7. |
| Slice-002 Deno suite (carry-forward) | Deno not installed locally | `deno test supabase/functions/` once Deno is installed. |

### 9c. Slice 003 Docker-dependent deferrals (cumulative through Phase 4 — 13 items)

| Task | Why deferred | What still needs running |
|---|---|---|
| T001 (slice 003) | Joint baseline — Docker down + Deno absent | § 8 steps 1–3b + 10. |
| T010 (slice 003) | pgTAP authoring (US1) — runtime was not observed RED | § 8 step 3a in a stash-and-test recipe (see `red-gate-us1.md`). |
| T011 (slice 003) | Playwright authoring (US1) — runtime was not observed RED | § 8 steps 7–8 in stash-and-test. |
| T012 (slice 003) | US1 RED-gate runtime — Docker down | Full stash-and-test recipe per `red-gate-us1.md § Verification commands`. |
| T013 (slice 003) | SP migration (CREATE) runtime — Docker down | § 8 step 3a post-`supabase db reset`. |
| T015 (slice 003) | Route handlers runtime — Docker down + dev server not booted | § 8 steps 7–8. |
| T016 (slice 003) | UI runtime — Docker down + dev server not booted | § 8 steps 7–8 + manual visual verification at `/matches`. |
| T017 (slice 003) | Phase-3 regression-checkpoint runtime — Docker down + Deno absent | Execute Phase-3 § 8 step set. |
| T018 (slice 003) | pgTAP authoring (US2) — runtime was not observed RED | § 8 step 3a in a stash-and-test recipe (see `red-gate-us2.md`). |
| T019 (slice 003) | Playwright authoring (US2) — runtime was not observed RED | § 8 steps 7–8 in stash-and-test. |
| T020 (slice 003) | US2 RED-gate runtime — Docker down | Full stash-and-test recipe per `red-gate-us2.md § Verification commands`. |
| T021 (slice 003) | SP migration (SUPERSEDE) runtime — Docker down | § 8 step 3a post-`supabase db reset` (the GREEN side of the stash-and-test). |
| **T022 (this doc)** | Runtime suite GREEN under live Docker — Docker down + Deno absent | Execute § 8 steps 1–10 above. |

### 9d. D-014 follow-on (informational, NOT blocking merge)

The audit-row inconsistency described in § 7 is **documented and known**. It does NOT block US3 / US4 / Polish / merge — the predictions table's current state remains correct, and no slice in the current roadmap reads `audit_log.new_value->>'superseded_by'` as a chain successor. Slice 007 (audit-forensic surfaces, if/when planned) should consume `predictions.superseded_by` as the source of truth for chain reconstruction. If a future audit-forensic requirement does need the chain successor to live in `audit_log.new_value`, schedule a DEFERRABLE-FK migration (with the accompanying conversion of `predictions_active_uk` from a partial unique index to a partial UNIQUE constraint) at that time.

---

## 10. Spec deviations consolidated (D-001 through D-014)

Carry-forward from slices 001 + 002 (D-001 through D-011) + slice 003 additions (D-012 through D-014). Full bodies live in the source files referenced.

| ID | Where recorded | One-liner |
|---|---|---|
| D-001 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`. Slice 003's `requireEligible()` re-check on every `/api/predictions` POST inherits the renamed hook path. |
| D-002 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `is_approved_domain(p_email text)` takes a FULL email. Inherited via the shared `requireEligible()` helper. |
| D-003 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `/api/me` body shape `{ participant: {...} }`; errors `{ error: { code, message } }` with `Cache-Control: private, max-age=0, must-revalidate`. Slice 003's `/api/predictions` and `/api/me/predictions` mirror the envelope byte-for-byte. |
| D-004 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `participants_self_or_admin_read` policy embeds the eligibility predicate (combined OR'd). Slice 003's `predictions_self_read` policy follows the same pattern. |
| D-005 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `handle_auth_user_signed_in` returns the `custom_access_token` envelope. Relevant to slice 003 via session refresh on the predictions page. |
| D-006 | `specs/002-match-catalog/tasks.md` § Implementation deviations | Wave-2 schema reconciliation. As-built migrations authoritative for slice 003's lock-window calculation in `is_prediction_locked(uuid)`. |
| D-007 | `specs/002-match-catalog/tasks.md` § Implementation deviations | `match_results` field-name mapping in `/api/matches`. Not directly exercised by US1 / US2. |
| D-008 | `specs/002-match-catalog/tasks.md` § Implementation deviations | pgTAP cannot observe `pg_notify`; slice-003 audit triggers do not emit notifications — informational only. |
| D-009 | `specs/002-match-catalog/tasks.md` § Implementation deviations | `audit_log.action` name mismatch in slice-002. Slice 003 pins `'prediction.created'` / `'prediction.superseded'` exactly. |
| D-010 | `specs/002-match-catalog/tasks.md` § Implementation deviations | sync-coordinator vs Deno tests vs migration 0022 gaps — not exercised by US1 / US2. |
| D-011 | `specs/002-match-catalog/tasks.md` § Implementation deviations | `audit_log.source` enum gaps — slice 003 reuses `source='trigger'`; already allowed. |
| D-012 | `specs/003-match-predictions/tasks.md` lines 48–63 | Migration slot renumber: slice-003 migrations shifted +1 (T013 lives at on-disk slot **0034**, T021 at slot **0037**, not the spec's 0033 / 0036). Tests reference function/table names; no test-file change required. |
| D-013 | `specs/003-match-predictions/tasks.md` lines 65–70 | `submit_prediction` provisional `WCM06` branch in T013. **Resolved (2026-05-20, T021)**: migration 0037 retires WCM06 and replaces with the supersede UPDATE+INSERT pattern. |
| **D-014** | `specs/003-match-predictions/tasks.md` lines 72–81 | **NEW (this phase)**: T021's supersede SP body uses a 3-step self-reference placeholder because `predictions_active_uk` (partial unique INDEX) and `predictions_superseded_by_fkey` (FK) are both non-deferrable. Consequence: the `prediction.superseded` audit row's `new_value->>'superseded_by'` carries OLD's own id (the placeholder), not the final `v_new_id`. T018's audit-format test does not assert this field against `v_new_id` so it remains GREEN. Slice 007 forensic readers must reconstruct supersede chains from `predictions.superseded_by`, NOT from `audit_log.new_value`. See § 7 above. |

No D-015 reserved by Phase 4; next deviation slot for US3 / US4 / Polish work is D-015.

---

## 11. Pre-merge action items (operator checklist)

Tick each box before opening (or merging) the slice-003 PR.

- [ ] Docker Desktop running and healthy on the verifying machine (`docker info` exits 0).
- [ ] Deno toolchain installed (`deno --version` exits 0) — required by the slice-002 carry-forward step 10.
- [ ] § 8 step 1 (`supabase start`) succeeds.
- [ ] § 8 step 2 (`supabase db reset`) applies all 31 migrations cleanly and loads all three seed fixtures with no errors.
- [ ] § 8 step 3a (slice-003 pgTAP) reports 24 ok lines across `submit_prediction_create_happy.sql` (6) + `submit_prediction_invalid_score.sql` (3) + `submit_prediction_invalid_match.sql` (2) + `submit_prediction_ineligible.sql` (2) + `submit_prediction_update_supersedes.sql` (6) + `submit_prediction_audit_format.sql` (5).
- [ ] § 8 step 3b (slice-001 + slice-002 pgTAP carry-forward) reports all 21 files green at the documented assertion totals.
- [ ] § 8 step 4 (`pnpm -F web exec tsc --noEmit`) exits 0 with no output.
- [ ] § 8 step 5 (`pnpm -F web build`) succeeds and the build manifest matches the Phase-3 baseline (no new routes in Phase 4).
- [ ] § 8 step 6 (`node --test apps/web/lib/predictions/countdown.test.ts`) reports 5 ok lines.
- [ ] § 8 step 8 (`pnpm -F web e2e -- --grep '@slice-003 (@us1|@us2)'`) reports 16 of 16 slice-003 tests passed (13 US1 + 3 US2).
- [ ] § 8 step 9 (slice-001 + slice-002 Playwright carry-forward) reports slice-001 / slice-002 green at their final-gate totals.
- [ ] § 8 step 10 (slice-002 Deno carry-forward) green (or noted as Deno-absent).
- [ ] § 9a (slice 001 deferrals) ticked GREEN on slice 001's gate.
- [ ] § 9b (slice 002 deferrals) ticked GREEN on slice 002's gate.
- [ ] § 9c (slice 003 deferrals) — every T001, T010, T011, T012, T013, T015, T016, T017, T018, T019, T020, T021, T022 observably GREEN against the live stack.
- [ ] § 9d / D-014 acknowledged in PR description; future audit-forensic readers (slice 007 if/when planned) called out to consume `predictions.superseded_by`, not `audit_log.new_value`.
- [ ] PR description references this file (`specs/003-match-predictions/regression-checkpoint-us2.md`), plus `red-gate-us2.md`, `regression-checkpoint-us1.md`, `red-gate-us1.md`, `regression-baseline-from-001-002.md`, and (once they exist) `regression-checkpoint-us3.md`, `regression-checkpoint-us4.md`, and `regression-final.md`.

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack (+ Deno toolchain for the carry-forward Deno suite) is the merge gate. Until every box above is ticked, Phase 5 (US3) MAY NOT start, Phase 6 (US4) MAY NOT start, the Polish phase MAY NOT start, and slice 003 MAY NOT merge to `main`.
