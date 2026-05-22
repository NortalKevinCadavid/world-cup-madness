# Regression checkpoint — Slice 003, Phase 3 (US1)

- **Slice**: `003-match-predictions`
- **Phase**: 3 (US1 — "Eligible participant submits and reviews their own predictions for in-window matches")
- **Date**: 2026-05-20
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T017 (`specs/003-match-predictions/tasks.md` line 701)
- **Companion artifacts**:
  - `specs/003-match-predictions/regression-baseline-from-001-002.md` (T001 — slice-001 + slice-002 carry-forward baseline)
  - `specs/003-match-predictions/red-gate-us1.md` (T012 — sibling RED-gate inventory for the same US1 test set)
  - `specs/001-eligibility-login/regression-checkpoint-us1.md` + `specs/002-match-catalog/regression-checkpoint-us1.md` (templates this document mirrors)
- **Purpose**: Record the state of the slice-001 + slice-002 + slice-003-so-far test suite at the moment US1 lands in slice 003, inventory every test the operator must run, and hand the exact verification commands to whoever next has a working Docker daemon + Deno toolchain. Per Principle XI, US2 (Phase 4), US3 (Phase 5), US4 (Phase 6), and the Polish phase MAY NOT start, and the slice MAY NOT merge to `main`, until all verification commands below land GREEN.

---

## Status: DEFERRED

Both the Docker daemon (required by `supabase start`, `supabase db reset`, `supabase test db`, and by every Playwright fixture that boots the local Supabase stack) and the Deno toolchain (required by slice-002's `provider-stub.test.ts` carry-forward suite) were **unavailable at execution time**. `supabase start`, `supabase db reset`, `supabase test db`, the Next.js dev server (which Playwright fixtures depend on), the Playwright suite, and `deno test` therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added so far in slice 003 (cumulative with slices 001 + 002), and hands the exact commands the user MUST run locally (or in CI, once slice 001's T007 ships) before Phase 4 (US2) begins or the slice can merge. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 8 have all returned GREEN.

---

## 1. Suite inventory (post-US1, cumulative across slices 001 + 002 + 003)

### 1a. pgTAP tests — `supabase/tests/pgtap/`

**Slice 001 carry-forward** — 12 files unchanged from the slice-001 baseline. Full inventory in `specs/001-eligibility-login/regression-final.md § 2`. Headline: 1 harness probe + 8 functional + 2 RLS-isolation + 1 perf = 12 files.

**Slice 002 carry-forward** — 9 files unchanged from the slice-002 final gate. Full inventory in `specs/002-match-catalog/regression-final.md § 1a`. Headline: 1 catalog-RLS + 8 `record_match_result_*` files (5 functional + 1 audit-format + 1 emits-notification + 1 admin-correction split into 2 files = 8).

**Slice 003 additions (Phase 3 US1)** — 4 new files, all authored by T010 (RED-first), pre-empting T013's GREEN implementation. Every file uses the BEGIN / `plan(N)` / asserts / `finish` / ROLLBACK pattern so no residue persists.

| # | File | `plan(N)` | Purpose | Authored by |
|---|------|-----------|---------|-------------|
| 1 | `supabase/tests/pgtap/submit_prediction_create_happy.sql` | `plan(6)` | Six assertions on the SP create-path: A1 returned uuid is non-null, A2 +1 row in `predictions`, A3 active-row shape matches `(participant=alpha, match=M4, predicted_home=2, predicted_away=1, source='ui')`, A4 inserted-id equals returned id, A5 +1 row in `audit_log` with `action='prediction.created'`, A6 audit-row shape matches `(source='trigger', actor=alpha)`. Setup performs a `DELETE FROM public.predictions WHERE participant_id=alpha AND match_id=M4` inside the outer txn to clear the slice-003 fixture's Row 5 collision before calling the SP — the ROLLBACK undoes the delete. | T010 |
| 2 | `supabase/tests/pgtap/submit_prediction_invalid_score.sql` | `plan(3)` | A1 `throws_ok` for `p_home=21` (above seeded `score_upper_bound=20`) → `ERRCODE='WCM03'`. A2 `throws_ok` for `p_home=-1` (negative) → `ERRCODE='WCM03'`. A3 active-row-unchanged invariant. | T010 |
| 3 | `supabase/tests/pgtap/submit_prediction_invalid_match.sql` | `plan(2)` | A1 `throws_ok` with non-existent `p_match_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'` → `ERRCODE='WCM04'`. A2 predictions row-count unchanged. | T010 |
| 4 | `supabase/tests/pgtap/submit_prediction_ineligible.sql` | `plan(2)` | A1 SP call on behalf of zulu (`participation_status='deactivated'`) → `ERRCODE='WCM05'`. A2 predictions row-count unchanged + zulu has zero rows. | T010 |

**Slice 003 pgTAP aggregate**: 4 files, planned assertions `6 + 3 + 2 + 2 = 13`.

**Cumulative pgTAP aggregate at end of Phase 3**: 12 (slice 001) + 9 (slice 002) + 4 (slice 003) = **25 pgTAP files**.

### 1b. Playwright tests — `apps/web/tests/playwright/`

**Slice 001 carry-forward** — 15 spec files (14 `@slice-001` + 1 untagged harness probe `smoke.spec.ts`). Full inventory in `specs/001-eligibility-login/regression-final.md`.

**Slice 002 carry-forward** — 12 spec files (`slice-002-*` — 9 catalog-US1 specs + 3 sync-US2/US3 specs: `slice-002-conflict-quarantined`, `slice-002-outage-alert-dedup`, `slice-002-empty-payload-served-last-known`). Full inventory in `specs/002-match-catalog/regression-final.md`.

**Slice 003 additions (Phase 3 US1)** — 12 new spec files / 13 tests, all tagged `@slice-003 @us1`. Authored by T011 (RED-first); GREEN-implemented by T015 (route handlers) and T016 (UI form).

| # | File | Tests | Tags | Authored by |
|---|------|-------|------|-------------|
| 1 | `slice-003-submit-happy.spec.ts` | 1 | `@slice-003 @us1` | T011 |
| 2 | `slice-003-submit-unauthenticated.spec.ts` | 1 | `@slice-003 @us1` | T011 |
| 3 | `slice-003-submit-invalid-score.spec.ts` | 2 (`home=-1` → 400 BAD_REQUEST; `home=21` → 422 INVALID_SCORE/WCM03) | `@slice-003 @us1` | T011 |
| 4 | `slice-003-submit-invalid-match.spec.ts` | 1 | `@slice-003 @us1` | T011 |
| 5 | `slice-003-submit-domain-removed.spec.ts` | 1 | `@slice-003 @us1` | T011 |
| 6 | `slice-003-submit-direct-api-rejected.spec.ts` | 1 (WCM02 → 409 PREDICTION_LOCKED for finished match) | `@slice-003 @us1` | T011 |
| 7 | `slice-003-submit-client-clock-ignored.spec.ts` | 1 (browser `Date` overridden to 2020; server-clock authority) | `@slice-003 @us1` | T011 |
| 8 | `slice-003-me-predictions-empty.spec.ts` | 1 | `@slice-003 @us1` | T011 |
| 9 | `slice-003-me-predictions-list.spec.ts` | 1 (alpha sees exactly 3 active rows; superseded chain row excluded; RLS-filtered) | `@slice-003 @us1` | T011 |
| 10 | `slice-003-me-predictions-match-filter.spec.ts` | 1 (`?match_id=<M3>` → 1 entry; `?match_id=<M2>` → 0 entries) | `@slice-003 @us1` | T011 |
| 11 | `slice-003-me-predictions-bad-match-id.spec.ts` | 1 (`?match_id=not-a-uuid` → 400 BAD_REQUEST) | `@slice-003 @us1` | T011 |
| 12 | `slice-003-me-predictions-401.spec.ts` | 1 (no cookies → 401 UNAUTHENTICATED) | `@slice-003 @us1` | T011 |

**Slice-003 Playwright test-count aggregate (US1)**: **13 tests across 12 files**.

**Cumulative Playwright aggregate at end of Phase 3**: 15 (slice 001) + 12 (slice 002) + 12 (slice 003) = **39 spec files**.

### 1c. Deno tests — `supabase/functions/`

**Slice 002 carry-forward** — Deno tests (e.g. `provider-stub.test.ts`, sync-coordinator unit tests) remain unchanged. Slice 003 ships zero Edge Functions (prediction surfaces are all Next.js route handlers + a Postgres SP), so the Deno test set is unchanged from the slice-002 final gate. Re-running `deno test` is included in § 8 for completeness, but the slice-003 implementation cannot regress these.

### 1d. node:test unit tests — `apps/web/lib/`

**Slice 002 carry-forward**: `apps/web/lib/catalog/format.test.ts` (T019 of slice 002).

**Slice 003 additions**: 1 new file.

| File | T# | Coverage |
|---|---|---|
| `apps/web/lib/predictions/countdown.test.ts` | T014 | `formatRemainingUntilLock(kickoff, lock_window_minutes, now)` — 5 cases: well-before-lock, just-before-lock, at-lock-boundary, just-inside-lock, well-past-lock. `node:test` runner; not Docker-dependent. |

### 1e. TypeScript compile

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web exec tsc --noEmit` | Project-wide strict compile of `apps/web/`. Establishes cross-slice contract for `lib/predictions/types.ts` (T014), `lib/predictions/client.ts` (T014), `lib/predictions/countdown.ts` (T014), both new route handlers (T015), the `PredictionForm.tsx` client component (T016), and the modified `(participant)/matches/page.tsx` server component (T016). | **GREEN locally** per the T015 + T016 implementation reports (no Docker dependency). |

### 1f. Next.js build

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web build` | Production-mode `next build`. Confirms the App Router catches the two new route handlers (`/api/predictions` POST + `/api/me/predictions` GET), the `PredictionForm` client component is correctly marked `'use client'` and does not leak server-only imports, and the modified `(participant)/matches/page.tsx` server component still type-checks against the slice-002 catalog client + the new slice-003 prediction client. | **GREEN locally** per the T016 implementation report (no Docker dependency). |

---

## 2. Migration inventory — `supabase/migrations/`

**Slice 001 carry-forward** — 11 migrations (`0001`…`0011`), unchanged.

**Slice 002 carry-forward** — 12 migrations (`0018`…`0029` with the documented holes — `0012`…`0017` and `0024` are reserved; on-disk slots are dense from `0018` through `0029` covering 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025, 0026, 0027, 0028, 0029). Full inventory in `specs/002-match-catalog/regression-final.md § 2`.

**Slice 003 additions (Phase 2 + Phase 3)** — 7 new migrations, slot-renumbered +1 per D-012 (spec said 0029…0035; on-disk lives at 0030…0036). T013's `submit_prediction_sp` migration (slot **0034**) is the new addition in Phase 3.

| # | File | T# | Phase | Summary |
|---|------|----|-------|---------|
| 0030 | `0030_predictions.sql` | T003 | 2 | Creates `public.prediction_source` enum (`ui` / `api` / `admin_override`), `public.predictions` table (UUID PK, FKs to `participants` + `matches`, non-negative score CHECKs, `source` enum, `superseded_at` / `superseded_by` nullable pair + `(superseded_at IS NULL) = (superseded_by IS NULL)` CHECK, audit columns), the `predictions_active_uk` unique partial index on `(participant_id, match_id) WHERE superseded_at IS NULL`, three secondary indexes (`predictions_match_active_idx`, `predictions_participant_idx`, `predictions_superseded_by_idx`), and a BEFORE-UPDATE trigger for `updated_at`. |
| 0031 | `0031_is_prediction_locked.sql` | T004 | 2 | Creates `public.is_prediction_locked(p_match_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER`. Reads `matches.status` + `matches.kickoff_utc` and the seeded `tournament_config.lock_window_minutes`; returns TRUE when `status <> 'scheduled'` OR `kickoff_utc <= now() + (lock_window_minutes * interval '1 minute')`. **LOCKED cross-slice predicate** — slice 004 / 005 / 006 consumers depend on this signature. |
| 0032 | `0032_predictions_rls.sql` | T005 | 2 | Enables + FORCEs RLS on `predictions`. SELECT policy `predictions_self_read` allows `participant_id = (SELECT id FROM participants WHERE auth_user_id = auth.uid())` AND `public.is_eligible_nortal_participant(auth.uid())` (combined OR'd per D-004 pattern). INSERT/UPDATE/DELETE all REVOKED from `authenticated` + `anon` — only the SECURITY DEFINER SP at slot 0034 may write. Admin SELECT policy adds `is_admin(auth.uid())` for the slice-006 admin path. |
| 0033 | `0033_predictions_audit_trigger.sql` | T006 | 2 | AFTER INSERT / AFTER UPDATE OF `superseded_at` SECURITY DEFINER trigger on `predictions`. Emits `audit_log` rows: `'prediction.created'` on INSERT, `'prediction.superseded'` on UPDATE-of-`superseded_at`-from-NULL. `source='trigger'`. Skips no-op UPDATEs via `row(NEW.*) IS DISTINCT FROM row(OLD.*)`. |
| **0034** | **`0034_submit_prediction_sp.sql`** | **T013** | **3** | **CREATE-branch + all-rejection-branches of the locked cross-slice SP `public.submit_prediction(p_participant_id uuid, p_match_id uuid, p_home int, p_away int, p_source text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER`.** Order of operations (per `contracts/predictions.write.md` § Stored procedure semantics): validate `p_source`, validate score bounds (writes audit row `prediction.rejected_invalid_score` + RAISE `WCM03`), validate eligibility (writes audit row + RAISE `WCM05`), validate match existence (RAISE `WCM04`), lock-check via `is_prediction_locked(p_match_id)` (writes audit row + RAISE `WCM01` for window-passed or `WCM02` for status-locked), then INSERT into `predictions`. Provisional `WCM06` branch on existing-active-row collision per **D-013** — T021 (US2) replaces with supersede pattern. |
| 0035 | `0035_lock_window_score_bound_seed.sql` | T007 | 2 | Inserts default `tournament_config` rows: `lock_window_minutes = 60`, `score_upper_bound = 20`. Insert-only — does not alter the locked `tournament_config(key, value, updated_at)` shape. |
| 0036 | `0036_kickoff_correction_audit_trigger.sql` | T008 | 2 | AFTER UPDATE OF `kickoff_utc` trigger on `matches`. Writes `audit_log` row `action='match.kickoff_corrected'` with `source='trigger'`, capturing old/new `kickoff_utc` + the affected `match_id` (used by slice 006 admin diff view). |

**Slice 003 migrations aggregate**: **7 files** (0030–0036).

**Cumulative migration totals at end of Phase 3**: 11 (slice 001) + 12 (slice 002) + 7 (slice 003) = **30 migrations** on disk.

**Seed fixtures**: 3 files — `supabase/seed/slice-001-fixture.sql` (carry-forward) + `supabase/seed/slice-002-fixture.sql` (carry-forward) + `supabase/seed/slice-003-fixture.sql` (T009).

---

## 3. App code inventory — slice 003 additions

Slice 001's 7 app files and slice 002's 8 app files are unchanged. Slice 003 adds 8 new files (1 modified).

### 3a. Shared lib (T014)

| File | T# | Role |
|---|---|---|
| `apps/web/lib/predictions/types.ts` | T014 | Cross-slice `Prediction` / `PredictionSource` / `SubmitPredictionInput` / `SubmitPredictionResponse` / `MePredictionsResponse` TS shapes. Imported by `apps/web/lib/predictions/client.ts`, both route handlers, and the `PredictionForm.tsx` UI component. |
| `apps/web/lib/predictions/client.ts` | T014 | `submitPrediction(client, input)` POSTs JSON to `/api/predictions`; `getMyPredictions(client, matchId?)` GETs from `/api/me/predictions`. Server-component-only (uses the per-request user-JWT-bound Supabase client). Throws on non-200 with the contract error body. |
| `apps/web/lib/predictions/countdown.ts` | T014 | Pure-function `formatRemainingUntilLock(kickoffUtc, lockWindowMinutes, now)` returning e.g. `"locks in 23 min"` or `"locked"`. No DOM / no React. Display-only — never used to gate submission server-side. |
| `apps/web/lib/predictions/countdown.test.ts` | T014 | `node:test` unit tests for `countdown.ts` — 5 boundary cases. Not Docker-dependent. |

### 3b. API routes (T015)

| File | T# | Role |
|---|---|---|
| `apps/web/app/api/predictions/route.ts` | T015 | `POST /api/predictions`. Body validated by zod; calls `requireEligible()`; invokes `public.submit_prediction(...)` via the per-request user-JWT-bound Supabase client (so eligibility re-check + RLS-aware audit insertion run server-side). Parses SQLERRM for `WCM01..WCM05`; maps to 409 / 422 / 403 / 404 per `contracts/predictions.write.md`. Error envelope `{ error: { code, message } }` byte-equivalent to slice-001 `/api/me` per D-003. `Cache-Control: private, max-age=0, must-revalidate` on every denial path. |
| `apps/web/app/api/me/predictions/route.ts` | T015 | `GET /api/me/predictions`. Optional `?match_id=<uuid>` query-param validated by zod. Calls `requireEligible()`; reads active rows only (`superseded_at IS NULL`) via the user-JWT-bound client (RLS enforces `participant_id = (current user)`). Body shape `{ predictions: Prediction[] }`. Errors mirror the slice-001 envelope. |

### 3c. UI — participant route group (T016)

| File | T# | Role |
|---|---|---|
| `apps/web/app/(participant)/matches/components/PredictionForm.tsx` | T016 (new) | `'use client'` form with home/away number inputs + Submit button. Uses `useTransition` + `submitPrediction(client, {match_id, home, away})`. On success: `router.refresh()` (App-Router SSR re-fetch). On error: renders the contract error `message` inline via `aria-live="polite"`. Pre-fills inputs when an existing prediction is passed via props (button reads "Update" rather than "Submit"). When locked, no form is rendered — display-only score. |
| `apps/web/app/(participant)/matches/page.tsx` | T016 (modified) | Server-component catalog page (originally created by slice 002 T021). Now also calls `getMyPredictions(client)` and builds a `match_id → Prediction` map. Computes display-only lock state per match using `formatRemainingUntilLock(...)` (display only — server-authoritative lock decisions live in the SP at slot 0034). Renders `PredictionForm` for editable rows; static score-display for locked rows. |

### 3d. App code summary

**Slice 003 new app files**: 7 new + 1 modified = **8 first-party app file touches**.

---

## 4. Expected GREEN state per test file (inferred, not observed)

Predictions below are inferred from file-level inspection of every authored test against the implementations now landed (T013 SP + T015 routes + T016 UI). Until Docker + Deno are up they are NOT observed.

### 4a. pgTAP — slice 003

- `submit_prediction_create_happy.sql` (`plan(6)`) → **GREEN once Docker + db reset**. SP at slot 0034 ships the create branch + audit-row INSERT via slot-0033 trigger. The internal `DELETE` of fixture Row 5 (alpha + M4) + `ROLLBACK` pattern leaves the fixture intact.
- `submit_prediction_invalid_score.sql` (`plan(3)`) → **GREEN once Docker + db reset**. SP step 3 raises `WCM03` for both `p_home=21` and `p_home=-1` before any insert; active-row invariant holds.
- `submit_prediction_invalid_match.sql` (`plan(2)`) → **GREEN once Docker + db reset**. SP step 5 raises `WCM04` for non-existent match_id; predictions row-count unchanged.
- `submit_prediction_ineligible.sql` (`plan(2)`) → **GREEN once Docker + db reset**. SP step 4 raises `WCM05` for zulu; predictions row-count unchanged + zulu still has zero rows.

### 4b. pgTAP — slices 001 + 002 carry-forward

All 21 carry-forward pgTAP files (12 slice-001 + 9 slice-002) expected GREEN exactly as documented in `specs/001-eligibility-login/regression-final.md` and `specs/002-match-catalog/regression-final.md`. Slice 003 did not modify any slice-001 / slice-002 function, table, RLS policy, audit trigger, or seed.

### 4c. Playwright — slice 003 US1 (13 tests across 12 files)

- `slice-003-submit-happy.spec.ts` → **GREEN once Docker + Next.js dev running**. Route at `/api/predictions` ships in T015; UI in T016. Targets match M6 (USA-JPN) per the special-case note in `red-gate-us1.md` to avoid colliding with the pgTAP sibling's M4 mutation.
- `slice-003-submit-unauthenticated.spec.ts` → **GREEN once Docker + dev running**. Route + `requireEligible()` wiring returns 401 envelope byte-equivalent to slice-001 `/api/me`.
- `slice-003-submit-invalid-score.spec.ts` (2 tests) → **GREEN once Docker + dev running**. Two-layer rejection: zod (`home=-1`) → 400; SP/`WCM03` (`home=21`) → 422.
- `slice-003-submit-invalid-match.spec.ts` → **GREEN once Docker + dev running**. SP/`WCM04` → 404.
- `slice-003-submit-domain-removed.spec.ts` → **GREEN once Docker + dev running**. `withTemporaryConfig` flips approved_domains to `[]`; next POST returns 403 `DOMAIN_NOT_APPROVED`.
- `slice-003-submit-direct-api-rejected.spec.ts` → **GREEN once Docker + dev running**. Direct POST against a finished match → SP/`WCM02` → 409 `PREDICTION_LOCKED`.
- `slice-003-submit-client-clock-ignored.spec.ts` → **GREEN once Docker + dev running**. Browser `Date` pinned to 2020; SP uses server clock + `match_status`; in-progress match still 409.
- `slice-003-me-predictions-empty.spec.ts` → **GREEN once Docker + dev running**. New participant returns `{ predictions: [] }`.
- `slice-003-me-predictions-list.spec.ts` → **GREEN once Docker + dev running**. alpha sees exactly 3 active rows (RLS filters other participants; `superseded_at IS NULL` filters the superseded chain).
- `slice-003-me-predictions-match-filter.spec.ts` → **GREEN once Docker + dev running**. Filter behaves as documented.
- `slice-003-me-predictions-bad-match-id.spec.ts` → **GREEN once Docker + dev running**. zod uuid validation → 400 BAD_REQUEST.
- `slice-003-me-predictions-401.spec.ts` → **GREEN once Docker + dev running**. No cookies → 401 UNAUTHENTICATED.

### 4d. Playwright — slices 001 + 002 carry-forward

All 27 carry-forward Playwright spec files (15 slice-001 + 12 slice-002) expected GREEN per their final gates. Slice 003 did not modify the slice-001 callback, denied, or `/api/me` surfaces, and did not modify the slice-002 catalog route, page, or filters.

### 4e. Static + build + node:test

- `pnpm -F web exec tsc --noEmit` → **GREEN**, last-known per T015 + T016 implementation reports (no Docker dependency).
- `pnpm -F web build` → **GREEN**, last-known per T016 implementation report (no Docker dependency).
- `pnpm -F web exec node --test apps/web/lib/predictions/countdown.test.ts` → **GREEN**, last-known per T014 implementation report.

---

## 5. Aggregate totals at end of Phase 3

| Surface | Slice 001 | Slice 002 | Slice 003 (US1 cumulative) | Total |
|---|---|---|---|---|
| Migrations | 11 | 12 | 7 | **30** |
| pgTAP files | 12 | 9 | 4 | **25** |
| Playwright specs | 15 | 12 | 12 | **39** |
| Playwright tests (slice-003 US1 only) | — | — | 13 | — |
| node:test unit files | 0 | 1 | 1 | 2 |
| First-party app files | 7 | 8 | 7 new + 1 modified | **22 new + 1 modified** |
| Seed fixtures | 1 | 1 | 1 | 3 |

---

## 6. Cross-slice contracts now locked by slice 003 Phase 3

Per Constitution Principle XI, the symbols and shapes below are **now LOCKED** in addition to the contracts locked by slices 001 + 002 (still locked: `is_eligible_nortal_participant`, `is_admin`, `participants`, `audit_log`, `tournament_config`, `match_status` / `match_stage` enums, `matches`, `match_results` `_for_scoring` columns, `MatchDataProviderAdapter`, `GET /api/matches`, `tournament_config.providers.*` / `provider_sync.*` keys).

| Symbol / shape | Lock | Consumers |
|---|---|---|
| `public.predictions` table — column names `id`, `participant_id`, `match_id`, `predicted_home`, `predicted_away`, `submitted_at`, `source`, `superseded_at`, `superseded_by`, `created_by`, `created_at`, `updated_at` | Column NAMES LOCKED. Slice 005 (leaderboard / scoring) reads `predicted_home` / `predicted_away` by name via SECURITY DEFINER. Additive optional columns allowed; renames/removals require coordinated slice 004/005/006 migration. | Slice 005 (leaderboard read), slice 006 (admin overrides). |
| `public.prediction_source` enum `{ui, api, admin_override}` (3 values) | Body LOCKED. Additive values require coordinated migration. | Slice 006 (admin_override path). |
| `public.is_prediction_locked(p_match_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER` | Signature LOCKED. | Slice 004 (final-prediction lock parity), slice 005 (scoring snapshot eligibility), slice 006 (admin override gate). |
| `public.submit_prediction(p_participant_id uuid, p_match_id uuid, p_home int, p_away int, p_source text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER` | Signature LOCKED. Body may evolve (T021 replaces the WCM06 branch with the supersede pattern per D-013). | Slice 006 (admin override path calls with `source='admin_override'`). |
| ERRCODE values `WCM01..WCM05` raised by `submit_prediction` (lock_window_passed / match_status_locked / invalid_score / match_not_found / participant_ineligible) | Code-value list LOCKED. `WCM06` is provisional per D-013 and **not** cross-slice locked. | Route-handler error-mapping layer (T015); admin path (slice 006); any future caller. |
| `POST /api/predictions` request body `{ match_id: uuid, home: int, away: int, source?: 'ui'|'api' }` + 200 response `{ prediction: Prediction }` + error envelope `{ error: { code, message } }` with codes `UNAUTHENTICATED` / `DOMAIN_NOT_APPROVED` / `BAD_REQUEST` / `INVALID_SCORE` / `MATCH_NOT_FOUND` / `PREDICTION_LOCKED` / `INTERNAL` | Wire shape LOCKED — error envelope byte-equivalent to slice-001 `/api/me` per D-003. | Slice 003 UI (T016); future admin UI (slice 006); cross-slice test fixtures. |
| `GET /api/me/predictions` 200 response `{ predictions: Prediction[] }` + optional `?match_id=<uuid>` query param + error envelope (same codes as POST minus `INVALID_SCORE` / `MATCH_NOT_FOUND` / `PREDICTION_LOCKED`) | Wire shape LOCKED. Additive fields permitted (slice 005 may add `score` per row); renames require coordinated UI migration. | Slice 003 UI (T016 `getMyPredictions` map); slice 005 (per-row score join, additive). |
| `audit_log.action` strings `'prediction.created'`, `'prediction.superseded'`, `'prediction.rejected_invalid_score'`, `'prediction.rejected_ineligible'`, `'prediction.rejected_match_not_found'`, `'prediction.rejected_lock_window_passed'`, `'prediction.rejected_match_status_locked'` | Action-name vocabulary LOCKED. Avoids the slice-002 D-009 `match_result.recorded` vs `updated` trap by pinning every action string in the SP body. | Slice 006 (admin diff view); any audit-log consumer. |

---

## 7. D-013 callout — provisional WCM06 branch

**D-013 (surfaced at T013, 2026-05-20)**: T013 ships the CREATE path of `public.submit_prediction(...)` only — the supersede branch is owned by T021 (US2). To keep the SP behaviorally deterministic in the gap between T013 and T021, T013 raises `ERRCODE='WCM06'` on any pre-existing active row for the same `(participant_id, match_id)` pair (otherwise the `predictions_active_uk` unique partial index would surface a generic `23505` that the route handler can't distinguish from genuine corruption). **WCM06 is provisional and NOT in the cross-slice locked ERRCODE list (WCM01..WCM05).** T021 must:

1. Remove the WCM06 branch from the SP body entirely.
2. Replace with the supersede pattern: `SELECT ... FOR UPDATE` of the existing active row, INSERT the new row, UPDATE the old row to set `superseded_at = now()` + `superseded_by = v_new_id`.
3. Verify the audit trigger at slot 0033 fires both `prediction.created` (on the new row) and `prediction.superseded` (on the old row) automatically.
4. If any test references WCM06, update or remove that reference.

**Impact on US1**: slice-003 happy-path E2E flows do not trigger WCM06 (the pgTAP sibling pre-deletes any colliding row; the Playwright happy-path uses a fresh match). Route handler in T015 does NOT map WCM06 to an HTTP code — observing it in production before T021 ships indicates a bug.

---

## 8. Verification commands (operator runbook)

Run from the repo root on branch `003-match-predictions` in order. Stop on the first non-zero exit. PowerShell variants given; bash equivalents follow.

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all 30 migrations
#    (slice 001's 0001..0011 + slice 002's 0018..0029 + slice 003's 0030..0036
#    per D-012 renumber) and loads the three seed fixtures
#    (supabase/seed/slice-001-fixture.sql + slice-002-fixture.sql + slice-003-fixture.sql).
supabase db reset

# 3a. Run every slice-003 pgTAP test file individually (4 files).
Get-ChildItem supabase/tests/pgtap -Filter 'submit_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 3b. Carry-forward regression sweep — every slice-001 + slice-002 pgTAP file (21 files).
Get-ChildItem supabase/tests/pgtap -Filter '*.sql' -Exclude 'submit_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 4. TypeScript strict compile of the web app (last-known GREEN).
pnpm -F web exec tsc --noEmit

# 5. Production-mode Next.js build (last-known GREEN).
pnpm -F web build

# 6. node:test unit suite — countdown helper.
pnpm -F web exec node --test apps/web/lib/predictions/countdown.test.ts

# 7. Start the Next.js dev server (Playwright fixtures depend on it).
#    Run in a separate terminal; the suite will tear it down after.
pnpm -F web dev

# 8. Playwright suite — slice-003 US1 scope (expect 13/13 GREEN).
pnpm -F web e2e -- --grep '@slice-003 @us1'

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

- **Step 3a**: 4 files; `ok 1..6` / `ok 1..3` / `ok 1..2` / `ok 1..2` respectively = **13 ok assertions** against `submit_prediction_*`.
- **Step 3b**: 21 files green at the totals documented in slice 001's `regression-final.md` and slice 002's `regression-final.md`.
- **Step 4**: no output, exit 0.
- **Step 5**: build succeeds; output reports the new `/api/predictions` POST + `/api/me/predictions` GET handlers and the modified `(participant)/matches/page.tsx`.
- **Step 6**: 5 `ok` lines from `countdown.test.ts`.
- **Step 8**: 13 of 13 slice-003 US1 tests passed.
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

### 9c. Slice 003 Docker-dependent deferrals (8 items)

| Task | Why deferred | What still needs running |
|---|---|---|
| T001 (slice 003) | Joint baseline — Docker down + Deno absent | § 8 steps 1–3b + 10. |
| T010 (slice 003) | pgTAP authoring — runtime was not observed RED | § 8 step 3a in a stash-and-test recipe (see red-gate-us1.md). |
| T011 (slice 003) | Playwright authoring — runtime was not observed RED | § 8 steps 7–8 in stash-and-test. |
| T012 (slice 003) | US1 RED-gate runtime — Docker down | Full stash-and-test recipe per `red-gate-us1.md § Verification commands`. |
| T013 (slice 003) | SP migration runtime — Docker down | § 8 step 3a post-`supabase db reset`. |
| T015 (slice 003) | Route handlers runtime — Docker down + dev server not booted | § 8 steps 7–8. |
| T016 (slice 003) | UI runtime — Docker down + dev server not booted | § 8 steps 7–8 + manual visual verification at `/matches`. |
| **T017 (this doc)** | Runtime suite GREEN under live Docker — Docker down + Deno absent | Execute § 8 steps 1–10 above. |

### 9d. D-013 follow-on (blocks T021)

`WCM06` provisional branch in `public.submit_prediction(...)` (slot 0034) **must** be replaced by T021 (US2) with the supersede pattern. Until T021 ships:

- The pgTAP sibling `submit_prediction_update_supersedes.sql` (T018 of slice 003) and the corresponding Playwright `slice-003-submit-update-*.spec.ts` files do not yet exist.
- The slice cannot enter Phase 4 / US2 sign-off until WCM06 is gone and the supersede pgTAP + Playwright matrix is green.

---

## 10. Spec deviations consolidated

Carry-forward from slices 001 + 002 (D-001 through D-011) + slice 003 additions (D-012 + D-013). Full bodies live in the source files referenced.

| ID | Where recorded | One-liner |
|---|---|---|
| D-001 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`. Slice 003's `requireEligible()` re-check on every `/api/predictions` POST inherits the renamed hook path. |
| D-002 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `is_approved_domain(p_email text)` takes a FULL email. Slice 003's mid-session-deny test inherits this via the shared `requireEligible()`. |
| D-003 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `/api/me` body shape `{ participant: {...} }`; errors `{ error: { code, message } }` with `Cache-Control: private, max-age=0, must-revalidate`. Slice 003's `/api/predictions` and `/api/me/predictions` mirror the envelope byte-for-byte. |
| D-004 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `participants_self_or_admin_read` policy embeds the eligibility predicate (combined OR'd). Slice 003's `predictions_self_read` policy follows the same pattern. |
| D-005 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `handle_auth_user_signed_in` returns the `custom_access_token` envelope. Relevant to slice 003 only via session refresh on the predictions page. |
| D-006 | `specs/002-match-catalog/tasks.md` lines 51–63 | Wave-2 schema reconciliation. As-built migrations authoritative for slice 003's lock-window calculation in `is_prediction_locked(uuid)`. |
| D-007 | `specs/002-match-catalog/tasks.md` lines 65–75 | `match_results` field-name mapping in `/api/matches`. Not directly exercised by US1 (predictions does not query `match_results`); the locked-match test depends on `match_status='finished'` consistency. |
| D-008 | `specs/002-match-catalog/tasks.md § Implementation deviations` | pgTAP cannot observe `pg_notify`; slice-003 audit triggers do not emit notifications — informational only for this slice. |
| D-009 | `specs/002-match-catalog/tasks.md § Implementation deviations` | `audit_log.action` name mismatch in slice-002. Slice 003 introduces a parallel `'prediction.created'` / `'prediction.rejected_*'` vocabulary and pins action strings in the SP body. |
| D-010 | `specs/002-match-catalog/tasks.md § Implementation deviations` | sync-coordinator vs Deno tests vs migration 0022 gaps — not exercised by US1. |
| D-011 | `specs/002-match-catalog/tasks.md § Implementation deviations` | `audit_log.source` enum gaps — slice 003 reuses `source='trigger'` (audit-trigger path) and `source='api_guard'` (direct-route writes); both already allowed. |
| **D-012** | `specs/003-match-predictions/tasks.md` lines 48–63 | Migration slot renumber: slice 003's migrations shifted +1 (T013 `submit_prediction_sp` lives at on-disk slot **0034**, not the spec's 0033). Tests reference function/table names; no test-file change required. |
| **D-013** | `specs/003-match-predictions/tasks.md` lines 65–69 | `submit_prediction` provisional `WCM06` branch — added in T013 to keep the SP deterministic before the supersede path lands. T021 (US2) MUST remove the WCM06 branch and replace it with the supersede UPDATE+INSERT pattern. Not cross-slice locked. |

No D-014 reserved by Phase 3; next deviation slot for US2 / US3 / US4 / Polish work is D-014.

---

## 11. Pre-merge action items (operator checklist)

Tick each box before opening (or merging) the slice-003 PR.

- [ ] Docker Desktop running and healthy on the verifying machine (`docker info` exits 0).
- [ ] Deno toolchain installed (`deno --version` exits 0) — required by the slice-002 carry-forward step 10.
- [ ] § 8 step 1 (`supabase start`) succeeds.
- [ ] § 8 step 2 (`supabase db reset`) applies all 30 migrations cleanly and loads all three seed fixtures with no errors.
- [ ] § 8 step 3a (slice-003 pgTAP) reports 13 ok lines across `submit_prediction_create_happy.sql` (6) + `submit_prediction_invalid_score.sql` (3) + `submit_prediction_invalid_match.sql` (2) + `submit_prediction_ineligible.sql` (2).
- [ ] § 8 step 3b (slice-001 + slice-002 pgTAP carry-forward) reports all 21 files green at the documented assertion totals.
- [ ] § 8 step 4 (`pnpm -F web exec tsc --noEmit`) exits 0 with no output.
- [ ] § 8 step 5 (`pnpm -F web build`) succeeds and emits the new `/api/predictions` + `/api/me/predictions` route handlers in the build manifest.
- [ ] § 8 step 6 (`node --test apps/web/lib/predictions/countdown.test.ts`) reports 5 ok lines.
- [ ] § 8 step 8 (`pnpm -F web e2e -- --grep '@slice-003 @us1'`) reports 13 of 13 slice-003 US1 tests passed.
- [ ] § 8 step 9 (slice-001 + slice-002 Playwright carry-forward) reports slice-001 / slice-002 green at their final-gate totals (incl. the slice-002 `slice-002-late-fixture-appears` self-fixme behaviour).
- [ ] § 8 step 10 (slice-002 Deno carry-forward) green (or noted as Deno-absent).
- [ ] § 9a (slice 001 deferrals) ticked GREEN on slice 001's gate.
- [ ] § 9b (slice 002 deferrals) ticked GREEN on slice 002's gate.
- [ ] § 9c (slice 003 deferrals) — every T001, T010, T011, T012, T013, T015, T016, T017 observably GREEN against the live stack.
- [ ] § 9d — D-013 acknowledged in PR description; T021 (US2) called out as the follow-on that retires WCM06.
- [ ] PR description references this file (`specs/003-match-predictions/regression-checkpoint-us1.md`), plus `red-gate-us1.md`, `regression-baseline-from-001-002.md`, and (once they exist) `regression-checkpoint-us2.md`, `regression-checkpoint-us3.md`, `regression-checkpoint-us4.md`, and `regression-final.md`.

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack (+ Deno toolchain for the carry-forward Deno suite) is the merge gate. Until every box above is ticked, Phase 4 (US2) MAY NOT start, Phase 5 (US3) MAY NOT start, Phase 6 (US4) MAY NOT start, the Polish phase MAY NOT start, and slice 003 MAY NOT merge to `main`.
