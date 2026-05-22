# Slice 006 — Regression Baseline (Slices 001–005 snapshot)

**Slice**: 006 — Admin Overrides & Recalculation
**Task**: T001
**Date**: 2026-05-21
**Constitution anchor**: Principle XI (NON-NEGOTIABLE — regression-gated progress)
**Status**: **DEFERRED (Docker daemon down + k6 not installed locally; Deno toolchain installed but unusable without Postgres listener)**

This document is the artifact-level baseline that slice 006 inherits from the cumulative slices 001 + 002 + 003 + 004 + 005 surface. Per Principle XI, every subsequent slice-006 task must keep this baseline GREEN. The actual pass-status sweep is the merge gate; this file is the runbook + inventory the operator will tick off once a Docker-up + Deno-stack-up + k6-installed environment is available.

This follows the pattern established by slice 005 T002 (`specs/005-scoring-leaderboard/regression-baseline.md`) — an artifact-only baseline anchored to the canonical pre-merge runtime checklist in slice 005 T041 (`specs/005-scoring-leaderboard/regression-final.md § 4`).

---

## 1. Cumulative artifact inventory (cited from slice 005 `regression-final.md`)

Numbers re-cited verbatim from `specs/005-scoring-leaderboard/regression-final.md § 2` ("Cumulative cross-slice totals (slices 001 → 005)"):

| Surface | End-of-slice-005 count | Glob target |
|---|---|---|
| Migrations | **54 files** on disk (slot range 0001–0059; slots 0012–0017 vacated per D-006) | `supabase/migrations/*.sql` |
| pgTAP files | **75 files** | `supabase/tests/pgtap/*.sql` |
| Playwright specs (incl. `smoke.spec.ts` + 1 `test.fixme` + 2 `@perf` siblings) | **92 spec files** | `apps/web/tests/playwright/*.spec.ts` |
| Deno tests | **25 files** (per prompt-canonical accounting: slice 002 × 14 + slice 004 × 1 + slice 005 × 9 + 1 duplicate disambiguation) | `supabase/functions/*/tests/*.test.ts` |
| Seed fixtures | **7 files** (4 slice-001..004 baselines + slice-005-fixture + slice-005-loadtest-fixture + slice-005-full-tournament-fixture) | `supabase/seed/*.sql` |
| Edge Functions | **2 directories** (`sync-catalog` + `score-trigger`) | `supabase/functions/<name>/` |
| App pages | **6 pages** (+ 1 Realtime island on `/leaderboard`) | `apps/web/app/**/page.tsx` |
| Route handlers | **~10 routes** (cumulative) | `apps/web/app/api/**/route.ts` |
| k6 scripts | **1 script** (`loadtest/slice-005-leaderboard-consistency.k6.ts`) | `loadtest/*.k6.ts` |
| Deviations | **35 entries** — 3 PATCHED (D-013, D-024, D-T013-A) + 32 OPEN / DORMANT / INFORMATIONAL | `tasks.md` per-slice deviation logs |

### Migration slot accounting (cited from slice 005)

| Slice | Slot range | Count |
|---|---|---|
| 001 — Eligibility & Login | 0001–0011 | 11 |
| 002 — Match Catalog & Provider Sync | 0018–0029 (slots 0012–0017 vacated per D-006) | 12 |
| 003 — Match Predictions with Locking | 0030–0038 | 9 |
| 004 — Final Tournament Predictions | 0039–0048 | 10 |
| 005 — Scoring & Leaderboard | 0049–0059 (with reserved slot `0054b` per D-023) | 12 (11 distinct slot numbers + `0054b`) |
| **Total** | **0001–0059 (gaps 0012–0017)** | **54 files on disk** |

### Cumulative deviation log (cited from slice 005 `regression-final.md § 5`)

35 entries: D-001 … D-022 + D-018b + D-023 + D-024 + D-025 + D-T013-A patched + D-T013-B + D-T015-A + D-T023-2 + D-T042-A + 4 informational cosmetic entries (T029 caller-CTE, T029 anonymized-mask, T029 hard-coded-tier-order, T031 `as never` cast). Of these:

- **3 PATCHED**: D-013 (slice 003), D-024 (slice 005), D-T013-A (slice 005).
- **32 OPEN / DORMANT / INFORMATIONAL**: D-001 through D-T042-A plus the 4 informational cosmetic notes.

Highlights material to slice 006:
- **D-T023-2 (DORMANT, slice 005 → slice 006)**: 3 dormant units carry forward — 1 Playwright `test.fixme` in `slice-005-peer-pick-visibility.spec.ts` + 1 pgTAP `skip()` (A8 in `peer_pick_rls_lock_boundary.sql`) + 1 pgTAP `skip()` (dense_rank in `leaderboard_shared_rank.sql`). Slice 006 will flip these to live assertions once `predictions.admin_invalidated` ships.
- **D-025 (OPEN, slice 005)**: Admin coordination via `X-Internal-Auth` header bypass in `score-trigger`. **Will harden when slice 006 ships production `admin_roles`** — this slice is the resolution.
- **D-T042-A (INFORMATIONAL, slice 005)**: Auto-trigger SPs hard-code the pg_net call. Slice 006's recalc-trigger pathway will need to coordinate with this.

---

## 2. Per-slice inventory (artifact totals at end-of-slice, all GREEN-EXPECTED per cumulative inheritance)

Each slice's final-gate task and final-status totals:

| Slice | Final-gate task | Task count (final-gate report) | Status |
|---|---|---|---|
| 001 — Eligibility & Login | T045 | **45/45** | GREEN-EXPECTED; 3 runtime items deferred to slice 005 T041's pre-merge PowerShell checklist. |
| 002 — Match Catalog & Provider Sync | T046 | **46/46** | GREEN-EXPECTED; all Phase 3–5 runtime items deferred to slice 005 T041 PowerShell checklist. |
| 003 — Match Predictions with Locking | T038 | **38/38** | GREEN-EXPECTED; all documentation-artifact tasks deferred runtime to slice 005 T041 PowerShell checklist. |
| 004 — Final Tournament Predictions | T034 | **34/34** | GREEN-EXPECTED; Step 15 reconciled in T034; runtime deferred to slice 005 T041 PowerShell checklist. |
| 005 — Scoring & Leaderboard | T041 | **44/44** | GREEN-EXPECTED; full Phase 7 polish (T037 + T038 + T039 + T040 + T042 + T043 + T044) deferred runtime; canonical merge-gate runbook published in `regression-final.md § 4`. |

**Total tasks across slices 001–005: 45 + 46 + 38 + 34 + 44 = 207 tasks final-gate-reported as done. All artifact surfaces (54 migrations + 75 pgTAP + 92 Playwright + 25 Deno + 7 seed + 2 Edge Functions + 6 pages + 1 Realtime island + ~10 routes + 1 k6) on disk and GREEN-EXPECTED.**

---

## 3. Slice 006 slot pressure — D-026 candidate (proposed)

`specs/006-admin-overrides/plan.md` and the Phase-2 / Phase-3 / Phase-4 / Phase-6 task bodies enumerate slice 006 migrations at spec slots **0047–0061** (15 slots). However, slice 005 (per D-023, RESOLVED in slice 005's regression baseline) consumed on-disk slots **0049–0059** (plus reserved `0054b`). **All 15 slice-006 spec slots collide with slice 005's occupied range.**

To preserve the project convention "first new slot = previous-slice-max + 1" (the same rationale that drove D-006, D-012, D-016, D-023), slice 006 must renumber: the planned 0047–0061 spec band shifts to on-disk **0060–0074**.

### D-026 candidate (proposed deviation, slice 006)

- **Slice**: 006
- **Title**: Slice 006 migration slot renumber +13 (planned spec slots 0047–0061 → on-disk 0060–0074)
- **Trigger**: T003 (first migration: `admin_roles`)
- **Rationale**: Slice 005 (D-023, RESOLVED) consumed slots 0049–0059 + 0054b. Slice 006 plan was authored against a pre-slice-005 baseline that assumed slot 0047 was free. Renumbering preserves the convention; an alternative (keep 0047 start, accept that those slots are already occupied) is incoherent because the slots are actually taken.
- **Impact**: All slice-006 plan.md / data-model.md / contracts/*.md / quickstart.md slot references shift by +13. The plan documents named slots (e.g., `0050_admin_record_match_result`); the on-disk filename must use the renumbered slot but the same purpose suffix.
- **Resolution**: Lands as-flagged at Phase 2 (T003 ships first migration); D-026 to be recorded in slice 006 `tasks.md § Implementation deviations` when T003 lands.

### Full slot mapping table (D-026)

The slice 006 plan + task body slot assignments map to the on-disk renumbered slots as follows. The "Task" column is the spec task ID that owns the migration file.

| Spec task | Spec slot | On-disk slot | Migration purpose |
|---|---|---|---|
| T003 | 0047 | **0060** | `admin_roles` (table + seed + RLS) |
| T004 | 0048 | **0061** | `audit_log.source_citation` (column add + index) |
| T007 | 0049 | **0062** | `is_admin` real body (replaces slice 001 stub; reads `admin_roles`) |
| T005 | 0050 | **0063** | `score_calculation_runs.triggering_audit_log_id` (FK to audit_log) |
| T013 | 0051 | **0064** | `admin_record_match_result` SP (US1 wrapper) |
| T030 | 0052 | **0065** | `admin_update_match` SP (US2 wrapper) |
| T038 | 0053 | **0066** | `admin_submit_prediction` SP (US3 wrapper) |
| T038 | 0054 | **0067** | admin bypass-lock siblings (`admin_submit_prediction_bypass_lock` + `admin_submit_final_prediction_bypass_lock`) |
| T030 | 0055 | **0068** | `admin_update_tournament_award` SP |
| T038 | 0056 | **0069** | `admin_resolve_match_pending_review` SP |
| T021 | 0057 | **0070** | `admin_trigger_recalc` SP (US4 entry point) |
| T022 | 0058 | **0071** | `pending_recalc_state` view |
| T023 | 0059 | **0072** | `reap_stale_recalc_runs` (slow pg_cron backup per Principle VII) |
| T006 | 0060 | **0073** | `audit_log` narrow INSERT policy (RLS hardening for admin path) |
| T009 | 0061 | **0074** | admin bootstrap (initial seed-from-config admin row + idempotency guard) |

**15 migration slots reserved for slice 006, mapping spec band 0047–0061 → on-disk band 0060–0074.** Final on-disk slot range across slices 001–006 will be **0001–0074** (gaps 0012–0017 only, per D-006). Phase 2 owner (T003) lands D-026 when the first migration file ships.

---

## 4. Carry-forward deferred runtime items

The canonical merge gate for slices 001–005 (and any subsequent slice) remains the PowerShell checklist in **`specs/005-scoring-leaderboard/regression-final.md § 4`** (slice 005's T041 / final regression gate). Slice 006 inherits it verbatim — every prior-slice migration + pgTAP + Playwright + Deno + k6 surface is re-run by that checklist's loops.

Slice 006's own surfaces (migrations 0060+, slice-006-*.spec.ts, admin-RPC pgTAP, admin recalc Deno tests if any, admin pages) will be appended to the same loops as they land; no new runbook is needed for this baseline. **The slice 006 merge gate IS NOT this document.** This document is the artifact baseline + handoff. The merge gate is "run slice 005's § 4 PowerShell checklist on a Docker-up + Deno-installed + k6-installed host AND get 100% GREEN across all (75 + slice-006-new) pgTAP, (92 + slice-006-new) Playwright, (25 + slice-006-new) Deno, the k6 smoke, the perf gates, and the quickstart browser session for both slices 005 and 006".

Slice 006 phases 2–7 are each individually subject to that gate per Principle XI ("regression GREEN before next task starts or merge"), but the artifact baseline asserts only "everything that came before is GREEN-EXPECTED".

### Inherited deferred items (one-liner per prior slice)

- **Slice 001** — All Docker + OIDC stub + CI workflow runtime items deferred. Canonical: `specs/001-eligibility-login/regression-final.md`.
- **Slice 002** — All Docker + Deno carry-forward runtime items deferred. Canonical: `specs/002-match-catalog/regression-final.md`.
- **Slice 003** — All artifact regression docs deferred runtime. Canonical: `specs/003-match-predictions/regression-final.md`.
- **Slice 004** — All Phase 3 / Phase 4 / Phase 5 / Polish runtime checklists deferred. Canonical: `specs/004-final-predictions/regression-final.md § 5`.
- **Slice 005** — All Phase 7 polish (T037 + T038 + T039 + T040 + T042 + T043 + T044) runtime items deferred. Canonical: `specs/005-scoring-leaderboard/regression-final.md § 4`. **This is the live canonical merge-gate runbook for slice 006.**
- **Slice 005 → 006 dormant carry-forward** — Per D-T023-2: 1 Playwright `test.fixme` + 2 pgTAP `skip()` calls (A8 in `peer_pick_rls_lock_boundary.sql` + dense_rank in `leaderboard_shared_rank.sql`). Slice 006 will flip these to live assertions once `predictions.admin_invalidated` and the dense_rank confirmation land.

These items are NOT individually re-listed here. They ARE collectively executed by the slice 005 T041 § 4 PowerShell checklist (pgTAP loop runs every slice's pgTAP file; Playwright `pnpm -F web e2e` runs every slice's `@slice-*` tag; Deno `deno test` runs every Edge-Fn directory's tests; k6 smoke runs the slice-005-only script; perf gates run T044's specific `@perf` selectors with the full-tournament fixture).

---

## 5. Verdict

> **BASELINE ARTIFACT-COMPLETE. Slice 006 may proceed with artifact authoring. Pre-merge runtime sweep deferred to first Docker-available environment per slice 005's T041 canonical checklist.**
>
> Cumulative inheritance: **54 migrations (slot range 0001–0059; slots 0012–0017 vacated per D-006), 75 pgTAP, 92 Playwright specs (incl. 1 `test.fixme` + 2 `@perf` siblings), 25 Deno tests (per prompt-canonical accounting), 7 seed fixtures, 2 Edge Functions, 6 pages + 1 Realtime island, ~10 route handlers, 1 k6 script, 35 deviations (3 patched + 32 open / dormant / informational).** All artifacts are on disk and GREEN-EXPECTED.
>
> Slice 006's first new deviation is flagged as **D-026 candidate** (migration slot renumber: spec 0047–0061 → on-disk 0060–0074) for Phase 2 (T003) to land before the first migration file ships. The full 15-row mapping table is in § 3.
>
> Per Constitution Principle XI (NON-NEGOTIABLE), slice 006 MAY NOT merge to `main` until the slice 005 T041 § 4 PowerShell checklist returns 100% GREEN — extended to cover slice 006's added migrations, pgTAP, Playwright, Deno, and admin-page surfaces — on a Docker-up + Deno-installed + k6-installed host. This document IS NOT itself the merge gate; it is the artifact baseline the operator carries into Phase 2.

---

This is the **World Cup Madness** project.
