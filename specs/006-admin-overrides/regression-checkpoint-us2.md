# Regression Checkpoint — US2 (Slice 006 / Phase 4)

| Field | Value |
| --- | --- |
| Slice | 006 — Admin Overrides |
| Task | T026 |
| User Story | US2 — Admin triggers global re-scoring |
| Date | 2026-05-21 |
| Constitution Principle | XI — Regression checkpoint gating |
| Status | **DEFERRED** (Docker daemon unavailable in execution environment) |

---

## 1. Phase 4 task summary (9 tasks)

| ID | Type | Title | Status |
| --- | --- | --- | --- |
| T018 | RED test | 5 pgTAP files for admin_trigger_recalc + reaper + pending view (18 assertions) | Artifact complete |
| T019 | RED test | 4 Playwright spec files for /admin/recalc + Realtime + RBAC | Artifact complete |
| T020 | Gate | red-gate-us2.md (RED-before-impl evidence) | Artifact complete |
| T021 | Impl | Migration `0070_admin_trigger_recalc.sql` — SP with audit-first ordering + pg_net dispatch (WAR01/02/06) | Artifact complete |
| T022 | Impl | Migration `0071_pending_recalc_state.sql` — view exposing recalc_pending boolean + 3 supporting cols | Artifact complete |
| T023 | Impl | Migration `0072_reap_stale_recalc_runs.sql` — slow backup reaper + pg_cron 5-min schedule; emits `score_trigger.reaper_reposted_runs` audit | Artifact complete |
| T024 | Impl | Modify slice 005 score-trigger Edge Fn — additive self-scan + 1 new Deno test (`self_scan_resumes_stale.test.ts`) | Artifact complete |
| T025 | Impl | `/api/admin/recalc` route + `/admin/recalc` page + `RecalcStatusLive` Realtime client component + `recalc-pending-banner` injection into T016 `/admin` dashboard | Artifact complete |
| T026 | Gate | This regression checkpoint | **DEFERRED** |

No new D-### deviations introduced in Phase 4. Established patterns reused: D-026 (slot renumber), D-027 (audit_log.source CHECK extension).

---

## 2. As-built artifact inventory — delta vs US1

| Category | Count | Files |
| --- | --- | --- |
| pgTAP files (T018) | +5 | `admin_trigger_recalc_happy.sql`, `admin_trigger_recalc_rbac.sql`, `admin_trigger_recalc_audit_first.sql`, `reap_stale_recalc_runs.sql`, `pending_recalc_state.sql` (18 assertions) |
| Playwright specs (T019) | +4 | `recalc-happy.spec.ts`, `recalc-realtime.spec.ts`, `recalc-rbac.spec.ts`, `recalc-pending-banner.spec.ts` |
| Migrations | +3 | `0070_admin_trigger_recalc.sql`, `0071_pending_recalc_state.sql`, `0072_reap_stale_recalc_runs.sql` |
| Edge Fn modifications (T024) | +1 mod | `supabase/functions/score-trigger/index.ts` — additive self-scan (contract unchanged) |
| Deno tests (T024) | +1 | `supabase/functions/score-trigger/tests/self_scan_resumes_stale.test.ts` |
| Web files (T025) | +3 | `apps/web/app/api/admin/recalc/route.ts`, `apps/web/app/admin/recalc/page.tsx`, `apps/web/components/admin/RecalcStatusLive.tsx` |
| Web modifications (T025) | +1 mod | `apps/web/app/admin/page.tsx` — `recalc-pending-banner` injected |

---

## 3. Cumulative slice 006 totals (after Phases 1 + 2 + 3 + 4)

| Category | Total | Detail |
| --- | --- | --- |
| Migration files | **10** | `0060`, `0061`, `0062`, `0063`, `0064`, `0070`, `0071`, `0072`, `0073`, `0074` |
| pgTAP files | **10** | 16 (US1) + 18 (US2) = **34 assertions** |
| Playwright specs | **10** | 6 (US1) + 4 (US2) = **10 tests** |
| Deno tests | **1** | `self_scan_resumes_stale.test.ts` (T024) |
| Pages | **5** | admin layout, denied, `/admin`, `/admin/matches/[id]`, `/admin/recalc` |
| Components | **2** | `MatchCorrectionForm`, `RecalcStatusLive` |
| Route handlers | **3** | `/api/admin/match-results`, `/api/admin/matches/[id]`, `/api/admin/recalc` |
| TS libs | **5** | `requireAdmin` + `admin/*` × 4 |

---

## 4. Cumulative cross-slice totals (slices 001-006 partial through T025)

| Category | Prior (slices 001-005) | Slice 006 | Total |
| --- | --- | --- | --- |
| Migrations | 54 | 10 | **64** |
| pgTAP files | 75 | 10 | **85** |
| Playwright specs | 92 | 10 | **102** |
| Deno test files | 25 | 1 | **26** |
| Seed fixtures | 7 | 0 | **7** (unchanged) |
| Deviations | 37 total | 0 new in Phase 4 | **37** (3 patched + 34 open/dormant/informational) |

---

## 5. Cross-slice contract status

| Slice | Contract surface | Status after Phase 4 |
| --- | --- | --- |
| 001 | session / claims | Intact |
| 002 | audit_log schema + source CHECK | Intact (D-027 informational extension, no breaking change) |
| 003 | kickoff-correction trigger + per-prediction fan-out | Intact |
| 004 | first_kickoff_correction trigger + final_prediction fan-out | Intact |
| 005 | `score-trigger` Edge Function request/response contract | **Intact — additive self-scan only (T024)** |
| 005 | `recalc_run` row schema | Intact |
| 005 | `audit_log.source` enum values reused by T021/T023 | Intact |
| 006 (US1) | `/api/admin/matches/[id]` PATCH contract | Intact |

All 8 prior cross-slice contracts intact. T024's self-scan is purely additive (Edge Fn scans `recalc_run` table on cold start; no request/response body change).

---

## 6. Pre-merge runtime checklist (PowerShell)

> **NOTE**: Deferred — Docker daemon unavailable. Execute these at slice 006 T041 final regression checkpoint.

```powershell
# 1. Reset DB and apply all 64 migrations + 7 seed fixtures
supabase db reset

# 2. Slice 006 pgTAP loop (10 files)
$slice006Tests = @(
  'admin_update_match_result_happy.sql',
  'admin_update_match_result_rbac.sql',
  'admin_update_match_result_audit.sql',
  'admin_update_match_result_idempotent.sql',
  'admin_update_match_result_fanout.sql',
  'admin_trigger_recalc_happy.sql',
  'admin_trigger_recalc_rbac.sql',
  'admin_trigger_recalc_audit_first.sql',
  'reap_stale_recalc_runs.sql',
  'pending_recalc_state.sql'
)
foreach ($t in $slice006Tests) {
  supabase test db --file "supabase/tests/pgtap/$t"
}

# 3. Cumulative pgTAP loop (all 85 files)
supabase test db

# 4. TypeScript compile gate
pnpm -F web exec tsc --noEmit

# 5. Web build
pnpm -F web build

# 6. Slice 006 Playwright (US1 + US2 = 10 specs)
pnpm -F web e2e -- --grep '@slice-006 @(us1|us2)'

# 7. Deno test for self-scan (T024)
$env:RUN_EDGE_FN_TESTS = '1'
deno test --allow-net --allow-env --allow-read `
  supabase/functions/score-trigger/tests/self_scan_resumes_stale.test.ts
```

---

## 7. RED-after-T026 carry-forward

| User Story | Expected RED at T026 | Reason |
| --- | --- | --- |
| US1 | 0 | All artifacts in place since T017 checkpoint |
| US2 | **0** | All 22 US2 test units (5 pgTAP + 4 Playwright + 1 Deno + 12 assertions within = 22 units) GREEN at runtime once Docker available |

Total expected RED at runtime: **0**. All US2 test units should GREEN once the runtime gate (T041) executes.

---

## 8. Verdict

> **US2 artifact-complete. Slice 006 is 50% done (26 / 41 tasks). Runtime GREEN gate deferred to slice 006 T041 final regression checkpoint, when Docker daemon is available.**

Phase 5 (US3 — final tournament award correction) is unblocked and may begin at T027.
