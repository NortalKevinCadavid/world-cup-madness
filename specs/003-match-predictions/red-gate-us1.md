# RED Gate — Slice 003 / User Story 1 (US1)

**Slice**: `003-match-predictions`
**Phase**: 3 (US1 — "Eligible participant submits and reviews their own predictions for in-window matches")
**Date**: 2026-05-20
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T012 (the Principle IX gate task itself; US1 red-gate document)

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-3 / US1 RED tests authored in T010 (pgTAP, 4 files) and T011 (Playwright, 12 files / 13 tests) are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 003 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 3 (US1) produced **16 RED-state test files** (12 Playwright specs + 4 pgTAP scripts). T010 fans out into 4 pgTAP files covering the four behavioral facets of the not-yet-shipped `submit_prediction(...)` SP at on-disk slot **0034** (see D-012 re: slot renumber). T011 fans out into 12 Playwright files / 13 tests covering the `POST /api/predictions` and `GET /api/me/predictions` route surfaces.

Total: **13 Playwright tests + 4 pgTAP scripts** (with `plan(6) + plan(3) + plan(2) + plan(2) = 13` pgTAP assertions) **= 26 behaviorally-distinct RED units**.

### pgTAP files (T010 — 4 files, 13 planned assertions)

All four files expect to fail with `ERROR:  function public.submit_prediction(uuid, uuid, integer, integer, text) does not exist` (or equivalent "function not found" pgTAP failure mode) until **T013** ships migration `0034_submit_prediction_sp.sql` (per D-012's slot renumber — original spec said 0033, on-disk slot is **0034**). Each file uses the BEGIN / `plan(N)` / asserts / `finish` / ROLLBACK pattern so no residue persists if the SP partially exists.

| # | Test file | `plan(N)` | Expected RED failure signature PRE-T013 | GREEN implementer |
|---|-----------|-----------|------------------------------------------|-------------------|
| 1 | `supabase/tests/pgtap/submit_prediction_create_happy.sql` | `plan(6)` | **RED**. The `INSERT INTO sp_result SELECT public.submit_prediction(...)` call at line ~60 fails with `function public.submit_prediction(uuid, uuid, integer, integer, text) does not exist`. pgTAP reports "Bail out!" or a planned-vs-run mismatch; all 6 assertions (A1 returned uuid, A2 +1 predictions row, A3 active row shape match, A4 returned id matches inserted id, A5 +1 audit row, A6 audit row shape match) are unreachable. **Setup precondition**: the file's lines 42–44 issue `DELETE FROM public.predictions WHERE participant_id=alpha AND match_id=M4` *inside the outer txn* before calling the SP — this removes the slice-003 fixture's Row 5 (alpha + M4 1-1 ui) so the SP exercises the *create* branch (not the supersede branch owned by US2 / T021). The ROLLBACK at the end guarantees the delete is undone. This delete-then-create-then-rollback pattern is documented in the file's own header comments (lines 14–25 + line 41). | T013 (`supabase/migrations/0034_submit_prediction_sp.sql` — create branch + audit-row INSERT side-effect via slot-0033 trigger). |
| 2 | `supabase/tests/pgtap/submit_prediction_invalid_score.sql` | `plan(3)` | **RED**. Both `throws_ok` invocations (A1: `p_home=21`, above `score_upper_bound=20`; A2: `p_home=-1`, negative) fail because the SP does not exist yet — pgTAP reports "function does not exist" instead of the expected `ERRCODE='WCM03'`. A3 (active-row-unchanged invariant: the pre-existing Row 5 still active, no row with rejected scores) is unreachable. Note the file's header (lines 14–18) explicitly documents that the SP MUST raise on score-validation *before* the supersede branch, so the colliding Row 5 is intentional and irrelevant. | T013 (score-validation step 3 of SP semantics; raises WCM03). |
| 3 | `supabase/tests/pgtap/submit_prediction_invalid_match.sql` | `plan(2)` | **RED**. A1 (`throws_ok` with `p_match_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`, a uuid guaranteed not to appear in `matches` — slice-002 fixture uses `bbbb…N` prefix) fails because the SP does not exist; expected RED reason is the missing function, not the WCM04 raise. A2 (predictions row count unchanged) is unreachable. | T013 (match-existence step 5 of SP semantics; raises WCM04). |
| 4 | `supabase/tests/pgtap/submit_prediction_ineligible.sql` | `plan(2)` | **RED**. A1 invokes the SP on behalf of zulu (auth.users `…000d`, participants `9999…9`, seeded `participation_status='deactivated'` by the slice-001 fixture) targeting M4. Expected `ERRCODE='WCM05'` (`is_eligible_nortal_participant` returns false); actual RED reason is the missing function. A2 (predictions row count unchanged + zulu has zero rows) unreachable. | T013 (eligibility re-check step 4 of SP semantics; raises WCM05). |

### Playwright files (T011 — 12 files, 13 tests)

All 12 files are tagged `@slice-003 @us1`. The matrix below names each file; the expected RED reason is uniformly "the `/api/predictions` route handler does not exist yet" (for the 7 submit files) or "the `/api/me/predictions` route handler does not exist yet" (for the 5 me-predictions files) — i.e. Next.js returns a 404 for an absent `app/api/predictions/route.ts` / `app/api/me/predictions/route.ts`, so the first `expect(response.status()).toBe(<expected>)` assertion blows up. All RED reasons stay assertion-level failures (not test-framework or fixture errors) as required by Principle IX.

| # | Test file | Tests | Expected status PRE-T015 | GREEN implementer |
|---|-----------|-------|--------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-003-submit-happy.spec.ts` | 1 test | **RED**. The POST to `/api/predictions` 404s instead of 200; all downstream assertions (body envelope, GET-mirror via `/api/me/predictions`) are unreachable. | T015 (`apps/web/app/api/predictions/route.ts` POST handler). |
| 2 | `apps/web/tests/playwright/slice-003-submit-unauthenticated.spec.ts` | 1 test | **RED**. No route handler → 404 instead of the expected 401 `{ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }` envelope (slice-001 D-003 contract). | T015 (route handler + `requireEligible()` wiring). |
| 3 | `apps/web/tests/playwright/slice-003-submit-invalid-score.spec.ts` | 2 tests (`home=-1` → 400 BAD_REQUEST from zod; `home=21` → 422 INVALID_SCORE from SP / WCM03) | **RED**. Both tests fail at the first status assertion because the route 404s. The two-layer rejection (zod for client-shape errors → 400; SP-side `WCM03` for above-bound → 422) cannot be observed. | T015 (route handler + zod validation layer + WCM03→422 mapping). |
| 4 | `apps/web/tests/playwright/slice-003-submit-invalid-match.spec.ts` | 1 test | **RED**. POST with syntactically-valid but non-existent match_id 404s on the route, not on the SP's WCM04→404 mapping. | T015 (route handler + WCM04→404 mapping). |
| 5 | `apps/web/tests/playwright/slice-003-submit-domain-removed.spec.ts` | 1 test | **RED**. The mid-session-deny scenario flips `tournament_config.eligibility.approved_domains` to `[]` via `withTemporaryConfig` and asserts the next `POST /api/predictions` returns 403 + `DOMAIN_NOT_APPROVED`. Without the route, the pre-mutation sanity-POST already 404s. | T015 (per-request `requireEligible()` re-check, inherited via D-002). |
| 6 | `apps/web/tests/playwright/slice-003-submit-direct-api-rejected.spec.ts` | 1 test | **RED**. Direct POST for a locked (finished) match — UI gating is not the gate; the SP's WCM02 (kickoff-window lock) MUST raise → 409 `PREDICTION_LOCKED`. Without the route, the test 404s at the status assertion. | T015 (route handler + WCM02→409 mapping). |
| 7 | `apps/web/tests/playwright/slice-003-submit-client-clock-ignored.spec.ts` | 1 test | **RED**. Browser clock pinned to 2020 via `page.addInitScript` overriding `Date`; in_progress match still must return 409 `match_status_locked` because the SP uses server time / `match_status`. Without the route, the test 404s at the first assertion. | T015 (server-clock authority — never trust client time). |
| 8 | `apps/web/tests/playwright/slice-003-me-predictions-empty.spec.ts` | 1 test | **RED**. GET `/api/me/predictions` 404s instead of returning `{ predictions: [] }` for a newly-signed-in participant with no rows. | T015 (`apps/web/app/api/me/predictions/route.ts` GET handler). |
| 9 | `apps/web/tests/playwright/slice-003-me-predictions-list.spec.ts` | 1 test | **RED**. alpha is expected to see exactly 3 active rows (superseded chain row excluded; other participants' rows excluded by RLS). With the route absent, the request 404s and the RLS / `superseded_at IS NULL` filtering can't be observed. | T015 (GET handler + correct `superseded_at IS NULL` + RLS reliance). |
| 10 | `apps/web/tests/playwright/slice-003-me-predictions-match-filter.spec.ts` | 1 test | **RED**. `?match_id=<M3>` → 1 entry; `?match_id=<M2>` → 0 entries. Route absent → 404. | T015 (GET handler + `match_id` query-param). |
| 11 | `apps/web/tests/playwright/slice-003-me-predictions-bad-match-id.spec.ts` | 1 test | **RED**. `?match_id=not-a-uuid` MUST return 400 BAD_REQUEST. Route absent → 404 instead. | T015 (GET handler + zod / uuid validation on query-param). |
| 12 | `apps/web/tests/playwright/slice-003-me-predictions-401.spec.ts` | 1 test | **RED**. No cookies → MUST be 401 UNAUTHENTICATED. Route absent → 404. | T015 (GET handler + `requireEligible()`). |

**Special-case note on `slice-003-submit-happy.spec.ts`**: the pgTAP sibling `submit_prediction_create_happy.sql` deletes the slice-003-fixture Row 5 (alpha + M4 1-1 ui) inside its outer txn to clear the slot for a fresh create — this delete-then-create-then-rollback pattern is documented in the SQL file's header (lines 14–25 + line 41). The Playwright file's happy-path picks a *different* match (M6 USA-JPN) precisely to avoid needing a destructive fixture mutation at the API layer — the test header documents this choice. Both happy-path tests therefore exercise the SP's create branch without colliding with each other.

---

## Implementation note — RED state inferred, not observed (TDD caveat)

In this session (2026-05-20, Auto mode, Docker daemon down), the RED tests T010 + T011 were authored and the matching GREEN-implementation tasks T013 (`submit_prediction` SP) and T015 (`/api/predictions` + `/api/me/predictions` route handlers) **may be authored in the same agentic session** without an intervening Docker-based run to *observe* the RED state. The expected failure signatures in the tables above are inferred from straightforward "function does not exist" / "route does not exist" reasoning — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 003.** The recipe mirrors slices 001 + 002: stash the GREEN implementation files (the migration at slot 0034 + the route handlers under `apps/web/app/api/predictions/` and `apps/web/app/api/me/predictions/`), run the verification commands below, observe every test fail for the documented reason, restore the stash, re-run, observe every test pass. Per-file paths to stash will be enumerated in the slice's `regression-final.md` once the GREEN implementations are known.

If any test in the inventory comes up GREEN *before* the stash-restore then that test is not actually gating the implementation it claims to gate. Stop and investigate before proceeding.

---

## Verification commands (run once Docker is up)

From the repo root on branch `003-match-predictions`:

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all 30 migrations (slice 001's 0001..0018 +
#    slice 002's 0019..0029 + slice 003's 0030..0036 per D-012 renumber) and
#    loads the three seed fixtures
#    (supabase/seed/slice-001-fixture.sql + slice-002-fixture.sql + slice-003-fixture.sql).
supabase db reset

# 3. Run each slice-003 pgTAP test file individually. Slice-001 + slice-002
#    pgTAP files are covered by their own gates; this loop scopes to the
#    submit_prediction_*.sql set only.
Get-ChildItem supabase/tests/pgtap -Filter submit_prediction_*.sql | ForEach-Object { supabase test db $_.FullName }

# 4. Typecheck the web app — catches any contract-shape drift between the
#    locally-declared response types in the specs and the route handlers.
pnpm -F web exec tsc --noEmit

# 5. Run the US1 Playwright suite, scoped to slice 003. The @slice-003 + @us1
#    tags are applied by T011 via test.describe annotations.
pnpm -F web e2e -- --grep '@slice-003 @us1'
```

**Pass criteria for the GREEN run** (post-stash-restore, all of T013/T015/etc. shipped):

- All 4 `submit_prediction_*.sql` pgTAP files report `ok` for every planned assertion (6 + 3 + 2 + 2 = 13 ok lines).
- Every Playwright test tagged `@slice-003 @us1` reports `passed` (13 tests across 12 files).
- `pnpm -F web exec tsc --noEmit` is clean.

**Pass criteria for the RED run** (stash-and-test, BEFORE the GREEN implementations land):

- All 4 pgTAP files fail because `public.submit_prediction` does not exist (function-not-found error from the SP call site), not for a syntax error in the test, a missing fixture row, or a planned-vs-run mismatch caused by a typo.
- All 13 Playwright tests fail because the route handler they depend on is absent — assertions fail for a 404, not for a fixture or framework error. The happy-path sibling (`slice-003-submit-happy.spec.ts`) and the score-rejection sibling fail on the route-status assertion before any body-shape assertion runs.

If both criteria hold, the Principle IX gate is observationally satisfied and Slice 003 US1 is cleared to merge.

---

## Inherited spec deviations

Slice 003 inherits **D-001 through D-011** from slices 001 + 002 and adds **D-012** of its own. One-liners:

- **D-001** (slice 001, T004) — Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`; slice 003's `requireEligible()` re-check on every `/api/predictions` POST inherits the renamed hook path.
- **D-002** (slice 001, T019/T022) — `is_approved_domain(p_email text)` accepts a full email and extracts the domain internally; slice 003's mid-session-deny test (`slice-003-submit-domain-removed.spec.ts`) inherits this contract via the shared `requireEligible()` helper.
- **D-003** (slice 001, T028) — `/api/me` response body locked to `{ participant: {...} }` with `{ error: { code, message } }` envelopes and `Cache-Control: private, max-age=0, must-revalidate`; slice 003's `/api/predictions` and `/api/me/predictions` reuse the same error envelope byte-for-byte (asserted by `slice-003-submit-unauthenticated.spec.ts` and `slice-003-me-predictions-401.spec.ts`).
- **D-004** (slice 001, T034) — `participants_self_or_admin_read` policy embeds the eligibility predicate as a combined OR'd policy; slice 003's per-row predictions RLS depends on the live combined policy through `is_eligible_nortal_participant(...)`.
- **D-005** (slice 001, T038) — `handle_auth_user_signed_in` returns the `custom_access_token` envelope (`{claims}` / `{error}`), not the `{decision}` envelope used by `handle_auth_user_created`; relevant to slice 003 only insofar as the predictions-page session refresh path traverses this hook.
- **D-006** (slice 002, T003–T011 wave-2 schema reconciliation) — `match_status` enum is `scheduled/in_progress/finished/postponed/cancelled` (canonical, fixed inline); `match_results` keeps split columns but retains the locked cross-slice names `home_score_for_scoring` / `away_score_for_scoring`; `result_status` uses singular `'penalty_shootout'`; `provider_sync_runs` and `match_pending_review` use `bigserial`/text-CHECK enums; `tournament_config` provider key uses `providers.active`. The as-built migrations are authoritative for slice 003's lock-window calculation in `is_prediction_locked(uuid)`.
- **D-007** (slice 002, T020) — `match_results` field-name mapping in the catalog route; not directly exercised by US1 (predictions does not query `match_results`) but locked because the locked-match test (`slice-003-submit-direct-api-rejected.spec.ts`) depends on `match_status='finished'` being set consistently with that mapping.
- **D-008** (slice 002, T026) — pgTAP cannot observe `pg_notify` channel reception; slice 003's prediction-audit triggers do not emit notifications, so D-008 is informational only for this slice.
- **D-009** (slice 002, T026) — `audit_log.action` name mismatch (`'match_result.recorded'` vs `'match_result.updated'`/`'corrected'`); slice 003 introduces a parallel `'prediction.created'` / `'prediction.rejected_*'` vocabulary and avoids the same trap by pinning the action strings in the SP body (T013) — the audit-format assertion in `submit_prediction_create_happy.sql` (A5/A6) checks `'prediction.created'` exactly.
- **D-010** (slice 002, T032/T033) — `sync-catalog` coordinator vs Deno tests vs migration 0022 reconciliation gaps; not exercised by US1 (sync is US2-of-slice-002 territory).
- **D-011** (slice 002, T039) — `audit_log.source` enum has no value that fits the sync coordinator cleanly; slice 003 reuses `source='trigger'` for the audit-trigger path (asserted by A6 in `submit_prediction_create_happy.sql`) and `source='api_guard'` for direct-route audit writes — both already-allowed enum values, so D-011 does not regress here.
- **D-012** (slice 003, surfaced at slice start) — Migration slot renumber: slice 003's migrations shifted +1 (e.g. `submit_prediction_sp` lives at on-disk slot **0034**, not the spec's 0033). Tests reference function/table names (not slot numbers), so no test-file change is required — but the verification command `supabase db reset` must apply the renumbered set cleanly without filename collisions against slice 002's slot 0029 (`sync_lock_helpers`).

---

## Sign-off checklist (for the Slice 003 US1 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] RED run completed (per the stash-and-test recipe — paths to be enumerated in the slice's `regression-final.md`); transcript or CI link recorded.
- [ ] GREEN run completed; transcript or CI link recorded.
- [ ] PR description references this file by path: `specs/003-match-predictions/red-gate-us1.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.
- [ ] All 4 pgTAP files report `ok` on the GREEN run (13 total assertions); all 13 Playwright tests report `passed` on the GREEN run.

Until every box above is ticked, Slice 003 US1 does not satisfy Constitution Principle IX and must not merge.
