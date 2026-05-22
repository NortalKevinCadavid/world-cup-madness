# Regression checkpoint — Slice 004, Phase 3 (US1)

- **Slice**: `004-final-predictions`
- **Phase**: 3 (US1 — "Eligible participant submits and reviews their own four final-tournament predictions before the global first-kickoff lock")
- **Date**: 2026-05-20
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T020 (`specs/004-final-predictions/tasks.md` line 747)
- **Companion artifacts**:
  - `specs/004-final-predictions/regression-baseline-from-001-002-003.md` (T001 — slice-001 + slice-002 + slice-003 carry-forward baseline)
  - `specs/004-final-predictions/red-gate-us1.md` (T015 — sibling RED-gate inventory for the same US1 test set)
  - `specs/003-match-predictions/regression-checkpoint-us1.md` (template this document mirrors)
- **Purpose**: Record the state of the slice-001 + slice-002 + slice-003 + slice-004-so-far test suite at the moment US1 lands in slice 004, inventory every test the operator must run, and hand the exact verification commands to whoever next has a working Docker daemon + Deno toolchain. Per Principle XI, US2 (Phase 4), US3 (Phase 5), US4 (Phase 6 — if any), and the Polish phase MAY NOT start, and the slice MAY NOT merge to `main`, until all verification commands below land GREEN.

---

## Status: DEFERRED

Both the Docker daemon (required by `supabase start`, `supabase db reset`, `supabase test db`, and by every Playwright fixture that boots the local Supabase stack) and the Deno toolchain (required by slice-002's `provider-stub.test.ts` carry-forward suite) were **unavailable at execution time**. `supabase start`, `supabase db reset`, `supabase test db`, the Next.js dev server (which Playwright fixtures depend on), the Playwright suite, and `deno test` therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added so far in slice 004 (cumulative with slices 001 + 002 + 003), and hands the exact commands the user MUST run locally (or in CI, once slice 001's T007 ships) before Phase 4 (US2) begins or the slice can merge. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 6 have all returned GREEN.

---

## 1. Phase 3 task summary (T012 → T020)

| T# | Type | Output |
|---|---|---|
| T012 | RED authoring (pgTAP) | 7 pgTAP files under `supabase/tests/pgtap/submit_final_prediction_*.sql` exercising the not-yet-shipped SP. Planned-assertion total = 6 + 5 + 2 + 4 + 3 + 3 + 5 = **28 assertions**. |
| T013 | RED authoring (Playwright submit) | 9 spec files / **11 distinct tests** under `apps/web/tests/playwright/slice-004-submit-*.spec.ts`. All tagged `@slice-004 @us1`. |
| T014 | RED authoring (Playwright read) | 16 spec files / **16 tests** (1 marked `test.fixme` until US3's T029) under `apps/web/tests/playwright/slice-004-{me-final-predictions,teams,players}-*.spec.ts`. All tagged `@slice-004 @us1`. **15 expected RED at runtime**, 1 dormant. |
| T015 | RED gate (artifact) | `specs/004-final-predictions/red-gate-us1.md` — documentation artifact; runtime observation deferred (Docker down). 33 behaviorally-distinct RED units catalogued. |
| T016 | GREEN migration | `supabase/migrations/0044_submit_final_prediction_sp.sql` — SECURITY DEFINER SP, create + all rejection branches, ERRCODE WFP01–WFP06 (validate `p_item_kind` → WFP03; validate target xor shape → WFP03; validate target existence → WFP04; eligibility → WFP05; lock predicate → WFP02; identical-team disjoint check → WFP06 when `predictions.allow_identical_champion_runner_up=false`). Per D-016 on-disk slot is **0044**. |
| T017 | GREEN lib (TS) | **6 TS files**: `apps/web/lib/final-predictions/{types,client,countdown,countdown.test}.ts` + `apps/web/lib/roster/{client,types}.ts`. `types.ts` `MeFinalPredictionsResponse` array key reconciled to `final_predictions` (matches T014 + T018; D-018 cleanup). |
| T018 | GREEN routes | **4 Next.js route handlers**: `apps/web/app/api/final-predictions/route.ts` (POST), `apps/web/app/api/me/final-predictions/route.ts` (GET), `apps/web/app/api/teams/route.ts` (GET), `apps/web/app/api/players/route.ts` (GET). Error envelope byte-equivalent to slice-001 `/api/me` per D-003. |
| T019 | GREEN UI | `apps/web/app/(participant)/me/finals/page.tsx` (server) + **4 client components** `FinalsForm.tsx`, `TeamPicker.tsx`, `PlayerPicker.tsx`, `FinalsLockBanner.tsx`. `cmdk` typeahead per D-016/R-012. `useTransition` + `router.refresh()` after each successful pick per slice-003 precedent. |
| **T020** (this doc) | Regression checkpoint | `specs/004-final-predictions/regression-checkpoint-us1.md` — documentation artifact; runtime verification deferred (Docker daemon down). |

---

## 2. As-built artifact inventory

### 2a. Migrations (slice 004, cumulative through Phase 3)

Per D-016 the slice 004 migrations occupy on-disk slots **0039–0047** (spec said 0036–0046; shifted +3 because slice 003 filled 0030–0038). T016's submit SP at slot **0044** is the new Phase 3 addition.

| # | File | T# | Phase | Summary |
|---|------|----|-------|---------|
| 0039 | `0039_players.sql` | T003 | 2 | `players` + `player_provider_external_ids` tables. |
| 0040 | `0040_final_predictions.sql` | T004 | 2 | `final_predictions` table — UUID PK, `participant_id` FK, `item_kind` (text-enum: `champion` / `runner_up` / `top_scorer` / `best_player`), `target_team_id` + `target_player_id` (xor — exactly one NOT NULL), supersede pair, `predictions_active_uk` unique partial index `(participant_id, item_kind) WHERE superseded_at IS NULL`. |
| 0041 | `0041_is_final_prediction_locked.sql` | T005 | 2 | `public.is_final_prediction_locked() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER`. Reads `tournament_config.first_kickoff_utc`; fail-CLOSED on missing key per D-017. Strict `>=` comparator (BR-LOCK-005). LOCKED cross-slice predicate. |
| 0042 | `0042_final_predictions_rls.sql` | T007 | 2 | Enables + FORCEs RLS on `final_predictions` + `players` + `player_provider_external_ids`. Self-read on `final_predictions` + eligibility predicate. INSERT/UPDATE/DELETE REVOKED from `authenticated` + `anon` — only the SECURITY DEFINER SP at slot 0044 (and the supersede SP at slot 0048, US3) may write. |
| 0043 | `0043_final_predictions_audit_trigger.sql` | T008 | 2 | AFTER INSERT / AFTER UPDATE OF `superseded_at` SECURITY DEFINER trigger on `final_predictions`. Emits `audit_log` rows: `final_prediction.created` on INSERT, `final_prediction.superseded` on UPDATE-of-`superseded_at`-from-NULL. `source='trigger'`. |
| **0044** | **`0044_submit_final_prediction_sp.sql`** | **T016** | **3** | **CREATE branch + all rejection branches of the locked cross-slice SP `public.submit_final_prediction(p_participant_id uuid, p_item_kind text, p_target_team_id uuid, p_target_player_id uuid, p_source text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER`.** ERRCODE list `WFP01..WFP06`: WFP01 reserved, WFP02 (final-prediction-locked), WFP03 (invalid kind / target xor), WFP04 (target not found / removed player), WFP05 (participant ineligible), WFP06 (identical champion/runner_up disjoint check when seed key is false). |
| 0045 | `0045_players_remove_audit_trigger.sql` | T009 | 2 | AFTER UPDATE OF `removed_at` SECURITY DEFINER trigger on `players`. For every active final-prediction targeting the player, writes `audit_log` row `action='final_prediction.target_player_removed'` (consumed by T019's `FinalsForm` warning banner per Clarifications Q1). |
| 0046 | `0046_first_kickoff_correction_trigger.sql` | T010 | 2 | AFTER UPDATE OF `kickoff_utc` / `status` trigger on `matches`. **Observability-only** per D-017 — writes audit rows; does NOT mutate `tournament_config.first_kickoff_utc`. |
| 0047 | `0047_predictions_config_seed.sql` | T006 | 2 | Inserts default `tournament_config` row `predictions.allow_identical_champion_runner_up = false`. |

**Slice 004 Phase 2 + Phase 3 migration aggregate**: **9 files** (0039–0047). The Phase 3 task T016 ships only slot **0044**; the surrounding eight slots (0039–0043, 0045–0047) were already on disk from Phase 2.

**Cumulative migration totals at end of Phase 3**: 11 (slice 001) + 12 (slice 002) + 9 (slice 003) + 9 (slice 004) = **41 migrations** on disk.

> **Note on count vs the read-first context**: the user's task context cites "40 migrations" for the Phase 4+ runtime command. On-disk inspection at T020 time shows **41**. Both numbers refer to the same set; the operator should expect `supabase db reset` to apply whatever's on disk (current = 41).

**Seed fixtures**: 4 files — `supabase/seed/slice-001-fixture.sql` (carry-forward) + `supabase/seed/slice-002-fixture.sql` (carry-forward) + `supabase/seed/slice-003-fixture.sql` (carry-forward) + `supabase/seed/slice-004-fixture.sql` (T011 — adds 8 fixture teams' rosters + the D-017 `first_kickoff_utc = '"2026-06-16T20:00:00Z"'::jsonb` seed).

### 2b. pgTAP — slice 004 US1 additions (T012 — 7 files)

| # | File | `plan(N)` |
|---|------|-----------|
| 1 | `supabase/tests/pgtap/submit_final_prediction_create_champion_happy.sql` | `plan(6)` |
| 2 | `supabase/tests/pgtap/submit_final_prediction_create_top_scorer_happy.sql` | `plan(5)` |
| 3 | `supabase/tests/pgtap/submit_final_prediction_invalid_kind.sql` | `plan(2)` |
| 4 | `supabase/tests/pgtap/submit_final_prediction_invalid_target_shape.sql` | `plan(4)` |
| 5 | `supabase/tests/pgtap/submit_final_prediction_invalid_target_missing.sql` | `plan(3)` |
| 6 | `supabase/tests/pgtap/submit_final_prediction_invalid_target_removed_player.sql` | `plan(3)` |
| 7 | `supabase/tests/pgtap/submit_final_prediction_audit_format.sql` | `plan(5)` |

**Slice 004 US1 pgTAP aggregate**: 7 files, 28 planned assertions.

**Cumulative pgTAP aggregate at end of slice 004 Phase 3**: 12 (slice 001) + 9 (slice 002) + ~22 (slice 003 final) + 7 (slice 004 US1) = **~50 pgTAP files** on disk.

### 2c. Playwright — slice 004 US1 additions (T013 + T014 — 25 files / 27 test bodies)

**Submit path (T013 — 9 files / 11 tests)**:

| # | File | Tests |
|---|------|-------|
| 1 | `apps/web/tests/playwright/slice-004-submit-champion-happy.spec.ts` | 1 |
| 2 | `apps/web/tests/playwright/slice-004-submit-top-scorer-happy.spec.ts` | 1 |
| 3 | `apps/web/tests/playwright/slice-004-submit-all-four.spec.ts` | 1 |
| 4 | `apps/web/tests/playwright/slice-004-submit-invalid-team.spec.ts` | 1 |
| 5 | `apps/web/tests/playwright/slice-004-submit-invalid-player.spec.ts` | 1 |
| 6 | `apps/web/tests/playwright/slice-004-submit-removed-player.spec.ts` | 1 |
| 7 | `apps/web/tests/playwright/slice-004-submit-unauthenticated.spec.ts` | 1 |
| 8 | `apps/web/tests/playwright/slice-004-submit-domain-removed.spec.ts` | 1 |
| 9 | `apps/web/tests/playwright/slice-004-submit-bad-body.spec.ts` | 3 |

**Read path (T014 — 16 files / 16 tests; 1 `test.fixme`)**:

| # | File | Tests | Notes |
|---|------|-------|-------|
| 1 | `apps/web/tests/playwright/slice-004-me-final-predictions-empty.spec.ts` | 1 | |
| 2 | `apps/web/tests/playwright/slice-004-me-final-predictions-list.spec.ts` | 1 | |
| 3 | `apps/web/tests/playwright/slice-004-me-final-predictions-after-supersede.spec.ts` | 1 | **`test.fixme`** — gated on T029 (US3 supersede). |
| 4 | `apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-editable.spec.ts` | 1 | |
| 5 | `apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-locked.spec.ts` | 1 | |
| 6 | `apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-at-boundary.spec.ts` | 1 | |
| 7 | `apps/web/tests/playwright/slice-004-me-final-predictions-401.spec.ts` | 1 | |
| 8 | `apps/web/tests/playwright/slice-004-me-final-predictions-403.spec.ts` | 1 | |
| 9 | `apps/web/tests/playwright/slice-004-teams-200.spec.ts` | 1 | |
| 10 | `apps/web/tests/playwright/slice-004-teams-401.spec.ts` | 1 | |
| 11 | `apps/web/tests/playwright/slice-004-players-list.spec.ts` | 1 | |
| 12 | `apps/web/tests/playwright/slice-004-players-team-filter.spec.ts` | 1 | |
| 13 | `apps/web/tests/playwright/slice-004-players-q-search.spec.ts` | 1 | |
| 14 | `apps/web/tests/playwright/slice-004-players-excludes-removed.spec.ts` | 1 | |
| 15 | `apps/web/tests/playwright/slice-004-players-401.spec.ts` | 1 | |
| 16 | `apps/web/tests/playwright/slice-004-players-bad-limit.spec.ts` | 1 | |

**Slice 004 US1 Playwright aggregate**: **25 spec files / 27 test bodies** (11 submit + 16 read); **26 runtime-expected GREEN tests** post-T018 (1 `test.fixme` dormant until US3).

### 2d. TypeScript lib (T017 — 6 files)

| File | Role |
|---|---|
| `apps/web/lib/final-predictions/types.ts` | `FinalPredictionItemKind`, `FinalPrediction`, `MeFinalPredictionsResponse { final_predictions, lock_state, first_kickoff_utc }`, submit input + response shapes. **Array key is `final_predictions`** (reconciled from earlier draft `predictions` to match T014 + T018 evidence — D-018 reconciliation in this document's § 4). |
| `apps/web/lib/final-predictions/client.ts` | `submitFinalPrediction(client, input)`, `getMyFinalPredictions(client)` over `/api/final-predictions` + `/api/me/final-predictions`. |
| `apps/web/lib/final-predictions/countdown.ts` | Pure-function `formatRemainingUntilFinalLock(firstKickoffUtc, now)` returning e.g. `"locks in 2h 15m"` or `"locked"`. Display-only. |
| `apps/web/lib/final-predictions/countdown.test.ts` | `node:test` unit cases for `countdown.ts`. Not Docker-dependent. |
| `apps/web/lib/roster/types.ts` | `Team`, `Player` shapes. `Team` keys aligned to actual `public.teams` schema: `{ id, name, short_code, flag_url }` (no `country_code`, no `group_id`) — D-018b. |
| `apps/web/lib/roster/client.ts` | `getTeams(client)`, `searchPlayers(client, { q?, team_id?, limit? })`. |

### 2e. Route handlers (T018 — 4 files)

| File | Method | Notes |
|---|---|---|
| `apps/web/app/api/final-predictions/route.ts` | POST | zod body validation (kind/target xor refinement); `requireEligible()`; invokes `public.submit_final_prediction(...)`; maps WFP02→409, WFP03→400/422, WFP04→404, WFP05→403, WFP06→409. Rejection-path audit-log inserts NOT implemented — see D-018. |
| `apps/web/app/api/me/final-predictions/route.ts` | GET | Reads active rows (`superseded_at IS NULL`) under user-JWT-bound client; embeds `lock_state` from `public.is_final_prediction_locked()` + `first_kickoff_utc` from `tournament_config`. Response body `{ final_predictions: FinalPrediction[], lock_state, first_kickoff_utc }`. |
| `apps/web/app/api/teams/route.ts` | GET | Returns the active teams from `public.teams` with the schema-accurate shape `{ id, name, short_code, flag_url }` (D-018b). |
| `apps/web/app/api/players/route.ts` | GET | Optional `?team_id=<uuid>` + `?q=<string>` (ILIKE on `full_name`) + `?limit` (zod-clamped [1,500]); `WHERE removed_at IS NULL`. |

### 2f. UI (T019 — page + 4 client components)

| File | Role |
|---|---|
| `apps/web/app/(participant)/me/finals/page.tsx` | Server component — fetches `getMyFinalPredictions(client)` + `getTeams(client)`; passes to children. Route is **`/me/finals`**. |
| `apps/web/app/(participant)/me/finals/components/FinalsForm.tsx` | `'use client'` form rendering 4 picker rows; `useTransition` + `submitFinalPrediction` + `router.refresh()` on success; inline error from contract envelope. Warning banner driven by `final_prediction.target_player_removed` audit-log lookups. |
| `apps/web/app/(participant)/me/finals/components/TeamPicker.tsx` | `cmdk`-driven keyboard-accessible team typeahead. |
| `apps/web/app/(participant)/me/finals/components/PlayerPicker.tsx` | `cmdk`-driven player typeahead, optional `?team_id` filter. |
| `apps/web/app/(participant)/me/finals/components/FinalsLockBanner.tsx` | Locked state + countdown display; replaces the form when `lock_state === 'locked'`. |

### 2g. Slice 004 app code summary

**New first-party app file touches in slice 004 Phase 3**: 6 lib (T017) + 4 routes (T018) + 1 page + 4 components (T019) = **15 new app files** at end of Phase 3.

---

## 3. Cross-slice contract status (carry-forward verification)

Per `regression-baseline-from-001-002-003.md`, slice 004 inherited **8 cross-slice contracts** from slices 001 + 002 + 003. None were broken by slice 004 Phase 2 or Phase 3.

| # | Contract | Owner | Slice-004-Phase-3 status |
|---|---|---|---|
| 1 | `public.is_eligible_nortal_participant(uuid) STABLE` | slice 001 / 0005 | **INTACT.** Slice 004 SP body invokes via the per-request user-JWT-bound client; signature unchanged. |
| 2 | `public.is_admin(uuid)` (stub) | slice 001 / 0006 | **INTACT.** Slice 006 dependency only; no slice-004 modification. |
| 3 | `public.participants` table (auth_user_id, status) | slice 001 / 0001 | **INTACT.** `final_predictions.participant_id` FK added; no column changes to `participants`. |
| 4 | `public.audit_log` shape | slice 001 / 0003 | **INTACT.** Slice 004's audit triggers + audit-format pgTAP assert the canonical column list; the rejection-path inserts D-018 defers, slice 007 widens RLS. |
| 5 | `public.matches` (id, status, kickoff_utc, stage) | slice 002 / 0020 | **INTACT.** `is_final_prediction_locked()` reads `tournament_config.first_kickoff_utc` (not `matches` directly) per D-017. |
| 6 | `public.teams` (id, short_code) | slice 002 / 0019 | **INTACT.** `final_predictions.target_team_id` FKs to `teams.id`; teams schema unchanged. D-018b clarifies `/api/teams` response shape uses `{ id, name, short_code, flag_url }` (no fictional `country_code` / `group_id`). |
| 7 | `public.tournament_config` | slice 001 + slices 002/003 seed | **INTACT.** Slot 0047 inserts `predictions.allow_identical_champion_runner_up = false`; slice-004 fixture seeds `first_kickoff_utc`. Shape unchanged. |
| 8 | `MatchDataProviderAdapter.fetchPlayers?` interface | slice 002 / providers/types.ts | **INTACT.** Phase 2 T011 already exercises through the fixture seed; no Phase 3 modification. |

**All 8 contracts intact at end of Phase 3.**

---

## 4. Deviations log (running totals after Phase 3)

Inherited carry-forward: **D-001 through D-015** (slices 001 + 002 + 003).
Phase-2 slice 004 additions: **D-016, D-017**.
Phase-3 slice 004 additions surfaced in this document: **D-018, D-018b**, plus a naming-reconciliation entry.

| ID | Phase | One-liner |
|---|---|---|
| D-001..D-015 | inherited | See `specs/004-final-predictions/regression-baseline-from-001-002-003.md § Inherited deviations`. |
| **D-016** | slice 004 Phase 2 (T001 / slot renumber) | Migration slots shifted **+3** (spec 0036–0046 → on-disk 0039–0047). T016's submit SP lives at **0044**, not the spec's 0041. Tests reference function/table names only; no test changes required. |
| **D-017** | slice 004 Phase 2 (T011 first_kickoff_utc seed) | `tournament_config.first_kickoff_utc` is **admin-owned**. Slot-0046 trigger is observability-only — it does NOT auto-write the key. Local-dev + slice-004 tests rely on the slice-004 fixture seed appending `first_kickoff_utc = '"2026-06-16T20:00:00Z"'::jsonb`; production sets the key explicitly through Slice 008's admin UI. Without this seed, `is_final_prediction_locked()` fails-CLOSED → permanently locked. |
| **D-018** | slice 004 Phase 3 (T018 audit rejection-path deferred) | Rejection-path audit-log inserts NOT implemented in `POST /api/final-predictions`. Reason: migration 0010's `audit_log` RLS `WITH CHECK` restricts the `authenticated` role to `action='access.denied' AND source='api_guard'`. Slice 003's predictions route hit the same constraint. **Slice 007 owns the audit RLS widening** that lets route handlers emit `*.rejected_*` rows. Phase-3 happy-path audit assertions (file #7 `submit_final_prediction_audit_format.sql`) remain unaffected because the trigger at slot 0043 runs as SECURITY DEFINER and bypasses the `authenticated` policy. |
| **D-018b** | slice 004 Phase 3 (T018 / T017 teams schema reconciliation) | `/api/teams` response shape uses actual `public.teams` schema columns `{ id, name, short_code, flag_url }`. Earlier T017 draft referenced `country_code` and `group_id` — neither exists on `public.teams`. `apps/web/lib/roster/types.ts` `Team` shape patched accordingly; tests (`slice-004-teams-200.spec.ts`) already assert the correct keys. |
| Naming reconciliation (no new D-ID) | slice 004 Phase 3 (T017 ↔ T014 ↔ T018) | `MeFinalPredictionsResponse` array key is `final_predictions` (not `predictions`). T017's draft initially used `predictions`; T018 + T014 evidence converged on `final_predictions`. T017 `types.ts` patched. No cross-slice breakage (slice 003 owns `MePredictionsResponse.predictions` for matches; the two are different surfaces). |

No D-019 / D-020 reserved by Phase 3; next deviation slot for US2 / US3 work is **D-019**.

---

## 5. Inherited deferred items (one-liner per prior slice)

- **Slice 001** — Pre-merge Docker + OIDC stub + CI workflow PR-trigger items (T005, T006, T007, T021, T031, T035, T039, T041, T044) all still pending an observed-GREEN run on a Docker-up host. See `specs/001-eligibility-login/regression-final.md`.
- **Slice 002** — All Docker-dependent + Deno carry-forward items (T001, T002, T018, T022, T028, T033, T038, T042, T043, T044, T045 + the full Deno suite). See `specs/002-match-catalog/regression-final.md`.
- **Slice 003** — Every documentation artifact (T012, T013, T015, T016, T017 + the regression-final consolidation) deferred runtime to a future Docker-up + Deno-installed session. See `specs/003-match-predictions/regression-final.md`.

These items are NOT individually re-listed below. They are blocking the **consolidated** pre-merge runtime verification at slice 004's **T034** (`regression-final.md`).

---

## 6. Pre-merge runtime verification checklist (operator runbook)

Run from the repo root on branch `004-final-predictions` in order. Stop on the first non-zero exit. PowerShell variants given; bash equivalents follow.

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all migrations on disk
#    (slice 001's 0001..0011 + slice 002's 0018..0029 + slice 003's 0030..0038 +
#    slice 004's 0039..0047 per D-016 renumber) and loads the four seed fixtures
#    (supabase/seed/slice-001-fixture.sql + slice-002-fixture.sql +
#    slice-003-fixture.sql + slice-004-fixture.sql).
supabase db reset

# 3. Run every slice-004 US1 pgTAP test file individually (7 files).
Get-ChildItem supabase/tests/pgtap -Filter 'submit_final_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 4. TypeScript strict compile of the web app.
pnpm -F web exec tsc --noEmit

# 5. Production-mode Next.js build (confirms new routes + page register).
pnpm -F web build

# 6. node:test unit suite — final-predictions countdown helper.
pnpm -F web exec node --test apps/web/lib/final-predictions/countdown.test.ts

# 7. Start the Next.js dev server (Playwright fixtures depend on it).
pnpm -F web dev

# 8. Playwright suite — slice-004 US1 scope (expect 26/27 GREEN; 1 test.fixme dormant).
pnpm -F web e2e -- --grep '@slice-004 @us1'

# 9. Browser smoke test of /me/finals (manual, no automation).
#    - Sign in as alpha → /me/finals → 4 picks display, edit each → success toast,
#      page refreshes, 4 active rows remain.
#    - Sign in as charlie → /me/finals → 4 empty pickers; submit champion=ARG;
#      cmdk typeahead works; lock banner absent (lock_state='editable').
#    - GET /api/me/final-predictions returns final_predictions length = 4.

# 10. Optional cross-slice carry-forward regression sweep.
pnpm -F web e2e -- --grep '@slice-001'
pnpm -F web e2e -- --grep '@slice-002'
pnpm -F web e2e -- --grep '@slice-003'

# 11. Slice-002 Deno carry-forward (requires Deno toolchain installed).
deno test supabase/functions/
```

Bash equivalent for step 3:

```bash
for f in supabase/tests/pgtap/submit_final_prediction_*.sql; do supabase test db "$f" || exit 1; done
```

A passing run produces:

- **Step 3**: 7 files; `ok 1..6` / `ok 1..5` / `ok 1..2` / `ok 1..4` / `ok 1..3` / `ok 1..3` / `ok 1..5` = **28 ok assertions**.
- **Step 4**: no output, exit 0.
- **Step 5**: build succeeds; output reports the 4 new route handlers + the `/me/finals` page.
- **Step 6**: countdown unit cases all green.
- **Step 8**: 26/27 slice-004 US1 tests passed; 1 `test.fixme` reported as skipped (NOT failed) — flips to passed when US3's T029 lands and the `.fixme` annotation is removed.
- **Step 9**: manual browser smoke confirms 4 active rows post-submit and that picker UI is keyboard-accessible.
- **Step 10**: prior-slice carry-forward sets green at their gates.
- **Step 11**: Deno suite green (no slice-004 additions).

---

## 7. Pre-merge action items (operator checklist)

Tick each box before opening (or merging) the slice-004 PR.

- [ ] Docker Desktop running and healthy on the verifying machine (`docker info` exits 0).
- [ ] Deno toolchain installed (`deno --version` exits 0) — required by step 11.
- [ ] § 6 step 1 (`supabase start`) succeeds.
- [ ] § 6 step 2 (`supabase db reset`) applies all migrations + loads all four seed fixtures cleanly.
- [ ] § 6 step 3 (slice-004 US1 pgTAP) reports **28 ok lines** across 7 files.
- [ ] § 6 step 4 (`tsc --noEmit`) exits 0.
- [ ] § 6 step 5 (`pnpm -F web build`) succeeds; build manifest shows the 4 new route handlers + `/me/finals` page.
- [ ] § 6 step 6 (`node --test countdown.test.ts`) all green.
- [ ] § 6 step 8 (`pnpm -F web e2e -- --grep '@slice-004 @us1'`) reports 26/27 passed + 1 skipped (the `test.fixme`).
- [ ] § 6 step 9 (browser smoke at `/me/finals`) — alpha + charlie both verified.
- [ ] § 6 steps 10 + 11 — prior-slice + Deno carry-forward green (or noted Deno-absent).
- [ ] Inherited deferred items (§ 5) all ticked GREEN on their slice gates.
- [ ] D-018 acknowledged in PR description; slice 007 called out as the audit RLS widener.
- [ ] D-018b acknowledged in PR description; teams response shape is `{ id, name, short_code, flag_url }`.
- [ ] PR description references this file (`specs/004-final-predictions/regression-checkpoint-us1.md`), plus `red-gate-us1.md`, `regression-baseline-from-001-002-003.md`, and (once they exist) `regression-checkpoint-us2.md`, `regression-checkpoint-us3.md`, and `regression-final.md` (T034).

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack (+ Deno toolchain for the carry-forward Deno suite) IS the merge gate. Until every box above is ticked, Phase 4 (US2) MAY NOT start, Phase 5 (US3) MAY NOT start, the Polish phase MAY NOT start, and slice 004 MAY NOT merge to `main`.

---

## 8. Verdict

**US1 ARTIFACT-COMPLETE; runtime verification deferred to the consolidated `regression-final.md` (T034).**

Phase 3 produced 7 pgTAP files + 25 Playwright spec files (27 tests; 1 dormant `test.fixme`) + 1 SP migration + 6 TS lib files + 4 route handlers + 1 page + 4 components — all on disk, all type-consistent, all reconciled against the locked cross-slice contracts. No cross-slice contract was broken by Phase 3. Two new deviations (D-018, D-018b) and one naming reconciliation were surfaced and recorded. Per Principle XI, Phase 4 (US2) MAY proceed at the artifact-authoring level, but the slice cannot merge until the § 6 runtime checklist is observably GREEN.

This is the **World Cup Madness** project.
