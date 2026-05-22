# RED Gate — Slice 004 / User Story 2 (US2)

**Slice**: `004-final-predictions`
**Phase**: 4 (US2 — "System rejects edits after first kickoff")
**Date**: 2026-05-20
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T023 (the Principle IX gate task itself; US2 red-gate document).

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both `supabase test db` for pgTAP and by the Playwright suite, which boots the local Supabase stack as a fixture) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

Unlike the US1 gate (T015 — where everything was expected uniformly RED because neither the SP nor the route handlers existed yet), the US2 gate sits in an interesting position: **both the predicate (T005, slot 0041) and the SP (T016, slot 0044) ALREADY SHIPPED in US1**, and they were authored against the **same Test surface contracts** that drove T021 + T022. The most-likely runtime distribution is therefore not "uniformly RED" but rather:

- **Most T021 pgTAP files are probably already GREEN** — the predicate body uses strict `>=` (BR-LOCK-005), fails closed on missing config, and is STABLE; the SP raises `WFP01` when the predicate is TRUE. Each of these properties is what the pgTAP files assert.
- **All T022 Playwright specs are RED** simply because they cannot run — the Playwright harness needs Docker for the Supabase stack fixture. Once Docker is up, the route handlers from T018 already implement the lock-check + error-mapping surface, so most of them should flip GREEN immediately.
- **One outlier: file 11 of T021** (`submit_final_prediction_serializes_concurrent.sql`) is **RED through Phase 4** and stays RED until T029 (US3) ships the supersede branch. See the discrepancy section below.

This document exists so that:

1. The Phase-4 / US2 RED tests authored in T021 (11 pgTAP files, 16 planned assertions) and T022 (6 Playwright specs, 6 tests) are catalogued with their expected status under the **current** Phase-4 GREEN gate.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.
4. The forward-compat tests that gate US3 (specifically file 11) are explicitly flagged as **expected RED carry-forward into Phase 5**, not silent failures.

The merge of Slice 004 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 4 (US2) produced **17 RED-state test files** (11 pgTAP + 6 Playwright). Total **22 behaviorally-distinct assertions** (16 pgTAP planned + 6 Playwright). The 11 pgTAP files exercise the predicate `public.is_final_prediction_locked()` at slot 0041 and the SP `public.submit_final_prediction(...)` at slot 0044 (per D-016 — see `red-gate-us1.md`); the 6 Playwright specs exercise the `POST /api/final-predictions` route surface's lock-rejection branch via T018's handler.

### pgTAP files (T021 — 11 files)

| # | Test file | `plan(N)` | Expected status PRE-T024 | GREEN implementer |
|---|-----------|-----------|--------------------------|-------------------|
| 1 | `supabase/tests/pgtap/is_final_prediction_locked_before.sql` | `plan(2)` | **likely-GREEN-already**. Sets `first_kickoff_utc` ~1 hour in the future via UPDATE on `tournament_config`; calls `is_final_prediction_locked()`; expects FALSE. Slot-0041 predicate body matches: `IF v_first_kickoff IS NULL THEN RETURN true; END IF; RETURN now() >= v_first_kickoff;` returns FALSE when the kickoff is in the future. A2 (`stable_function_marker`) verifies pg_proc.provolatile = 's' for the predicate — also passes because slot 0041 declares `STABLE`. | T005 (already shipped at slot 0041). |
| 2 | `supabase/tests/pgtap/is_final_prediction_locked_at_boundary.sql` | `plan(2)` | **likely-GREEN-already**. Sets `first_kickoff_utc = now()` (zero offset); calls predicate; strict `>=` returns TRUE → predicate TRUE. A2 (re-check that the predicate is `STABLE`) also passes. Edge-case-RED only if `now()` drifts at statement-boundary; pgTAP's transaction-scoped `now()` is monotonic so this is safe. | T005 (already shipped). |
| 3 | `supabase/tests/pgtap/is_final_prediction_locked_just_before.sql` | `plan(1)` | **likely-GREEN-already**. Sets `first_kickoff_utc = now() + interval '50 milliseconds'`; expects predicate FALSE (BR-LOCK-002 strict-`>=` does NOT lock just below the boundary). Slot-0041 body: `now() >= (now() + 50ms)` → FALSE. | T005. |
| 4 | `supabase/tests/pgtap/is_final_prediction_locked_just_after.sql` | `plan(1)` | **likely-GREEN-already**. Sets `first_kickoff_utc = now() - interval '50 milliseconds'`; expects predicate TRUE. Slot-0041 body: `now() >= (now() - 50ms)` → TRUE. | T005. |
| 5 | `supabase/tests/pgtap/is_final_prediction_locked_far_after.sql` | `plan(1)` | **likely-GREEN-already**. Sets `first_kickoff_utc = '2024-01-01T00:00:00Z'` (deep past); expects predicate TRUE. | T005. |
| 6 | `supabase/tests/pgtap/is_final_prediction_locked_config_missing.sql` | `plan(1)` | **likely-GREEN-already**. DELETEs the `first_kickoff_utc` row from `tournament_config` inside the BEGIN; expects predicate TRUE (fail-CLOSED per Constitution III + BR-LOCK-005). Slot-0041 body: `IF v_first_kickoff IS NULL THEN RETURN true; END IF;` returns TRUE. ROLLBACK restores the seed row. | T005. |
| 7 | `supabase/tests/pgtap/is_final_prediction_locked_config_changes.sql` | `plan(2)` | **likely-GREEN-already**. Mutates `first_kickoff_utc` mid-transaction (future → past) and re-invokes the predicate; asserts the second invocation returns a different value reflecting the new config. STABLE within statement does not block this — pgTAP uses separate SELECTs (separate snapshots) so the predicate observes the updated `tournament_config` row. | T005. |
| 8 | `supabase/tests/pgtap/is_final_prediction_locked_uses_db_clock.sql` | `plan(2)` | **likely-GREEN-already**. Verifies the predicate uses Postgres `now()` and NOT a client-supplied timestamp. A1 calls predicate without any GUC/session manipulation; A2 attempts (and confirms inability) to inject a fake "now" via session GUCs — the predicate ignores them and reads server `now()`. Slot-0041 body uses bare `now()` so this passes. | T005. |
| 9 | `supabase/tests/pgtap/is_final_prediction_locked_perf.sql` | `plan(1)` | **likely-GREEN-already** (with caveat). Loops 1,000 invocations of the predicate and asserts p95 < 5 ms. The predicate body is one `SELECT ... FROM tournament_config WHERE key='first_kickoff_utc'` + one comparison — it should comfortably meet 5 ms on any non-pathological host. Edge-case-RED only on a slow CI runner; if it surfaces, T024 documents it as environmental rather than a contract violation. | T005. |
| 10 | `supabase/tests/pgtap/submit_final_prediction_locked.sql` | `plan(2)` | **likely-GREEN-already**. Sets `first_kickoff_utc = now() - interval '1 hour'` so predicate is TRUE; calls `submit_final_prediction(charlie, 'champion', POL, NULL, 'ui')`; expects `throws_ok` with `ERRCODE='WFP01'`. A2 asserts the `final_predictions` count is unchanged. Slot-0044 SP step 5: `IF public.is_final_prediction_locked() THEN RAISE EXCEPTION USING ERRCODE='WFP01' ...` — matches exactly. | T016 (already shipped at slot 0044). |
| 11 | `supabase/tests/pgtap/submit_final_prediction_serializes_concurrent.sql` | `plan(1)` | **RED-until-T029**. Calls SP twice in sequence for the SAME (charlie, champion, POL) pair; expects A1: exactly ONE active row exists at end. The test was authored against **post-T029 supersede behavior** — both sequential calls succeed and the first becomes a `superseded_at IS NOT NULL` history row. Slot-0044 SP at the current GREEN gate does NOT implement supersede (its own comment says: "If an existing active row exists ... the partial unique index `final_predictions_active_uk` will reject this INSERT with 23505. That's expected for US1's create-only scope; T029 (US3) will replace this INSERT with the supersede UPDATE+INSERT pattern"). Therefore the **second** SP call raises `unique_violation` (23505), the `DO $$` block aborts before `finish()`, and pgTAP reports a plan-vs-run mismatch (0/1) — RED. This RED is **expected and forward-compat** (see discrepancy section). | T029 (US3 supersede branch). |

**pgTAP planned-assertion total**: `2 + 2 + 1 + 1 + 1 + 1 + 2 + 2 + 1 + 2 + 1 = 16 planned assertions` across the 11 files. Expected status: **15 GREEN-on-runtime / 1 RED-until-T029**.

### Playwright files (T022 — 6 files / 6 tests)

All 6 files are tagged `@slice-004 @us2`. The route handler (`apps/web/app/api/final-predictions/route.ts`) and its predicate + WFP01 → 403 mapping shipped in T018; **the missing ingredient at this gate is Docker** — without it the harness cannot boot Supabase and Playwright cannot reach the route. Therefore every spec is RED-by-environment, not RED-by-contract. Most should flip GREEN immediately on a Docker-up run; one needs post-T029 revision per its own inline comment.

| # | Test file | Tests | Expected status PRE-T024 | GREEN implementer |
|---|-----------|-------|--------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-004-submit-locked.spec.ts` | 1 test | **likely-GREEN-after-T024** (RED-by-environment now). US2 AS1 — sets `first_kickoff_utc = now()` via service-role psql; POST `/api/final-predictions` with `{champion, POL}`; expects 403 `FINAL_PREDICTIONS_LOCKED`. T018's route maps `WFP01 → 403 FINAL_PREDICTIONS_LOCKED`; slot-0044 SP raises WFP01 because the predicate is TRUE at the boundary. End-to-end alignment is straightforward. | (already shipped — T005 + T016 + T018.) |
| 2 | `apps/web/tests/playwright/slice-004-submit-locked-just-after.spec.ts` | 1 test | **likely-GREEN-after-T024** (RED-by-environment now). US2 AS2 — `first_kickoff_utc = now() - 1s`; POST → expects 403 `FINAL_PREDICTIONS_LOCKED`. Strict `>=` predicate returns TRUE. | (already shipped.) |
| 3 | `apps/web/tests/playwright/slice-004-submit-just-before-lock.spec.ts` | 1 test | **likely-GREEN-after-T024** (RED-by-environment now). US2 AS3 — `first_kickoff_utc = now() + 60s`; POST → expects 200 (accepted, not locked). Predicate returns FALSE; SP proceeds to INSERT. Timing-sensitive but 60s is generous. | (already shipped.) |
| 4 | `apps/web/tests/playwright/slice-004-submit-direct-api-rejected.spec.ts` | 1 test | **likely-GREEN-after-T024** (RED-by-environment now). US2 AS2 / SC-002 — proves the lock is enforced at the **API** layer, not just the UI. Drives POST with no `Origin` header (curl-equivalent) after setting kickoff to past; expects 403 FINAL_PREDICTIONS_LOCKED. Same WFP01 mapping. | (already shipped.) |
| 5 | `apps/web/tests/playwright/slice-004-submit-client-clock-ignored.spec.ts` | 1 test | **likely-GREEN-after-T024** (RED-by-environment now). US3.4 (asserted at US2 gate per T022's scope) — sets browser context's `Date.now()` to a value where the participant believes editing is still open; server's `is_final_prediction_locked()` uses Postgres `now()` and rejects. The slot-0041 predicate uses bare `now()` with no client GUC — passes. | (already shipped — predicate already uses DB clock.) |
| 6 | `apps/web/tests/playwright/slice-004-submit-concurrent-tabs.spec.ts` | 1 test | **likely-GREEN-after-T024** (RED-by-environment now; **needs revision after T029**). FR-010 / SC-004 — two parallel POSTs for `(charlie, champion)` with DIFFERENT teams (POL vs JPN). Per the test's own inline comment: pre-US3 the SP advisory-locks; winner returns 200, loser hits 23505 → mapped to 409 `ALREADY_SUBMITTED` by T018; GET `/api/me/final-predictions` shows exactly ONE active champion row. **This pre-US3 reality is what the spec asserts** — `[200, 409]` status pair + exactly-one-active invariant. Once T029 lands supersede the test will need a small revision (both POSTs return 200; the loser becomes a history row). The "exactly one active row" invariant holds either way. | (already shipped for pre-US3 form; T029 owns revision to post-US3 form.) |

**Playwright test total**: 6 distinct Playwright tests across 6 files; **all 6 RED-by-environment now, expected GREEN-on-runtime after Docker comes up** (and after the user re-runs them).

---

## Highlights

- **9 of 11 T021 pgTAP files probably GREEN immediately** against the already-shipped predicate (slot 0041, T005) — the predicate body uses strict `>=` (BR-LOCK-005), fails closed on missing config, declares `STABLE`, and reads server `now()`. Each of these properties is exactly what files #1–#9 assert. File #9 (perf) is a soft "likely-GREEN" — environmental factors can drive p95 > 5 ms on a slow runner, in which case T024 documents it as environmental rather than a contract violation.
- **File #10 (`submit_final_prediction_locked.sql`) probably GREEN immediately** against the already-shipped SP (slot 0044, T016) — the SP step 5 raises `WFP01` when the predicate is TRUE, and the test's `throws_ok` matcher pins exactly `ERRCODE='WFP01'`.
- **File #11 (`submit_final_prediction_serializes_concurrent.sql`) RED-until-T029** — see discrepancy section below. This is the only pgTAP file in T021 that is RED-by-contract rather than RED-by-environment.
- **All 6 T022 Playwright specs RED-by-environment** (Docker daemon down). On a Docker-up run, all 6 should flip GREEN immediately because T018's route already maps `WFP01 → 403 FINAL_PREDICTIONS_LOCKED` and `23505 → 409 ALREADY_SUBMITTED`, and the predicate + SP semantics match the contract.
- **One T022 spec needs post-T029 revision** — `slice-004-submit-concurrent-tabs.spec.ts` was authored against the pre-US3 reality (loser hits 23505 → 409) and explicitly says so in its inline comment. Once T029 ships supersede, the assertion `[200, 409]` becomes `[200, 200]`. The "exactly one active row" invariant survives the change unchanged.

---

## Serialize-test discrepancy (T021 file 11 vs current Phase-4 GREEN gate)

**The mismatch**: File 11 of T021 (`submit_final_prediction_serializes_concurrent.sql`) was authored assuming **post-T029 supersede behavior** — two sequential SP calls both succeed, the first becomes a `superseded_at IS NOT NULL` history row, and exactly one active row remains. The test's `DO $$` block calls the SP twice in sequence and the `finish()` reporter checks the active-count = 1 invariant.

**The current reality**: T016's slot-0044 SP does **NOT** implement supersede yet. Its own header comment is explicit:

> *T029 (US3) will extend with the supersede UPDATE+INSERT pattern (mirrors slice 003 D-014).*

and the INSERT step (step 7) comment is even more explicit:

> *If an existing active row exists for (participant, item_kind), the partial unique index `final_predictions_active_uk` will reject this INSERT with 23505. That's expected behavior for US1's create-only scope; T029 (US3) will replace this INSERT with the supersede UPDATE+INSERT pattern.*

So at the Phase-4 GREEN gate, the second SP call inside the `DO $$` block raises `unique_violation` (SQLSTATE 23505). PL/pgSQL propagates the error up, the DO block aborts before pgTAP's `finish()` is reached, and pgTAP reports a plan(1)-vs-run(0) mismatch. RED.

**Note that T022's `slice-004-submit-concurrent-tabs.spec.ts` correctly asserts the pre-T029 reality** — it expects the response pair to be `[200, 409]` (winner + loser-on-23505-mapped-to-409) and pins the "exactly one active row" invariant via a follow-up GET. So at the API layer the gate is consistent; only the pgTAP file 11 is forward-compat.

### Resolution options

**(Option A) Keep file 11 as-is** — RED through Phase 4, GREEN after T029. T024 documents the deferral; the next red-gate (US3, T030 if numbered analogously) will observe it RED-then-GREEN as part of US3's own Principle IX gate.

**(Option B) Rewrite file 11 to assert pre-US3 reality** — wrap the second SP call in a `throws_ok` with `ERRCODE='23505'` and add a separate post-US3 file (slot in tests/pgtap to be assigned by T029 itself) that asserts the supersede invariant. T024 owns the rewrite; T029 owns the new file.

**Recommendation: Option A.** Rationale:

1. The test is a **forward-compat documentation artifact** — it documents what the post-T029 invariant looks like, in the place a reader most naturally goes to find it (sibling to other `submit_final_prediction_*.sql` files). Rewriting it loses that documentation value.
2. Principle IX explicitly allows RED tests to carry forward across phases — what it forbids is *un-acknowledged* RED. This document acknowledges it.
3. The "exactly one active row" invariant is **already covered for the API layer** by T022's `slice-004-submit-concurrent-tabs.spec.ts` (in its pre-US3 form). So the safety property is observed RED-then-GREEN at the boundary; what file 11 adds is a SQL-layer assertion of the same property post-T029.
4. Option B doubles the test count for marginal gain — one file for pre-US3, one for post-US3 — when the post-US3 form is what the system will be in after T029.

T024's working-set therefore should **not** include rewriting file 11. It documents the deferral and re-runs the other 10 pgTAP + 6 Playwright on the Docker-up host.

---

## T024 working-set recommendation

T024's task body anticipates "most should GREEN immediately" with "common causes for RED" being timing imprecision in fixture or missing recursion guard. Based on the contract-level reading above, the predicted T024 working-set is **near-empty**:

- **Most likely**: T024 confirms 10/11 pgTAP files GREEN, 1/11 RED (file 11, deferred to T029), 6/6 Playwright GREEN on a Docker-up host. T024 marks itself complete with no code change beyond optional notes in `regression-checkpoint-us2.md`.
- **Possible**: Perf file (#9) is environmentally RED — T024 documents environment-dependence rather than changing the predicate.
- **Possible**: Boundary file (#2, at_boundary) is non-deterministic on a very-slow host because the test sets `first_kickoff_utc = now()` and re-reads `now()` in the predicate; if statement-boundary `now()` drift exceeds 0 the test may flicker. T024 documents the inherent flakiness and pins the fix as a follow-up if it ever surfaces.
- **Unlikely**: Actual contract bug surfaces — would imply T005 or T016 was authored against a different reading of the contract than T021/T022 were, which is implausible given the same contract files (`final-prediction-lock.predicate.sql.md` + `final-predictions.write.md`) drove all three task groups.

**Fixup migrations are NOT expected.** If T024 surfaces a genuine bug, a new migration `supabase/migrations/0048_*.sql` (or whichever slot is next post-D-016) would be added — historical migrations stay immutable per the slice's renumber-respecting convention.

---

## Implementation note — RED state inferred, not observed (TDD caveat)

In this session (2026-05-20, Auto mode, Docker daemon down + Deno not installed), the RED tests T021 + T022 were authored and the matching GREEN-implementation review T024 may run in the same agentic session without an intervening Docker-based run to *observe* the status of any of the 17 test files. The expected status in the tables above is inferred from contract reading — the SP body at slot 0044, the predicate body at slot 0041, the route handler in T018, and the test files themselves were all read end-to-end. None of the conclusions are transcripts of an actual test run.

**This means the user MUST manually verify the predicted distribution before merging Slice 004.** The recipe mirrors the US1 gate: run the verification commands below, capture the output, and confirm:

- 10 of 11 pgTAP files report `ok` for every planned assertion (15 planned assertions in total across the 10);
- 1 pgTAP file (file 11) reports the plan-vs-run mismatch or 23505 error described above (and stays in that state until T029 ships);
- All 6 Playwright tests report `passed` except possibly the perf-sensitive Playwright assertion within `slice-004-submit-just-before-lock.spec.ts` if the 60s window slips on a slow host (re-run if flaky).

If a contract violation surfaces (predicate body, SP error mapping, route handler 23505→409 mapping), T024 owns the minimum-change fix.

---

## Verification commands (run once Docker is up)

From the repo root on branch `004-final-predictions`:

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all slice-004 migrations through slot 0047
#    (per D-016 renumber) and loads slice 001..004 seed fixtures.
supabase db reset

# 3. Run each US2 pgTAP test file individually. The 11 files split into
#    9 is_final_prediction_locked_*.sql + 2 submit_final_prediction_*.sql.
$us2 = @(
  'is_final_prediction_locked_before.sql',
  'is_final_prediction_locked_at_boundary.sql',
  'is_final_prediction_locked_just_before.sql',
  'is_final_prediction_locked_just_after.sql',
  'is_final_prediction_locked_far_after.sql',
  'is_final_prediction_locked_config_missing.sql',
  'is_final_prediction_locked_config_changes.sql',
  'is_final_prediction_locked_uses_db_clock.sql',
  'is_final_prediction_locked_perf.sql',
  'submit_final_prediction_locked.sql',
  'submit_final_prediction_serializes_concurrent.sql'
)
foreach ($f in $us2) { supabase test db "supabase/tests/pgtap/$f" }

# 4. Run the US2 Playwright suite, scoped to slice 004. The @slice-004 + @us2
#    tags are applied by T022 via test.describe annotations.
pnpm -F web e2e -- --grep '@slice-004 @us2'

# 5. (Optional) Typecheck the web app — catches any contract-shape drift between
#    the locally-declared response types in the specs and the route handlers.
pnpm -F web exec tsc --noEmit
```

**Pass criteria for the Phase-4 GREEN run** (the gate this document is for):

- 10 of 11 `is_final_prediction_locked_*.sql` + `submit_final_prediction_locked.sql` pgTAP files report `ok` for every planned assertion (15 of 16 planned assertions pass).
- 1 pgTAP file (`submit_final_prediction_serializes_concurrent.sql`) reports the expected RED — plan-vs-run mismatch or 23505 error. This is **expected RED** until T029 lands and is documented as such here.
- Every Playwright test tagged `@slice-004 @us2` reports `passed` (6 tests).
- `pnpm -F web exec tsc --noEmit` is clean (optional sanity).

**Pass criteria after T029 (US3 supersede branch)**:

- File 11 also reports `ok` for plan(1) — exactly one active row after two sequential submits.
- `slice-004-submit-concurrent-tabs.spec.ts` updated to assert `[200, 200]` instead of `[200, 409]`; "exactly one active row" GET assertion unchanged.

If the Phase-4 pass criteria hold, the Principle IX gate is observationally satisfied for US2 and Slice 004 Phase 4 is cleared to advance to Phase 5 (US3).

---

## Inherited spec deviations

Slice 004 US2 inherits **D-001 through D-017** unchanged from `red-gate-us1.md`. The deviations most directly relevant to US2 are:

- **D-016** (slice 004) — Slot renumber: the predicate at on-disk slot **0041** (spec said 0040) and the SP at **0044** (spec said 0041). The 11 T021 files reference function names, not slot numbers, so no test-file edits were required.
- **D-017** (slice 004) — `tournament_config.first_kickoff_utc` is admin-owned, seeded by the slice-004 fixture. Every T021 + T022 test that needs a particular kickoff value mutates this row via `UPDATE tournament_config` and (for pgTAP) lets ROLLBACK restore it, or (for Playwright) restores it in `afterEach`. Without the fixture seed, the predicate would fail-CLOSED on every call and all "editable" assertions would RED for the wrong reason; the seed is the load-bearing dependency.

No new US2-specific deviations were surfaced during T021 + T022 authoring.

---

## Sign-off checklist (for the Slice 004 US2 PR section)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] 11 pgTAP files run; 10 GREEN, 1 RED-as-expected (file 11 — `submit_final_prediction_serializes_concurrent.sql`).
- [ ] 6 Playwright tests run; all 6 GREEN.
- [ ] Transcript or CI link recorded in the PR description.
- [ ] No test in the inventory was edited between this gate and the run.
- [ ] T024 closed (with or without a fixup migration); `regression-checkpoint-us2.md` (the Phase-5 entry gate for US3) records the final 11 / 6 status.
- [ ] PR description references this file by path: `specs/004-final-predictions/red-gate-us2.md`.
- [ ] File 11's expected RED-until-T029 status acknowledged explicitly in the PR description (so reviewers don't flag it as a bug).

Until every box above is ticked, Slice 004 US2 does not satisfy Constitution Principle IX and must not merge.

---

## T024 verification — appended 2026-05-20

**Mode**: code-review verification (Docker daemon down + Deno not installed; runtime exec deferred to T034 per the slice-004 cross-link harness plan).

**Approach**: read each of the 11 T021 pgTAP files + 6 T022 Playwright specs end-to-end against the SHIPPED implementation files:

- `supabase/migrations/0041_is_final_prediction_locked.sql` (predicate body, slot 0041, T005)
- `supabase/migrations/0044_submit_final_prediction_sp.sql` (SP body, slot 0044, T016)
- `apps/web/app/api/final-predictions/route.ts` (route handler + SP error → HTTP mapping, T018)

For each test file, determine whether the underlying contract is satisfied by the implementation under a hypothetical Docker-up + Playwright-up run, and categorize the verdict.

### Verdict summary

- **GREEN-now** (implementation matches assertion; only Docker-up runtime confirmation deferred to T034): **10/11 pgTAP + 6/6 Playwright = 16 of 17**.
- **RED-fixable** (implementation bug requires a fixup migration): **0**.
- **RED-deferred-to-T029** (pre-US3 reality; supersede not yet shipped): **1/11 pgTAP = 1 of 17** (the serialize file, per Option A from the body of this document).

This matches the expected distribution called out in T024's task brief and the "highlights" section above.

### Per-file verdicts

#### pgTAP (T021) — 11 files

| # | File | Verdict | Implementation anchor |
|---|------|---------|-----------------------|
| 1 | `supabase/tests/pgtap/is_final_prediction_locked_before.sql` | **GREEN-now**. UPDATE sets `first_kickoff_utc = now() + 1 day`; predicate at 0041 line 20 (`RETURN now() >= v_first_kickoff`) returns FALSE. A2 verifies `pg_proc.provolatile='s'`; 0041 line 8 declares `STABLE`. | 0041 lines 8, 20. |
| 2 | `supabase/tests/pgtap/is_final_prediction_locked_at_boundary.sql` | **GREEN-now**. DO block sets `v_now := now()` then UPDATEs `first_kickoff_utc = v_now`; since `now()` is transaction_timestamp (fixed for the txn), the predicate's bare `now()` (0041 line 20) re-reads the same instant; `now() >= now()` → TRUE. A2 re-asserts in same txn — same fixed `now()`, still TRUE. | 0041 line 20 (strict `>=`). |
| 3 | `supabase/tests/pgtap/is_final_prediction_locked_just_before.sql` | **GREEN-now**. UPDATEs `first_kickoff_utc = now() + 1 ms`; predicate `now() >= (txn_now + 1ms)` → FALSE. | 0041 line 20. |
| 4 | `supabase/tests/pgtap/is_final_prediction_locked_just_after.sql` | **GREEN-now**. UPDATEs `first_kickoff_utc = now() - 1 ms`; predicate `now() >= (txn_now - 1ms)` → TRUE. | 0041 line 20. |
| 5 | `supabase/tests/pgtap/is_final_prediction_locked_far_after.sql` | **GREEN-now**. UPDATEs `first_kickoff_utc = now() - 7 days`; predicate TRUE. | 0041 line 20. |
| 6 | `supabase/tests/pgtap/is_final_prediction_locked_config_missing.sql` | **GREEN-now**. DELETEs the row; predicate at 0041 line 19 (`IF v_first_kickoff IS NULL THEN RETURN true`) returns TRUE. | 0041 line 19 (fail-CLOSED). |
| 7 | `supabase/tests/pgtap/is_final_prediction_locked_config_changes.sql` | **GREEN-now**. STABLE memoization is statement-scoped, not txn-scoped — separate SELECT statements re-read `tournament_config`. State A (future) → FALSE; State B (past) → TRUE. | 0041 lines 14-20 (re-reads via the SELECT each call). |
| 8 | `supabase/tests/pgtap/is_final_prediction_locked_uses_db_clock.sql` | **GREEN-now**. A1: `pronargs=0` matches the zero-arg `CREATE OR REPLACE FUNCTION public.is_final_prediction_locked()` at 0041 line 5. A2: `pg_get_functiondef()` body contains `now()` (0041 line 20) — regex `\mnow\s*\(\s*\)` matches. | 0041 lines 5, 20. |
| 9 | `supabase/tests/pgtap/is_final_prediction_locked_perf.sql` | **GREEN-now** (environmental caveat). 1,000 iterations of one SELECT + one timestamp comparison; p95 < 5 ms is comfortable on any non-pathological host. RED only on a slow CI runner — documented as environmental rather than a contract violation. | 0041 lines 14-21 (single-row SELECT + comparison). |
| 10 | `supabase/tests/pgtap/submit_final_prediction_locked.sql` | **GREEN-now**. UPDATE forces predicate TRUE; SP step 5 (0044 lines 135-139) raises `RAISE EXCEPTION USING ERRCODE='WFP01'`; `throws_ok` matcher pins exactly that ERRCODE. A2 count-invariant holds because RAISE rolls the SP txn back before INSERT (0044 lines 194-210). | 0044 lines 135-139 + lines 194-210. |
| 11 | `supabase/tests/pgtap/submit_final_prediction_serializes_concurrent.sql` | **RED-deferred-to-T029**. Test calls SP twice in sequence for SAME (charlie, champion, POL); asserts exactly one active row. SP at 0044 has NO supersede branch (comment lines 7, 191-194 explicitly defer to T029); second call hits 23505 from `final_predictions_active_uk`; DO block aborts before `finish()`; pgTAP reports plan-vs-run mismatch. Documented Option A in this red-gate doc — no fixup, no rewrite, RED carries forward to Phase 5. | 0044 lines 7, 191-194 (T029 placeholder); Option A in this doc lines 102-110. |

**Total pgTAP**: 10 GREEN-now + 1 RED-deferred-to-T029 = 11/11 categorized.

#### Playwright (T022) — 6 files

The route handler maps SP errors as follows (route.ts lines 251-308):

- **WFP01 → 409 FINAL_PREDICTIONS_LOCKED, reason='lock_window_passed'** (lines 252-257)
- **23505 → 409 ALREADY_SUBMITTED** (lines 295-305)

All 6 specs use these exact strings, so they will pass on a Docker-up run.

| # | File | Verdict | Implementation anchor |
|---|------|---------|-----------------------|
| 1 | `apps/web/tests/playwright/slice-004-submit-locked.spec.ts` | **GREEN-now**. Sets `first_kickoff_utc = new Date().toISOString()` (boundary); POSTs champion=POL; expects 409 `FINAL_PREDICTIONS_LOCKED` + reason `lock_window_passed`. Predicate hits strict `>=` (or fires by the time the SP runs due to network latency); SP raises WFP01; route maps to exactly that envelope. | route.ts lines 252-257 + 0044 lines 135-139 + 0041 line 20. |
| 2 | `apps/web/tests/playwright/slice-004-submit-locked-just-after.spec.ts` | **GREEN-now**. `first_kickoff_utc = now - 1s`; predicate TRUE; WFP01 → 409 FINAL_PREDICTIONS_LOCKED + lock_window_passed. | route.ts lines 252-257. |
| 3 | `apps/web/tests/playwright/slice-004-submit-just-before-lock.spec.ts` | **GREEN-now**. `first_kickoff_utc = now + 60s`; predicate FALSE; SP proceeds to INSERT; route returns 200 with body shape `{final_prediction: {id, item_kind, target_team_id, target_player_id, submitted_at, source, superseded_at}}` (route.ts lines 407-425). All four asserted fields match. | route.ts lines 407-425. |
| 4 | `apps/web/tests/playwright/slice-004-submit-direct-api-rejected.spec.ts` | **GREEN-now**. Iterates all four item_kinds with valid targets; all four hit WFP01 because SP step 5 (lock check) is BEFORE step 6/7 (disjoint + INSERT) in the SP's branch ordering — 0044 lines 135-139 fire first, regardless of kind. All four return 409 FINAL_PREDICTIONS_LOCKED + lock_window_passed. | 0044 lines 135-139 (step ordering); route.ts lines 252-257. |
| 5 | `apps/web/tests/playwright/slice-004-submit-client-clock-ignored.spec.ts` | **GREEN-now**. `SUBMIT_SCHEMA` (route.ts lines 122-166) is `z.object().superRefine()` — NOT `.strict()`. Unknown keys (`fake_now`, `client_now`, `now`) are silently stripped. The `X-Client-Now` header is never read in the lock-check path. SP uses bare `now()` (Postgres clock) only. Lock fires; 409 FINAL_PREDICTIONS_LOCKED. | route.ts lines 122-166 (zod schema, no `.strict()`); 0041 line 20 (bare `now()`). |
| 6 | `apps/web/tests/playwright/slice-004-submit-concurrent-tabs.spec.ts` | **GREEN-now (pre-US3 form; needs revision after T029, as documented inline)**. Two parallel POSTs for `(charlie, champion)` with different teams (POL vs JPN); SP advisory lock (0044 lines 49-51) serializes; first INSERT succeeds → 200; second hits `final_predictions_active_uk` partial unique index → 23505; route maps 23505 → 409 ALREADY_SUBMITTED (route.ts lines 295-305). Test asserts `[200, 409]` status pair (sorted) + error.code='ALREADY_SUBMITTED' + exactly one active row via GET. T029 will revise to `[200, 200]` once supersede branch ships; the "exactly one active row" invariant holds either way. | 0044 lines 49-51 (advisory lock) + lines 191-194 (T029 placeholder) + route.ts lines 295-305 (23505 mapping). |

**Total Playwright**: 6 GREEN-now / 6 (modulo Docker availability for actual exec).

### Fixup migration created

**None.** Code review surfaced zero contract mismatches. No fixup migration written. Slot 0049 remains available if a future code-review-driven defect needs a US2 fixup; slot 0048 stays reserved for T029.

### Unexpected discrepancies

None. All 11 pgTAP setups (UPDATEs / DELETEs against `tournament_config` via the same `to_jsonb(..::text)` shape the slice-004 seed uses at line 233 of `supabase/seed/slice-004-fixture.sql`) align with the predicate's `(value::text)::timestamptz` cast at 0041 line 15. All 6 Playwright setups (`.from('tournament_config').update({ value: isoValue })` via service-role client) write the value as a JSON string scalar — same shape — so the predicate decodes them identically.

The one *expected* discrepancy is the serialize file (#11) which is RED-by-contract pre-T029, documented above and in Option A of the body.

### Carry-forward items for T029

1. **`supabase/tests/pgtap/submit_final_prediction_serializes_concurrent.sql` (file 11)** — will flip GREEN once T029 ships the supersede UPDATE+INSERT branch on `submit_final_prediction(...)` at a new migration slot (0048 reserved). No edit to file 11 required; the assertion is forward-compat.
2. **`apps/web/tests/playwright/slice-004-submit-concurrent-tabs.spec.ts` (file 6)** — needs a one-line revision when T029 ships: `expect(statuses).toEqual([200, 409])` → `expect(statuses).toEqual([200, 200])`. The "exactly one active row" GET assertion (the FR-010 / SC-004 invariant) carries unchanged. T029 owns the rewrite per its task brief.

No other tests carry forward.

### Sign-off note

This T024 verification is **code review only** (Docker down). The `regression-checkpoint-us2.md` document T025 will produce records the final 11/6 state. Actual runtime confirmation (executing `supabase test db` + `pnpm -F web e2e --grep '@slice-004 @us2'`) is deferred to **T034** per the cross-link harness item — at that point the user runs the verification commands from the body of this document and appends or links the transcript to the Slice 004 PR description.

If runtime exec at T034 surfaces a discrepancy not anticipated here, the resulting fixup belongs in a NEW migration slot (0050+) — historical migrations 0041 and 0044 stay immutable per the slice's renumber-respecting convention.


