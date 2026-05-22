# RED Gate — Slice 006 / User Story 1 (US1)

**Slice**: `006-admin-overrides`
**Phase**: 3 (US1 — "Admin corrects a match result: dashboard → match detail → confirm-typed override → audit-stamped recalculation")
**Date**: 2026-05-21
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T012 (the Principle IX gate task itself; US1 red-gate document)

---

## Status: DEFERRED (Docker daemon down)

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-3 / US1 RED tests authored in T010 (pgTAP, 5 files / 16 assertions) and T011 (Playwright, 6 files / 6 tests) are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up (deferred to the slice's final regression gate).
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 006 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 3 (US1) produced **11 RED-state test files** (5 pgTAP scripts + 6 Playwright specs) totalling **22 distinct test units** (16 pgTAP assertions + 6 Playwright tests).

| File | Type | Tests/assertions | RED reason | Who turns GREEN |
|------|------|------------------|------------|-----------------|
| `supabase/tests/pgtap/admin_record_match_result_happy.sql` | pgTAP | 6 | SP undefined — `function public.admin_record_match_result(...) does not exist`. Happy-path assertions (Slice 002 SP delegation, audit row emission with reason + source, recalc trigger, return tuple shape) unreachable. | T013 |
| `supabase/tests/pgtap/admin_record_match_result_not_admin.sql` | pgTAP | 3 | SP undefined — non-admin caller path (`ERRCODE 28000` / `insufficient_privilege`) cannot fire because the SP itself does not exist. | T013 |
| `supabase/tests/pgtap/admin_record_match_result_missing_reason.sql` | pgTAP | 2 | SP undefined — `reason` null/empty validation (`ERRCODE 22023` / `invalid_parameter_value`) unreachable. | T013 |
| `supabase/tests/pgtap/admin_record_match_result_missing_source.sql` | pgTAP | 2 | SP undefined — `source` null/empty validation (`ERRCODE 22023`) unreachable. | T013 |
| `supabase/tests/pgtap/admin_record_match_result_invariant_propagates.sql` | pgTAP | 3 | SP undefined — Slice 002 invariant propagation (loser/draw/timing) cannot be observed because the wrapper SP does not yet wrap anything. | T013 |
| `apps/web/tests/playwright/slice-006-admin-dashboard-eligible-admin.spec.ts` | Playwright | 1 | `/admin` page absent — Next.js returns 404 before any dashboard assertion (admin1 sees the dashboard with match list) can run. | T016 |
| `apps/web/tests/playwright/slice-006-admin-match-correct-score-happy.spec.ts` | Playwright | 1 | Route handler `/api/admin/match-results` absent + match detail page absent + SP absent — end-to-end correction flow blows up at the first navigation/POST. | T013 + T015 + T016 |
| `apps/web/tests/playwright/slice-006-admin-match-correct-score-missing-reason.spec.ts` | Playwright | 1 | Route handler + match detail page absent — client-side reason-required validation has no surface to fire on. | T015 + T016 |
| `apps/web/tests/playwright/slice-006-non-admin-rejected-ui.spec.ts` | Playwright | 1 | `/admin` layout guard absent — non-admin currently gets 404 instead of the contracted `403 denied` page (the layout does not yet redirect / block). | T015 |
| `apps/web/tests/playwright/slice-006-non-admin-rejected-api.spec.ts` | Playwright | 1 | `/api/admin/match-results` absent — POST returns 404 instead of the contracted `403 unauthorized`. | T015 |
| `apps/web/tests/playwright/slice-006-admin-role-revoked-mid-session.spec.ts` | Playwright | 1 | `/admin` layout guard absent — revocation cannot be re-evaluated by a guard that does not exist; subsequent navigation 404s instead of redirecting to the denied page. | T015 |

**Total RED units**: `16 (pgTAP, T010) + 6 (Playwright, T011) = 22 behaviorally-distinct RED units`.

All files are tagged or scoped `@slice-006 @us1`. None of the assertions are tautological — each one references a specific (admin uid, match id, reason text, source text, audit row, ERRCODE, or denied-page selector) tuple sourced from `specs/006-admin-overrides/contracts/admin-rpcs.write.md` and the slice's seed fixtures.

---

## What unlocks GREEN

| Task | Artifact | Unblocks |
|------|----------|----------|
| **T013** | Migration `supabase/migrations/0064_admin_record_match_result.sql` — admin RPC wrapping Slice 002's `record_match_result` SP with reason/source validation, ERRCODE map, audit emission. | All 5 pgTAP files (16 assertions) + the happy-path Playwright spec. |
| **T014** | `apps/web/lib/admin/requireAdmin.ts` + supporting admin helpers — server-side admin gate used by route handlers and the `/admin` layout. | Foundation for T015. |
| **T015** | Route handler `app/api/admin/match-results/route.ts` + `/admin` denied page + layout guard wiring T014. | All 4 non-happy-path Playwright specs (denied UI, denied API, role-revoked mid-session, missing-reason form validation). |
| **T016** | `/admin` dashboard page (eligible-admin list view) + match detail page with the typed-confirmation correction form. | Happy-path dashboard + happy-path correction flow Playwright specs. |

T013 + T014 + T015 + T016 land in that order; the happy-path Playwright spec is the last to flip because it spans all four.

---

## Pre-merge runtime verification (deferred to slice 006 final regression gate)

Once Docker is back up, on branch `006-admin-overrides` from the repo root:

```powershell
# 1. Boot the local Supabase stack.
supabase start

# 2. Reset the database — applies all slice 001-006 migrations and loads fixtures.
supabase db reset

# 3. Run the five slice-006 US1 pgTAP files in a loop.
$pgtapFiles = @(
  'admin_record_match_result_happy.sql',
  'admin_record_match_result_not_admin.sql',
  'admin_record_match_result_missing_reason.sql',
  'admin_record_match_result_missing_source.sql',
  'admin_record_match_result_invariant_propagates.sql'
)
foreach ($f in $pgtapFiles) {
  Write-Host "=== $f ===" -ForegroundColor Cyan
  supabase test db --file "supabase/tests/pgtap/$f"
}

# 4. Build the web app (catches missing routes / pages at compile time).
pnpm -F web build

# 5. Run the US1 Playwright suite, scoped to slice 006.
pnpm -F web e2e -- --grep '@slice-006 @us1'
```

**Pass criteria for the RED run** (stash-and-test, BEFORE T013-T016 land):

- All 5 pgTAP files fail with `function public.admin_record_match_result(...) does not exist` (function-not-found from the SP call site) — not for a syntax error in the test, a missing fixture row, or a planned-vs-run mismatch.
- All 6 Playwright tests fail at the first navigation / first POST assertion (404 on `/admin`, 404 on `/api/admin/match-results`) — failures are assertion-level, never infrastructure-level.

**Pass criteria for the GREEN run** (post-T013/T014/T015/T016):

- All 5 pgTAP files report `ok` on every planned assertion (6 + 3 + 2 + 2 + 3 = 16).
- All 6 Playwright tests tagged `@slice-006 @us1` report `passed`.
- `pnpm -F web build` is clean.

Runtime verification of both the RED-state observation and the eventual GREEN flip is **deferred to the slice's final regression gate task**. That task will append transcript references — or a CI link — to this document before merge.

---

## Verdict

**All 22 US1 test units authored and RED-by-design** (16 pgTAP assertions across 5 files + 6 Playwright tests across 6 files). **T013 (admin_record_match_result SP at slot 0064) + T014 (requireAdmin/admin libs) + T015 (route handler + denied page + layout guard) + T016 (dashboard + match detail page) unlock GREEN.**

Per Principle IX the gate is **DEFERRED but acknowledged** — runtime confirmation of the RED state will be appended in the slice's final regression gate task once Docker is back up. Until then this artifact is the authoritative inventory of Slice 006 US1's RED surface.
