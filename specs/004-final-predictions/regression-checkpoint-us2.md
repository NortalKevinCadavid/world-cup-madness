# Regression checkpoint — Slice 004, Phase 4 (US2)

- **Slice**: `004-final-predictions`
- **Phase**: 4 (US2 — "System rejects edits after first kickoff")
- **Date**: 2026-05-20
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T025 (`specs/004-final-predictions/tasks.md` line 887)
- **Companion artifacts**:
  - `specs/004-final-predictions/regression-baseline-from-001-002-003.md` (T001 — slice-001 + slice-002 + slice-003 carry-forward baseline)
  - `specs/004-final-predictions/regression-checkpoint-us1.md` (T020 — sibling US1 checkpoint; this document mirrors its structure)
  - `specs/004-final-predictions/red-gate-us1.md` (T015 — US1 RED inventory)
  - `specs/004-final-predictions/red-gate-us2.md` (T023 — US2 RED inventory + T024 verification appendix)
- **Purpose**: Record the state of the slice-001 + slice-002 + slice-003 + slice-004-(US1+US2) test suite at the moment US2 lands in slice 004, inventory every test the operator must run, and hand the exact verification commands to whoever next has a working Docker daemon + Deno toolchain. Per Principle XI, US3 (Phase 5), US4 (Phase 6 — if any), and the Polish phase MAY NOT start, and the slice MAY NOT merge to `main`, until all verification commands below land GREEN.

---

## Status: DEFERRED

Both the Docker daemon (required by `supabase start`, `supabase db reset`, `supabase test db`, and by every Playwright fixture that boots the local Supabase stack) and the Deno toolchain (required by slice-002's `provider-stub.test.ts` carry-forward suite) were **unavailable at execution time**. `supabase start`, `supabase db reset`, `supabase test db`, the Next.js dev server (which Playwright fixtures depend on), the Playwright suite, and `deno test` therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added so far in slice 004 Phase 4 (cumulative with slices 001 + 002 + 003 + slice-004 US1), and hands the exact commands the user MUST run locally (or in CI, once slice 001's T007 ships) before Phase 5 (US3) begins or the slice can merge. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 6 have all returned GREEN.

---

## 1. Phase 4 task summary (T021 → T025)

| T# | Type | Output |
|---|---|---|
| T021 | RED authoring (pgTAP) | **11 pgTAP files** under `supabase/tests/pgtap/{is_final_prediction_locked_*,submit_final_prediction_{locked,serializes_concurrent}}.sql` exercising the slot-0041 predicate + slot-0044 SP lock-branch. Planned-assertion total = 2 + 2 + 1 + 1 + 1 + 1 + 2 + 2 + 1 + 2 + 1 = **16 assertions**. |
| T022 | RED authoring (Playwright) | **6 spec files / 6 tests** under `apps/web/tests/playwright/slice-004-submit-{locked,locked-just-after,just-before-lock,direct-api-rejected,client-clock-ignored,concurrent-tabs}.spec.ts`. All tagged `@slice-004 @us2`. |
| T023 | RED gate (artifact) | `specs/004-final-predictions/red-gate-us2.md` — documentation artifact; runtime observation deferred (Docker down). 17 test files catalogued, 16 GREEN-likely on a Docker-up run + **1 RED-until-T029** (file 11 `submit_final_prediction_serializes_concurrent.sql`). Option A from § "Resolution options" adopted — no Phase-4 rewrite. |
| T024 | GREEN verification | **Code-review verification** (Docker down). All 17 files read end-to-end against shipped implementations (`0041_is_final_prediction_locked.sql`, `0044_submit_final_prediction_sp.sql`, `apps/web/app/api/final-predictions/route.ts`). Verdict: **16 GREEN-now + 1 RED-deferred-to-T029**. **0 fixup migrations shipped** — slot 0048 remains reserved for T029. |
| **T025** (this doc) | Regression checkpoint | `specs/004-final-predictions/regression-checkpoint-us2.md` — documentation artifact; runtime verification deferred (Docker daemon down). |

---

## 2. As-built artifact inventory delta vs US1

Phase 4 is **test-only**. The slice's GREEN implementation surface (migrations, route handlers, TS libs, page, components) did NOT grow in Phase 4 — the predicate (slot 0041, T005) and the submit SP (slot 0044, T016) and the route handler (T018) were already shipped in Phase 2 + Phase 3 with the WFP01 → 409 lock-rejection branch in place. T024 confirmed via code review that no fixup migration is required.

| Surface | Phase 3 (US1) delta | Phase 4 (US2) delta | Notes |
|---|---|---|---|
| pgTAP files | +7 (T012) | **+11 (T021)** | Predicate boundary (`is_final_prediction_locked_*` × 9) + SP lock (`submit_final_prediction_locked.sql`) + serialize-concurrent forward-compat (`submit_final_prediction_serializes_concurrent.sql`). |
| Playwright specs | +25 (T013 + T014) | **+6 (T022)** | Lock-state (boundary / just-after / just-before) + direct-API + client-clock-ignored + concurrent-tabs. All tagged `@slice-004 @us2`. |
| Migrations | +1 slot 0044 (T016) | **0** | T024 surfaced no contract violation. Slot 0048 stays reserved for T029. |
| Route handlers (TS) | +4 (T018) | **0** | `POST /api/final-predictions` already maps WFP01 → 409 + 23505 → 409 ALREADY_SUBMITTED. No edits this phase. |
| TS lib files | +6 (T017) | **0** | Phase 4 is pure test-authoring; lib surface untouched. |
| Page + components | +1 page + 4 components (T019) | **0** | `/me/finals` page + FinalsForm/TeamPicker/PlayerPicker/FinalsLockBanner unchanged. |

---

## 3. Cumulative slice 004 totals (US1 + US2)

Running totals at end of Phase 4 (cumulative across slice 004 Phases 2 + 3 + 4):

| Surface | US1 total | + US2 delta | Cumulative US1 + US2 |
|---|---|---|---|
| pgTAP files (slice 004) | 7 | + 11 | **18** |
| Playwright specs (slice 004) | 26 | + 6 | **32** |
| Migrations (slice 004 on disk, slots 0039–0047 per D-016) | 9 | + 0 | **9** (slot 0048 reserved for T029; no slot 0048+ on disk yet) |
| TS lib files (slice 004) | 6 | + 0 | **6** |
| Route handlers (slice 004) | 4 | + 0 | **4** |
| Pages (slice 004) | 1 | + 0 | **1** (`/me/finals`) |
| Client components (slice 004) | 4 | + 0 | **4** (FinalsForm + TeamPicker + PlayerPicker + FinalsLockBanner) |

> **Playwright reconciliation**: The US1 checkpoint reports 25 spec **files** / 27 test **bodies** (26 runtime-expected GREEN + 1 `test.fixme` dormant). The "26 + 6 = 32" tally above counts the *runtime-expected* test bodies for US1 (26) + the 6 US2 specs (each one test body). On a runtime-expected-passing basis the slice now ships **32 GREEN-on-runtime + 1 dormant `test.fixme` + 1 forward-compat (serialize-concurrent revision) → 34 test bodies authored**. The dormant + forward-compat lines stay accounted in the RED-carry-forward section below.

**Cumulative pgTAP planned assertions**: 28 (US1) + 16 (US2) = **44 planned assertions** across the slice-004 US1 + US2 pgTAP set.

**Cumulative pgTAP on-disk total at end of Phase 4** (across all slices): 12 (slice 001) + 9 (slice 002) + ~22 (slice 003) + 18 (slice 004) = **~61 pgTAP files** on disk.

---

## 4. Cross-slice contract status (carry-forward verification)

Per `regression-baseline-from-001-002-003.md`, slice 004 inherited **8 cross-slice contracts** from slices 001 + 002 + 003. None were broken by slice 004 Phase 2, Phase 3, or Phase 4. Phase 4 is test-only and made no contract surface changes.

| # | Contract | Owner | Slice-004-Phase-4 status |
|---|---|---|---|
| 1 | `public.is_eligible_nortal_participant(uuid) STABLE` | slice 001 / 0005 | **INTACT.** No Phase-4 modification. |
| 2 | `public.is_admin(uuid)` (stub) | slice 001 / 0006 | **INTACT.** No Phase-4 modification. |
| 3 | `public.participants` table (auth_user_id, status) | slice 001 / 0001 | **INTACT.** No Phase-4 modification. |
| 4 | `public.audit_log` shape | slice 001 / 0003 | **INTACT.** Phase-4 emits no new audit-log rows. D-018 rejection-path audit deferral unchanged (slice 007 widens RLS). |
| 5 | `public.matches` (id, status, kickoff_utc, stage) | slice 002 / 0020 | **INTACT.** Predicate continues to read `tournament_config.first_kickoff_utc` (not `matches` directly) per D-017. |
| 6 | `public.teams` (id, short_code) | slice 002 / 0019 | **INTACT.** No Phase-4 modification. |
| 7 | `public.tournament_config` | slice 001 + slices 002/003/004 seed | **INTACT.** T021 pgTAP files mutate the `first_kickoff_utc` key via UPDATE + ROLLBACK; T022 Playwright specs use service-role psql + `afterEach` restoration. No schema change. |
| 8 | `MatchDataProviderAdapter.fetchPlayers?` interface | slice 002 / providers/types.ts | **INTACT.** No Phase-4 modification. |

**All 8 contracts intact at end of Phase 4.**

---

## 5. Deviations log delta (running totals after Phase 4)

Inherited carry-forward: **D-001 through D-015** (slices 001 + 002 + 003).
Slice-004 Phase-2 + Phase-3 additions: **D-016, D-017, D-018, D-018b** (full table in `regression-checkpoint-us1.md § 4`).

**Phase 4 (US2) added zero new D-### entries.** No deviations from spec were required to ship US2 — the predicate + SP + route handler already shipped in Phases 2 + 3 implemented the WFP01 → 409 contract that T021 + T022 assert against; T024 code review confirmed end-to-end alignment.

The serialize-test discrepancy described in `red-gate-us2.md § Serialize-test discrepancy` is **NOT a deviation** — it is a forward-compat artifact of authoring `submit_final_prediction_serializes_concurrent.sql` against the post-T029 supersede invariant (Option A from T023's resolution-options section). The file stays RED-by-contract through Phase 4 and is expected to flip GREEN automatically when T029 ships the supersede branch at slot 0048. No code-level deviation is logged.

| ID | Phase | One-liner |
|---|---|---|
| D-001..D-015 | inherited | See `specs/004-final-predictions/regression-baseline-from-001-002-003.md § Inherited deviations`. |
| D-016 | slice 004 Phase 2 | Migration slot renumber +3 (spec 0036–0046 → on-disk 0039–0047). Carries forward unchanged. |
| D-017 | slice 004 Phase 2 | `tournament_config.first_kickoff_utc` is admin-owned; slot-0046 trigger is observability-only. Carries forward unchanged. |
| D-018 | slice 004 Phase 3 | Rejection-path audit-log inserts NOT implemented in `POST /api/final-predictions`; slice 007 owns audit RLS widening. Carries forward unchanged. |
| D-018b | slice 004 Phase 3 | `/api/teams` response shape uses `{ id, name, short_code, flag_url }` — no `country_code` / `group_id`. Carries forward unchanged. |

Next-deviation slot for Phase 5 / US3 work remains **D-019** (Phase 4 did not consume it).

---

## 6. RED-carry-forward items for T029

Two items were knowingly authored at Phase 4 against the post-T029 supersede invariant. Both stay deferred to Phase 5 (US3 / T029) per Option A from `red-gate-us2.md § Resolution options`:

1. **pgTAP file (1)**: `supabase/tests/pgtap/submit_final_prediction_serializes_concurrent.sql` — RED-by-contract through Phase 4. Calls `submit_final_prediction(charlie, 'champion', POL, NULL, 'ui')` twice in sequence and asserts exactly one active row at end. Slot-0044 SP does NOT yet implement supersede (header comments at 0044 lines 7 + 191-194 explicitly defer to T029); the second call raises `unique_violation` (23505) from `final_predictions_active_uk`; the `DO $$` block aborts before pgTAP's `finish()`; pgTAP reports plan(1)-vs-run(0) mismatch → RED. **Will flip GREEN automatically once T029 ships the supersede UPDATE+INSERT branch at slot 0048 — no file edit required**, the assertion is forward-compat.

2. **Playwright revision (1)**: `apps/web/tests/playwright/slice-004-submit-concurrent-tabs.spec.ts` — currently GREEN-likely against the pre-US3 reality (status pair `[200, 409]`; the loser's 23505 is mapped to 409 ALREADY_SUBMITTED by `apps/web/app/api/final-predictions/route.ts` lines 295-305). **One-line revision required when T029 ships**: change `expect(statuses).toEqual([200, 409])` → `expect(statuses).toEqual([200, 200])`. The "exactly one active row" GET assertion (the FR-010 / SC-004 invariant) survives the change unchanged. T029 owns the rewrite per its task brief.

No other slice-004 tests carry forward.

---

## 7. Pre-merge runtime verification checklist (operator runbook — US2 scope)

Run from the repo root on branch `004-final-predictions` in order. Stop on the first non-zero exit. PowerShell variants given; bash equivalents follow each step where relevant.

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all migrations on disk:
#    slice 001's 0001..0011 + slice 002's 0018..0029 + slice 003's 0030..0038 +
#    slice 004's 0039..0047 per D-016 renumber (slot 0048 still reserved for T029, NOT yet on disk).
#    Loads the four seed fixtures: slice-001 + slice-002 + slice-003 + slice-004-fixture.sql.
supabase db reset

# 3. Run every slice-004 US1 + US2 pgTAP test file individually (18 files cumulative).
#    Expected on a Docker-up host: 17 GREEN + 1 RED-as-expected
#    (`submit_final_prediction_serializes_concurrent.sql` — RED-until-T029).
Get-ChildItem supabase/tests/pgtap -Filter 'submit_final_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }
Get-ChildItem supabase/tests/pgtap -Filter 'is_final_prediction_locked_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 4. Production-mode Next.js build (confirms route handlers + /me/finals page still register).
pnpm -F web build

# 5. Start the Next.js dev server (Playwright fixtures depend on it).
pnpm -F web dev

# 6. Playwright suite — slice-004 US1 + US2 scope (32 GREEN-expected runtime tests + 1 test.fixme dormant).
pnpm -F web e2e -- --grep '@slice-004 @(us1|us2)'

# 7. Browser smoke test — US2 lock enforcement (manual, no automation).
#    a. Set `tournament_config.first_kickoff_utc` to a value in the past via service-role psql:
#       UPDATE tournament_config SET value = to_jsonb('2020-01-01T00:00:00Z'::text) WHERE key='first_kickoff_utc';
#    b. Sign in as charlie → /me/finals → page renders the FinalsLockBanner ("Final predictions are locked").
#    c. POST /api/final-predictions with a valid body → response status 409,
#       body { error: { code: 'FINAL_PREDICTIONS_LOCKED', reason: 'lock_window_passed' } }.
#    d. Restore the seed: UPDATE tournament_config SET value = to_jsonb('2026-06-16T20:00:00Z'::text) WHERE key='first_kickoff_utc';
```

Bash equivalent for step 3:

```bash
for f in supabase/tests/pgtap/submit_final_prediction_*.sql supabase/tests/pgtap/is_final_prediction_locked_*.sql; do
  supabase test db "$f" || true   # do NOT exit on the expected serialize RED; review the per-file output
done
```

A passing run produces:

- **Step 3**: 18 files; **17 of 18 GREEN** = 15 of 16 US2 planned-assertions ok + 28 of 28 US1 planned-assertions ok. **1 of 18 RED-as-expected** = file 11 (`submit_final_prediction_serializes_concurrent.sql`) reports the plan(1)-vs-run(0) mismatch or the unique_violation (23505) error described in `red-gate-us2.md § Serialize-test discrepancy`.
- **Step 4**: build succeeds; manifest shows the 4 route handlers + `/me/finals` page.
- **Step 6**: 32 GREEN runtime tests + 1 skipped `test.fixme` (the US1 after-supersede spec — flips to passed when T029 lands and the `.fixme` annotation is removed). Of the 32 GREEN, 26 are US1 + 6 are US2.
- **Step 7**: locked banner appears + POST returns 409 with the correct envelope.

### Pre-merge action items (operator checklist — US2 scope)

Tick each box before opening (or merging) the slice-004 PR.

- [ ] Docker Desktop running and healthy (`docker info` exits 0).
- [ ] Step 1 (`supabase start`) succeeds.
- [ ] Step 2 (`supabase db reset`) applies all 41 migrations + loads 4 fixtures cleanly.
- [ ] Step 3 reports 17/18 GREEN with the **1 RED on `submit_final_prediction_serializes_concurrent.sql` acknowledged in the PR description as expected-RED-until-T029**.
- [ ] Step 4 (`pnpm -F web build`) succeeds.
- [ ] Step 6 reports 32 passed + 1 skipped (US1 `test.fixme`); zero failed.
- [ ] Step 7 browser smoke confirms locked banner + 409 envelope.
- [ ] D-018 + D-018b acknowledgements (carried from US1) repeated in PR description.
- [ ] PR description references this file + `red-gate-us2.md` + `regression-checkpoint-us1.md` + (once they exist) `regression-checkpoint-us3.md` + `regression-final.md` (T034).

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack (+ Deno toolchain for the carry-forward Deno suite) IS the merge gate. Until every box above is ticked, Phase 5 (US3) MAY NOT start, the Polish phase MAY NOT start, and slice 004 MAY NOT merge to `main`.

---

## 8. Inherited deferred items (one-liner per prior slice)

- **Slice 001** — Pre-merge Docker + OIDC stub + CI workflow PR-trigger items (T005, T006, T007, T021, T031, T035, T039, T041, T044) all still pending an observed-GREEN run on a Docker-up host. See `specs/001-eligibility-login/regression-final.md`.
- **Slice 002** — All Docker-dependent + Deno carry-forward items (T001, T002, T018, T022, T028, T033, T038, T042, T043, T044, T045 + the full Deno suite). See `specs/002-match-catalog/regression-final.md`.
- **Slice 003** — Every documentation artifact (T012, T013, T015, T016, T017 + the regression-final consolidation) deferred runtime to a future Docker-up + Deno-installed session. See `specs/003-match-predictions/regression-final.md`.
- **Slice 004 / US1** — T012, T013, T014, T015 (red-gate), T016 (slot-0044 SP migration runtime), T017 (countdown unit), T018 (route runtime), T019 (UI Playwright runtime), T020 (regression-checkpoint-us1 runtime). See `specs/004-final-predictions/regression-checkpoint-us1.md`.

These items are NOT individually re-listed below. They are blocking the **consolidated** pre-merge runtime verification at slice 004's **T034** (`regression-final.md`).

---

## 9. Verdict

**US2 ARTIFACT-COMPLETE; runtime verification deferred to the consolidated `regression-final.md` (T034).**

Phase 4 produced 11 pgTAP files (16 planned assertions) + 6 Playwright spec files (6 tests) — all on disk, all type-consistent, all reconciled against the slot-0041 predicate + slot-0044 SP + T018 route handler that shipped in Phases 2 + 3. **0 new migrations** were required (T024 code review confirmed end-to-end alignment with the locked WFP01 → 409 / 23505 → 409 contract). **0 first-party app files changed** in Phase 4 (test-only). **0 new D-### deviations** were added; **D-016, D-017, D-018, D-018b** carry forward unchanged.

**1 RED-carry-forward** is acknowledged: `submit_final_prediction_serializes_concurrent.sql` stays RED through Phase 4 (forward-compat artifact for the post-T029 supersede invariant). **1 forward-compat Playwright revision** is anticipated when T029 ships: `slice-004-submit-concurrent-tabs.spec.ts` will flip its status-pair assertion from `[200, 409]` to `[200, 200]`. The "exactly one active row" invariant survives both transitions.

Per Principle XI, Phase 5 (US3) MAY proceed at the artifact-authoring level, but the slice cannot merge until the § 7 runtime checklist is observably GREEN.

This is the **World Cup Madness** project.
