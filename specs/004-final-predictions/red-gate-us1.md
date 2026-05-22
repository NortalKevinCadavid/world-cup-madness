# RED Gate — Slice 004 / User Story 1 (US1)

**Slice**: `004-final-predictions`
**Phase**: 3 (US1 — "Eligible participant submits and reviews their own four final-tournament predictions before the global first-kickoff lock")
**Date**: 2026-05-20
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T015 (the Principle IX gate task itself; US1 red-gate document)

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-3 / US1 RED tests authored in T012 (pgTAP, 7 files), T013 (Playwright submit, 9 files / 11 tests), and T014 (Playwright read, 16 files / 16 tests, 1 of which is `test.fixme` pending US3) are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 004 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 3 (US1) produced **32 RED-state test files** (25 Playwright specs + 7 pgTAP scripts). T012 fans out into 7 pgTAP files exercising the not-yet-shipped `submit_final_prediction(...)` SP at on-disk slot **0044** (per D-016 the slice 004 migrations shifted +3 from the spec's slot 0041 due to slice-003 absorbing 0036–0038). T013 fans out into 9 Playwright files / 11 tests covering the `POST /api/final-predictions` route surface (the `submit-bad-body` file is a 3-sub-test file). T014 fans out into 16 Playwright files / 16 tests covering the three read endpoints `GET /api/me/final-predictions`, `GET /api/teams`, and `GET /api/players` (one file — `slice-004-me-final-predictions-after-supersede.spec.ts` — is marked `test.fixme` because the supersede branch is owned by T029 in US3 and the second-POST assertion will not flip GREEN until then).

Total RED units (excluding the `test.fixme` US3-dependent file from runtime expectations):

- **7 pgTAP files** (T012)
- **11 Playwright submit tests** across 9 files (T013)
- **15 Playwright read tests** that should observe RED on T015 + flip GREEN on T018 (T014, excluding the 1 `test.fixme`)
- **= 33 behaviorally-distinct RED units** (16 SQL assertions across pgTAP + 26 Playwright assertions; 7 + 11 + 15 distinct test bodies = 33)

The full *inventory* — including the `test.fixme` — is **34 test bodies**. The runtime-RED expectation is **33**.

### pgTAP files (T012 — 7 files)

All seven files expect to fail with `ERROR:  function public.submit_final_prediction(uuid, text, uuid, uuid, text) does not exist` (or equivalent "function not found" pgTAP failure mode) until **T016** ships migration `0044_submit_final_prediction_sp.sql` (per D-016's slot renumber — original spec said 0041, on-disk slot is **0044**). Each file uses the BEGIN / `plan(N)` / asserts / `finish` / ROLLBACK pattern so no residue persists if the SP partially exists.

| # | Test file | `plan(N)` | Expected RED failure signature PRE-T016 | GREEN implementer |
|---|-----------|-----------|-----------------------------------------|-------------------|
| 1 | `supabase/tests/pgtap/submit_final_prediction_create_champion_happy.sql` | `plan(6)` | **RED**. The `INSERT INTO sp_result SELECT public.submit_final_prediction(...)` call (charlie + `'champion'` + POL) fails with `function public.submit_final_prediction(uuid, text, uuid, uuid, text) does not exist`. pgTAP reports "Bail out!" or a planned-vs-run mismatch; all 6 assertions (A1 returned uuid, A2 +1 `final_predictions` row, A3 active row shape match, A4 returned id matches inserted id, A5 +1 `final_prediction.created` audit row, A6 audit row shape match) are unreachable. The ROLLBACK at the end guarantees no residue. | T016 (`supabase/migrations/0044_submit_final_prediction_sp.sql` — create branch + audit side-effect via slot-0043 trigger). |
| 2 | `supabase/tests/pgtap/submit_final_prediction_create_top_scorer_happy.sql` | `plan(5)` | **RED**. Mirror of file #1 but for the player-kind branch (charlie + `'top_scorer'` + Messi). All 5 assertions (A1 returned uuid, A2 +1 `final_predictions` row, A3 `target_player_id` populated + `target_team_id IS NULL` (xor invariant), A4 audit row exists, A5 audit row shape match) are unreachable because the SP does not exist. | T016 (create branch — player-kind half of the xor invariant). |
| 3 | `supabase/tests/pgtap/submit_final_prediction_invalid_kind.sql` | `plan(2)` | **RED**. `throws_ok` invocation with `p_item_kind='nonsense'` fails because the SP does not exist; pgTAP reports "function does not exist" instead of the expected `ERRCODE='WFP03'`. A2 (`final_predictions` count unchanged invariant) is unreachable. | T016 (kind-validation step 2 of SP semantics; raises WFP03). |
| 4 | `supabase/tests/pgtap/submit_final_prediction_invalid_target_shape.sql` | `plan(4)` | **RED**. Two SAVEPOINT-isolated `throws_ok` sub-tests: (a) `'champion'` with `target_player_id` set + `target_team_id IS NULL`, and (b) `'top_scorer'` with `target_team_id` set + `target_player_id IS NULL`. Both expected to raise `ERRCODE='WFP03'`. Actual RED reason: function not found. The two count-invariant assertions are unreachable. | T016 (kind/target xor validation — step 2 of SP semantics; raises WFP03 before INSERT). |
| 5 | `supabase/tests/pgtap/submit_final_prediction_invalid_target_missing.sql` | `plan(3)` | **RED**. `throws_ok` with a `gen_random_uuid()`-generated team uuid guaranteed not to appear in `teams` (slice-002 fixture uses `aaaa0000-...` prefix). Expected `ERRCODE='WFP04'` with reason `team_not_found`; actual RED reason is the missing function. A2 + A3 (count-invariant + the random uuid still absent) are unreachable. | T016 (target-existence step 3 of SP semantics; raises WFP04). |
| 6 | `supabase/tests/pgtap/submit_final_prediction_invalid_target_removed_player.sql` | `plan(3)` | **RED**. Pre-mutates Pedri's (player 09) `removed_at = now()` inside the BEGIN block; then `throws_ok` SP call targeting Pedri must raise `ERRCODE='WFP04'` with reason `player_removed`. Outer ROLLBACK restores Pedri's active state. Actual RED reason: function not found. | T016 (target-existence step 3 with `removed_at IS NULL` predicate; raises WFP04). |
| 7 | `supabase/tests/pgtap/submit_final_prediction_audit_format.sql` | `plan(5)` | **RED**. Invokes the SP for charlie + `runner_up` + ESP; expects the slot-0043 audit trigger to write one `final_prediction.created` audit_log row with the contract's exact field shape (action, entity_type, entity_id, actor, source='trigger', previous_value IS NULL, new_value JSON keys). The SP does not exist, so the call site fails before any audit row is written. All 5 assertions unreachable. | T016 (SP body) + already-shipped slot-0043 audit trigger. |

**pgTAP assertion total**: `plan(6) + plan(5) + plan(2) + plan(4) + plan(3) + plan(3) + plan(5) = 28 planned assertions` across the 7 files. All 28 expected RED for the same root cause: `public.submit_final_prediction(uuid, text, uuid, uuid, text)` is absent until T016 ships.

### Playwright files — Submit path (T013 — 9 files / 11 tests)

All 9 files are tagged `@slice-004 @us1`. The expected RED reason is uniformly "the `/api/final-predictions` route handler does not exist yet" — Next.js returns a 404 for an absent `app/api/final-predictions/route.ts`, so the first `expect(response.status()).toBe(<expected>)` assertion blows up. RED reasons stay assertion-level failures (not test-framework or fixture errors) as required by Principle IX. **Additionally** the happy-path files transitively depend on T016 — without the SP at slot 0044, even a present route handler would 500 — but the route's absence is the first wall they hit.

| # | Test file | Tests | Expected status PRE-T018 | GREEN implementer |
|---|-----------|-------|--------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-004-submit-champion-happy.spec.ts` | 1 test | **RED**. POST `/api/final-predictions` with `{ item_kind: 'champion', target_team_id: <POL> }` 404s instead of 200; all downstream assertions (envelope shape, GET-mirror via `/api/me/final-predictions`) are unreachable. | T018 (`apps/web/app/api/final-predictions/route.ts` POST handler) + T016 (SP). |
| 2 | `apps/web/tests/playwright/slice-004-submit-top-scorer-happy.spec.ts` | 1 test | **RED**. POST with `{ item_kind: 'top_scorer', target_player_id: <Messi> }` 404s. | T018 + T016. |
| 3 | `apps/web/tests/playwright/slice-004-submit-all-four.spec.ts` | 1 test | **RED**. Four sequential POSTs (champion, runner_up, top_scorer, best_player) all 404; even the first POST fails before the FR-007 disjoint-team check can be exercised. | T018 + T016 (champion+runner_up disjoint enforced in SP step 5). |
| 4 | `apps/web/tests/playwright/slice-004-submit-invalid-team.spec.ts` | 1 test | **RED**. POST with the all-zeros uuid for `target_team_id` 404s on the route, not on the SP's WFP04→404 mapping with reason `team_not_found`. | T018 (route + WFP04→404 mapping) + T016 (WFP04 raise). |
| 5 | `apps/web/tests/playwright/slice-004-submit-invalid-player.spec.ts` | 1 test | **RED**. POST with the all-zeros uuid for `target_player_id` 404s on the route, not on the SP's WFP04→404 mapping with reason `player_not_found`. | T018 + T016. |
| 6 | `apps/web/tests/playwright/slice-004-submit-removed-player.spec.ts` | 1 test | **RED**. `beforeEach` flips PL8's `removed_at = now()` via service role; POST referencing PL8 expected to 404 with reason `player_removed` (per Clarifications 2026-05-17 Q1). Route absent → 404 fires before reason can be observed. `afterEach` restores `removed_at = NULL`. | T018 (route + WFP04→404 + reason discrimination via second query) + T016. |
| 7 | `apps/web/tests/playwright/slice-004-submit-unauthenticated.spec.ts` | 1 test | **RED**. No-cookies POST → MUST be 401 `{ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }` envelope (D-003 inheritance). Route absent → 404. | T018 (route + `requireSession()` guard). |
| 8 | `apps/web/tests/playwright/slice-004-submit-domain-removed.spec.ts` | 1 test | **RED**. Mid-session-deny: `withTemporaryConfig` flips `eligibility.approved_domains` to `[]`; POST expected to return 403 `DOMAIN_NOT_APPROVED`. The pre-mutation sanity-POST already 404s without the route. | T018 (per-request `requireEligible()` re-check, inherited via D-002). |
| 9 | `apps/web/tests/playwright/slice-004-submit-bad-body.spec.ts` | **3 sub-tests** (missing `item_kind`; `champion` + `target_player_id`; `top_scorer` + `target_team_id`) | **RED**. All three sub-tests expect 400 `BAD_REQUEST` from the route-handler zod schema enforcing kind/target consistency BEFORE eligibility check or SP invocation. Route absent → 404 instead of 400. | T018 (route + zod schema with kind/target xor refinement). |

**Submit-path test total**: `1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 3 = 11 distinct Playwright tests` across 9 files.

### Playwright files — Read path (T014 — 16 files / 16 tests, 1 `test.fixme` for US3)

All 16 files are tagged `@slice-004 @us1`. The expected RED reason is uniformly "the read route handler does not exist yet" — for the 8 me-final-predictions files the missing route is `app/api/me/final-predictions/route.ts`; for the 2 teams files it's `app/api/teams/route.ts`; for the 6 players files it's `app/api/players/route.ts`. All three sets are absent until T018 (which ships the three read-route handlers in addition to the submit handler). The one `test.fixme` (#3 below) is intentionally inert until US3's T029 lands the supersede branch of `submit_final_prediction(...)`.

| # | Test file | Tests | Expected status PRE-T018 (and PRE-T029 for #3) | GREEN implementer |
|---|-----------|-------|------------------------------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-004-me-final-predictions-empty.spec.ts` | 1 test | **RED**. Fresh newcomer signs in; GET → expected 200 with `{ final_predictions: [], lock_state: 'editable', first_kickoff_utc: '2026-06-16T20:00:00Z' }`. Route absent → 404. | T018 (`apps/web/app/api/me/final-predictions/route.ts` GET handler). |
| 2 | `apps/web/tests/playwright/slice-004-me-final-predictions-list.spec.ts` | 1 test | **RED**. alpha sees exactly 3 active rows (champion=ARG, runner_up=ESP, top_scorer=Messi from fixture). Route absent → 404; the `superseded_at IS NULL` + RLS filtering is unobservable. | T018 (GET handler + `superseded_at IS NULL` filter + RLS reliance). |
| 3 | `apps/web/tests/playwright/slice-004-me-final-predictions-after-supersede.spec.ts` | 1 test (**`test.fixme`**) | **RED** but **dormant**. Submit champion=A then champion=B; GET expects 1 entry with `target_team_id=B`. The supersede branch is owned by T029 (US3) — until then the second POST returns 409/similar. Marked `test.fixme` so it does not block the US1 gate. | T029 (US3 supersede branch of `submit_final_prediction(...)`). Remove `.fixme` when US3 lands. |
| 4 | `apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-editable.spec.ts` | 1 test | **RED**. Fixture seeds `first_kickoff_utc='2026-06-16T20:00:00Z'`; test-clock is 2026-05-20 → predicate FALSE → `lock_state='editable'`. Route absent → 404. | T018 (GET handler + `is_final_prediction_locked()` invocation per slot 0041). |
| 5 | `apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-locked.spec.ts` | 1 test | **RED**. Service-role mutates `first_kickoff_utc` to a past value (e.g. 2026-05-01); predicate TRUE → `lock_state='locked'`. `afterEach` restores fixture. Route absent → 404. | T018 + slot-0041 predicate (strict `>=`, BR-LOCK-005). |
| 6 | `apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-at-boundary.spec.ts` | 1 test | **RED**. Boundary semantics: `first_kickoff_utc` set to ~`now() - 50ms`; strict `>=` returns TRUE → `lock_state='locked'`. Route absent → 404. | T018 + slot-0041 predicate. |
| 7 | `apps/web/tests/playwright/slice-004-me-final-predictions-401.spec.ts` | 1 test | **RED**. No-cookies GET → MUST be 401 `UNAUTHENTICATED` (D-003 envelope). Route absent → 404. | T018 (GET handler + `requireSession()`). |
| 8 | `apps/web/tests/playwright/slice-004-me-final-predictions-403.spec.ts` | 1 test | **RED**. Mid-session domain-removed → 403 `DOMAIN_NOT_APPROVED`. Route absent → 404. | T018 (GET handler + `requireEligible()`). |
| 9 | `apps/web/tests/playwright/slice-004-teams-200.spec.ts` | 1 test | **RED**. alpha GETs `/api/teams` → expected 200 + 8 fixture teams (slice-002 seed) with `{ id, name, short_code, flag_url }`. Route absent → 404. | T018 (`apps/web/app/api/teams/route.ts` GET handler). |
| 10 | `apps/web/tests/playwright/slice-004-teams-401.spec.ts` | 1 test | **RED**. No-cookies → 401. Route absent → 404. | T018 (GET handler + `requireSession()`). |
| 11 | `apps/web/tests/playwright/slice-004-players-list.spec.ts` | 1 test | **RED**. alpha GETs `/api/players` → expected 200 + 16 players sorted by `full_name ASC` with `total_matching=16`. Route absent → 404. | T018 (`apps/web/app/api/players/route.ts` GET handler). |
| 12 | `apps/web/tests/playwright/slice-004-players-team-filter.spec.ts` | 1 test | **RED**. `?team_id=<ARG>` → exactly 2 players (Messi + Álvarez), both `team_short_code='ARG'`. Route absent → 404. | T018 (GET handler + `team_id` query-param). |
| 13 | `apps/web/tests/playwright/slice-004-players-q-search.spec.ts` | 1 test | **RED**. `?q=mes` → Messi appears via case-insensitive substring match on `full_name`. Route absent → 404. | T018 (GET handler + `q` filter — ILIKE substring on `full_name`). |
| 14 | `apps/web/tests/playwright/slice-004-players-excludes-removed.spec.ts` | 1 test | **RED**. Service-role flips Pedri's `removed_at = now()`; GET MUST NOT include Pedri. Route absent → 404. `afterEach` restores `removed_at = NULL`. | T018 (GET handler + `WHERE p.removed_at IS NULL`). |
| 15 | `apps/web/tests/playwright/slice-004-players-401.spec.ts` | 1 test | **RED**. No-cookies → 401. Route absent → 404. | T018 (GET handler + `requireSession()`). |
| 16 | `apps/web/tests/playwright/slice-004-players-bad-limit.spec.ts` | 1 test | **RED**. `?limit=99999` → expected 400 `BAD_REQUEST` (clamp range `[1, 500]`). Route absent → 404. | T018 (GET handler + zod query-param validator). |

**Read-path test total**: 16 distinct Playwright tests across 16 files; **15 expected RED on runtime** (#3 is `test.fixme` for US3 dependency).

---

## Highlights

- **7 T012 pgTAP files RED** until T016 ships `supabase/migrations/0044_submit_final_prediction_sp.sql` (per D-016 the SP slot is the on-disk 0044, not the spec's 0041). All 28 planned pgTAP assertions block on the same root cause: `public.submit_final_prediction(uuid, text, uuid, uuid, text)` is absent.
- **11 T013 Playwright tests RED** (across 9 files) until T018 ships `POST /api/final-predictions` AND T016 ships the SP. The route handler's zod schema, eligibility re-check, and SP-error-code → HTTP-status mapping are all owned by T018; the SP body is owned by T016 — both are needed before any happy-path test can flip GREEN.
- **15 T014 Playwright tests RED** (across 16 files; 1 `test.fixme` excluded from runtime expectations) until T018 ships the three read-route handlers `GET /api/me/final-predictions`, `GET /api/teams`, and `GET /api/players`. The `me-final-predictions-after-supersede.spec.ts` file is `test.fixme` and stays inert until T029 (US3) ships the supersede branch of the SP — at that point the `.fixme` is removed and the test flips GREEN as part of US3's gate.

---

## Implementation note — RED state inferred, not observed (TDD caveat)

In this session (2026-05-20, Auto mode, Docker daemon down), the RED tests T012 + T013 + T014 were authored and the matching GREEN-implementation tasks T016 (`submit_final_prediction` SP) and T018 (the four route handlers under `apps/web/app/api/final-predictions/`, `app/api/me/final-predictions/`, `app/api/teams/`, `app/api/players/`) **may be authored in the same agentic session** without an intervening Docker-based run to *observe* the RED state. The expected failure signatures in the tables above are inferred from straightforward "function does not exist" / "route does not exist" reasoning — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 004.** The recipe mirrors slices 001 + 002 + 003: stash the GREEN implementation files (the migration at slot 0044 + the four route handlers), run the verification commands below, observe every test fail for the documented reason, restore the stash, re-run, observe every test pass. Per-file paths to stash will be enumerated in the slice's `regression-final.md` once the GREEN implementations are known.

If any test in the inventory comes up GREEN *before* the stash-restore then that test is not actually gating the implementation it claims to gate. Stop and investigate before proceeding.

---

## Verification commands (run once Docker is up)

From the repo root on branch `004-final-predictions`:

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all 40 migrations
#    (slice 001's 0001..0018 + slice 002's 0019..0029 + slice 003's 0030..0038 +
#    slice 004's 0039..0047 per D-016 renumber) and loads the four seed fixtures
#    (slice-001-fixture.sql + slice-002-fixture.sql + slice-003-fixture.sql +
#    slice-004-fixture.sql).
supabase db reset

# 3. Run each slice-004 pgTAP test file individually. Prior-slice pgTAP files
#    are covered by their own gates; this loop scopes to the
#    submit_final_prediction_*.sql set only.
Get-ChildItem supabase/tests/pgtap -Filter submit_final_prediction_*.sql | ForEach-Object { supabase test db $_.FullName }

# 4. Typecheck the web app — catches any contract-shape drift between the
#    locally-declared response types in the specs and the route handlers.
pnpm -F web exec tsc --noEmit

# 5. Run the US1 Playwright suite, scoped to slice 004. The @slice-004 + @us1
#    tags are applied by T013 + T014 via test.describe annotations.
pnpm -F web e2e -- --grep '@slice-004 @us1'
```

**Pass criteria for the GREEN run** (post-stash-restore, all of T016/T018/etc. shipped):

- All 7 `submit_final_prediction_*.sql` pgTAP files report `ok` for every planned assertion (6 + 5 + 2 + 4 + 3 + 3 + 5 = 28 ok lines).
- Every Playwright test tagged `@slice-004 @us1` reports `passed` except the 1 `test.fixme` (26 tests across 25 effective files; the after-supersede file shows as skipped, not failed).
- `pnpm -F web exec tsc --noEmit` is clean.

**Pass criteria for the RED run** (stash-and-test, BEFORE the GREEN implementations land):

- All 7 pgTAP files fail because `public.submit_final_prediction` does not exist (function-not-found error from the SP call site), not for a syntax error in the test, a missing fixture row, or a planned-vs-run mismatch caused by a typo.
- All 26 non-fixme Playwright tests fail because the route handler they depend on is absent — assertions fail for a 404, not for a fixture or framework error.
- The 1 `test.fixme` (`slice-004-me-final-predictions-after-supersede.spec.ts`) shows as skipped (NOT failed) in both the RED and GREEN runs until US3's T029 lands.

If both criteria hold, the Principle IX gate is observationally satisfied and Slice 004 US1 is cleared to merge.

---

## Inherited spec deviations

Slice 004 inherits **D-001 through D-015** from `specs/001-eligibility-login/tasks.md`, `specs/002-match-catalog/tasks.md`, and `specs/003-match-predictions/tasks.md`, and adds **D-016 + D-017** of its own. One-liners:

- **D-001** (slice 001) — Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`; slice 004's `requireEligible()` re-check on every `/api/final-predictions` POST inherits the renamed hook path.
- **D-002** (slice 001) — `is_approved_domain(p_email text)` accepts a full email and extracts the domain internally; slice 004's mid-session-deny tests (`slice-004-submit-domain-removed.spec.ts`, `slice-004-me-final-predictions-403.spec.ts`) inherit this contract via the shared `requireEligible()` helper.
- **D-003** (slice 001) — `/api/me` response body locked to `{ participant: {...} }` with `{ error: { code, message } }` envelopes; slice 004's `/api/final-predictions`, `/api/me/final-predictions`, `/api/teams`, `/api/players` reuse the same error envelope byte-for-byte (asserted by all 401 + 403 tests in T013 + T014).
- **D-004** (slice 001) — `participants_self_or_admin_read` policy embeds the eligibility predicate as a combined OR'd policy; slice 004's per-row `final_predictions` + `players` + `player_provider_external_ids` RLS depends on the live combined policy through `is_eligible_nortal_participant(...)`.
- **D-005** (slice 001) — `handle_auth_user_signed_in` returns the `custom_access_token` envelope (`{claims}` / `{error}`); relevant to slice 004 only insofar as the final-predictions page session refresh path traverses this hook.
- **D-006** (slice 002) — Wave-2 schema reconciliation: `match_status` enum values, `group_id` column name, multi-method adapter interface (which now activates `fetchPlayers?` for slice 004's players hydration via T011's seed-time roster).
- **D-007** (slice 002) — `match_results` field-name mapping in the catalog route; not directly exercised by US1 (final predictions does not query `match_results`).
- **D-008** (slice 002) — pgTAP cannot observe `pg_notify` channel reception; slice 004's audit triggers do not emit notifications, so D-008 is informational only.
- **D-009** (slice 002) — `audit_log.action` name mismatch (`'match_result.recorded'` vs `'.corrected'`); slice 004 avoids the same trap by pinning the action strings in the SP body — the audit-format assertion in `submit_final_prediction_audit_format.sql` checks `'final_prediction.created'` exactly.
- **D-010** (slice 002) — `sync-catalog` coordinator vs Deno tests vs migration 0022 reconciliation gaps; not exercised by US1.
- **D-011** (slice 002) — `audit_log.source` enum reuse; slice 004 reuses `source='trigger'` for the audit-trigger path (asserted by the audit_format pgTAP) and `source='api_guard'` for direct-route audit writes — both already-allowed enum values.
- **D-012** (slice 003) — Migration slot renumber: slice 003's migrations shifted +1 (e.g. `submit_prediction_sp` lives at on-disk slot **0034**, not the spec's 0033). Slice 004 inherits the consequence: slice 003 also occupied 0036–0038 (kickoff_correction_audit_trigger / submit_prediction_supersede / get_lock_states_bulk), which forced D-016's +3 shift for slice 004.
- **D-013** (slice 003, RESOLVED) — Provisional `WCM06` branch replaced by T021's supersede; informational only for slice 004.
- **D-014** (slice 003) — Supersede self-reference placeholder; informational. Slice 004's own supersede branch (T029) will follow the same pattern.
- **D-015** (slice 003) — Bulk `get_lock_states(uuid[])` helper for `/api/matches` (slot 0038); not exercised by slice 004's US1 read paths, but its slot occupancy is the proximate cause of D-016's slot shift.
- **D-016** (slice 004, surfaced at slice 004 start) — Migration slot renumber: slice 004's migrations shifted **+3** from the spec's slots 0036–0046 because slice 003 already filled 0030–0038. On-disk slots are now `0039 players`, `0040 final_predictions`, **`0041 is_final_prediction_locked`**, `0042 RLS`, `0043 final_predictions_audit_trigger`, **`0044 submit_final_prediction_sp`**, `0045 players_remove_audit_trigger`, `0046 first_kickoff_correction_trigger`, `0047 predictions_config_seed` (and US3's `0048 submit_final_prediction_supersede` will follow). All slice-004 tests reference function/table names (not slot numbers), so no test-file changes were required — but `supabase db reset` MUST apply the renumbered set cleanly without filename collisions against slice 003's slot 0038.
- **D-017** (slice 004, surfaced during T011) — `tournament_config.first_kickoff_utc` is admin-owned, not auto-maintained. T010's `first_kickoff_correction` trigger at slot 0046 is observability-only — it emits `audit_log` rows when `matches.kickoff_utc` / `status` mutate but does NOT write `tournament_config.first_kickoff_utc`. Production: Slice 008's admin UI sets the key at tournament setup. Local dev + slice-004 tests: the slice-004 fixture seed appends `INSERT ... first_kickoff_utc = '"2026-06-16T20:00:00Z"'::jsonb` (slice 002's M3 ARG-CAN kickoff). Without this seed, `is_final_prediction_locked()` would fail-CLOSED on missing config and permanently lock all submissions — so the lock-state-editable + lock-state-locked + lock-state-at-boundary tests in T014 all depend transitively on the fixture seed for their expected non-locked baseline.

---

## Sign-off checklist (for the Slice 004 US1 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] RED run completed (per the stash-and-test recipe — paths to be enumerated in the slice's `regression-final.md`); transcript or CI link recorded.
- [ ] GREEN run completed; transcript or CI link recorded.
- [ ] PR description references this file by path: `specs/004-final-predictions/red-gate-us1.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.
- [ ] All 7 pgTAP files report `ok` on the GREEN run (28 total assertions); 26 of 27 Playwright tests report `passed` (the 1 `test.fixme` shows skipped — flips to passed when US3's T029 lands and the `.fixme` is removed).

Until every box above is ticked, Slice 004 US1 does not satisfy Constitution Principle IX and must not merge.
