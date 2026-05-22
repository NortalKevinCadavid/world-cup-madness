# Regression checkpoint — Slice 002, Phase 3 (US1)

- **Slice**: `002-match-catalog`
- **Phase**: 3 (US1 — "Eligible participant browses the canonical match catalog")
- **Date**: 2026-05-19
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T022 (`specs/002-match-catalog/tasks.md` line 881)
- **Companion artifacts**:
  - `specs/002-match-catalog/regression-baseline-from-001.md` (T001 — the slice 001 carry-forward baseline)
  - `specs/002-match-catalog/red-gate-us1.md` (T018 — the sibling RED-gate inventory for the same test set)
  - `specs/001-eligibility-login/regression-checkpoint-us1.md` (the slice 001 template this document mirrors)
- **Purpose**: Record the state of the slice-001 + slice-002-so-far test suite at the moment US1 lands in slice 002, inventory every test the operator must run, and hand the exact verification commands to whoever next has a working Docker daemon. Per Principle XI, US2 (Phase 4) and US3 (Phase 5) MAY NOT start, and the slice MAY NOT merge to `main`, until all verification commands below land GREEN.

---

## Status: DEFERRED

The Docker daemon was DOWN at execution time. `supabase start`, `supabase db reset`, `supabase test db`, the Next.js dev server (which Playwright fixtures depend on), and the Playwright suite therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like, lists every test surface added so far in slice 002, and hands the exact commands the user MUST run locally (or in CI, once slice 001's T007 ships) before Phase 4 (US2) begins or the slice can merge. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at § 7 have all returned GREEN.

---

## 1. Suite inventory (post-US1)

### 1a. pgTAP tests — `supabase/tests/pgtap/`

**Slice 001 carry-forward** — 12 files unchanged from the slice 001 baseline. Full inventory and per-file expectations live in `specs/001-eligibility-login/regression-final.md § 2` and in this slice's `regression-baseline-from-001.md § 1.2`. Headline: 1 harness probe + 8 functional + 2 RLS-isolation + 1 perf = 12 files. Slice 002 does not modify any of them.

**Slice 002 additions (Phase 2 + Phase 3)** — 1 new file:

| # | File | Plan | Purpose |
|---|------|------|---------|
| 1 | `supabase/tests/pgtap/slice-002-catalog-rls.sql` | `plan(7)` | T017. Four scenarios: (1) `alpha@nortal.com` sees the seeded catalog (`matches` + `match_results` + `teams`), (2) alpha is blocked from admin-only tables (`provider_sync_runs`, `match_pending_review`), (3) `outsider@example.com` (ineligible) sees zero matches, (4) mid-session-deny — flipping `tournament_config.eligibility.approved_domains` to `[]` strips read access from a previously-eligible user on the very next statement. Already GREEN-from-the-gate because the migration it tests (`0026_catalog_rls.sql`, T009) shipped in Phase 2 before this RED-gate task ran. See `red-gate-us1.md § GREEN-already callout`. |

**Aggregate**: 12 carry-forward + 1 slice-002 = **13 pgTAP files** total at the end of Phase 3.

### 1b. Playwright tests — `apps/web/tests/playwright/`

**Slice 001 carry-forward** — 15 spec files unchanged from the slice 001 baseline (14 carrying `@slice-001` + 1 untagged harness probe `smoke.spec.ts`). Full inventory in `regression-baseline-from-001.md § 1.3`.

**Slice 002 additions (Phase 3 US1)** — 9 new spec files, all tagged `@slice-002 @us1`:

| # | File | Tests | Tags | Authored by |
|---|------|-------|------|-------------|
| 1 | `slice-002-catalog-eligible-200.spec.ts` | 1 | `@slice-002 @us1` | T013 |
| 2 | `slice-002-catalog-filters.spec.ts` | 6 (one per filter dimension: `stage`, `status=finished`, `status=in_progress`, `team_id`, `from..to`, `group`) | `@slice-002 @us1` | T013 |
| 3 | `slice-002-catalog-pagination.spec.ts` | 2 (`?page_size=3`, `?page_size=3&page=2`) | `@slice-002 @us1` | T013 |
| 4 | `slice-002-catalog-bad-params.spec.ts` | 3 (`?page_size=10000`, inverted `from > to`, `?stage=unknown-stage`) | `@slice-002 @us1` | T013 |
| 5 | `slice-002-catalog-401.spec.ts` | 1 | `@slice-002 @us1` | T014 |
| 6 | `slice-002-catalog-403-domain-removed.spec.ts` | 1 | `@slice-002 @us1` | T014 |
| 7 | `slice-002-catalog-no-leak.spec.ts` | 1 (~25 forbidden-token assertions over a single 403 body) | `@slice-002 @us1 @edge` | T014 |
| 8 | `slice-002-catalog-locale-display.spec.ts` | 4 (es-ES, en-US, ja-JP page render + DB canonical-UTC invariant) | `@slice-002 @us1 @locale` | T015 |
| 9 | `slice-002-late-fixture-appears.spec.ts` | 1 (with two `test.fixme` self-skip guards: missing `SYNC_INTERNAL_AUTH_SECRET`, missing T030 stub snapshot) | `@slice-002 @us1 @sync` | T016 |

**Slice-002 test-count aggregate (US1)**: 20 Playwright tests across 9 files.

**Aggregate at end of Phase 3**: 15 carry-forward specs + 9 slice-002-US1 specs = **24 spec files** total.

### 1c. TypeScript compile

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web exec tsc --noEmit` | Project-wide strict compile of `apps/web/`. Establishes the cross-slice contract for `lib/types/match.ts` (T019), `lib/catalog/format.ts` + `client.ts` (T019), the route handler at `app/api/matches/route.ts` (T020), the participant route group at `app/(participant)/` (T021), and continued green-ness of every slice-001 surface. | GREEN locally per the T020 and T021 implementation reports (no Docker dependency). |

### 1d. Next.js build

| Command | Purpose | Latest known result |
|---|---|---|
| `pnpm -F web build` | Production-mode `next build`. Confirms the App Router catches the new route handler + participant route group, the dev-only `service-role.ts` helper is NOT bundled (carries the slice-001 `node:test` marker), and no slice-002 file leaks a `'use client'`-incompatible import into a server boundary. | GREEN locally per the T021 implementation report (no Docker dependency). |

---

## 2. Migration inventory — `supabase/migrations/`

**Slice 001 carry-forward** — 11 migrations (`0001`…`0011`), all unchanged. Full inventory in `regression-baseline-from-001.md § 1.1`.

**Slice 002 additions (Phase 1 + Phase 2)** — 9 new migrations (numbering deliberately leaves `0012`…`0017`, `0024`, `0027` reserved):

| # | File | T# | Summary |
|---|------|----|---------|
| 0018 | `0018_enable_extensions.sql` | T002 | Enables `pg_cron` (for the slice-002 scheduled-sync coordinator) and `pg_net` (for the SECURITY DEFINER `trigger_sync_catalog` wrapper that issues the cron-driven HTTP call to the `sync-catalog` Edge Function). Sets `timezone='UTC'` idempotently. |
| 0019 | `0019_teams.sql` | T003 | Creates `public.teams` (canonical name + ISO short code + region; UNIQUE on `code`) and `public.team_provider_external_ids` (surrogate UUID PK; UNIQUE `(provider_name, provider_match_id)`); both audit-trigger-ready. |
| 0020 | `0020_matches.sql` | T004 | Creates `public.match_status` enum `{scheduled, in_progress, finished, postponed, cancelled}` and `public.match_stage` enum `{group, r16, qf, sf, final, third_place}`. Creates `public.matches` (UUID PK, FK to `teams` for both sides, `kickoff_utc timestamptz NOT NULL`, `venue`, `stage match_stage`, `group_id` nullable + `matches_group_id_consistency` CHECK enforcing `(stage='group') <=> (group_id IS NOT NULL)`, `status match_status DEFAULT 'scheduled'`, `last_synced_at`). Adds `public.match_provider_external_ids` parallel to team-side. |
| 0021 | `0021_match_results.sql` | T005 | Creates `public.match_results` (one-to-one with `matches` via UNIQUE FK). Split-column shape (`home_score`/`away_score` + optional `extra_time_*`/`penalty_*`) per D-006. Also writes the LOCKED cross-slice columns `home_score_for_scoring` / `away_score_for_scoring` (slice 005 leaderboard reads these by name via SECURITY DEFINER). `result_status` is text+CHECK (`regulation`/`extra_time`/`penalty_shootout` — singular; reconciled at the wire by T020's `mapResultStatus`, see D-007). |
| 0022 | `0022_provider_sync_tables.sql` | T006 | Creates `public.provider_sync_runs` (run history) and `public.provider_sync_state` (per-key checkpoint). `bigserial` PK + text+CHECK enums per D-006 (internal bookkeeping; no cross-slice reads). |
| 0023 | `0023_match_pending_review.sql` | T007 | Creates `public.match_pending_review` (manual-resolution queue for sync conflicts). Text+CHECK enums for `conflict_kind` / `conflict_resolution` per D-006 — slice 006 (admin overrides) reads these; flagged for slice 006 to normalise. |
| 0025 | `0025_catalog_audit_triggers.sql` | T008 | Adds `*_write_audit()` SECURITY DEFINER AFTER-trigger functions for `teams`, `matches`, and `match_results`. Emits `team.created/updated`, `match.created/updated`, `match_result.created/updated` rows in `public.audit_log` with `source='trigger'`. Skips no-op UPDATEs via `row(NEW.*) IS DISTINCT FROM row(OLD.*)`. |
| 0026 | `0026_catalog_rls.sql` | T009 | Enables + FORCEs RLS on `teams`, `matches`, `match_results`. Single combined OR'd `_eligible_read` policy per table, embedding `public.is_eligible_nortal_participant(auth.uid())` directly in the `USING` clause (D-004 pattern from slice 001). Admin-only tables (`provider_sync_runs`, `provider_sync_state`, `match_pending_review`, `match_provider_external_ids`, `team_provider_external_ids`) are RLS-enabled with `is_admin(auth.uid())` guards. REVOKEs INSERT/UPDATE/DELETE on every slice-002 table from `authenticated` and `anon`. |
| 0028 | `0028_provider_config_defaults.sql` | T010 | Inserts default rows into `public.tournament_config` for the `providers.*` and `provider_sync.*` keys: `providers.active`, `providers.{name}.base_url`, `provider_sync.cadence.{pre_tournament,tournament_day,live}`, `provider_sync.live_window.{pre_kickoff_minutes,post_kickoff_hours}`, `provider_sync.payload.undersized_threshold`, `provider_sync.outage.alert_after_minutes`, `notifications.outage_webhook_url`, `sync.advisory_lock_key`. Insert-only — does not alter the locked `tournament_config(key, value, updated_at)` shape. |

**Aggregate**: 11 carry-forward + 9 slice-002 = **20 migrations** total. (The skipped numbers `0012`–`0017`, `0024`, `0027` are reserved holes from the original task numbering; the file set on disk is dense from `0001` through `0011` and from `0018` through `0028`.)

**Seed fixtures**: 2 files — `supabase/seed/slice-001-fixture.sql` (carry-forward) + `supabase/seed/slice-002-fixture.sql` (T012, new).

---

## 3. App code inventory — slice 002 additions

Files added during slice 002 Phase 2 + Phase 3. Slice 001's 7 app files (`lib/types/participant.ts`, `lib/auth/{requireEligible,getCurrentParticipant}.ts`, `app/auth/{callback,denied}/page.tsx`, `app/dashboard/page.tsx`, `app/api/me/route.ts`) are unchanged.

### 3a. Shared lib (T011, T019)

| File | T# | Role |
|---|---|---|
| `supabase/functions/_shared/providers/types.ts` | T011 (Phase 2) | Provider-adapter TS contract. Multi-method form per `contracts/provider-adapter.contract.md`: `MatchDataProviderAdapter` interface with `fetchFixtures` / `fetchResults` / `fetchTeams` / optional `fetchPlayers?`. Plus `SyncWindow`, `NormalizedFixture`, `NormalizedResult`, `NormalizedTeam`, `NormalizedPlayer` shapes and error classes `ProviderTransientError` / `ProviderRateLimitedError` / `ProviderClientError` (each with `readonly retryable` discriminator). |
| `apps/web/lib/types/match.ts` | T019 | Cross-slice `Match` / `MatchResult` / `Team` / `MatchStage` / `MatchStatus` / `ResultStatus` / `MatchSort` / `MatchCatalogResponse` / `ErrorEnvelope` TS shapes. Imported by slice 003 (predictions display), slice 004 (final-prediction validation), and slice 005 (leaderboard breakdown). |
| `apps/web/lib/catalog/format.ts` | T019 | `formatKickoff(utcIso, locale)` and `formatScoreLine(matchResult, locale)` pure-function helpers using `Intl.DateTimeFormat` + `Intl.NumberFormat`. No DOM / no React. SC-004 invariant: format never mutates the canonical UTC ISO string. |
| `apps/web/lib/catalog/format.test.ts` | T019 | Unit-test harness for `format.ts` (es-ES / en-US / ja-JP — same locales the Playwright `slice-002-catalog-locale-display.spec.ts` asserts on). Runs under `pnpm -F web exec tsx --test` or the project's existing test runner; not Docker-dependent. |
| `apps/web/lib/catalog/client.ts` | T019 | `fetchMatches(searchParams)` server-component-only helper. Calls the route handler with the per-request user JWT via cookies (the RLS predicate runs on the server-side Supabase client). Returns the typed `MatchCatalogResponse` envelope or throws `EligibilityError` re-thrown from `requireEligible()`. |

### 3b. API route (T020)

| File | T# | Role |
|---|---|---|
| `apps/web/app/api/matches/route.ts` | T020 | `GET /api/matches` handler. Query-param validation precedes the eligibility gate (avoids timing-leak between "eligible but bad params" and "not eligible"); then `requireEligible()` (slice 001) runs; then the matches query goes through a user-JWT-bound Supabase server client so the catalog RLS policies apply. Body shape `{ matches, page, page_size, total }` (D-007 maps `match_results` column names to the contract on the wire). Error envelopes `{ error: { code, message } }` mirror `/api/me` byte-for-byte (`UNAUTHENTICATED` / `DOMAIN_NOT_APPROVED` / `BAD_REQUEST` / `INTERNAL`). `Cache-Control: private, max-age=10, must-revalidate` on the 200 path; `max-age=0` on every denial path. |

### 3c. Participant route group (T021)

| File | T# | Role |
|---|---|---|
| `apps/web/app/(participant)/layout.tsx` | T021 | Route-group layout that scopes the catalog page to the eligible-participant surface. Re-runs `requireEligible()` server-side; redirects to `/auth/denied?reason=...` on failure. No client-side eligibility logic — server-component-only. |
| `apps/web/app/(participant)/matches/page.tsx` | T021 | Server-component catalog page. Reads search params from the URL, calls `fetchMatches()` from `lib/catalog/client.ts`, renders the match list using `formatKickoff` / `formatScoreLine` with `Intl.DateTimeFormat` against the user's `Accept-Language`. Pagination + filter state lives entirely in the URL (no client-side state machine for filter values; client components only update `router.push(url)`). |
| `apps/web/app/(participant)/matches/components/MatchListFilters.tsx` | T021 | `'use client'` component. Reads current filter state from `useSearchParams`, writes back via `router.replace`. Presentation only (Principle III). |
| `apps/web/app/(participant)/matches/components/PaginationControls.tsx` | T021 | `'use client'` component. Prev/Next page links via `useSearchParams` + `router.replace`. Disables Prev on page 1 and Next on the last page (computed from `page * page_size >= total`). |

---

## 4. Expected GREEN state per test file (inferred, not observed)

These predictions are inferred from inspection of each file's assertions against the implementations now landed. Until Docker is up they are NOT observed.

### 4a. pgTAP

- `slice-002-catalog-rls.sql` (T017 plan = 7 assertions) → **GREEN out of the gate**. Migration `0026_catalog_rls.sql` shipped in Phase 2 ahead of the RED-first gate; the file's own header declares this expectation explicitly (see `red-gate-us1.md § GREEN-already callout`). All 4 scenarios × cumulative 7 assertions land green on first run against the slice-001 + slice-002 fixtures. If this file flips RED, investigate `0026_catalog_rls.sql` for regression BEFORE running anything else.
- All slice-001 pgTAP files (12) — expected GREEN exactly as documented in `specs/001-eligibility-login/regression-checkpoint-us1.md § 3` and slice 001's `regression-final.md`. Slice 002 did not touch slice-001 functions, predicates, RLS policies, or audit triggers; the only cross-slice surface either slice touches is `tournament_config.eligibility.approved_domains` (set by slice 001 migration 0002; never altered by slice 002).

### 4b. Playwright (slice-002 US1 — 9 specs, 20 tests)

- `slice-002-catalog-eligible-200.spec.ts` → **GREEN once Docker boots**. T020 ships the route handler; T012 ships the seeded matches. Asserts 200 status, response body shape (`{ matches, page, page_size, total }`), per-match fixture-presence (M1 finished, M2 in-progress, M3 scheduled, etc.), pagination defaults (`page=1`, `page_size=20`), and chronological-asc sort.
- `slice-002-catalog-filters.spec.ts` (6 tests) → **GREEN once Docker boots**. T020's query-param parser handles every documented filter (`stage`, `status`, `team_id`, `from`/`to`, `group`). Half-open `[from, to)` window membership is enforced server-side and asserted per fixture row.
- `slice-002-catalog-pagination.spec.ts` (2 tests) → **GREEN once Docker boots**. `total` is stable across pages; no row appears on both `page=1` and `page=2`; chronological-asc sort continues correctly across the page boundary; deterministic tiebreaker `(kickoff_utc, id)` (D-007 fallback) prevents stable-sort drift.
- `slice-002-catalog-bad-params.spec.ts` (3 tests) → **GREEN once Docker boots**. Each bad-input request returns 400 with `{ error: { code: 'BAD_REQUEST', message } }`. No stack trace leakage; `message` is a static, contract-quoted string. Validation runs BEFORE eligibility check by design — these tests use a signed-in eligible session.
- `slice-002-catalog-401.spec.ts` → **GREEN once Docker boots**. Unauthenticated call returns `{ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }` with `Cache-Control: private, max-age=0, must-revalidate` — byte-equivalent to slice 001's `/api/me` denial path.
- `slice-002-catalog-403-domain-removed.spec.ts` → **GREEN once Docker boots**. `withTemporaryConfig` flips `eligibility.approved_domains` to `[]`; the next `/api/matches` call observes the RLS-policy re-evaluation on the same JWT and returns 403 with `DOMAIN_NOT_APPROVED`.
- `slice-002-catalog-no-leak.spec.ts` (1 test, ~25 forbidden-token assertions) → **GREEN once Docker boots**. 403 body keys are exactly `["error"]`; ~25 forbidden tokens (participant UUIDs, provider names, approved-domain strings, admin tokens, stack frame markers, internal headers) are absent.
- `slice-002-catalog-locale-display.spec.ts` (4 tests) → **GREEN once Docker boots AND `pnpm -F web dev` is running**. Test 4 (DB-canonical invariant) is service-role-only and depends solely on the seed fixture loaded by `supabase db reset`. Tests 1–3 each call `page.goto('/matches')` with a different `Accept-Language` header and assert locale-distinguishing date/number substrings; this requires the Next dev server to be running so `(participant)/matches/page.tsx` (T021) can render.
- `slice-002-late-fixture-appears.spec.ts` → **STILL RED at end of Phase 3**. This is the doubly-RED US1 test that depends on **US2 + Phase 5** implementation (`sync-catalog` Edge Function + stub provider snapshot file from T030 + sync coordinator T032/T033 + adapter T040 + fixture JSON T041). It self-fixmes today if `SYNC_INTERNAL_AUTH_SECRET` is unset or the stub snapshot file is missing, which keeps the gate honest. Will flip GREEN once Phase 4 (US2) + Phase 5 (US3 sync) ship; remains DEFERRED at this checkpoint.

### 4c. Static + build

- `pnpm -F web exec tsc --noEmit` → **GREEN**, per the T019 / T020 / T021 implementation reports (no Docker dependency; this can be re-confirmed at any time).
- `pnpm -F web build` → **GREEN**, per the T021 implementation report (no Docker dependency).

---

## 5. Migration totals at end of Phase 3

| Surface | Slice 001 | Slice 002 (US1 cumulative) | Total |
|---|---|---|---|
| Migrations | 11 | 9 | 20 |
| pgTAP files | 12 | 1 | 13 |
| Playwright specs | 15 (14 `@slice-001` + 1 untagged smoke) | 9 (`@slice-002 @us1`) | 24 |
| Test helpers | 1 (`service-role.ts`) | 0 (slice 002 reuses) | 1 |
| First-party app files | 7 | 8 (1 shared types + 3 catalog lib incl. test + 1 route + 4 participant route group) | 15 |
| Seed fixtures | 1 | 1 | 2 |
| OIDC stub artifacts | dir + 4 supporting files | (slice 002 reuses) | dir + 4 |
| Docker-compose override | 1 | 0 | 1 |
| CI workflow | 1 | 0 (slice 002 will append jobs in Phase 6 polish) | 1 |

---

## 6. Cross-slice contracts now locked by slice 002 Phase 1–3

Per Constitution Principle XI, the symbols and shapes below are now LOCKED in addition to the five locked by slice 001 (which are still locked — `is_eligible_nortal_participant`, `is_admin`, `participants`, `audit_log`, `tournament_config`).

| Symbol / shape | Lock | Consumers |
|---|---|---|
| `public.match_status` enum `{scheduled, in_progress, finished, postponed, cancelled}` (5 values) | Body LOCKED. Additive values require coordinated migration across slices 003 / 004 / 005. | Slice 003 (predictions UI), 004 (final-prediction validation), 005 (leaderboard breakdown). |
| `public.match_stage` enum `{group, r16, qf, sf, final, third_place}` (6 short codes) | Body LOCKED. The short-code form (`r16`, not `round_of_16`) is the wire shape. | Slice 003, 004, 005. |
| `public.matches` schema including `kickoff_utc timestamptz NOT NULL`, `stage match_stage`, and the `matches_group_id_consistency` CHECK enforcing `(stage='group') <=> (group_id IS NOT NULL)` | Column names + CHECK LOCKED. Additive optional columns allowed; renames/removals require coordinated slice 003/004/005 migration. | Slice 003 (FK from `predictions.match_id`), 004 (final-prediction match lookups), 005 (leaderboard read). |
| `public.match_results` with cross-slice columns `home_score_for_scoring` / `away_score_for_scoring` | Column NAMES LOCKED. Slice 005 reads them by name via SECURITY DEFINER (RLS-exempt). The raw split-column shape (`home_score`/`away_score`/`extra_time_*`/`penalty_*`) is NOT cross-slice-locked — D-006 may revise that internal shape if slice 005 needs different breakdowns. | Slice 005 (leaderboard / scoring engine). |
| `MatchDataProviderAdapter` TS interface (multi-method: `fetchFixtures` / `fetchResults` / `fetchTeams` / optional `fetchPlayers?`) + error classes (`ProviderTransientError` / `ProviderRateLimitedError` / `ProviderClientError`) | Interface shape LOCKED. T040 stub adapter and any future real adapter must implement to this contract. | Slice 002 sync coordinator (T032/T033), future provider implementations. |
| `GET /api/matches` 200 body shape `{ matches, page, page_size, total }` + error envelope `{ error: { code, message } }` with codes `UNAUTHENTICATED` / `DOMAIN_NOT_APPROVED` / `BAD_REQUEST` / `INTERNAL` | Wire shape LOCKED — byte-equivalent to slice 001's `/api/me` for the error envelope. Slice 003+ may add response fields ADDITIVELY; key renames/removals require coordinated UI work. | Participant catalog page (T021), slice 003 prediction UI, future admin views. |
| `tournament_config` keys with `providers.*` and `provider_sync.*` prefixes (seeded by `0028_provider_config_defaults.sql`) | Key NAMES LOCKED (`providers.active` with `s`, per D-006). Slice 008 admin UI must write back the same keys. Values are JSONB and may evolve additively per key; the key-name surface is the cross-slice contract. | Slice 008 (admin UI for tournament_config), sync coordinator T032/T033. |

---

## 7. Verification commands (operator runbook)

Run from the repo root on branch `002-match-catalog` in order. Stop on the first non-zero exit. PowerShell variants given; bash equivalents at the bottom.

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all 20 migrations
#    (slice 001's 0001..0011 + slice 002's 0018..0023, 0025, 0026, 0028 — note the
#    reserved gaps at 0012..0017, 0024, 0027) and loads both seed fixtures
#    (supabase/seed/slice-001-fixture.sql + supabase/seed/slice-002-fixture.sql).
supabase db reset

# 3a. Run every slice-002 pgTAP test file individually.
Get-ChildItem supabase/tests/pgtap -Filter slice-002-*.sql | ForEach-Object { supabase test db $_.FullName }

# 3b. Optional regression sweep — every slice-001 pgTAP file too (carry-forward).
#     Slice 001's gate is the canonical source for these; this loop is a belt-and-braces check.
Get-ChildItem supabase/tests/pgtap -Exclude slice-002-* -Filter *.sql | ForEach-Object { supabase test db $_.FullName }

# 4. TypeScript strict compile of the web app.
pnpm -F web exec tsc --noEmit

# 5. Production-mode Next.js build.
pnpm -F web build

# 6. Start the Next.js dev server (Playwright fixtures depend on it).
#    Run in a separate terminal; the suite will tear it down after.
pnpm -F web dev

# 7. Playwright suite — slice-002 US1 scope.
pnpm -F web e2e -- --grep '@slice-002 @us1'
```

Bash equivalents (run instead of step 3a / 3b on a POSIX shell):

```bash
for f in supabase/tests/pgtap/slice-002-*.sql; do supabase test db "$f" || exit 1; done
for f in supabase/tests/pgtap/*.sql; do
  case "$(basename "$f")" in slice-002-*) ;; *) supabase test db "$f" || exit 1 ;; esac
done
```

A passing run produces:

- **Step 3a**: 1 file, `ok 1..7` against `slice-002-catalog-rls.sql`.
- **Step 3b**: 12 files; assertion totals as documented in slice 001's `regression-checkpoint-us1.md` and `regression-final.md`.
- **Step 4**: no output, exit 0.
- **Step 5**: build succeeds; production bundle output reports the new `/matches` page + `/api/matches` route handler; no warnings about `service-role.ts` being bundled.
- **Step 7**: every `@slice-002 @us1` test that is not `test.fixme` passes (19 of 20 slice-002 US1 tests; the single `slice-002-late-fixture-appears` stays in its `test.fixme` self-skip until US2 + US3 ship — that is acceptable for US1's merge gate per `red-gate-us1.md § Sign-off checklist`).

---

## 8. Open deferred work blocking a fully observed GREEN

The following items were authored or invoked but their **execution-time verification** was deferred due to Docker being down (or to GitHub push not yet having happened). None block this documentation artifact — they block the runtime confirmation that the suite is observably GREEN.

### 8a. Slice 001 carry-forward (9 items, unchanged from slice 001's final gate)

| Task | Why deferred | What still needs running |
|---|---|---|
| T005 (slice 001) | pgTAP harness smoke check — Docker down | `supabase test db supabase/tests/pgtap/_harness_smoke.sql` after `supabase start`. |
| T006 (slice 001) | OIDC stub `supabase start` boot-verification — Docker down | Confirm OIDC sidecar URL reachable from `assertOidcStubReachable()`. |
| T007 (slice 001) | CI workflow PR-trigger verification — repo not yet pushed | Open a PR; observe `.github/workflows/ci.yml` runs and gates merge. |
| T021 (slice 001) | US1 RED-gate runtime — Docker down | Slice-001 stash-and-test recipe (now retrospective; covered by `regression-final.md`). |
| T031 (slice 001) | US2 RED-gate runtime — Docker down | Slice-001 stash-and-test for US2. |
| T035 (slice 001) | US2 regression-checkpoint runtime — Docker down | Slice 001's § 7 commands. |
| T039 (slice 001) | US3 RED-gate runtime — Docker down | Slice-001 stash-and-test for US3. |
| T041 (slice 001) | US3 regression-checkpoint runtime — Docker down | Slice 001's § 7 commands. |
| T044 (slice 001) | Quickstart 8-step manual verification — Docker down | Execute `specs/001-eligibility-login/quickstart-verification.md` steps 1–8 manually. |

### 8b. Slice 002 Docker-dependent deferrals (4 items)

| Task | Why deferred | What still needs running |
|---|---|---|
| T001 (slice 002) | Baseline runtime — joint with slice 001 | Implicit in steps 1–3b of § 7 above. |
| T002 (slice 002) | `supabase start` for `pg_cron` + `pg_net` extension boot-verification — Docker down | `supabase start && psql -c "SELECT extname FROM pg_extension"` (must include `pg_cron` and `pg_net`). |
| T018 (slice 002) | US1 RED-gate runtime — Docker down (this slice) | Stash the implementations (T019/T020/T021), run § 7 steps 1+3a+4+7, observe RED, restore, re-run, observe GREEN. Full recipe in `red-gate-us1.md § Verification commands`. |
| **T022 (this doc)** | Runtime suite GREEN under live Docker — Docker down | Execute § 7 steps 1–7 above. |

### 8c. Test that STAYS RED until later phases ship

| Test | Stays RED until | Owner |
|---|---|---|
| `slice-002-late-fixture-appears.spec.ts` | Phase 4 (US2) + Phase 5 (US3 sync) ship the `sync-catalog` Edge Function, stub provider snapshot (T030), sync coordinator (T032/T033), adapter (T040), and fixture JSON (T041). Self-fixmes until preconditions exist; that fixme is the correct US1-time behaviour and DOES NOT block this gate. | T020 (`/api/matches`) + T021 (page) + T030 + T032 + T033 + T040 + T041. |

---

## 9. Spec deviations consolidated

Carry-forward from slice 001 (D-001 through D-005) + slice 002 additions (D-006, D-007). Full bodies live in the source files referenced.

| ID | Where recorded | One-liner |
|---|---|---|
| D-001 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`. Slice 002 mid-session-deny test inherits this. |
| D-002 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `is_approved_domain(p_email text)` takes a FULL email, not a bare domain. Slice 002 audit triggers and fixtures must pass email strings. |
| D-003 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `/api/me` body shape uses `{ participant: {...} }`; errors use `{ error: { code, message } }` with explicit codes + `Cache-Control: private, max-age=0, must-revalidate`. Slice 002's `/api/matches` mirrors the error envelope byte-for-byte. |
| D-004 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `participants_self_or_admin_read` policy already embeds the eligibility predicate (combined OR'd policy). Slice 002's catalog RLS (T009 / migration 0026) follows the same pattern. |
| D-005 | `specs/001-eligibility-login/tasks.md § Implementation deviations` | `handle_auth_user_signed_in` returns the `{claims}` / `{error}` `custom_access_token` envelope, not `{decision}`. Slice 002 fixtures that mock token issuance must emit the same shape. |
| D-006 | `specs/002-match-catalog/tasks.md` lines 51–63 | Wave-2 schema reconciliation across `0020_matches.sql` / `0021_match_results.sql` / `0022_provider_sync_tables.sql` / `0023_match_pending_review.sql` / `0028_provider_config_defaults.sql` / `_shared/providers/types.ts`. Canonical enum values + LOCKED `_for_scoring` columns confirmed; some internal shapes diverge from `data-model.md`. **The as-built migrations are now authoritative for slice 002.** Flagged for slice 005 (`result_status` enum value) and slice 006 (`match_pending_review` enum normalisation). |
| D-007 | `specs/002-match-catalog/tasks.md` lines 65–75 | `match_results` field-name mapping in `/api/matches` (T020). Route handler PROJECTS `home_score_official = home_score + COALESCE(extra_time_home_score,0) + COALESCE(penalty_home_score,0)` (and same for away). `home_score_for_scoring` / `away_score_for_scoring` pass through unchanged. `approved_at` sourced from `match_results.recorded_at`. `mapResultStatus()` reconciles the singular DB value `'penalty_shootout'` to the contract's plural `'penalties_shootout'`. Sort param accepts both `kickoff_utc_asc/desc` (contract) and `kickoff_asc/desc` (TS type). |

No D-008 reserved by Phase 3; the next deviation slot for US2 / US3 work is D-008.

---

## 10. Pre-merge action items (operator checklist)

Tick each box before opening (or merging) the slice-002 PR.

- [ ] Docker Desktop running and healthy on the verifying machine (`docker info` exits 0).
- [ ] § 7 step 1 (`supabase start`) succeeds and the Supabase Studio URL is reachable.
- [ ] § 7 step 2 (`supabase db reset`) applies all 20 migrations cleanly and loads both seed fixtures with no errors.
- [ ] § 7 step 3a (slice-002 pgTAP) reports `ok 1..7` against `slice-002-catalog-rls.sql`.
- [ ] § 7 step 3b (slice-001 pgTAP carry-forward) reports all 12 files green at the documented assertion totals.
- [ ] § 7 step 4 (`pnpm -F web exec tsc --noEmit`) exits 0 with no output.
- [ ] § 7 step 5 (`pnpm -F web build`) succeeds and emits the new `/matches` route + `/api/matches` route handler in the build manifest; `service-role.ts` is NOT bundled.
- [ ] § 7 step 7 (`pnpm -F web e2e -- --grep '@slice-002 @us1'`) reports 19 of 20 slice-002 US1 tests passed; the remaining 1 is `slice-002-late-fixture-appears` legitimately self-fixme'd until US2 + US3 ship.
- [ ] § 8a (slice 001 carry-forward deferrals) — at minimum T005, T006, T007 ticked GREEN on slice 001's gate; the slice-002 PR cannot ship without slice 001 also satisfying its own pre-merge checklist (the two PRs may merge together).
- [ ] § 8b (slice 002 Docker-dependent deferrals) — T001, T002, T018, T022 all observably GREEN against the live stack.
- [ ] § 8c — `slice-002-late-fixture-appears.spec.ts` confirmed to be in its `test.fixme` skip branch (NOT failing assertions). Once US2 + US3 ship the test must flip to live GREEN; track in `regression-checkpoint-us2.md` and `regression-checkpoint-us3.md`.
- [ ] PR description references this file (`specs/002-match-catalog/regression-checkpoint-us1.md`) plus `red-gate-us1.md`, `regression-baseline-from-001.md`, and (once they exist) `regression-checkpoint-us2.md`, `regression-checkpoint-us3.md`, and `regression-final.md`.

Per Principle XI (NON-NEGOTIABLE): the artifact-level checkpoint produced today IS NOT the merge gate. Runtime confirmation against a live Docker stack is the merge gate. Until every box above is ticked, Phase 4 (US2) MAY NOT start, Phase 5 (US3) MAY NOT start, and slice 002 MAY NOT merge to `main`.
