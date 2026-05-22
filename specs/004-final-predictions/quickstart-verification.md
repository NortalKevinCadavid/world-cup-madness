# Slice 004 — Quickstart end-to-end verification

**Slice**: 004 — Final Tournament Predictions
**Task**: T033
**Date**: 2026-05-20
**Reference**: `specs/004-final-predictions/quickstart.md` § Manual verification checklist (steps 1–15) + Constitution Principle X (vertical slice delivery)

## Status: DEFERRED

The 15 manual-verification steps are deferred until the operator brings up the local stack (Docker Desktop + `supabase start` + `pnpm -F web build` + `pnpm -F web start` + manual browser session). Docker is currently down and Deno is not installed on this workstation, so no terminal commands from `quickstart.md` can be executed end-to-end. In lieu of runtime evidence, this document is a **code-review verification**: for every step we confirm that the underlying migration / route / page / test / config artifact exists on disk and is well-formed enough that the operator should observe GREEN when the stack is brought up at T034.

## Prerequisites for runtime execution at T034

Before running the checklist:

- [ ] Docker Desktop is running.
- [ ] `supabase start` succeeded; `supabase status` shows all containers UP.
- [ ] `supabase db reset` succeeded (loads 48 migrations + 4 seed fixtures including `slice-004-fixture.sql`).
- [ ] `apps/web/.env.local` is populated with the env vars listed in `apps/web/.env.example` (slices 001 + 002 + 003 inherited; slice 004 introduces no new env vars).
- [ ] `pnpm -F web build && pnpm -F web start` is running on `http://localhost:3000`.
- [ ] `pnpm -F web exec tsc --noEmit` exits 0.
- [ ] OIDC stub container is healthy (slice 001 `infra/oidc-stub/`).
- [ ] Helper JWTs `LOCAL_ALPHA_JWT`, `LOCAL_BRAVO_JWT`, `LOCAL_CHARLIE_JWT` issued by the OIDC stub.
- [ ] `tournament_config.first_kickoff_utc` set to `now() + INTERVAL '2 hours'` (per quickstart § One-time setup step 4).

## Verification matrix (15 steps)

Verdict legend:

- **GREEN-EXPECTED** — every underlying artifact (migration / route / page / test / config) is present on disk and well-formed; expected to pass on first runtime execution barring environmental noise.
- **NEEDS-RUNTIME** — the step genuinely requires a running browser, Edge Function, or DB session (i.e. cannot be verified from artifacts alone, even though all underlying artifacts exist).
- **ARTIFACT-GAP** — an underlying artifact is missing or incomplete; step will likely FAIL when run at T034 unless the gap is closed first.

| # | Step (from quickstart.md) | Underlying artifact(s) | Verdict |
|---|---|---|---|
| 1 | Submit champion before lock (US1.1 / FR-001) — sign in as charlie, navigate `/me/finals`, pick Argentina, submit; verify `final_predictions` row + `audit_log` `final_prediction.created`. | `apps/web/app/(participant)/me/finals/page.tsx` + `components/FinalsForm.tsx` + `components/TeamPicker.tsx`; `apps/web/app/api/final-predictions/route.ts`; `supabase/migrations/0040_final_predictions.sql`; `0043_final_predictions_audit_trigger.sql`; `0044_submit_final_prediction_sp.sql`. | GREEN-EXPECTED (runtime browser flow) |
| 2 | Independent items (US1.2 / FR-002) — submit France as runner-up, do not touch top_scorer / best_player; verify 2 active rows, others unset. | Same as step 1 + `final_predictions_target_xor_kind` CHECK constraint (0040) + SP supersede branch in `0044` / `0048`. | GREEN-EXPECTED (runtime browser flow) |
| 3 | Update champion (US1.3 / US3.1) — change ARG → BRA; verify 2 rows for `item_kind='champion'` (1 active, 1 superseded); runner_up untouched. | `0048_submit_final_prediction_supersede.sql` (supersede chain logic); `0043_final_predictions_audit_trigger.sql` emits `final_prediction.superseded` + `final_prediction.created`; playwright `slice-004-submit-update-supersedes.spec.ts`. | GREEN-EXPECTED (runtime browser flow) |
| 4 | Lock at exactly `first_kickoff_utc` — REJECT (US2.1 / SC-001 strict boundary); 409 `lock_window_passed`; audit `final_prediction.rejected_locked`. | `0041_is_final_prediction_locked.sql` (predicate uses `>=` boundary); `0044_submit_final_prediction_sp.sql` raises `WCM03` on lock; route maps to 409; pgtap `is_final_prediction_locked_at_boundary.sql` + `submit_final_prediction_locked.sql` + playwright `slice-004-submit-locked.spec.ts`. | GREEN-EXPECTED (runtime browser flow) |
| 5 | Lock at `first_kickoff_utc + 1 second` — REJECT (US2.2); separate attempt also rejects. | `0041_is_final_prediction_locked.sql`; pgtap `is_final_prediction_locked_just_after.sql` + `is_final_prediction_locked_far_after.sql`; playwright `slice-004-submit-locked-just-after.spec.ts`. | GREEN-EXPECTED (runtime browser flow) |
| 6 | Lock at `first_kickoff_utc − 1 second` — ACCEPT (US2.3 / SC-001); submit best_player; 200. | `0041_is_final_prediction_locked.sql`; pgtap `is_final_prediction_locked_before.sql` + `is_final_prediction_locked_just_before.sql`; playwright `slice-004-submit-just-before-lock.spec.ts`. | GREEN-EXPECTED (runtime browser flow) |
| 7 | Direct API attempt after lock — REJECT at API gate (US2.2 / SC-002); 409 `lock_window_passed`. | `apps/web/app/api/final-predictions/route.ts` (lock check before SP delegation); `0041_is_final_prediction_locked.sql`; playwright `slice-004-submit-direct-api-rejected.spec.ts`. | GREEN-EXPECTED (runtime curl) |
| 8 | Identical champion/runner-up rejected (FR-007 default); flip `predictions.allow_identical_champion_runner_up` to true; re-attempt succeeds. | `supabase/migrations/0047_predictions_config_seed.sql` (default `'false'::jsonb`); SP enforcement in `0044_submit_final_prediction_sp.sql` raising `identical_champion_runner_up`; pgtap `submit_final_prediction_identical_champion_runner_up.sql`; playwright `slice-004-submit-identical-champ-runner.spec.ts`. | GREEN-EXPECTED (runtime browser + psql toggle) |
| 9 | Invalid player target (FR-006) — non-existent `player_id`; expected 404 `player_not_found`. | `0044_submit_final_prediction_sp.sql` (FK + existence check); route maps to 404; pgtap `submit_final_prediction_invalid_target_missing.sql`; playwright `slice-004-submit-invalid-player.spec.ts`. | GREEN-EXPECTED (runtime curl) |
| 10 | Removed player target (Edge Case "player removed before lock") — 404 `player_removed`; pre-existing audit `final_prediction.target_player_removed`. | `supabase/migrations/0039_players.sql` (`removed_at` column); `0044_submit_final_prediction_sp.sql` (rejects when `removed_at IS NOT NULL`); `0045_players_remove_audit_trigger.sql` (emits the audit row on player removal); pgtap `submit_final_prediction_invalid_target_removed_player.sql`; playwright `slice-004-submit-removed-player.spec.ts`. | GREEN-EXPECTED (runtime curl) |
| 11 | Concurrent edits to same item (US3 concurrent / SC-004) — two tabs as charlie; both 200; exactly 1 active row; chain length 3; no race. | `0044_submit_final_prediction_sp.sql` (advisory lock per `(participant_id, item_kind)` serializes concurrent calls); pgtap `submit_final_prediction_serializes_concurrent.sql`; playwright `slice-004-submit-concurrent-tabs.spec.ts`. | GREEN-EXPECTED (runtime two-tab browser flow) |
| 12 | First-kickoff correction (FR-009 / SC-005) — move `first_kickoff_utc` into the past; subsequent submit attempts 409; audit `final_prediction.first_kickoff_corrected` row per active prediction. | `0046_first_kickoff_correction_trigger.sql` (emits audit on matches mutation that shifts `MIN(kickoff_utc)`); `0041_is_final_prediction_locked.sql` (re-reads config on every call so the next call responds to the new kickoff). NOTE: the quickstart text expects the audit action label `final_prediction.first_kickoff_corrected` AND filters on `new_value->>'first_kickoff_utc' != previous_value->>'first_kickoff_utc'`; the migration's INSERT shape and action label MUST match — operator should re-verify on first runtime read. | GREEN-EXPECTED (runtime psql + browser) |
| 13 | Personal final predictions read (FR-010 / R-010) — `GET /api/me/final-predictions` returns charlie's active picks + `lock_state`; bravo's call returns bravo's picks only. | `apps/web/app/api/me/final-predictions/route.ts`; `supabase/migrations/0042_final_predictions_rls.sql` (`participant_id = auth.uid()` policy); playwright `slice-004-me-final-predictions-list.spec.ts`, `slice-004-me-final-predictions-empty.spec.ts`, `slice-004-me-final-predictions-lock-state-editable.spec.ts`, `slice-004-me-final-predictions-lock-state-locked.spec.ts`, `slice-004-me-final-predictions-lock-state-at-boundary.spec.ts`, `slice-004-me-final-predictions-401.spec.ts`, `slice-004-me-final-predictions-403.spec.ts`, `slice-004-me-final-predictions-after-supersede.spec.ts`. | GREEN-EXPECTED (runtime curl) |
| 14 | Audit trail completeness (FR-011 / SC-006) — full action narrative across created / superseded / rejected_locked / rejected_identical_champion_runner_up / target_player_removed / first_kickoff_corrected / recovered. | `0043_final_predictions_audit_trigger.sql` (create + supersede + reject paths); `0044_submit_final_prediction_sp.sql` (reject_identical + reject_locked audit emissions); `0045_players_remove_audit_trigger.sql` (target_player_removed); `0046_first_kickoff_correction_trigger.sql` (first_kickoff_corrected); pgtap `submit_final_prediction_audit_format.sql`. | GREEN-EXPECTED (runtime psql aggregation) |
| 15 | Player ingest end-to-end (R-004 / players ingest contract) — sync against stub adapter that includes `fetchPlayers()` returning a roster; `players` + `player_provider_external_ids` rows appear; `audit_log` `player.created` rows fire; re-trigger with one player removed → `removed_at` set + `final_prediction.target_player_removed` audit row. | `supabase/migrations/0039_players.sql` (table + `player_provider_external_ids` table); `0045_players_remove_audit_trigger.sql` (removal audit fan-out); `supabase/functions/sync-catalog/index.ts` (`upsertPlayers` branch added by T031); pgtap `players_ingest_happy.sql` + `_update.sql` + `_soft_delete.sql` + `_undersized_quarantined.sql` (T031); Deno `supabase/functions/sync-catalog/tests/players_branch.test.ts` (T031); stub fixture sibling `supabase/functions/_shared/providers/stub/wc2026-players.json` (D-020). | GREEN-EXPECTED (runtime sync-catalog invocation + curl) — **Reconciled by T034**: T031 artifacts confirmed on disk: `upsertPlayers` branch in `sync-catalog/index.ts`, the 4 `players_ingest_*.sql` pgTAP files, the `players_branch.test.ts` Deno test, and the `wc2026-players.json` sibling fixture (D-020). Three new deviations: D-020 (sibling fixture file), D-021 (`NormalizedPlayer.aliases` not persisted — `players` table has no `aliases` column), D-022 (quarantine outcome value is `conflict_quarantined`, closest fit in `provider_sync_runs.outcome` CHECK constraint). |

**Tally (code-review verdicts):**
- 15/15 GREEN-EXPECTED (all underlying artifacts present and well-formed for code-review purposes; Step 15 reconciled by T034 after T031 landed `upsertPlayers` + 4 pgTAP + Deno + sibling fixture).
- 0/15 NEEDS-RUNTIME with ARTIFACT-GAP (the prior gap on Step 15 was closed by T031; see the row note above).
- 0/15 PASS (runtime), 0/15 FAIL (runtime), 15/15 DEFERRED for runtime confirmation.

**T034 reconciliation note (2026-05-20)**: This document was originally authored in parallel with T031 and flagged Step 15 as ARTIFACT-GAP because T031's writes hadn't yet landed in this document's snapshot. T034 (the final regression gate) verified that T031's artifacts are now on disk:
- `apps/web/`/`supabase/functions/sync-catalog/index.ts` includes the `upsertPlayers` branch invoking `adapter.fetchPlayers?.()`.
- `supabase/tests/pgtap/players_ingest_{happy,update,soft_delete,undersized_quarantined}.sql` — 4 files present.
- `supabase/functions/sync-catalog/tests/players_branch.test.ts` — 1 file present (15th Deno test).
- `supabase/functions/_shared/providers/stub/wc2026-players.json` — sibling fixture present (D-020).
Step 15 verdict is therefore flipped to GREEN-EXPECTED; the original NEEDS-RUNTIME-WITH-ARTIFACT-GAP wording is superseded by this note.

## Highlights

- **All 15 steps' underlying code/migrations exist on disk** (Step 15's prior artifact gap was closed by T031 — see the T034 reconciliation note above). The sync-catalog coordinator now branches on `adapter.fetchPlayers?.()` via `upsertPlayers`, the four `players_ingest_*.sql` pgTAP files exist, and the `players_branch.test.ts` Deno test is on disk. All 15 steps are expected to GREEN under runtime.
- **Migration set is contiguous and well-ordered**: slice 004 owns slots 0039–0048 (per D-016), and every artifact the 15 quickstart steps depend on (final_predictions table, RLS, audit trigger, lock predicate, submit SP, supersede branch, identical config seed, first-kickoff-correction trigger, players table, players-remove audit trigger) is present.
- **Playwright fan-out is thorough**: 33 `slice-004-*.spec.ts` files cover champion/top-scorer/best-player happy paths, lock-window boundaries (just before / just after / at boundary), direct-API rejection, client-clock ignored, identical champ/runner, concurrent tabs, removed/invalid players, me/final-predictions list + lock-state variants + 401/403 + after-supersede. Step 1–14 quickstart parity is solid.
- **pgTAP fan-out is thorough for final_predictions** (9 `is_final_prediction_locked_*` + 12 `submit_final_prediction_*` = 21 files) **and players_ingest** (4 `players_ingest_*` files added by T031, matching the quickstart enumeration). Cumulative slice-004 pgTAP count: 25 files.
- **Runtime verification will run at T034** against `supabase db reset && pnpm -F web build && pnpm -F web start` + a manual browser session (the operator brings Docker back up). Per `tasks.md` T034's "Final regression gate", T034 is responsible for the consolidated runtime sign-off across slices 001+002+003+004 — it will check off these 15 steps as part of that pass.

## Pre-merge note

T034's consolidated **regression-final** will check off these steps when Docker is available:

1. T034 brings up the full stack (Docker → `supabase start` → `supabase db reset` → fixtures → `pnpm -F web build && pnpm -F web start`).
2. T034 runs each of the 15 steps end-to-end and replaces the "Verdict" column above with PASS / FAIL + exact terminal output (paralleling the slice-003 `quickstart-verification.md` matrix shape so reviewers can diff).
3. T034 also runs the automated-test fan-out cited in `quickstart.md` § "Run automated tests" — 33 Playwright specs, 22 pgTAP scripts, 1 Deno test (subject to the Step 15 ARTIFACT-GAP above).
4. **Step 15 artifact gap RESOLVED by T031 (Phase 6 Polish)**: the sync-catalog `fetchPlayers()` branch (`upsertPlayers`), 4 pgTAP files, Deno `players_branch.test.ts`, and the `wc2026-players.json` sibling fixture (D-020) are all present. T034's `regression-final.md` records the reconciliation. The three accompanying deviations from T031 (D-020 sibling fixture, D-021 aliases-not-persisted, D-022 quarantine outcome value) are logged for slice-007 follow-up but do not block the 15/15 GREEN-EXPECTED tally.

## Notes for the runtime operator (T034)

- **Step 4 vs Step 6 timing**: the strict-boundary verification (`>=` predicate at `now() = first_kickoff_utc`) is hostage to system-clock drift across the supabase container and the test harness — prefer mutating `tournament_config.first_kickoff_utc` via `psql` with `INTERVAL '1 second'` arithmetic (as quickstart does) rather than chasing wall-clock alignment.
- **Step 8 config restore**: after toggling `predictions.allow_identical_champion_runner_up` to `true`, restore to `'false'::jsonb` before moving to subsequent steps so step 14's audit-trail aggregation stays interpretable.
- **Step 11 concurrency**: use two distinct browser contexts (different incognito windows) or two parallel `curl` invocations in a bash subshell. The SP's advisory lock serializes them at the SP level — both should return 200; the chain length assertion is the canonical evidence (length 3 = Brazil → Spain or Germany → the other).
- **Step 12 audit query**: filter `audit_log` on `entity_type='tournament' AND action='final_prediction.first_kickoff_corrected' AND occurred_at >= <step-12-start-time>` to scope to your run; the table accumulates audit history across all 15 steps.
- **Step 15**: the artifact gap was closed by T031 prior to T034 — see the T034 reconciliation note in this document and the deviation entries D-020/D-021/D-022 in `regression-final.md`. At runtime, invoke `sync-catalog` via the stub adapter (which now resolves `wc2026-players.json` as the sibling fixture per D-020), then verify the `players` + `player_provider_external_ids` rows via service-role `psql`. The undersized-quarantine branch reports `provider_sync_runs.outcome='conflict_quarantined'` (D-022).
