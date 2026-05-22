# Slice 003 — Final Regression Gate

**Slice**: 003 — Match Predictions with Locking
**Date**: 2026-05-20
**Reference**: Constitution Principle XI (NON-NEGOTIABLE — final regression gate before merge)

## Status: DEFERRED (artifacts complete, runtime verification pending)

Slice 003 is **NOT yet eligible to merge.** All 38 task artifacts exist on disk; runtime verification requires Docker Desktop + (for slice-002 carry-forward Deno tests) the Deno runtime, neither of which is available in this session. The pre-merge checklist in § 7 below MUST be completed before merge.

---

## 1. Surface tabulation

| Surface | Files | Count | Status | Verification command |
|---|---|---|---|---|
| Playwright slice-003 specs | `apps/web/tests/playwright/slice-003-*.spec.ts` | 25 files / 28 tests | ARTIFACTS COMPLETE; runtime DEFERRED | `pnpm -F web e2e -- --grep '@slice-003'` |
| pgTAP slice-003 tests | `supabase/tests/pgtap/{submit_prediction_*, is_prediction_locked_*}.sql` | 22 files | ARTIFACTS COMPLETE; runtime DEFERRED | `Get-ChildItem supabase/tests/pgtap -Filter '{submit_prediction,is_prediction_locked}*.sql'` then loop `supabase test db` |
| Deno sync-catalog tests (slice 002 carry-forward) | `supabase/functions/sync-catalog/tests/` | 14 files | DEFERRED (Deno not installed) | `deno test --allow-all` |
| TypeScript typecheck | `pnpm -F web exec tsc --noEmit` | — | ARTIFACTS COMPLETE; last-known-GREEN per Phase 3+5+6 | `pnpm -F web exec tsc --noEmit` |
| Next.js build | `pnpm -F web build` | — | ARTIFACTS COMPLETE; last-known-GREEN per Phase 3 | `pnpm -F web build` |
| ESLint | (slice 002 added `lint` script) | — | DEFERRED | `pnpm -F web lint` |
| CI on most recent PR | `.github/workflows/ci.yml` | 1 workflow | DEFERRED (no remote push yet) | `gh pr checks` |
| Quickstart 14-step verification | `specs/003-match-predictions/quickstart-verification.md` | 14 steps | DEFERRED (template only) | manual run; update doc to 14/14 PASS |

**Cumulative surface counts (slices 001 + 002 + 003)**:
- Migrations: **32** (slice 001: 11; slice 002: 12; slice 003: 9 — slots 0030–0038).
- pgTAP files: **43** (slice 001: 12 + perf; slice 002: 9; slice 003: 22).
- Playwright spec files: **52** (slice 001: 15; slice 002: 12; slice 003: 25).
- Deno test files: **14** (all slice 002 sync-catalog).
- App-code first-party files: 21 (7 slice 001 + 8 slice 002 + 6 slice 003 — predictions lib (4) + routes (2) + PredictionForm + page modifications).

---

## 2. Slice 003 — final tally per phase

| Phase | Tasks | Done | Status |
|---|---|---|---|
| Phase 1 — Setup | 2 (T001, T002) | 2 | ✓ |
| Phase 2 — Foundational | 7 (T003–T009) | 7 | ✓ |
| Phase 3 — US1 (Submit) | 8 (T010–T017) | 8 | ✓ |
| Phase 4 — US2 (Update before lock) | 5 (T018–T022) | 5 | ✓ |
| Phase 5 — US3 (Lock enforcement) | 6 (T023–T028) | 6 | ✓ |
| Phase 6 — US4 (Lock state display) | 6 (T029–T034) | 6 | ✓ |
| Phase 7 — Polish | 4 (T035–T038) | 4 | ✓ (T038 = this doc) |
| **Total** | **38** | **38** | **100% artifacts complete** |

---

## 3. Migration inventory (slice 003)

| Slot | File | Owner | Purpose |
|---|---|---|---|
| 0030 | `0030_predictions.sql` | T003 | `predictions` table + indexes + partial unique idx |
| 0031 | `0031_is_prediction_locked.sql` | T004 | Locked cross-slice predicate (STABLE, INVOKER) |
| 0032 | `0032_predictions_rls.sql` | T005 | RLS on `predictions` (self-read + admin-read) |
| 0033 | `0033_predictions_audit_trigger.sql` | T006 | `prediction.created` / `.superseded` audit trigger |
| 0034 | `0034_submit_prediction_sp.sql` | T013 | `submit_prediction()` SP — create + rejection branches |
| 0035 | `0035_lock_window_score_bound_seed.sql` | T007 | Seeds `lock_window_minutes`=60, `score_upper_bound`=20 |
| 0036 | `0036_kickoff_correction_audit_trigger.sql` | T008 | `prediction.kickoff_correction_crossed_lock` audit |
| 0037 | `0037_submit_prediction_supersede.sql` | T021 | Supersede UPDATE+INSERT pattern (D-013 resolved; D-014 placeholder) |
| 0038 | `0038_get_lock_states_bulk.sql` | T031 | Bulk `get_lock_states(uuid[])` for `/api/matches` (D-015) |

---

## 4. Test inventory (slice 003)

### pgTAP (22 files)
- US1 (T010, 4): `submit_prediction_create_happy`, `_invalid_score`, `_invalid_match`, `_ineligible`
- US2 (T018, 2): `submit_prediction_update_supersedes`, `submit_prediction_audit_format`
- US3 (T023, 12): `is_prediction_locked_{far_before, strict_boundary_at, strict_boundary_just_outside, strict_boundary_just_inside, status_in_progress, status_finished, status_postponed, status_cancelled, unknown_match, config_changes, uses_db_clock, perf}`
- US3 (T024, 3): `submit_prediction_locked_window`, `submit_prediction_locked_status_in_progress`, `submit_prediction_serializes_concurrent`
- Polish (T035, 1): `submit_prediction_admin_override`

### Playwright (25 files / 28 tests)
- US1 (T011, 12 files / 13 tests): `slice-003-submit-*` + `slice-003-me-predictions-*`
- US2 (T019, 3 files / 3 tests): `slice-003-submit-update-supersedes`, `-concurrent-tabs`, `-me-predictions-after-supersede`
- US3 (T025, 4 files / 5 tests): `slice-003-submit-locked*`, `-status-locked`
- US4 (T029, 5 files / 6 tests): `slice-003-matches-lock-state-*`
- US4 (T030, 1 file / 4 tests): `slice-003-ui-display-countdown`

---

## 5. Cross-slice contracts locked by slice 003

Slices 004–008 build on:

- **Tables**:
  - `public.predictions` schema (slot 0030) — `id, participant_id, match_id, predicted_home, predicted_away, submitted_at, source (enum), superseded_at, superseded_by, created_by, ...` + partial UNIQUE INDEX `predictions_active_uk`.
  - Slice 005 reads `predicted_home`/`predicted_away` by name for scoring.

- **Functions**:
  - `public.is_prediction_locked(p_match_id uuid) RETURNS boolean STABLE SECURITY INVOKER` — referenced by future slice RLS + scoring triggers.
  - `public.submit_prediction(p_participant_id, p_match_id, p_home, p_away, p_source) RETURNS uuid SECURITY DEFINER` — referenced by slice 006 admin wrapper.
  - `public.get_lock_states(p_match_ids uuid[]) RETURNS TABLE(match_id, lock_state)` — slice-003-internal helper (D-015).

- **Audit actions**:
  - `prediction.created`, `prediction.superseded`, `prediction.kickoff_correction_crossed_lock` (audit_log.source='trigger').

- **ERRCODE values** (route-handler HTTP mapping):
  - WCM01 → 409 `PREDICTION_LOCKED` / `reason='lock_window_passed'`
  - WCM02 → 409 `PREDICTION_LOCKED` / `reason='match_status_locked'`
  - WCM03 → 422 `INVALID_SCORE` (or 400 from route-layer zod validation)
  - WCM04 → 404 `MATCH_NOT_FOUND`
  - WCM05 → 403 `INELIGIBLE`
  - (WCM06 RETIRED — D-013 resolved)

- **API contracts**:
  - `POST /api/predictions` body + response shape per `contracts/predictions.write.md`
  - `GET /api/me/predictions` response shape per `contracts/predictions.read.md`
  - `GET /api/matches` ADDITIVE extension: `match.lock_state?: 'editable' | 'locked'` (slice 002 backward-compatible)

- **Tournament config keys**:
  - `lock_window_minutes` (jsonb int; default 60)
  - `score_upper_bound` (jsonb int; default 20)

---

## 6. Deviation summary (slice 003)

| ID | Title | Status | Cross-ref |
|---|---|---|---|
| D-012 | Migration slot renumber (0029 → 0030+) | Locked into timeline | tasks.md § Implementation deviations |
| D-013 | Provisional WCM06 branch in T013 | RESOLVED by T021 (slot 0037) | tasks.md |
| D-014 | Supersede self-reference placeholder | Informational; Slice 007 audit-forensics follow-up | tasks.md + `0037_submit_prediction_supersede.sql` |
| D-015 | Bulk `get_lock_states(uuid[])` helper | Active design (slot 0038) | tasks.md + `0038_get_lock_states_bulk.sql` |

Carry-forward from slices 001 + 002: D-001 through D-011 (see `specs/001-eligibility-login/tasks.md` and `specs/002-match-catalog/tasks.md`).

---

## 7. Pre-merge checklist (actionable)

Operator MUST complete the following before merging slice 003:

### Environment setup
- [ ] Docker Desktop running.
- [ ] Install Deno (`winget install denoland.deno` or equivalent) if slice-002 Deno tests are to run.
- [ ] `apps/web/.env.local` populated (slice 001 + slice 002 env vars; slice 003 adds no new ones).

### Database
- [ ] `supabase start` brings up all containers without error.
- [ ] `supabase db reset` applies all **32 migrations** cleanly (slots 0001–0011 + 0018–0029 + 0030–0038) and loads **3 seed fixtures** (slice 001 + 002 + 003).
- [ ] Verify migration 0038's helper is reachable: `psql -c "SELECT public.get_lock_states(ARRAY[gen_random_uuid()]::uuid[])"` returns one row with `lock_state='locked'` (fail-closed on unknown match).

### Test surfaces
- [ ] **pgTAP**: `Get-ChildItem supabase/tests/pgtap -Filter '*.sql' | ForEach-Object { supabase test db $_.FullName }`. All slice-003 files (22 files) GREEN. Carry-forward slice-001 + slice-002 also GREEN.
- [ ] **TypeScript**: `pnpm -F web exec tsc --noEmit` exits 0.
- [ ] **Build**: `pnpm -F web build` succeeds. `/matches`, `/api/matches`, `/api/predictions`, `/api/me/predictions` all compile.
- [ ] **Deno (slice 002 carry-forward)**: `cd supabase/functions/sync-catalog/tests && deno test --allow-all --env-file=...`. All 14 files GREEN.
- [ ] **Playwright**: `pnpm -F web e2e -- --grep '@slice-003'`. **All 28 tests GREEN** (US1: 13, US2: 3, US3: 5, US4: 6+4).
- [ ] **Carry-forward Playwright**: `pnpm -F web e2e -- --grep '@slice-002'` and `--grep '@slice-001'`. All GREEN.

### Polish-specific
- [ ] T035 admin_override pgTAP GREEN (verified by the loop above).
- [ ] T036 perf test: `supabase test db supabase/tests/pgtap/is_prediction_locked_perf.sql` exits 0 with the printed message showing p95 < 5 ms. Update `perf-report.md` § Latency distribution placeholder with the observed p50/p95/p99/max.
- [ ] T037 quickstart: execute all 14 steps from `quickstart.md` § Manual verification checklist. Update `quickstart-verification.md` to 14/14 PASS with exact terminal output per row.
- [ ] Verify D-015 fail-soft: temporarily `REVOKE EXECUTE ON FUNCTION public.get_lock_states FROM authenticated`. GET `/api/matches` — response 200, matches array does NOT include `lock_state` field. RE-GRANT after the test.

### CI
- [ ] Push branch to GitHub: `git push -u origin 003-match-predictions`.
- [ ] Run `gh pr create` (or open via GitHub UI).
- [ ] `gh pr checks` shows GREEN for all three jobs (typecheck / playwright / pgtap).

### Slice 001 + 002 carry-forward
- [ ] All slice-001 deferred items resolved (T005, T006, T007 from slice 001).
- [ ] All slice-002 deferred items resolved (T001, T002, T018, T022, T028, T033, T038, T042, T043, T044, T045 from slice 002).
- [ ] D-010 reconciliation gaps in slice 002 (3 US2 Deno tests with `provider_sync_runs.id` / `provider_name` / `trigger='cron'` drift) addressed.

### Final
- [ ] Once all the above PASS → slice 003 can merge to main.
- [ ] Slice 004 (Final Tournament Predictions) is unblocked AFTER merge.

---

## 8. Merge-gate verdict

> **Slice 003 is NOT yet eligible to merge.** Artifacts complete (38 of 38 tasks marked `[X]`); runtime verification pending the pre-merge checklist above.

The cross-slice contracts locked in § 5 — particularly `is_prediction_locked()` (referenced by every future slice's RLS / scoring triggers) and `submit_prediction()` (referenced by slice 006's admin wrapper) — are byte-for-byte identical to the canonical contract files, verified by T027's structural review.

---

## 9. Process notes (artifact-only execution)

This slice was implemented across multiple sessions with Docker daemon and Deno consistently unavailable. Phase 7 specifically was executed without subagent support (Anthropic API 529 overloaded errors), so T029–T038 were authored directly using Read/Edit/Write rather than dispatched to subagents. This explains the terse "written directly" annotations in the task checkbox suffix lines.

Quality bar maintained:
- All test files follow the established pattern from slice 001 + 002 (`BEGIN; SELECT plan(N); ... SELECT * FROM finish(); ROLLBACK;` for pgTAP; `test.describe` + `test.beforeEach(resetStub)` for Playwright).
- All cross-slice contracts (predicate signature, SP signature, ERRCODE map, audit actions, table schemas) reconciled byte-for-byte against the canonical contract files.
- All deviations (D-012, D-013, D-014, D-015) documented with full Symptom / Decision / Impact prose in `tasks.md` § Implementation deviations.
- Constitution Principle III preserved (UI does NOT re-implement the lock decision; computeLockState in page.tsx is a display-only fallback when the server omits `lock_state`).

This is the **World Cup Madness** project.
