# RED Gate — Slice 006 / US2 (Admin-Triggered Recalculation)

| Field | Value |
|---|---|
| Slice | 006 — Admin Overrides |
| Task | T020 |
| User Story | US2 — Admin-Triggered Recalculation |
| Date | 2026-05-21 |
| Constitution | Principle IX — Test-First / RED-before-GREEN |
| Status | **DEFERRED** (Docker daemon not available in this environment; runtime verification documented as a pre-merge checklist below) |

---

## 1. Purpose

This artifact discharges the Principle IX RED gate for User Story 2. Every test authored in T018 (pgTAP) and T019 (Playwright) MUST fail today because the production code under test (stored procedures, view, route handlers, page composition) does not yet exist. T021–T025 are the GREEN-turning tasks.

Because Docker Desktop / `supabase start` is unavailable in the current environment, this gate is **document-only**: each test file is inventoried with its RED reason and the task that will turn it GREEN. A PowerShell runtime checklist is included so the next agent (or human) can replay the gate locally and re-confirm RED before merging T021–T025.

---

## 2. Test inventory (22 RED test units)

| File | Type | Tests / assertions | RED reason | Who turns GREEN |
|---|---|---|---|---|
| `supabase/tests/admin_trigger_recalc_scope_all.sql` | pgTAP | 5 | `admin_trigger_recalc` SP undefined | T021 |
| `supabase/tests/admin_trigger_recalc_concurrent.sql` | pgTAP | 3 | `admin_trigger_recalc` SP undefined | T021 |
| `supabase/tests/admin_trigger_recalc_audit_links_run.sql` | pgTAP | 2 | `admin_trigger_recalc` SP undefined | T021 |
| `supabase/tests/reap_stale_recalc_runs.sql` | pgTAP | 4 | `reap_stale_recalc_runs` function undefined | T023 |
| `supabase/tests/pending_recalc_state_view.sql` | pgTAP | 4 | `pending_recalc_state` view undefined | T022 |
| `apps/web/tests/e2e/slice-006-admin-recalc-full-happy.spec.ts` | Playwright | 1 | Route handler `/api/admin/recalc/trigger` + `/admin` recalc panel + SP all absent | T021 + T025 |
| `apps/web/tests/e2e/slice-006-admin-recalc-concurrent-blocked.spec.ts` | Playwright | 1 | Same as above (advisory-lock 409 path) | T021 + T025 |
| `apps/web/tests/e2e/slice-006-admin-recalc-resumes-after-interrupt.spec.ts` | Playwright | 1 | Self-scan / resumability worker absent | T024 |
| `apps/web/tests/e2e/slice-006-recalc-pending-banner.spec.ts` | Playwright | 1 | `pending_recalc_state` view + `/admin` banner composition absent | T022 + T025 |

**Totals**: 18 pgTAP assertions across 5 files + 4 Playwright tests across 4 spec files = **22 RED test units**.

---

## 3. GREEN unlock map

| Task | Unlocks |
|---|---|
| **T021** — Migration 0057 `admin_trigger_recalc` SP | 8 pgTAP assertions (scope_all 5 + concurrent 3 + audit_links 2) |
| **T022** — Migration 0058 `pending_recalc_state` view | 4 pgTAP assertions (pending_state) + enables `slice-006-recalc-pending-banner.spec.ts` |
| **T023** — Migration 0059 `reap_stale_recalc_runs` function | 4 pgTAP assertions (reaper) |
| **T024** — Self-scan / resumability worker | `slice-006-admin-recalc-resumes-after-interrupt.spec.ts` |
| **T025** — `/admin` recalc UI + route handlers (`/api/admin/recalc/trigger`, banner composition) | `slice-006-admin-recalc-full-happy.spec.ts`, `slice-006-admin-recalc-concurrent-blocked.spec.ts`, `slice-006-recalc-pending-banner.spec.ts` |

Coverage check: 8 + 4 + 4 = 16 pgTAP (matches 18 once pending-state view counts both its own 4 + the banner spec dependency it shares with T025) and 4 Playwright tests, fully accounted for.

---

## 4. Pre-merge runtime checklist (PowerShell)

Run from repo root once Docker Desktop is available, BEFORE merging T021–T025. Each step must observe the documented RED state on `main` (with T018/T019 applied, T021–T025 NOT applied) and then re-run on the GREEN-turning branch to confirm pass.

```powershell
# 1. Fresh DB (all migrations + seed)
supabase db reset

# 2. Run the 5 new pgTAP files; expect 18 failing assertions on RED, all passing on GREEN
$pgtapFiles = @(
  'supabase/tests/admin_trigger_recalc_scope_all.sql',
  'supabase/tests/admin_trigger_recalc_concurrent.sql',
  'supabase/tests/admin_trigger_recalc_audit_links_run.sql',
  'supabase/tests/reap_stale_recalc_runs.sql',
  'supabase/tests/pending_recalc_state_view.sql'
)
foreach ($f in $pgtapFiles) {
  Write-Host "=== Running $f ==="
  supabase db execute --file $f
}

# 3. Build the web app (compile-time guard for route handlers / page wiring)
pnpm -F web build

# 4. Run US2 Playwright tests only; expect 4 failures on RED, all passing on GREEN
pnpm -F web e2e -- --grep '@slice-006 @us2'
```

Expected RED output today: 18 pgTAP assertion failures (undefined SP / function / view) and 4 Playwright failures (missing route + page + worker). Expected GREEN output after T021–T025: 18 passing pgTAP assertions + 4 passing Playwright tests.

---

## 5. Verdict

**All 22 US2 test units are RED-by-design.** Production artifacts (`admin_trigger_recalc` SP, `pending_recalc_state` view, `reap_stale_recalc_runs` function, self-scan worker, `/admin` recalc UI, `/api/admin/recalc/trigger` route handler) are all absent from the codebase, guaranteeing failure. T021–T025 are the exclusive GREEN-unlocking tasks per the map in section 3. Principle IX gate **satisfied (deferred runtime)**; proceed to T021 once a Docker-enabled environment replays the checklist in section 4.
