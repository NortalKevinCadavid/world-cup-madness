# RED Gate — Slice 002 / User Story 1 (US1)

**Slice**: `002-match-catalog`
**Phase**: 3 (US1 — "Eligible participant browses the canonical match catalog")
**Date**: 2026-05-19
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T018 (the Principle IX gate task itself)

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-3 / US1 RED tests authored in T013–T017 are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 002 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 3 (US1) produced **9 RED-state test files** (8 Playwright specs + 1 pgTAP script). T013 fans out into 4 Playwright files covering the four behavioral facets of `GET /api/matches`; T014 fans out into 3 files covering the 401/403/no-leak posture; T015 contributes 1 file with 4 locale tests; T016 contributes the doubly-RED sync-end-to-end file; T017 contributes the RLS pgTAP suite.

Total: **20 Playwright tests + `plan(7)` pgTAP assertions = 27 behaviorally-distinct RED units**.

| # | Test file | Test type | Test count / `plan(N)` | Expected status PRE-T020/T021 ship | GREEN implementer |
|---|-----------|-----------|------------------------|------------------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-002-catalog-eligible-200.spec.ts` | Playwright (@slice-002 @us1) | 1 test | **RED**. The `/api/matches` route handler does not exist yet. The first assertion `expect(response.status()).toBe(200)` blows up against a Next.js 404 (no `apps/web/app/api/matches/route.ts` shipped). All downstream body-shape, fixture-count, pagination-default, and M1 finished-match assertions are therefore unreachable. | T020 (`apps/web/app/api/matches/route.ts`). |
| 2 | `apps/web/tests/playwright/slice-002-catalog-filters.spec.ts` | Playwright (@slice-002 @us1) | 6 tests (one per filter dimension: `stage`, `status=finished`, `status=in_progress`, `team_id`, `from..to`, `group`) | **RED**. Same root cause as row 1: each filter test issues `GET /api/matches?<param>=…` and asserts a 200 — every test fails on the 404 from the missing route. Filter-shape assertions (membership of fixture UUIDs, half-open window inclusion/exclusion) cannot run. | T020 (route handler + query-param parsing per `contracts/match-catalog.read.md § Query parameters`). |
| 3 | `apps/web/tests/playwright/slice-002-catalog-pagination.spec.ts` | Playwright (@slice-002 @us1) | 2 tests (`?page_size=3`, then `?page_size=3&page=2`) | **RED**. Same root cause: route is absent → 404. Pagination invariants (page echo, total stability across pages, no row overlap, chronological continuation) are unreachable. | T020 (pagination + sort-tiebreaker). |
| 4 | `apps/web/tests/playwright/slice-002-catalog-bad-params.spec.ts` | Playwright (@slice-002 @us1) | 3 tests (`?page_size=10000`, inverted `from > to`, `?stage=unknown-stage`) | **RED**. The bad-params suite asserts the contract § 400 envelope `{ error: { code: "BAD_REQUEST", message } }`. With no route handler, all three requests 404 instead of 400 — first assertion (`expect(response.status()).toBe(400)`) fails. The contract § Security invariants "no stack trace leakage" assertion is also unreachable. | T020 (input-validation branch returning the contract 400 shape). |
| 5 | `apps/web/tests/playwright/slice-002-catalog-401.spec.ts` | Playwright (@slice-002 @us1) | 1 test | **RED**. No route handler → 404 instead of 401. Even once T020 lands, the `requireEligible()` guard from slice 001 must short-circuit unauthenticated callers to `{ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }` with the `private, max-age=0, must-revalidate` cache header. Every then-clause depends on the route existing. | T020 (route handler + `requireEligible()` wiring). |
| 6 | `apps/web/tests/playwright/slice-002-catalog-403-domain-removed.spec.ts` | Playwright (@slice-002 @us1) | 1 test | **RED**. The mid-session-deny scenario flips `tournament_config.eligibility.approved_domains` to `[]` via `withTemporaryConfig` and asserts the next `/api/matches` call returns 403 + `DOMAIN_NOT_APPROVED`. With the route absent, the pre-mutation sanity-check `GET /api/matches` already 404s and the test halts on the sanity assertion (`expect(sanity.status()).toBe(200)`). | T020 (the same `requireEligible()` re-check on each invocation). |
| 7 | `apps/web/tests/playwright/slice-002-catalog-no-leak.spec.ts` | Playwright (@slice-002 @us1 @edge) | 1 test (with ~25 forbidden-token assertions over a single response) | **RED**. Same setup as row 6 (`withTemporaryConfig` + post-mutation read). Without the route, the test cannot reach the 403 body it scans for participant UUIDs, provider tokens, admin tokens, approved-domain strings, stack frames, and debug headers. The structural envelope assertion `Object.keys(body).toEqual(["error"])` is unreachable. | T020 (deny-path body shape; no debug header leakage). |
| 8 | `apps/web/tests/playwright/slice-002-catalog-locale-display.spec.ts` | Playwright (@slice-002 @us1 @locale) | 4 tests (es-ES, en-US, ja-JP page render + DB canonical invariant) | **RED**. Each locale test calls `page.goto("/matches")` — the participant catalog page does not exist yet, so the navigation lands on Next.js's 404 page and the `expect(page.locator("body")).toContainText(<locale-distinguishing substring>)` assertion fails. The wire-shape leg also requires T020 (`/api/matches` JSON `kickoff_utc` must stay canonical UTC regardless of `Accept-Language`). Test 4 (the DB-canonical invariant) is `service-role` only and would pass against the current tree — but only if `supabase db reset` has loaded the slice-002 fixture, so it still requires Docker to be observed. | T021 (`apps/web/app/matches/page.tsx` with `Intl.DateTimeFormat` rendering) **and** T020 (canonical-UTC JSON). |
| 9 | `apps/web/tests/playwright/slice-002-late-fixture-appears.spec.ts` | Playwright (@slice-002 @us1 @sync) | 1 test (with two `test.fixme` self-skip guards: missing `SYNC_INTERNAL_AUTH_SECRET`, missing stub snapshot file) | **Doubly RED.** This file exercises a US1 acceptance scenario (AS-3: late-added fixture appears after sync) but depends on US2 implementation (`sync-catalog` Edge Function + stub provider snapshot). It self-fixmes when its preconditions are missing — `SYNC_INTERNAL_AUTH_SECRET` env or the stub snapshot file from T030 — which keeps the gate honest without producing false REDs. With the catalog route absent (T020) and the sync engine absent (T032/T033) it fails at the very first `await request.get("/api/matches")` pre-state read (404). Once T030 ships the stub snapshot but T032/T033 do not, the trigger `POST /functions/v1/sync-catalog` 404s and the poll for `provider_sync_runs` times out at 45s. | T020 (`/api/matches`) + T021 (page) + T030 (stub provider fixture file) + T032 (sync coordinator function shell) + T033 (sync coordinator body) + T040 (stub provider adapter) + T041 (stub fixture JSON). |
| 10 | `supabase/tests/pgtap/slice-002-catalog-rls.sql` | pgTAP | `plan(7)` (4 scenarios: alpha-sees-catalog × 3 assertions, alpha-blocked-on-admin-tables × 2 assertions, outsider-sees-no-matches × 1 assertion, mid-session-deny × 1 assertion) | **GREEN-already** (see callout below). The migration this file tests (`supabase/migrations/0026_catalog_rls.sql`, T009) shipped in Phase 2 *before* this RED-gate task. All 7 assertions are expected to pass against the current tree once Docker is up and `supabase db reset` has loaded the slice-001 + slice-002 fixtures. | Already GREEN as of T009 (Phase 2). |

---

## GREEN-already callout (T017 pgTAP)

The pgTAP file `slice-002-catalog-rls.sql` is the one exception to "everything in this inventory is RED". T017's original task body anticipated RED because it was authored before T009 landed, but T009 (the RLS migration) **shipped in Phase 2 of this slice** ahead of the RED-first gate. The file's own header comment (`-- RED / GREEN expectation against the current migration set: GREEN.`) declares this expectation explicitly. When Docker comes up, the operator should observe `supabase test db slice-002-catalog-rls.sql` return `ok 1..7` on the very first run — this is correct and does not indicate the RED-first ordering was violated for any *other* test in this inventory. T017 is the policy-test counterpart to a migration that had to land in the Foundational phase (Phase 2) so all later US tests have RLS-enabled tables to read.

If the operator observes T017 RED, that indicates a regression in `0026_catalog_rls.sql` — investigate before proceeding with T020/T021.

---

## Implementation note — RED state inferred, not observed (TDD caveat)

In this session (2026-05-19, Auto mode, Docker daemon down), the RED tests T013–T017 were authored and the matching GREEN-implementation tasks T020 (`/api/matches`), T021 (`/matches` page), and the downstream sync tasks **may be authored in the same agentic session** without an intervening Docker-based run to *observe* the RED state. The expected failure signatures in the table above are inferred from straightforward "route does not exist" / "page does not exist" reasoning — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 002.** The recipe mirrors slice 001's: stash the GREEN implementation files, run the verification commands below, observe every test fail for the documented reason, restore the stash, re-run, observe every test pass. Per-file paths to stash will be enumerated in `regression-final.md` (T046) once the GREEN implementations are known.

If any test in the inventory comes up GREEN *before* the stash-restore — other than T017's pgTAP, which is GREEN-already by design — then that test is not actually gating the implementation it claims to gate. Stop and investigate before proceeding.

---

## Verification commands (run once Docker is up)

From the repo root on branch `002-match-catalog`:

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all 19 migrations (slice 001's 18 + slice 002's
#    0019..0028 set) and loads both seed fixtures
#    (supabase/seed/slice-001-fixture.sql + supabase/seed/slice-002-fixture.sql).
supabase db reset

# 3. Run every slice-002 pgTAP test file individually. Slice-001 pgTAP files are
#    covered by Slice 001's own gate; this loop scopes to slice-002 only.
Get-ChildItem supabase/tests/pgtap -Filter slice-002-*.sql | ForEach-Object { supabase test db $_.FullName }

# 4. Typecheck the web app — catches any contract-shape drift between the
#    locally-declared response types in the specs and the route handler.
pnpm -F web exec tsc --noEmit

# 5. Run the US1 Playwright suite, scoped to slice 002. The @slice-002 + @us1
#    tags are applied by T013–T016 via test.describe annotations.
pnpm -F web e2e -- --grep '@slice-002 @us1'
```

**Pass criteria for the GREEN run** (post-stash-restore, all of T020/T021/etc. shipped):

- `slice-002-catalog-rls.sql` reports `ok` for all 7 planned assertions (it is GREEN-already; this is a regression check).
- Every Playwright test tagged `@slice-002 @us1` reports `passed`. The two `test.fixme` self-skip branches in `slice-002-late-fixture-appears.spec.ts` flip to actual execution once `SYNC_INTERNAL_AUTH_SECRET` is set and the stub snapshot file (T030) exists; until both are true, the file legitimately fixmes and that is acceptable for US1's merge gate (US2 owns the full sync path).
- `pnpm -F web exec tsc --noEmit` is clean.

**Pass criteria for the RED run** (stash-and-test, BEFORE the GREEN implementation lands):

- All Playwright tests in the inventory fail because the routes / page they depend on are absent — assertions fail for a 404, a missing locator, or a polling timeout against `provider_sync_runs`, **not** for a syntax error in the test itself or a missing fixture row.
- `slice-002-catalog-rls.sql` still passes (it is gated by T009's migration, which is shipped — this is the deliberate GREEN-already case documented above).

If both criteria hold, the Principle IX gate is observationally satisfied and Slice 002 US1 is cleared to merge.

---

## Inherited spec deviations

Slice 002 inherits **D-001 through D-005** from slice 001 (see `specs/001-eligibility-login/tasks.md § Implementation deviations`) and adds **D-006** of its own. One-liners:

- **D-001** (slice 001, T004) — Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`; affects how slice 002's API-guard reuses slice 001's eligibility re-check on every request.
- **D-002** (slice 001, T019/T022) — `is_approved_domain(p_email text)` accepts a full email and extracts the domain internally; slice 002's mid-session-deny test (`slice-002-catalog-403-domain-removed.spec.ts`) inherits this contract via the shared `requireEligible()` helper.
- **D-003** (slice 001, T028) — `/api/me` response body locked to `{ participant: {...} }` with `{ error: { code, message } }` errors and `Cache-Control: private, max-age=0, must-revalidate`; slice 002's `/api/matches` reuses the same error envelope shape byte-for-byte (asserted by `slice-002-catalog-401.spec.ts` and the 403 specs).
- **D-004** (slice 001, T034) — `participants_self_or_admin_read` policy already embeds the eligibility predicate (combined OR'd policy, not split into two policies); slice 002's RLS pgTAP (`slice-002-catalog-rls.sql`) references the live combined policy by name in scenario 4 (mid-session deny).
- **D-005** (slice 001, T038) — `handle_auth_user_signed_in` returns the `custom_access_token` envelope (`{claims}` / `{error}`), not the `{decision}` envelope used by `handle_auth_user_created`; relevant to slice 002 only insofar as the catalog page's session refresh path goes through this hook.
- **D-006** (slice 002, T003–T011 wave-2 schema reconciliation) — Several Phase-2 migrations diverged from `data-model.md`: `match_status` enum is `scheduled/in_progress/finished/postponed/cancelled` (canonical, fixed inline); `match_results` keeps split columns (`home_score`/`away_score` etc.) instead of `_official` suffix shape but **retains the locked cross-slice names** `home_score_for_scoring` / `away_score_for_scoring`; `result_status` uses `'penalty_shootout'` (singular) — flagged for slice 005; `provider_sync_runs` and `match_pending_review` use `bigserial`/text-CHECK enums instead of UUID/`CREATE TYPE` enums (internal plumbing only); `tournament_config` provider key uses `providers.active` (with `s`) per the as-seeded shape. The as-built migrations are now authoritative for slice 002; the data-model document remains the historical spec.

---

## Sign-off checklist (for the Slice 002 US1 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] RED run completed (per the stash-and-test recipe, paths to be enumerated by T046); transcript or CI link recorded.
- [ ] GREEN run completed; transcript or CI link recorded.
- [ ] PR description references this file by path: `specs/002-match-catalog/red-gate-us1.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.
- [ ] `slice-002-catalog-rls.sql` was GREEN on the RED run too (the documented GREEN-already case) — if it flipped to RED, investigate `0026_catalog_rls.sql` for regression before merging.

Until every box above is ticked, Slice 002 US1 does not satisfy Constitution Principle IX and must not merge.
