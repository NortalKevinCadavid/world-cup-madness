# Slice 004 — Regression baseline from slices 001 + 002 + 003

**Slice**: 004 — Final Tournament Predictions
**Date**: 2026-05-20
**Reference**: Constitution Principle XI — verify the prior baseline is artifact-complete before slice 004 work begins.

## Status: DEFERRED (joint runtime verification with prior slices)

Slices 001, 002, and 003 are all **artifact-complete** but their runtime verification (Docker + Deno + GitHub CI) remains pending. Slice 004 inherits the same deferred-runtime posture; the pre-merge checklist that consolidates all four slices lives at `specs/004-final-predictions/regression-final.md` (T034).

---

## Artifact inventory (verified on disk via `Glob` / `ls`)

### Slice 001 — Eligibility & Login (11 migrations, 12 pgTAP + perf, 15 Playwright, 7 app files)
- Migrations 0001–0011 — EXISTS.
- pgTAP under `supabase/tests/pgtap/` — 12 slice-001 files (alpha-omega coverage of predicates, RLS, auth hook).
- Playwright under `apps/web/tests/playwright/slice-001-*.spec.ts` — 14 files + harness `smoke.spec.ts`.
- App code: `lib/types/participant.ts`, `lib/auth/{requireEligible,getCurrentParticipant}.ts`, `app/auth/{callback,denied}/page.tsx`, `app/dashboard/page.tsx`, `app/api/me/route.ts` — EXISTS.
- Infra: `infra/oidc-stub/`, `docker-compose.override.yml`, `.github/workflows/ci.yml` — EXISTS.

### Slice 002 — Match Catalog & Provider Sync (12 migrations, 9 pgTAP, 12 Playwright, 14 Deno)
- Migrations 0018–0029 — EXISTS.
- pgTAP (slice-002): `slice-002-catalog-rls.sql` + 8 `record_match_result_*.sql` — EXISTS.
- Playwright `slice-002-*.spec.ts` — 12 files.
- Deno tests under `supabase/functions/sync-catalog/tests/` — 14 files (6 US2 + 7 US3 + 1 perf).
- Edge Function + adapters: `supabase/functions/sync-catalog/index.ts`, `_shared/providers/{types.ts, stub/, stub2/, footballdata/}` — EXISTS.
- App code: `lib/types/match.ts`, `lib/catalog/{format,client}.ts`, `app/api/matches/route.ts`, `app/(participant)/{layout,matches/page}.tsx` + components — EXISTS.

### Slice 003 — Match Predictions with Locking (9 migrations, 22 pgTAP, 25 Playwright, 6 new app files + modifications)
- Migrations 0030–0038 — EXISTS.
- pgTAP (slice-003): 22 files spanning `submit_prediction_*`, `is_prediction_locked_*` boundary + status + edge + perf, plus polish `submit_prediction_admin_override` — EXISTS.
- Playwright `slice-003-*.spec.ts` — 25 files / 28 tests.
- App code: `lib/predictions/{types, client, countdown, countdown.test}.ts`, `app/api/predictions/route.ts`, `app/api/me/predictions/route.ts`, `app/(participant)/matches/components/PredictionForm.tsx`, plus modifications to `lib/types/match.ts` (additive `LockState`) and `app/(participant)/matches/page.tsx` (server `lock_state` preferred) — EXISTS.
- Seeds: `supabase/seed/slice-003-fixture.sql` — EXISTS.

**Cumulative**: 32 migrations / 43 pgTAP files / 52 Playwright specs / 14 Deno tests / 21 first-party app files / 3 seed fixtures. **All artifacts EXIST on disk** — no missing files.

---

## Cross-slice contracts slice 004 depends on

| Surface | Owner | Slice 004 usage |
|---|---|---|
| `public.is_eligible_nortal_participant(uuid) STABLE` | Slice 001 / migration 0005 | Required by every slice 004 RLS USING clause + the new `submit_final_prediction` SP eligibility check |
| `public.is_admin(uuid)` (stub returns false) | Slice 001 / 0006 | Slice 006 admin wrapping; slice 004 RLS admin-read |
| `public.participants` table (auth_user_id, status) | Slice 001 / 0001 | Foreign key from `final_predictions.participant_id` |
| `public.audit_log` shape | Slice 001 / 0003 | Slice 004 audit triggers emit into this with `entity_type='final_prediction'` and `action='final_prediction.created' / '.superseded' / '.target_player_removed'` |
| `public.matches` (id, status, kickoff_utc, stage) | Slice 002 / 0020 | `is_final_prediction_locked()` reads MIN(kickoff_utc) across the match catalog |
| `public.teams` (id, short_code) | Slice 002 / 0019 | Foreign key from `final_predictions.champion_team_id` + `runner_up_team_id` |
| `public.tournament_config` | Slice 001 + slices 002/003 seed | Slice 004 reads `predictions.allow_identical_champion_runner_up` (default false) |
| `MatchDataProviderAdapter.fetchPlayers?` interface | Slice 002 / `_shared/providers/types.ts` | Slice 004 Phase 6 T031 activates the optional method; players ingest |

All eight contracts confirmed present on disk in the prior slices' code.

---

## D-016 callout — slice-004 migration slot renumber

Slice 004's plan placed migrations at slots **0036–0046**. Slice 003 already filled **0030–0038**. Slice 004 shifts +3 to start at slot **0039**. See `specs/004-final-predictions/tasks.md § Implementation deviations D-016` for the full slot mapping table. Every slice 004 migration in this checkpoint references the **actual on-disk slot** (0039+), not the spec's original number.

---

## Inherited deferrals (carry-forward block)

Slice 004 inherits all pending pre-merge items from the prior three slices:

- **Slice 001**: T005 (pgTAP harness smoke), T006 (Supabase + OIDC stub boot), T007 (CI workflow PR-trigger).
- **Slice 002**: T001 (baseline runtime), T002 (`supabase start` extensions), T018 (red-gate runtime), T022 (US1 checkpoint runtime), T028 (red-gate runtime), T033 (US2 checkpoint runtime), T038 (red-gate runtime), T042 (US3 checkpoint runtime), T043 (pg_cron schedule verify), T044 (perf runtime), T045 (quickstart runtime).
- **Slice 003**: every documentation artifact deferred runtime via Docker + Deno.

These items are NOT individually re-listed in `specs/004-final-predictions/regression-final.md`; they ARE referenced by their slice's `regression-final.md` (slice 001 + slice 002) or `regression-final.md` (slice 003).

---

## Inherited deviations (D-001 through D-015) — one-liner summary

| ID | Slice | Title |
|---|---|---|
| D-001 | 001 | Auth hook key `before_user_signed_in` → `custom_access_token` (Supabase CLI v2 schema constraint) |
| D-002 | 001 | `is_approved_domain` takes a full email |
| D-003 | 001 | `/api/me` body wrapped per contract |
| D-004 | 001 | T012 front-loaded the eligibility RLS tightening |
| D-005 | 001 | `handle_auth_user_signed_in` uses the `custom_access_token` envelope (`{claims}/{error}`) |
| D-006 | 002 | Wave-2 schema reconciliation: `match_status` enum values, `group_id` column name, multi-method adapter interface |
| D-007 | 002 | `/api/matches` `match_result` column-mapping ( `_official` derived from split columns) |
| D-008 | 002 | pgTAP cannot observe `pg_notify` inside `BEGIN/ROLLBACK` envelope |
| D-009 | 002 | Migration 0025 emits `match_result.updated` (vs contract's `.corrected`) |
| D-010 | 002 | Test/migration enum reconciliation gaps (3 US2 Deno tests with `provider_sync_runs.id`/`provider_name`/`trigger='cron'`) |
| D-011 | 002 | Sync coordinator uses `audit_log.source='api_guard'` (least-bad fit) |
| D-012 | 003 | Slice 003 migration slot renumber (0029 → 0030+) |
| D-013 | 003 | RESOLVED — provisional WCM06 branch in T013 replaced by T021's supersede |
| D-014 | 003 | Supersede self-reference placeholder; slice 007 audit-forensics follow-up |
| D-015 | 003 | Bulk `get_lock_states(uuid[])` helper for `/api/matches` (slot 0038) |

Slice 004 adds D-016 (migration slot renumber, see above) and may surface additional deviations during Phase 2+ execution.

---

## Verdict

**BASELINE ARTIFACTS COMPLETE.** Slice 004 may proceed with artifact authoring. Runtime probe lives at slice 004's `regression-final.md` (T034) along with the consolidated pre-merge checklist for all four slices.

This is the **World Cup Madness** project.
