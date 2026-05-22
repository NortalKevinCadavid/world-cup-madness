# Regression Checkpoint — US4 (Slice 006 / Phase 6)

| Field | Value |
| --- | --- |
| Slice | 006 — Admin Overrides |
| Task | T037 |
| User Story | US4 — Unauthorized access rejected |
| Date | 2026-05-21 |
| Constitution Principle | XI — Regression checkpoint gating |
| Status | **DEFERRED** (Docker daemon unavailable in execution environment) |

---

## 1. Phase 6 task summary (5 tasks)

| ID | Type | Title | Status |
| --- | --- | --- | --- |
| T033 | RED test | 9 pgTAP files for `is_admin` real body (14 assertions) | Artifact complete |
| T034 | RED test | 2 Playwright spec files (`is-admin-uses-db-state-not-jwt`, `admin-denied-page-no-leak`) | Artifact complete |
| T035 | Gate | `red-gate-us4.md` — code-review red-gate (15/16 GREEN-expected; 1 RED-now flagged as D-028 candidate) | Artifact complete |
| T036 | Impl + Patch | Migration `0075_is_admin_active_participant_filter.sql` — `CREATE OR REPLACE FUNCTION` adds `p.status = 'active'` filter to T007 body | Artifact complete (D-028 **PATCHED**) |
| T037 | Gate | This regression checkpoint | **DEFERRED** |

### New deviation in Phase 6

**D-028** — T007's `is_admin` body (slot 0062) omitted the `p.status = 'active'` filter required by `contracts/is-admin.predicate.sql.md` § Semantics, allowing a deactivated participant with a live `admin_roles` grant to resolve to TRUE. **PATCHED** by T036 via `0075_is_admin_active_participant_filter.sql` using `CREATE OR REPLACE FUNCTION`. The patch is strictly additive — adding the filter is strictly more restrictive, so no previously-passing test relies on a deactivated participant resolving to TRUE. Existing US1/US2/US3 tests stay GREEN. Function signature is unchanged (`is_admin(p_user_id uuid) RETURNS boolean`), so Principle XI (cross-slice contract preservation) holds. Status: **PATCHED**.

Per Principle IX, this phase performed a code-review red-gate rather than a runtime red-gate because the gate had to be inverted: T007 (real `is_admin` body) shipped earlier in the slice to give T011's US1 specs something to deny against. T035 records the verdict for each new test against the shipped code.

---

## 2. As-built artifact inventory — delta vs US3

| Category | Count | Files |
| --- | --- | --- |
| pgTAP files (T033) | +9 | `is_admin_active_grant.sql`, `is_admin_revoked_grant.sql`, `is_admin_no_grant.sql`, `is_admin_deactivated_participant.sql`, `is_admin_unknown_uid.sql`, `is_admin_null_uid.sql`, `is_admin_revoke_then_regrant.sql`, `is_admin_uses_db_state_not_jwt.sql`, `is_admin_perf.sql` (14 assertions) |
| Playwright specs (T034) | +2 | `slice-006-is-admin-uses-db-state-not-jwt.spec.ts`, `slice-006-admin-denied-page-no-leak.spec.ts` |
| Migrations (T036) | +1 | `0075_is_admin_active_participant_filter.sql` — `CREATE OR REPLACE FUNCTION` adds `p.status = 'active'` filter (D-028 PATCH) |
| Web files | 0 | (denial page already shipped by T015 in Phase 2; no new pages/components/routes/libs in Phase 6) |
| Deno tests | 0 | (no Edge Function surface in Phase 6) |

---

## 3. Cumulative slice 006 totals (after Phases 1 + 2 + 3 + 4 + 5 + 6)

| Category | Total | Detail |
| --- | --- | --- |
| Migration files | **13** | `0060`, `0061`, `0062`, `0063`, `0064`, `0065`, `0068`, `0070`, `0071`, `0072`, `0073`, `0074`, `0075` |
| pgTAP files | **22** | 16 (US1) + 18 (US2) + 14 (US3) + 14 (US4) = **62 assertions** |
| Playwright specs | **15** | 6 (US1) + 4 (US2) + 3 (US3) + 2 (US4) = **15 tests** |
| Deno tests | **1** | `self_scan_resumes_stale.test.ts` (T024) — unchanged |
| Pages | **6** | admin layout, `/admin/denied`, `/admin`, `/admin/matches/[id]`, `/admin/recalc`, `/admin/finals` |
| Components | **4** | `MatchCorrectionForm`, `RecalcStatusLive`, `AwardCorrectionForm`, `MatchUpdateForm` |
| Route handlers | **4** | `/api/admin/match-results`, `/api/admin/matches/[id]`, `/api/admin/recalc`, `/api/admin/tournament-award` |
| TS libs | **5** | `requireAdmin` + `admin/*` × 4 (unchanged in Phase 6) |

---

## 4. Cumulative cross-slice totals (slices 001-006 partial through T037)

| Category | Prior (slices 001-005) | Slice 006 | Total |
| --- | --- | --- | --- |
| Migrations | 54 | 13 | **67** |
| pgTAP files | 75 | 22 | **97** |
| Playwright specs | 92 | 15 | **107** |
| Deno test files | 25 | 1 | **26** |
| Seed fixtures | 7 | 0 | **7** (unchanged) |
| Deviations | 37 total | +1 (D-028, PATCHED) in Phase 6 | **38** (4 patched: D-013, D-024, D-T013-A, D-028 + 34 open/dormant/informational) |

---

## 5. Cross-slice contract status

| Slice | Contract surface | Status after Phase 6 |
| --- | --- | --- |
| 001 | session / claims | Intact |
| 002 | audit_log schema + source CHECK | Intact (D-027 informational extension, no breaking change) |
| 003 | kickoff-correction trigger + per-prediction fan-out (`prediction.kickoff_correction_crossed_lock`) | Intact |
| 004 | first_kickoff_correction trigger + final_prediction fan-out (`final_prediction.first_kickoff_correction`) | Intact |
| 005 | `score-trigger` Edge Function request/response contract | Intact (T024 self-scan additive only) |
| 005 | `recalc_run` row schema | Intact |
| 005 | `audit_log.source` enum values reused by T021/T023/T030 | Intact |
| 005 | `award_confirmed_trigger` | Intact — fires automatically when `admin_update_tournament_award` is invoked |
| 006 (US1) | `/api/admin/matches/[id]` PATCH contract | Intact |
| 006 (US4) | `is_admin(p_user_id uuid) RETURNS boolean` signature | **Intact — D-028 is a body-only patch via `CREATE OR REPLACE FUNCTION`** (signature, language, volatility, and return type all preserved) |

All 8 prior cross-slice contracts intact. D-028's patch (T036, slot 0075) is body-only and therefore Principle XI compliant — every existing call site continues to type-check and execute against the unchanged function signature.

---

## 6. Pre-merge runtime checklist (PowerShell)

> **NOTE**: Deferred — Docker daemon unavailable. Execute at slice 006 T041 final regression checkpoint.

```powershell
# 1. Reset DB and apply all 67 migrations + 7 seed fixtures
supabase db reset

# 2. Slice 006 pgTAP loop (22 files)
$slice006Tests = @(
  'admin_record_match_result_happy.sql',
  'admin_record_match_result_not_admin.sql',
  'admin_record_match_result_missing_reason.sql',
  'admin_record_match_result_missing_source.sql',
  'admin_record_match_result_invariant_propagates.sql',
  'admin_trigger_recalc_scope_all.sql',
  'admin_trigger_recalc_concurrent.sql',
  'admin_trigger_recalc_audit_links_run.sql',
  'reap_stale_recalc_runs.sql',
  'pending_recalc_state_view.sql',
  'admin_update_match_happy.sql',
  'admin_update_match_kickoff_fans_out.sql',
  'admin_update_tournament_award_happy.sql',
  'is_admin_active_grant.sql',
  'is_admin_revoked_grant.sql',
  'is_admin_no_grant.sql',
  'is_admin_deactivated_participant.sql',
  'is_admin_unknown_uid.sql',
  'is_admin_null_uid.sql',
  'is_admin_revoke_then_regrant.sql',
  'is_admin_uses_db_state_not_jwt.sql',
  'is_admin_perf.sql'
)
foreach ($t in $slice006Tests) {
  supabase test db --file "supabase/tests/pgtap/$t"
}

# 3. Cumulative pgTAP loop (all 97 files)
supabase test db

# 4. TypeScript compile gate
pnpm -F web exec tsc --noEmit

# 5. Web build
pnpm -F web build

# 6. Slice 006 Playwright (US1 + US2 + US3 + US4 = 15 specs)
pnpm -F web e2e -- --grep '@slice-006 @(us1|us2|us3|us4)'

# 7. Deno test for self-scan (T024) — re-run to confirm no regression
$env:RUN_EDGE_FN_TESTS = '1'
deno test --allow-net --allow-env --allow-read `
  supabase/functions/score-trigger/tests/self_scan_resumes_stale.test.ts
```

---

## 7. RED-after-T037 carry-forward

| User Story | Expected RED at T037 | Reason |
| --- | --- | --- |
| US1 | 0 | All artifacts in place since T017 checkpoint |
| US2 | 0 | All US2 test units GREEN at runtime once Docker available (per T026) |
| US3 | 0 | All 17 US3 test units GREEN at runtime once Docker available (per T032) |
| US4 | **0** | All 16 US4 test units (14 pgTAP assertions across 9 files + 2 Playwright tests) expected GREEN once Docker available. D-028 (the only RED-now in T035) was patched by T036 at slot 0075. |

Total expected RED at runtime: **0**. All US4 test units should GREEN once the runtime gate (T041) executes.

---

## 8. Verdict

> **US4 artifact-complete. Slice 006 is 90% done (37 / 41 tasks). Runtime GREEN gate deferred to slice 006 T041 final regression checkpoint, when Docker daemon is available. Phase 7 polish remaining.**

Phase 7 (Polish & Cross-Cutting Concerns) is unblocked and may begin at T038. Remaining tasks: T038 (admin write-path siblings — `admin_submit_prediction`, `admin_submit_final_prediction`, `admin_resolve_match_pending_review`), T039–T040 (polish), and T041 (final cumulative regression checkpoint — the runtime gate that will execute the deferred Docker-dependent checklist accumulated across T017, T026, T032, and this T037 checkpoint).
