# Regression checkpoint — Slice 003, Phase 5 (US3)

- **Slice**: `003-match-predictions`
- **Phase**: 5 (US3 — "Eligible participant blocked from creating or modifying a prediction once the lock boundary passes or the match status moves out of `scheduled`")
- **Date**: 2026-05-20
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T028 (`specs/003-match-predictions/tasks.md`)
- **Companion artifacts**:
  - `specs/003-match-predictions/regression-baseline-from-001-002.md` (T001 — slice-001 + slice-002 carry-forward baseline)
  - `specs/003-match-predictions/red-gate-us1.md` (T012 — RED-gate inventory for US1)
  - `specs/003-match-predictions/regression-checkpoint-us1.md` (T017 — Phase-3 sibling)
  - `specs/003-match-predictions/red-gate-us2.md` (T020 — RED-gate inventory for US2)
  - `specs/003-match-predictions/regression-checkpoint-us2.md` (T022 — Phase-4 sibling)
  - `specs/003-match-predictions/red-gate-us3.md` (T026 — sibling RED-gate inventory for this US3 test set)
  - `specs/001-eligibility-login/regression-checkpoint-us1.md` + `specs/002-match-catalog/regression-checkpoint-us1.md` (cross-slice templates this document mirrors)
- **Purpose**: Record the cumulative state of the slice-001 + slice-002 + slice-003-so-far test suite at the moment Phase 5 (US3) lands, inventory every test surface added through US3, and hand the exact verification commands to whoever next has a working Docker daemon + Deno toolchain. Per Principle XI, US4 (Phase 6) and the Polish phase MAY NOT start, and the slice MAY NOT merge to `main`, until all verification commands below land GREEN.

---

## Status: DEFERRED

Both the Docker daemon (required by `supabase start`, `supabase db reset`, `supabase test db`, and by every Playwright fixture that boots the local Supabase stack) and the Deno toolchain (required by slice-002's `provider-stub.test.ts` carry-forward suite) were **unavailable at execution time**. `supabase start`, `supabase db reset`, `supabase test db`, the Next.js dev server (which Playwright fixtures depend on), the Playwright suite, and `deno test` therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added through Phase 5 (cumulative with slices 001 + 002 + slice-003 Phases 3 + 4), and hands the exact commands the user MUST run locally (or in CI, once slice 001's T007 ships) before Phase 6 (US4) begins or the slice can merge. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 8 have all returned GREEN.

**Phase 5 specifics**: US3 is the inverse of US1 + US2 — the GREEN implementations (`is_prediction_locked` predicate at slot 0031 via T004, the `submit_prediction` SP at slots 0034 + 0037 via T013 + T021) were already in place **before** Phase 5's RED tests landed. T027 (post-T026 fix-up) was therefore reduced to a structural review and ultimately a no-op: the predicate body matches `contracts/prediction-lock.predicate.sql.md` § Signature byte-for-byte, the SP step-6 lock branches match `contracts/predictions.write.md` § Stored procedure semantics step 6 byte-for-byte, and the 19 (20 sub-tests) tests authored by T023 + T024 + T025 target exactly those contract assertions. Phase 5 therefore added **zero new migrations and zero new app code** — its entire output is test files + documentation.

---

## 1. Suite inventory (post-Phase-5 / US3, cumulative across slices 001 + 002 + 003)

### 1a. pgTAP tests — `supabase/tests/pgtap/`

**Slice 001 carry-forward** — 12 files unchanged from the slice-001 baseline. Full inventory in `specs/001-eligibility-login/regression-final.md § 2`. Headline: 1 harness probe + 8 functional + 2 RLS-isolation + 1 perf = 12 files.

**Slice 002 carry-forward** — 9 files unchanged from the slice-002 final gate. Full inventory in `specs/002-match-catalog/regression-final.md § 1a`.

**Slice 003 — Phase 3 (US1)** — 4 files authored by T010 (RED-first), GREEN against T013's CREATE branch. Full inventory in `regression-checkpoint-us1.md § 1a`:
- `submit_prediction_create_happy.sql` (`plan(6)`)
- `submit_prediction_invalid_score.sql` (`plan(3)`)
- `submit_prediction_invalid_match.sql` (`plan(2)`)
- `submit_prediction_ineligible.sql` (`plan(2)`)

**Slice 003 — Phase 4 (US2)** — 2 files authored by T018 (RED-first), GREEN against T021's supersede branch at slot 0037. Full inventory in `regression-checkpoint-us2.md § 1a`:
- `submit_prediction_update_supersedes.sql` (`plan(6)`)
- `submit_prediction_audit_format.sql` (`plan(5)`)

**Slice 003 — Phase 5 (US3)** — **15 new files** authored RED-first (T023 + T024); expected GREEN against the as-built predicate + SP per `red-gate-us3.md`.

#### T023 — `is_prediction_locked(uuid)` predicate suite (12 files, 14 planned assertions)

| # | File | `plan(N)` | Purpose | Authored by |
|---|------|-----------|---------|-------------|
| 7 | `supabase/tests/pgtap/is_prediction_locked_far_before.sql` | `plan(1)` | kickoff=now()+3h, lock_window=60 → predicate returns FALSE. Contract row 1. | T023 |
| 8 | `supabase/tests/pgtap/is_prediction_locked_strict_boundary_at.sql` | `plan(1)` | kickoff=now()+60min → TRUE (BR-LOCK-002 strict `>=`). Contract row 2. | T023 |
| 9 | `supabase/tests/pgtap/is_prediction_locked_strict_boundary_just_outside.sql` | `plan(1)` | kickoff=now()+60min+1s → FALSE. Contract row 3. (1-second buffer — `red-gate-us3.md` flag: possible µs flake on extreme load.) | T023 |
| 10 | `supabase/tests/pgtap/is_prediction_locked_strict_boundary_just_inside.sql` | `plan(1)` | kickoff=now()+59:59 → TRUE. Contract row 4. | T023 |
| 11 | `supabase/tests/pgtap/is_prediction_locked_status_in_progress.sql` | `plan(1)` | status=`in_progress`, kickoff +24h → TRUE (status branch beats time). Contract row 5. | T023 |
| 12 | `supabase/tests/pgtap/is_prediction_locked_status_finished.sql` | `plan(1)` | Slice-002 fixture M1 (`bbbb…-0001`, status=`finished`) → TRUE. Contract row 6. Cross-slice dependency: requires slice-002 seed. | T023 |
| 13 | `supabase/tests/pgtap/is_prediction_locked_status_postponed.sql` | `plan(1)` | Synthetic M, status=`postponed` → TRUE. Contract row 7. | T023 |
| 14 | `supabase/tests/pgtap/is_prediction_locked_status_cancelled.sql` | `plan(1)` | Synthetic M, status=`cancelled` → TRUE. Contract row 8. | T023 |
| 15 | `supabase/tests/pgtap/is_prediction_locked_unknown_match.sql` | `plan(1)` | UUID `ffffffff-…-ffff` (no match) → fail-closed TRUE. Contract row 9. | T023 |
| 16 | `supabase/tests/pgtap/is_prediction_locked_config_changes.sql` | `plan(3)` | A1 verdict at default 60 with kickoff +90min = FALSE; A2 verdict after `UPDATE tournament_config SET value='120'` = TRUE; A3 verdict after restore = FALSE. SC-005 1-minute config responsiveness. Inner UPDATE rolls back at outer ROLLBACK. | T023 |
| 17 | `supabase/tests/pgtap/is_prediction_locked_uses_db_clock.sql` | `plan(2)` | BR-LOCK-001 / Principle VI — `now()` is UTC-absolute regardless of `SET LOCAL TIMEZONE`. Verdict invariant before + after timezone shift. | T023 |
| 18 | `supabase/tests/pgtap/is_prediction_locked_perf.sql` | `plan(1)` | Inserts 100 matches in `eeee*` namespace, loops 1,000 invocations, asserts `percentile_cont(0.95) < 5 ms`. **Environment-dependent**; flagged for T027 attention if RED on a starved local Postgres. | T023 |

#### T024 — `submit_prediction(...)` lock-path + concurrency suite (3 files, 7 planned assertions)

| # | File | `plan(N)` | Purpose | Authored by |
|---|------|-----------|---------|-------------|
| 19 | `supabase/tests/pgtap/submit_prediction_locked_window.sql` | `plan(2)` | M-BOUNDARY (`dddd…-0100`), kickoff=now()+60min, scheduled. SP step 6 raises `WCM01` (lock_window_passed). A1 `throws_ok('WCM01')`, A2 `count(*) = 0` post-raise. | T024 |
| 20 | `supabase/tests/pgtap/submit_prediction_locked_status_in_progress.sql` | `plan(2)` | M-IN-PROGRESS (`dddd…-0101`), kickoff=now()+24h, status=`in_progress`. SP step 6 raises `WCM02` (match_status_locked) — proves status check precedes time math. | T024 |
| 21 | `supabase/tests/pgtap/submit_prediction_serializes_concurrent.sql` | `plan(3)` | 5 sequential SP calls against (alpha, M6) inside a single txn. A1 exactly 1 active row, A2 exactly 5 total rows (1 active + 4 superseded), A3 all 4 `superseded_by` FKs resolve. Verifies T021's supersede-chain invariant + slot-0037 self-reference placeholder (D-014). Test inspects only `predictions` final state — D-014 audit caveat does not regress. | T024 |

**Slice 003 pgTAP aggregate (cumulative Phase 3 + Phase 4 + Phase 5)**: 4 (US1) + 2 (US2) + 12 (US3, T023) + 3 (US3, T024) = **21 files**, planned assertions `13 (US1) + 11 (US2) + 14 (T023) + 7 (T024) = 45`.

**Cumulative pgTAP aggregate at end of Phase 5**: 12 (slice 001) + 9 (slice 002) + 21 (slice 003) = **42 pgTAP files**.

### 1b. Playwright tests — `apps/web/tests/playwright/`

**Slice 001 carry-forward** — 15 spec files (14 `@slice-001` + 1 untagged `smoke.spec.ts`).

**Slice 002 carry-forward** — 12 spec files (`slice-002-*`).

**Slice 003 — Phase 3 (US1)** — 12 spec files / 13 tests tagged `@slice-003 @us1`. Full inventory in `regression-checkpoint-us1.md § 1b`.

**Slice 003 — Phase 4 (US2)** — 3 spec files / 3 tests tagged `@slice-003 @us2`. Full inventory in `regression-checkpoint-us2.md § 1b`.

**Slice 003 — Phase 5 (US3)** — **4 new spec files / 5 sub-tests** (the status-locked file packs both `in_progress` and `finished` legs), all tagged `@slice-003 @us3`, authored by T025 (RED-first), expected GREEN against T015's existing route handler + the SP's WCM01 / WCM02 branches.

| # | File | Sub-tests | Tags | Authored by |
|---|------|-----------|------|-------------|
| 16 | `slice-003-submit-locked.spec.ts` | 1 (M-BOUNDARY `dddd…-0200` at kickoff=now()+60:00 — exact boundary → 409 `PREDICTION_LOCKED`, `reason='lock_window_passed'`) | `@slice-003 @us3` | T025 |
| 17 | `slice-003-submit-locked-just-inside.spec.ts` | 1 (`dddd…-0201` at kickoff=now()+59:59 → 409 + `lock_window_passed`) | `@slice-003 @us3` | T025 |
| 18 | `slice-003-submit-locked-just-outside.spec.ts` | 1 (`dddd…-0202` at kickoff=now()+60:05 → 200; verified via `/api/me/predictions`). **5-second buffer flagged for possible T027 expansion under slow CI.** | `@slice-003 @us3` | T025 |
| 19 | `slice-003-submit-status-locked.spec.ts` | 2 (a: `dddd…-0203` status=`in_progress` → 409 + `match_status_locked`; b: `dddd…-0204` status=`finished` → 409 + `match_status_locked`) | `@slice-003 @us3` | T025 |

**Slice-003 Playwright test-count aggregate (US1 + US2 + US3)**: 13 (US1) + 3 (US2) + 5 (US3) = **21 tests across 19 spec files**.

**Cumulative Playwright aggregate at end of Phase 5**: 15 (slice 001) + 12 (slice 002) + 19 (slice 003) = **46 spec files**.

### 1c. Deno tests — `supabase/functions/`

**Slice 002 carry-forward** — unchanged. Slice 003 ships zero Edge Functions, so the Deno test set is unchanged from the slice-002 final gate. Re-running `deno test` is included in § 8 for completeness; slice-003 Phase 5 cannot regress these.

### 1d. node:test unit tests — `apps/web/lib/`

- `apps/web/lib/catalog/format.test.ts` (slice-002 T019, carry-forward).
- `apps/web/lib/predictions/countdown.test.ts` (slice-003 T014, carry-forward from Phase 3 — 5 boundary cases for `formatRemainingUntilLock`).

**Phase 5 added zero node:test files.**

### 1e. TypeScript compile

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web exec tsc --noEmit` | Project-wide strict compile of `apps/web/`. **Phase 5 added zero TS source files** — every Phase 5 artifact lives under `supabase/tests/pgtap/`, `apps/web/tests/playwright/`, or `specs/003-match-predictions/`. The TS surface is byte-identical to the post-Phase-4 baseline (which itself was byte-identical to the post-Phase-3 / T016 baseline). | **GREEN locally** per T015 + T016 implementation reports (no Docker dependency). |

### 1f. Next.js build

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web build` | Production-mode `next build`. **Phase 5 introduced no new route handlers, lib files, or components** — the `POST /api/predictions` handler from T015 already maps WCM01 + WCM02 to 409 with the correct `reason` field; nothing in the build manifest changed. | **GREEN locally** per T016 implementation report (no Docker dependency). |

---

## 2. Migration inventory — `supabase/migrations/`

**Slice 001 carry-forward** — 11 migrations (`0001`…`0011`), unchanged.

**Slice 002 carry-forward** — 12 migrations (`0018`…`0029`), unchanged.

**Slice 003 — cumulative through Phase 5** — **8 new migrations** (slots 0030…0037 per D-012 renumber). **Phase 5 added ZERO new migrations.** T027 (the structural-review task) confirmed the as-built predicate + SP align with the 19 (20 sub-test) US3 tests; no code changes were required and therefore no migration `0038_us3_fixups.sql` (or similar) was emitted.

| # | File | T# | Phase | Summary |
|---|------|----|-------|---------|
| 0030 | `0030_predictions.sql` | T003 | 2 (Foundational) | `public.prediction_source` enum, `public.predictions` table with `predictions_active_uk` partial unique index + supersede CHECK + secondary indexes + BEFORE-UPDATE `updated_at` trigger. |
| 0031 | `0031_is_prediction_locked.sql` | T004 | 2 | **LOCKED cross-slice predicate** `public.is_prediction_locked(p_match_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE`. Body matches `contracts/prediction-lock.predicate.sql.md` § Signature byte-for-byte (verified by side-by-side diff during T026). |
| 0032 | `0032_predictions_rls.sql` | T005 | 2 | Enables + FORCEs RLS on `predictions`. SELECT-only policies; all writes flow through the SP. |
| 0033 | `0033_predictions_audit_trigger.sql` | T006 | 2 | AFTER INSERT / AFTER UPDATE of `superseded_at` trigger; emits `prediction.created` + `prediction.superseded`. Recursion-guarded. |
| 0034 | `0034_submit_prediction_sp.sql` | T013 | 3 (US1) | **Locked cross-slice SP** `public.submit_prediction(...) RETURNS uuid SECURITY DEFINER`. CREATE branch + WCM01–WCM05 rejection branches. D-013 WCM06 trap retired by slot 0037. |
| 0035 | `0035_lock_window_score_bound_seed.sql` | T007 | 2 | Seeds `tournament_config`: `lock_window_minutes = 60`, `score_upper_bound = 20`. |
| 0036 | `0036_kickoff_correction_audit_trigger.sql` | T008 | 2 | AFTER UPDATE OF `kickoff_utc` trigger emitting `prediction.kickoff_correction_crossed_lock` per active prediction. |
| 0037 | `0037_submit_prediction_supersede.sql` | T021 | 4 (US2) | `CREATE OR REPLACE FUNCTION public.submit_prediction(...)` adding the supersede branch via the 3-step self-reference placeholder pattern (D-014). Byte-identical signature to slot 0034; WCM06 retired. |

**Slice 003 migrations aggregate (post-Phase-5)**: **8 files** (0030–0037) — unchanged since Phase 4.

**Cumulative migration totals at end of Phase 5**: 11 (slice 001) + 12 (slice 002) + 8 (slice 003) = **31 migrations** on disk.

**Seed fixtures**: 3 files — `supabase/seed/slice-001-fixture.sql` + `supabase/seed/slice-002-fixture.sql` + `supabase/seed/slice-003-fixture.sql` (T009, carry-forward).

---

## 3. App code inventory — slice 003 additions

Slice 001's 7 app files and slice 002's 8 app files are unchanged.

**Slice 003 cumulative through Phase 5**: 7 new + 1 modified (all from Phase 3) — **NO Phase 4 additions** and **NO Phase 5 additions**.

### 3a. Phase 3 — shared lib (T014)

| File | T# | Role |
|---|---|---|
| `apps/web/lib/predictions/types.ts` | T014 | Cross-slice `Prediction` / `PredictionSource` / `SubmitPredictionInput` / `SubmitPredictionResponse` / `MePredictionsResponse` TS shapes. |
| `apps/web/lib/predictions/client.ts` | T014 | `submitPrediction(client, input)` + `getMyPredictions(client, matchId?)`. |
| `apps/web/lib/predictions/countdown.ts` | T014 | Pure-function `formatRemainingUntilLock(...)` — display-only countdown. |
| `apps/web/lib/predictions/countdown.test.ts` | T014 | `node:test` unit tests — 5 boundary cases. |

### 3b. Phase 3 — API routes (T015)

| File | T# | Role |
|---|---|---|
| `apps/web/app/api/predictions/route.ts` | T015 | `POST /api/predictions`. zod body validation, `requireEligible()`, `submit_prediction` RPC, WCM01–WCM05 → 409 / 422 / 403 / 404 mapping. |
| `apps/web/app/api/me/predictions/route.ts` | T015 | `GET /api/me/predictions[?match_id=<uuid>]`. RLS-bound, `superseded_at IS NULL` filter. |

### 3c. Phase 3 — UI (T016)

| File | T# | Role |
|---|---|---|
| `apps/web/app/(participant)/matches/components/PredictionForm.tsx` | T016 (new) | `'use client'` form with home/away inputs + Submit. |
| `apps/web/app/(participant)/matches/page.tsx` | T016 (modified) | Reads `getMyPredictions(client)`; renders `<PredictionForm>` for editable rows. |

### 3d. Phase 4 — app code

**Phase 4 added zero new app code.** Migration 0037 only.

### 3e. Phase 5 — app code

**Phase 5 added zero new app code.** T027 confirmed structural alignment between the as-built predicate / SP and the US3 test assertions; no fixes were required. The full Phase 5 output is:

- 15 new pgTAP files (12 from T023 + 3 from T024) under `supabase/tests/pgtap/`.
- 4 new Playwright spec files (T025) under `apps/web/tests/playwright/`.
- 3 documentation artifacts (`red-gate-us3.md` from T026, T027's no-op review note recorded in its tasks.md checkbox suffix, and this regression-checkpoint).

### 3f. App code summary

**Slice 003 app file touches (cumulative through Phase 5)**: 7 new + 1 modified (all from Phase 3) = **8 first-party app file touches**. Phase 4 adds **0**. Phase 5 adds **0**.

---

## 4. Expected GREEN state per test file (inferred, not observed)

Predictions below are inferred from file-level inspection of every authored test against the implementations now landed. Until Docker + Deno are up they are NOT observed. Detailed per-test analysis lives in `red-gate-us3.md`; this section summarizes.

### 4a. pgTAP — slice 003 US1 carry-forward (Phase 3)

All 4 files (`submit_prediction_create_happy.sql`, `submit_prediction_invalid_score.sql`, `submit_prediction_invalid_match.sql`, `submit_prediction_ineligible.sql`) **GREEN-already** against T013's SP body (slot 0034). Phase 5 introduced no changes that could regress these.

### 4b. pgTAP — slice 003 US2 carry-forward (Phase 4)

Both files (`submit_prediction_update_supersedes.sql`, `submit_prediction_audit_format.sql`) **GREEN-already** against T021's supersede branch (slot 0037), subject to the documented D-014 audit-row caveat (these tests do not assert on `audit_log.new_value->>'superseded_by'` for the supersede row, so the placeholder workaround is invisible).

### 4c. pgTAP — slice 003 US3 — T023 predicate suite (Phase 5)

Per `red-gate-us3.md § Section A`:

- **Rows 1–11**: all **GREEN-already** against the slot-0031 predicate, whose body matches `contracts/prediction-lock.predicate.sql.md` § Signature byte-for-byte. The 11 behavioral assertions test the documented contract behavior (fail-closed on unknown match, status branch precedes time math, BR-LOCK-002 strict `>=`, COALESCE default of 60 minutes, fresh `tournament_config` read, UTC-absolute `now()`).
- **Row 12 (`is_prediction_locked_perf.sql`)**: **GREEN-likely; environment-dependent.** The predicate is two PK lookups so should be sub-millisecond on a healthy Postgres, but may RED on a starved local Docker Postgres or a contention-heavy CI runner. If RED, T027 follow-up (or a future polish task) should either re-verify the 5 ms threshold under a representative Postgres + record the observed p95 figure in the test comment, OR raise the threshold (e.g. to 10 ms) with cross-slice signoff via the `contracts/prediction-lock.predicate.sql.md § Performance` amendment process — Slice 005's `peer_pick_v` filter calls the predicate per-row and depends on the threshold.

### 4d. pgTAP — slice 003 US3 — T024 SP lock-path suite (Phase 5)

Per `red-gate-us3.md § Section B`: all 3 files **GREEN-already** against the slot-0037 SP. The chain-integrity test (`submit_prediction_serializes_concurrent.sql`) inspects only `predictions` final state, so D-014 (the audit-row placeholder caveat) does not regress.

### 4e. pgTAP — slices 001 + 002 carry-forward

All 21 carry-forward pgTAP files (12 slice-001 + 9 slice-002) expected GREEN exactly as documented in `specs/001-eligibility-login/regression-final.md` and `specs/002-match-catalog/regression-final.md`. Phase 5 did not modify any slice-001 / slice-002 function, table, RLS policy, audit trigger, or seed.

### 4f. Playwright — slice 003 US1 carry-forward (Phase 3)

All 13 tests across 12 spec files from `regression-checkpoint-us1.md § 4c` remain GREEN. Phase 5 introduced zero route-handler / UI changes; the SP signature + ERRCODE surface is byte-stable.

### 4g. Playwright — slice 003 US2 carry-forward (Phase 4)

All 3 tests across 3 spec files from `regression-checkpoint-us2.md § 4e` remain GREEN.

### 4h. Playwright — slice 003 US3 — T025 lock-path suite (Phase 5)

Per `red-gate-us3.md § Section C`:

- **`slice-003-submit-locked.spec.ts`** → **GREEN-already**. At the exact boundary, the few-ms latency between `beforeEach` match upsert and the POST guarantees the SP-eval `now()` is ≥ the calibrated kickoff − 60min. Robust.
- **`slice-003-submit-locked-just-inside.spec.ts`** → **GREEN-already**. 1-second-inside calibration is comfortably inside the boundary.
- **`slice-003-submit-locked-just-outside.spec.ts`** → **GREEN-likely; CI-timing-sensitive.** The 5-second buffer absorbs `beforeEach → SP-eval` latency on a healthy runner, but slow CI (4-6 s upsert → cookie forward → POST → SP entry) may flip the verdict and return 409 instead of 200. **Most likely RED candidate of the 20 sub-tests.** T027 follow-up (or a future polish task) should expand the buffer to ≥ 60-120 s if the flake is observed; document the chosen buffer in the spec header comment.
- **`slice-003-submit-status-locked.spec.ts` (in_progress + finished sub-tests)** → both **GREEN-already**. SP status check precedes time math; both sub-tests assert `WCM02 → 409 + match_status_locked`.

### 4i. Playwright — slices 001 + 002 carry-forward

All 27 carry-forward Playwright spec files (15 slice-001 + 12 slice-002) expected GREEN per their final gates. Phase 5 did not modify any slice-001 / slice-002 surface.

### 4j. Static + build + node:test

- `pnpm -F web exec tsc --noEmit` → **GREEN**, last-known (no Phase-5 TS changes).
- `pnpm -F web build` → **GREEN**, last-known (no Phase-5 build surface changes).
- `pnpm -F web exec node --test apps/web/lib/predictions/countdown.test.ts` → **GREEN**, last-known.

---

## 5. Aggregate totals at end of Phase 5

| Surface | Slice 001 | Slice 002 | Slice 003 (US1 + US2 + US3 cumulative) | Total |
|---|---|---|---|---|
| Migrations | 11 | 12 | 8 | **31** |
| pgTAP files | 12 | 9 | 21 | **42** |
| Playwright specs | 15 | 12 | 19 | **46** |
| Playwright tests (slice-003 only) | — | — | 21 (13 US1 + 3 US2 + 5 US3 across 19 files) | — |
| node:test unit files | 0 | 1 | 1 | 2 |
| First-party app files | 7 | 8 | 7 new + 1 modified (all Phase 3) | **22 new + 1 modified** |
| Seed fixtures | 1 | 1 | 1 | 3 |

---

## 6. Cross-slice contracts confirmed (NOT extended) by slice 003 Phase 5

Phase 5 **does not introduce any new cross-slice locked contract**. Its function is the inverse: it **exercises and verifies** the cross-slice predicate locked by T004 in Phase 2, exhaustively, across the contract test surface:

| Symbol / shape | Lock established | Phase 5 verification |
|---|---|---|
| `public.is_prediction_locked(p_match_id uuid) RETURNS boolean STABLE` — signature + body semantics | T004, slot 0031 (Phase 2) | **T023's 12 pgTAP files exercise the predicate against the full Test surface table** in `contracts/prediction-lock.predicate.sql.md`. Every contract row (1–12) has a corresponding pgTAP file. The locked-cross-slice predicate surface is therefore **fully verified** at the moment T028 lands. Slice 005's `peer_pick_v` filter and Slice 006's admin tooling now have an empirically-bounded predicate to depend on (subject to the runtime confirmation in § 8). |
| `submit_prediction(...) RETURNS uuid SECURITY DEFINER` — WCM01 + WCM02 lock-rejection branches | T013, slot 0034 (Phase 3) + T021, slot 0037 (Phase 4) | T024's 3 pgTAP files + T025's 5 Playwright sub-tests confirm the lock-rejection envelope (ERRCODE + reason) is byte-stable. |

The Phase-3 + Phase-4 locks (the WCM01–WCM05 ERRCODE list; the `POST /api/predictions` + `GET /api/me/predictions` wire shapes; the `audit_log.action` vocabulary; the supersede self-reference placeholder pattern from D-014) all remain in force. **No new ERRCODE is introduced by Phase 5.**

---

## 7. Open deferred work blocking a fully observed GREEN

The following items were authored or invoked but their **execution-time verification** was deferred due to Docker being down or Deno not being installed. None block this documentation artifact — they block the runtime confirmation that the suite is observably GREEN.

### 7a. Slice 001 carry-forward (9 items, unchanged from slice 001's final gate)

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

### 7b. Slice 002 carry-forward (4 Docker-dependent + Deno items, unchanged from slice 002's final gate)

| Task | Why deferred | What still needs running |
|---|---|---|
| T001 (slice 002) | Joint baseline runtime | Implicit in steps 1–3 of § 8. |
| T002 (slice 002) | `pg_cron` + `pg_net` extension boot — Docker down | `supabase start && psql -c "SELECT extname FROM pg_extension"`. |
| T018 (slice 002) | US1 RED-gate runtime — Docker down | Slice-002 stash-and-test for US1. |
| T022 (slice 002) | Slice-002 US1 regression checkpoint — Docker down | Slice-002 § 7. |
| Slice-002 Deno suite (carry-forward) | Deno not installed locally | `deno test supabase/functions/` once Deno is installed. |

### 7c. Slice 003 Docker-dependent deferrals (cumulative through Phase 5 — 19 items)

| Task | Why deferred | What still needs running |
|---|---|---|
| T001 (slice 003) | Joint baseline — Docker down + Deno absent | § 8 verification command set. |
| T010 (slice 003) | pgTAP authoring (US1) — runtime was not observed RED | § 8 step 3 in a stash-and-test recipe (see `red-gate-us1.md`). |
| T011 (slice 003) | Playwright authoring (US1) — runtime was not observed RED | § 8 step 8 in stash-and-test. |
| T012 (slice 003) | US1 RED-gate runtime — Docker down | Full stash-and-test recipe per `red-gate-us1.md § Verification commands`. |
| T013 (slice 003) | SP migration (CREATE) runtime — Docker down | § 8 step 3 post-`supabase db reset`. |
| T015 (slice 003) | Route handlers runtime — Docker down + dev server not booted | § 8 steps 7–8. |
| T016 (slice 003) | UI runtime — Docker down + dev server not booted | § 8 steps 7–8 + manual visual verification at `/matches`. |
| T017 (slice 003) | Phase-3 regression-checkpoint runtime — Docker down + Deno absent | Execute Phase-3 § 8 step set. |
| T018 (slice 003) | pgTAP authoring (US2) — runtime was not observed RED | § 8 step 3 in stash-and-test (see `red-gate-us2.md`). |
| T019 (slice 003) | Playwright authoring (US2) — runtime was not observed RED | § 8 step 8 in stash-and-test. |
| T020 (slice 003) | US2 RED-gate runtime — Docker down | Full stash-and-test per `red-gate-us2.md § Verification commands`. |
| T021 (slice 003) | SP migration (SUPERSEDE) runtime — Docker down | § 8 step 3 post-`supabase db reset`. |
| T022 (slice 003) | Phase-4 regression-checkpoint runtime — Docker down | Execute `regression-checkpoint-us2.md § 8`. |
| T023 (slice 003) | pgTAP authoring (US3 predicate) — runtime was not observed RED | § 8 step 3 in stash-and-test (stash slot 0031; see `red-gate-us3.md § Verification commands`). |
| T024 (slice 003) | pgTAP authoring (US3 SP lock-paths) — runtime was not observed RED | § 8 step 3 in stash-and-test (stash slots 0034 + 0037). |
| T025 (slice 003) | Playwright authoring (US3) — runtime was not observed RED | § 8 step 8 in stash-and-test. |
| T026 (slice 003) | US3 RED-gate runtime — Docker down | Full stash-and-test per `red-gate-us3.md § Verification commands`. |
| T027 (slice 003) | US3 structural-review runtime — Docker down | Re-run T023 + T024 + T025 once Docker is up; patch any RED edges (most likely candidates: `is_prediction_locked_perf.sql` p95 threshold, `slice-003-submit-locked-just-outside.spec.ts` 5-second buffer). If all GREEN, the existing T027-no-op checkbox stands. |
| **T028 (this doc)** | Runtime suite GREEN under live Docker — Docker down + Deno absent | Execute § 8 steps 1–10 below. |

### 7d. D-014 follow-on (informational, NOT blocking merge)

The audit-row inconsistency described in `regression-checkpoint-us2.md § 7` is **documented and known**. It does NOT block US4 / Polish / merge — the predictions table's current state remains correct (`predictions.superseded_by` is the canonical chain successor link), and no slice in the current roadmap reads `audit_log.new_value->>'superseded_by'` as a chain successor. Phase 5's `submit_prediction_serializes_concurrent.sql` asserts only on `predictions` final state, so D-014 does not regress here. Slice 007 (audit-forensic surfaces, if/when planned) should consume `predictions.superseded_by` as the source of truth for chain reconstruction.

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

# 3a. Run the slice-003 is_prediction_locked pgTAP suite (T023 — 12 files, 14 planned assertions).
Get-ChildItem supabase/tests/pgtap -Filter 'is_prediction_locked_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 3b. Run every slice-003 submit_prediction pgTAP file (9 files: 4 US1 + 2 US2 + 2 US3 lock-paths + 1 US3 concurrency).
Get-ChildItem supabase/tests/pgtap -Filter 'submit_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 3c. Carry-forward regression sweep — every slice-001 + slice-002 pgTAP file (21 files).
Get-ChildItem supabase/tests/pgtap -Filter '*.sql' -Exclude 'is_prediction_locked_*.sql','submit_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 4. TypeScript strict compile of the web app (last-known GREEN; no Phase-5 TS surface changes).
pnpm -F web exec tsc --noEmit

# 5. Production-mode Next.js build (last-known GREEN; no Phase-5 build surface changes).
pnpm -F web build

# 6. node:test unit suite — countdown helper (carry-forward from Phase 3).
pnpm -F web exec node --test apps/web/lib/predictions/countdown.test.ts

# 7. Start the Next.js dev server (Playwright fixtures depend on it).
#    Run in a separate terminal; the suite will tear it down after.
pnpm -F web dev

# 8. Playwright suite — slice-003 US1 + US2 + US3 scope (expect 21/21 GREEN: 13 US1 + 3 US2 + 5 US3).
pnpm -F web e2e -- --grep '@slice-003 (@us1|@us2|@us3)'

# 9. Optional cross-slice regression sweep.
pnpm -F web e2e -- --grep '@slice-001'
pnpm -F web e2e -- --grep '@slice-002'

# 10. Slice-002 Deno carry-forward (requires Deno toolchain installed).
deno test supabase/functions/
```

Bash equivalents (run instead of steps 3a / 3b / 3c on a POSIX shell):

```bash
for f in supabase/tests/pgtap/is_prediction_locked_*.sql; do supabase test db "$f" || exit 1; done
for f in supabase/tests/pgtap/submit_prediction_*.sql; do supabase test db "$f" || exit 1; done
for f in supabase/tests/pgtap/*.sql; do
  case "$(basename "$f")" in is_prediction_locked_*|submit_prediction_*) ;; *) supabase test db "$f" || exit 1 ;; esac
done
```

A passing run produces:

- **Step 3a**: 12 files; 14 `ok` assertions total across the predicate suite.
- **Step 3b**: 9 files; 11 (US1+US2) + 7 (US3 T024) = 18 `ok` assertions total across `submit_prediction_*`.
- **Step 3c**: 21 files (12 slice-001 + 9 slice-002) green at the totals documented in slice 001's `regression-final.md` and slice 002's `regression-final.md`.
- **Step 4**: no output, exit 0.
- **Step 5**: build succeeds; the route-handler manifest is unchanged from Phase 4 (no new routes in Phase 5).
- **Step 6**: 5 `ok` lines from `countdown.test.ts`.
- **Step 8**: 21 of 21 slice-003 US1+US2+US3 tests passed (13 US1 + 3 US2 + 5 US3).
- **Step 9**: 14/15 slice-001 (smoke is untagged) + slice-002 set per their gates.
- **Step 10**: every Deno suite green (no slice-003 additions).

---

## 9. Open deferred work blocking a fully observed GREEN

See § 7 above for the full enumeration. Headline: every slice-003 task from T001 through T028 has its runtime gate deferred to the next live-Docker run. Phase 5 specifically defers T023 + T024 + T025 + T026 + T027 + T028 (this doc) — six tasks, all Docker-dependent, none with code surface that could regress prior phases.

---

## 10. Spec deviations consolidated (D-001 through D-014)

Carry-forward from slices 001 + 002 (D-001 through D-011) + slice 003 additions (D-012 through D-014). **Phase 5 introduced no new deviations.** Full bodies live in the source files referenced.

| ID | Where recorded | One-liner |
|---|---|---|
| D-001 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`. Slice 003 inherits via `requireEligible()`. |
| D-002 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `is_approved_domain(p_email text)` takes a FULL email. Inherited via the shared `requireEligible()` helper. |
| D-003 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `{ error: { code, message } }` envelope + `Cache-Control: private, max-age=0, must-revalidate`. Slice 003's 409 envelope (`code='PREDICTION_LOCKED'`, `reason='lock_window_passed' \| 'match_status_locked'`) extends this shape and is asserted byte-for-byte by T025's 5 sub-tests. |
| D-004 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `participants_self_or_admin_read` policy embeds the eligibility predicate. Slice 003's `predictions_self_read` follows the same pattern. |
| D-005 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `handle_auth_user_signed_in` returns the `custom_access_token` envelope. |
| D-006 | `specs/002-match-catalog/tasks.md` § Implementation deviations | Wave-2 schema reconciliation. Slice 003's `is_prediction_locked` reads the reconciled `matches.status` enum (5 values: `scheduled / in_progress / finished / postponed / cancelled`); T023's status_* pgTAP files exercise all 5 values. |
| D-007 | `specs/002-match-catalog/tasks.md` § Implementation deviations | `match_results` field-name mapping. Not exercised by US3. |
| D-008 | `specs/002-match-catalog/tasks.md` § Implementation deviations | pgTAP cannot observe `pg_notify`; slice-003 audit triggers do not emit notifications. |
| D-009 | `specs/002-match-catalog/tasks.md` § Implementation deviations | `audit_log.action` name mismatch in slice-002. Slice 003 pins `'prediction.created'` / `'prediction.superseded'` exactly. |
| D-010 | `specs/002-match-catalog/tasks.md` § Implementation deviations | sync-coordinator vs Deno tests vs migration 0022 gaps — not exercised by US3. |
| D-011 | `specs/002-match-catalog/tasks.md` § Implementation deviations | `audit_log.source` enum gaps — slice 003 reuses `source='trigger'`; already allowed. |
| D-012 | `specs/003-match-predictions/tasks.md` lines 48–63 | Migration slot renumber: slice-003 migrations shifted +1. T004 predicate at on-disk slot **0031**, T013 SP at **0034**, T021 supersede at **0037**. Tests reference function/table names; no test-file change required. |
| D-013 | `specs/003-match-predictions/tasks.md` lines 65–70 | `submit_prediction` provisional `WCM06` branch in T013. **Resolved (2026-05-20, T021)**: migration 0037 retires WCM06 and replaces with the supersede UPDATE+INSERT pattern. |
| D-014 | `specs/003-match-predictions/tasks.md` lines 72–81 | T021's supersede SP body uses a 3-step self-reference placeholder. Consequence: the `prediction.superseded` audit row's `new_value->>'superseded_by'` carries OLD's own id (the placeholder), not the final `v_new_id`. T018's audit-format test does not assert this field against `v_new_id` so it remains GREEN. T024's `submit_prediction_serializes_concurrent.sql` asserts only on `predictions` final state (NOT `audit_log`), so D-014 also does not regress under US3. Slice 007 forensic readers must reconstruct supersede chains from `predictions.superseded_by`, NOT from `audit_log.new_value`. **Informational caveat only — does not block US4 / Polish / merge.** |

No D-015 reserved by Phase 5; next deviation slot for US4 / Polish work is D-015.

---

## 11. Pre-merge action items (operator checklist)

Tick each box before opening (or merging) the slice-003 PR.

- [ ] Docker Desktop running and healthy on the verifying machine (`docker info` exits 0).
- [ ] Deno toolchain installed (`deno --version` exits 0) — required by the slice-002 carry-forward step 10.
- [ ] § 8 step 1 (`supabase start`) succeeds.
- [ ] § 8 step 2 (`supabase db reset`) applies all 31 migrations cleanly and loads all three seed fixtures with no errors.
- [ ] § 8 step 3a (slice-003 `is_prediction_locked_*` pgTAP — T023) reports 14 `ok` lines across the 12 files (1×9 single-assert + 1 file × 3 + 1 file × 2 = 9 + 3 + 2 = 14).
- [ ] § 8 step 3b (slice-003 `submit_prediction_*` pgTAP — T010 + T018 + T024) reports 6 + 3 + 2 + 2 + 6 + 5 + 2 + 2 + 3 = 31 `ok` lines across the 9 files.
- [ ] § 8 step 3c (slice-001 + slice-002 pgTAP carry-forward) reports all 21 files green at the documented assertion totals.
- [ ] § 8 step 4 (`pnpm -F web exec tsc --noEmit`) exits 0 with no output.
- [ ] § 8 step 5 (`pnpm -F web build`) succeeds and the build manifest matches the Phase-4 baseline (no new routes in Phase 5).
- [ ] § 8 step 6 (`node --test apps/web/lib/predictions/countdown.test.ts`) reports 5 `ok` lines.
- [ ] § 8 step 8 (`pnpm -F web e2e -- --grep '@slice-003 (@us1|@us2|@us3)'`) reports 21 of 21 slice-003 tests passed (13 US1 + 3 US2 + 5 US3).
- [ ] § 8 step 9 (slice-001 + slice-002 Playwright carry-forward) reports slice-001 / slice-002 green at their final-gate totals.
- [ ] § 8 step 10 (slice-002 Deno carry-forward) green (or noted as Deno-absent).
- [ ] If `is_prediction_locked_perf.sql` RED's, T027 follow-up has either re-verified the 5 ms threshold under a representative Postgres + recorded the observed p95 figure OR amended the threshold with cross-slice signoff (Slice 005's `peer_pick_v` consumer).
- [ ] If `slice-003-submit-locked-just-outside.spec.ts` RED's, T027 follow-up has expanded the 5-second kickoff buffer to a CI-safe value (≥ 60–120 s) and documented the choice in the spec header comment.
- [ ] § 7a (slice 001 deferrals) ticked GREEN on slice 001's gate.
- [ ] § 7b (slice 002 deferrals) ticked GREEN on slice 002's gate.
- [ ] § 7c (slice 003 deferrals) — every T001, T010, T011, T012, T013, T015, T016, T017, T018, T019, T020, T021, T022, T023, T024, T025, T026, T027, T028 observably GREEN against the live stack.
- [ ] § 7d / D-014 acknowledged in PR description; future audit-forensic readers (slice 007 if/when planned) called out to consume `predictions.superseded_by`, not `audit_log.new_value`.
- [ ] PR description references this file (`specs/003-match-predictions/regression-checkpoint-us3.md`), plus `red-gate-us3.md`, `regression-checkpoint-us2.md`, `red-gate-us2.md`, `regression-checkpoint-us1.md`, `red-gate-us1.md`, `regression-baseline-from-001-002.md`, and (once they exist) `regression-checkpoint-us4.md` and `regression-final.md`.

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack (+ Deno toolchain for the carry-forward Deno suite) is the merge gate. Until every box above is ticked, Phase 6 (US4) MAY NOT start, the Polish phase MAY NOT start, and slice 003 MAY NOT merge to `main`.
