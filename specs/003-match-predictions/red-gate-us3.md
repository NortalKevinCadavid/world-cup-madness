# RED Gate — Slice 003 / User Story 3 (US3)

**Slice**: `003-match-predictions`
**Phase**: 5 (US3 — "Eligible participant blocked from creating or modifying a prediction once the lock boundary passes or the match status moves out of `scheduled`")
**Date**: 2026-05-20
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T026 (the Principle IX gate task itself; US3 red-gate document)

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed. **Statuses are INFERRED by code inspection** of the as-built predicate (`supabase/migrations/0031_is_prediction_locked.sql`) and the as-built supersede SP (`supabase/migrations/0034_submit_prediction_sp.sql` + `0037_submit_prediction_supersede.sql`).

This document exists so that:

1. The Phase-5 / US3 RED tests authored in T023 (pgTAP, 12 files) + T024 (pgTAP, 3 files) + T025 (Playwright, 4 files / 5 tests) are catalogued exactly once with their expected pre-run failure / pass signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 003 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## GREEN-already callout (important — read this first)

**Most US3 tests are EXPECTED TO PASS IMMEDIATELY against the as-built code.** Unlike US1's pre-T013 gap and US2's D-013 WCM06-trap, US3's GREEN implementations were **shipped before the RED tests were authored**:

- **T004** shipped `is_prediction_locked(p_match_id uuid)` at on-disk slot **0031** with a body that **matches `contracts/prediction-lock.predicate.sql.md` § Signature byte-for-byte** (verified by side-by-side diff of the migration body against the contract block).
- **T013** + **T021** shipped `submit_prediction(...)` at on-disk slots **0034** + **0037** with the WCM01 + WCM02 branches per `contracts/predictions.write.md` § Stored procedure semantics step 6 (verified by reading slot 0037's lines 111–124).

Therefore the expected runtime outcome of T026's gate run is **broad GREEN, narrow RED** — specifically:

- All 11 of T023's behavioral pgTAP files (rows 1–11) should pass on the first run.
- T023's perf test (`is_prediction_locked_perf.sql`, row 12) is environment-dependent — the 5 ms p95 threshold may need recalibration on slow local Postgres builds.
- All 3 of T024's submit_prediction lock-path tests should pass.
- All 5 of T025's Playwright sub-tests (4 files) should pass, with one timing-sensitive caveat on the just-outside leg.

This is consistent with T026's agent prompt header: *"the predicate (T004) and SP (T013) were authored against contracts that match these tests exactly, so most should GREEN immediately"* (T027 body, tasks.md line 1013).

**Principle IX caveat**: T023 + T024 + T025 were authored *after* T004 + T013 + T021 — so for US3 the RED-before-GREEN observation must be reconstructed by stash-and-restore against the GREEN-already code (the same workflow used by slices 001 + 002's final gates and by US2's `red-gate-us2.md` recipe). Specifically: stash slot 0031 + slot 0034 + slot 0037 ⇒ re-run the 19 tests ⇒ observe failures (function not found / unknown SP); restore ⇒ re-run ⇒ observe pass. The stash-restore choreography is enumerated in the slice's `regression-final.md` (T038).

---

## Test inventory

Phase 5 (US3) produced **19 RED-state test files (20 sub-tests counting `slice-003-submit-status-locked.spec.ts`'s 2 sub-tests in one file)**. Total: **12 pgTAP files (T023) + 3 pgTAP files (T024) + 5 Playwright sub-tests across 4 spec files (T025) = 20 behaviorally-distinct units**.

### Section A — T023: `is_prediction_locked()` predicate pgTAP (12 files, 14 planned assertions)

All 12 files follow the `BEGIN / plan(N) / asserts / finish / ROLLBACK` pattern. UUIDs use the `dddd0000-0000-0000-0000-000000000001` Playwright namespace + `eeee*` perf namespace — outside slice-002's `bbbb*` catalog block — so collisions are impossible. The fixture rows are synthesized inside the txn, calibrated against `now()` so the tests are location-independent.

| # | Test file | `plan(N)` | Inferred status against slot-0031 predicate | Notes |
|---|-----------|-----------|---------------------------------------------|-------|
| 1 | `is_prediction_locked_far_before.sql` | `plan(1)` | **GREEN-already**. kickoff=now()+3h, lock_window=60. `now() < kickoff − 60min` → predicate returns FALSE. Matches contract row 1. | — |
| 2 | `is_prediction_locked_strict_boundary_at.sql` | `plan(1)` | **GREEN-already**. kickoff=now()+60min. Between INSERT and predicate eval, `now()` advances ≥ a few µs → `now() ≥ kickoff − 60min` → TRUE. Matches contract row 2 (BR-LOCK-002 strict `>=`). | — |
| 3 | `is_prediction_locked_strict_boundary_just_outside.sql` | `plan(1)` | **GREEN-already**. kickoff=now()+60min+1s. The 1-second buffer absorbs the few-µs `now()` drift → predicate returns FALSE. Matches contract row 3. | Buffer is 1 second — **possible flake under extreme load** (cf. T025 caveat below for the 5-second buffer rationale). |
| 4 | `is_prediction_locked_strict_boundary_just_inside.sql` | `plan(1)` | **GREEN-already**. kickoff=now()+59:59. `now() ≥ kickoff − 60min = now() − 1s` → TRUE. Matches contract row 4. | — |
| 5 | `is_prediction_locked_status_in_progress.sql` | `plan(1)` | **GREEN-already**. status=`in_progress` with kickoff +24h. Status branch (slot 0031 line 25 `IF v_status <> 'scheduled' THEN RETURN true`) fires before the time check → TRUE. Matches contract row 5. | — |
| 6 | `is_prediction_locked_status_finished.sql` | `plan(1)` | **GREEN-already**. Re-uses slice-002 fixture **M1** (`bbbb0000-…-0001`, ARG-MEX, status=`finished`). Status branch → TRUE. Matches contract row 6. | Depends on slice-002 fixture being applied by `supabase db reset`. Per `supabase/seed/slice-002-fixture.sql` ordering, M1 is seeded. |
| 7 | `is_prediction_locked_status_postponed.sql` | `plan(1)` | **GREEN-already**. Synthesized M with status=`postponed`. Status branch → TRUE. Matches contract row 7. | — |
| 8 | `is_prediction_locked_status_cancelled.sql` | `plan(1)` | **GREEN-already**. Synthesized M with status=`cancelled`. Status branch → TRUE. Matches contract row 8. | — |
| 9 | `is_prediction_locked_unknown_match.sql` | `plan(1)` | **GREEN-already**. UUID `ffffffff-…-ffff` — `v_status IS NULL` → slot 0031 line 22 `IF v_status IS NULL THEN RETURN true` → fail-closed TRUE. Matches contract row 9. | — |
| 10 | `is_prediction_locked_config_changes.sql` | `plan(3)` | **GREEN-already**. Predicate reads `tournament_config.lock_window_minutes` fresh on every call (slot 0031 lines 29–31). 3 asserts: (a) verdict at default 60 with kickoff +90min = FALSE; (b) verdict after `UPDATE tournament_config SET value='120'` = TRUE; (c) verdict after restore to 60 = FALSE. SC-005 1-minute config responsiveness. | The mid-txn `UPDATE tournament_config` rolls back at outer ROLLBACK — no residue. |
| 11 | `is_prediction_locked_uses_db_clock.sql` | `plan(2)` | **GREEN-already**. BR-LOCK-001 / Principle VI — `now()` is UTC-absolute regardless of `SET LOCAL TIMEZONE`. Asserts verdict invariant before + after timezone shift. | — |
| 12 | `is_prediction_locked_perf.sql` | `plan(1)` | **GREEN-likely; environment-dependent**. Inserts 100 matches in `eeee*` namespace, loops 1,000 invocations, asserts `percentile_cont(0.95) < 5 ms`. The predicate is two PK lookups (matches.id PK, tournament_config.key PK) — should be sub-millisecond on a healthy Postgres, but **may RED on a starved local Docker Postgres** or a CI runner with disk contention. **Flag for T027 attention if it RED's.** | Perf budget per slot-0031 line ~75 (contract § Performance). |

T023 totals: **12 files**, planned assertions = 1·9 + 3 + 2 + 1 = **14 assertions**. Expected RED count under code inspection: **0 (broad GREEN)** with one environment-flake risk (perf) and one µs-drift flake risk (just-outside, 1-second buffer).

### Section B — T024: `submit_prediction()` lock-path pgTAP (3 files, 7 planned assertions)

All 3 files follow `BEGIN / plan(N) / throws_ok + count-invariant / finish / ROLLBACK`. Each verifies the SP's step-6 branch selection (slot 0037 lines 111–124) — `WCM01` for the lock-window branch, `WCM02` for the status branch — plus the absence-of-row invariant (the SP raises before step 7's INSERT lands).

| # | Test file | `plan(N)` | Inferred status against slot-0037 SP | Notes |
|---|-----------|-----------|--------------------------------------|-------|
| 1 | `submit_prediction_locked_window.sql` | `plan(2)` | **GREEN-already**. Synthesizes M-BOUNDARY (`dddd…-0100`) at kickoff=now()+60min, status=`scheduled`. SP step 6 evaluates: `is_prediction_locked()` returns TRUE (boundary), `v_match_status = 'scheduled'` → slot 0037 line 121 raises `WCM01`. A1 `throws_ok('WCM01')` passes, A2 `count(*) = 0` passes. | The contract test surface row also mentions "audit row `prediction.rejected_locked`" but the SP at slot 0037 raises BEFORE writing audit — that assertion is documented as deferred at slot 0037 header lines 25–33. Not asserted here. |
| 2 | `submit_prediction_locked_status_in_progress.sql` | `plan(2)` | **GREEN-already**. Synthesizes M-IN-PROGRESS (`dddd…-0101`) at kickoff=now()+24h, status=`in_progress`. SP step 6 evaluates: predicate returns TRUE (status branch), `v_match_status <> 'scheduled'` → slot 0037 line 114 raises `WCM02`. A1 `throws_ok('WCM02')` passes, A2 `count(*) = 0` passes. Proves status check precedes time math. | — |
| 3 | `submit_prediction_serializes_concurrent.sql` | `plan(3)` | **GREEN-already**. Drives 5 sequential SP calls against (alpha, M6) inside a single txn. Verifies the supersede-chain invariant T021 ships: A1 exactly 1 active row, A2 exactly 5 total rows (1 active + 4 superseded), A3 all 4 superseded rows have `superseded_by` FKs that resolve to extant predictions. Slot 0037's self-reference placeholder + back-fix (D-014) ensures the final state of `predictions.superseded_by` is correct. | **D-014 audit caveat**: the test inspects only `predictions` final state; `audit_log.new_value->>'superseded_by'` carries the self-reference placeholder for the first 4 supersede transitions. This test does NOT assert on audit_log content, so the D-014 caveat does not regress it. |

T024 totals: **3 files**, planned assertions = 2 + 2 + 3 = **7 assertions**. Expected RED count under code inspection: **0 (all GREEN)**.

### Section C — T025: `POST /api/predictions` lock-path Playwright (4 files, 5 sub-tests)

All 5 sub-tests are tagged `@slice-003 @us3`. Each spins up a synthetic match via service-role in `beforeEach`, signs in as alpha through the OIDC stub, forwards session cookies onto the API `request`, and asserts the route handler's status + envelope. The 5 sub-tests live in 4 files because `slice-003-submit-status-locked.spec.ts` contains two `test(...)` calls (in-progress + finished) under one `describe`.

| # | Test file | sub-tests | UUID | Calibration | Inferred status | Notes |
|---|-----------|-----------|------|-------------|-----------------|-------|
| 1 | `slice-003-submit-locked.spec.ts` | 1 | `dddd…-0200` | kickoff=now()+60:00 (exact boundary) | **GREEN-already (timing-sensitive)**. SP raises WCM01 → route maps to **409 `PREDICTION_LOCKED`** with `reason='lock_window_passed'`. Asserts `.toBe(409)` + `.code='PREDICTION_LOCKED'` + `.reason='lock_window_passed'`. | At the exact boundary, the test relies on `now()` at SP-eval ≥ `now()` at `setupCalibratedMatch` — the few-ms latency between the match upsert and the POST guarantees this on any reasonable runner. Robust. |
| 2 | `slice-003-submit-locked-just-inside.spec.ts` | 1 | `dddd…-0201` | kickoff=now()+59:59 (1 sec INSIDE) | **GREEN-already**. Same WCM01 path → 409 + `lock_window_passed`. The 1-second-inside calibration is comfortably inside the boundary. | — |
| 3 | `slice-003-submit-locked-just-outside.spec.ts` | 1 | `dddd…-0202` | kickoff=now()+60:05 (5 sec OUTSIDE) | **GREEN-likely; CI-timing-sensitive (flag for T027)**. The 5-second buffer (deliberately wider than T023 row 3's 1-second buffer per slot file lines 18–19) absorbs `beforeEach → SP-eval` latency. **However**: on slow CI runners the upsert → cookie forward → POST → SP entry path can take 4-6 s, and if the SP evaluates `now() ≥ kickoff − 60min` with the match's `kickoff_utc` set 60:05 ago, the verdict flips to TRUE and the test gets 409 instead of 200. Asserts both `.toBe(200)` AND a subsequent GET `/api/me/predictions?match_id=…` returns the new row. | **Most likely RED candidate of the 20.** Consider expanding the buffer to 90:00 or 120:00 if T027 sees a flake. |
| 4a | `slice-003-submit-status-locked.spec.ts` (sub-test 1) | 1 | `dddd…-0203` | kickoff=now()+24h, status=`in_progress` | **GREEN-already**. SP raises WCM02 → route maps to **409 `PREDICTION_LOCKED`** with `reason='match_status_locked'`. Status branch wins regardless of time-window distance. | — |
| 4b | `slice-003-submit-status-locked.spec.ts` (sub-test 2) | 1 | `dddd…-0204` | kickoff=now()−2h, status=`finished` | **GREEN-already**. Same WCM02 path → 409 + `match_status_locked`. Proves SP checks status BEFORE the time math (a past kickoff would otherwise route to WCM01 via the time branch). | — |

T025 totals: **4 files, 5 sub-tests**. Expected RED count under code inspection: **0 (broad GREEN)** with timing-flake risk on sub-test 3 (just-outside, 5-second buffer).

---

## Predicate-matches-contract callout

Re-iterating because it's the single most important fact for reviewers of this gate:

- `supabase/migrations/0031_is_prediction_locked.sql` body (lines 5–34) matches `specs/003-match-predictions/contracts/prediction-lock.predicate.sql.md` § Signature (lines 18–48) **byte-for-byte** — same DECLARE block, same `IF v_status IS NULL THEN RETURN true`, same `IF v_status <> 'scheduled' THEN RETURN true`, same `COALESCE((value::text)::int, 60)` config-read, same `RETURN now() >= v_kickoff_utc - (v_lock_window_min * INTERVAL '1 minute')`.
- T023's 12 pgTAP files target *exactly* the 12 contract test-surface rows. Therefore: predicate body matches contract ⇔ pgTAP files match contract ⇔ pgTAP files match predicate body ⇔ all behavioral tests GREEN-already.

The 5-tests-broad-GREEN-narrow-RED property here is the opposite of US2's 5-tests-one-D-013-fix property — US3's tests verify code already shipped, where US2's verified code yet to ship. The Principle IX RED-before-GREEN sequence for US3 is therefore satisfied by stash-and-restore of the GREEN-already migrations (recipe documented in `regression-final.md`).

---

## Pre-merge action items (potential T027 fixes)

T027's body acknowledges "the predicate (T004) and SP (T013) were authored against contracts that match these tests exactly, so most should GREEN immediately". For the narrow RED candidates flagged above, T027's likely scope:

1. **`is_prediction_locked_perf.sql` p95 threshold** — if the 5 ms threshold RED's on a local Postgres / Docker Postgres / CI runner, T027 should either:
   - re-verify the threshold under a tuned local Postgres + commit the run's p95 figure to the test comment, OR
   - bump the threshold to 10 ms with a comment explaining the runtime tradeoff. Per the contract § Performance, "p95 < 5 ms" is the canonical target; raising it requires a contract amendment with cross-slice signoff (Slice 005's `peer_pick_v` filter calls this per-row).
2. **`slice-003-submit-locked-just-outside.spec.ts` 5-second buffer** — if the test RED's under CI with `expect(response.status()).toBe(200)` getting 409 instead, T027 should:
   - expand the kickoff offset from `60 * 60 * 1000 + 5 * 1000` (60:05) to `60 * 60 * 1000 + 60 * 1000` (61:00) or `60 * 60 * 1000 + 5 * 60 * 1000` (65:00), depending on observed beforeEach → SP-eval latency.
   - Update the spec header comment to document the actual buffer chosen.
3. **D-014 audit-row caveat documentation** — no test currently RED's on this, but T027 (or T038's regression-final) should re-confirm that no future US3 test (or US4–US7 downstream slice) accidentally asserts on `audit_log.new_value->>'superseded_by'` for a `prediction.superseded` row, because that field carries the self-reference placeholder. D-014 is documented in `tasks.md` § Implementation deviations and in slot 0037's body comments (lines 192–202).

If all 20 sub-tests come up GREEN on the runtime gate run, **T027 is a no-op** — checkbox it `[X]` with the suffix `— no fixes required; all US3 tests GREEN on first run; predicate + SP match contract byte-for-byte`.

---

## Implementation note — RED state inferred, not observed (TDD caveat)

In this session (2026-05-20, Auto mode, Docker daemon down), the RED tests T023 + T024 + T025 were authored and the matching GREEN implementations (T004 predicate at slot 0031, T013 SP at slot 0034, T021 supersede extension at slot 0037) were **already in place when the tests landed**. The expected outcomes in the tables above are inferred from straightforward side-by-side reading of the predicate / SP bodies against the test assertions — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 003.** For US3 the recipe inverts the slices-001+002 sequence: the GREEN code is already in tree, so the user stashes the three migrations (`0031`, `0034`, `0037`), runs the verification commands below, observes every test fail (function-not-found / SP-not-found / generic SQLSTATE), restores the stash, re-runs, observes every test pass. Stash paths to enumerate in `regression-final.md` (T038).

If any test in the inventory comes up GREEN *before* the stash-restore then that test is not actually gating the implementation it claims to gate — most likely a typo'd UUID, a fixture-row leak, or a missing seed. Stop and investigate before proceeding.

If any test comes up RED *after* the stash-restore for a reason OTHER than the documented signature (timing flake on the just-outside spec, p95 threshold under local Postgres, fixture / RLS / framework error), T027 must investigate the root cause before merging.

---

## Verification commands (run once Docker is up)

From the repo root on branch `003-match-predictions`:

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all 31 slice-001 + slice-002 + slice-003
#    migrations (0001..0011, 0018..0029, 0030..0037 per D-012's renumber)
#    and loads the three seed fixtures
#    (supabase/seed/slice-001-fixture.sql + slice-002-fixture.sql +
#    slice-003-fixture.sql).
supabase db reset

# 3. Run the slice-003 is_prediction_locked pgTAP suite (T023 — 12 files,
#    14 planned assertions). Iterate via Get-ChildItem because supabase
#    test db takes one path at a time.
Get-ChildItem supabase/tests/pgtap -Filter 'is_prediction_locked_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 4. Run the slice-003 submit_prediction lock-path pgTAP files (T024 —
#    2 files via this glob: submit_prediction_locked_window.sql +
#    submit_prediction_locked_status_in_progress.sql).
Get-ChildItem supabase/tests/pgtap -Filter 'submit_prediction_locked_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 5. Run the slice-003 submit_prediction serialization pgTAP file (T024 —
#    1 file; the supersede-chain integrity test does not match the
#    submit_prediction_locked_* glob).
supabase test db supabase/tests/pgtap/submit_prediction_serializes_concurrent.sql

# 6. Typecheck the web app — catches any contract-shape drift between the
#    locally-declared response types in the specs and the route handlers.
pnpm -F web exec tsc --noEmit

# 7. Run the US3 Playwright suite, scoped to slice 003 / us3. The
#    @slice-003 + @us3 tags are applied by T025 via test.describe
#    annotations on all 4 spec files / 5 sub-tests.
pnpm -F web e2e -- --grep '@slice-003 @us3'
```

**Pass criteria for the GREEN run** (no stash; tree as-is):

- All 12 `is_prediction_locked_*.sql` files report `ok` for every planned assertion (14 ok lines total).
- Both `submit_prediction_locked_*.sql` files report `ok` for both planned assertions each (4 ok lines total).
- `submit_prediction_serializes_concurrent.sql` reports `ok` for all 3 planned assertions.
- All 5 Playwright sub-tests tagged `@slice-003 @us3` (across 4 spec files) report `passed`.
- `pnpm -F web exec tsc --noEmit` is clean.

**Pass criteria for the RED run** (stash slots 0031 + 0034 + 0037 BEFORE running):

- Every `is_prediction_locked_*.sql` file fails because `public.is_prediction_locked(uuid)` does not exist (function-not-found / `42883`). pgTAP marks the file as `bailout`.
- Every `submit_prediction_locked_*.sql` and `submit_prediction_serializes_concurrent.sql` file fails because `public.submit_prediction(uuid, uuid, int, int, text)` does not exist. `throws_ok` reports an unexpected SQLSTATE (`42883`), failing A1; A2 may still pass (`count(*) = 0` on an empty table) — but the file overall reports `not ok`.
- All 5 Playwright sub-tests fail. The synthetic-match upsert in `beforeEach` succeeds (`matches` table exists), but `POST /api/predictions` returns either 500 (the route handler's SP call raises `function not found`) or another 4xx; the expected status assertion (`.toBe(409)` for the 4 locked sub-tests, `.toBe(200)` for the just-outside sub-test) fails.
- `pnpm -F web exec tsc --noEmit` remains clean (typecheck is unaffected by stashed migrations).

If both criteria hold, the Principle IX gate is observationally satisfied and Slice 003 US3 is cleared to merge.

---

## Inherited spec deviations

Slice 003 US3 inherits **D-001 through D-014** from prior phases. One-liners:

- **D-001** (slice 001, T004) — Auth hook key renamed to `[auth.hook.custom_access_token]`; US3 inherits via `requireEligible()` on every `POST /api/predictions`.
- **D-002** (slice 001, T019/T022) — `is_approved_domain(p_email text)` accepts a full email; inherited via the shared `requireEligible()` helper.
- **D-003** (slice 001, T028) — `{ error: { code, message } }` envelope + `Cache-Control: private, max-age=0, must-revalidate`; US3's 409 envelope (`code='PREDICTION_LOCKED'`, `reason='lock_window_passed' | 'match_status_locked'`) is the contract-locked extension of this shape and is asserted byte-for-byte by all 5 Playwright sub-tests.
- **D-004** (slice 001, T034) — `participants_self_or_admin_read` combined OR'd policy embeds the eligibility predicate; US3's per-row predictions RLS depends on the live policy.
- **D-005** (slice 001, T038) — `handle_auth_user_signed_in` returns `custom_access_token` envelope; relevant to US3 only because each Playwright sign-in traverses this hook.
- **D-006** (slice 002, T003–T011) — `match_status` enum is `scheduled / in_progress / finished / postponed / cancelled`; US3's `status_*` pgTAP suite and `slice-003-submit-status-locked.spec.ts` reference all 5 values (only `cancelled` is not exercised by the Playwright surface; pgTAP row 8 covers it).
- **D-007** (slice 002, T020) — `match_results` field-name mapping; not exercised by US3 (predictions does not query match_results).
- **D-008** (slice 002, T026) — pgTAP cannot observe `pg_notify`; predictions audit triggers do not emit notifications, so D-008 is informational for US3.
- **D-009** (slice 002, T026) — `audit_log.action` name mismatch (`'match_result.recorded'` vs `'updated'`/`'corrected'`); US3's `'prediction.created'` + `'prediction.superseded'` vocabulary avoids the same trap.
- **D-010** (slice 002, T032/T033) — `sync-catalog` reconciliation gaps; not exercised by US3.
- **D-011** (slice 002, T039) — `audit_log.source` enum reuses `'trigger'`; US3 prediction-audit rows reuse the same source. No regression here.
- **D-012** (slice 003, slice start) — Migration slot renumber: T004 predicate lives at slot **0031**, T013 SP at **0034**, T021 supersede at **0037**. Tests reference function/table names so no test-file change required; `supabase db reset` applies the renumbered set cleanly.
- **D-013** (slice 003, T013, resolved by T021) — Provisional WCM06 (`DUPLICATE_ACTIVE`) branch in T013, replaced by supersede pattern in T021. No US3 test references WCM06; the supersede behavior is verified by US2's gate (`red-gate-us2.md`) and by US3's `submit_prediction_serializes_concurrent.sql` chain-integrity test. After T021, no caller observes WCM06 — including this gate.
- **D-014** (slice 003, T021 review) — Supersede self-reference placeholder. `audit_log.new_value->>'superseded_by'` carries the self-reference (OLD's own id), not the chain successor; `predictions.superseded_by` is the canonical successor link. US3's `submit_prediction_serializes_concurrent.sql` asserts only on `predictions` final state (NOT `audit_log`), so D-014 does not regress here. Future Slice 007 audit forensics readers must reconstruct supersede chains from `predictions.superseded_by`.

---

## Sign-off checklist (for the Slice 003 US3 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] RED run completed (per the stash-and-test recipe — stash slots 0031 + 0034 + 0037; paths enumerated in `regression-final.md`); transcript or CI link recorded.
- [ ] GREEN run completed (post-restore); transcript or CI link recorded.
- [ ] PR description references this file by path: `specs/003-match-predictions/red-gate-us3.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.
- [ ] All 12 + 3 = 15 pgTAP files report `ok` on the GREEN run (14 + 7 = 21 total assertions); all 5 Playwright sub-tests across 4 spec files report `passed` on the GREEN run.
- [ ] If `is_prediction_locked_perf.sql` RED's, T027 has either re-verified the 5 ms threshold under a representative Postgres or amended the threshold with cross-slice signoff (Slice 005's `peer_pick_v` consumer).
- [ ] If `slice-003-submit-locked-just-outside.spec.ts` RED's, T027 has expanded the 5-second kickoff buffer to a CI-safe value and documented the choice in the spec header comment.
- [ ] D-014 caveat preserved: no test in this gate (or downstream) asserts on `audit_log.new_value->>'superseded_by'` for `prediction.superseded` rows.

Until every box above is ticked, Slice 003 US3 does not satisfy Constitution Principle IX and must not merge.
