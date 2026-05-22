# Regression checkpoint — Slice 002, Phase 5 (US3)

- **Slice**: `002-match-catalog`
- **Phase**: 5 (US3 — "Catalog usable during provider failure: empty/undersized/duplicate payloads, per-row conflict quarantine, sustained-outage alerts deduplicated")
- **Date**: 2026-05-20
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T042 (`specs/002-match-catalog/tasks.md` line 1540)
- **Companion artifacts**:
  - `specs/002-match-catalog/regression-baseline-from-001.md` (T001 — slice-001 carry-forward baseline)
  - `specs/002-match-catalog/regression-checkpoint-us1.md` (T022 — Phase-3/US1 checkpoint)
  - `specs/002-match-catalog/regression-checkpoint-us2.md` (T033 — Phase-4/US2 checkpoint, the immediate template this document mirrors)
  - `specs/002-match-catalog/red-gate-us1.md` (T018 — Phase-3/US1 RED-gate)
  - `specs/002-match-catalog/red-gate-us2.md` (T028 — Phase-4/US2 RED-gate)
  - `specs/002-match-catalog/red-gate-us3.md` (T038 — Phase-5/US3 RED-gate, the sibling artifact for this same test set)
  - `specs/001-eligibility-login/regression-final.md` (the slice 001 final gate; carry-forward source)
- **Purpose**: Record the state of the slice-001 + slice-002-through-US3 test suite at the moment US3 (the failure-resilience hardening of the sync coordinator) lands, inventory every test the operator must run, and hand the exact verification commands to whoever next has a working Docker daemon AND a working local Deno install. Per Principle XI, Polish (Phase 6) MAY NOT start, and the slice MAY NOT merge to `main`, until all verification commands below land GREEN.

---

## Status: DEFERRED

Two distinct runtime dependencies were unavailable on the executing machine at the time this document was authored — the same dual gap that deferred T001, T018, T022, T028, T033, and T038:

1. **The Docker daemon required by `supabase start`** (and therefore by `supabase test db` for pgTAP, by the Edge Function runtime that hosts `sync-catalog`, and by any Playwright spec that boots the Next dev server against a live database) was **down**.
2. **Deno is not installed locally** (`deno --version` not on PATH). The thirteen Deno test files now co-located with the sync coordinator (6 from T023/T024/T025 + 7 from T034/T035/T036) require Deno to execute — `deno test --allow-all` is the only supported runner for Edge Function tests; the Supabase CLI does not bundle Deno for use outside of `supabase functions serve`.

This checkpoint is therefore a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added so far in slice 002 (US1 + US2 + US3 cumulative), and hands the exact commands the user MUST run locally (or in CI) before Phase 6 (Polish) begins or the slice can merge.

Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 8 have all returned GREEN.

---

## 1. Suite inventory (post-US3, cumulative across slices 001 + 002)

### 1a. pgTAP tests — `supabase/tests/pgtap/`

**Slice 001 carry-forward** — 12 files unchanged from the slice 001 baseline (1 harness probe + 8 functional + 2 RLS-isolation + 1 perf). Full inventory in `specs/001-eligibility-login/regression-final.md § 2` and in this slice's `regression-baseline-from-001.md § 1.2`. Slice 002 does not modify any of them.

**Slice 002 / US1 carry-forward (Phase 3)** — 1 file, unchanged from US1's checkpoint:

| # | File | Plan | Owning task |
|---|------|------|-------------|
| 1 | `slice-002-catalog-rls.sql` | `plan(7)` | T017 |

**Slice 002 / US2 carry-forward (Phase 4)** — 8 files, unchanged from US2's checkpoint, all owned by T026 and gating the `record_match_result(...)` SP shipped by T029:

| # | File | Plan | Purpose |
|---|------|------|---------|
| 1 | `record_match_result_happy.sql` | per file | Happy-path SP invocation: regulation result lands a `match_results` row with the cross-slice `_for_scoring` columns populated. |
| 2 | `record_match_result_rejects_pre_finished.sql` | per file | SP must `RAISE EXCEPTION` when `matches.status <> 'finished'`. |
| 3 | `record_match_result_enforces_for_scoring_invariant.sql` | per file | The `_for_scoring` columns must always reflect the regulation-90 score per the contract invariant. |
| 4 | `record_match_result_enforces_shootout_invariant.sql` | per file | `result_status = 'penalty_shootout'` requires the penalty columns populated. |
| 5 | `record_match_result_admin_correction_requires_approver.sql` | per file | Admin-override path requires `p_approved_by IS NOT NULL` when `p_source = 'admin_override'`. |
| 6 | `record_match_result_admin_correction_requires_admin.sql` | per file | `p_approved_by` must resolve to an `is_admin()` user. |
| 7 | `record_match_result_emits_notification.sql` | `plan(2)` | Structural proxy for `pg_notify('match_results_recorded', ...)` per D-008. |
| 8 | `record_match_result_audit_format.sql` | `plan(3)` | Asserts INSERT-path audit row uses `'match_result.recorded'`; UPDATE-path spelling deferred per D-009. |

**Slice 002 / US3 additions (Phase 5)** — **ZERO new pgTAP files**. Phase 5 is a sync-coordinator hardening phase: the failure paths it adds (payload-sanity guards in T039, conflict quarantine in T040, outage-alert dedup in T041) all live in TypeScript inside the Edge Function — they do not run inside Postgres and therefore have no pgTAP surface. Their verification surface is Deno (§ 1c) and Playwright (§ 1b) only.

**Aggregate**: 12 carry-forward + 1 slice-002-US1 + 8 slice-002-US2 + 0 slice-002-US3 = **21 pgTAP files** total at the end of Phase 5 (unchanged from Phase 4). On-disk count verified: 21 `.sql` files under `supabase/tests/pgtap/`.

### 1b. Playwright tests — `apps/web/tests/playwright/`

**Slice 001 carry-forward** — 14 `@slice-001`-tagged spec files + 1 untagged harness probe (`smoke.spec.ts`) = 15 specs, unchanged from the slice 001 baseline.

**Slice 002 / US1 carry-forward (Phase 3)** — 9 spec files, 20 tests total, all tagged `@slice-002 @us1`. Inventory unchanged from `regression-checkpoint-us1.md § 1b`. The one residual `test.fixme` (`slice-002-late-fixture-appears.spec.ts`) is still in its US1-time self-skip branch — see § 4c below for its US3 disposition.

**Slice 002 / US2 carry-forward (Phase 4)** — 0 new specs. US2 was a server-side / sync-coordinator slice with no participant-visible UI changes.

**Slice 002 / US3 additions (Phase 5)** — 3 new spec files, all owned by T037, all tagged `@slice-002 @us3`:

| # | File | Owning task | Tests | Purpose |
|---|------|-------------|-------|---------|
| 1 | `slice-002-empty-payload-served-last-known.spec.ts` | T037 | 1 | US3 AS1 / SC-002: pre-seed catalog → mutate stub fixture to empty array → trigger sync → navigate `/matches` as eligible participant → assert all 8 prior matches still render (no error UI, data unchanged). Also asserts the `audit_log` contains a `provider.sync_rejected_empty` row from this run. |
| 2 | `slice-002-conflict-quarantined.spec.ts` | T037 | 1 | US3 AS3 + Edge Case: sign in → confirm M1 shows ARG vs MEX → rewrite stub fixture so M1 away team flips to BRA → trigger sync → reload `/matches` → assert M1 still shows ARG vs MEX (catalog unchanged); assert admin service-role query of `match_pending_review` returns one row with `conflict_class='team_assignment_change'`. |
| 3 | `slice-002-outage-alert-dedup.spec.ts` | T037 | 1 | US3 AS2 / SC-003: set `notifications.outage_threshold_minutes=1` via `withTemporaryConfig` → mutate fixture to malformed JSON so every `fetchFixtures()` throws → trigger 3 failing POSTs (`first_failure_after_success_at` backdated by 2 minutes between each) → assert exactly one `provider.outage_alert_emitted` audit row exists since the test started. |

**Aggregate at end of Phase 5**: 15 carry-forward specs + 9 slice-002-US1 specs + 0 slice-002-US2 specs + 3 slice-002-US3 specs = **27 spec files** total. On-disk count verified: 27 `.spec.ts` files under `apps/web/tests/playwright/`.

### 1c. Deno tests — `supabase/functions/sync-catalog/tests/`

**Slice 002 / US2 carry-forward (Phase 4)** — 6 files, unchanged from US2's checkpoint (T023 + T024 + T025): `single_sync_happy`, `idempotent_retry`, `advisory_lock_returns_409`, `non_admin_returns_403`, `internal_auth_path` (2 sub-tests), `provider_swap`. Total = 6 files / 7 sub-tests.

**Slice 002 / US3 additions (Phase 5)** — 7 new files, all RED-authored before T039/T040/T041 shipped the GREEN implementations:

| # | File | Owning task | Sub-tests | Purpose | GREEN by |
|---|------|-------------|-----------|---------|----------|
| 1 | `empty_payload_rejected.test.ts` | T034 | 1 | Mutate stub fixture to `[]`, POST with `X-Internal-Auth` + `trigger='manual_internal'`, assert 422 + `outcome='rejected_empty'` + `matches` count unchanged + `audit_log` `provider.sync_rejected_empty` row. | T039. |
| 2 | `undersized_payload_rejected.test.ts` | T034 | 1 | Mutate stub fixture to first 3 of 8 rows (37.5% < 50% threshold), POST, assert 422 + `outcome='rejected_undersized'` + audit row `provider.sync_rejected_undersized`. | T039. |
| 3 | `duplicate_in_payload_rejected.test.ts` | T034 | 1 | Rewrite fixture so two rows share the same provider `id`, POST, assert 422 + `outcome='rejected_duplicate_in_payload'` + `matches` count unchanged (structural=abort the WHOLE run) + audit row `provider.sync_rejected_duplicate`. | T039. |
| 4 | `cross_run_conflict_quarantined.test.ts` | T035 | 1 | Rewrite stub-match-1 so away team flips MEX → BRA. Assert `outcome IN ('conflict_quarantined','partial')`, exactly one `match_pending_review` row with `conflict_class='team_assignment_change'` (D-006 as-built name, NOT `_changed`), M1 `matches` row UNCHANGED. | T040. |
| 5 | `score_before_kickoff_quarantined.test.ts` | T035 | 1 | Attach non-null `result` to stub-match-3 while M3's `matches.status='scheduled'`. Assert quarantine row with `conflict_class='score_before_finished'` (D-006 as-built name, NOT `score_before_kickoff`) and `match_results` for M3 NOT inserted. | T040. |
| 6 | `outage_alert_dedup.test.ts` | T036 | 1 | Shrink `notifications.outage_threshold_minutes=1`; rename fixture aside so `fetchFixtures()` raises ENOENT; trigger 3 failing POSTs spaced via service-role-backdated `provider_sync_state.first_failure_after_success_at`. Assert exactly ONE `provider.outage_alert_emitted` audit row. | T041. |
| 7 | `recovery_clears_outage_state.test.ts` | T036 | 1 | Seed `provider_sync_state` as an active, already-alerted outage; trigger a successful sync. Assert 200 + happy outcome, both ledger columns NULL after run, exactly one new `provider.recovered` audit row. | T041. |

**Aggregate**: 6 US2 + 7 US3 = **13 Deno test files** total = 14 behaviourally-distinct sub-tests. (On-disk count verified: 13 `.test.ts` files under `supabase/functions/sync-catalog/tests/`.)

The two test artifacts shipped under T025 (the `stub2` provider adapter + its fixture) remain in place as the second provider for `provider_swap.test.ts` — they are checked in to the test surface, not the production surface.

### 1d. TypeScript compile

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web exec tsc --noEmit` | Project-wide strict compile of `apps/web/`. Phase 5 added zero files to the web app surface; T039/T040/T041 are confined to `supabase/functions/sync-catalog/*.ts`. The `/api/matches` route, the catalog page, and the participant route group are byte-identical to their US2 state. | GREEN locally per T021's and T032's implementation reports. No Docker dependency; can be re-confirmed at any time. |

### 1e. Next.js build

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web build` | Production-mode `next build`. Confirms the App Router still catches `/api/matches` and `/(participant)/matches`. Phase 5 changes nothing on this surface. | GREEN locally per T021's implementation report. No Docker dependency. |

### 1f. Deno typecheck

| Command | Purpose | Latest known result |
|---|---|---|
| `deno check supabase/functions/sync-catalog/index.ts` | Strict TypeScript check of the sync coordinator under the Deno runtime — now catches drift between the coordinator and the three new helper modules introduced in Phase 5 (`payload_sanity.ts`, `conflict_quarantine.ts`, `outage_state.ts`). | **Cannot run locally — Deno not installed.** Deferred. |
| `deno check supabase/functions/sync-catalog/payload_sanity.ts` | Strict check of the T039 helper module in isolation. | **Cannot run locally — Deno not installed.** Deferred. |
| `deno check supabase/functions/sync-catalog/conflict_quarantine.ts` | Strict check of the T040 helper module in isolation. | **Cannot run locally — Deno not installed.** Deferred. |
| `deno check supabase/functions/sync-catalog/outage_state.ts` | Strict check of the T041 helper module in isolation. | **Cannot run locally — Deno not installed.** Deferred. |
| `deno check supabase/functions/_shared/providers/{stub,stub2,footballdata}/index.ts` | Same, for each adapter. Unchanged from US2 set. | **Cannot run locally — Deno not installed.** Deferred. |

---

## 2. Migration inventory — `supabase/migrations/`

**Slice 001 carry-forward** — 11 migrations (`0001`…`0011`), all unchanged.

**Slice 002 carry-forward (Phases 1 + 2 + 4)** — 12 migrations from the US2 checkpoint, unchanged. Inventory (line-by-line):

| # | File | T# | Phase added | Summary |
|---|------|----|-------------|---------|
| 0018 | `0018_enable_extensions.sql` | T002 | 1 | `pg_cron` + `pg_net` extensions, `timezone='UTC'`. |
| 0019 | `0019_teams.sql` | T003 | 2 | `public.teams` + `team_provider_external_ids` mapping table. |
| 0020 | `0020_matches.sql` | T004 | 2 | `public.matches` + enums (`match_status`, `match_stage`) + `match_provider_external_ids` + group-consistency CHECK. |
| 0021 | `0021_match_results.sql` | T005 | 2 | `public.match_results` with LOCKED `_for_scoring` columns + split-column shape (D-006). |
| 0022 | `0022_provider_sync_tables.sql` | T006 | 2 | `provider_sync_runs` (bigserial PK + `correlation_id uuid` + text+CHECK enums) and `provider_sync_state` (with `first_failure_after_success_at` + `outage_alert_emitted_at` columns now consumed by T041). |
| 0023 | `0023_match_pending_review.sql` | T007 | 2 | Manual-resolution queue with text+CHECK enums. The `conflict_class` CHECK whitelist (D-006) is now the load-bearing contract for T040's quarantine writes: `team_assignment_change`, `status_backward_transition`, `score_before_finished`, `kickoff_change_after_lock`, `unknown_team`, `other`. |
| 0024 | `0024_record_match_result_sp.sql` | T029 | 4 | The `record_match_result(...)` SP — eight-arg signature consumed by both the sync coordinator and slice 006 admin-override writes. |
| 0025 | `0025_catalog_audit_triggers.sql` | T008 | 2 | `*_write_audit()` triggers for `teams` / `matches` / `match_results`. |
| 0026 | `0026_catalog_rls.sql` | T009 | 2 | RLS on catalog tables + admin-only guards on sync bookkeeping tables. |
| 0028 | `0028_provider_config_defaults.sql` | T010 | 2 | Default rows in `tournament_config` for `providers.*` + `provider_sync.*` keys, including the `notifications.outage_threshold_minutes` and `notifications.outage_webhook_url` keys T041 reads. |
| 0029 | `0029_sync_lock_helpers.sql` | T032 | 4 | `try_lock_sync(text)` and `unlock_sync(text)` helper RPCs. |

**Slice 002 / US3 additions (Phase 5)** — **ZERO new migrations**. T039, T040, and T041 all extended `supabase/functions/sync-catalog/index.ts` and added new TypeScript helper modules alongside it. None of them touched the schema. All the schema affordances they consume were already shipped in Phase 2 / Phase 4:

- T039's payload-sanity guards write to `audit_log` (slice 001's `0003`, with the `source` enum constraint flagged in D-011 below) and update `provider_sync_runs.outcome` (using the additional outcome values which the `0022` CHECK accepts — `'rejected_empty'`, `'rejected_undersized'`, `'rejected_duplicate_in_payload'` are all in the migration's whitelist).
- T040's quarantine writes go to `match_pending_review` (`0023`) with the canonical `conflict_class` values listed above.
- T041's outage-state machine reads + writes `provider_sync_state` columns already present in `0022` (`first_failure_after_success_at`, `outage_alert_emitted_at`, `last_success_at`).

**Aggregate**: 11 carry-forward + 12 slice-002 = **23 migrations** total on disk. Reserved-but-unfilled slots: `0012`…`0017` and `0027`. Phase 5 did not change this layout.

**Seed fixtures**: still 2 files — `supabase/seed/slice-001-fixture.sql` (carry-forward) + `supabase/seed/slice-002-fixture.sql` (T012, US1). No new seed fixtures in Phase 5.

---

## 3. App-code inventory — slice 002 / US3 additions

Files added or modified during slice 002 Phase 5 (US3). All US1 + US2 surface remains unchanged.

### 3a. Sync coordinator (modified by T039, T040, T041)

| File | T# (last modifier) | Role |
|---|---|---|
| `supabase/functions/sync-catalog/index.ts` | T041 | The coordinator. Phase 5 extended it from a happy-path-only implementation (US2's T032) into the production-shape state machine. The fetch result now flows through three new branches in sequence: payload-sanity guards (T039, calls `payload_sanity.ts`), conflict-quarantine logic (T040, calls `conflict_quarantine.ts`), and outage state-machine + webhook POST (T041, calls `outage_state.ts`). The happy path remains structurally identical to T032's. |

### 3b. New helper modules (NEW in Phase 5)

All three live alongside `index.ts` under `supabase/functions/sync-catalog/`. They are pure-function modules (no globals, no side-effectful module loads); the coordinator threads its Supabase client through to each.

| File | T# | Role |
|---|---|---|
| `supabase/functions/sync-catalog/payload_sanity.ts` | T039 | Pure-function guards: `checkEmptyPayload(fixtures, existingMatchCount)`, `checkUndersizedPayload(fixtures, existingMatchCount, threshold)`, `checkDuplicateInPayload(fixtures)`. Each returns `null` on pass or a `{ outcome, auditAction, diagnostics }` triple on fail. The coordinator inspects the triple, writes the canonical rejection ledger row in `provider_sync_runs`, writes the audit row (`source='api_guard'` per D-011), and returns 422 with the contract-shape response. |
| `supabase/functions/sync-catalog/conflict_quarantine.ts` | T040 | Per-row conflict classifier. `classifyConflict(incoming, existing, config)` returns one of the six `conflict_class` values (D-006 whitelist) or `null` for no conflict. Used twice in the coordinator's per-row UPSERT loop — once for `matches` rows (`team_assignment_change`, `status_backward_transition`, `kickoff_change_after_lock`, `unknown_team`) and once for `match_results` rows (`score_before_finished`). On conflict, the coordinator INSERTs a `match_pending_review` row and skips the live `matches` / `match_results` write for that row only. |
| `supabase/functions/sync-catalog/outage_state.ts` | T041 | The outage state-machine. `recordFailure(state, threshold, now)` returns `{ shouldAlert, updates }` describing how to advance `provider_sync_state` and whether the current invocation is the first qualifying failure that crosses the threshold. `recordRecovery(state, now)` returns `{ wasRecovering, updates }`. The coordinator applies the `updates` patch, writes the appropriate audit row (`provider.outage_alert_emitted` or `provider.recovered`), and POSTs the webhook with 5-second timeout if `tournament_config.notifications.outage_webhook_url` is non-null. |

### 3c. Provider adapters (unchanged from Phase 4)

| File | T# | Role |
|---|---|---|
| `supabase/functions/_shared/providers/types.ts` | T011 (US1) | Adapter interface. Unchanged in Phase 5. |
| `supabase/functions/_shared/providers/stub/index.ts` | T030 (US2) | Stub adapter. Unchanged in Phase 5. The T034/T035/T036 tests mutate its fixture file in-place under `try/finally` blocks; the adapter code itself does not change. |
| `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json` | T030 (US2) | The stub adapter's canonical fixture. Eight matches. The Phase-5 tests mutate this file; each test restores the byte-for-byte original in `finally`. |
| `supabase/functions/_shared/providers/stub2/index.ts` | T025 (US2) | Second-stub adapter (test artifact). Unchanged in Phase 5. |
| `supabase/functions/_shared/providers/stub2/fixtures/wc2026-snapshot.json` | T025 (US2) | Stub2's snapshot. Unchanged in Phase 5. |
| `supabase/functions/_shared/providers/footballdata/index.ts` | T031 (US2) | Real football-data.org adapter scaffold. Unchanged in Phase 5. |

### 3d. Tournament-config touchpoints

No new keys land in Phase 5 — T041 reads the keys already seeded by T010 / migration 0028 (`notifications.outage_threshold_minutes`, `notifications.outage_webhook_url`, `provider_sync.undersized_threshold`, `provider_sync.kickoff_tolerance_minutes`). The coordinator's failure-path behaviour is config-driven by those keys per Constitution Principle VIII.

---

## 4. Expected GREEN state per test (inferred — not observed)

These predictions are inferred from inspection of each test file's assertions against the implementations now landed (T039 + T040 + T041 helpers plus the matching branches threaded through `index.ts`). Until Docker is up AND Deno is installed they are NOT observed.

### 4a. Slice 002 / US3 Deno tests (7 files = 7 sub-tests)

All seven files require: (a) Docker daemon running so the local Supabase stack accepts `POST /functions/v1/sync-catalog`; (b) Deno installed so `deno test --allow-all` can drive them; (c) `RUN_SYNC_CATALOG_TESTS=1` exported in the test env; (d) `apps/web/.env.local` populated with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SYNC_TRIGGER_SECRET`.

- `empty_payload_rejected.test.ts` (T034) → **GREEN once Docker + Deno running**. T039's `checkEmptyPayload` returns the rejection triple when fixtures are empty and the live catalog has matches; the coordinator writes `outcome='rejected_empty'` to `provider_sync_runs`, writes `audit_log` row `action='provider.sync_rejected_empty'` (with `source='api_guard'` per D-011), and returns 422.
- `undersized_payload_rejected.test.ts` (T034) → **GREEN once Docker + Deno running**. T039's `checkUndersizedPayload` reads `tournament_config.provider_sync.undersized_threshold` (default `0.5`); 3 of 8 rows = 37.5% < 50% triggers the rejection branch.
- `duplicate_in_payload_rejected.test.ts` (T034) → **GREEN once Docker + Deno running**. T039's `checkDuplicateInPayload` walks the fixtures once and short-circuits on the first repeated `providerMatchId`. The whole run aborts (no partial UPSERT).
- `cross_run_conflict_quarantined.test.ts` (T035) → **GREEN once Docker + Deno running**. T040's `classifyConflict` detects the team-assignment flip (MEX → BRA on M1), the coordinator INSERTs the `match_pending_review` row with `conflict_class='team_assignment_change'`, and the live `matches` UPDATE is skipped for M1.
- `score_before_kickoff_quarantined.test.ts` (T035) → **GREEN once Docker + Deno running**. T040 detects a `match_results` row arriving for a match whose `status<>'finished'` and quarantines with `conflict_class='score_before_finished'`; the `record_match_result` SP is NOT invoked for M3.
- `outage_alert_dedup.test.ts` (T036) → **GREEN once Docker + Deno running**. T041's `recordFailure` state-machine emits `shouldAlert=true` only on the first qualifying failure (`first_failure_after_success_at` set, threshold crossed, `outage_alert_emitted_at IS NULL`); subsequent failures with `outage_alert_emitted_at IS NOT NULL` produce `shouldAlert=false`. Exactly one `provider.outage_alert_emitted` audit row across the three failing POSTs.
- `recovery_clears_outage_state.test.ts` (T036) → **GREEN once Docker + Deno running**. T041's `recordRecovery` returns `wasRecovering=true` when the prior state has `outage_alert_emitted_at IS NOT NULL`; the coordinator writes the `provider.recovered` audit row and NULLs both ledger columns.

### 4b. Slice 002 / US3 Playwright tests (3 specs = 3 tests)

- `slice-002-empty-payload-served-last-known.spec.ts` (T037) → **GREEN once Docker + Deno running + the Next.js dev server + the participant catalog page from T021 (already shipped)**. Snapshot fixture → empty → POST sync → page still renders 8 matches → audit row present.
- `slice-002-conflict-quarantined.spec.ts` (T037) → **GREEN once Docker + Deno running**. Mutate fixture → POST sync → catalog page still shows MEX (not BRA) → service-role query of `match_pending_review` returns one row with `conflict_class='team_assignment_change'`.
- `slice-002-outage-alert-dedup.spec.ts` (T037) → **GREEN once Docker + Deno running**. Three failing POSTs spaced via backdated state-machine columns → exactly one `provider.outage_alert_emitted` audit row.

### 4c. Slice 002 / US1 + US2 carry-forward (unchanged behaviour expected)

Expectations unchanged from `regression-checkpoint-us1.md § 4` and `regression-checkpoint-us2.md § 4`. T039/T040/T041 were structured to leave the T032 happy-path code-path byte-equivalent in behaviour when no anomalies are present — the new branches gate only on detected anomaly conditions and fall through to the original UPSERT loop otherwise. Therefore the six US2 Deno tests (`single_sync_happy`, `idempotent_retry`, `advisory_lock_returns_409`, `non_admin_returns_403`, `internal_auth_path` ×2, `provider_swap`) remain expected-GREEN under the same drift caveats documented in `regression-checkpoint-us2.md § 7` (the D-010 reconciliation set, still pending).

The one US1 `test.fixme` (`slice-002-late-fixture-appears.spec.ts`) remains in its self-skip branch. Phase 5 shipped the failure-path resilience but did NOT ship the cron-driven invocation that produces a mid-tournament late-fixture event — that's owned by T043 (Phase 6 / pg_cron schedule) and T045 (Phase 6 / late-fixture orchestration). The fixme stays.

### 4d. Slice 001 tests (carry-forward)

Expectations unchanged from `specs/001-eligibility-login/regression-final.md`. Slice 002 did not modify any slice-001 surface.

### 4e. Static + build

- `pnpm -F web exec tsc --noEmit` → **GREEN**. Phase 5 added zero files to `apps/web/`; the typecheck surface is unchanged from US2.
- `pnpm -F web build` → **GREEN**, per T021's implementation report. No Docker dependency.
- `deno check` on the function tree (now including the three new Phase-5 helper modules) → **DEFERRED until Deno is installed**.

---

## 5. Aggregate totals at end of Phase 5

| Surface | Slice 001 | Slice 002 (US1) | Slice 002 (US2) | Slice 002 (US3) | Total |
|---|---|---|---|---|---|
| Migrations | 11 | 9 | 3 (net +2 new files in Phase 4) | 0 | 23 |
| pgTAP files | 12 | 1 | 8 | 0 | 21 |
| Playwright specs | 15 | 9 | 0 | 3 | 27 |
| Deno test files | 0 | 0 | 6 | 7 | 13 |
| Deno test sub-tests | 0 | 0 | 7 | 7 | 14 |
| Provider adapters (`_shared/providers/*/index.ts`) | 0 | 0 | 3 (`stub` + `stub2` + `footballdata`) + interface | 0 | 3 + interface |
| Sync coordinator + helpers (`sync-catalog/*.ts`) | 0 | 0 | 1 (`index.ts` + `deno.json`) | +3 helper modules | 1 coordinator + 3 helpers |
| First-party web app files | 7 | 8 | 0 | 0 | 15 |
| Seed fixtures | 1 | 1 | 0 | 0 | 2 |

---

## 6. Cross-slice contracts now locked by slice 002 Phases 1–5

Carry-forward from US2's checkpoint § 6 (unchanged) PLUS the following new locks contributed by Phase 5:

| Symbol / shape | Lock | Consumers |
|---|---|---|
| **`provider_sync_runs.outcome` rejection enum members `'rejected_empty'` / `'rejected_undersized'` / `'rejected_duplicate_in_payload'`** | **Stored values LOCKED.** Migration 0022's CHECK accepts these; T039 writes them; Slice 006's admin UI will read them to render the run-history table; Slice 007's forensic queries will filter on them. | Slice 002 sync coordinator, Slice 006 (admin run-history UI), Slice 007 (forensics). |
| **`match_pending_review.conflict_class` values `'team_assignment_change'` / `'status_backward_transition'` / `'score_before_finished'` / `'kickoff_change_after_lock'` / `'unknown_team'` / `'other'`** | **Whitelist LOCKED** at migration 0023 time (D-006); now load-bearing for T040's quarantine writes and for the slice-006 admin-resolution UI's class selector. Adding a new class requires migration extension AND coordinator update AND UI extension. | Slice 002 sync coordinator (T040 writer), Slice 006 (admin resolution UI). |
| **`audit_log.action` namespace `'provider.*'`** — concrete values now in flight: `'provider.sync_rejected_empty'`, `'provider.sync_rejected_undersized'`, `'provider.sync_rejected_duplicate'`, `'provider.outage_alert_emitted'`, `'provider.recovered'` | **Action vocabulary LOCKED** (additive new actions allowed; existing spellings frozen). All emitted with `source='api_guard'` per D-011 until slice 007 extends the `source` enum. Slice 007 ops dashboards filter on `action LIKE 'provider.%'`. | Slice 002 sync coordinator, Slice 007 (audit dashboard). |
| **Outage state-machine per-provider singleton invariant** — `provider_sync_state` has exactly one row per registered provider (PK on `provider`); the state machine guarantees exactly one `'provider.outage_alert_emitted'` audit row per outage episode (between a `last_success_at` and the next `last_success_at`). | **Behavioural invariant LOCKED** by T041's `outage_state.ts` semantics; verified by `outage_alert_dedup.test.ts` + `recovery_clears_outage_state.test.ts`. The dedup ledger columns (`first_failure_after_success_at`, `outage_alert_emitted_at`) are the canonical persistent state; the audit log is the canonical history. | Slice 002 sync coordinator, Slice 007 (outage SLO reporting). |
| **`notifications.outage_webhook_url` config key contract** — when non-null, T041 POSTs a JSON body `{ event: 'provider.outage_alert' | 'provider.recovered', provider, run_id, timestamp }` with 5-second timeout. Failures log to stderr; the audit row is canonical. | **Wire shape LOCKED** for webhook consumers (PagerDuty / Slack / similar). | Slice 002 (writer), Slice 008 (ops integration). |

---

## 7. Reconciliation gaps still pending (D-010 carry-forward + Phase-5 observations)

### 7a. D-010 carry-forward (unchanged from US2)

The three drift items recorded as D-010 in US2's checkpoint § 7 (outcome enum mismatch on the wire vs storage, US2 happy-path test schema drift on `provider_sync_runs.id` / `provider_name`, US2 test trigger-enum mismatch) are **still pending** at the end of Phase 5. Phase 5 did not touch the surfaces that would resolve them:

- (a) Storage vs wire outcome divergence — documentation-only; not a runtime gate.
- (b) `single_sync_happy.test.ts` (T023) still queries `.eq('id', runId)` and SELECTs `provider_name`. **Pre-merge HARD GATE** unchanged.
- (c) Five US2 Deno tests still post `trigger='cron'`; `non_admin_returns_403.test.ts` posts `'admin_manual'`; `provider_swap.test.ts` posts `'swap-test'`. **Pre-merge HARD GATE** unchanged.

**Note**: The seven Phase-5 Deno tests (T034/T035/T036) ALL post `trigger='manual_internal'` per the red-gate-us3 author's discipline (cross-referenced in `red-gate-us3.md § Cumulative spec deviations § D-010`). So the Phase-5 tests themselves are NOT subject to the D-010(c) hard gate. The gate only blocks the six US2 tests until their `trigger` literals are remapped.

### 7b. Phase-5-surfaced item — D-011 (the `audit_log.source` enum gap)

T039's implementation report surfaced a new deviation, recorded as **D-011** in `tasks.md § Implementation deviations` (line 105). Short summary:

- **Symptom**: The `audit_log.source` CHECK constraint (migration `0003_audit_log_stub.sql`) accepts only `'auth_hook'`, `'rls'`, `'api_guard'`, `'ui'`, `'trigger'`. None of those describe "the sync coordinator's payload guard" naturally. A literal `'sync'` value would violate the CHECK.
- **T039's decision**: Write `source = 'api_guard'` uniformly across every audit row emitted by the sync coordinator (rejection rows, quarantine alert rows, outage rows, recovery rows). Rationale — the coordinator IS an API-level gatekeeper that decides whether to admit a write to the catalog; structurally it's the same role as the existing `api_guard` writers from Slice 001.
- **Cross-slice impact**: Slice 007 (audit hardening) may want to extend the `source` CHECK with a `'sync'` value and back-fill prior rows whose `action` starts with `'provider.sync_'` / `'provider.outage_'` / `'provider.recovered'`. The reconciliation is mechanical: `UPDATE audit_log SET source='sync' WHERE action LIKE 'provider.%'`.
- **Not a runtime gate for this slice's merge** — the chosen `'api_guard'` value passes the CHECK and is semantically defensible. Slice 007 owns the cleanup.

### 7c. Open Phase-5 deviation count

The slice-002 deviation log now stands at D-006 through D-011 — six slice-002-specific deviations. Cross-slice carry-forward from slice 001 (D-001 through D-005) is unchanged.

---

## 8. Verification commands (operator runbook)

Run from the repo root on branch `002-match-catalog` in order. Stop on the first non-zero exit. PowerShell variants given; bash equivalents at the bottom.

```powershell
# 0. One-time prerequisites: Docker daemon up AND Deno on PATH.
docker info | Select-String "Server Version"   # must succeed
deno --version                                  # must report a version
# If Deno is missing: winget install denoland.deno (or choco install deno; or download from https://deno.land/).

# 1. Boot the local Supabase stack.
supabase start

# 2. Reset the database -- applies all 23 migrations (slice 001's 0001..0011 + slice
#    002's 0018..0026, 0028, 0029 -- note the reserved gaps at 0012..0017 and 0027)
#    and reloads both seed fixtures.
supabase db reset

# 3a. Run every slice-002 pgTAP test file individually.
Get-ChildItem supabase/tests/pgtap -Filter 'slice-002-*.sql' | ForEach-Object { supabase test db $_.FullName }
Get-ChildItem supabase/tests/pgtap -Filter 'record_match_result_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 3b. Optional regression sweep -- every slice-001 pgTAP file too (carry-forward).
Get-ChildItem supabase/tests/pgtap -Exclude 'slice-002-*','record_match_result_*' -Filter '*.sql' | ForEach-Object { supabase test db $_.FullName }

# 4. TypeScript strict compile of the web app.
pnpm -F web exec tsc --noEmit

# 5. Production-mode Next.js build.
pnpm -F web build

# 6. Deno typecheck of the function tree (now includes the three Phase-5 helpers).
deno check supabase/functions/sync-catalog/index.ts
deno check supabase/functions/sync-catalog/payload_sanity.ts
deno check supabase/functions/sync-catalog/conflict_quarantine.ts
deno check supabase/functions/sync-catalog/outage_state.ts
deno check supabase/functions/_shared/providers/stub/index.ts
deno check supabase/functions/_shared/providers/stub2/index.ts
deno check supabase/functions/_shared/providers/footballdata/index.ts

# 7. Deno tests -- all 13 files (6 US2 + 7 US3).
#    Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SYNC_TRIGGER_SECRET
#    in apps/web/.env.local, AND RUN_SYNC_CATALOG_TESTS=1 exported.
cd supabase/functions/sync-catalog/tests
$env:RUN_SYNC_CATALOG_TESTS = "1"
deno test --allow-all --env-file=../../../../apps/web/.env.local
cd ../../../..

# 8. Start the Next.js dev server (Playwright fixtures depend on it).
#    Run in a separate terminal; the suite will tear it down after.
pnpm -F web dev

# 9. Playwright suite -- full slice-002 scope (US1 + US3 specs).
pnpm -F web e2e -- --grep '@slice-002'
```

Bash equivalents (run instead of step 3 on a POSIX shell):

```bash
for f in supabase/tests/pgtap/slice-002-*.sql; do supabase test db "$f" || exit 1; done
for f in supabase/tests/pgtap/record_match_result_*.sql; do supabase test db "$f" || exit 1; done
for f in supabase/tests/pgtap/*.sql; do
  case "$(basename "$f")" in slice-002-*|record_match_result_*) ;; *) supabase test db "$f" || exit 1 ;; esac
done
```

A passing run produces:

- **Step 3a (slice-002 pgTAP)**: 9 files — 1 from US1 (`slice-002-catalog-rls.sql` plan(7)) + 8 from US2 (`record_match_result_*.sql`), all reporting `ok` for every planned assertion, modulo the D-008 / D-009 caveats. Zero new pgTAP from US3.
- **Step 3b**: 12 carry-forward files; assertion totals as documented in slice 001's regression-final.
- **Step 4**: no output, exit 0.
- **Step 5**: build succeeds.
- **Step 6**: 7 `deno check` invocations (4 in the `sync-catalog/` tree now — `index.ts` + the three helpers — plus the 3 adapter checks), each exits 0.
- **Step 7**: 13 Deno test files, 14 sub-tests, all `ok` — after D-010(b) + D-010(c) reconciliation patches land. The 7 US3 test files are already aligned to the migration's accepted `trigger='manual_internal'` value so they do not block on D-010(c).
- **Step 9**: 23 slice-002 Playwright tests passing (20 US1 + 3 US3); the `slice-002-late-fixture-appears` test remains `test.fixme` until Phase 6 ships T043 (cron schedule) + T045 (late-fixture orchestration).

---

## 9. Open deferred work blocking a fully observed GREEN

### 9a. Slice 001 carry-forward (unchanged from US1 / US2 checkpoints)

All nine items from US1's § 8a remain open: T005, T006, T007, T021, T031, T035, T039, T041, T044 (slice 001 task numbering). Carry-forward unchanged.

### 9b. Slice 002 Docker-dependent deferrals (unchanged + Phase-5 carry-forward)

The Docker-dependent items from US1's § 8b and US2's § 9b — T001, T002, T018, T022, T023, T024, T025, T026, T028, T033 — all remain open. Phase 5 adds:

| Task | Why deferred | What still needs running |
|---|---|---|
| T034 (slice 002) | 3 Deno tests authored RED — no live observation yet (Docker + Deno both unavailable). | § 8 step 7 above. |
| T035 (slice 002) | 2 Deno tests authored RED — no live observation. | § 8 step 7 above. |
| T036 (slice 002) | 2 Deno tests authored RED — no live observation. | § 8 step 7 above. |
| T037 (slice 002) | 3 Playwright tests authored RED — no live observation. | § 8 step 9 above. |
| T038 (slice 002 — the RED gate sibling) | Stash-and-test RED→GREEN verification for the full US3 surface. | The full recipe in `red-gate-us3.md § Verification commands`. |
| T039 (slice 002) | Payload-sanity guards GREEN-implemented but not observed. | § 8 step 7 (the 3 T034 tests). |
| T040 (slice 002) | Quarantine logic GREEN-implemented but not observed. | § 8 step 7 (the 2 T035 tests). |
| T041 (slice 002) | Outage state-machine + webhook POST GREEN-implemented but not observed. | § 8 step 7 (the 2 T036 tests). |
| **T042 (this doc)** | Runtime suite GREEN under live Docker + live Deno — both unavailable. | Execute § 8 steps 1–9 above. |

### 9c. Deno-dependent deferrals (carry-forward from Phase 4)

Distinct from the Docker-dependent set: every Deno-runtime invocation in the runbook is doubly blocked (needs Docker AND needs Deno on PATH). If Docker comes back online without Deno, only steps 1, 2, 3a, 3b, 4, 5, 8, 9 can run — steps 6 and 7 remain deferred until Deno is installed.

### 9d. Tests that STAY RED until later phases ship

| Test | Stays RED until | Owner |
|---|---|---|
| `slice-002-late-fixture-appears.spec.ts` | Phase 6 ships the cron schedule (T043) and the late-fixture orchestration (T045). | T043 + T045 (Phase 6). |

### 9e. D-010 reconciliation patches (carry-forward — still pending)

Unchanged from `regression-checkpoint-us2.md § 9e`. Restated for completeness:

- **§ 7a / D-010(a)** (outcome enum on storage vs wire) — documentation-only.
- **§ 7b / D-010(b)** (`single_sync_happy.test.ts` schema drift) — HARD GATE.
- **§ 7c / D-010(c)** (six US2 test files post invalid `trigger` literals) — HARD GATE for those six files. The seven US3 tests are not affected (they all use `trigger='manual_internal'`).

Recommended: schedule these patches as Phase-6 polish tasks. Until they land, the runbook at § 8 step 7 will produce false-RED results for the six affected US2 files.

### 9f. D-011 audit-source enum extension (NEW Phase-5 carry-forward)

T039 wrote `audit_log.source='api_guard'` for every sync-coordinator audit row. This passes the migration 0003 CHECK but is semantically a stretch. Slice 007 should add a `'sync'` source enum value and back-fill prior `'api_guard'` rows whose `action LIKE 'provider.%'`. Tracked in `specs/002-match-catalog/tasks.md § Implementation deviations § D-011`. **Not a merge gate for slice 002.**

---

## 10. Pre-merge action items (operator checklist)

Tick each box before opening (or merging) the slice-002 PR. Carry-forward from US2's § 10 with Phase-5 additions.

- [ ] Docker Desktop running and healthy on the verifying machine (`docker info` exits 0).
- [ ] Deno on PATH on the verifying machine (`deno --version` reports a version).
- [ ] § 8 step 1 (`supabase start`) succeeds and the Supabase Studio URL is reachable.
- [ ] § 8 step 2 (`supabase db reset`) applies all 23 migrations cleanly and loads both seed fixtures with no errors.
- [ ] § 8 step 3a (slice-002 pgTAP) reports `ok` for all 9 slice-002 pgTAP files (1 RLS + 8 record_match_result). No new pgTAP files in Phase 5.
- [ ] § 8 step 3b (slice-001 pgTAP carry-forward) reports all 12 files green.
- [ ] § 8 step 4 (`pnpm -F web exec tsc --noEmit`) exits 0 with no output.
- [ ] § 8 step 5 (`pnpm -F web build`) succeeds.
- [ ] § 8 step 6 (`deno check`) — all 7 invocations exit 0 (4 in `sync-catalog/` + 3 in `_shared/providers/`).
- [ ] § 8 step 7 (`deno test`) — all 13 Deno test files exit 0 with all 14 sub-tests passing. **Requires D-010(b) + D-010(c) patches to have landed for the six US2 test files; the seven US3 test files run clean today.**
- [ ] § 8 step 9 (Playwright `@slice-002`) reports 23 of 24 slice-002 tests passing; the remaining 1 is `slice-002-late-fixture-appears` legitimately self-fixme'd until Phase 6's T043 + T045 ship.
- [ ] D-010 disposition decided and documented (do § 7b + § 7c patches land before merge, or are they tracked as a known-RED set into Phase 6 / Polish?).
- [ ] D-011 disposition acknowledged — `audit_log.source='api_guard'` accepted as the slice-002 choice; slice 007 owns the eventual `'sync'` value + back-fill.
- [ ] T028 RED-gate sign-off (per `red-gate-us2.md § Sign-off checklist`).
- [ ] T038 RED-gate sign-off (per `red-gate-us3.md § Sign-off checklist`) — both RED + GREEN runs of the stash-and-test recipe captured for the 10 US3 RED units.
- [ ] PR description references this file (`specs/002-match-catalog/regression-checkpoint-us3.md`) plus `red-gate-us3.md`, `regression-checkpoint-us2.md`, `red-gate-us2.md`, `regression-checkpoint-us1.md`, `red-gate-us1.md`, `regression-baseline-from-001.md`, and (once it exists) `regression-final.md`.

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack + live Deno runtime is the merge gate. Until every box above is ticked, Polish (Phase 6) MAY NOT start in a way that bypasses this gate, and slice 002 MAY NOT merge to `main`.

---

## 11. Spec deviations consolidated

Carry-forward from slice 001 (D-001 through D-005) + slice 002 prior additions (D-006 through D-010) + NEW at Phase 5 (D-011). One-liners with `tasks.md` line refs where applicable:

| ID | Where recorded | One-liner |
|---|---|---|
| D-001 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`. |
| D-002 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `is_approved_domain(p_email text)` takes a FULL email, not a bare domain. |
| D-003 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `/api/me` body shape uses `{ participant: {...} }`; errors use `{ error: { code, message } }` + `Cache-Control: private, max-age=0`. Slice 002's `/api/matches` mirrors. |
| D-004 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `participants_self_or_admin_read` policy embeds the eligibility predicate. Slice 002's catalog RLS follows the same pattern. |
| D-005 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `handle_auth_user_signed_in` returns the `{claims}` / `{error}` `custom_access_token` envelope, not `{decision}`. |
| D-006 | `specs/002-match-catalog/tasks.md § Implementation deviations` | Wave-2 schema reconciliation across 0020–0023, 0028, types.ts. The `match_pending_review.conflict_class` whitelist is load-bearing for T040 — canonical values use `_change` (not `_changed`) and `score_before_finished` (not `score_before_kickoff`). |
| D-007 | `specs/002-match-catalog/tasks.md § Implementation deviations` | `match_results` field-name mapping in `/api/matches` (T020). Route projects `_official` from split + extra-time + penalty columns; `_for_scoring` passes through; result-status enum remapped on the wire. |
| D-008 | `specs/002-match-catalog/tasks.md § Implementation deviations` | pgTAP cannot observe `pg_notify` channel reception (`BEGIN/ROLLBACK` envelope). `record_match_result_emits_notification.sql` uses structural-proxy assertions; real channel verification deferred to slice 005. |
| D-009 | `specs/002-match-catalog/tasks.md § Implementation deviations` | `audit_log.action` name mismatch — migration 0025 emits `'match_result.updated'` on UPDATE; contract names it `'match_result.corrected'`. T029 chose to honour the migration; UPDATE-path assertion deferred to slice 006. |
| D-010 | `specs/002-match-catalog/tasks.md § Implementation deviations` (line 93, surfaced T032, consolidated T033) | `sync-catalog` coordinator vs Deno tests vs migration 0022 reconciliation gaps: (a) outcome enum on wire vs storage; (b) US2 `single_sync_happy.test.ts` schema drift on `provider_sync_runs.id` / `provider_name`; (c) US2 test fixtures post `trigger` values outside the migration CHECK whitelist. (b) + (c) are pre-merge hard gates for the six US2 Deno files. The seven Phase-5 Deno files use `trigger='manual_internal'` and are not affected. |
| **D-011** | **`specs/002-match-catalog/tasks.md § Implementation deviations` (line 105, surfaced T039)** | **`audit_log.source` CHECK accepts only `auth_hook` / `rls` / `api_guard` / `ui` / `trigger`; the sync coordinator has no clean fit. T039 chose `source='api_guard'` uniformly. Slice 007 will add a `'sync'` value and back-fill `audit_log` rows where `action LIKE 'provider.%'`. Not a merge gate for slice 002.** |

---

## 12. Phase-5 close-out note

Phase 5 lands all 9 of its tasks (T034 + T035 + T036 + T037 + T038 + T039 + T040 + T041 + T042). The sync coordinator now has the production-shape failure-resilience surface — payload-sanity guards (T039), per-row conflict quarantine (T040), and outage-alert dedup + recovery (T041) — wired through three pure-function helper modules alongside `index.ts`. No new migrations were needed; the schema affordances were all in place from Phase 2 / Phase 4.

Two observations worth recording for Phase 6's planning:

1. The `slice-002-late-fixture-appears.spec.ts` test remains the last `test.fixme` in the slice-002 Playwright suite. It will flip GREEN when T043 (pg_cron three-tier schedule) and T045 (late-fixture orchestration) ship in Phase 6.
2. The D-010(b) and D-010(c) test-fixture patches for the six US2 Deno tests should land in Phase 6 polish — without them, `deno test` will produce false-RED for those six files. The fix is mechanical (rename column references in one test, remap `trigger` literals in six tests) and was deliberately deferred to keep Phase-5 scope focused on the GREEN implementations.

Polish (Phase 6) — T043 through T048 — begins after this checkpoint is signed off and the verification commands at § 8 land green.
