# RED Gate — Slice 005 / User Story 1 (US1)

**Slice**: `005-scoring-leaderboard`
**Phase**: 3 (US1 — "Match Scoring: 10 / 5 / 0 / no-prediction truth table + idempotency + audit + recalc")
**Date**: 2026-05-20
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T012 (the Principle IX gate task itself; US1 red-gate document)

---

## Status: DEFERRED (Docker daemon down)

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-3 / US1 RED tests authored in T009 (Playwright, 1 file / 7 tests), T010 (pgTAP, 1 file / 12 assertions), and T011 (pgTAP, 1 file / 6 assertions) are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up (deferred to T016, the slice's final regression gate).
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.
4. The cross-slice coordination point uncovered while authoring T009's admin-auth path is captured as a candidate spec deviation (**D-025**, see § "Cross-slice coordination" below) so slice 006 implementers don't trip over the same wall.

The merge of Slice 005 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 3 (US1) produced **3 RED-state test files** (1 Playwright spec + 2 pgTAP scripts) totalling **25 distinct test units** (7 Playwright tests + 12 pgTAP assertions + 6 pgTAP assertions).

| File | Type | Test / assertion count | Expected RED reason | Who turns GREEN |
|------|------|------------------------|---------------------|-----------------|
| `apps/web/tests/playwright/slice-005-match-scoring.spec.ts` | Playwright | 7 | `POST /functions/v1/score-trigger` returns **404** (Edge Function does not exist yet) **OR**, once T015 ships the function, **403** (`is_admin(auth.uid())` returns false — slice 001 stub — even for admin1; see § Cross-slice coordination). Either way the first `expect(response.status()).toBe(200)` blows up before any downstream `score_records` / `audit_log` assertions can be reached. | **T015** (`supabase/functions/score-trigger/`) — and unblocked admin auth identity via D-025 resolution (see below). |
| `supabase/tests/pgtap/score_match_award_table.sql` | pgTAP | 12 (`plan(12)`) | `INSERT INTO score_records SELECT public.score_match(...)` invocation raises `ERROR: function public.score_match(uuid, uuid) does not exist`. pgTAP reports the function-not-found error before any of the 12 planned assertions (4 reason codes × 3 matches across 6 participants) can be checked. The outer `BEGIN ... ROLLBACK` guarantees no residue. | **T013** (`supabase/migrations/0053_score_match_fn.sql` — per D-023 the on-disk slot is **0053**, not the spec's 0052). |
| `supabase/tests/pgtap/score_match_idempotent.sql` | pgTAP | 6 (`plan(6)`) | Same root cause as above — `score_match(uuid, uuid)` does not exist. All 6 idempotency / version-bump / out-of-order assertions (A1 same-run-id no-duplicate, A2 run row unchanged on replay, A3 fresh-run-id bumps `current_calculation_version` by exactly 1, A4 prior-version rows still present, A5 audit row per write, A6 out-of-order commutativity via session-GUC serialization) are unreachable. | **T013**. |

**Total RED units**: `7 (Playwright) + 12 (pgTAP T010) + 6 (pgTAP T011) = 25 behaviorally-distinct RED units`.

All three files are tagged or scoped `@slice-005 @us1`. None of the assertions are tautological — each one references a specific (participant, target, points, reason_code, calculation_version, or audit-row) tuple sourced from the hand-verified truth table at the bottom of `supabase/seed/slice-005-fixture.sql`.

---

## Cross-slice coordination — **D-025 candidate** (admin auth identity for `score-trigger`)

While authoring T009 the following sequencing wall surfaced and is captured here for the slice 005 PR review so it does not get lost between slices:

**The wall**: The seven Playwright tests in `slice-005-match-scoring.spec.ts` all POST to `/functions/v1/score-trigger` with admin1's bearer token. T015's contract (`specs/005-scoring-leaderboard/contracts/scoring-trigger.edge-fn.md`) requires the Edge Function to gate the admin path on `public.is_admin(auth.uid())`. In slice 001 (`supabase/migrations/0009_is_admin_stub.sql`-equivalent) that function is a stub returning **`false` for every uid** — the actual `admin_roles` table + the production-grade `is_admin` replacement are owned by **Slice 006** ("Admin governance + role management").

Consequence: once T015 ships, the seven Playwright tests will flip from **404** (function absent) to **403** (`unauthorized`) but **NOT to 200** until slice 006 lands or a coordination decision is made. That makes the slice 005 GREEN run technically impossible in isolation — the tests would remain RED for a different reason.

**Options** (in order of decreasing dependency on slice 006):

- **(a)** Wait for slice 006: its `admin_roles` migration adds admin1's `auth_user_id` to the admin set, and its replacement `is_admin(uid)` returns `true` for that row. Slice 005 US1 cannot merge until slice 006's admin migration lands.
- **(b) [RECOMMENDED]** Slice 005's T015 Edge Function exposes an **`X-Internal-Auth: <shared secret>`** header bypass for the admin gate, scoped to test invocation. The Playwright tests in T009 include this header. Production: the shared secret is unset / rotated, so the bypass is inert outside the test harness. Less secure than (a) but lets US1 ship before US6 without coupling the two slices' release trains.
- **(c)** Slice 005's fixture creates a stub `admin_roles` table inline (in T015's own migration) and seeds admin1 into it; the `is_admin` stub is patched to read this table. This effectively pre-bakes a fraction of slice 006's schema into slice 005, which the constitution discourages (slice scope creep).

**Recommendation**: **Option (b)**. It is the simplest path that does not depend on slice 006's release timing. The implementer of **T015** SHOULD:

1. Add an environment-variable-gated `X-Internal-Auth` header secret to the Edge Function (e.g. `WCM_SCORE_TRIGGER_TEST_SECRET`).
2. Document the header in the contract as **"test-only — secret unset in production"**.
3. Update T009's Playwright tests to send the header (Phase 5 polish task or T015 itself).
4. Cross-reference this red-gate doc and the candidate D-025 in T015's PR description so the gap to slice 006's eventual hardening (option (a)) is tracked.

This decision should be promoted from "D-025 candidate" to a numbered, accepted **D-025** entry in the slice's `regression-final.md` once T015's implementer commits to the approach.

---

## Pre-merge runtime verification (deferred to T016)

Once Docker is back up, on branch `005-scoring-leaderboard` from the repo root:

```powershell
# 1. Boot the local Supabase stack.
supabase start

# 2. Reset the database — applies all slice 001-005 migrations and loads fixtures.
supabase db reset

# 3. Run the two slice-005 pgTAP files individually.
supabase test db --file supabase/tests/pgtap/score_match_award_table.sql
supabase test db --file supabase/tests/pgtap/score_match_idempotent.sql

# 4. Typecheck the web app.
pnpm -F web exec tsc --noEmit

# 5. Run the US1 Playwright suite, scoped to slice 005.
pnpm exec playwright test slice-005-match-scoring.spec.ts
# or, equivalently, by tag:
pnpm -F web e2e -- --grep '@slice-005 @us1'
```

**Pass criteria for the RED run** (stash-and-test, BEFORE T013-T015 land):

- `score_match_award_table.sql` fails with `function public.score_match(uuid, uuid) does not exist` (function-not-found error from the SP call site) — not for a syntax error in the test, a missing fixture row, or a planned-vs-run mismatch.
- `score_match_idempotent.sql` fails for the same root cause.
- All 7 Playwright tests fail at the first `expect(response.status()).toBe(200)` because the response is 404 (or 403 once T015 ships without the D-025 resolution) — failures are assertion-level, never infrastructure-level.

**Pass criteria for the GREEN run** (post-T013/T014/T015, post-D-025 resolution):

- `score_match_award_table.sql` reports `ok` on all 12 assertions.
- `score_match_idempotent.sql` reports `ok` on all 6 assertions.
- All 7 Playwright tests tagged `@slice-005 @us1` report `passed`.
- `pnpm -F web exec tsc --noEmit` is clean.

Runtime verification of both the RED-state observation and the eventual GREEN flip is **deferred to T016** (slice 005's final regression gate task). T016 will append transcript references — or a CI link — to this document before merge.

---

## Verdict

**All 25 US1 test units authored and RED-by-contract.** T013 (score_match SP) + T014 (audit trigger) + T015 (score-trigger Edge Function) unlock GREEN, contingent on the D-025 admin-auth coordination decision being made before T015's Playwright tests can run end-to-end.

Per Principle IX the gate is **DEFERRED but acknowledged** — runtime confirmation of the RED state will be appended in T016 once Docker is back up. Until then this artifact is the authoritative inventory of Slice 005 US1's RED surface.
