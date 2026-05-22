# Slice 005 — Quickstart end-to-end verification

**Slice**: 005 — Scoring & Leaderboard
**Task**: T040
**Date**: 2026-05-20
**Reference**: `specs/005-scoring-leaderboard/quickstart.md` § Manual verification checklist (steps 1–8) + Constitution Principle X (vertical slice delivery)

## Status: DEFERRED

The 8 manual-verification steps are deferred until the operator brings up the local stack (Docker Desktop + `supabase start` + `supabase db reset` + `supabase functions serve score-trigger` + `pnpm -F web build && pnpm -F web start` + manual browser session). Docker is currently down and the Supabase Edge Function runtime (Deno) is not invocable on this workstation, so no terminal commands from `quickstart.md` can be executed end-to-end. In lieu of runtime evidence, this document is a **code-review verification**: for every step we confirm that the underlying migration / route / page / test / Edge Function artifact exists on disk and is well-formed enough that the operator should observe GREEN when the stack is brought up at T041.

## Prerequisites for runtime execution at T041

Before running the checklist:

- [ ] Docker Desktop is running.
- [ ] `supabase start` succeeded; `supabase status` shows all containers UP (Postgres + Auth + Realtime + Edge Functions).
- [ ] `supabase db reset` succeeded (loads 59 migrations 0001–0059 + 5 seed fixtures including `slice-005-fixture.sql`).
- [ ] `apps/web/.env.local` is populated with the env vars listed in `apps/web/.env.example` (slices 001 + 002 + 003 + 004 inherited; slice 005 introduces no new env vars).
- [ ] `supabase functions serve score-trigger --env-file .env.local` is running and reachable at `http://localhost:54321/functions/v1/score-trigger`.
- [ ] `pnpm -F web build && pnpm -F web start` is running on `http://localhost:3000`.
- [ ] `pnpm -F web exec tsc --noEmit` exits 0.
- [ ] OIDC stub container is healthy (slice 001 `infra/oidc-stub/`).
- [ ] Helper JWT `LOCAL_ADMIN_JWT` issued by the OIDC stub for the `admin1` fixture participant.
- [ ] Initial bootstrap recalc invocation (`scope='all'`, `reason='quickstart-bootstrap'`, `run_id='00000000-0000-0000-0000-000000000001'`) returned 200 OK before step 1.
- [ ] `tournament_config.leaderboard_visibility = 'identified'` (default) for steps 1–7; step 8 mutates `tournament_config.match_points.exact`.

## Verification matrix (8 steps)

Verdict legend:

- **GREEN-EXPECTED** — every underlying artifact (migration / route / page / test / Edge Function / view / seed) is present on disk and well-formed; expected to pass on first runtime execution barring environmental noise.
- **NEEDS-RUNTIME** — the step genuinely requires a running browser, Edge Function, or DB session (i.e. cannot be verified from artifacts alone, even though all underlying artifacts exist).
- **ARTIFACT-GAP** — an underlying artifact is missing or incomplete; step will likely FAIL when run at T041 unless the gap is closed first.

| # | Step (from quickstart.md) | Underlying artifact(s) | Verdict |
|---|---|---|---|
| 1 | Sign in as `alpha@nortal.com` in the browser at `http://localhost:3000` → expect redirect to `/dashboard`. | `apps/web/app/page.tsx` (root sign-in entry); `apps/web/app/auth/callback/page.tsx` (OIDC callback); `apps/web/app/dashboard/page.tsx` (post-login landing); slice 001 eligibility middleware (`supabase/migrations/0005_is_eligible_nortal_participant.sql` + `0011_participants_rls_eligibility_tighten.sql`); `supabase/seed/slice-005-fixture.sql` (provisions `alpha@nortal.com` as an eligible participant). | GREEN-EXPECTED (runtime browser flow) |
| 2 | Visit `/leaderboard` → 6 participants, ranked, with hand-verifiable totals; `admin1` and `alpha`…`zeta` only; the non-Nortal account is absent. | `apps/web/app/(participant)/leaderboard/page.tsx` + `components/LeaderboardRefresher.tsx`; `supabase/migrations/0054_leaderboard_views.sql` (`leaderboard_v`); `0056_score_rls.sql` (RLS scoped to eligible participants only); `0049_score_records.sql` + `0052_score_match_fn.sql` + `0053_score_finals_fn.sql` (totals); `supabase/seed/slice-005-fixture.sql` (24 match predictions + 6 final-prediction sets producing hand-verifiable totals); pgtap `leaderboard_tie_breakers.sql` + `leaderboard_shared_rank.sql` + `leaderboard_calc_version_consistency.sql`; playwright `slice-005-leaderboard.spec.ts`. | GREEN-EXPECTED (runtime browser flow) |
| 3 | Visit `/me/breakdown` → per-match rows for the 3 finished matches; the 3 confirmed final items; the `best_player` row shows `final_pending`. | `apps/web/app/(participant)/me/breakdown/page.tsx`; `supabase/migrations/0054b_personal_breakdown_view.sql` (per-participant view including final_pending placeholder rows); `0051_tournament_award.sql` (drives the `final_pending` status for `best_player`); `0049_score_records.sql` (score_records seeded for the 3 finished matches via fixture); `supabase/seed/slice-005-fixture.sql` (sets `best_player_status='pending'`); playwright `slice-005-breakdown.spec.ts` + `slice-005-breakdown.perf.spec.ts`. | GREEN-EXPECTED (runtime browser flow) |
| 4 | Sign out, sign in as `bravo@nortal.com`, visit `/me/breakdown` → only `bravo`'s rows; sum of `points` equals `bravo`'s `total_points` from the leaderboard. | `apps/web/app/(participant)/me/breakdown/page.tsx`; `supabase/migrations/0056_score_rls.sql` (`participant_id = auth.uid()` policy on `score_records`); `0054b_personal_breakdown_view.sql` (filters via underlying RLS); `0054_leaderboard_views.sql` (`leaderboard_v` sum matches per-participant sum from breakdown view); playwright `slice-005-breakdown.spec.ts`. | GREEN-EXPECTED (runtime browser flow) |
| 5 | While logged in as `bravo`, `GET /api/peer-pick/<unlocked-match-uuid>` → empty `picks` array — match still locked-to-peers because kickoff is in the future. | `apps/web/app/api/peer-pick/[match_id]/route.ts`; `supabase/migrations/0035_lock_window_score_bound_seed.sql` (`lock_window_minutes=60` default); `supabase/migrations/0031_is_prediction_locked.sql` (lock predicate); `supabase/migrations/0032_predictions_rls.sql` + `0056_score_rls.sql` (RLS enforces lock-to-peers boundary); `peer_pick_v` (introduced alongside leaderboard views — see `0054_leaderboard_views.sql` § peer-pick view); `supabase/seed/slice-005-fixture.sql` (includes at least one unfinished, unlocked match for `bravo`); pgtap `peer_pick_rls_lock_boundary.sql`; playwright `slice-005-peer-pick-visibility.spec.ts`. | GREEN-EXPECTED (runtime curl) |
| 6 | `GET /api/peer-pick/<finished-match-uuid>` → non-empty `picks` array including `alpha`'s pick. | `apps/web/app/api/peer-pick/[match_id]/route.ts`; `peer_pick_v` view definition (per `0054_leaderboard_views.sql`); fixture provides 3 finished matches with picks across all 6 participants; pgtap `peer_pick_rls_lock_boundary.sql`; playwright `slice-005-peer-pick-visibility.spec.ts`. | GREEN-EXPECTED (runtime curl) |
| 7 | (Admin) Trigger a recalc with the same `run_id` as bootstrap → response identical to step 3 — idempotent (R-002). | `supabase/functions/score-trigger/index.ts` (idempotency check via `score_calculation_runs.run_id` uniqueness); `supabase/migrations/0050_score_calculation_runs.sql` (UNIQUE on `run_id`); `0052_score_match_fn.sql` + `0053_score_finals_fn.sql` (idempotent score writes by `(calculation_version, participant_id, match_id/award_kind)`); pgtap `score_match_idempotent.sql`; Deno `supabase/functions/score-trigger/tests/idempotent_retry.test.ts` + `concurrent_returns_409.test.ts`. | GREEN-EXPECTED (runtime curl) |
| 8 | (Admin) Update `tournament_config.match_points.exact` from 10 to 15, then trigger `scope='all'` recalc → leaderboard totals shift accordingly; `score_calculation_runs.notes` includes `config_change`; audit log shows previous and new points per affected record. | `supabase/migrations/0057_score_config_defaults.sql` (`match_points.exact=10` default); `0058_score_all_fn.sql` (full recalc fn); `0055_score_audit_trigger.sql` (emits previous/new points to `audit_log`); `0050_score_calculation_runs.sql` (`notes` column populated with `config_change` by the Edge Function when the config delta is detected); `0052_score_match_fn.sql` (re-reads config per call so the new `exact=15` value applies on the recalc); Deno `supabase/functions/score-trigger/tests/all_scope.test.ts` + `all_scope_perf.test.ts`; playwright `slice-005-match-scoring.spec.ts` + `slice-005-final-scoring.spec.ts` (cover the audit-log delta shape). | GREEN-EXPECTED (runtime psql + curl + browser refresh) |

**Tally (code-review verdicts):**
- 8/8 GREEN-EXPECTED (all underlying artifacts present and well-formed for code-review purposes — assuming Phases 1–7 of the slice are complete, which the migration set 0049–0059 and the artifact glob confirms).
- 0/8 NEEDS-RUNTIME with ARTIFACT-GAP.
- 0/8 PASS (runtime), 0/8 FAIL (runtime), 8/8 DEFERRED for runtime confirmation.

## Highlights

- **All 8 steps' underlying code/migrations/views/Edge Function/tests exist on disk** (Phases 1–7 are complete). The artifact matrix above maps each quickstart step 1:1 to a concrete file path; no ARTIFACT-GAP entries.
- **Migration set is contiguous and well-ordered**: slice 005 owns slots 0049–0059 (per `docs/architecture/open-decisions.md` slot assignments), and every artifact the 8 quickstart steps depend on is present: `score_records` (0049), `score_calculation_runs` (0050), `tournament_award` (0051), `score_match_fn` (0052), `score_finals_fn` (0053), `leaderboard_views` (0054), `personal_breakdown_view` (0054b), `score_audit_trigger` (0055), `score_rls` (0056), `score_config_defaults` (0057), `score_all_fn` (0058), `score_auto_trigger` (0059).
- **Edge Function fan-out is thorough**: `supabase/functions/score-trigger/` exposes `index.ts` plus 9 Deno tests covering single-match auto trigger, idempotent retry, concurrent 409, non-admin 403, finals scope, all scope, auto-trigger on match finish, auto-trigger on award confirm, and all-scope perf — every behavior the 8 quickstart steps exercise has at least one Deno test pinning it.
- **Playwright fan-out is solid for the participant surfaces**: `slice-005-leaderboard.spec.ts`, `slice-005-breakdown.spec.ts` (+ perf variant), `slice-005-peer-pick-visibility.spec.ts`, `slice-005-match-scoring.spec.ts`, `slice-005-final-scoring.spec.ts` cover the read-side and scoring narratives that steps 2–8 walk through.
- **pgTAP fan-out covers the scoring + leaderboard + peer-pick invariants** invoked by the 8 steps: `score_match_idempotent.sql` + `score_match_award_table.sql` + `score_finals_golden_boot_tie.sql` + `leaderboard_tie_breakers.sql` + `leaderboard_shared_rank.sql` + `leaderboard_calc_version_consistency.sql` + `peer_pick_rls_lock_boundary.sql` (7 files).
- **Fixture parity**: `supabase/seed/slice-005-fixture.sql` provisions exactly the populations the 8 steps assume — 6 eligible participants, 1 admin, 1 non-Nortal account (must be absent from leaderboard per step 2), 3 finished matches with deterministic official scores (exact / outcome / incorrect), the `tournament_award` row with `best_player_status='pending'` (step 3's `final_pending` evidence), 24 match predictions across all reason codes, and 6 final-prediction sets producing hand-verifiable totals.
- **Runtime verification will run at T041** against `supabase start && supabase db reset && supabase functions serve score-trigger && pnpm -F web build && pnpm -F web start` + a manual browser session + admin-JWT-armed curl invocations (the operator brings Docker back up). Per `tasks.md` T041's role as the consolidated runtime sign-off for slice 005, T041 is responsible for marking off these 8 steps as PASS/FAIL with terminal output and screenshots.

## Pre-merge note

T041 will check off these 8 steps when Docker is available:

1. T041 brings up the full stack (Docker → `supabase start` → `supabase db reset` → fixtures including `slice-005-fixture.sql` → `supabase functions serve score-trigger` → `pnpm -F web build && pnpm -F web start`).
2. T041 issues the bootstrap recalc (`scope='all'`, `run_id='00000000-0000-0000-0000-000000000001'`, `reason='quickstart-bootstrap'`) and confirms 200 OK with the success body shape from `contracts/scoring-trigger.edge-fn.md`.
3. T041 runs each of the 8 steps end-to-end and replaces the "Verdict" column above with PASS / FAIL + exact terminal output (screenshot path for browser steps; HTTP response body for curl steps; psql output for SQL steps) — paralleling the slice-004 `quickstart-verification.md` matrix shape so reviewers can diff.
4. T041 also runs the automated-test fan-out cited in `quickstart.md` § "Run automated tests" — 6 Playwright slice-005-* specs, 7 pgTAP scripts (`score_match_idempotent.sql`, `score_match_award_table.sql`, `score_finals_golden_boot_tie.sql`, `leaderboard_tie_breakers.sql`, `leaderboard_shared_rank.sql`, `leaderboard_calc_version_consistency.sql`, `peer_pick_rls_lock_boundary.sql`), and 9 Deno tests in `supabase/functions/score-trigger/tests/`.
5. T041 confirms the consolidated regression-final across slices 001+002+003+004+005 (Principle XI) is green before merge.

## Notes for the runtime operator (T041)

- **Step 5 vs Step 6 boundary**: the lock-to-peers predicate uses `lock_window_minutes=60` (seeded by `0035_lock_window_score_bound_seed.sql`). Prefer mutating `tournament_config.lock_window_minutes` or matches.kickoff_utc via `psql` with `INTERVAL` arithmetic to control which match falls into "unlocked-to-peers" vs "finished" — avoid wall-clock alignment to keep results deterministic across runs.
- **Step 7 idempotency check**: re-issue the bootstrap recalc with the same `run_id` and assert (a) HTTP 200 with the same response body shape, (b) `SELECT count(*) FROM score_calculation_runs WHERE run_id='00000000-0000-0000-0000-000000000001'` remains 1 (idempotent insert), (c) `score_records` row count is unchanged. The Deno test `idempotent_retry.test.ts` codifies this contract.
- **Step 8 config restore**: after toggling `tournament_config.match_points.exact` from 10 → 15 and re-running the recalc, restore to the default `10::jsonb` before any post-merge cleanup so subsequent test runs against the same DB don't inherit the bumped value. The `audit_log` rows emitted by `0055_score_audit_trigger.sql` should each carry `previous_value->>'points'` and `new_value->>'points'` for every affected `score_records` row — filter on `entity_type='score_record' AND occurred_at >= <step-8-start-time>` to scope.
- **Step 2 visibility default**: `tournament_config.leaderboard_visibility` defaults to `'identified'` for steps 1–7; if the operator wants to spot-check the anonymized branch (Common operations § "Switch leaderboard visibility to anonymized"), do it after step 8 and revert before regression-final to avoid interfering with the `admin1`/`alpha`…`zeta` display-name assertions in step 2.
- **Edge Function authorization**: every curl invocation in steps 5–8 requires `LOCAL_ADMIN_JWT` (issued by the OIDC stub for the `admin1` fixture participant). The Deno test `non_admin_returns_403.test.ts` confirms the 403 negative path; the quickstart only exercises the 200 happy path with the admin JWT.
