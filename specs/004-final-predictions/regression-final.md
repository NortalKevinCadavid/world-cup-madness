# Slice 004 — Final Regression Gate

**Slice**: 004 — Final Tournament Predictions
**Task**: T034
**Date**: 2026-05-20
**Constitution anchor**: Principle XI (NON-NEGOTIABLE — final regression gate before merge)
**Status**: **DEFERRED (Docker daemon down + Deno not installed locally)**

This is the consolidated pre-merge regression gate spanning **slices 001 + 002 + 003 + 004**. Every artifact slice 004 needs is on disk, type-clean, and reconciled against the cross-slice contracts. Runtime verification (Docker-up + Deno-installed sweep) is the merge gate per Principle XI; it is captured in this document as an actionable PowerShell checklist for the operator who next has a working stack.

---

## 1. Cumulative artifact inventory (verified via `Glob`)

| Surface | Count | Glob target |
|---|---|---|
| Migrations on disk | **42 files** | `supabase/migrations/*.sql` |
| pgTAP files | **68 files** | `supabase/tests/pgtap/*.sql` |
| Playwright spec files (incl. `smoke.spec.ts` harness) | **86 files** | `apps/web/tests/playwright/*.spec.ts` |
| Deno tests (sync-catalog) | **15 files** | `supabase/functions/sync-catalog/tests/*.test.ts` |
| Seed fixtures | **4 files** | `supabase/seed/slice-00{1,2,3,4}-fixture.sql` |
| CI workflows | **1 file** | `.github/workflows/ci.yml` |

### Migration slot accounting

The repo uses slot numbers 0001–0048 with a documented gap at 0012–0017 (D-006 wave-2 reconciliation in slice 002 vacated those slots when the original draft was renumbered). Filled slots:

| Slice | Slot range | Count |
|---|---|---|
| 001 — Eligibility & Login | 0001–0011 | 11 |
| 002 — Match Catalog & Provider Sync | 0018–0029 | 12 |
| 003 — Match Predictions with Locking | 0030–0038 | 9 |
| 004 — Final Tournament Predictions | 0039–0048 | 10 |
| **Total** | **42 files across slots 1–48** | **42** |

The prompt's narrative "slot count: 48 migrations on disk" reads the slot range, not the filled-file count; the artifact-true number is **42 migration files** with the documented 6-slot gap. No remediation required — Postgres only enforces ordering, not contiguity.

### pgTAP breakdown

| Slice | Count | Notes |
|---|---|---|
| 001 | 12 | eligibility predicates + auth hook + RLS + perf |
| 002 | 9 | catalog RLS + 8 × `record_match_result_*` |
| 003 | 22 | `submit_prediction_*` (7) + `is_prediction_locked_*` (12 incl. perf) + supersede + admin_override + serializes_concurrent |
| 004 (US1+US2+US3) | 21 | `submit_final_prediction_*` (12) + `is_final_prediction_locked_*` (9 incl. perf) |
| 004 (Phase 6 / T031) | 4 | `players_ingest_{happy, update, soft_delete, undersized_quarantined}` |
| **Total** | **68** | |

### Playwright breakdown

| Slice | Count |
|---|---|
| harness `smoke.spec.ts` | 1 |
| 001 | 14 |
| 002 | 13 (12 from US1+US2+US3 + 1 reconciled in this slice) |
| 003 | 25 |
| 004 | 33 (26 US1 + 6 US2 + 2 US3 net-new — T027's third file was the US1 `test.fixme` flipped active in T027) |
| **Total** | **86** |

### Deno breakdown

| Slice | Count |
|---|---|
| 002 (sync-catalog US1+US2+US3 + perf) | 14 |
| 004 / T031 (`players_branch.test.ts`) | 1 |
| **Total** | **15** |

### First-party app files (slice 004 net-new)

`apps/web/app/api/final-predictions/route.ts`, `apps/web/app/api/me/final-predictions/route.ts`, `apps/web/app/api/teams/route.ts`, `apps/web/app/api/players/route.ts`, `apps/web/app/(participant)/me/finals/page.tsx`, plus `components/` (FinalsForm, TeamPicker, PlayerPicker, FinalsLockBanner), plus `lib/finals/{types, client, countdown}.ts` and adjacent unit tests. Approximate slice-004 first-party file count: **11**, on top of the **~21** first-party files inherited from slices 001 + 002 + 003. **Cumulative app surface: ~32 files.**

---

## 2. Surfaces matrix

One row per "surface" with implementation status (artifact on disk) and local-runtime-verification status.

| Surface | Implementation | Local runtime verification |
|---|---|---|
| Migrations 0001–0048 (42 files; slots 0012–0017 vacated per D-006) | ✓ on disk | DEFERRED — needs `supabase db reset` |
| pgTAP × 68 | ✓ authored | DEFERRED — needs `supabase test db --file <each>` loop |
| Playwright × 86 | ✓ authored | DEFERRED — needs `pnpm -F web e2e` |
| Deno × 15 | ✓ authored | DEFERRED — needs `deno test` |
| Next.js build | ✓ verified clean post-T019 + T020 + T030 | not the same as runtime |
| TypeScript typecheck | ✓ clean (`pnpm -F web exec tsc --noEmit`) | n/a |
| Quickstart 15-step | ✓ per T033 (post-reconciliation: 15/15 GREEN-EXPECTED) | DEFERRED — manual browser session |
| Perf p95 (`is_final_prediction_locked`) | ✓ estimate per T032 (<< 1 ms code-review) | DEFERRED — needs pgTAP runtime |
| CI workflow | ✓ `.github/workflows/ci.yml` present per slice 001 T007 | DEFERRED — runs on push (no remote push yet from this branch) |
| Seed fixtures | ✓ 4 on disk (slice-001 + slice-002 + slice-003 + slice-004) | DEFERRED — loaded by `supabase db reset` |

---

## 3. Step 15 reconciliation (quickstart-verification.md ↔ T031)

T033's `quickstart-verification.md` was authored in parallel with T031 and originally reported Step 15 (player ingest end-to-end) as **NEEDS-RUNTIME with ARTIFACT-GAP**. T034 (this document) verified that T031's artifacts are now on disk:

| Artifact | Status |
|---|---|
| `supabase/functions/sync-catalog/index.ts` `upsertPlayers` branch | ✓ present (calls `adapter.fetchPlayers?.()`) |
| `supabase/tests/pgtap/players_ingest_happy.sql` | ✓ present |
| `supabase/tests/pgtap/players_ingest_update.sql` | ✓ present |
| `supabase/tests/pgtap/players_ingest_soft_delete.sql` | ✓ present |
| `supabase/tests/pgtap/players_ingest_undersized_quarantined.sql` | ✓ present |
| `supabase/functions/sync-catalog/tests/players_branch.test.ts` | ✓ present |
| `supabase/functions/_shared/providers/stub/wc2026-players.json` | ✓ present (D-020 sibling fixture) |

**Outcome**: Step 15 has been flipped to **GREEN-EXPECTED** in `quickstart-verification.md` with an explicit "Reconciled by T034" note that lists each artifact path. The new tally is **15/15 GREEN-EXPECTED, 0 ARTIFACT-GAP, 15/15 DEFERRED for runtime confirmation**. No remediation work needed — the gap was a snapshot artifact of parallel authoring, not a real gap.

---

## 4. Deviation log (cumulative, 23 rows)

| ID | Slice | Title |
|---|---|---|
| D-001 | 001 | Auth hook key `before_user_signed_in` → `custom_access_token` (Supabase CLI v2 schema constraint) |
| D-002 | 001 | `is_approved_domain` takes a full email |
| D-003 | 001 | `/api/me` body wrapped per contract |
| D-004 | 001 | T012 front-loaded the eligibility RLS tightening |
| D-005 | 001 | `handle_auth_user_signed_in` uses the `custom_access_token` envelope (`{claims}/{error}`) |
| D-006 | 002 | Schema reconciliation wave-2 (vacated slots 0012–0017; renumbered to 0018+) |
| D-007 | 002 | `/api/matches` `match_result` split-column mapping |
| D-008 | 002 | pgTAP cannot observe `pg_notify` inside `BEGIN/ROLLBACK` envelope |
| D-009 | 002 | Migration 0025 emits `match_result.updated` (vs contract's `.corrected`) |
| D-010 | 002 | `provider_sync_runs` naming gaps in 3 US2 Deno tests |
| D-011 | 002 | Sync coordinator uses `audit_log.source='api_guard'` (least-bad fit) |
| D-012 | 003 | Slice 003 migration slot renumber (0029 → 0030+) |
| D-013 | 003 | RESOLVED — provisional WCM06 branch retired by T021's supersede |
| D-014 | 003 | Supersede self-reference placeholder; slice 007 audit-forensics follow-up |
| D-015 | 003 | Bulk `get_lock_states(uuid[])` helper for `/api/matches` (slot 0038) |
| D-016 | 004 | Slice 004 migration slot renumber +3 (spec 0036–0046 → on-disk 0039–0048) |
| D-017 | 004 | `tournament_config.first_kickoff_utc` seeded by slice 004 fixture; slot-0046 trigger is observability-only |
| D-018 | 004 | Rejection-path audit-log inserts deferred to slice 007 (audit RLS widening) |
| D-018b | 004 | `/api/teams` response shape uses `{ id, name, short_code, flag_url }` — no `country_code`/`group_id` per actual `public.teams` schema |
| D-019 | 004 | T029 "born-superseded NEW, then resurrect" pattern + manual `created` audit INSERT from SP body |
| **D-020** | **004 / T031** | **NEW (Phase 6 / Polish).** Stub fixture uses sibling file `supabase/functions/_shared/providers/stub/wc2026-players.json` (not folded into `wc2026-snapshot.json`) to preserve slice 002's `Array.isArray(payload)` asserts in the existing Deno suite. The coordinator branches on `adapter.fetchPlayers?.()` and reads the sibling JSON independently of the matches snapshot. |
| **D-021** | **004 / T031** | **NEW (Phase 6 / Polish).** `NormalizedPlayer.aliases` returned by `fetchPlayers()` is NOT persisted: the `public.players` table (migration 0039) has columns `display_name`, `team_id`, `country_code`, `position` only — no `aliases` column. The `upsertPlayers` branch drops the field. Slice 007 follow-up MAY add an `aliases jsonb` column + index if downstream search needs it; until then, the contract's optional field is intentionally dropped at the persistence boundary. |
| **D-022** | **004 / T031** | **NEW (Phase 6 / Polish).** Quarantine outcome value is `conflict_quarantined` (closest semantic match in `provider_sync_runs.outcome` CHECK constraint). The contract phrasing was the unconstrained word "quarantined"; T031 chose the existing enum-checked value to avoid widening the CHECK constraint mid-slice. Slice 007 MAY add a dedicated `players_quarantined` value if telemetry differentiation becomes useful. |

Phase 6 / Polish added **3 new deviations** (D-020, D-021, D-022) for T031's players-ingest activation. None block merge; all are recorded against slice 007 (audit + schema hardening) for follow-up.

---

## 5. Pre-merge runtime checklist (PowerShell, human-runnable)

Run from the repo root on branch `004-final-predictions` once Docker is restored. Stop on the first non-zero exit.

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset to latest schema + seeds.
#    Applies all 42 migration files spanning slots 0001-0048 (gaps 0012-0017 vacated per D-006).
#    Loads 4 seed fixtures: slice-001 + slice-002 + slice-003 + slice-004.
supabase db reset

# 3. Run all pgTAP files (68 total). Expected: 68/68 GREEN.
Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object {
  Write-Host "Running $($_.Name)..."
  supabase test db --file $_.FullName
}

# 4. Run Deno tests (15 total). Requires Deno installed (`winget install denoland.deno`).
deno test --allow-net --allow-env --allow-read supabase/functions

# 5. Web typecheck + production build.
pnpm -F web exec tsc --noEmit
pnpm -F web build

# 6. Web Playwright (86 specs incl. smoke harness). Expected: 86/86 GREEN.
pnpm -F web e2e

# 7. Manual quickstart browser session (15 steps from quickstart.md / quickstart-verification.md).
#    Expected per quickstart-verification.md: 15/15 PASS (Step 15 reconciled by T034).
pnpm -F web start
# Then walk through the 15 steps; substitute PASS/FAIL into quickstart-verification.md row by row.
```

Bash equivalents for steps 3 and 4:

```bash
for f in supabase/tests/pgtap/*.sql; do
  supabase test db --file "$f"
done

deno test --allow-net --allow-env --allow-read supabase/functions
```

### Pre-merge action items (operator checklist)

Tick each box before opening (or merging) the slice-004 PR.

- [ ] Docker Desktop running and healthy (`docker info` exits 0).
- [ ] Deno installed and on PATH (`deno --version` exits 0).
- [ ] Step 1 (`supabase start`) succeeds.
- [ ] Step 2 (`supabase db reset`) applies all 42 migrations + loads 4 fixtures cleanly.
- [ ] Step 3 reports 68/68 pgTAP GREEN.
- [ ] Step 4 reports 15/15 Deno GREEN (incl. `players_branch.test.ts`).
- [ ] Step 5 (`tsc --noEmit` + `pnpm build`) succeeds.
- [ ] Step 6 reports 86/86 Playwright GREEN (no skipped, no failed; the `test.fixme` lifted in T027 is now an active test body).
- [ ] Step 7 walks all 15 quickstart steps to PASS; `quickstart-verification.md` updated with terminal output per row.
- [ ] D-018, D-018b, D-019, D-020, D-021, D-022 acknowledged in the PR description.
- [ ] PR description references this file + `regression-baseline-from-001-002-003.md` + `regression-checkpoint-us{1,2,3}.md` + `quickstart-verification.md` + `perf-report.md`.

---

## 6. CI confirmation

`.github/workflows/ci.yml` exists per slice 001's T007 and is wired to run typecheck + Playwright + pgTAP on push. T034 itself cannot trigger CI without push, but documents that the PR-trigger workflow runs the same step 3 + step 5 + step 6 sequence above when the branch is pushed to GitHub.

After running steps 1–7 locally:
- [ ] `git push -u origin 004-final-predictions`.
- [ ] `gh pr create`.
- [ ] `gh pr checks` shows GREEN for all jobs (typecheck / playwright / pgtap).

---

## 7. Verdict

> **ALL ARTIFACTS COMPLETE. Runtime verification DEFERRED to first Docker-available environment (CI or local).**
>
> Slices 001 + 002 + 003 + 004 are **artifact-mergeable** pending the runtime sweep in § 5. The cumulative deviation log (23 entries, D-001 … D-022 with D-018b bridging) is fully documented. The Step 15 ARTIFACT-GAP from T033 has been reconciled by T034 — T031's `upsertPlayers` branch + 4 pgTAP + Deno + sibling fixture are all on disk.
>
> Per Principle XI (NON-NEGOTIABLE), slice 004 MAY NOT merge to `main` until § 5's PowerShell checklist returns 100% GREEN on a Docker-up + Deno-installed host. This document IS NOT itself the merge gate; it is the runbook the operator follows to reach the merge gate.

---

## 8. Inherited deferred items (one-liner per prior slice)

From `regression-baseline-from-001-002-003.md` and the upstream slices' own regression-final documents:

- **Slice 001** — T005 (pgTAP harness smoke runtime), T006 (Supabase + OIDC stub boot runtime), T007 (CI workflow PR-trigger observation), plus T021/T031/T035/T039/T041/T044 all still pending an observed-GREEN run on a Docker-up host. See `specs/001-eligibility-login/regression-final.md`.
- **Slice 002** — T001 (baseline runtime), T002 (`supabase start` extensions), T018 (red-gate runtime), T022 (US1 checkpoint runtime), T028 (red-gate runtime), T033 (US2 checkpoint runtime), T038 (red-gate runtime), T042 (US3 checkpoint runtime), T043 (pg_cron schedule verify), T044 (perf runtime), T045 (quickstart runtime) — plus the full 14-file Deno suite — all deferred to the consolidated runtime sweep in § 5 above. See `specs/002-match-catalog/regression-final.md`.
- **Slice 003** — every documentation artifact (T012, T013, T015, T016, T017, T027, T036, T037 + T038's regression-final consolidation) deferred runtime to the consolidated runtime sweep in § 5 above. See `specs/003-match-predictions/regression-final.md`.
- **Slice 004 / US1** — T012, T013, T014, T015 (red-gate), T016 (slot-0044 SP migration runtime), T017 (countdown unit), T018 (route runtime), T019 (UI Playwright runtime), T020 (regression-checkpoint-us1 runtime). See `specs/004-final-predictions/regression-checkpoint-us1.md`.
- **Slice 004 / US2** — T021 (11 pgTAP runtime), T022 (6 Playwright runtime), T023 (red-gate-us2), T024 (GREEN verification), T025 (regression-checkpoint-us2 runtime). See `specs/004-final-predictions/regression-checkpoint-us2.md`.
- **Slice 004 / US3** — T026 (3 pgTAP runtime), T027 (3 Playwright runtime), T028 (red-gate-us3), T029 (supersede SP runtime), T030 (regression-checkpoint-us3 runtime). See `specs/004-final-predictions/regression-checkpoint-us3.md`.
- **Slice 004 / Polish** — T031 (4 pgTAP + 1 Deno + `upsertPlayers` runtime), T032 (perf runtime — see `perf-report.md` § Verification command), T033 (15-step browser session — see `quickstart-verification.md` § Pre-merge note), T034 (this document — runtime sweep in § 5).

These items are NOT individually re-listed in § 5; they ARE collectively executed by the § 5 PowerShell checklist (pgTAP loop runs every slice's pgTAP file; Playwright `pnpm -F web e2e` runs every slice's `@slice-*` tag; Deno `deno test` runs every sync-catalog Deno file).

---

## 9. Process notes

This slice was implemented across multiple sessions with the Docker daemon and Deno toolchain consistently unavailable. Phase 6 / Polish (T031–T034) was executed in artifact-only mode:

- T031 activated the `MatchDataProviderAdapter.fetchPlayers?` interface in `sync-catalog/index.ts` and added 4 pgTAP + 1 Deno test, introducing 3 new deviations (D-020, D-021, D-022).
- T032 produced a code-review perf estimate (<< 1 ms p95) against `is_final_prediction_locked()`.
- T033 produced a 15-step code-review verification; Step 15 was originally flagged as ARTIFACT-GAP due to parallel-authoring snapshot drift with T031.
- T034 (this document) reconciled Step 15 to GREEN-EXPECTED after verifying T031's artifacts on disk, then consolidated the cumulative inventory + deviation log + pre-merge runtime checklist across all four slices.

Quality bar maintained:
- All test files follow the established pattern from slices 001 + 002 + 003 (`BEGIN; SELECT plan(N); ... SELECT * FROM finish(); ROLLBACK;` for pgTAP; `test.describe` + `test.beforeEach(resetStub)` for Playwright).
- All cross-slice contracts (predicate signatures, SP signatures, ERRCODE map, audit actions, table schemas) reconciled byte-for-byte against the canonical contract files. See `regression-checkpoint-us3.md § 4` for the 8 inherited contracts' intact status.
- All 23 deviations documented with full Symptom / Decision / Impact prose in `tasks.md § Implementation deviations`.
- Constitution Principle III preserved (the UI does NOT re-implement the lock decision; the server is the canonical source of `lock_state`).
- Constitution Principle XI honored: this document IS NOT the merge gate. Runtime observation against a live Docker stack (+ Deno toolchain) IS the merge gate.

This is the **World Cup Madness** project.
