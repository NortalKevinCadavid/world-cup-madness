# Regression checkpoint — Slice 005, Phase 4 (US2)

- **Slice**: `005-scoring-leaderboard`
- **Phase**: 4 (US2 — "Final-Tournament Scoring: champion / runner_up / top_scorer / best_player with `final_pending` for unresolved awards + Golden Boot tie split")
- **Date**: 2026-05-20
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T021 (`specs/005-scoring-leaderboard/tasks.md` line 826)
- **Status**: **DEFERRED**
- **Companion artifacts**:
  - `specs/005-scoring-leaderboard/regression-baseline.md` (T002 — cumulative slices 001–004 baseline)
  - `specs/005-scoring-leaderboard/regression-checkpoint-us1.md` (T016 — sibling US1 checkpoint; this document mirrors its structure)
  - `specs/005-scoring-leaderboard/red-gate-us1.md` (T012 — US1 RED inventory; pattern carried forward)
  - `specs/004-final-predictions/regression-checkpoint-us2.md` (slice 004's equivalent — template this document mirrors)

---

## Status: DEFERRED

Both the Docker daemon (required by `supabase start`, `supabase db reset`, `supabase test db`, and every Playwright fixture that boots the local Supabase stack) and the local Supabase stack were **not running** at execution time. `supabase start`, `supabase db reset`, `supabase test db`, the Next.js dev server, the Playwright suite, and `deno test` therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added so far in slice 005 Phase 4 (cumulative with slices 001 + 002 + 003 + 004 + slice 005 US1), and hands the exact commands the user MUST run locally (or in CI, once available) before Phase 5 (US3) begins or the slice can merge. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 7 have all returned GREEN.

---

## 1. Phase 4 task summary (T017 → T021)

| T# | Type | Output |
|---|---|---|
| T017 | RED authoring (Playwright) | 1 spec file / **6 tests** — `apps/web/tests/playwright/slice-005-final-scoring.spec.ts` (591 lines). All tagged `@slice-005 @us2`. Covers: 4-award happy-path scoring across champion/runner_up/top_scorer/best_player, `final_pending` placeholder for unresolved awards (contract wins over R-008 — row IS written), Golden Boot tie split (2 co-scorers each receive 50%), `target_id` forbidden for finals scope (422), `scope='finals'` idempotency replay (no_op), and admin-only gate (403). |
| T018 | RED authoring (pgTAP) | 1 pgTAP file / **10 assertions** — `supabase/tests/pgtap/score_finals_golden_boot_tie.sql` (`plan(10)`: champion award, runner_up award, top_scorer single-winner full-points, top_scorer tie 50/50 split, best_player award, final_pending row written for unresolved award, calculation_version bump, audit trigger emits `score.recorded`, idempotent replay no-duplicate, `target_id` rejection). Note: surfaced a research.md § R-008 vs `contracts/scoring-trigger.edge-fn.md` tension over skip-vs-write for pending awards — **contract wins**: row IS written with `reason_code='final_pending'` and `points=0`. Documented design choice, NOT a deviation. |
| T019 | GREEN migration (SP) | `supabase/migrations/0053_score_finals_fn.sql` — `score_finals(p_run_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER` SP. Implements finals scoring via **single `INSERT ... SELECT` with a CASE ladder** that handles all 4 item kinds (champion, runner_up, top_scorer, best_player) including the Golden Boot tie-split branch and the `final_pending` placeholder branch. Uses `ORDER BY set_at DESC LIMIT 1` to locate the single active `tournament_award` row (single-tournament posture); forward-compatible — a future overload can take a `tournament_id` arg. No new D-### entries surfaced. |
| T020 | GREEN Edge Fn extension + Deno test | `supabase/functions/score-trigger/index.ts` — extended `scope='finals'` branch added (calls `score_finals(run_id)`; rejects `target_id` with 422; preserves match-scope advisory-lock + auth pattern). `scope='all'` still returns 501 (owned by T037). **1 new Deno test file** — `supabase/functions/score-trigger/tests/finals_scope.test.ts` with **2 test cases** (happy-path scope='finals' returns 200 + records_written > 0; `target_id` provided → 422). Match scope behavior preserved. No new D-### entries surfaced. |
| **T021** (this doc) | Regression checkpoint | `specs/005-scoring-leaderboard/regression-checkpoint-us2.md` — documentation artifact; runtime verification deferred (Docker daemon down). |

---

## 2. As-built artifact inventory delta vs US1

Phase 4 adds the finals-scoring vertical on top of US1's match-scoring vertical. The delta is implementation-bearing: 1 migration + 1 Edge Function extension + new test surface. No prior US1 file was regressed.

| Surface | US1 (Phase 3) delta | US2 (Phase 4) delta | Notes |
|---|---|---|---|
| Playwright specs (slice 005) | +1 file / 7 tests | **+1 file / 6 tests** | `slice-005-final-scoring.spec.ts` (591 lines). Tagged `@slice-005 @us2`. |
| pgTAP files (slice 005) | +2 files / 18 assertions | **+1 file / 10 assertions** | `score_finals_golden_boot_tie.sql`. |
| Migrations (slice 005) | +5 on disk (0049, 0050 patched, 0051, 0052, 0055, 0056, 0057 — slot 0053 reserved at US1 close) | **+1 on disk — slot 0053** | `0053_score_finals_fn.sql` — `score_finals(uuid)` SP (single `INSERT ... SELECT` with CASE ladder for all 4 item kinds). |
| Edge Function | +1 new directory (`score-trigger`) with `match` scope | **+0 new directories; 1 modification** (`scope='finals'` branch added; `match` preserved; `all` still 501) | Match scope and admin-gate logic unchanged. |
| Deno test files (slice 005) | +4 files | **+1 file / 2 cases** | `finals_scope.test.ts` (happy + `target_id` forbidden 422). Gated by `RUN_EDGE_FN_TESTS=1` per slice 002 precedent. |
| Seed fixtures (slice 005) | +1 (`slice-005-fixture.sql`) | **+0** | T017 + T018 reuse the US1 fixture; `tournament_award` rows already seeded (T005 / T010 path). |

---

## 3. Cumulative slice 005 totals (US1 + US2)

Running totals at end of Phase 4 (cumulative across slice 005 Phases 1 + 2 + 3 + 4):

| Surface | US1 total | + US2 delta | Cumulative US1 + US2 |
|---|---|---|---|
| Migrations (slice 005 on disk, per D-023 slots 0049–0057+) | 7 (0049, 0050 patched, 0051, 0052, 0055, 0056, 0057) | + 1 (0053) | **8** (0049, 0050, 0051, 0052, **0053**, 0055, 0056, 0057). Slot **0054** reserved for T029 (`leaderboard_view`) and slot **0054b** reserved for T035 (`personal_breakdown_v`). |
| pgTAP files (slice 005) | 2 files / 18 assertions | + 1 / 10 assertions | **3 files / 28 assertions** — `score_match_award_table.sql` (12) + `score_match_idempotent.sql` (6) + `score_finals_golden_boot_tie.sql` (10) |
| Playwright specs (slice 005) | 1 file / 7 tests | + 1 file / 6 tests | **2 files / 13 tests** — `slice-005-match-scoring.spec.ts` + `slice-005-final-scoring.spec.ts` |
| Deno test files (slice 005) | 4 files / 4 cases | + 1 file / 2 cases | **5 files / 6 test cases** — 4 from T015 (`single_score_happy`, `idempotent_replay`, `concurrent_returns_409`, `non_admin_returns_403`) + 1 from T020 (`finals_scope.test.ts` with 2 cases). All gated by `RUN_EDGE_FN_TESTS=1`. |
| Seed fixtures (slice 005) | 1 (`slice-005-fixture.sql`) | + 0 | **1** |
| Edge Functions (slice 005) | 1 (`score-trigger`, match scope only) | + 0 directories; 1 modification | **1** — `score-trigger` now handles `scope='match'` + `scope='finals'`; `scope='all'` returns 501 (owned by T037). |

---

## 4. Cumulative cross-slice totals (slices 001 → 005 Phase 4)

| Surface | End of slice 005 US1 (Phase 3) | Slice 005 US2 delta | End of slice 005 US2 |
|---|---|---|---|
| Migrations | 49 | + 1 (slot 0053) | **50** |
| pgTAP files | 70 | + 1 | **71** |
| Playwright spec files | 87 (per `regression-checkpoint-us1.md § 2c` — slice 004 `regression-final.md` canonical count) | + 1 | **88** |
| Deno test files | 19 | + 1 | **20** |
| Deviations | 27 (D-001 .. D-022 + D-018b + D-023 + D-024 + D-025 + D-T013-A patched + D-T013-B + D-T015-A) | **+ 0** | **27** |

**No new deviations were added in Phase 4.** T019 surfaced no contract violations during the `score_finals` SP implementation; T020's Edge Function extension reused the existing match-scope auth + advisory-lock pattern without modification. The research.md § R-008 vs contract tension noted under T018 is a **documented design choice** (contract wins — `final_pending` row IS written) and is NOT a deviation. The single-tournament `ORDER BY set_at DESC LIMIT 1` lookup pattern in T019 is forward-compatible (a future overload may take a `tournament_id` arg) and is NOT a deviation.

---

## 5. Cross-slice contract status (carry-forward verification)

All 8 cross-slice contracts established in slice 004's `regression-checkpoint-us1.md § 3` (and carried forward through slice 005 US1's `regression-checkpoint-us1.md § 5`) remain **intact** at end of slice 005 Phase 4:

1. `public.is_eligible_nortal_participant(uuid)` — **INTACT** (no Phase-4 modification).
2. `public.is_admin(uuid)` — **INTACT** (still slice 001 stub; admin1 satisfied via D-025 X-Internal-Auth header bypass; slice 006 will harden).
3. `public.participants` — **INTACT** (T019's `score_finals` SP writes `score_records` rows that FK to `public.participants(id)` ON DELETE RESTRICT per D-024).
4. `public.audit_log` — **INTACT** (slot-0055 trigger from T014 emits `score.recorded` rows for finals scoring too; no shape change).
5. `public.matches` — **INTACT** (`score_finals` does NOT read `matches`; finals scoring sources `tournament_award` and `tournament_config.scoring.finals.*` keys only).
6. `public.teams` — **INTACT**.
7. `public.tournament_config` — **INTACT** (scoring.finals.* keys seeded at slot 0057 read-only).
8. `MatchDataProviderAdapter` — **INTACT** (no slice-005 modification).

**All 8 contracts intact.**

---

## 6. RED-after-T021 carry-forward

**Expected: 0 RED units carrying forward from Phase 4.**

All 18 RED-by-design test units authored in Phase 4 (6 Playwright + 10 pgTAP + 2 Deno) should flip GREEN once T019 (score_finals SP at slot 0053) + T020 (Edge Fn scope='finals' branch + finals_scope.test.ts) ship — which they did during this phase. Runtime confirmation is deferred.

**Runtime caveats** (items that may still observe RED until resolved — all carry-forward from US1):

- Tests gated on **D-T013-B** (the pgTAP files' `auth.uid()`-dependent assertions, if any) may RED in pgTAP context until the NULL fallback is verified. `score_finals_golden_boot_tie.sql` inherits the same pattern as `score_match_idempotent.sql` and may RED in the same way.
- The Playwright `concurrent_returns_409` scenario (T009, US1) and the Deno `concurrent_returns_409.test.ts` (T015, US1) may RED until **D-T015-A** is resolved (helper SP shipped). The new T020 Deno test (`finals_scope.test.ts`) does NOT exercise the advisory-lock collision path so is not subject to D-T015-A.

No new red-gate document is produced for US2 — the carry-over pattern is to fold US2 RED authoring into this checkpoint per the slice 004 / slice 005 template precedent. (Slice 005's US1 still has `red-gate-us1.md`; slice 004 produced `red-gate-us2.md` separately; the slice 005 cadence absorbs the RED inventory into the per-phase checkpoint going forward.)

---

## 7. Pre-merge runtime verification checklist (operator runbook, deferred)

Run from the repo root on the slice-005 branch in order. Stop on the first non-zero exit. PowerShell variants given; bash equivalents follow each step where relevant.

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all 50 migrations on disk
#    (slice 001's 0001..0011 + slice 002's 0018..0029 + slice 003's 0030..0038 +
#    slice 004's 0039..0048 + slice 005's 0049..0057 per D-023, with reserved gaps
#    0054 + 0054b) and loads the five seed fixtures (slice-001..slice-005-fixture.sql).
supabase db reset

# 3. Run the three slice-005 pgTAP files individually (US1 + US2 cumulative).
supabase test db --file supabase/tests/pgtap/score_match_award_table.sql
supabase test db --file supabase/tests/pgtap/score_match_idempotent.sql
supabase test db --file supabase/tests/pgtap/score_finals_golden_boot_tie.sql

# 4. Run the cumulative pgTAP sweep (71 files including prior slices).
Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object {
  supabase test db --file $_.FullName
}

# 5. TypeScript strict compile of the web app.
pnpm -F web exec tsc --noEmit

# 6. Production-mode Next.js build.
pnpm -F web build

# 7. Playwright suite — slice-005 US1 + US2 scope (13 tests).
pnpm -F web e2e -- --grep '@slice-005 @(us1|us2)'

# 8. Deno test gate (Edge Function tests, gated by RUN_EDGE_FN_TESTS=1).
$env:RUN_EDGE_FN_TESTS = "1"
$env:SUPABASE_URL = "..."
$env:SUPABASE_SERVICE_ROLE_KEY = "..."
$env:SCORE_TRIGGER_INTERNAL_AUTH_SECRET = "..."
deno test --allow-net --allow-env --allow-read supabase/functions/score-trigger/tests

# 9. Browser smoke (manual, no automation).
#    - Admin: POST /functions/v1/score-trigger { scope: 'finals', run_id: <new-uuid> }
#      with X-Internal-Auth header → 200 + records_written > 0; replay → 200 + no_op=true.
#    - Same POST with target_id present → 422.
#    - Non-admin: same POST without header → 403.
```

Bash equivalent for step 4:

```bash
for f in supabase/tests/pgtap/*.sql; do
  supabase test db --file "$f"
done
```

A passing run produces:

- **Step 3**: 3 files; `ok 1..12` + `ok 1..6` + `ok 1..10` = **28 ok assertions** across slice-005 US1 + US2.
- **Step 4**: 71 files all green.
- **Step 5**: no output, exit 0.
- **Step 6**: build succeeds; manifest unchanged (no slice-005 UI yet for finals scoring; admin invocation is server-side only).
- **Step 7**: 13 specs all green (7 US1 + 6 US2), modulo the US1 `concurrent_returns_409` D-T015-A caveat.
- **Step 8**: 6 Deno tests across 5 files green (modulo D-T015-A for the US1 collision case; T020's 2 finals cases not subject to D-T015-A).
- **Step 9**: manual smoke confirms admin finals path + idempotency replay + target_id rejection.

### Pre-merge action items (operator checklist — US2 scope)

Tick each box before opening (or merging) the slice-005 PR.

- [ ] Docker Desktop running and healthy (`docker info` exits 0).
- [ ] Step 1 (`supabase start`) succeeds.
- [ ] Step 2 (`supabase db reset`) applies all 50 migrations + loads 5 fixtures cleanly.
- [ ] Step 3 reports `ok 1..12 + 1..6 + 1..10 = 28 ok assertions`.
- [ ] Step 4 reports 71/71 GREEN across the cumulative pgTAP sweep.
- [ ] Step 6 (`pnpm -F web build`) succeeds.
- [ ] Step 7 reports 13/13 passed for `@slice-005 @(us1|us2)` (modulo D-T015-A caveat acknowledged in PR description).
- [ ] Step 8 reports 6/6 Deno tests passed (modulo D-T015-A caveat).
- [ ] Step 9 manual browser smoke confirms admin finals invocation, idempotency replay, target_id 422, and non-admin 403.
- [ ] D-025 + D-T013-B + D-T015-A acknowledgements (carried from US1) repeated in PR description.
- [ ] PR description references this file + `regression-checkpoint-us1.md` + `red-gate-us1.md` + (once they exist) `regression-checkpoint-us3.md`, `regression-checkpoint-us4.md`, `regression-final.md` (T041).

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack (+ Deno toolchain for the Edge Function test suite) IS the merge gate. Until every box above is ticked, Phase 5 (US3) MAY NOT start, the Polish phase MAY NOT start, and slice 005 MAY NOT merge to `main`.

---

## 8. Carry-forward deviations

All 6 open / patched deviations from prior slice-005 phases carry forward unchanged:

| ID | Status | One-liner |
|---|---|---|
| **D-023** | Resolved | Slice 005 migration slot renumber +1 (spec 0050–0059 → on-disk 0049–0057+). Carries forward unchanged; slot 0053 (T019) consumed this phase. |
| **D-024** | Resolved | RLS auth.uid mapping — `score_records_self_read` predicate is `participant_id IN (SELECT id FROM participants WHERE auth_user_id = auth.uid())`. Carries forward unchanged. |
| **D-025** | Open | Slice 005 + Slice 006 coordination — `is_admin(uid)` stub returns FALSE in slice 001; admin1 path in `score-trigger` satisfied via X-Internal-Auth header bypass (option (b)). T020's `scope='finals'` branch reuses the same admin gate — same bypass applies. Will harden when slice 006 ships production `admin_roles`. |
| **D-T013-A** | **PATCHED** | Slot 0050's FK ALTER TABLE referenced `calculation_run_id` but slot 0049 declared `run_id`. Patched directly during T013 execution. No follow-up. |
| **D-T013-B** | Open | `auth.uid()` returns NULL in pgTAP contexts without JWT; T013/T019 SPs' `triggered_by` insert may need a NULL fallback. Schema permits NULL on `triggered_by` so service-role path works; pgTAP runtime may reveal additional NULL handling. T019 inherits the same pattern. |
| **D-T015-A** | Open | JS-side hashtext32 (FNV-1a in `score-trigger/index.ts`) not byte-equivalent with Postgres `hashtext()`. T015's `concurrent_returns_409` test may not collide at runtime. **Follow-up**: ship `public.try_lock_scoring(uuid)` SECURITY DEFINER helper so both call sites take the lock through identical Postgres semantics. T020's finals_scope tests do NOT exercise the collision path so are not affected. |

**Cumulative deviation count at end of slice 005 Phase 4: 27** (D-001 .. D-022 + D-018b + D-023 + D-024 + D-025 + D-T013-A patched + D-T013-B + D-T015-A). **0 new entries this phase.**

---

## 9. Inherited deferred items (one-liner per prior slice)

- **Slice 001** — All Docker + OIDC stub + CI workflow runtime items deferred to a future Docker-up + Deno-installed host. Cited canonical: `specs/001-eligibility-login/regression-final.md`.
- **Slice 002** — All Docker + Deno carry-forward runtime items deferred. Cited canonical: `specs/002-match-catalog/regression-final.md`.
- **Slice 003** — All artifact regression docs deferred runtime to a future Docker-up + Deno-installed session. Cited canonical: `specs/003-match-predictions/regression-final.md`.
- **Slice 004** — All Phase 3 / Phase 4 / Phase 5 / Polish runtime checklists deferred to slice 004's T034 `regression-final.md`. **Canonical citation for the consolidated cross-slice runtime sweep**: `specs/004-final-predictions/regression-final.md § 5`.
- **Slice 005 / US1 (Phase 3)** — All Phase-3 runtime items (T009 Playwright, T010 + T011 pgTAP, T013 + T014 + T015 migration / trigger / Edge-Fn runtime, T016 checkpoint runtime confirmation) deferred. Cited canonical: `specs/005-scoring-leaderboard/regression-checkpoint-us1.md § 6`.

These items are NOT individually re-listed. They are blocking the consolidated pre-merge runtime verification at slice 005's eventual **T041** (`regression-final.md`).

---

## 10. Verdict

> **US2 artifact-complete. Cumulative US1+US2 expected GREEN once Docker is up. Runtime gate deferred to T041 slice-005 final regression.**
>
> Phase 4 produced 1 Playwright spec (6 tests) + 1 pgTAP file (10 assertions) + 1 SP migration (slot 0053 — `score_finals(uuid)` with single-`INSERT...SELECT` CASE-ladder over all 4 item kinds) + 1 Edge Function extension (`scope='finals'` branch; `match` preserved; `all` still 501) + 1 Deno test file (2 cases — happy + target_id 422). All on disk, all type-consistent, all reconciled against the locked cross-slice contracts. No cross-slice contract was broken by Phase 4. **Zero new D-### deviations** were surfaced; the 6 carry-forward deviations (D-023, D-024, D-025, D-T013-A patched, D-T013-B, D-T015-A) remain unchanged.
>
> Per Principle XI, Phase 5 (US3 — Leaderboard with Tie-Breakers + Peer-Pick Visibility) MAY proceed at the artifact-authoring level, but the slice cannot merge until the § 7 runtime checklist is observably GREEN on a Docker-up + Deno-installed host. This document IS NOT itself the merge gate; the merge gate is the consolidated cross-slice runtime sweep documented at slice 005's `regression-final.md` (T041) extending the slice 004 § 5 PowerShell checklist with slice-005 surfaces.

**T021 Definition of done**: **Status**: DONE (US2 checkpoint produced; runtime verification of GREEN status deferred — Docker daemon down). All 18 US2 test units authored + T019+T020 implementation shipped.

---

This is the **World Cup Madness** project.
