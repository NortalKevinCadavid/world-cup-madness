# RED Gate — Slice 005 / User Story 3 (US3)

**Slice**: `005-scoring-leaderboard`
**Phase**: 5 (US3 — "Leaderboard + peer-pick visibility: ranked totals, deterministic tie-breakers, calc-version consistency, RLS-gated peer views")
**Date**: 2026-05-20
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T028 (the Principle IX gate task itself; US3 red-gate document)

---

## Status: DEFERRED (Docker daemon down)

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-5 / US3 RED tests authored in T022 (Playwright, 1 file / 7 tests), T023 (Playwright, 1 file / 10 tests — 1 `test.fixme`), T024 (pgTAP, 1 file / 8 assertions), T025 (pgTAP, 1 file / 3 assertions — 1 `skip()`), T026 (pgTAP, 1 file / 4 assertions), and T027 (pgTAP, 1 file / 8 assertions — 1 `skip()`) are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up (deferred to the slice's final regression gate).
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.
4. Dormant test units (`test.fixme` + `skip()`) blocked on slice 006 are explicitly tracked as carry-forward deferrals so they cannot be silently lost between slices.

The merge of Slice 005 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 5 (US3) produced **6 RED-state test files** (2 Playwright specs + 4 pgTAP scripts) totalling **40 authored test units**, of which **37 are active RED-by-design** and **3 are dormant** (1 Playwright `test.fixme` + 2 pgTAP `skip()`s) pending slice 006's `admin_invalidated` column.

| File | Type | Test / assertion count | Expected RED reason | Who turns GREEN |
|------|------|------------------------|---------------------|-----------------|
| `apps/web/tests/playwright/slice-005-leaderboard.spec.ts` | Playwright | 7 | `leaderboard_v` view does not exist yet **AND** `/leaderboard` page does not render. Tests fail either at the navigation step (404 from Next.js — no route handler) or, once the route exists but the view is absent, at the first `[data-testid="leaderboard-row"]` selector wait (DOM never reaches expected state). | **T029** (`supabase/migrations/0054_leaderboard_view.sql` — per D-023 the on-disk slot is **0054**, spec slot **0055**) + **T031** (`apps/web/app/leaderboard/page.tsx`). |
| `apps/web/tests/playwright/slice-005-peer-pick-visibility.spec.ts` | Playwright | 10 (1 `test.fixme`) | `peer_pick_v` + `peer_final_pick_v` views absent; `/api/peer-pick/*` route handlers absent. Tests fail at the first `fetch('/api/peer-pick/...')` returning 404, or at DOM assertions on peer-pick rendering that never appears. 9 tests RED-by-design; **1 test is `test.fixme`-marked** (admin-invalidated visibility) and is dormant until slice 006 ships the `admin_invalidated` column on `predictions`. | **T029** (peer views) + **T032** (`apps/web/app/api/peer-pick/...` route handlers). |
| `supabase/tests/pgtap/leaderboard_tie_breakers.sql` | pgTAP | 8 (`plan(8)`) | `SELECT * FROM leaderboard_v` raises `ERROR: relation "public.leaderboard_v" does not exist`. None of the 8 tie-breaker ordering assertions (rank stability across exact-result count → group-stage points → registration `created_at`) reach evaluation. | **T029**. |
| `supabase/tests/pgtap/leaderboard_shared_rank.sql` | pgTAP | 3 (`plan(3)`, 1 `skip()`) | Same root cause — `leaderboard_v` absent. 2 assertions RED-by-design (shared rank when fully tied participants share identical `rank`; rank gap respected after the tie). **1 assertion is `skip()`**-marked pending a downstream confirmation. | **T029**. |
| `supabase/tests/pgtap/leaderboard_calc_version_consistency.sql` | pgTAP | 4 (`plan(4)`) | Same root cause — `leaderboard_v` absent. The 4 calc-version-consistency assertions (one `calculation_version` per row; max version reflects most-recent `score_match` run; no cross-version row mixing within a single read; view re-reads after recalc bump cleanly) cannot run. | **T029**. |
| `supabase/tests/pgtap/peer_pick_rls_lock_boundary.sql` | pgTAP | 8 (`plan(8)`, 1 `skip()`) | `peer_pick_v` + `peer_final_pick_v` absent. 7 RLS / lock-boundary assertions RED-by-design (pre-lock owner-only visibility; post-lock peer visibility; admin override; cross-user denial; row-count parity; locked-match visibility flip; RLS denies for anon role). **1 assertion (A8 admin-invalidated) is `skip()`**-marked — same reason as the T023 `test.fixme`: blocked on slice 006's `admin_invalidated` column. | **T029**. |

**Totals**:

- **Authored test units**: `7 (T022 Playwright) + 10 (T023 Playwright) + 8 (T024 pgTAP) + 3 (T025 pgTAP) + 4 (T026 pgTAP) + 8 (T027 pgTAP) = 40`.
- **Playwright**: 17 authored (1 `test.fixme` dormant pending slice 006) → **16 active RED-by-design**.
- **pgTAP**: 23 authored (2 `skip()`s dormant pending slice 006) → **21 active RED-by-design**.
- **Active RED-by-design**: **37**. **Dormant**: **3**.

All six files are tagged or scoped `@slice-005 @us3`. None of the active assertions are tautological — each one references a specific (participant, rank, total_points, exact_result_count, group_stage_points, calculation_version, owner uid, peer uid, locked_at boundary, or RLS role) tuple sourced from the hand-verified fixture rows in `supabase/seed/slice-005-fixture.sql`.

---

## GREEN unlock map

| Task | What it ships | Tests it flips to GREEN |
|------|---------------|-------------------------|
| **T029** | `supabase/migrations/0054_*` — `leaderboard_v` + `peer_pick_v` + `peer_final_pick_v` views (on-disk slot **0054**, spec slot **0055** per **D-023**). | All **23 pgTAP** units (8 T024 + 3 T025 + 4 T026 + 8 T027), modulo the 2 `skip()`s. Backs the view-data half of both Playwright files. |
| **T031** | `apps/web/app/leaderboard/page.tsx` — the `/leaderboard` Next.js page that queries `leaderboard_v` and renders the DOM contract surfaced by T022 (see below). | All **7 T022 Playwright** tests. |
| **T032** | `apps/web/app/api/peer-pick/...` — route handlers that query `peer_pick_v` + `peer_final_pick_v` under RLS. | **9 of 10 T023 Playwright** tests (the 10th is `test.fixme` carry-forward). |

T029 is the database GREEN unlock; T031 + T032 are the web GREEN unlocks. The DB unlock is a hard prerequisite for the web unlocks — the web cannot flip GREEN before the views exist.

---

## Carry-forward deferrals (must not be lost between slices)

These dormant units are tracked here so slice 006's planner picks them up:

- **D-T023-2** — `test.fixme` in `slice-005-peer-pick-visibility.spec.ts`: "admin-invalidated predictions are hidden from peers even after lock." Dormant pending slice 006's `predictions.admin_invalidated` column + its `peer_pick_v` filter clause update. Slice 006 implementer **must** remove the `test.fixme` marker and let the assertion run.
- **A8 of T027** (`skip()` in `peer_pick_rls_lock_boundary.sql`): same root cause and same remediation as D-T023-2 — the assertion exists as `SKIP "admin_invalidated col not yet present (slice 006)"`; slice 006 implementer **must** flip the `skip()` to a live `is(...)` / `ok(...)` call against the new column.

Both are referenced by the slice 006 backlog under the working tag **D-T023-2** so the link survives.

---

## T031 DOM selector contract (surfaced by T022)

T022's Playwright spec asserts against a stable, accessibility-friendly DOM contract that **T031 MUST honor exactly** when it builds `/leaderboard`. The contract is:

- Each ranked row: `[data-testid="leaderboard-row"]` with attribute `data-rank="<integer>"`.
- Per-row fields, each marked with a `data-field` attribute on a child element:
  - `[data-field="participant_name"]`
  - `[data-field="total_points"]`
  - `[data-field="exact_result_count"]`
  - `[data-field="group_stage_points"]`
  - `[data-field="calculation_version"]`
- Rows are emitted in rank-ascending order (rank 1 first); shared ranks share a `data-rank` value, and the next distinct rank skips by tie-group size (standard "1, 1, 3" competition ranking).
- An empty leaderboard renders `[data-testid="leaderboard-empty"]` instead of zero rows.

This contract is the load-bearing seam between T022 and T031 — diverging here re-RED-s the suite. T031's implementer should treat this section as a freeze.

---

## Pre-merge runtime verification (deferred)

Once Docker is back up, on branch `005-scoring-leaderboard` from the repo root, in **PowerShell**:

```powershell
# 1. Reset the database — applies all slice 001-005 migrations and loads fixtures.
supabase db reset

# 2. Run the four slice-005 US3 pgTAP files in a loop.
$us3PgTap = @(
  'supabase/tests/pgtap/leaderboard_tie_breakers.sql',
  'supabase/tests/pgtap/leaderboard_shared_rank.sql',
  'supabase/tests/pgtap/leaderboard_calc_version_consistency.sql',
  'supabase/tests/pgtap/peer_pick_rls_lock_boundary.sql'
)
foreach ($f in $us3PgTap) { supabase test db --file $f }

# 3. Typecheck + build the web app (catches DOM contract drift early).
pnpm -F web build

# 4. Run the US3 Playwright suite, scoped to slice 005 / US3.
pnpm -F web e2e -- --grep '@slice-005 @us3'
```

**Pass criteria for the RED run** (stash-and-test, BEFORE T029-T032 land):

- All four pgTAP files fail with `relation "public.leaderboard_v" does not exist` (T024-T026) or `relation "public.peer_pick_v" does not exist` (T027) — not for syntax errors, missing fixtures, or planned-vs-run mismatches.
- T022's 7 Playwright tests fail at `/leaderboard` navigation (Next.js 404) or at the first `[data-testid="leaderboard-row"]` selector wait.
- T023's 9 active Playwright tests fail at `/api/peer-pick/*` returning 404; the 1 `test.fixme` test is **reported as skipped** by Playwright, not as a failure (that is the correct dormant state).
- The 2 pgTAP `skip()` lines (1 in T025, 1 in T027) are **reported by pgTAP as `# SKIP`** — counted toward the file's plan but neither RED nor GREEN.

**Pass criteria for the GREEN run** (post-T029/T031/T032, slice 006 still pending):

- All 23 pgTAP units reach `ok` (minus the 2 `skip()`s, which remain reported as `# SKIP`).
- All 16 active Playwright tests report `passed`; the 1 `test.fixme` test remains reported as skipped until slice 006 reactivates it.
- `pnpm -F web build` is clean.

Runtime verification of both the RED-state observation and the eventual GREEN flip is **deferred to the slice's final regression gate**. That gate will append transcript references — or a CI link — to this document before merge.

---

## Verdict

**All 40 US3 test units authored.** Of those, **37 are RED-by-design** (16 Playwright + 21 pgTAP) and will flip GREEN once **T029** (leaderboard_v + peer_pick_v + peer_final_pick_v views at on-disk slot 0054) + **T031** (`/leaderboard` page honoring the T022 DOM contract) + **T032** (`/api/peer-pick/*` route handlers) land. The remaining **3 dormant units** (1 `test.fixme` in T023 + 2 `skip()`s across T025 and T027) are carry-forward deferrals (**D-T023-2** + A8-of-T027) pending slice 006's `predictions.admin_invalidated` column.

Per Principle IX the gate is **DEFERRED but acknowledged** — runtime confirmation of the RED state will be appended in the slice's final regression gate once Docker is back up. Until then this artifact is the authoritative inventory of Slice 005 US3's RED surface.
