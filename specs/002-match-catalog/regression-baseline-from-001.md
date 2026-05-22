# Regression baseline from Slice 001 — Slice 002 starting point

- **Slice**: `002-match-catalog`
- **Phase**: 1 (Setup)
- **Date**: 2026-05-19
- **Purpose**: Baseline verification from Slice 001 — confirm Slice 001's artifact inventory is complete on disk so Slice 002 can build on its locked cross-slice contracts. Per Constitution Principle XI, Slice 002 cannot start with Slice 001's regression suite in a red state.
- **Owning task**: T001 (`specs/002-match-catalog/tasks.md` line 51)
- **Companion artifacts**:
  - `specs/001-eligibility-login/regression-final.md` (slice 001's final gate — the source of truth this document echoes)
  - `specs/001-eligibility-login/tasks.md § Implementation deviations` (D-001 through D-005, carried forward into slice 002)

---

## Status: DEFERRED (artifact baseline complete; runtime verification jointly deferred with Slice 001)

Slice 001's regression-final.md status (the canonical predecessor gate) reads `DEFERRED (artifacts complete, runtime verification pending)` because Docker Desktop was DOWN at slice-001 final-gate execution. Every runtime command in slice 001's § 5 Pre-merge checklist (`supabase start`, `supabase db reset`, the pgTAP loop, `pnpm -F web exec tsc --noEmit`, `pnpm -F web build`, the Playwright `@slice-001` run, the manual quickstart 8-step) requires a working Docker daemon and remains unexecuted.

**This document is therefore an artifact-level baseline, not a runtime observation.** All slice-001 artifacts (migrations, app code, tests, contract locks, deviations) are confirmed present on disk by direct file-system inspection executed during T001. What remains is the joint runtime confirmation across both slices — that runtime probe lives in slice 002's `regression-final.md` (T046) alongside slice 001's § 5 pre-merge checklist. Neither slice can merge to `main` until both runtime checklists land GREEN; both surfaces share the same Docker dependency and the same operator-driven execution window.

**Per Principle XI**, slice 002 may proceed with **artifact authoring** (migrations, pgTAP, Playwright specs, app code, contracts) on the strength of the artifact baseline below. Slice 002 MUST NOT merge until both slices' runtime gates are GREEN.

---

## 1. Slice 001 artifact inventory

Verified by direct file-system listing on 2026-05-19. Every row labeled `EXISTS` was confirmed via `Glob` / `ls`.

### 1.1 Migrations (11 files)

| # | File | Status |
|---|---|---|
| 1 | `supabase/migrations/0001_participants.sql` | EXISTS |
| 2 | `supabase/migrations/0002_tournament_config_stub.sql` | EXISTS |
| 3 | `supabase/migrations/0003_audit_log_stub.sql` | EXISTS |
| 4 | `supabase/migrations/0004_is_approved_domain.sql` | EXISTS |
| 5 | `supabase/migrations/0005_is_eligible_nortal_participant.sql` | EXISTS |
| 6 | `supabase/migrations/0006_is_admin_stub.sql` | EXISTS |
| 7 | `supabase/migrations/0007_participants_rls.sql` | EXISTS |
| 8 | `supabase/migrations/0008_participants_audit_trigger.sql` | EXISTS |
| 9 | `supabase/migrations/0009_auth_hooks.sql` | EXISTS |
| 10 | `supabase/migrations/0010_audit_log_api_guard_insert.sql` | EXISTS |
| 11 | `supabase/migrations/0011_participants_rls_eligibility_tighten.sql` | EXISTS (header-only no-op per D-004) |

**Tally**: 11/11 EXISTS, 0 MISSING.

### 1.2 pgTAP test files (`supabase/tests/pgtap/`)

Slice 001's regression-final.md § 1 row 2 declares "12 total" (11 slice-001 functional + perf, plus 1 harness smoke). Direct disk listing on 2026-05-19 returned **12 files**:

| # | File | Category | Status |
|---|---|---|---|
| 1 | `supabase/tests/pgtap/_harness_smoke.sql` | Harness (Phase 1) | EXISTS |
| 2 | `supabase/tests/pgtap/is_approved_domain.sql` | Functional (US1) | EXISTS |
| 3 | `supabase/tests/pgtap/is_eligible_active_approved.sql` | Functional (US1) | EXISTS |
| 4 | `supabase/tests/pgtap/is_eligible_deactivated.sql` | Functional (US1) | EXISTS |
| 5 | `supabase/tests/pgtap/is_eligible_unknown_uid.sql` | Functional (US1) | EXISTS |
| 6 | `supabase/tests/pgtap/is_eligible_null_uid.sql` | Functional (US1) | EXISTS |
| 7 | `supabase/tests/pgtap/auth_hook_first_login.sql` | Functional (US2) | EXISTS |
| 8 | `supabase/tests/pgtap/auth_hook_returning_login.sql` | Functional (US3) | EXISTS |
| 9 | `supabase/tests/pgtap/auth_hook_fails_closed_on_missing_config.sql` | Functional (US3 fail-closed) | EXISTS |
| 10 | `supabase/tests/pgtap/slice-001-api-me-rls.sql` | RLS-isolation (US2) | EXISTS |
| 11 | `supabase/tests/pgtap/participants_rls_mid_session_deny.sql` | RLS-isolation (US3) | EXISTS |
| 12 | `supabase/tests/pgtap/is_eligible_perf.sql` | Perf (Phase 6 / T042) | EXISTS |

**Tally**: 12/12 EXISTS. (Task-brief target was "13 pgTAP files (incl. perf + 2 RLS-isolation + harness)"; the canonical count per slice 001's regression-final.md § 2 is **12 files = 11 slice-001 functional+perf + 1 harness smoke**. The 12 on disk match the regression-final.md authoritative aggregate. No file is missing.) Includes: harness (1) + perf (1) + RLS-isolation (2: `slice-001-api-me-rls.sql`, `participants_rls_mid_session_deny.sql`) + functional eligibility/hook coverage (8).

### 1.3 Playwright specs (`apps/web/tests/playwright/`)

Slice 001's regression-final.md § 1 row 1 declares "15 spec files total" (14 slice-001 + 1 harness smoke). Direct listing returned **15 files**:

| # | File | Tag | Status |
|---|---|---|---|
| 1 | `apps/web/tests/playwright/smoke.spec.ts` | (harness, no slice tag) | EXISTS |
| 2 | `apps/web/tests/playwright/slice-001-login-approved.spec.ts` | `@slice-001` | EXISTS |
| 3 | `apps/web/tests/playwright/slice-001-login-missing-claims.spec.ts` | `@slice-001` | EXISTS |
| 4 | `apps/web/tests/playwright/slice-001-login-denied-domain.spec.ts` | `@slice-001` | EXISTS |
| 5 | `apps/web/tests/playwright/slice-001-api-me-401.spec.ts` | `@slice-001` | EXISTS |
| 6 | `apps/web/tests/playwright/slice-001-api-me-403-domain-removed.spec.ts` | `@slice-001` | EXISTS |
| 7 | `apps/web/tests/playwright/slice-001-api-me-no-leak.spec.ts` | `@slice-001` | EXISTS |
| 8 | `apps/web/tests/playwright/slice-001-callback-denied-domain.spec.ts` | `@slice-001` | EXISTS |
| 9 | `apps/web/tests/playwright/slice-001-callback-no-code.spec.ts` | `@slice-001` | EXISTS |
| 10 | `apps/web/tests/playwright/slice-001-denied-no-leak.spec.ts` | `@slice-001` | EXISTS |
| 11 | `apps/web/tests/playwright/slice-001-denied-renders-without-session.spec.ts` | `@slice-001` | EXISTS |
| 12 | `apps/web/tests/playwright/slice-001-domain-removed-mid-session.spec.ts` | `@slice-001` | EXISTS |
| 13 | `apps/web/tests/playwright/slice-001-email-drift.spec.ts` | `@slice-001` | EXISTS |
| 14 | `apps/web/tests/playwright/slice-001-missing-optional-claim.spec.ts` | `@slice-001` | EXISTS |
| 15 | `apps/web/tests/playwright/slice-001-returning-login-refresh.spec.ts` | `@slice-001` | EXISTS |

**Tally**: 15/15 EXISTS (the 15 specs claimed by the task brief). 14 carry `@slice-001`; the 15th (`smoke.spec.ts`) is the untagged harness probe.

### 1.4 Test helpers (1 file)

| File | Status |
|---|---|
| `apps/web/tests/playwright/helpers/service-role.ts` | EXISTS |

**Tally**: 1/1 EXISTS. The helper carries the dev-only marker per slice 001's regression-final.md row 4 — it MUST NOT be picked up by `next build`.

### 1.5 First-party app files (7 files)

| # | File | Status |
|---|---|---|
| 1 | `apps/web/lib/types/participant.ts` | EXISTS |
| 2 | `apps/web/lib/auth/requireEligible.ts` | EXISTS |
| 3 | `apps/web/lib/auth/getCurrentParticipant.ts` | EXISTS |
| 4 | `apps/web/app/auth/callback/page.tsx` | EXISTS |
| 5 | `apps/web/app/auth/denied/page.tsx` | EXISTS |
| 6 | `apps/web/app/dashboard/page.tsx` | EXISTS |
| 7 | `apps/web/app/api/me/route.ts` | EXISTS |

**Tally**: 7/7 EXISTS.

### 1.6 Fixture seed (1 file)

| File | Status |
|---|---|
| `supabase/seed/slice-001-fixture.sql` | EXISTS |

**Tally**: 1/1 EXISTS.

### 1.7 OIDC stub infrastructure

| Artifact | Status |
|---|---|
| `infra/oidc-stub/` directory | EXISTS |
| `infra/oidc-stub/README.md` | EXISTS |
| `infra/oidc-stub/keys/rsa-private.pem` | EXISTS |
| `infra/oidc-stub/keys/rsa-public.pem` | EXISTS |
| `docker-compose.override.yml` | EXISTS |

**Tally**: directory + 4 supporting files EXISTS.

### 1.8 CI workflow (1 file)

| File | Status |
|---|---|
| `.github/workflows/ci.yml` | EXISTS |

**Tally**: 1/1 EXISTS. Its PR-trigger run remains DEFERRED (slice 001 has not yet been pushed; no PR has opened).

### Inventory aggregate

| Surface | Verified EXISTS | MISSING |
|---|---|---|
| Migrations | 11 | 0 |
| pgTAP files | 12 | 0 |
| Playwright specs | 15 | 0 |
| Test helpers | 1 | 0 |
| First-party app files | 7 | 0 |
| Fixture seed | 1 | 0 |
| OIDC stub artifacts | 5 (dir + 4 files) | 0 |
| Docker-compose override | 1 | 0 |
| CI workflow | 1 | 0 |
| **Total** | **54** | **0** |

Zero MISSING. Slice 001's artifact phase is complete on disk.

---

## 2. Cross-slice contracts Slice 002 depends on

Slice 002's `spec.md § Architecture anchors` (FR-004, FR-017) and `tasks.md` reference five concrete slice-001-owned symbols. Each is confirmed below by direct grep against the slice-001 migrations.

| # | Symbol / shape | Slice 001 source | Slice 002 consumer | Confirmation |
|---|---|---|---|---|
| 1 | `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE SECURITY INVOKER` | `supabase/migrations/0005_is_eligible_nortal_participant.sql` | Catalog RLS (T009) — `matches`, `match_results`, `teams` read policies USE `auth.uid()` via this predicate | EXISTS (migration 0005); locked in slice 001 regression-final § 3 row 1 |
| 2 | `public.is_admin(p_user_id uuid) RETURNS boolean STABLE` (stub returning constant `FALSE`) | `supabase/migrations/0006_is_admin_stub.sql` | `record_match_result(...)` SP (T029) — admin-only writer; signature LOCKED, body replaced by slice 006 | EXISTS (migration 0006); locked in slice 001 regression-final § 3 row 2 |
| 3 | `public.participants` table (canonical column list locked in slice 001 regression-final § 3 row 5; `participation_status` enum LOCKED to `{active, deactivated}`) | `supabase/migrations/0001_participants.sql` | RLS `USING` clauses for `matches` + `match_results` + `predictions` (downstream FKs to `participants(id)`) | EXISTS (migration 0001); slice 002 FKs `match_results.recorded_by → participants(id)` |
| 4 | `public.audit_log` table (10 canonical columns: `id`, `actor`, `action`, `source` CHECK in `{auth_hook, rls, api_guard, ui, trigger}`, `entity_type`, `entity_id`, `previous_value`, `new_value`, `reason`, `occurred_at`) | `supabase/migrations/0003_audit_log_stub.sql` | Catalog audit triggers (T008) + sync-engine event emission (every `provider.*` action) + `record_match_result` SP | EXISTS (migration 0003); locked in slice 001 regression-final § 3 row 6. Slice 002 writes with `source='trigger'` (catalog mutation triggers) and `source='api_guard'` (sync coordinator). Additive column changes only — no rename/drop. |
| 5 | `public.tournament_config` table (stub shape: `key text PK`, `value jsonb NOT NULL`, `updated_at timestamptz`; seeded with `('eligibility.approved_domains', '["nortal.com"]'::jsonb)`) | `supabase/migrations/0002_tournament_config_stub.sql` | Slice 002 extends with provider/cadence keys (T010): `provider_sync.cadence.pre_tournament`, `provider_sync.cadence.tournament_day`, `provider_sync.cadence.live`, `provider_sync.live_window.pre_kickoff_minutes`, `provider_sync.live_window.post_kickoff_hours`, `provider_sync.payload.undersized_threshold`, `provider_sync.outage.alert_after_minutes`, `notifications.outage_webhook_url`, `sync.advisory_lock_key`. Insert-only — does not alter the shape locked by slice 001. | EXISTS (migration 0002); locked in slice 001 regression-final § 3 row 7. Slice 008 owns the additive ALTERs (`value_type`, `updated_by`, `version_id`, RLS, `config_read()` helper); slice 002 only INSERTs new rows. |

**Tally**: 5/5 cross-slice contracts confirmed present on disk and unchanged. Slice 002 may safely consume them.

---

## 3. Slice 001 deferred items inherited as Slice 002 prerequisites

Per slice 001's regression-final.md § 2 row 7, slice 001 ships with **9 deferred-verification tasks**: T005, T006, T007, T021, T031, T035, T039, T041, T044. Three of those nine block slice 002 directly because slice 002 reuses the same runtime infrastructure:

| Deferred slice-001 task | Why slice 002 is also blocked | Resolution path |
|---|---|---|
| **T005** — pgTAP harness smoke run (`supabase test db supabase/tests/pgtap/_harness_smoke.sql`) | Slice 002 authors more pgTAP files (catalog RLS isolation, `record_match_result` invariants, sync-engine event audit checks) against the same harness. If the harness itself is broken on the live Docker stack, neither slice's pgTAP suite can run. | One-time smoke once Docker is up; covers both slices. |
| **T006** — Supabase + OIDC stub boot (`supabase start` + `docker-compose.override.yml` OIDC sidecar healthy) | Slice 002's Playwright specs (participant `/matches` page, sync-trigger headers, outage simulation) require the same Next.js dev server + Supabase + OIDC-stub triad. | One-time bring-up; covers both slices. |
| **T007** — CI workflow PR-trigger run (`.github/workflows/ci.yml` on a real PR) | Slice 002 will need the same CI workflow to gate its own PR. The workflow has never observed a real PR-trigger; its slice-002 jobs will be authored on top of (and validated by) the same first run. | First slice-001 PR push exercises the workflow; slice-002 PR push runs it again with slice-002 jobs added. |

The remaining six slice-001 deferrals (T021, T031, T035, T039, T041, T044) are slice-001-internal verification tasks (RED-gate observations, regression checkpoint runtime, quickstart 8-step). They block slice 001's merge but do not block slice 002's artifact authoring; they will land alongside slice 001 once Docker is back.

**Slice 002 will add its own deferred-verification tasks** during its execution; the joint pre-merge checklist for both slices lives in slice 002's `regression-final.md` at T046.

---

## 4. Verdict

**BASELINE ARTIFACTS COMPLETE; runtime verification DEFERRED jointly with Slice 001.**

- All 11 slice-001 migrations, all 12 pgTAP files, all 15 Playwright specs (14 `@slice-001` + 1 harness), all 7 first-party app files, the dev-only service-role helper, the fixture seed, the OIDC stub infrastructure, the docker-compose override, and the CI workflow are confirmed EXISTS on disk.
- All 5 cross-slice contracts slice 002 consumes (`is_eligible_nortal_participant`, `is_admin`, `participants`, `audit_log`, `tournament_config`) are confirmed locked and consumable.
- The 3 slice-001 deferred tasks slice 002 inherits (T005 harness smoke, T006 stack boot, T007 CI PR trigger) are documented and roll into the joint pre-merge checklist.

Slice 002 may proceed with artifact authoring (Phase 1 setup additions, Phase 2 foundational migrations, Phase 3 pgTAP RED gates, Phase 4 implementation, Phase 5 sync coordinator + outage handling, Phase 6 polish). Slice 002's `regression-final.md` (T046) will carry the joint runtime probe and the joint pre-merge checklist — slice 002 cannot merge to `main` until both slice 001's § 5 pre-merge checklist AND slice 002's equivalent are 100% ticked GREEN against a working Docker daemon.

Per Principle XI (NON-NEGOTIABLE): the artifact baseline IS NOT the regression gate. Runtime confirmation against the live stack remains required before merge of either slice.

---

## 5. D-001 through D-005 carry-forward

Slice 002 inherits and MUST honor the five accepted slice-001 deviations. Full entries in `specs/001-eligibility-login/tasks.md § Implementation deviations`:

| ID | One-liner | Slice 002 impact |
|---|---|---|
| **D-001** | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`; `handle_auth_user_signed_in` fires on every token issuance (initial sign-in + every refresh). See `specs/001-eligibility-login/tasks.md` lines 83-91. | Slice 002's catalog RLS predicate (`auth.uid()` → `is_eligible_nortal_participant`) is re-evaluated on every token refresh, not only on full re-login. Slice 002 Playwright fixtures MUST drive the OIDC stub through the `custom_access_token` path; no spec should assume a one-shot `before_user_signed_in`. |
| **D-002** | `is_approved_domain(p_email text)` accepts a FULL email, not a bare domain — extracts the domain segment internally via `split_part(lower(trim(p_email)),'@',2)`. See `specs/001-eligibility-login/tasks.md` lines 77-81. | Slice 002 does not call `is_approved_domain` directly (its eligibility check routes through `is_eligible_nortal_participant`), but any new audit triggers or test fixtures that touch the predicate MUST pass email strings, never bare domains. |
| **D-003** | `/api/me` body shape reconciled to `contracts/participant-me.read.md`: 200 returns `{ participant: {...} }` (8 narrowed fields, omits `auth_user_id`/`created_at`/`updated_at`); errors return `{ error: { code, message } }` with codes `UNAUTHENTICATED` / `DOMAIN_NOT_APPROVED` / `INTERNAL`; every response carries `Cache-Control: private, max-age=0, must-revalidate`. See `specs/001-eligibility-login/tasks.md` lines 69-75. | Slice 002's new participant-facing API (`/api/matches`) MUST follow the same envelope conventions: `{ matches: [...] }` (or `{ data: ... }`) on 200, `{ error: { code, message } }` on errors, identical `Cache-Control` semantics for authenticated reads. Slice 002 should NOT echo the slice-001 drift (raw object on success, terse string error). The route handler is the consumer for `requireEligible`'s 403/401 paths. |
| **D-004** | `participants` RLS tightening already shipped under T012 (migration 0007 embeds the eligibility predicate in `participants_self_or_admin_read.USING`). Migration 0011 is a header-only no-op marker; the predicate-path tightening is already live. See `specs/001-eligibility-login/tasks.md` lines 58-67. | Slice 002 catalog RLS (T009) follows the same pattern: single OR'd policy embedding `is_eligible_nortal_participant(auth.uid())`, not a self-read + admin-read pair of separately-named policies. No retroactive split of slice-001's `participants_self_or_admin_read`. |
| **D-005** | `handle_auth_user_signed_in` returns the Supabase `custom_access_token` envelope (`{claims: ...}` accept / `{error: {http_code, message}}` reject), NOT the contract's `{decision, message}` envelope. `handle_auth_user_created` retains the `{decision, message}` envelope. The two hooks are deliberately asymmetric in their return contract. See `specs/001-eligibility-login/tasks.md` lines 48-56. | Slice 002 has no direct dependency on the auth-hook return envelope, but any slice-002 test fixture that mocks token issuance MUST emit the `{claims}` / `{error}` shape — the `{decision}` shape will be silently ignored by the Supabase Auth runtime and will admit users who should be rejected. |

No D-006 reserved by slice 001's final gate; the next deviation slot for slice 002 work is D-006.

---

## 6. Companion runtime gate (where the joint pre-merge checklist lives)

This document is the **artifact-level baseline**. The **runtime-level baseline** for the joint slice-001 + slice-002 regression — the document that records the actual `supabase start` / `supabase db reset` / pgTAP loop / `tsc --noEmit` / `next build` / Playwright `@slice-001 + @slice-002` / quickstart-verification output against a live Docker stack — lives at:

- `specs/002-match-catalog/regression-final.md` (T046, slice 002 Phase 6 polish)

T046 will reproduce slice 001's § 5 pre-merge checklist VERBATIM and append slice 002's equivalent checklist below it. Both checklists MUST land GREEN before slice 002's PR merges to `main`.
