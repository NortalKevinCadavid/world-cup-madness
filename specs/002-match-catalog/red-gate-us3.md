# RED Gate — Slice 002 / User Story 3 (US3)

**Slice**: `002-match-catalog`
**Phase**: 5 (US3 — "Catalog usable during provider failure: empty/undersized/duplicate payloads, per-row conflict quarantine, sustained-outage alerts deduplicated")
**Date**: 2026-05-20
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T038 (the Principle IX gate task for US3)

---

## Status: DEFERRED

**This gate was NOT executed.** Two distinct runtime dependencies were unavailable on the executing machine — the same dual gap that deferred T018 (US1) and T028 (US2):

1. **The Docker daemon required by `supabase start`** (and therefore by the Edge Function runtime any `POST /functions/v1/sync-catalog` test depends on, and by the Playwright suite which boots the local Supabase stack as a fixture) was **down at the time of execution**.
2. **Deno is not installed locally** (`deno --version` not on PATH). The seven Deno test files authored under T034–T036 require Deno to execute — `deno test --allow-all` is the only supported runner for Edge Function tests; the Supabase CLI does not bundle Deno for use outside of `supabase functions serve`.

Both gaps must be closed before the verification recipe at the bottom of this document can run. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-5 tests authored in T034, T035, T036, and T037 are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up AND Deno is installed.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 002 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 5 (US3) produced **10 RED-state test files** (7 Deno test files + 3 Playwright specs). T034 contributes 3 payload-structural-anomaly Deno tests; T035 contributes 2 per-row-conflict Deno tests; T036 contributes 2 sustained-outage Deno tests (alert-dedup + recovery); T037 contributes 3 end-to-end Playwright specs that exercise the same three concerns from the participant-visible side.

**Total: 7 Deno sub-tests + 3 Playwright tests = 10 behaviorally-distinct RED units.**

| # | Test file | Test type | Test count | Expected status PRE-T039/T040/T041 ship | GREEN implementer |
|---|-----------|-----------|------------|-----------------------------------------|-------------------|
| 1 | `supabase/functions/sync-catalog/tests/empty_payload_rejected.test.ts` | Deno (`@slice-002 @us3`) | 1 sub-test | **RED**. Mutates the stub fixture to `[]` and POSTs `/functions/v1/sync-catalog` with `X-Internal-Auth` + `trigger='manual_internal'`. T032's coordinator has no R-004 payload-sanity guard yet, so the empty array flows through to the apply step — depending on whether T032 errors or applies, the test fails on `expect(response.status).toBe(422)` or on `outcome === 'rejected_empty'` or on the `matches` post-state assertion (count must remain 8) or on the `audit_log.action='provider.sync_rejected_empty'` assertion. The fixture is restored byte-for-byte in `finally`. | T039 (`supabase/functions/sync-catalog/index.ts` payload-sanity guards: empty + undersized + in-payload duplicate). |
| 2 | `supabase/functions/sync-catalog/tests/undersized_payload_rejected.test.ts` | Deno (`@slice-002 @us3`) | 1 sub-test | **RED**. Mutates the stub fixture to the first 3 of 8 rows (37.5% < the default 50% threshold) and POSTs. Without T039's threshold guard the run either applies (failing the unchanged-count assertion) or errors out for an unrelated reason (failing the `outcome='rejected_undersized'` assertion). Also asserts the corresponding audit row `provider.sync_rejected_undersized`. | T039. |
| 3 | `supabase/functions/sync-catalog/tests/duplicate_in_payload_rejected.test.ts` | Deno (`@slice-002 @us3`) | 1 sub-test | **RED**. Rewrites the fixture so two rows share the same provider `id` (collides row 2 onto row 1's id) and POSTs. Without T039 the coordinator either applies one of the two arbitrarily (violating spec Edge Case "MUST NOT pick one arbitrarily") or fails for an unrelated reason. Asserts `outcome='rejected_duplicate_in_payload'`, `matches` count unchanged at 8 (structural=abort the WHOLE run), and audit row `provider.sync_rejected_duplicate`. | T039. |
| 4 | `supabase/functions/sync-catalog/tests/cross_run_conflict_quarantined.test.ts` | Deno (`@slice-002 @us3`) | 1 sub-test | **RED**. Rewrites stub-match-1 so the away team flips from MEX to BRA (team-assignment change). T040 hasn't shipped, so the coordinator either silently UPDATEs the row (violating Principle II + spec Q2 hybrid policy) or aborts the whole run. Asserts `outcome IN ('conflict_quarantined','partial')`, exactly one `match_pending_review` row with `conflict_class='team_assignment_change'` (as-built CHECK whitelist per D-006 — NOT `_changed`), and the M1 `matches` row UNCHANGED. | T040 (per-row quarantine logic in the coordinator). |
| 5 | `supabase/functions/sync-catalog/tests/score_before_kickoff_quarantined.test.ts` | Deno (`@slice-002 @us3`) | 1 sub-test | **RED**. Attaches a non-null `result` object to stub-match-3 while M3's `matches.status` remains `'scheduled'`. T040 absent, so either the score lands in `match_results` (leaking a premature score into Slice 005's scoring path) or the whole run aborts. Asserts the quarantine row with `conflict_class='score_before_finished'` (D-006 as-built name, NOT `score_before_kickoff`) and that `match_results` for M3 was NOT inserted. | T040. |
| 6 | `supabase/functions/sync-catalog/tests/outage_alert_dedup.test.ts` | Deno (`@slice-002 @us3 @sc-003`) | 1 sub-test | **RED**. Shrinks `notifications.outage_threshold_minutes` to 1, renames the fixture aside so every `fetchFixtures()` raises ENOENT, and triggers 3 failing POSTs spaced via service-role-backdated `provider_sync_state.first_failure_after_success_at` (no live `setTimeout`). Without T041 the coordinator emits zero `provider.outage_alert_emitted` audit rows, so the `count === 1` assertion reads 0. The `finally` block restores both the fixture and the config key. | T041 (R-008 outage-alert dedup ledger: first-qualifying-failure emits; subsequent failures with `outage_alert_emitted_at IS NOT NULL` are deduped). |
| 7 | `supabase/functions/sync-catalog/tests/recovery_clears_outage_state.test.ts` | Deno (`@slice-002 @us3 @sc-003`) | 1 sub-test | **RED**. Seeds `provider_sync_state` to look like an active, already-alerted outage (`first_failure_after_success_at` 10m ago, `outage_alert_emitted_at` 5m ago) and triggers a successful sync. Without T041 the coordinator does not write a `provider.recovered` audit row and does not NULL the dedup ledger columns — so a future second outage would not re-arm. Asserts (a) 200 OK with a happy outcome, (b) both ledger columns NULL, and (c) exactly one new `provider.recovered` audit row. | T041. |
| 8 | `apps/web/tests/playwright/slice-002-empty-payload-served-last-known.spec.ts` | Playwright (`@slice-002 @us3`) | 1 test | **Doubly RED**. Snapshots the fixture, replaces it with an empty array, POSTs the sync, signs in as `alpha@nortal.com`, and navigates to `/matches`. Without T039 the POST either errors out or applies the empty payload (wiping the catalog) — and the page assertion ("all 8 prior matches still rendered, no error UI") fails. Also asserts the service-role view of `audit_log` contains a `provider.sync_rejected_empty` row from this run. | T039 (sync coordinator's empty-payload guard) + T021 (already shipped — the participant catalog page that renders the last-known-good rows). |
| 9 | `apps/web/tests/playwright/slice-002-conflict-quarantined.spec.ts` | Playwright (`@slice-002 @us3`) | 1 test | **Doubly RED**. Signs in, sanity-checks that `/matches` shows ARG vs MEX for M1, rewrites the stub fixture so stub-match-1 away team becomes BRA, triggers the sync, reloads `/matches`. Without T040 the conflicting sync either silently overwrites M1 (the page now shows ARG vs BRA — assertion fails) or aborts the run (the `match_pending_review` row count is 0 — assertion fails). Both branches are valid RED signatures. | T040 + T021 (already shipped). |
| 10 | `apps/web/tests/playwright/slice-002-outage-alert-dedup.spec.ts` | Playwright (`@slice-002 @us3 @sc-003`) | 1 test | **Triply RED**. Sets `notifications.outage_threshold_minutes=1` via `withTemporaryConfig`, mutates the fixture to malformed JSON so every `fetchFixtures()` throws, triggers three failing POSTs (with `first_failure_after_success_at` backdated by 2 minutes between each), and asserts exactly one `provider.outage_alert_emitted` audit row exists since the test started. Without T041 the count is 0; without T039 the malformed JSON might short-circuit before the failure-ledger update; without the coordinator distinguishing fail-state from rejection-state the alert ledger may not advance at all. | T041 + T039 + T021 (already shipped). |

---

## Implementation note — RED state inferred, not observed (TDD caveat)

In this session (2026-05-20, Auto mode, Docker daemon down + Deno not installed), the GREEN-implementation tasks for US3 — **T039 (payload-sanity guards), T040 (per-row conflict quarantine), T041 (outage-alert dedup + recovery)** — **may be authored in the same agentic session** as the T034–T037 RED tests, without an intervening live test run to *observe* the RED state.

The expected failure signatures in the inventory above are inferred from straightforward "guard not shipped" / "quarantine branch not implemented" / "audit row not written" reasoning — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 002.** The recipe mirrors the slice 001 and US1/US2 patterns:

1. Install Deno (`winget install denoland.deno` on Windows; equivalent platform-specific install elsewhere) and start Docker Desktop; wait for both to be healthy.
2. From the repo root, stash the US3 GREEN implementation files so the working tree returns to its pre-T039/T040/T041 state:
   ```powershell
   git stash push -m "slice-002 US3 GREEN stash for RED verification" `
     supabase/functions/sync-catalog/index.ts
   ```
   (T039, T040, and T041 all extend the same `sync-catalog/index.ts` coordinator. If T040/T041 introduce additional helper modules under `supabase/functions/_shared/`, add those paths to the stash command. Exact filenames may differ — substitute the actual filenames produced by T039–T041.)
3. Run the verification commands in the next section. Every test in the inventory MUST fail with the documented signature. Capture the output.
4. Restore the GREEN implementation:
   ```powershell
   git stash pop
   ```
5. Re-run the same verification commands. Every test in the inventory MUST now pass.
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

# 2. Reset the database — applies all 22 migrations (slice 001's 0001..0017 + slice
#    002's 0018..0028) and loads both seed fixtures
#    (supabase/seed/slice-001-fixture.sql + supabase/seed/slice-002-fixture.sql).
supabase db reset

# 3. Run the 7 US3 Deno test files. They self-skip without the env vars set, so
#    RUN_SYNC_CATALOG_TESTS=1 + Supabase URL/keys + SYNC_TRIGGER_SECRET must all
#    be present. The web app's .env.local file holds the three Supabase vars;
#    RUN_SYNC_CATALOG_TESTS=1 must be exported explicitly per session.
cd supabase/functions/sync-catalog/tests
$env:RUN_SYNC_CATALOG_TESTS = "1"
deno test --allow-all --env-file=../../../../apps/web/.env.local `
  empty_payload_rejected.test.ts `
  undersized_payload_rejected.test.ts `
  duplicate_in_payload_rejected.test.ts `
  cross_run_conflict_quarantined.test.ts `
  score_before_kickoff_quarantined.test.ts `
  outage_alert_dedup.test.ts `
  recovery_clears_outage_state.test.ts
cd ../../../..

# 4. Typecheck the sync coordinator + any shared helpers it consumes — catches
#    contract-shape drift between provider-adapter types and the coordinator
#    body.
deno check supabase/functions/sync-catalog/index.ts

# 5. Run the US3 Playwright suite. The @slice-002 + @us3 tags are applied by
#    T037 via test.describe annotations. The three specs require
#    SYNC_INTERNAL_AUTH_SECRET + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in
#    apps/web/.env.local for the service-role audit_log / match_pending_review
#    queries.
pnpm -F web e2e -- --grep '@slice-002 @us3'
```

**Pass criteria for the GREEN run** (post-`git stash pop`, all of T039/T040/T041 shipped):

- All 7 Deno test files report `ok` for every sub-test:
  - `empty_payload_rejected.test.ts`: 422 + `outcome='rejected_empty'`; `matches` count stays at 8; one `provider.sync_rejected_empty` audit row.
  - `undersized_payload_rejected.test.ts`: 422 + `outcome='rejected_undersized'`; one `provider.sync_rejected_undersized` audit row.
  - `duplicate_in_payload_rejected.test.ts`: 422 + `outcome='rejected_duplicate_in_payload'`; one `provider.sync_rejected_duplicate` audit row.
  - `cross_run_conflict_quarantined.test.ts`: terminal outcome ∈ {`conflict_quarantined`,`partial`}; one `match_pending_review` row with `conflict_class='team_assignment_change'`; M1 `matches` row unchanged.
  - `score_before_kickoff_quarantined.test.ts`: quarantined; one `match_pending_review` row with `conflict_class='score_before_finished'`; no `match_results` insert for M3.
  - `outage_alert_dedup.test.ts`: exactly one `provider.outage_alert_emitted` audit row across three qualifying failures.
  - `recovery_clears_outage_state.test.ts`: happy outcome; both `first_failure_after_success_at` and `outage_alert_emitted_at` NULL; one new `provider.recovered` audit row.
- All 3 Playwright tests tagged `@slice-002 @us3` report `passed`.
- `deno check` on `sync-catalog/index.ts` returns clean.

**Pass criteria for the RED run** (between `git stash push` and `git stash pop`):

- The Deno tests fail because the coordinator either applies the malformed payload, errors out before writing the rejection ledger row, or never writes the expected audit-action — *not* for a syntax error in the test file itself, a missing fixture row, a missing env var, or a Deno-runtime failure.
- The Playwright specs fail because either the page renders mutated data (the catalog was overwritten — proving the guard is absent) or the expected audit row count is 0 — *not* because the sign-in fixture failed or the page route is missing.
- `deno check` on `sync-catalog/index.ts` may pass against the stashed-out (US2-only) baseline — that is acceptable; it would only fail here if T039/T040/T041 introduced new shared modules and `sync-catalog/index.ts` was stashed but those modules weren't.

If both criteria hold, the Principle IX gate is observationally satisfied for US3 and Slice 002 is cleared to merge from a US3 perspective. (The US1 gate, documented in `red-gate-us1.md`, and the US2 gate, documented in `red-gate-us2.md`, must also be satisfied.)

---

## Cumulative spec deviations

The full running log lives in `specs/002-match-catalog/tasks.md` § Implementation deviations (which inherits D-001..D-005 from slice 001 via `specs/001-eligibility-login/tasks.md`). Cross-referenced one-liners for review:

- **D-001** (slice 001, T004) — Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`. US3's sync-catalog Edge Function tests inherit via shared eligibility plumbing.
- **D-002** (slice 001, T019/T022) — `is_approved_domain(p_email text)` accepts a full email and extracts the domain internally. US3's Playwright specs reuse this via the eligible-participant sign-in fixture.
- **D-003** (slice 001, T028) — `/api/me` response body locked to `{ participant: {...} }` / `{ error: {...} }` envelope with `Cache-Control: private, max-age=0, must-revalidate`. US3's catalog reads reuse the same envelope.
- **D-004** (slice 001, T034) — `participants_self_or_admin_read` policy already embeds the eligibility predicate (front-loaded). US3's mid-failure catalog reads go through the same combined policy.
- **D-005** (slice 001, T038) — `handle_auth_user_signed_in` returns the `custom_access_token` envelope (`{claims}` / `{error}`), not `{decision}`. Relevant to US3 only insofar as the catalog page's session refresh path traverses this hook.
- **D-006** (slice 002, T003–T011 wave-2 schema reconciliation) — Several Phase-2 migrations diverged from `data-model.md`: `match_status` canonical enum fixed inline; `match_results` keeps split columns + LOCKED `_for_scoring` names; `result_status` uses `'penalty_shootout'` (singular) flagged for slice 005; `provider_sync_runs` / `match_pending_review` use `bigserial`/text-CHECK enums; `tournament_config` uses `providers.active` (with `s`). **The `match_pending_review.conflict_class` CHECK whitelist is the load-bearing contract for T040 and T035: canonical values are `team_assignment_change`, `status_backward_transition`, `score_before_finished`, `kickoff_change_after_lock`, `unknown_team`, `other` — note `_change` (not `_changed`) and `score_before_finished` (not `score_before_kickoff` as the older research draft used).** As-built migrations are now authoritative; `data-model.md` is historical.
- **D-007** (slice 002, T020 catalog route field-name mapping) — Catalog route projects `home_score_official` / `away_score_official` from split columns + extra-time + penalty; `_for_scoring` passes through; `approved_at = recorded_at`; `result_status` enum mapped (`'penalty_shootout'` → `'penalties_shootout'`); both `kickoff_utc_asc/desc` and `kickoff_asc/desc` accepted on the wire.
- **D-008** (slice 002, T026 `record_match_result_emits_notification.sql`) — pgTAP's `BEGIN/ROLLBACK` envelope cannot observe `pg_notify` channel reception; structural-proxy assertions used. Real channel-payload verification deferred to Slice 005's Deno integration test.
- **D-009** (slice 002, T026 `record_match_result_audit_format.sql`) — Migration 0025 emits `'match_result.recorded'`/`'match_result.updated'`; contract names the UPDATE action `'match_result.corrected'`. T029 picks the spelling; pgTAP file only asserts the agreed-on INSERT path.
- **D-010** (slice 002, T032/T033) — Three concrete drifts between the `sync-catalog` coordinator, the US2 Deno tests, and migration 0022: (1) `outcome='success_no_changes'` returned on the wire but `'success'` stored in `provider_sync_runs` due to the migration's CHECK; (2) the US2 happy-path test asserts `.eq('id', runId)` and SELECTs `provider_name` but the migration uses `bigserial id` + `correlation_id uuid` + a column named `provider`; (3) several US2 test fixtures post `trigger='cron'` / `'admin_manual'` / `'swap-test'` but the migration's CHECK accepts only `'scheduled'`/`'manual_admin'`/`'manual_internal'` — **US3's Deno tests (T034–T036) all use `trigger='manual_internal'` to avoid this CHECK failure.** Recorded in detail in `regression-checkpoint-us2.md § 7`.

---

## Sign-off checklist (for the Slice 002 US3 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] Deno installed on the verifying machine (`deno --version` succeeds).
- [ ] RED run completed (per the stash-and-test recipe above); transcript or CI link recorded. All 10 RED units fail with the documented signature.
- [ ] GREEN run completed; transcript or CI link recorded. All 10 RED units pass.
- [ ] PR description references this file by path: `specs/002-match-catalog/red-gate-us3.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.

Until every box above is ticked, Slice 002 does not satisfy Constitution Principle IX for US3 and must not merge.
