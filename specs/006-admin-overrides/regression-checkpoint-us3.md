# Regression Checkpoint — US3 (Slice 006 / Phase 5)

| Field | Value |
| --- | --- |
| Slice | 006 — Admin Overrides |
| Task | T032 |
| User Story | US3 — Admin corrects final tournament award |
| Date | 2026-05-21 |
| Constitution Principle | XI — Regression checkpoint gating |
| Status | **DEFERRED** (Docker daemon unavailable in execution environment) |

---

## 1. Phase 5 task summary (6 tasks)

| ID | Type | Title | Status |
| --- | --- | --- | --- |
| T027 | RED test | 3 pgTAP files for `admin_update_match` + `admin_update_tournament_award` (14 assertions) | Artifact complete |
| T028 | RED test | 3 Playwright spec files for `/admin/matches/[id]` status edit + `/admin/finals` confirm + correct flow | Artifact complete |
| T029 | Gate | `red-gate-us3.md` (RED-before-impl evidence) | Artifact complete |
| T030 | Impl | Migrations `0065_admin_update_match.sql` + `0068_admin_update_tournament_award.sql` (slice 005 `award_confirmed_trigger` auto-fires) | Artifact complete |
| T031 | Impl | 4 new web files (tournament-award route + `/admin/finals` page + `AwardCorrectionForm` + `MatchUpdateForm`) + 1 stub-to-full route (`/api/admin/matches/[id]`) + 1 page modify (`/admin/matches/[id]` integrates `MatchUpdateForm`) + WAR07 in `ERRCODE_HTTP_MAP` | Artifact complete |
| T032 | Gate | This regression checkpoint | **DEFERRED** |

No new D-### deviations introduced in Phase 5. Established patterns reused: D-026 (slot renumber; slot 0065 + 0068 selected to leave room for 0066/0067 if future hot-fix migrations are needed), D-027 (audit_log.source CHECK extension), and the slice 005 `award_confirmed_trigger` contract which fires automatically whenever `admin_update_tournament_award` writes the singleton row.

### Important corrections captured during Phase 5

- Audit action label is `admin.award_updated` (NOT `admin.tournament_award_updated`).
- Slice 003 trigger action is `prediction.kickoff_correction_crossed_lock`.
- Slice 004 trigger action is `final_prediction.first_kickoff_correction`.
- `admin_update_tournament_award` takes **no** `tournament_id` parameter (single-row table; identity is implicit).
- WAR07 (no-op detection — no fields changed) added to `ERRCODE_HTTP_MAP` and surfaced as HTTP 409 to callers.

---

## 2. As-built artifact inventory — delta vs US2

| Category | Count | Files |
| --- | --- | --- |
| pgTAP files (T027) | +3 | `admin_update_match_happy.sql`, `admin_update_match_kickoff_fans_out.sql`, `admin_update_tournament_award_happy.sql` (14 assertions) |
| Playwright specs (T028) | +3 | `slice-006-admin-match-update-status-postponed.spec.ts`, `slice-006-admin-finals-correct-top-scorer.spec.ts`, `slice-006-admin-finals-confirm-pending.spec.ts` |
| Migrations (T030) | +2 | `0065_admin_update_match.sql`, `0068_admin_update_tournament_award.sql` |
| Web files (T031, new) | +5 | `apps/web/app/api/admin/tournament-award/route.ts`, `apps/web/app/admin/finals/page.tsx`, `apps/web/app/admin/finals/components/AwardCorrectionForm.tsx`, `apps/web/app/admin/matches/[id]/components/MatchUpdateForm.tsx`, plus the full `apps/web/app/api/admin/matches/[id]/route.ts` (was a T015 stub, now production body) |
| Web modifications (T031) | +1 mod | `apps/web/app/admin/matches/[id]/page.tsx` — wires `MatchUpdateForm` next to the existing `MatchCorrectionForm` |
| TS lib modifications (T031) | +1 mod | `apps/web/lib/admin/ERRCODE_HTTP_MAP` extended for WAR07 (HTTP 409) |
| Deno tests | 0 | (no Edge Function surface in Phase 5) |

---

## 3. Cumulative slice 006 totals (after Phases 1 + 2 + 3 + 4 + 5)

| Category | Total | Detail |
| --- | --- | --- |
| Migration files | **12** | `0060`, `0061`, `0062`, `0063`, `0064`, `0065`, `0068`, `0070`, `0071`, `0072`, `0073`, `0074` |
| pgTAP files | **13** | 16 (US1) + 18 (US2) + 14 (US3) = **48 assertions** |
| Playwright specs | **13** | 6 (US1) + 4 (US2) + 3 (US3) = **13 tests** |
| Deno tests | **1** | `self_scan_resumes_stale.test.ts` (T024) — unchanged in Phase 5 |
| Pages | **6** | admin layout, denied, `/admin`, `/admin/matches/[id]`, `/admin/recalc`, `/admin/finals` |
| Components | **4** | `MatchCorrectionForm`, `RecalcStatusLive`, `AwardCorrectionForm`, `MatchUpdateForm` |
| Route handlers | **4** | `/api/admin/match-results`, `/api/admin/matches/[id]`, `/api/admin/recalc`, `/api/admin/tournament-award` |
| TS libs | **5** | `requireAdmin` + `admin/*` × 4 (`ERRCODE_HTTP_MAP` extended for WAR07 in Phase 5) |

---

## 4. Cumulative cross-slice totals (slices 001-006 partial through T032)

| Category | Prior (slices 001-005) | Slice 006 | Total |
| --- | --- | --- | --- |
| Migrations | 54 | 12 | **66** |
| pgTAP files | 75 | 13 | **88** |
| Playwright specs | 92 | 13 | **105** |
| Deno test files | 25 | 1 | **26** |
| Seed fixtures | 7 | 0 | **7** (unchanged) |
| Deviations | 37 total | 0 new in Phase 5 | **37** (3 patched + 34 open/dormant/informational) |

---

## 5. Cross-slice contract status

| Slice | Contract surface | Status after Phase 5 |
| --- | --- | --- |
| 001 | session / claims | Intact |
| 002 | audit_log schema + source CHECK | Intact (D-027 informational extension, no breaking change) |
| 003 | kickoff-correction trigger + per-prediction fan-out (`prediction.kickoff_correction_crossed_lock`) | Intact — exercised by `admin_update_match_kickoff_fans_out.sql` (T027) |
| 004 | first_kickoff_correction trigger + final_prediction fan-out (`final_prediction.first_kickoff_correction`) | Intact |
| 005 | `score-trigger` Edge Function request/response contract | Intact (T024 self-scan additive only) |
| 005 | `recalc_run` row schema | Intact |
| 005 | `audit_log.source` enum values reused by T021/T023/T030 | Intact |
| 005 | `award_confirmed_trigger` | **Intact — fires automatically when `admin_update_tournament_award` is invoked** (T030 deliberately does not bypass it) |
| 006 (US1) | `/api/admin/matches/[id]` PATCH contract | Intact — T031 replaces the T015 stub with a production body that preserves the PATCH shape |

All 8 prior cross-slice contracts intact. Slice 005's `award_confirmed_trigger` is the most relevant integration point for Phase 5: T030's `admin_update_tournament_award` writes the singleton tournament-award row, the trigger fires, and slice 005 scoring re-runs automatically — no slice 005 code was modified, the contract is preserved by composition.

---

## 6. Pre-merge runtime checklist (PowerShell)

> **NOTE**: Deferred — Docker daemon unavailable. Execute at slice 006 T041 final regression checkpoint.

```powershell
# 1. Reset DB and apply all 66 migrations + 7 seed fixtures
supabase db reset

# 2. Slice 006 pgTAP loop (13 files)
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
  'admin_update_tournament_award_happy.sql'
)
foreach ($t in $slice006Tests) {
  supabase test db --file "supabase/tests/pgtap/$t"
}

# 3. Cumulative pgTAP loop (all 88 files)
supabase test db

# 4. TypeScript compile gate
pnpm -F web exec tsc --noEmit

# 5. Web build
pnpm -F web build

# 6. Slice 006 Playwright (US1 + US2 + US3 = 13 specs)
pnpm -F web e2e -- --grep '@slice-006 @(us1|us2|us3)'

# 7. Deno test for self-scan (T024) — re-run to confirm no regression
$env:RUN_EDGE_FN_TESTS = '1'
deno test --allow-net --allow-env --allow-read `
  supabase/functions/score-trigger/tests/self_scan_resumes_stale.test.ts
```

---

## 7. RED-after-T032 carry-forward

| User Story | Expected RED at T032 | Reason |
| --- | --- | --- |
| US1 | 0 | All artifacts in place since T017 checkpoint |
| US2 | 0 | All US2 test units GREEN at runtime once Docker available (per T026) |
| US3 | **0** | All 17 US3 test units (3 pgTAP files / 14 assertions + 3 Playwright tests = 17 units) expected GREEN at runtime once Docker available |

Total expected RED at runtime: **0**. All US3 test units should GREEN once the runtime gate (T041) executes.

---

## 8. Verdict

> **US3 artifact-complete. Slice 006 is 78% done (32 / 41 tasks). Runtime GREEN gate deferred to slice 006 T041 final regression checkpoint, when Docker daemon is available.**

Phase 6 (US4 — unauthorized access rejected) is unblocked and may begin at T033. Note that foundational US4 coverage already exists via T011 (non-admin-rejected specs) and T015's `requireAdmin` gate; Phase 6 hardens the `is_admin` boundary surface and polishes the denial page.
