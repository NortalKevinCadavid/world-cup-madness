# RED Gate — Slice 002 / User Story 2 (US2)

**Slice**: `002-match-catalog`
**Phase**: 4 (US2 — "Provider abstraction: fixtures + statuses + scores sync through a stable adapter; swap is config-only")
**Date**: 2026-05-19
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T028 (the Principle IX gate task for US2)

---

## Status: DEFERRED

**This gate was NOT executed.** Two distinct runtime dependencies were unavailable on the executing machine:

1. **The Docker daemon required by `supabase start`** (and therefore by `supabase test db` for pgTAP, by the Edge Function runtime, and by any test that posts to `/functions/v1/sync-catalog`) was **down at the time of execution**.
2. **Deno is not installed locally** (`deno --version` not on PATH). The four Deno test files authored under T023–T025 require Deno to execute — `deno test --allow-all` is the only supported runner for Edge Function tests, and the Supabase CLI does not bundle Deno for use outside of `supabase functions serve`.

Both gaps must be closed before the verification recipe at the bottom of this document can run. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-4 tests authored in T023, T024, T025, and T026 are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up AND Deno is installed.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 002 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 4 (US2) produced **12 RED-state test files** (4 Deno test files + 8 pgTAP scripts). T023 fans out into 2 Deno files (2 sub-tests). T024 fans out into 3 Deno files (4 sub-tests — `internal_auth_path` is itself a two-assert file). T025 contributes 1 Deno file (1 sub-test) plus the second-stub adapter artifact (`supabase/functions/_shared/providers/stub2/index.ts` + its fixture JSON, which are *implementation* artifacts authored by T025 to make the future GREEN run possible — they are not themselves RED tests). T026 contributes 8 pgTAP files covering the `record_match_result` SP surface.

**Total: 7 Deno sub-tests + 8 pgTAP files = 15 behaviorally-distinct RED units.**

| # | Test file | Test type | Test count / `plan(N)` | Expected status PRE-T029/T030/T031/T032 ship | GREEN implementer |
|---|-----------|-----------|------------------------|----------------------------------------------|-------------------|
| 1 | `supabase/functions/sync-catalog/tests/single_sync_happy.test.ts` | Deno (`@slice-002 @us2`) | 1 sub-test | **RED**. POSTs `/functions/v1/sync-catalog` with `X-Internal-Auth` + a fresh `run_id`. The Edge Function does not exist yet — Supabase's function dispatcher returns 404, the first assertion `assertEquals(response.status, 200)` fails. Even with a stub handler in place, the downstream assertions (`provider_sync_runs.id = run_id`, `provider_name = 'stub'`, terminal `outcome`, `matches` row count == 8) cannot satisfy without T032's coordinator logic + T030's stub adapter. | T032 (`supabase/functions/sync-catalog/index.ts` coordinator) + T030 (`supabase/functions/_shared/providers/stub/index.ts` adapter) + T031 (stub fixture). |
| 2 | `supabase/functions/sync-catalog/tests/idempotent_retry.test.ts` | Deno (`@slice-002 @us2`) | 1 sub-test | **RED**. POSTs the same payload twice with the same `run_id`. The first call 404s (no function) → second call also 404s. Even with T032 shipped, the contract-mandated `notes="idempotent retry"` echo on the second response, and the assertion that the second response body equals the first byte-for-byte, depend on the coordinator's idempotency branch (per `contracts/sync-runner.scheduled.md` § Coordinator behavior step 3 — "look up `provider_sync_runs` by `run_id`; if present, return the prior response shape with `notes='idempotent retry'`"). | T032 (idempotency branch + `provider_sync_runs` upsert) + T030. |
| 3 | `supabase/functions/sync-catalog/tests/advisory_lock_returns_409.test.ts` | Deno (`@slice-002 @us2`) | 1 sub-test | **RED**. Acquires `pg_advisory_lock(hashtext('sync_catalog'), hashtext('stub'))` in a side connection, THEN POSTs the sync. With no function, the response is 404 instead of the contract 409 + `{error:{code:'SYNC_IN_FLIGHT'}}`. Once T032 ships, the coordinator step 2 (`pg_try_advisory_lock`) must short-circuit to 409 on contention; the side connection holds the lock for the test duration. | T032 (advisory-lock branch). |
| 4 | `supabase/functions/sync-catalog/tests/non_admin_returns_403.test.ts` | Deno (`@slice-002 @us2`) | 1 sub-test | **RED**. Signs in via `@supabase/supabase-js` (any authenticated user — `is_admin()` is the Slice 001 stub returning `false`), POSTs without `X-Internal-Auth`, asserts `403 + { error: { code: 'FORBIDDEN' } }`. No function → 404. Once T032 ships, the JWT-admin branch must reject non-admins. | T032 (auth gate per `contracts/sync-runner.scheduled.md` § Auth). |
| 5 | `supabase/functions/sync-catalog/tests/internal_auth_path.test.ts` | Deno (`@slice-002 @us2`) | 2 sub-tests (one for valid `X-Internal-Auth` → 200; one for wrong-secret → 401) | **RED**. Two-assert file. Both POSTs return 404 from the missing function instead of the contract 200 (success) / 401 (bad secret). Once T032 ships, the header path must accept the configured secret and reject mismatches. | T032 (header-auth branch). |
| 6 | `supabase/functions/sync-catalog/tests/provider_swap.test.ts` | Deno (`@slice-002 @us2 @sc-005`) | 1 sub-test | **RED**. Sequences: sync against `stub` → SHA-256 of `matches` rows → flip `tournament_config.providers.active` to `"stub2"` → sync against `stub2` → SHA-256 again → assert hashes are byte-identical. With no function, the first sync 404s. **NOTE**: T025 already authored `supabase/functions/_shared/providers/stub2/index.ts` + its fixture JSON as part of its own task (so the second stub is on disk today). The remaining work is in T030 (wire `stub` into the registry), T032 (wire `stub2` into the same registry — single-line change per the test's docblock), and T032's coordinator body. This test will become GREEN only when both adapters are in the static adapter registry and produce byte-identical normalized output. | T032 (registry wiring for both `stub` and `stub2`) + T030 (stub adapter) + T031 (fixture). |
| 7 | `supabase/tests/pgtap/record_match_result_happy.sql` | pgTAP | `plan(N)` per file | **RED**. The SP `public.record_match_result(...)` does not exist; `lives_ok` / `is` assertions invoking it will raise `function record_match_result(...) does not exist`. | T029 (`supabase/migrations/0024_record_match_result_sp.sql`). |
| 8 | `supabase/tests/pgtap/record_match_result_rejects_pre_finished.sql` | pgTAP | `plan(N)` per file | **RED**. Same root cause: SP absent. Once T029 ships, the SP must `RAISE EXCEPTION` when `matches.status <> 'finished'`. | T029. |
| 9 | `supabase/tests/pgtap/record_match_result_enforces_for_scoring_invariant.sql` | pgTAP | `plan(N)` per file | **RED**. SP absent. The CHECK invariants (the `_for_scoring` columns must reflect the regulation-90' score at the column level) are enforced inside the SP body. | T029. |
| 10 | `supabase/tests/pgtap/record_match_result_enforces_shootout_invariant.sql` | pgTAP | `plan(N)` per file | **RED**. SP absent. The shootout level-check (`result_status = 'penalty_shootout'` requires penalty columns populated) is enforced inside the SP body (per `contracts/match-results.write.md` § Stored procedure semantics step 2). | T029. |
| 11 | `supabase/tests/pgtap/record_match_result_admin_correction_requires_approver.sql` | pgTAP | `plan(N)` per file | **RED**. SP absent. The admin-override path requires `p_approved_by IS NOT NULL` when `p_source = 'admin_override'`. | T029. |
| 12 | `supabase/tests/pgtap/record_match_result_admin_correction_requires_admin.sql` | pgTAP | `plan(N)` per file | **RED**. SP absent. The admin-override path requires `p_approved_by` to resolve to an `is_admin()` user. | T029. |
| 13 | `supabase/tests/pgtap/record_match_result_emits_notification.sql` | pgTAP | `plan(2)` | **RED**. SP absent. See **D-008** below — pgTAP's `BEGIN/ROLLBACK` envelope cannot observe `pg_notify` channel reception; this file falls back to `lives_ok` on the SP call + `is(count(*), 1)` on the `match_results` insert as a structural proxy for "the `PERFORM pg_notify(...)` call executed without raising." Real channel-payload verification is deferred to Slice 005. | T029 (the `PERFORM pg_notify('match_results_recorded', ...)` step). Real channel reception verified later by Slice 005 T042. |
| 14 | `supabase/tests/pgtap/record_match_result_audit_format.sql` | pgTAP | `plan(3)` | **RED**. SP absent. See **D-009** below — migration `0025_catalog_audit_triggers.sql` shipped `action='match_result.recorded'` (INSERT) and `action='match_result.updated'` (UPDATE); the contract names the UPDATE action `'match_result.corrected'`. This file asserts the *as-built* `'match_result.recorded'` for the first-insert path (which the contract and the migration agree on). The UPDATE-path action-name mismatch is a T029 decision: honor the migration's `'match_result.updated'` OR re-author 0025 to match the contract. | T029 (the SP body's INSERT path triggers the migration's `match_result.recorded`/`match_result.updated` audit row; the cross-slice `_for_scoring` column must appear in `new_value`). |

---

## D-008 reservation (NEW — surfaced in T026 `record_match_result_emits_notification.sql`)

**Symptom**: The pgTAP test pattern requires every test to run inside a `BEGIN; ... ROLLBACK;` envelope (the harness rolls back so tests don't pollute the database between runs). However, PostgreSQL's `pg_notify` semantics enqueue notifications for delivery at `COMMIT` — a rolled-back transaction emits nothing to listening sessions. Additionally, libpq surfaces notifications only between commands, and pgTAP harnesses don't expose them to test assertions. There is therefore no in-pgTAP way to observe that `'match_results_recorded'` actually received the expected payload.

**Compromise chosen by T026**: The file asserts:
- `lives_ok` on the SP call: any malformed `pg_notify` invocation (typo'd channel name, payload not coercible to text, `json_build_object` failure) would raise here; this catches *structural* errors in T029's notification call.
- `is(count(*), 1)` on the `match_results` row: the contract puts `PERFORM pg_notify(...)` AFTER the UPSERT, so a successful UPSERT is a necessary precondition for the notification step to have executed.

This is a structural proxy, not the load-bearing assertion. The load-bearing assertion — "Slice 005's score-trigger Edge Function actually receives `{ match_id, source }` on the `'match_results_recorded'` channel" — is deferred to a **Slice 005 Deno integration test** that maintains a real `LISTEN` session across `COMMIT` (Slice 005 task T042 per its placeholder plan).

**Cross-reference**: D-007 (the column-mapping reconciliation in the catalog route) handles the `_official` vs split-column shape on the *read* side. D-008 handles the notification observability gap on the *write* side. Both are consequences of working with the as-built migration set rather than the data-model document.

**Recorded in `tasks.md`** under § Implementation deviations.

---

## D-009 reservation (NEW — surfaced in T026 `record_match_result_audit_format.sql`)

**Symptom**: The audit-trigger migration `0025_catalog_audit_triggers.sql` (T013, shipped under Phase 2) emits `audit_log.action`:

- `'match_result.recorded'` on INSERT into `match_results`
- `'match_result.updated'` on UPDATE of `match_results`

The cross-slice contract `specs/002-match-catalog/contracts/match-results.write.md` § Audit posture, however, names the UPDATE-path action `'match_result.corrected'` (the spelling chosen to reflect the admin-override semantics — corrections are humans fixing provider data).

**Decision deferred to T029**:

1. **Honor the migration's existing actions** — accept `'match_result.updated'` as the canonical spelling and propagate that name through to Slice 006's admin-override UI, Slice 007's forensic queries, and any cross-slice documentation that currently references `'match_result.corrected'`. Lowest churn.
2. **Re-author 0025 to match the contract** — emit a follow-on migration (or amend 0025 in place if no other slice has consumed it yet) that flips the UPDATE-path action name to `'match_result.corrected'`. Aligns with the contract's chosen spelling but introduces a schema-change migration in Slice 002 that ripples through downstream slices.

The pgTAP file `record_match_result_audit_format.sql` only asserts the INSERT path (`'match_result.recorded'`) — which both the migration and the contract agree on — so it does not gate this decision. The UPDATE-path assertion will live in a future Slice 006 pgTAP file once T029 picks a spelling.

**Cross-reference**: D-006 (the broader Wave-2 schema reconciliation) is the umbrella deviation under which 0025's audit-action naming was set. D-009 is a focused follow-up specifically for the action-name mismatch.

**Recorded in `tasks.md`** under § Implementation deviations.

---

## Implementation note — RED state inferred, not observed (TDD caveat)

In this session (2026-05-19, Auto mode, Docker down + Deno not installed), the GREEN-implementation tasks for US2 — **T029 (the SP migration), T030 (the stub adapter), T031 (fixture wiring), T032 (the sync-catalog Edge Function coordinator)** — **may be authored in the same agentic session** as the T023–T026 RED tests, without an intervening live test run to *observe* the RED state.

The expected failure signatures in the inventory above are inferred from straightforward "function does not exist" / "SP does not exist" / "adapter registry empty" reasoning — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 002.** The recipe mirrors slice 001's:

1. Install Deno (`winget install denoland.deno` on Windows; equivalent platform-specific install elsewhere) and start Docker Desktop; wait for both to be healthy.
2. From the repo root, stash the GREEN implementation files so the working tree returns to its pre-T029/T030/T031/T032 state:
   ```powershell
   git stash push -m "slice-002 US2 GREEN stash for RED verification" `
     supabase/migrations/0024_record_match_result_sp.sql `
     supabase/functions/_shared/providers/stub/index.ts `
     supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json `
     supabase/functions/sync-catalog/index.ts
   ```
   (If any path does not exist in your tree, omit it from the `git stash push` invocation. Exact filenames may differ — substitute the actual filenames produced by T029–T032. Note: the stub2 adapter files were authored by T025 itself and are RED-test artifacts, not GREEN-implementation artifacts — do NOT stash them.)
3. Run the verification commands in the next section. Every test in the inventory MUST fail with the documented signature. Capture the output.
4. Restore the GREEN implementation:
   ```powershell
   git stash pop
   ```
5. Re-run the same verification commands. Every test in the inventory MUST now pass — with the documented caveat that `record_match_result_emits_notification.sql` only asserts the structural proxy (D-008) and `record_match_result_audit_format.sql` only asserts the agreed-on `'match_result.recorded'` spelling (D-009).
6. Append both transcripts (RED + GREEN), or links to CI runs that exhibit them, to the Slice 002 PR description.

If step 3 produces a GREEN result for any test in the inventory, that test is not actually RED-gated by the implementation it claims to gate — stop and investigate before proceeding.

---

## Verification commands (run once Docker is up AND Deno is installed)

From the repo root on branch `002-match-catalog`:

```powershell
# 0. One-time: install Deno if not already on PATH.
winget install denoland.deno
# (Alternative: choco install deno; or download from https://deno.land/.)

# Verify both runtimes:
docker info | Select-String "Server Version"   # must succeed (Docker daemon up)
deno --version                                  # must report a version (Deno on PATH)

# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database. Slice 002 ships 11 new migrations (0018..0028) on top
#    of Slice 001's 11 (0001..0011), for 22 migrations total. The reset also
#    reloads both seed fixtures (supabase/seed/slice-001-fixture.sql +
#    supabase/seed/slice-002-fixture.sql).
supabase db reset

# 3. Run the 8 pgTAP files authored under T026 individually. Globbing keeps
#    the loop scoped to record_match_result_*.sql — the other slice-002
#    pgTAP files (RLS suite from T017) belong to US1's gate (red-gate-us1.md).
Get-ChildItem supabase/tests/pgtap -Filter record_match_result_*.sql `
  | ForEach-Object { supabase test db $_.FullName }

# 4. Run the 4 Deno test files authored under T023, T024, T025. The Edge
#    Function tests require an env file with SUPABASE_URL +
#    SUPABASE_SERVICE_ROLE_KEY + SYNC_TRIGGER_SECRET + RUN_SYNC_CATALOG_TESTS=1.
#    The web app's .env.local file holds the first three; you must export
#    RUN_SYNC_CATALOG_TESTS=1 explicitly (the tests self-skip without it).
cd supabase/functions/sync-catalog/tests
$env:RUN_SYNC_CATALOG_TESTS = "1"
deno test --allow-all --env-file=../../../../apps/web/.env.local
cd ../../../..

# 5. Optional but recommended: typecheck the function tree to catch
#    contract-shape drift between supabase/functions/_shared/providers/types.ts
#    and any adapter that consumes it.
deno check supabase/functions/_shared/providers/stub/index.ts
deno check supabase/functions/_shared/providers/stub2/index.ts
deno check supabase/functions/sync-catalog/index.ts
```

**Pass criteria for the GREEN run** (post-`git stash pop`, all of T029/T030/T031/T032 shipped):

- All 8 pgTAP files report `ok` for every planned assertion. The notification file (`record_match_result_emits_notification.sql`) passes via the D-008 structural-proxy assertions; the audit-format file (`record_match_result_audit_format.sql`) passes via the D-009 agreed-on `'match_result.recorded'` action name. Both are documented limitations, not bugs.
- All 4 Deno test files report `ok` for every sub-test:
  - `single_sync_happy.test.ts`: 1 sub-test passes (200 OK, `provider_sync_runs.outcome` terminal, `matches` row count canonical).
  - `idempotent_retry.test.ts`: 1 sub-test passes (second call echoes `notes='idempotent retry'` with body byte-identical to the first).
  - `advisory_lock_returns_409.test.ts`: 1 sub-test passes (409 + `SYNC_IN_FLIGHT` while side connection holds the lock).
  - `non_admin_returns_403.test.ts`: 1 sub-test passes (`is_admin()=false` participant gets 403 + `FORBIDDEN`).
  - `internal_auth_path.test.ts`: 2 sub-tests pass (valid secret → 200; wrong secret → 401).
  - `provider_swap.test.ts`: 1 sub-test passes (SHA-256 of `matches` is identical under `stub` and `stub2` providers).

**Pass criteria for the RED run** (between `git stash push` and `git stash pop`):

- All 8 pgTAP files fail because `function record_match_result(...) does not exist` (or, for the audit-format test, because no row is inserted into `match_results` for the trigger to fire on).
- All 4 Deno test files fail because `POST /functions/v1/sync-catalog` returns 404 (Edge Function tree empty) — *not* for a syntax error in the test file itself, a missing fixture row, a missing env var, or a Deno-runtime failure.
- The two adapter `deno check` invocations on `stub2/index.ts` succeed (T025 ships that adapter as a test artifact) but `stub/index.ts` and `sync-catalog/index.ts` either fail to typecheck because the files don't exist OR return errors about missing imports.

If both criteria hold, the Principle IX gate is observationally satisfied for US2 and Slice 002 is cleared to merge from a US2 perspective. (The US1 gate, documented in `red-gate-us1.md`, must also be satisfied.)

---

## Cumulative spec deviations

The full running log lives in `specs/002-match-catalog/tasks.md` § Implementation deviations (which inherits D-001..D-005 from slice 001 via `specs/001-eligibility-login/tasks.md`). Cross-referenced one-liners for review:

- **D-001** (slice 001, T004) — Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`. Slice 002 inherits via the shared `requireEligible()` helper.
- **D-002** (slice 001, T019/T022) — `is_approved_domain(p_email text)` accepts a full email and extracts the domain internally. Slice 002's API-guard re-check uses this signature.
- **D-003** (slice 001, T028) — `/api/me` response body locked to `{ participant: {...} }` / `{ error: {...} }` with `Cache-Control: private, max-age=0, must-revalidate`. Slice 002's `/api/matches` reuses the same envelope.
- **D-004** (slice 001, T034) — `participants_self_or_admin_read` policy already embeds the eligibility predicate (front-loaded under T012's bow wave). Slice 002's `slice-002-catalog-rls.sql` references the live combined policy.
- **D-005** (slice 001, T038) — `handle_auth_user_signed_in` returns the `custom_access_token` envelope (`{claims}` / `{error}`), not `{decision}`. Slice 002's catalog page session refresh path goes through this hook.
- **D-006** (slice 002, tasks.md line 51, T003–T011 wave-2 schema reconciliation) — Several Phase-2 migrations diverged from `data-model.md`: `match_status` canonical enum fixed inline; `match_results` keeps split columns + LOCKED `_for_scoring` names; `result_status` uses `'penalty_shootout'` (singular) flagged for slice 005; `provider_sync_runs` and `match_pending_review` use `bigserial`/text-CHECK enums internally; `tournament_config` uses `providers.active` (with `s`). As-built migrations are now authoritative; `data-model.md` is historical.
- **D-007** (slice 002, tasks.md line 65, T020 catalog route field-name mapping) — Catalog route projects `home_score_official` / `away_score_official` from the split columns + extra-time + penalty columns; `_for_scoring` passes through; `approved_at = recorded_at`; `result_status` enum mapped (`'penalty_shootout'` → `'penalties_shootout'`); both `kickoff_utc_asc/desc` and `kickoff_asc/desc` accepted on the wire.
- **D-008** (slice 002, NEW — T026 `record_match_result_emits_notification.sql`) — pgTAP's `BEGIN/ROLLBACK` envelope cannot observe `pg_notify` channel reception; the test asserts `lives_ok` on the SP call + `is(count, 1)` on the `match_results` insert as a structural proxy. Real channel-payload verification deferred to Slice 005's Deno integration test.
- **D-009** (slice 002, NEW — T026 `record_match_result_audit_format.sql`) — Migration 0025 emits `'match_result.recorded'` (INSERT) / `'match_result.updated'` (UPDATE); contract `match-results.write.md` names the UPDATE action `'match_result.corrected'`. T029 must decide: honor the migration's existing actions OR re-author 0025 to match the contract. The pgTAP file asserts only the agreed-on `'match_result.recorded'` so it does not gate the decision.

---

## Sign-off checklist (for the Slice 002 US2 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] Deno installed on the verifying machine (`deno --version` succeeds).
- [ ] RED run completed (per the stash-and-test recipe above); transcript or CI link recorded. All 15 RED units fail with the documented signature.
- [ ] GREEN run completed; transcript or CI link recorded. All 15 RED units pass (with the D-008 structural-proxy caveat for `record_match_result_emits_notification.sql` and the D-009 action-name caveat for `record_match_result_audit_format.sql`).
- [ ] T029's D-009 disposition decided (honor `match_result.updated` OR re-author 0025).
- [ ] PR description references this file by path: `specs/002-match-catalog/red-gate-us2.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.

Until every box above is ticked, Slice 002 does not satisfy Constitution Principle IX for US2 and must not merge.
