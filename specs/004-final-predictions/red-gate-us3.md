# RED Gate — Slice 004 / User Story 3 (US3)

**Slice**: `004-final-predictions`
**Phase**: 5 (US3 — "Participant updates an existing prediction; the prior value is preserved as a superseded version; the new value becomes the active one")
**Date**: 2026-05-20
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T028 (the Principle IX gate task itself; US3 red-gate document).

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both `supabase test db` for pgTAP and by the Playwright suite, which boots the local Supabase stack as a fixture) was **down at the time of execution**, AND Deno is not installed on this host. The test inventory below is therefore documentary, not observed.

The Phase-5 / US3 distribution is **mixed**, similar in spirit to (but more skewed than) the Phase-4 / US2 distribution:

- **Two of the six US3-new tests are CURRENT-GREEN** against the already-shipped T016 SP — they exercise validation surfaces (WFP06 disjoint + config-read; `admin_override` source enum value) that T016 *already implements*. They do not touch the supersede branch.
- **Four of the six US3-new tests are RED-by-contract** until T029 ships the supersede UPDATE+INSERT branch at on-disk migration slot **0048** (per D-016 — see `red-gate-us1.md`).
- **One carry-forward pgTAP from Phase 4** (`submit_final_prediction_serializes_concurrent.sql`, file 11 of T021 — see `red-gate-us2.md` § Serialize-test discrepancy) also flips GREEN after T029 lands.
- **One carry-forward Playwright from Phase 4** (`slice-004-submit-concurrent-tabs.spec.ts`, file 6 of T022) needs a one-line CODE revision after T029 (`[200, 409]` → `[200, 200]`); T030 owns that revision per its task brief. It is NOT flipped GREEN solely by T029.

This document exists so that:

1. The Phase-5 / US3 RED tests authored in T026 (3 pgTAP files, 17 planned assertions) and T027 (3 Playwright specs, 3 tests; one of which is a `test.fixme`-removal in a file inherited from T014) are catalogued with their expected status under the current Phase-5 entry gate.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.
4. The carry-forward expectations from Phase 4 are reconciled explicitly with the Phase-5 GREEN gate, so reviewers understand which RED units flip on which task (T029 alone, or T029 + T030).

The merge of Slice 004 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 5 (US3) produced **6 RED-state test units** authored in this phase (3 pgTAP files + 3 Playwright tests across 3 spec files; one of those spec files is the T014 `test.fixme` file that T027 un-fixme'd). Total **21 behaviorally-distinct assertions** authored in this phase (17 pgTAP planned + 4 high-level Playwright test bodies — counting the supersede + identical + me-after-supersede spec files individually). Two carry-forward items from Phase 4 are also tracked here so the PR reviewer sees the complete US3 disposition.

### pgTAP files (T026 — 3 files)

| # | Test file | `plan(N)` | Expected status pre-T029 | GREEN implementer |
|---|-----------|-----------|--------------------------|-------------------|
| 1 | `supabase/tests/pgtap/submit_final_prediction_update_supersedes.sql` | `plan(8)` | **RED-by-contract**. Direct-INSERT seeds charlie's existing `champion=ARG` row (bypassing the SP), then the SP is called for `(charlie, champion, BRA)`. Per the contract this MUST INSERT a new active row AND UPDATE the OLD row's `superseded_at = now()` + `superseded_by = <new id>` in the same transaction. T016's SP has NO supersede branch (its own header comment says "T029 (US3) will extend with the supersede UPDATE+INSERT pattern"); the INSERT step (step 7 in the SP body) hits `final_predictions_active_uk` (the partial unique index) and raises 23505 (`unique_violation`). pgTAP reports the SP call failing with `unique_violation`; the surrounding DO block aborts; all 8 assertions (A1 exactly-one-active-row, A2 active-row-shape, A3 OLD-row-superseded, A4 OLD.superseded_by = NEW.id, A5 NEW != OLD, A6 one `final_prediction.created` audit row, A7 one `final_prediction.superseded` audit row with `new_value->>'superseded_by' = NEW.id`, A8 final state matches) are unreachable. | T029 (`supabase/migrations/0048_submit_final_prediction_supersede.sql` — supersede UPDATE+INSERT branch + the slot-0043 audit trigger's existing `final_prediction.superseded` action emission on the UPDATE). |
| 2 | `supabase/tests/pgtap/submit_final_prediction_identical_champion_runner_up.sql` | `plan(5)` | **CURRENT-GREEN against T016**. Step 1 submits `champion=POL` for charlie via the SP — a fresh-create on a clean (charlie, champion) pair (the slice-004 fixture seeds Row 6 = `best_player`→Pedri only for charlie; no champion row pre-exists). Step 2 attempts `runner_up=POL` and expects WFP06 — exactly what T016's SP step 6 raises (the disjoint check reads `tournament_config.predictions.allow_identical_champion_runner_up` via the seed-0047 key and raises WFP06 when the values match AND the flag is `false`). Step 3 UPDATEs `tournament_config` flipping the flag to `true`, then Step 4 re-submits `runner_up=POL` — a fresh-create on `runner_up` (different item_kind than `champion`), which is the create-only branch and does not invoke supersede. Assertions A1 (WFP06 raised on first runner_up), A2 (non-null uuid after flip), A3 (exactly one active runner_up = POL), A4 (champion row untouched), A5 (the two ids differ) all hold against T016. **NOTE: this test does NOT invoke supersede.** It is intentionally aligned with the T016 reality. | (already shipped — T016 + slot-0047 seed; T029 has no effect on this test.) |
| 3 | `supabase/tests/pgtap/submit_final_prediction_admin_override.sql` | `plan(4)` | **CURRENT-GREEN against T016**. Single fresh-create call: `submit_final_prediction(charlie, 'champion', POL, NULL, 'admin_override')`. T016's source-enum check at step 2b accepts `'admin_override'` alongside `'ui'` and `'api'`; the SP body unconditionally sets `created_by = p_participant_id` regardless of source channel. Assertions A1 (non-null uuid returned), A2 (new row.source = 'admin_override'), A3 (new row.created_by = charlie's participants.id), A4 (audit row has action=`final_prediction.created`, `new_value->>'source'='admin_override'`, `actor=charlie` via the trigger's `COALESCE(NEW.created_by, NEW.participant_id)` derivation) all hold against the T016 SP and the slot-0043 audit trigger. **NOTE: this test does NOT invoke supersede.** It is a single fresh-create on a clean (charlie, champion) pair. Slice 006 will add a separate test that exercises the admin wrapper (where `created_by` diverges from `participant_id` because the admin's own `participants.id` ≠ the target participant); that's out of scope here. | (already shipped — T016 + slot-0043 audit trigger; T029 has no effect on this test.) |

**pgTAP planned-assertion total**: `8 + 5 + 4 = 17 planned assertions` across the 3 files. Expected status: **9 GREEN-now / 8 RED-until-T029**.

### Playwright files (T027 — 3 files)

All 3 files are tagged `@slice-004 @us3` (the third additionally carries `@us1` because the underlying read endpoint is the US1 surface). The route handler (`apps/web/app/api/final-predictions/route.ts`) and its SP-error → HTTP-status mapping shipped in T018; the missing ingredient for the supersede behavior is the SP's supersede branch (T029). Until T029 lands, the second POST in each spec hits the 23505 path → 409 ALREADY_SUBMITTED (per the route's 23505-mapping at lines 295–305) — which is the opposite of the asserted 200. Therefore all 3 specs are RED-by-contract pre-T029.

| # | Test file | Tests | Expected status pre-T029 | GREEN implementer |
|---|-----------|-------|--------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-004-submit-update-supersedes.spec.ts` | 1 test | **RED-by-contract**. Charlie POSTs `champion=ARG` (1st: 200, CREATE branch); then POSTs `champion=BRA` (2nd: asserted 200 — supersede branch). Pre-T029, the 2nd POST returns 409 ALREADY_SUBMITTED (23505 mapped); the status assertion at line 168 fails. Downstream service-role data-layer checks (exactly 2 rows for (charlie, champion); ARG row has `superseded_at IS NOT NULL` + `superseded_by = BRA row id`; BRA row has `superseded_at IS NULL`) and the GET active-only assertion are unreachable until T029. | T029 (SP supersede branch — replaces the 23505 path with UPDATE+INSERT). |
| 2 | `apps/web/tests/playwright/slice-004-submit-identical-champ-runner.spec.ts` | 1 test | **RED-by-contract**. Step 1 POSTs `champion=POL` (200, fresh-create — OK against T016). Step 2 POSTs `runner_up=POL` and expects 409 with `code='IDENTICAL_CHAMPION_RUNNER_UP'` + `reason='identical_champion_runner_up'`. T016's SP raises WFP06 on this path; T018's route maps WFP06 → 409 `IDENTICAL_CHAMPION_RUNNER_UP`. So this step alone is GREEN against the already-shipped surface. **HOWEVER**, Step 3 flips the config flag via service-role, and Step 4 re-submits `runner_up=POL` expecting 200. Since charlie has no existing `runner_up` row, this fourth submission is a fresh-create (not a supersede) and should also succeed against T016 — **so the test body is, in fact, CURRENT-GREEN against T016**. The corresponding pgTAP file #2 (above) made the same observation. Filed RED-by-contract here only out of caution: a Docker-up runtime confirmation may reveal a contract drift in the route handler's WFP06 → envelope mapping (e.g. an unexpected envelope nesting) that the test tolerates via its dual-shape `error.code` / `error: 'STRING'` reader at lines 208–215. **Likely-GREEN at runtime.** | (already shipped — T016 + slot-0047 seed + T018 route's WFP06 → 409 mapping; T029 has no effect.) |
| 3 | `apps/web/tests/playwright/slice-004-me-final-predictions-after-supersede.spec.ts` | 1 test (**`test.fixme` removed in T027**) | **RED-by-contract**. Inherited from T014 with `test.fixme` un-fixme'd by T027. Charlie POSTs `champion=ARG` then `champion=BRA`; asserts 2nd POST returns 200 and GET returns exactly one champion entry pointing at BRA. Pre-T029 the 2nd POST returns 409 ALREADY_SUBMITTED; status assertion at line 152 fails. The active-only GET behavior is already shipped in T018, but it cannot be exercised until the second-POST 200 lands via T029. | T029 (SP supersede branch). |

**Playwright test total**: 3 distinct Playwright tests across 3 files; expected status pre-T029: **2 RED-by-contract / 1 likely-GREEN-but-Docker-deferred**.

### Carry-forward items from Phase 4

| # | Test file | Origin task | Expected disposition | Flips on |
|---|-----------|-------------|----------------------|----------|
| CF-1 | `supabase/tests/pgtap/submit_final_prediction_serializes_concurrent.sql` | T021 file 11 (Phase 4) | **RED through Phase 4 + Phase 5 entry gate**; documented in `red-gate-us2.md` §§ Serialize-test discrepancy + Per-file verdicts (verdict: RED-deferred-to-T029). Asserts exactly-one-active-row after TWO sequential SP calls for `(charlie, champion, POL)` — the post-T029 supersede invariant. Pre-T029, the 2nd SP call hits 23505 and the DO block aborts. | T029 alone. No edit to file 11 required. |
| CF-2 | `apps/web/tests/playwright/slice-004-submit-concurrent-tabs.spec.ts` | T022 file 6 (Phase 4) | **GREEN-now against pre-US3 reality**; documented in `red-gate-us2.md` (verdict: GREEN-now). Asserts `[200, 409]` status pair for two parallel POSTs of `(charlie, champion)` with DIFFERENT teams (POL vs JPN). Post-T029 this assertion is WRONG — both POSTs return 200. T030's task brief explicitly owns the one-line revision: `expect(statuses).toEqual([200, 409])` → `expect(statuses).toEqual([200, 200])`. The "exactly one active row" GET invariant survives unchanged. | T029 (semantics) + T030 (test edit). NOT flipped by T029 alone. |

---

## Highlights

- **2 of 6 T026 + T027 US3-new tests are CURRENT-GREEN against the already-shipped T016 SP** — both are pgTAP files (`submit_final_prediction_identical_champion_runner_up.sql` and `submit_final_prediction_admin_override.sql`). Each exercises a T016-owned surface (WFP06 disjoint + config-flag bypass; `admin_override` source enum acceptance + the slot-0043 audit trigger's `COALESCE(NEW.created_by, NEW.participant_id)` derivation) and does NOT invoke supersede. Their test plans (`plan(5)` + `plan(4)` = 9 planned assertions) are expected to all report `ok` against the current SP body.
- **4 of 6 T026 + T027 US3-new tests are RED-by-contract** until T029 ships the supersede UPDATE+INSERT branch at on-disk slot **0048** (per D-016):
  - `submit_final_prediction_update_supersedes.sql` (pgTAP, `plan(8)` = 8 assertions);
  - `slice-004-submit-update-supersedes.spec.ts` (Playwright, 1 test);
  - `slice-004-submit-identical-champ-runner.spec.ts` (Playwright, 1 test — listed as likely-GREEN at runtime in the table above, but conservatively counted here as part of the supersede-dependent set in case runtime exec surfaces a contract drift); and
  - `slice-004-me-final-predictions-after-supersede.spec.ts` (Playwright, 1 test — the T014 `test.fixme`-removal).
- **Carry-forward from Phase 4**: 1 pgTAP file (CF-1 — `submit_final_prediction_serializes_concurrent.sql`) flips GREEN purely from T029. 1 Playwright spec (CF-2 — `slice-004-submit-concurrent-tabs.spec.ts`) needs a CODE revision in T030 (`[200, 409]` → `[200, 200]`) post-T029; it is NOT flipped by T029 alone.
- **Total assertions that flip GREEN solely from T029 shipping**: 8 (US3 pgTAP file #1) + 3 Playwright test bodies (US3 specs #1, #2, #3) + 1 (CF-1 pgTAP) = **12 assertions / 5 test files** that flip on T029 alone. (The Playwright concurrent-tabs CF-2 is a separate code edit at T030; it is NOT in this count.)

---

## Implementation note — RED state inferred, not observed (TDD caveat)

In this session (2026-05-20, Auto mode, Docker daemon down + Deno not installed), the RED tests T026 + T027 were authored and the matching GREEN-implementation tasks T029 (`supabase/migrations/0048_submit_final_prediction_supersede.sql`) and T030 (refactor + carry-forward revision) **may be authored in the same agentic session** without an intervening Docker-based run to *observe* the RED state of any of the 6 test files. The expected status in the tables above is inferred from contract reading — the SP body at slot 0044, the route handler in T018, the slot-0043 audit trigger, the slice-004 fixture seed at slot 0047, and the test files themselves were all read end-to-end. None of the conclusions are transcripts of an actual test run.

**This means the user MUST manually verify the predicted distribution before merging Slice 004.** The recipe mirrors the US1 + US2 gates: stash the GREEN implementation files (the migration at slot 0048 + the T030 test edit), run the verification commands below, observe every RED test fail for the documented reason, restore the stash, re-run, observe every test pass. Per-file paths to stash will be enumerated in the slice's `regression-final.md` (T035) once T029 + T030 ship.

If any test in the "RED-by-contract" set comes up GREEN *before* the stash-restore, that test is not actually gating the implementation it claims to gate. Stop and investigate before proceeding.

---

## Verification commands (run once Docker is up)

From the repo root on branch `004-final-predictions`:

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all slice-004 migrations through slot 0047
#    (per D-016 renumber; T029 will add slot 0048 on top) and loads slice 001..004
#    seed fixtures.
supabase db reset

# 3. Run each US3 pgTAP test file individually. The 3 T026 files + 1 Phase-4
#    carry-forward file (#11 from T021).
$us3 = @(
  'submit_final_prediction_update_supersedes.sql',
  'submit_final_prediction_identical_champion_runner_up.sql',
  'submit_final_prediction_admin_override.sql',
  'submit_final_prediction_serializes_concurrent.sql'  # CF-1 from Phase 4
)
foreach ($f in $us3) { supabase test db "supabase/tests/pgtap/$f" }

# 4. Run the US3 Playwright suite, scoped to slice 004. The @slice-004 + @us3
#    tags are applied by T027 via test.describe annotations; the after-supersede
#    file additionally carries @us1.
pnpm -F web e2e -- --grep '@slice-004 @us3'

# 5. (Optional) Typecheck the web app — catches any contract-shape drift between
#    the locally-declared response types in the specs and the route handlers.
pnpm -F web exec tsc --noEmit
```

**Pass criteria for the Phase-5 PRE-T029 RED run** (the gate this document is for):

- 2 of 3 T026 pgTAP files report `ok` for every planned assertion (9 of 17 planned assertions pass — files #2 and #3).
- 1 T026 pgTAP file (`submit_final_prediction_update_supersedes.sql`) reports plan-vs-run mismatch or 23505 error on the 2nd SP call. This is **expected RED** until T029 lands.
- 1 carry-forward pgTAP file (`submit_final_prediction_serializes_concurrent.sql`) reports plan-vs-run mismatch or 23505 error (also expected RED until T029, documented in `red-gate-us2.md`).
- Among the 3 T027 Playwright specs, the supersede + after-supersede specs (#1 + #3) fail on the 2nd-POST 200 assertion (returns 409 ALREADY_SUBMITTED instead). The identical-champ-runner spec (#2) is likely-GREEN at runtime (no supersede invoked); if it surfaces RED, investigate envelope-shape drift in T018's WFP06 → 409 mapping.
- `pnpm -F web exec tsc --noEmit` is clean (optional sanity).

**Pass criteria for the Phase-5 POST-T029+T030 GREEN run**:

- All 3 T026 pgTAP files report `ok` for every planned assertion (17/17).
- The carry-forward pgTAP file (CF-1) also reports `ok` for `plan(1)` (exactly one active row after two sequential submits).
- All 3 T027 Playwright tests report `passed`.
- The carry-forward Playwright spec (CF-2 — `slice-004-submit-concurrent-tabs.spec.ts`) reports `passed` AFTER T030's `[200, 409]` → `[200, 200]` edit; pre-T030 it fails on the status-pair assertion even though the SP semantics are correct.

If both criteria hold (RED-then-GREEN with the stash-and-restore recipe), the Principle IX gate is observationally satisfied for US3 and Slice 004 Phase 5 is cleared to advance to Phase 6 (regression + cross-link).

---

## Inherited spec deviations

Slice 004 US3 inherits **D-001 through D-017** unchanged from `red-gate-us1.md` + `red-gate-us2.md`. The deviations most directly relevant to US3 are:

- **D-014** (slice 003) — Supersede self-reference placeholder pattern. T029 follows the same convention: the OLD row's `superseded_by` is UPDATEd to point at the NEW row's id within the same transaction; the new INSERT itself does not need a forward pointer.
- **D-016** (slice 004) — Slot renumber: T029's supersede migration lands at on-disk slot **0048** (the spec's slot 0045 was renumbered for the audit-trigger + the +3 cascading shift). The 3 T026 pgTAP files + 3 T027 Playwright specs reference function names only — no test-file edits required for the slot renumber.
- **D-017** (slice 004) — `tournament_config.first_kickoff_utc` is admin-owned, seeded by the slice-004 fixture at slot 0047. Every T026 + T027 test relies on the fixture's future-dated kickoff (2026-06-16) so that `is_final_prediction_locked()` returns FALSE without per-test config manipulation. The identical-champion-runner-up test additionally mutates a DIFFERENT config key (`predictions.allow_identical_champion_runner_up`) — that key is independently seeded at slot 0047 and the test restores it in `afterEach`.

No new US3-specific deviations were surfaced during T026 + T027 authoring.

---

## Sign-off checklist (for the Slice 004 US3 PR section)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] 3 T026 pgTAP files run; 2 GREEN-now, 1 RED-as-expected (`submit_final_prediction_update_supersedes.sql` — flips GREEN with T029).
- [ ] 1 carry-forward pgTAP file (CF-1) run; reports RED-as-expected (flips GREEN with T029, no edit required).
- [ ] 3 T027 Playwright tests run; expected pre-T029 distribution observed (2 RED, 1 likely-GREEN — re-verify the identical-champ-runner spec if it surfaces RED).
- [ ] T029 ships migration `supabase/migrations/0048_submit_final_prediction_supersede.sql`; re-run all 4 pgTAP + 3 Playwright; all flip GREEN.
- [ ] T030 ships the one-line revision to `slice-004-submit-concurrent-tabs.spec.ts` (`[200, 409]` → `[200, 200]`); re-run that single spec; flips GREEN.
- [ ] Transcript or CI link recorded in the PR description.
- [ ] No test in the inventory was edited between this gate and the run (except T030's documented `[200, 409]` → `[200, 200]` revision in the carry-forward Playwright spec).
- [ ] PR description references this file by path: `specs/004-final-predictions/red-gate-us3.md`.
- [ ] File 11 (`submit_final_prediction_serializes_concurrent.sql`) RED-until-T029 status acknowledged explicitly (same caveat as in `red-gate-us2.md`).

Until every box above is ticked, Slice 004 US3 does not satisfy Constitution Principle IX and must not merge.
