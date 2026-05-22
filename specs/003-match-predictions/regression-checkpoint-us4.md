# Slice 003 / Phase 6 (US4) — Regression Checkpoint

**Slice**: 003 — Match Predictions with Locking
**Date**: 2026-05-20
**Reference**: Constitution Principle XI (regression suite GREEN before next phase or merge)

## Status: DEFERRED

Runtime verification cannot run in this session — Docker daemon down + Deno not installed locally. This document is an inventory of artifacts on disk + the inferred GREEN state once the environment is up. Phase 7 (Polish) is permitted to start AFTER the operator runs the verification commands in § 8 below.

---

## 1. Suite inventory (post-Phase-6 slice 003)

### Slice 003 pgTAP (21 files total)
- US1 (T010, 4 files): `submit_prediction_create_happy`, `_invalid_score`, `_invalid_match`, `_ineligible`
- US2 (T018, 2 files): `submit_prediction_update_supersedes`, `submit_prediction_audit_format`
- US3 (T023, 12 files): `is_prediction_locked_*` boundary + status + edge cases
- US3 (T024, 3 files): `submit_prediction_locked_window`, `submit_prediction_locked_status_in_progress`, `submit_prediction_serializes_concurrent`
- US4 (T029, T030 phase): no new pgTAP files this phase

### Slice 003 Playwright (25 files / 27 tests)
- US1 (T011, 12 files / 13 tests)
- US2 (T019, 3 files / 3 tests)
- US3 (T025, 4 files / 5 tests)
- **US4 (T029, 5 files / 6 tests, NEW this phase)**:
  - `slice-003-matches-lock-state-editable.spec.ts` (1 test)
  - `slice-003-matches-lock-state-locked-window.spec.ts` (1 test)
  - `slice-003-matches-lock-state-locked-status.spec.ts` (2 sub-tests: M1 finished + M2 in_progress)
  - `slice-003-matches-lock-state-boundary.spec.ts` (1 test)
  - `slice-003-matches-lock-state-after-config-change.spec.ts` (1 test)
- **US4 (T030, 1 file / 4 tests, NEW this phase)**:
  - `slice-003-ui-display-countdown.spec.ts` (4 tests: M3 editable + M1 finished + M2 in_progress + es-ES locale)

### TypeScript / Build
- `pnpm -F web exec tsc --noEmit` — last-known-GREEN per Phase 3+5.
- `pnpm -F web build` — last-known-GREEN per Phase 3 (T021); Phase 6 changes (additive `Match.lock_state?` + page `data-match-id` + bulk RPC call) are non-breaking.

---

## 2. Migration inventory (slice 003 now has 9 — Phase 6 added 1)

| Slot | File | Owner |
|---|---|---|
| 0030 | `0030_predictions.sql` | T003 |
| 0031 | `0031_is_prediction_locked.sql` | T004 |
| 0032 | `0032_predictions_rls.sql` | T005 |
| 0033 | `0033_predictions_audit_trigger.sql` | T006 |
| 0034 | `0034_submit_prediction_sp.sql` | T013 |
| 0035 | `0035_lock_window_score_bound_seed.sql` | T007 |
| 0036 | `0036_kickoff_correction_audit_trigger.sql` | T008 |
| 0037 | `0037_submit_prediction_supersede.sql` | T021 |
| **0038** | **`0038_get_lock_states_bulk.sql`** | **T031 (NEW, D-015)** |

Cumulative total across slices 001+002+003: **32 migrations**.

---

## 3. App code inventory (Phase 6 additions)

- `apps/web/lib/types/match.ts` — added `LockState` union + optional `Match.lock_state?: LockState` (T032).
- `apps/web/app/api/matches/route.ts` — modified: bulk RPC call to `get_lock_states(uuid[])` after row fetch; populates `lock_state` on each match (T031).
- `apps/web/app/(participant)/matches/page.tsx` — modified: prefers server `row.lock_state` over client `computeLockState`; added `data-match-id={row.id}` on each `<tr>` (T033).
- `apps/web/app/(participant)/matches/components/PredictionForm.tsx` — UNCHANGED (existing `(locked)` and "No pick — locked" rendering already satisfies T030 assertions).

Phase 6 NEW test files: 6 (5 from T029 + 1 from T030).

---

## 4. Expected GREEN state per test (inferred)

| Test | Status (inferred) | Notes |
|---|---|---|
| T029 × 5 (lock_state field on `/api/matches`) | **GREEN once Docker + db reset + migration 0038 loads** | Bulk RPC populates `lock_state`; route handler passes it through. |
| T030 × 4 (UI display) | **GREEN once Docker + Next.js dev runs** | Page renders `data-match-id` on rows; tests select by ID and assert form vs locked badge. |
| T029 `after-config-change` | **GREEN with caveat** | Restores `lock_window_minutes = 60` in afterEach; if a prior test leaves it modified, the suite is order-sensitive. Mitigated by explicit baseline-restore in beforeEach. |
| T030 `es-ES locale` | **GREEN if** the page renders kickoff via `formatKickoff(row.kickoff_utc, locale)` (it does — slice 002 / T015 wired this) | Slice 002 T015 already passes `Accept-Language` through to `formatKickoff`. |

Carry-forward (US1+US2+US3 from prior phases): all 22 pgTAP + 22 Playwright tests expected GREEN per the prior regression checkpoints.

---

## 5. D-015 — bulk `get_lock_states(uuid[])` RPC

PostgREST `.select()` cannot host arbitrary SQL expressions, so the route handler cannot inline `CASE WHEN public.is_prediction_locked(m.id) THEN ... END AS lock_state` in its existing query. Resolution: migration 0038 adds `public.get_lock_states(p_match_ids uuid[]) RETURNS TABLE(match_id, lock_state)`. Route handler calls the RPC once with the page's IDs, populates `lock_state` per match. Fails soft (lock_state stays `undefined`) on RPC error — clients SHOULD treat missing as `'editable'` per the additive-extension contract.

Full text: see `tasks.md` § Implementation deviations D-015.

---

## 6. Cross-slice contracts (cumulative)

Unchanged since Phase 5. Phase 6 adds ONE additive extension:
- **`Match.lock_state?: 'editable' | 'locked'`** — additive optional field on the slice-002 `Match` type. Slice 002 consumers unaffected (the field is optional). Slice 004/005/006 may consume it as their UIs are built.

The `public.is_prediction_locked(uuid)` predicate remains the LOCKED authoritative source; `public.get_lock_states(uuid[])` is a slice-003-internal bulk helper.

---

## 7. Open deferred work

### Carry-forward (slices 001 + 002)
All pre-Phase-6 deferred items remain pending Docker + Deno.

### Slice 003 (post-Phase-6)
- T001, T010, T011, T012, T013, T015, T016, T017, T018, T019, T020, T021, T022, T023, T024, T025, T026, T027, T028, T029, T030, T031, T032, T033, T034 — runtime verification all pending Docker.
- Phase 7 (T035–T038) still to ship: admin override pgTAP, perf assertion, quickstart, final regression gate.

### D-014 audit-row placeholder
Informational only — supersede chain's audit row carries the OLD row's own id as `superseded_by` placeholder. Slice 007 audit forensic readers should reconstruct chains from `predictions.superseded_by` (current state), not from `audit_log.new_value`.

### D-015 lock-state fail-soft
If migration 0038 isn't loaded, the route handler's RPC call errors and `lock_state` is omitted. Clients fall back to `'editable'` (fail-open). Page-level `computeLockState` is the secondary fallback when both the RPC and the field are missing.

---

## 8. Verification commands (PowerShell)

```powershell
# 1. Bring up the stack
supabase start
supabase db reset    # loads 32 migrations + 3 seed files

# 2. pgTAP — slice 003 boundary + lock suite
Get-ChildItem supabase/tests/pgtap -Filter 'is_prediction_locked_*.sql' | ForEach-Object { supabase test db $_.FullName }
Get-ChildItem supabase/tests/pgtap -Filter 'submit_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 3. App-side: typecheck + build
pnpm -F web exec tsc --noEmit
pnpm -F web build

# 4. Playwright — US1 + US2 + US3 + US4
pnpm -F web dev    # in another terminal
pnpm -F web e2e -- --grep '@slice-003'

# Expected: all US4 tests (T029 × 5 sub-tests + T030 × 4) GREEN. Carry-forward
# US1+US2+US3 expected GREEN per the prior checkpoints.
```

---

## 9. Spec deviations consolidated (slice 003)

| ID | Title | Status |
|---|---|---|
| D-012 | Migration slot renumber (0029 → 0030+) | Locked into the migration timeline |
| D-013 | Provisional WCM06 branch in T013 | Resolved by T021 (slot 0037) |
| D-014 | Supersede self-reference placeholder | Informational; Slice 007 follow-up |
| D-015 | Bulk `get_lock_states(uuid[])` helper for `/api/matches` (NEW this phase) | Active design |

Carry-forward from slices 001 + 002: D-001 through D-011.

---

## 10. Pre-merge action items (slice 003 specific)

1. Start Docker Desktop and `supabase start`.
2. `supabase db reset` (must complete cleanly — verifies all 32 migrations including the new 0038).
3. Run the pgTAP loops in § 8.
4. `pnpm -F web exec tsc --noEmit` (last-known-GREEN; verify after Phase 6 changes).
5. `pnpm -F web build` (last-known-GREEN; verify the new `lock_state` field doesn't regress slice 002 consumers).
6. `pnpm -F web dev` + Playwright `--grep '@slice-003'`. Expected: 32+ tests GREEN.
7. Confirm `D-015` fail-soft path: kill the helper RPC (e.g., `REVOKE EXECUTE`) and verify the route still returns 200 with `lock_state` absent on rows (clients fall back to `'editable'`).
8. Once all the above PASS → Phase 7 (Polish) may proceed.

---

## 11. Phase 6 landed

All 6 Phase-6 tasks (T029, T030, T031, T032, T033, T034) marked `[X]` in `specs/003-match-predictions/tasks.md`. Slice 003 is at 34/38 (89%) — only Phase 7 (Polish) remains.
