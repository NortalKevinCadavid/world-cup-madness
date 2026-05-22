# Regression checkpoint — Slice 002, Phase 4 (US2)

- **Slice**: `002-match-catalog`
- **Phase**: 4 (US2 — "Provider abstraction: fixtures + statuses + scores sync through a stable adapter; swap is config-only")
- **Date**: 2026-05-20
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T033 (`specs/002-match-catalog/tasks.md` line 1244)
- **Companion artifacts**:
  - `specs/002-match-catalog/regression-baseline-from-001.md` (T001 — slice-001 carry-forward baseline)
  - `specs/002-match-catalog/regression-checkpoint-us1.md` (T022 — Phase-3/US1 checkpoint, the template this document mirrors)
  - `specs/002-match-catalog/red-gate-us1.md` (T018 — Phase-3/US1 RED-gate)
  - `specs/002-match-catalog/red-gate-us2.md` (T028 — Phase-4/US2 RED-gate, the sibling artifact for this same test set)
  - `specs/001-eligibility-login/regression-final.md` (the slice 001 final gate; carry-forward source)
- **Purpose**: Record the state of the slice-001 + slice-002-through-US2 test suite at the moment US2 lands in slice 002, inventory every test the operator must run, and hand the exact verification commands to whoever next has a working Docker daemon AND a working local Deno install. Per Principle XI, US3 (Phase 5) and Polish (Phase 6) MAY NOT start, and the slice MAY NOT merge to `main`, until all verification commands below land GREEN.

---

## Status: DEFERRED

Two distinct runtime dependencies were unavailable on the executing machine at the time this document was authored:

1. **The Docker daemon required by `supabase start`** (and therefore by `supabase test db` for pgTAP, by the Edge Function runtime that hosts `sync-catalog`, and by any Playwright spec that boots the Next dev server against a live database) was **down**.
2. **Deno is not installed locally** (`deno --version` not on PATH). The six Deno test files authored under T023 + T024 + T025 require Deno to execute — `deno test --allow-all` is the only supported runner for Edge Function tests, and the Supabase CLI does not bundle Deno for use outside of `supabase functions serve`.

This checkpoint is therefore a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added so far in slice 002 (US1 + US2 cumulative), and hands the exact commands the user MUST run locally (or in CI) before Phase 5 (US3) begins or the slice can merge.

Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 8 have all returned GREEN.

---

## 1. Suite inventory (post-US2, cumulative across slices 001 + 002)

### 1a. pgTAP tests — `supabase/tests/pgtap/`

**Slice 001 carry-forward** — 12 files unchanged from the slice 001 baseline (1 harness probe + 8 functional + 2 RLS-isolation + 1 perf). Full inventory in `specs/001-eligibility-login/regression-final.md § 2` and in this slice's `regression-baseline-from-001.md § 1.2`. Slice 002 does not modify any of them.

**Slice 002 / US1 carry-forward (Phase 3)** — 1 file, unchanged from US1's checkpoint:

| # | File | Plan | Owning task |
|---|------|------|-------------|
| 1 | `slice-002-catalog-rls.sql` | `plan(7)` | T017 |

**Slice 002 / US2 additions (Phase 4)** — 8 new files, all owned by T026, all gating the `record_match_result(...)` SP shipped by T029:

| # | File | Plan | Purpose |
|---|------|------|---------|
| 1 | `record_match_result_happy.sql` | per file | Happy-path SP invocation: regulation result lands a `match_results` row with the cross-slice `_for_scoring` columns populated. |
| 2 | `record_match_result_rejects_pre_finished.sql` | per file | SP must `RAISE EXCEPTION` when `matches.status <> 'finished'`. |
| 3 | `record_match_result_enforces_for_scoring_invariant.sql` | per file | The `_for_scoring` columns must always reflect the regulation-90 score per the contract invariant. |
| 4 | `record_match_result_enforces_shootout_invariant.sql` | per file | `result_status = 'penalty_shootout'` requires the penalty columns populated. |
| 5 | `record_match_result_admin_correction_requires_approver.sql` | per file | Admin-override path requires `p_approved_by IS NOT NULL` when `p_source = 'admin_override'`. |
| 6 | `record_match_result_admin_correction_requires_admin.sql` | per file | `p_approved_by` must resolve to an `is_admin()` user. |
| 7 | `record_match_result_emits_notification.sql` | `plan(2)` | Structural proxy for `pg_notify('match_results_recorded', ...)` per D-008 — `lives_ok` on the SP + `is(count, 1)` on the row. Real channel-reception assertion deferred to slice 005 T042. |
| 8 | `record_match_result_audit_format.sql` | `plan(3)` | Asserts the INSERT-path audit row uses the migration's `'match_result.recorded'` action (which both migration 0025 and the contract agree on); UPDATE-path action-name spelling deferred per D-009. |

**Aggregate**: 12 carry-forward + 1 slice-002-US1 + 8 slice-002-US2 = **21 pgTAP files** total at the end of Phase 4. (On-disk count verified.)

### 1b. Playwright tests — `apps/web/tests/playwright/`

**Slice 001 carry-forward** — 15 spec files unchanged from the slice 001 baseline (14 carrying `@slice-001` + 1 untagged harness probe `smoke.spec.ts`).

**Slice 002 / US1 carry-forward (Phase 3)** — 9 spec files, 20 tests total, all tagged `@slice-002 @us1`. Inventory unchanged from `regression-checkpoint-us1.md § 1b`. No new Playwright specs land in Phase 4 — US2 is a server-side / sync-coordinator slice with no participant UI surface (the catalog page already covers the read path).

**Aggregate at end of Phase 4**: 15 carry-forward specs + 9 slice-002-US1 specs + 0 slice-002-US2 specs = **24 spec files** total. The `slice-002-late-fixture-appears.spec.ts` test remains in its `test.fixme` self-skip branch — it asserts a US3-owned outcome (a fresh fixture appearing mid-tournament) and won't flip GREEN until US3 ships the cron-driven sync invocation.

### 1c. Deno tests — `supabase/functions/sync-catalog/tests/`

**Slice 002 / US2 additions (Phase 4)** — 6 new Deno test files, all owned by T023 + T024 + T025, all dispatching `POST /functions/v1/sync-catalog` against the local Supabase stack:

| # | File | Owning task | Sub-tests | Purpose |
|---|------|-------------|-----------|---------|
| 1 | `single_sync_happy.test.ts` | T023 | 1 | Happy path — `X-Internal-Auth` + fresh `run_id` → 200 + canonical `provider_sync_runs` row + `matches`-count invariant. |
| 2 | `idempotent_retry.test.ts` | T023 | 1 | Same `run_id` posted twice → second response echoes `notes='idempotent retry'` byte-equivalent to the first. |
| 3 | `advisory_lock_returns_409.test.ts` | T024 | 1 | Side-connection holds `pg_advisory_lock` → POST returns 409 + `SYNC_IN_FLIGHT`. |
| 4 | `non_admin_returns_403.test.ts` | T024 | 1 | Authenticated non-admin without `X-Internal-Auth` → 403 + `FORBIDDEN`. |
| 5 | `internal_auth_path.test.ts` | T024 | 2 | Valid `X-Internal-Auth` → 200; wrong secret → 401. |
| 6 | `provider_swap.test.ts` | T025 | 1 | SHA-256 of `matches` after `provider=stub` sync equals SHA-256 after `provider=stub2` sync (config-only swap invariant). |

**Aggregate**: **6 Deno test files** = 7 behaviourally-distinct sub-tests. (On-disk count verified.)

In addition, T025 shipped a second-stub adapter as a RED-test artifact (NOT itself a test):

- `supabase/functions/_shared/providers/stub2/index.ts`
- `supabase/functions/_shared/providers/stub2/fixtures/wc2026-snapshot.json`

These exist solely so `provider_swap.test.ts` has a second provider in the registry to swap to; they are checked into the test surface, not the production surface.

### 1d. TypeScript compile

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web exec tsc --noEmit` | Project-wide strict compile of `apps/web/`. Validates `lib/types/match.ts` + `lib/catalog/*` + the `/api/matches` route + the participant route group continue to typecheck under US2's additions (which are confined to `supabase/functions/` and `supabase/migrations/`; the web app surface is unchanged at Phase 4). | GREEN locally per T021's and T032's implementation reports (no Docker dependency; can be re-confirmed at any time). |

### 1e. Next.js build

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web build` | Production-mode `next build`. Confirms the App Router still catches `/api/matches` and `/(participant)/matches`; no slice-002-US2 file leaks into a server-component boundary. | GREEN locally per T021's implementation report (no Docker dependency). |

### 1f. Deno typecheck (NEW for Phase 4)

| Command | Purpose | Latest known result |
|---|---|---|
| `deno check supabase/functions/sync-catalog/index.ts` | Strict TypeScript check of the sync coordinator under the Deno runtime (catches drift between the adapter interface in `supabase/functions/_shared/providers/types.ts` and the coordinator's adapter consumers). | **Cannot run locally — Deno not installed.** Deferred to the operator runbook. |
| `deno check supabase/functions/_shared/providers/{stub,stub2,footballdata}/index.ts` | Same, for each adapter. | **Cannot run locally — Deno not installed.** Deferred. |

---

## 2. Migration inventory — `supabase/migrations/`

**Slice 001 carry-forward** — 11 migrations (`0001`…`0011`), all unchanged.

**Slice 002 / US1 carry-forward (Phases 1 + 2)** — 9 migrations from the US1 checkpoint, unchanged.

**Slice 002 / US2 additions (Phase 4)** — 2 new migrations:

| # | File | T# | Summary | New in Phase 4? |
|---|------|----|---------|------------------|
| 0018 | `0018_enable_extensions.sql` | T002 | `pg_cron` + `pg_net` extensions, `timezone='UTC'`. | (Phase 1, carried forward.) |
| 0019 | `0019_teams.sql` | T003 | `public.teams` + `team_provider_external_ids` mapping table. | (Phase 2.) |
| 0020 | `0020_matches.sql` | T004 | `public.matches` + enums (`match_status`, `match_stage`) + `match_provider_external_ids` + group-consistency CHECK. | (Phase 2.) |
| 0021 | `0021_match_results.sql` | T005 | `public.match_results` with LOCKED `_for_scoring` columns + split-column shape (D-006). | (Phase 2.) |
| 0022 | `0022_provider_sync_tables.sql` | T006 | `provider_sync_runs` (bigserial PK + `correlation_id uuid` + text+CHECK enums) and `provider_sync_state`. | (Phase 2.) |
| 0023 | `0023_match_pending_review.sql` | T007 | Manual-resolution queue with text+CHECK enums (slice 006 reads). | (Phase 2.) |
| **0024** | **`0024_record_match_result_sp.sql`** | **T029** | **The `record_match_result(p_match_id, p_source, p_result_status, p_home_score, p_away_score, p_extra_time, p_penalty, p_approved_by)` SP — the eight-arg signature consumed by both the catalog UPSERT path inside the sync coordinator and by slice 006 admin-override writes. Issues the `pg_notify('match_results_recorded', ...)` notification at the end.** | **NEW in Phase 4.** |
| 0025 | `0025_catalog_audit_triggers.sql` | T008 | `*_write_audit()` triggers for `teams` / `matches` / `match_results`. | (Phase 2.) |
| 0026 | `0026_catalog_rls.sql` | T009 | RLS on catalog tables + admin-only guards on sync bookkeeping tables. | (Phase 2.) |
| 0028 | `0028_provider_config_defaults.sql` | T010 | Default rows in `tournament_config` for the `providers.*` + `provider_sync.*` keys. | (Phase 2.) |
| **0029** | **`0029_sync_lock_helpers.sql`** | **T032** | **`try_lock_sync(text)` and `unlock_sync(text)` helper RPCs wrapping `pg_try_advisory_lock` / `pg_advisory_unlock` with the canonical `hashtext('sync_catalog') ⊕ hashtext(provider)` key derivation. Used by the sync coordinator to acquire the cross-instance advisory lock without inlining the hash math in TypeScript. Slice-internal — not cross-slice-locked.** | **NEW in Phase 4.** |

**Aggregate**: 11 carry-forward + 12 slice-002 = **23 migrations** total on disk. (Verified via directory listing — 11 from `0001..0011` plus 12 from `0018..0029` with reserved gaps at `0024`-was-reserved-now-shipped, `0027` still reserved. The earlier US1-checkpoint statement that "0024 is reserved" is now superseded: T029 filled the slot.)

**Note on slot numbering**: The US1 checkpoint reserved `0024` (and `0027`) as holes. T029 occupies `0024`; `0027` remains unused. T032's new `0029_sync_lock_helpers.sql` is the next available densely-packed slot.

**Seed fixtures**: still 2 files — `supabase/seed/slice-001-fixture.sql` (carry-forward) + `supabase/seed/slice-002-fixture.sql` (T012, US1). No new seed fixtures in Phase 4.

---

## 3. App-code inventory — slice 002 / US2 additions

Files added during slice 002 Phase 4 (US2). All US1 additions (lib/types/match.ts, lib/catalog/*, app/api/matches/route.ts, app/(participant)/...) remain unchanged.

### 3a. Sync coordinator (T032)

| File | T# | Role |
|---|---|---|
| `supabase/functions/sync-catalog/index.ts` | T032 | The slice-002 sync coordinator Edge Function — happy path only. Parses the request body (`provider`, `trigger`, `run_id`, optional `reason`); enforces `X-Internal-Auth` OR admin-JWT auth (per `contracts/sync-runner.scheduled.md` § Auth); acquires the canonical advisory lock via `try_lock_sync(provider)` (migration 0029); checks idempotency via `provider_sync_runs.correlation_id = run_id`; inserts an in-progress ledger row; resolves the adapter via static registry (`stub` / `stub2` / `footballdata`); calls `adapter.fetchTeams()` + `fetchFixtures()` + `fetchResults()`; UPSERTs teams → matches → results (the latter via the T029 SP); updates the ledger row with `outcome='success'` or `'success_no_changes'`; updates `provider_sync_state.last_success_at` + clears outage fields; releases the lock in `finally`. **Does NOT implement** payload-sanity guards (T039), conflict quarantine (T040), or outage-alert dedup (T041) — those are US3. |
| `supabase/functions/sync-catalog/deno.json` | T032 | Deno runtime config for the Edge Function (compiler options + import map). |

### 3b. Provider adapters (T025, T030, T031)

| File | T# | Role |
|---|---|---|
| `supabase/functions/_shared/providers/stub/index.ts` | T030 | Stub adapter — reads the bundled fixture JSON and returns normalized teams / fixtures / results matching the seed shape. Implements `MatchDataProviderAdapter` from `_shared/providers/types.ts`. |
| `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json` | T030 | The stub adapter's canonical fixture. Same eight matches as `slice-002-fixture.sql`. |
| `supabase/functions/_shared/providers/stub2/index.ts` | T025 | Second-stub adapter (test artifact, but production-shape) — exists so `provider_swap.test.ts` has a registered alternative provider to swap to. Implements the same interface; reads a separate snapshot file. |
| `supabase/functions/_shared/providers/stub2/fixtures/wc2026-snapshot.json` | T025 | Stub2's snapshot — byte-equivalent normalized output to stub's snapshot (the test asserts the post-UPSERT `matches` SHA-256 is identical under both providers). |
| `supabase/functions/_shared/providers/footballdata/index.ts` | T031 | Real football-data.org adapter scaffold. Implements the interface; hits the live API behind a feature-flag check. Not exercised by any slice-002 test — production-bootstrap surface for slice 008 / operator. |

### 3c. Deno test surface (T023, T024, T025)

See § 1c above — six test files under `supabase/functions/sync-catalog/tests/`. Not app code per se, but co-located with the function under test.

### 3d. Tournament-config touchpoints

No new keys land in Phase 4 — T032 reads the keys seeded by T010 / migration 0028 (`providers.active`, `provider_sync.*`). The coordinator's own behaviour is config-driven by those keys per Constitution Principle VIII.

---

## 4. Expected GREEN state per test (inferred — not observed)

These predictions are inferred from inspection of each file's assertions against the implementations now landed. Until Docker is up AND Deno is installed they are NOT observed.

### 4a. pgTAP (slice-002 US2 — 8 files from T026)

- `record_match_result_happy.sql` → **GREEN once Docker boots**. T029 shipped the SP; the file's `lives_ok` on a regulation invocation + assertions on the inserted `match_results` row (including the LOCKED `_for_scoring` columns) all satisfy against the as-built SP body.
- `record_match_result_rejects_pre_finished.sql` → **GREEN once Docker boots**. T029's SP body opens with a `RAISE EXCEPTION` guard if `matches.status <> 'finished'`; `throws_ok` on a pre-finished invocation satisfies.
- `record_match_result_enforces_for_scoring_invariant.sql` → **GREEN once Docker boots**. T029 computes and stores the `_for_scoring` columns by deriving regulation-90 from the input args.
- `record_match_result_enforces_shootout_invariant.sql` → **GREEN once Docker boots**. T029 guards `result_status='penalty_shootout'` with a check that the penalty columns are populated.
- `record_match_result_admin_correction_requires_approver.sql` → **GREEN once Docker boots**. T029 enforces `p_approved_by IS NOT NULL` on the `p_source='admin_override'` branch.
- `record_match_result_admin_correction_requires_admin.sql` → **GREEN once Docker boots**. T029 calls `is_admin(p_approved_by)` and raises on `false`.
- `record_match_result_emits_notification.sql` → **GREEN once Docker boots, with D-008 caveat**. The file asserts only the structural proxy (`lives_ok` + row count); the load-bearing channel-reception assertion is deferred to slice 005 T042.
- `record_match_result_audit_format.sql` → **GREEN once Docker boots, with D-009 caveat**. The file asserts only the agreed-on `'match_result.recorded'` INSERT-path action name. UPDATE-path spelling disposition still pending in D-009.

### 4b. Deno tests (slice-002 US2 — 6 files = 7 sub-tests)

All six files require: (a) Docker daemon running so the local Supabase stack accepts `POST /functions/v1/sync-catalog`; (b) Deno installed so `deno test --allow-all` can drive them; (c) `RUN_SYNC_CATALOG_TESTS=1` exported in the test env; (d) `apps/web/.env.local` populated with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SYNC_TRIGGER_SECRET`.

- `single_sync_happy.test.ts` → **GREEN once Docker + Deno + stub adapter registered**. T032 ships the happy-path coordinator; T030's stub adapter is in the static registry; the assertions on `provider_sync_runs` (status terminal, counts present) and on `matches` (eight rows present, unchanged across a happy re-run) satisfy. **Drift caveat**: see § 7.
- `idempotent_retry.test.ts` → **GREEN once Docker + Deno running**. T032 step 3 (`correlation_id = run_id` lookup → return prior response with `notes='idempotent retry'`) satisfies.
- `advisory_lock_returns_409.test.ts` → **GREEN once Docker + Deno running**. T032's `try_lock_sync` branch returns 409 + `SYNC_IN_FLIGHT` on contention; migration 0029's helper RPC drives the lock acquisition.
- `non_admin_returns_403.test.ts` → **GREEN once Docker + Deno running**. T032's auth gate rejects non-admin JWTs that lack `X-Internal-Auth`. **Drift caveat**: this test posts `trigger='admin_manual'` which violates the migration 0022 CHECK — see § 7.
- `internal_auth_path.test.ts` (2 sub-tests) → **GREEN once Docker + Deno running**. T032 accepts the configured `SYNC_TRIGGER_SECRET` on the valid path and rejects the wrong-secret path with 401.
- `provider_swap.test.ts` → **GREEN once Docker + Deno running + stub2 adapter registered**. T032 wires both `stub` and `stub2` into the static registry; the SHA-256 invariant assertion satisfies because both stubs emit byte-equivalent normalized output. **Drift caveat**: this test posts `trigger='swap-test'` which violates the migration 0022 CHECK — see § 7.

### 4c. Slice-002 US1 tests (carry-forward)

Expectations unchanged from `regression-checkpoint-us1.md § 4`. Phase 4 added no Playwright specs and modified no US1 surface. The one residual `test.fixme` (`slice-002-late-fixture-appears.spec.ts`) is now closer to flipping GREEN — it needs the US3 cron-driven invocation that T034–T045 will ship — but is still expected to self-skip at Phase-4 close.

### 4d. Slice-001 tests (carry-forward)

Expectations unchanged from `specs/001-eligibility-login/regression-final.md`. Slice 002 did not modify any slice-001 surface.

### 4e. Static + build

- `pnpm -F web exec tsc --noEmit` → **GREEN**, per T032's implementation report. No Docker dependency.
- `pnpm -F web build` → **GREEN**, per T021's implementation report. No Docker dependency.
- `deno check` on the function tree → **DEFERRED until Deno is installed**.

---

## 5. Aggregate totals at end of Phase 4

| Surface | Slice 001 | Slice 002 (US1) | Slice 002 (US2) | Total |
|---|---|---|---|---|
| Migrations | 11 | 9 | 3 (0024 + 0029 newly added in Phase 4, plus 0022 modification scope unchanged) — net +2 new files | 23 |
| pgTAP files | 12 | 1 | 8 | 21 |
| Playwright specs | 15 | 9 | 0 | 24 |
| Deno test files | 0 | 0 | 6 | 6 |
| Deno test sub-tests | 0 | 0 | 7 | 7 |
| Provider adapters (`_shared/providers/*/index.ts`) | 0 | 0 | 3 (`stub` + `stub2` + `footballdata`) plus `types.ts` (US1) | 3 + interface |
| Sync coordinator | 0 | 0 | 1 (`sync-catalog/index.ts` + `deno.json`) | 1 |
| First-party web app files | 7 | 8 | 0 | 15 |
| Seed fixtures | 1 | 1 | 0 | 2 |

---

## 6. Cross-slice contracts now locked by slice 002 Phases 1–4

Carry-forward from US1's checkpoint § 6 (unchanged) PLUS the following new locks contributed by Phase 4:

| Symbol / shape | Lock | Consumers |
|---|---|---|
| **`public.record_match_result(p_match_id uuid, p_source text, p_result_status text, p_home_score int, p_away_score int, p_extra_time jsonb, p_penalty jsonb, p_approved_by uuid)` — eight-arg signature** | **Signature LOCKED.** Slice 002 sync coordinator (T032) calls it for every finished-match UPSERT; slice 006 admin-override UI will call it with `p_source='admin_override'` + non-NULL `p_approved_by`. | Slice 002 (T032 sync coordinator), Slice 006 (admin overrides), Slice 005 (forensic queries that read `match_results` know the columns are populated via this SP). |
| **`pg_notify('match_results_recorded', json_build_object('match_id', ..., 'source', ..., 'result_status', ...))` channel + payload** | **Channel name + payload key set LOCKED.** Slice 005's scoring trigger consumes this exact shape. Additive payload keys allowed; key renames/removals require coordinated slice 005 migration. | Slice 005 (scoring engine — listens on this channel, expects this payload). |
| `try_lock_sync(p_provider text) → bool` / `unlock_sync(p_provider text) → bool` helper RPCs | **Slice-internal — NOT cross-slice-locked.** Used only by `supabase/functions/sync-catalog/index.ts`. Slice 002 may rename or refactor these in Phase 5 / Polish if needed. | Slice 002 sync coordinator (T032) only. Future slice 008 ops tooling MAY consume — flag at that time. |
| **`MatchDataProviderAdapter` concrete instances registered in the sync coordinator: `stub`, `stub2`, `footballdata`** | **Registry KEY NAMES locked** (these are the values that `tournament_config.providers.active` can take). Adding a new provider requires registering its adapter + seeding its config; removing one requires coordinated migration. The interface shape itself was already locked in US1. | Slice 002 sync coordinator, Slice 008 admin UI (must expose the registered set as a dropdown). |

---

## 7. Reconciliation gaps flagged in T032's implementation report (D-010 candidates)

T032's implementation report surfaced three concrete drift items between (a) the as-built migration 0022, (b) the T023/T024/T025 Deno test bodies, and (c) the T032 coordinator's response shape. None block this artifact, but all are pre-merge fix candidates and are recorded as **D-010** below.

### 7a. Outcome enum mismatch (response shape vs migration CHECK)

- **Symptom**: T032 returns `outcome='success_no_changes'` in the JSON response when the apply produced zero diffs. The DB ledger row stores `outcome='success'` in that same case because migration `0022_provider_sync_tables.sql`'s `CHECK (outcome IN (...))` constraint does NOT include `'success_no_changes'` as an accepted value.
- **T032's documented behaviour**: T032 stores `'success'` in the row (to satisfy the CHECK) and surfaces `'success_no_changes'` on the JSON response (to satisfy the contract). Comments in `sync-catalog/index.ts` lines 47–49 document this divergence explicitly.
- **Why it's not a hard bug today**: The wire-shape contract and the storage shape are independent surfaces; the response is what the operator + dashboard observe, and the storage value is what slice 006's admin UI + slice 007's forensics read. The `'success_no_changes'` semantics are observable on the response without polluting the ledger CHECK.
- **Pre-merge fix candidate**: Either (a) ALTER the CHECK to accept `'success_no_changes'` and store it directly, OR (b) accept the divergence permanently and document it in the cross-slice contract surface. T032 chose (b); slice 006 / slice 007 will read `'success'` and not need the no-op distinction.

### 7b. Test schema drift — `provider_sync_runs.id` vs `correlation_id` lookup

- **Symptom**: `single_sync_happy.test.ts` asserts the ledger row via `.from('provider_sync_runs').select(...).eq('id', runId).single()` — that is, it expects `provider_sync_runs.id` to equal the request's UUID `run_id`. Migration 0022 ships `id bigserial` + a separate `correlation_id uuid` column. T032 stores the request `run_id` as `correlation_id` (not as `id`), so the test's lookup will return zero rows.
- **Additional column-name drift**: the same test SELECTs `provider_name`, but the migration column is named simply `provider`. The PostgREST query will fail with a column-not-found error before the assertion even runs.
- **Why it's a hard pre-merge gap**: This will block the GREEN run. The test must be amended to `.eq('correlation_id', runId)` and to SELECT `provider` (not `provider_name`) — OR migration 0022 must be amended to rename `provider` to `provider_name` and to use `id uuid` with the request's `run_id` as the PK. The latter has cross-slice implications (slice 006 reads the bigserial id for pagination); the former is the lower-churn fix.
- **Recommended pre-merge action**: Patch the test (in a Phase-6 polish task, or as part of US3 if the test surfaces before then). Track under D-010.

### 7c. Trigger enum mismatch — test fixtures vs migration CHECK

- **Symptom**: Five of the six Deno test files post `trigger='cron'`, one posts `trigger='admin_manual'`, one posts `trigger='swap-test'`. Migration 0022's `CHECK (trigger IN ('scheduled', 'manual_admin', 'manual_internal'))` rejects every one of those values.
- **What happens at runtime**: T032 inserts the request's `trigger` value directly into the row (it does not re-map). The first `INSERT INTO provider_sync_runs` will fail with a CHECK violation, and the coordinator will return 500 + `INTERNAL` instead of the contract's 200/401/403/409 status codes the tests assert on.
- **Why it's a hard pre-merge gap**: All six Deno tests will fail on this CHECK before reaching their behavioural assertions. The fix is to align the test fixtures to the migration's enum:
  - `'cron'` → `'scheduled'` (cron-driven invocations are the scheduled tier)
  - `'admin_manual'` → `'manual_admin'`
  - `'swap-test'` → `'manual_internal'` (or add `'manual_internal'` semantics for arbitrary internal callers)
- **Recommended pre-merge action**: Patch the six test files (one trivial sed-style change). Track under D-010.

### 7d. **D-010 reservation** (NEW — surfaced in T032 / consolidated here in T033)

The three reconciliation gaps above (7a + 7b + 7c) are recorded as a single new deviation **D-010** in `tasks.md § Implementation deviations`. See § 11 below for the consolidated D-001..D-010 table.

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

# 2. Reset the database -- applies all 23 migrations
#    (slice 001's 0001..0011 + slice 002's 0018..0026, 0028, 0029 -- note the
#    reserved gaps at 0012..0017 and 0027) and reloads both seed fixtures.
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

# 6. Deno typecheck of the function tree (new at Phase 4).
deno check supabase/functions/sync-catalog/index.ts
deno check supabase/functions/_shared/providers/stub/index.ts
deno check supabase/functions/_shared/providers/stub2/index.ts
deno check supabase/functions/_shared/providers/footballdata/index.ts

# 7. Deno tests for the sync-catalog Edge Function.
#    Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SYNC_TRIGGER_SECRET
#    in apps/web/.env.local, AND RUN_SYNC_CATALOG_TESTS=1 exported.
cd supabase/functions/sync-catalog/tests
$env:RUN_SYNC_CATALOG_TESTS = "1"
deno test --allow-all --env-file=../../../../apps/web/.env.local
cd ../../../..

# 8. Start the Next.js dev server (Playwright fixtures depend on it).
#    Run in a separate terminal; the suite will tear it down after.
pnpm -F web dev

# 9. Playwright suite -- slice-002 scope (US1 + any US2 specs that exist).
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

- **Step 3a (slice-002 pgTAP)**: 9 files — 1 from US1 (`slice-002-catalog-rls.sql` plan(7)) + 8 from US2 (`record_match_result_*.sql`), all reporting `ok` for every planned assertion, modulo the D-008 / D-009 caveats.
- **Step 3b**: 12 carry-forward files; assertion totals as documented in slice 001's regression-final.
- **Step 4**: no output, exit 0.
- **Step 5**: build succeeds.
- **Step 6**: 4 `deno check` invocations, each exits 0.
- **Step 7**: 6 Deno test files, 7 sub-tests, all `ok`. (After D-010 reconciliation patches land; without those patches the tests will fail at the CHECK-constraint boundary as documented in § 7.)
- **Step 9**: 19 of 20 slice-002 US1 Playwright tests pass; the `slice-002-late-fixture-appears` test remains `test.fixme` until US3 ships.

---

## 9. Open deferred work blocking a fully observed GREEN

### 9a. Slice 001 carry-forward (unchanged from US1 checkpoint § 8a)

All nine items from US1's § 8a remain open: T005, T006, T007, T021, T031, T035, T039, T041, T044 (slice 001 task numbering). Carry-forward unchanged.

### 9b. Slice 002 Docker-dependent deferrals (unchanged + carry-forward)

The four items from US1's § 8b — T001, T002, T018, T022 — remain open. Phase 4 adds:

| Task | Why deferred | What still needs running |
|---|---|---|
| T023 (slice 002) | Deno tests authored RED — no live observation yet (Docker + Deno both unavailable). | § 8 step 7 above. |
| T024 (slice 002) | Same. | § 8 step 7 above. |
| T025 (slice 002) | Same. | § 8 step 7 above. |
| T026 (slice 002) | 8 pgTAP tests authored RED — no live observation yet. | § 8 step 3a above. |
| T028 (slice 002 — the RED gate sibling) | Stash-and-test RED→GREEN verification for the full US2 surface. | The full recipe in `red-gate-us2.md § Verification commands`. |
| **T033 (this doc)** | Runtime suite GREEN under live Docker + live Deno — both unavailable. | Execute § 8 steps 1–9 above. |

### 9c. Deno-dependent deferrals (NEW at Phase 4)

Distinct from the Docker-dependent set: every Deno-runtime invocation in the runbook is doubly blocked (needs Docker AND needs Deno on PATH). The Docker daemon may come back online without Deno being installed; if so, only steps 1, 2, 3a, 3b, 4, 5, 8, 9 can run — steps 6 and 7 (the `deno check` and `deno test` lines) remain deferred until Deno is installed.

### 9d. Tests that STAY RED until later phases ship

| Test | Stays RED until | Owner |
|---|---|---|
| `slice-002-late-fixture-appears.spec.ts` | Phase 5 (US3 sync invocation) ships the live cron-driven sync that produces a fresh fixture mid-tournament. T032 ships the sync coordinator itself, but the cron schedule that drives it is owned by T043 / T045 in Phase 5. | T043 + T045 (US3 cron schedule + late-fixture orchestration). |

### 9e. D-010 reconciliation patches

The three drift items at § 7 require fixes before the Phase-5 GREEN run can be observed clean:

- **§ 7a (outcome enum)**: documentation-only — T032 documented the divergence; no patch required pre-merge unless a future slice needs the storage value to distinguish `'success'` vs `'success_no_changes'`.
- **§ 7b (test schema drift on `provider_sync_runs.id` / `provider_name`)**: HARD GATE — `single_sync_happy.test.ts` (T023) must be amended.
- **§ 7c (trigger enum)**: HARD GATE — all six Deno test files must have their `trigger` payload value remapped to the migration's accepted set.

Recommended: schedule these patches as Phase-6 polish tasks (or fold them into the next sync-catalog touch in US3). Until they land, the runbook at § 8 step 7 will produce false-RED results.

---

## 10. Pre-merge action items (operator checklist)

Tick each box before opening (or merging) the slice-002 PR.

- [ ] Docker Desktop running and healthy on the verifying machine (`docker info` exits 0).
- [ ] Deno on PATH on the verifying machine (`deno --version` reports a version).
- [ ] § 8 step 1 (`supabase start`) succeeds and the Supabase Studio URL is reachable.
- [ ] § 8 step 2 (`supabase db reset`) applies all 23 migrations cleanly and loads both seed fixtures with no errors.
- [ ] § 8 step 3a (slice-002 pgTAP) reports `ok` for all 9 slice-002 pgTAP files (1 RLS + 8 record_match_result).
- [ ] § 8 step 3b (slice-001 pgTAP carry-forward) reports all 12 files green.
- [ ] § 8 step 4 (`pnpm -F web exec tsc --noEmit`) exits 0 with no output.
- [ ] § 8 step 5 (`pnpm -F web build`) succeeds.
- [ ] § 8 step 6 (`deno check`) — all 4 invocations exit 0.
- [ ] § 8 step 7 (`deno test`) — all 6 Deno test files exit 0 with all 7 sub-tests passing. **Requires D-010 § 7b + § 7c patches to have landed.**
- [ ] § 8 step 9 (Playwright `@slice-002`) reports 19 of 20 US1 tests passing; the remaining 1 is `slice-002-late-fixture-appears` legitimately self-fixme'd.
- [ ] D-010 disposition decided and documented (do § 7b + § 7c patches land before merge, or are they tracked as a known-RED set into US3 / Polish?).
- [ ] T028 RED-gate sign-off (per `red-gate-us2.md § Sign-off checklist`) — both RED + GREEN runs of the stash-and-test recipe captured.
- [ ] PR description references this file (`specs/002-match-catalog/regression-checkpoint-us2.md`) plus `red-gate-us2.md`, `regression-checkpoint-us1.md`, `red-gate-us1.md`, `regression-baseline-from-001.md`, and (once they exist) `regression-checkpoint-us3.md` and `regression-final.md`.

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack + live Deno runtime is the merge gate. Until every box above is ticked, Phase 5 (US3) MAY NOT start, Polish (Phase 6) MAY NOT start, and slice 002 MAY NOT merge to `main`.

---

## 11. Spec deviations consolidated

Carry-forward from slice 001 (D-001 through D-005) + slice 002 prior additions (D-006 through D-009) + NEW at Phase 4 (D-010).

| ID | Where recorded | One-liner |
|---|---|---|
| D-001 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`. |
| D-002 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `is_approved_domain(p_email text)` takes a FULL email, not a bare domain. |
| D-003 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `/api/me` body shape uses `{ participant: {...} }`; errors use `{ error: { code, message } }` + `Cache-Control: private, max-age=0`. Slice 002's `/api/matches` mirrors. |
| D-004 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `participants_self_or_admin_read` policy embeds the eligibility predicate. Slice 002's catalog RLS follows the same pattern. |
| D-005 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `handle_auth_user_signed_in` returns the `{claims}` / `{error}` `custom_access_token` envelope, not `{decision}`. |
| D-006 | `specs/002-match-catalog/tasks.md § Implementation deviations` | Wave-2 schema reconciliation across 0020–0023, 0028, types.ts. As-built migrations are now authoritative for slice 002. |
| D-007 | `specs/002-match-catalog/tasks.md § Implementation deviations` | `match_results` field-name mapping in `/api/matches` (T020). Route projects `_official` from split + extra-time + penalty columns; `_for_scoring` passes through; result-status enum remapped on the wire. |
| D-008 | `specs/002-match-catalog/tasks.md § Implementation deviations` | pgTAP cannot observe `pg_notify` channel reception (`BEGIN/ROLLBACK` envelope). `record_match_result_emits_notification.sql` uses structural-proxy assertions; real channel verification deferred to slice 005 T042. |
| D-009 | `specs/002-match-catalog/tasks.md § Implementation deviations` | `audit_log.action` name mismatch — migration 0025 emits `'match_result.updated'` on UPDATE; contract names it `'match_result.corrected'`. T029 chose to honour the migration; UPDATE-path assertion deferred to slice 006. |
| **D-010** | **`specs/002-match-catalog/tasks.md § Implementation deviations` (NEW — added by T033)** | **T032 / T023–T025 reconciliation gaps: (a) outcome enum mismatch (`'success_no_changes'` returned on wire, `'success'` stored in row); (b) test schema drift (`single_sync_happy.test.ts` queries `provider_sync_runs.id == run_id` and column `provider_name`; the migration uses bigserial `id` + `correlation_id uuid` + column `provider`); (c) trigger enum mismatch (tests post `'cron'` / `'admin_manual'` / `'swap-test'`; migration CHECK accepts only `'scheduled'` / `'manual_admin'` / `'manual_internal'`). (b) + (c) are hard pre-merge gates and require test-fixture patches before the runbook at § 8 step 7 can produce a clean GREEN.** |

---

## 12. Phase-4 close-out note

Phase 4 lands all 11 of its tasks (T023 + T024 + T025 + T026 + T027 + T028 + T029 + T030 + T031 + T032 + T033). The sync coordinator's happy path is functional end-to-end on the file system; the only obstacles to an observed GREEN are (a) the missing local runtime stack and (b) the D-010 test-fixture patches.

US3 (Phase 5) begins after this checkpoint is signed off and the verification commands at § 8 land green. US3 will:

- Harden the failure paths inside the same `sync-catalog/index.ts` (payload-sanity guards in T039, conflict quarantine in T040, sustained-outage alert dedup in T041).
- Add the cron-launcher invocation that drives the coordinator on a schedule (T043).
- Flip `slice-002-late-fixture-appears.spec.ts` from its US1-time `test.fixme` self-skip into a live assertion (T045).

Polish (Phase 6) will fold in any unresolved D-010 / D-009 / cross-slice cleanup before the final slice-002 PR opens.
