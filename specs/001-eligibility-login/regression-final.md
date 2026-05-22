# Final regression gate — Slice 001 (Eligibility & Login)

- **Slice**: `001-eligibility-login`
- **Phase**: 6 (Polish)
- **Date**: 2026-05-19
- **Purpose**: **Slice 001 final regression gate.** Tabulate every test surface that participates in slice 001, record its status, and supply the verification command the operator MUST run before merge.
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE — `.specify/memory/constitution.md` § XI) — "The full regression suite — all previously-green BDD scenarios plus all unit and integration tests — MUST be passing before any new task is started, any new slice is begun, or any PR is merged." Also Principle X (Vertical Slice Delivery) for the quickstart row.
- **Owning task**: T045 (`specs/001-eligibility-login/tasks.md` line 1640)
- **Sibling artifacts**:
  - `specs/001-eligibility-login/regression-checkpoint-us1.md` (T028)
  - `specs/001-eligibility-login/regression-checkpoint-us2.md` (T035)
  - `specs/001-eligibility-login/regression-checkpoint-us3.md` (T041) — direct predecessor
  - `specs/001-eligibility-login/quickstart-verification.md` (T044)
  - `specs/001-eligibility-login/red-gate-us1.md`, `red-gate-us2.md`, `red-gate-us3.md`

---

## Status: DEFERRED (artifacts complete, runtime verification pending)

Docker Desktop was DOWN at execution time. Every step in this document's verification chain — `supabase start`, `supabase db reset`, the pgTAP loop, `pnpm -F web exec tsc --noEmit`, `pnpm -F web build`, the Playwright run, and the manual quickstart — requires a working Docker daemon (the local Supabase stack, the OIDC stub sidecar, and the Next.js dev server collectively depend on it).

**This document is therefore a documentation artifact, not an observation.** All slice-001 artifacts (migrations, app code, tests, contract locks, deviations) are complete and consistent on disk. What remains is the runtime confirmation — every entry below marked `ARTIFACTS COMPLETE; runtime verification DEFERRED` or `DEFERRED` requires the operator to bring Docker up and execute the commands in the pre-merge checklist (§ Pre-merge checklist).

**Per Principle XI, Slice 001 cannot be considered merged until the pre-merge checklist at the bottom of this document is 100% ticked.** No part of slice 001 ships to `main` while this status line still reads `DEFERRED`.

---

## 1. Surface tabulation

Seven surfaces, one row each. `ARTIFACTS COMPLETE` = the files / code / tests are written and consistent. `DEFERRED` = the runtime check requires Docker / a pushed PR / a populated `.env.local` and could not be executed. `N/A` = the surface does not exist in this slice (with a recommendation captured for a follow-up slice).

| # | Surface | Files | Count | Status | Verification command |
|---|---|---|---|---|---|
| 1 | Playwright slice-001 specs | `apps/web/tests/playwright/slice-001-*.spec.ts` (14 specs) + `smoke.spec.ts` (harness, not `@slice-001`-tagged) | 14 slice-001 spec files; **17 runnable tests**; **4 `test.fixme`** skipped (`login-approved` Scenario 3b mid-session deactivation; `login-missing-claims` `email_verified=false` per G-2; `login-missing-claims` forged signature per G-3; one further fixme on the `login-missing-claims` audit-row check) | ARTIFACTS COMPLETE; runtime verification DEFERRED | `pnpm -F web e2e -- --grep '@slice-001'` (after `supabase start` + `supabase db reset` + populated `apps/web/.env.local`) |
| 2 | pgTAP slice-001 tests | `supabase/tests/pgtap/*.sql` (11 slice-001 files + 1 harness smoke = 12 total; T042 added `is_eligible_perf.sql` in Phase 6) | **53+ assertions** across the 10 slice-001 functional pgTAP files (excluding `_harness_smoke.sql` and the perf file's runtime-budget assertion): 9 + 1 + 1 + 1 + 2 + 9 + 4 + 3 + 15 + 8 = 53. The perf file (`is_eligible_perf.sql`, T042) adds 1 p95-budget assertion against 1,000 invocations on a 500-row fixture. Harness smoke adds 1 probe. | ARTIFACTS COMPLETE; runtime verification DEFERRED | `Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object { supabase test db $_.FullName }` (PowerShell). Bash equivalent: `for f in supabase/tests/pgtap/*.sql; do supabase test db "$f" \|\| exit 1; done`. |
| 3 | TypeScript typecheck | `apps/web/**/*.ts`, `apps/web/**/*.tsx` | 7 first-party app files + `apps/web/tests/playwright/helpers/service-role.ts` (dev-only helper). Strict-mode compile of the full workspace. | DEFERRED | `pnpm -F web exec tsc --noEmit` |
| 4 | Next.js build | `apps/web/` (compiled by `next build`) | The full app — 3 pages (`/auth/callback`, `/auth/denied`, `/dashboard`), 1 route handler (`/api/me`), 2 auth-lib modules, 1 types module. The `apps/web/tests/playwright/helpers/service-role.ts` helper carries a `// no-emit` marker and MUST NEVER be picked up by `next build`. | DEFERRED | `pnpm -F web build` (expects exit 0 with no Next.js / tsc errors) |
| 5 | ESLint | `apps/web/package.json` ships `"lint": "next lint"` (verified during T045) — script EXISTS. | Project-wide `next lint` over `apps/web/`. ESLint dep declared (`eslint ^8.57.0`, `eslint-config-next ^14.2.0`); however no `.eslintrc*` config file was authored in this slice, so `next lint` will likely prompt for an interactive config on first run. **Recommendation**: a future slice should commit a non-interactive `.eslintrc.json` so this surface can be made a hard CI gate. | DEFERRED (script exists; non-interactive config is a follow-up) | `pnpm -F web lint` |
| 6 | CI on most recent PR | `.github/workflows/ci.yml` (authored by T007) | The repo has NOT been pushed to GitHub yet, and no PR exists for slice 001. T007's CI workflow was authored but its PR-trigger run was DEFERRED in every prior checkpoint. **The slice 001 PR opening itself is the moment CI first runs against this slice.** | DEFERRED (no PR exists yet) | `gh pr checks` (after `git push -u origin 001-eligibility-login` + `gh pr create`) |
| 7 | Quickstart verification | `specs/001-eligibility-login/quickstart-verification.md` (T044's artifact) | 8 manual steps mapping to FR-001…FR-008 / US1 + US2 + US3 + 4 edge cases. T044 produced the template; every step is currently marked `DEFERRED`. | **8/8 DEFERRED** (0 PASS, 0 FAIL, 8 DEFERRED) | Manually execute steps 1–8 in `quickstart-verification.md`; replace each `Status: DEFERRED` with `Status: PASS — <evidence>` or `Status: FAIL — <reason>`. |

---

## 2. Final tally (aggregate counts per test surface)

The counts below are the authoritative aggregates for the slice. Any future divergence between these numbers and the on-disk state is a slice-001-contract drift and must be reconciled before merge.

| Surface | Aggregate count | Notes |
|---|---|---|
| Playwright spec files | **14 slice-001 specs** + 1 harness smoke = 15 spec files total under `apps/web/tests/playwright/` | All 14 slice-001 specs carry `@slice-001` tags; `smoke.spec.ts` is untagged and skipped by `--grep '@slice-001'`. Numbers cross-checked against `regression-checkpoint-us3.md` § 1b. |
| Playwright runnable tests | **17 runnable** + **4 `test.fixme`** | Runnable: 3 in `login-approved` + 2 in `login-missing-claims` + 8 US2 single-test specs + 4 US3 single-test specs = 17. `test.fixme`: Scenario 3b (`login-approved`), 2 in `login-missing-claims` (`email_verified=false`, forged signature), 1 audit-row fixme (`login-missing-claims`) = 4. |
| pgTAP files | **11 slice-001 files** + 1 harness smoke + 1 perf file (T042, Phase 6) = 13 total `.sql` files under `supabase/tests/pgtap/` | The 11 slice-001 files are the 10 functional files inventoried in `regression-checkpoint-us3.md` § 1a plus the perf file `is_eligible_perf.sql` (T042). Migration count is independent (see next row). |
| pgTAP assertions (slice-001) | **53+ assertions** across the 10 functional slice-001 files | 9 (`is_approved_domain`) + 1 (`is_eligible_active_approved`) + 1 (`is_eligible_deactivated`) + 1 (`is_eligible_unknown_uid`) + 2 (`is_eligible_null_uid`) + 9 (`auth_hook_first_login`) + 4 (`slice-001-api-me-rls`) + 3 (`participants_rls_mid_session_deny`) + 15 (`auth_hook_returning_login`) + 8 (`auth_hook_fails_closed_on_missing_config`) = **53**. The perf file adds 1 p95-budget assertion. Harness smoke adds 1 probe. |
| Migrations applied | **11 migrations** (0001 through 0011) | All apply cleanly under `supabase db reset`. T040's `handle_auth_user_signed_in` body was appended to the existing `0009_auth_hooks.sql` rather than creating 0012 — see D-001 / D-005. Migration 0011 is a header-only no-op marker per D-004. |
| First-party app files | **7 files** under `apps/web/` | Types: `lib/types/participant.ts` (1). Auth lib: `lib/auth/requireEligible.ts`, `lib/auth/getCurrentParticipant.ts` (2). Pages: `app/auth/callback/page.tsx`, `app/auth/denied/page.tsx`, `app/dashboard/page.tsx` (3). API route: `app/api/me/route.ts` (1). Total = 1 + 2 + 3 + 1 = **7**. (Plus the dev-only `apps/web/tests/playwright/helpers/service-role.ts` helper, which is not first-party app code and must not be picked up by `next build`.) |
| Deferred-verification tasks (pre-merge work) | **9 tasks** | T005 (pgTAP harness smoke), T006 (OIDC stub boot), T007 (CI PR-trigger), T021 (US1 RED gate), T031 (US2 RED gate), T035 (US2 regression checkpoint runtime), T039 (US3 RED gate), T041 (US3 regression checkpoint runtime), T044 (quickstart 8 steps). Per task brief the canonical 9-item list is: **T005, T006, T007, T021, T031, T035, T039, T041, T044**. |

---

## 3. Cross-slice contracts locked by slice 001

These are the canonical signatures and shapes that slices 002–008 will depend on. Per Principle XI, **changing any of these after slice 001 merges is a coordinated cross-slice change set requiring regression updates across every consuming slice**. Sourced from `regression-checkpoint-us3.md` § 7.

| Symbol / shape | Canonical declaration |
|---|---|
| `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE SECURITY INVOKER` | The single named eligibility predicate. SELECT-EXISTS over `participants` where `auth_user_id = p_uid AND status='active' AND public.is_approved_domain(email)`. Referenced by every slice 002–008 RLS policy via `auth.uid()`. |
| `public.is_admin(p_user_id uuid) RETURNS boolean STABLE` | Stub returning constant `FALSE`. Signature LOCKED. Slice 006 owns the body replacement (`CREATE OR REPLACE FUNCTION ...`); the signature itself MUST NOT change. |
| `public.handle_auth_user_created(event jsonb) RETURNS jsonb` | Supabase Auth `before_user_created` hook. Return envelope: `{"decision":"continue"}` on accept; `{"decision":"reject","message":"<reason>"}` on reject. SECURITY DEFINER. EXECUTE granted to `supabase_auth_admin` + `service_role`. |
| `public.handle_auth_user_signed_in(event jsonb) RETURNS jsonb` | Supabase Auth `custom_access_token` hook (per D-001). Fires on **every token issuance** (initial sign-in + every refresh). Return envelope per D-005: `{"claims": {...}}` on accept; `{"error":{"http_code":403,"message":"<reason>"}}` on reject — NOT the `{decision,...}` shape from `contracts/auth-hook.sql.md`. SECURITY DEFINER. |
| `public.participants` table | Exact column list (verbatim from migration 0001): `id uuid PK`, `auth_user_id uuid UNIQUE NOT NULL` (FK auth.users), `email citext UNIQUE NOT NULL`, `display_name text NOT NULL`, `domain citext GENERATED ALWAYS AS (split_part(lower(email::text),'@',2)) STORED`, `region text`, `status participation_status NOT NULL DEFAULT 'active'`, `first_login_at timestamptz NOT NULL DEFAULT now()`, `last_login_at timestamptz NOT NULL DEFAULT now()`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`. The `participation_status` enum is LOCKED to exactly `{active, deactivated}`. Every downstream slice FKs to `participants(id)`. |
| `public.audit_log` table | Canonical column names finalized (migration 0003): `id uuid PK`, `actor uuid`, `action text NOT NULL`, `source text NOT NULL CHECK (source IN ('auth_hook','rls','api_guard','ui','trigger'))`, `entity_type text`, `entity_id uuid`, `previous_value jsonb`, `new_value jsonb`, `reason text`, `occurred_at timestamptz NOT NULL DEFAULT now()`. Slice 007 may ADD columns additively but MUST NOT alter or drop these. |
| `public.tournament_config` table | Stub shape (migration 0002): `key text PRIMARY KEY`, `value jsonb NOT NULL`, `updated_at timestamptz`. Slice 008 will ALTER additively (`value_type`, `updated_by`, `version_id`, RLS, `config_read()` helper). Seeded with `('eligibility.approved_domains', '["nortal.com"]'::jsonb)`. |
| `audit_log_api_guard_self_insert` RLS INSERT carve-out (migration 0010) | `CREATE POLICY audit_log_api_guard_self_insert ON public.audit_log FOR INSERT TO authenticated WITH CHECK (action='access.denied' AND source='api_guard' AND reason IN ('not_eligible','domain_not_approved','participant_not_provisioned') AND actor IS NOT DISTINCT FROM (SELECT id FROM participants WHERE auth_user_id = auth.uid()))`. **All four conjuncts are the contract.** Slice 007's audit hardening MUST preserve this exact carve-out (or migrate it explicitly). |
| `GET /api/me` response shape (D-003 reconciliation) | **200**: `{ "participant": { id, email, display_name, domain, region, status, first_login_at, last_login_at } }` — exactly 8 fields, omits `auth_user_id`, `created_at`, `updated_at`. **401**: `{ "error": { "code": "UNAUTHENTICATED", "message": "Sign in to continue." } }`. **403**: `{ "error": { "code": "DOMAIN_NOT_APPROVED", "message": "..." } }`. **500**: `{ "error": { "code": "INTERNAL", "message": "..." } }`. **Every response** carries `Cache-Control: private, max-age=0, must-revalidate`. |

---

## 4. Deviation summary (D-001 through D-005)

One-liner per deviation; full entries live in `specs/001-eligibility-login/tasks.md § Implementation deviations`. All five are accepted and documented — no D-006 has been reserved by this gate.

| ID | One-liner | tasks.md ref |
|---|---|---|
| D-001 | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]` (CLI v2.98.2 does not parse the spec's key); `handle_auth_user_signed_in` (T040) implements the `custom_access_token` signature. | `tasks.md` lines 83–91 |
| D-002 | `is_approved_domain(p_email text)` accepts a FULL email, not a bare domain — the function extracts the domain segment internally via `split_part(lower(trim(p_email)),'@',2)`. | `tasks.md` lines 77–81 |
| D-003 | `/api/me` body shape reconciled to `contracts/participant-me.read.md`: 200 returns `{ participant: {...} }` (8 narrowed fields), errors return `{ error: { code, message } }`, every response sets `Cache-Control: private, max-age=0, must-revalidate`. | `tasks.md` lines 69–75 |
| D-004 | `participants` RLS tightening already shipped under T012 (migration 0007 embeds the eligibility predicate in `participants_self_or_admin_read.USING`). Migration 0011 is therefore a header-only no-op marker; the predicate-path tightening is already live. | `tasks.md` lines 58–67 |
| D-005 | `handle_auth_user_signed_in` returns the Supabase `custom_access_token` envelope (`{claims: ...}` accept / `{error: {http_code, message}}` reject), NOT the contract's `{decision, message}` envelope. `handle_auth_user_created` retains the `{decision, message}` envelope. The two hooks bind to distinct Supabase Auth hook keys and are deliberately asymmetric. | `tasks.md` lines 48–56 |

---

## 5. Pre-merge checklist

Tick each box in order. Stop on the first failure; do NOT proceed until the preceding step is GREEN. Slice 001 cannot merge until every box is ticked.

- [ ] Start Docker Desktop and wait for `docker ps` to return 0 with no error.
- [ ] `cd` to the repo root (`C:\Users\kevin.cadavid\Documents\world-cup-madness`).
- [ ] Run `supabase start`. Confirm `supabase status` reports every service URL with no "unhealthy" lines.
- [ ] Run `supabase db reset` (loads all 11 migrations 0001–0011 + the slice-001 seed fixture at `supabase/seed/slice-001-fixture.sql`).
- [ ] Run the pgTAP loop (PowerShell):
      `Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object { supabase test db $_.FullName }`.
      Expect every file `# Result: PASS`; 53+ slice-001 assertions, plus the perf p95-budget assertion (T042), plus the harness probe.
- [ ] Run `pnpm -F web exec tsc --noEmit` → expect exit 0 with no output.
- [ ] Run `pnpm -F web build` → expect successful production build with no Next.js / TypeScript errors.
- [ ] (If lint config is committed) Run `pnpm -F web lint` → expect 0 errors. If `next lint` prompts interactively because no `.eslintrc*` exists, document the prompt in the PR description and treat the surface as DEFERRED-with-follow-up (a future slice should commit a non-interactive ESLint config). The `lint` script itself is present per `apps/web/package.json`.
- [ ] Populate `apps/web/.env.local` with every variable declared in `apps/web/.env.example`: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, **`SUPABASE_SERVICE_ROLE_KEY`** (required for the US2 + US3 Playwright helpers — `withTemporaryConfig`, `readAuditLog`, `countParticipantsByEmail`), `SUPABASE_AUTH_OIDC_ISSUER`, `SUPABASE_AUTH_OIDC_AUDIENCE`, `SUPABASE_AUTH_OIDC_CLIENT_ID`, `SUPABASE_AUTH_OIDC_CLIENT_SECRET`. Copy values from `supabase status`.
- [ ] Run `pnpm -F web e2e -- --grep '@slice-001'` → expect 17 runnable tests `passed`; the 4 `test.fixme` are skipped and acceptable (their gating gaps are documented in `regression-checkpoint-us3.md` § 6).
- [ ] Manually execute all 8 steps in `specs/001-eligibility-login/quickstart-verification.md`; replace every `Status: DEFERRED` line with `Status: PASS — <evidence>` (paste exact `psql` / `curl` / browser output) or `Status: FAIL — <one-line reason>`. Update the document's `## Overall result` line to `PASS — 8/8 PASS, 0/8 FAIL, 0/8 DEFERRED`.
- [ ] Commit and push to GitHub: `git push -u origin 001-eligibility-login`; `gh pr create --base main --head 001-eligibility-login` (link this document, `quickstart-verification.md`, and the three regression checkpoints in the PR body); confirm `gh pr checks` returns all GREEN (CI authored by T007 must pass on this PR for the first time).
- [ ] **Once every box above is ticked AND every command above returned GREEN → slice 001 satisfies Principle XI and can merge to `main`.**

---

## 6. Merge-gate verdict

**Slice 001 is NOT yet eligible to merge.** Artifacts complete, deferred-verification items above must be resolved first.

Specifically: while every test surface is `ARTIFACTS COMPLETE` on disk (14 Playwright specs, 11 + 1 + 1 pgTAP files, 11 migrations, 7 first-party app files, 5 documented deviations, 9 cross-slice contract locks), zero of the runtime surfaces have been observed GREEN by this agent. The merge gate of Principle XI is unfulfilled.

The user MUST execute the entire § 5 Pre-merge checklist on a working Docker daemon, confirm GREEN on every surface, and only then merge to `main`. Until that runtime confirmation lands, opening or merging the slice 001 PR violates Principle XI (NON-NEGOTIABLE) and risks shipping a broken cross-slice foundation that every subsequent slice (002–008) depends on.

After this gate lands GREEN, slices 002–008 may begin building on the locked cross-slice contracts in § 3.
