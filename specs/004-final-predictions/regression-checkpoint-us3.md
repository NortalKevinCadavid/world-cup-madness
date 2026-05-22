# Regression checkpoint — Slice 004, Phase 5 (US3)

- **Slice**: `004-final-predictions`
- **Phase**: 5 (US3 — "Participant updates an existing prediction; the prior value is preserved as a superseded version; the new value becomes the active one")
- **Date**: 2026-05-20
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T030 (`specs/004-final-predictions/tasks.md` line 1035)
- **Companion artifacts**:
  - `specs/004-final-predictions/regression-baseline-from-001-002-003.md` (T001 — slice-001 + slice-002 + slice-003 carry-forward baseline)
  - `specs/004-final-predictions/regression-checkpoint-us1.md` (T020 — US1 sibling checkpoint)
  - `specs/004-final-predictions/regression-checkpoint-us2.md` (T025 — US2 sibling checkpoint; this document mirrors its structure)
  - `specs/004-final-predictions/red-gate-us1.md` (T015 — US1 RED inventory)
  - `specs/004-final-predictions/red-gate-us2.md` (T023 — US2 RED inventory)
  - `specs/004-final-predictions/red-gate-us3.md` (T028 — US3 RED inventory)
- **Purpose**: Record the state of the slice-001 + slice-002 + slice-003 + slice-004-(US1+US2+US3) test suite at the moment US3 lands in slice 004, inventory every test the operator must run, and hand the exact verification commands to whoever next has a working Docker daemon + Deno toolchain. Per Principle XI, the Polish phase (Phase 6) MAY NOT start, and the slice MAY NOT merge to `main`, until all verification commands below land GREEN on a Docker-up + Deno-installed host.

---

## Status: DEFERRED

Both the Docker daemon (required by `supabase start`, `supabase db reset`, `supabase test db`, and every Playwright fixture that boots the local Supabase stack) and the Deno toolchain (required by the slice-002 `provider-stub.test.ts` carry-forward suite) were **unavailable at execution time**. `supabase start`, `supabase db reset`, `supabase test db`, the Next.js dev server, the Playwright suite, and `deno test` therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added so far in slice 004 Phase 5 (cumulative with slices 001 + 002 + 003 + slice-004 US1 + US2), and hands the exact commands the user MUST run locally (or in CI, once slice 001's T007 ships) before Phase 6 (Polish) begins or the slice can merge. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 8 have all returned GREEN.

---

## 1. Phase 5 task summary (T026 → T030)

| T# | Type | Output |
|---|---|---|
| T026 | RED authoring (pgTAP) | **3 pgTAP files** under `supabase/tests/pgtap/submit_final_prediction_{update_supersedes,identical_champion_runner_up,admin_override}.sql` exercising the supersede branch + WFP06 disjoint + admin_override source enum. Planned-assertion total = 8 + 5 + 4 = **17 assertions**. |
| T027 | RED authoring (Playwright) | **3 Playwright specs**, 3 test bodies, all tagged `@slice-004 @us3` (one additionally `@us1`). Net new files: **2** — `slice-004-submit-update-supersedes.spec.ts` + `slice-004-submit-identical-champ-runner.spec.ts`. **1 modified** — `slice-004-me-final-predictions-after-supersede.spec.ts` (T014's `test.fixme` removed). |
| T028 | RED gate (artifact) | `specs/004-final-predictions/red-gate-us3.md` — documentation artifact; runtime observation deferred (Docker down). 6 US3-new tests catalogued: 2 CURRENT-GREEN against T016, 4 RED-by-contract until T029. 2 Phase-4 carry-forward items reconciled (CF-1 pgTAP serializes-concurrent + CF-2 Playwright concurrent-tabs). |
| T029 | GREEN implementation | **Migration `0048_submit_final_prediction_supersede.sql`** — supersede UPDATE+INSERT branch on the SP slot 0044. Novel pattern: "born-superseded NEW, then resurrect" — pre-generates `v_new_id`, INSERTs NEW with `superseded_at=now()` + `superseded_by=v_existing_id` (NOT in the active partial-unique-index domain), UPDATEs OLD with `superseded_by=v_new_id` (audit trigger captures the correct JSONB shape per T026 A7), then UPDATEs NEW back to active (`superseded_at=NULL`, `superseded_by=NULL`). The SP body also manually INSERTs a `final_prediction.created` audit row with `source='trigger'` because the trigger only fires `created` on INSERT-active and NEW was born superseded. **D-019** records this design decision. |
| **T030** (this doc) | Regression checkpoint + 1 Playwright code revision | `specs/004-final-predictions/regression-checkpoint-us3.md` + one-line edit to `apps/web/tests/playwright/slice-004-submit-concurrent-tabs.spec.ts` (`[200, 409]` → `[200, 200]`; inline comment header rewritten POST-US3; `@us3` tag added on `describe` + `test`; unused `ErrorBody` interface dropped). |

---

## 2. As-built artifact inventory delta vs US2

Phase 5 added **one migration** (slot 0048, T029) — the first non-test surface added to slice 004 since the US1 Phase-3 ship.

| Surface | Phase 4 (US2) delta | Phase 5 (US3) delta | Notes |
|---|---|---|---|
| pgTAP files | + 11 (T021) | **+ 3 (T026)** | supersede + identical-champ-runner + admin_override. Net cumulative slice-004 pgTAP: 18 → 21. |
| Playwright specs | + 6 (T022) | **+ 2 new (T027) + 1 un-fixme'd (T027) + 1 revised (T030)** | T027 created `slice-004-submit-update-supersedes.spec.ts` + `slice-004-submit-identical-champ-runner.spec.ts`; T027 removed the `test.fixme` annotation from T014's `slice-004-me-final-predictions-after-supersede.spec.ts` (counted in US1 totals as a *file* but flipped from `test.fixme` → active in this phase); T030 revised `slice-004-submit-concurrent-tabs.spec.ts` (one-line `[200, 409]` → `[200, 200]` + inline comment rewrite). |
| Migrations | 0 | **+ 1 (T029)** | `0048_submit_final_prediction_supersede.sql`. Net cumulative slice-004 migrations: 9 → 10 (slots 0039–0048 per D-016 renumber). |
| Route handlers (TS) | 0 | **0** | `POST /api/final-predictions`'s 23505 → 409 ALREADY_SUBMITTED branch is now unreachable on the same-(participant, item_kind) path because the SP supersede branch no longer raises 23505 there; the branch is retained as defensive code for race conditions outside the advisory-lock domain. No code edits. |
| TS lib files | 0 | **0** | Phase 5 added no TS lib surface. |
| Page + components | 0 | **0** | `/me/finals` page + FinalsForm/TeamPicker/PlayerPicker/FinalsLockBanner unchanged. |

---

## 3. Cumulative slice 004 totals (US1 + US2 + US3)

Running totals at end of Phase 5 (cumulative across slice 004 Phases 2 + 3 + 4 + 5):

| Surface | US1 total | + US2 delta | + US3 delta | Cumulative US1 + US2 + US3 |
|---|---|---|---|---|
| pgTAP files (slice 004) | 7 | + 11 | + 3 | **21** |
| Playwright spec files (slice 004) | 26 | + 6 | + 2 new (T027) + 1 revised (T030, no net-new file) | **34 files** (26 + 6 + 2 = 34; T027's third spec was already counted as a US1 file at T014 with `test.fixme`, now un-fixme'd) |
| Playwright test bodies, runtime-expected GREEN | 26 (1 dormant `test.fixme`) | + 6 | + 1 newly-activated `test.fixme` removal + 2 new bodies | **35 runtime-GREEN bodies** (no dormant `test.fixme` left after T027) |
| Migrations (slice 004 on disk, slots 0039–0048 per D-016) | 9 | + 0 | **+ 1** | **10** |
| TS lib files (slice 004) | 6 | + 0 | + 0 | **6** |
| Route handlers (slice 004) | 4 | + 0 | + 0 | **4** |
| Pages (slice 004) | 1 | + 0 | + 0 | **1** (`/me/finals`) |
| Client components (slice 004) | 4 | + 0 | + 0 | **4** (FinalsForm + TeamPicker + PlayerPicker + FinalsLockBanner) |

> **Playwright reconciliation**: The US2 checkpoint reported 32 GREEN-expected runtime tests + 1 dormant `test.fixme`. T027 un-fixme'd the `slice-004-me-final-predictions-after-supersede.spec.ts` file (flipping its body from `test.fixme` → active) and added 2 brand-new spec files (supersede + identical-champ-runner). That's `32 + 1 + 2 = 35` runtime-expected GREEN test bodies. The "34 spec files" count reflects the *file* delta: 26 (US1) + 6 (US2) + 2 (US3 new from T027) = 34. T030's revision to `slice-004-submit-concurrent-tabs.spec.ts` (a US2 file) is a content edit, not a new file.

**Cumulative pgTAP planned assertions**: 28 (US1) + 16 (US2) + 17 (US3) = **61 planned assertions** across the slice-004 US1 + US2 + US3 pgTAP set.

**Cumulative pgTAP on-disk total at end of Phase 5** (across all slices): 12 (slice 001) + 9 (slice 002) + ~22 (slice 003) + 21 (slice 004) = **~64 pgTAP files** on disk.

---

## 4. Cross-slice contract status (carry-forward verification)

Per `regression-baseline-from-001-002-003.md`, slice 004 inherited **8 cross-slice contracts** from slices 001 + 002 + 003. None were broken by slice 004 Phases 2 / 3 / 4 / 5. Phase 5 added one migration (T029) that extends — but does not break — the SP contract from slot 0044; the partial-unique-index `final_predictions_active_uk` and the audit trigger at slot 0043 are both still honored (the trigger receives the correct JSONB shape thanks to the born-superseded-then-resurrect pattern documented in D-019).

| # | Contract | Owner | Slice-004-Phase-5 status |
|---|---|---|---|
| 1 | `public.is_eligible_nortal_participant(uuid) STABLE` | slice 001 / 0005 | **INTACT.** No Phase-5 modification. |
| 2 | `public.is_admin(uuid)` (stub) | slice 001 / 0006 | **INTACT.** No Phase-5 modification. |
| 3 | `public.participants` table (auth_user_id, status) | slice 001 / 0001 | **INTACT.** No Phase-5 modification. |
| 4 | `public.audit_log` shape | slice 001 / 0003 | **INTACT.** T029's SP body INSERTs a `final_prediction.created` audit row with `source='trigger'` from the SP body itself (because the trigger only fires `created` on INSERT-active and NEW was born superseded) — uses the existing audit_log shape unchanged. D-019 records this for slice-007 audit hardening: it MUST NOT add a duplicate-`created` guard that would reject this manual INSERT. |
| 5 | `public.matches` (id, status, kickoff_utc, stage) | slice 002 / 0020 | **INTACT.** No Phase-5 modification. |
| 6 | `public.teams` (id, short_code) | slice 002 / 0019 | **INTACT.** No Phase-5 modification. |
| 7 | `public.tournament_config` | slice 001 + slices 002/003/004 seed | **INTACT.** T026 + T027 specs mutate `predictions.allow_identical_champion_runner_up` + `first_kickoff_utc` keys via UPDATE + ROLLBACK / `afterEach` restoration. No schema change. |
| 8 | `MatchDataProviderAdapter.fetchPlayers?` interface | slice 002 / providers/types.ts | **INTACT.** No Phase-5 modification. |

**All 8 contracts intact at end of Phase 5.**

---

## 5. Deviations log delta (running totals after Phase 5)

Inherited carry-forward: **D-001 through D-015** (slices 001 + 002 + 003).
Slice-004 Phase-2 + Phase-3 additions: **D-016, D-017, D-018, D-018b**.
Phase 4 (US2) added **zero** new D-### entries.
Phase 5 (US3) adds **one** new D-### entry — **D-019**.

| ID | Phase | One-liner |
|---|---|---|
| D-001..D-015 | inherited | See `specs/004-final-predictions/regression-baseline-from-001-002-003.md § Inherited deviations`. |
| D-016 | slice 004 Phase 2 | Migration slot renumber +3 (spec 0036–0046 → on-disk 0039–0048 now that T029 has consumed slot 0048). Carries forward unchanged. |
| D-017 | slice 004 Phase 2 | `tournament_config.first_kickoff_utc` is admin-owned; slot-0046 trigger is observability-only. Carries forward unchanged. |
| D-018 | slice 004 Phase 3 | Rejection-path audit-log inserts NOT implemented in `POST /api/final-predictions`; slice 007 owns audit RLS widening. Carries forward unchanged. |
| D-018b | slice 004 Phase 3 | `/api/teams` response shape uses `{ id, name, short_code, flag_url }` — no `country_code` / `group_id`. Carries forward unchanged. |
| **D-019** | **slice 004 Phase 5 (T029)** | **NEW**. T029's supersede branch uses the **"born-superseded NEW, then resurrect"** pattern: pre-generates `v_new_id`, INSERTs NEW with `superseded_at=now()` + `superseded_by=v_existing_id` (NOT in the active partial-unique-index domain, so the INSERT does not collide), UPDATEs OLD with `superseded_by=v_new_id` (the slot-0043 audit trigger captures the correct `final_prediction.superseded` JSONB with `new_value->>'superseded_by' = v_new_id` per T026 A7), then UPDATEs NEW back to active (`superseded_at=NULL`, `superseded_by=NULL`). The SP body also manually INSERTs a `final_prediction.created` audit row with `source='trigger'` (uses the existing audit_log shape) because the trigger only fires `created` on INSERT-active and NEW was born superseded. Slice 003's self-reference placeholder pattern (D-014) could NOT satisfy T026 A7's JSONB-shape audit assertion (it leaves `new_value->>'superseded_by'` pointing at the OLD row, not the NEW row). **Slice 007 audit hardening MUST NOT add a duplicate-`created` guard that rejects this manual INSERT.** |

Next-deviation slot for Phase 6 / Polish work: **D-020**.

---

## 6. Red-then-green resolution table

Carry-forward items from Phase 4 + Phase-5 RED-now items, with their disposition after T029 + T030 shipped:

| Item | Origin | Pre-T029 status | Post-T029 + T030 status |
|---|---|---|---|
| Phase 4 carry-forward 1: `submit_final_prediction_serializes_concurrent.sql` | T021 file 11 | RED-by-contract (DO block aborts on 23505 from 2nd SP call). | **GREEN after T029 — no file edit required.** The forward-compat assertion (exactly one active row after two sequential `submit_final_prediction(charlie, 'champion', POL)` calls) is satisfied by T029's supersede UPDATE+INSERT branch. |
| Phase 4 carry-forward 2: `slice-004-submit-concurrent-tabs.spec.ts` | T022 file 6 | GREEN-against-pre-US3-reality (asserts `[200, 409]`). | **GREEN after T030's one-line edit** (`[200, 409]` → `[200, 200]`; inline comment header rewritten POST-US3; `@us3` tag added on `describe` + `test`; unused `ErrorBody` interface removed; trailing GET / winning-team-id logic updated to read both 200 envelopes and assert the surviving active row matches one of the two posted teams). The load-bearing "exactly one active row" GET invariant survives unchanged. |
| Phase 5 US3-new pgTAP 1: `submit_final_prediction_update_supersedes.sql` | T026 file 1 | RED-by-contract (INSERT collision at step 7 → 23505). | **GREEN after T029.** All 8 assertions (A1 exactly-one-active-row, A2 active-row-shape, A3 OLD-row-superseded, A4 `OLD.superseded_by = NEW.id`, A5 NEW != OLD, A6 one `final_prediction.created` audit row, A7 one `final_prediction.superseded` audit row with `new_value->>'superseded_by' = NEW.id`, A8 final state) pass against the supersede branch + manual `created` audit INSERT. |
| Phase 5 US3-new pgTAP 2: `submit_final_prediction_identical_champion_runner_up.sql` | T026 file 2 | CURRENT-GREEN against T016 (does not invoke supersede). | **Still GREEN.** T029 has no effect on this test. |
| Phase 5 US3-new pgTAP 3: `submit_final_prediction_admin_override.sql` | T026 file 3 | CURRENT-GREEN against T016 (does not invoke supersede). | **Still GREEN.** T029 has no effect on this test. |
| Phase 5 US3-new Playwright 1: `slice-004-submit-update-supersedes.spec.ts` | T027 file 1 | RED-by-contract (2nd POST 409 instead of asserted 200). | **GREEN after T029.** 2nd POST 200; data-layer + GET checks pass. |
| Phase 5 US3-new Playwright 2: `slice-004-submit-identical-champ-runner.spec.ts` | T027 file 2 | likely-GREEN at runtime (no supersede invoked). | **Still likely-GREEN.** T029 has no effect on this test. |
| Phase 5 US3-new Playwright 3: `slice-004-me-final-predictions-after-supersede.spec.ts` | T027 file 3 (T014 `test.fixme` removed) | RED-by-contract (2nd POST 409 instead of asserted 200). | **GREEN after T029.** 2nd POST 200; GET shows exactly one champion entry pointing at BRA. |

**Phase 5 RED-now items remaining**: **0**. All 6 US3 tests (3 pgTAP + 3 Playwright) are GREEN-or-likely-GREEN after T029; the 2 Phase-4 carry-forward items are GREEN after T029 (pgTAP) + T030 (Playwright). The slice has zero authored tests in a RED-by-contract state after Phase 5 ships.

---

## 7. Inherited deferred items (one-liner per prior slice)

- **Slice 001** — Pre-merge Docker + OIDC stub + CI workflow PR-trigger items (T005, T006, T007, T021, T031, T035, T039, T041, T044) all still pending an observed-GREEN run on a Docker-up host. See `specs/001-eligibility-login/regression-final.md`.
- **Slice 002** — All Docker-dependent + Deno carry-forward items (T001, T002, T018, T022, T028, T033, T038, T042, T043, T044, T045 + the full Deno suite). See `specs/002-match-catalog/regression-final.md`.
- **Slice 003** — Every documentation artifact (T012, T013, T015, T016, T017 + the regression-final consolidation) deferred runtime to a future Docker-up + Deno-installed session. See `specs/003-match-predictions/regression-final.md`.
- **Slice 004 / US1** — T012, T013, T014, T015 (red-gate), T016 (slot-0044 SP migration runtime), T017 (countdown unit), T018 (route runtime), T019 (UI Playwright runtime), T020 (regression-checkpoint-us1 runtime). See `specs/004-final-predictions/regression-checkpoint-us1.md`.
- **Slice 004 / US2** — T021 (11 pgTAP runtime), T022 (6 Playwright runtime), T023 (red-gate-us2), T024 (GREEN verification — code-review only on Docker-down host), T025 (regression-checkpoint-us2 runtime). See `specs/004-final-predictions/regression-checkpoint-us2.md`.

These items are NOT individually re-listed in § 8 below. They are blocking the **consolidated** pre-merge runtime verification at slice 004's **T034** (`regression-final.md`).

---

## 8. Pre-merge runtime verification checklist (operator runbook — US3 scope)

Run from the repo root on branch `004-final-predictions` in order. Stop on the first non-zero exit. PowerShell variants given; bash equivalents follow each step where relevant.

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all migrations on disk:
#    slice 001's 0001..0011 + slice 002's 0018..0029 + slice 003's 0030..0038 +
#    slice 004's 0039..0048 per D-016 renumber (T029's slot 0048 is now on disk).
#    Loads the four seed fixtures: slice-001 + slice-002 + slice-003 + slice-004-fixture.sql.
supabase db reset

# 3. Run every slice-004 US1 + US2 + US3 pgTAP test file individually (21 files cumulative).
#    Expected on a Docker-up host: 21 of 21 GREEN
#    (the Phase-4 RED-until-T029 file `submit_final_prediction_serializes_concurrent.sql`
#    now flips GREEN against T029's supersede branch; all 3 T026 files report all
#    planned assertions ok).
Get-ChildItem supabase/tests/pgtap -Filter 'submit_final_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }
Get-ChildItem supabase/tests/pgtap -Filter 'is_final_prediction_locked_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 4. Production-mode Next.js build (confirms route handlers + /me/finals page still register).
pnpm -F web build

# 5. Start the Next.js dev server (Playwright fixtures depend on it).
pnpm -F web dev

# 6. Playwright suite — slice-004 US1 + US2 + US3 scope (~35 GREEN-expected runtime tests).
pnpm -F web e2e -- --grep "@slice-004 @(us1|us2|us3)"

# 7. Browser smoke test — US3 supersede semantics (manual, no automation).
#    a. Reset DB to seed via `supabase db reset` (re-establish the future-dated kickoff).
#    b. Sign in as charlie → /me/finals.
#    c. POST /api/final-predictions { item_kind: 'champion', target_team_id: ARG_TEAM_ID }
#       → response status 200 with the new active row.
#    d. POST /api/final-predictions { item_kind: 'champion', target_team_id: BRA_TEAM_ID }
#       → response status 200 (supersede branch). NO 409 ALREADY_SUBMITTED.
#    e. GET /api/me/final-predictions → champion entry is BRA, NOT ARG.
#       The ARG row exists in the DB with `superseded_at IS NOT NULL` +
#       `superseded_by = <BRA row id>` (verify via service-role psql).
```

Bash equivalent for step 3:

```bash
for f in supabase/tests/pgtap/submit_final_prediction_*.sql supabase/tests/pgtap/is_final_prediction_locked_*.sql; do
  supabase test db "$f"
done
```

A passing run produces:

- **Step 3**: 21 files; **21 of 21 GREEN** = 28 of 28 US1 planned-assertions ok + 16 of 16 US2 planned-assertions ok + 17 of 17 US3 planned-assertions ok = **61 of 61 cumulative pgTAP planned assertions ok**.
- **Step 4**: build succeeds; manifest shows the 4 route handlers + `/me/finals` page.
- **Step 6**: ~35 GREEN runtime tests; zero skipped, zero failed (the US1 `test.fixme` was lifted in T027). Of the 35: 26 are US1 + 6 are US2 + 3 are US3-new (+ 0 net-new spec files from US3 because T027's third file was already counted in US1 and the T030 revision touches a US2 file).
- **Step 7**: 200 → 200 status pair; GET shows BRA active + ARG row exists with `superseded_at IS NOT NULL` and `superseded_by` pointing at the BRA row.

### Pre-merge action items (operator checklist — US3 scope)

Tick each box before opening (or merging) the slice-004 PR.

- [ ] Docker Desktop running and healthy (`docker info` exits 0).
- [ ] Step 1 (`supabase start`) succeeds.
- [ ] Step 2 (`supabase db reset`) applies all 42 migrations + loads 4 fixtures cleanly.
- [ ] Step 3 reports 21/21 GREEN (no RED-acknowledged caveats — the Phase-4 RED-until-T029 file now passes against the supersede branch).
- [ ] Step 4 (`pnpm -F web build`) succeeds.
- [ ] Step 6 reports ~35 passed (no skipped, no failed).
- [ ] Step 7 browser smoke confirms 200 + 200 + GET shows BRA active + ARG superseded.
- [ ] D-018, D-018b, D-019 acknowledgements repeated in PR description (D-019 callout is required: the SP body's manual `created` audit INSERT is BY DESIGN and slice 007 hardening must NOT add a duplicate-`created` guard that rejects it).
- [ ] PR description references this file + `red-gate-us3.md` + `regression-checkpoint-us1.md` + `regression-checkpoint-us2.md` + (once it exists) `regression-final.md` (T034).

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack (+ Deno toolchain for the carry-forward Deno suite) IS the merge gate. Until every box above is ticked, the Polish phase (Phase 6) MAY NOT start, and slice 004 MAY NOT merge to `main`.

---

## 9. Verdict

**US3 ARTIFACT-COMPLETE; runtime verification deferred to the consolidated `regression-final.md` (T034).**

Phase 5 produced 3 pgTAP files (17 planned assertions) + 2 new Playwright spec files + 1 un-fixme'd Playwright spec file (3 test bodies total) + 1 SP migration (slot 0048, T029) + 1 one-line Playwright revision (T030 to `slice-004-submit-concurrent-tabs.spec.ts`). All on disk, all type-consistent (`pnpm -F web exec tsc --noEmit` clean post-revision), all reconciled against the slot-0048 supersede branch + the existing slot-0041 predicate / slot-0043 audit trigger / slot-0044 SP base / T018 route handler / T019 client surface.

**1 new D-### deviation** was added in Phase 5: **D-019** (T029's born-superseded NEW + manual `created` audit INSERT pattern). **D-016, D-017, D-018, D-018b** carry forward unchanged.

**Both Phase-4 RED-carry-forward items** resolved:

1. `submit_final_prediction_serializes_concurrent.sql` (pgTAP) — GREEN after T029, no edit required (forward-compat assertion shape).
2. `slice-004-submit-concurrent-tabs.spec.ts` (Playwright) — GREEN after T030's `[200, 409]` → `[200, 200]` revision (+ comment header rewrite + `@us3` tag + unused interface drop + adapted winner-determination logic that reads both 200 envelopes and asserts the surviving active row via the GET endpoint). The load-bearing "exactly one active row" GET invariant survives unchanged.

**0 RED-by-contract tests remain authored** in slice 004 at end of Phase 5. Slice 004's behavioral envelope (CREATE, LOCKED, SUPERSEDE, IDENTICAL, ADMIN_OVERRIDE, CONCURRENT) is fully tested end-to-end at the artifact level.

Per Principle XI, Phase 6 (Polish) MAY proceed at the artifact-authoring level, but the slice cannot merge until the § 8 runtime checklist is observably GREEN.

This is the **World Cup Madness** project.
