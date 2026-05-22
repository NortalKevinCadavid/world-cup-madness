# Regression checkpoint — Slice 001, Phase 4 (US2)

- **Slice**: `001-eligibility-login`
- **Phase**: 4 (US2 — "Ineligible domain is rejected")
- **Date**: 2026-05-19
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T035 (`specs/001-eligibility-login/tasks.md` line 1323)
- **Sibling artifacts**:
  - `specs/001-eligibility-login/regression-checkpoint-us1.md` (T028 — Phase 3 checkpoint; this document inherits its structure)
  - `specs/001-eligibility-login/red-gate-us2.md` (T031 — Phase 4 RED gate; this document records the GREEN-side inventory of the same suite)
- **Purpose**: Record the state of the slice-001-so-far test suite at the moment US2 lands, inventory every test the user must run, enumerate the migrations and app code that participate, and hand the exact verification commands to the operator who has a working Docker daemon.

---

## Status: DEFERRED

The Docker daemon was DOWN at execution time. `supabase start`, `supabase db reset`, `supabase test db`, and the Playwright run (which boots the local Supabase stack as a fixture) therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like and the exact commands the user MUST run locally (or in CI, once T007 ships) before the slice can be merged or before Phase 5 (US3) begins. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands at the bottom of this document have all returned GREEN.

---

## 1. Suite inventory

### 1a. pgTAP tests — `supabase/tests/pgtap/`

Nine `.sql` files (US1 carried seven; US2 adds two). Each file is wrapped in `BEGIN; … ROLLBACK;` so it leaves no residue in the database between runs.

| # | File | Purpose | Phase added |
|---|------|---------|-------------|
| 1 | `_harness_smoke.sql` | Probes that the pgTAP extension loads under `supabase test db`; not a slice-001 assertion (harness boot only). | 1 |
| 2 | `is_approved_domain.sql` | 9 assertions covering `public.is_approved_domain(text)`: case-insensitive match, whitespace trim, unapproved domain, empty/NULL input, no suffix expansion (`nortal.co.uk` vs `nortal.com`), and fail-closed when the config row is absent. | 3 |
| 3 | `is_eligible_active_approved.sql` | Happy path — fixture row `alpha@nortal.com` (status='active', approved domain) is reported eligible by `public.is_eligible_nortal_participant(uuid)`. | 3 |
| 4 | `is_eligible_deactivated.sql` | Fixture row `zulu@nortal.com` (status='deactivated') is reported ineligible despite the approved domain. | 3 |
| 5 | `is_eligible_unknown_uid.sql` | A UUID with no `participants` row returns FALSE (fail-closed; not NULL, no exception). | 3 |
| 6 | `is_eligible_null_uid.sql` | 2 assertions: `NULL::uuid` input returns FALSE and is NOT NULL (RLS USING-clause safety). | 3 |
| 7 | `auth_hook_first_login.sql` | 9 assertions across 3 scenarios: (T1) first-login of `freshie@nortal.com` provisions a row + `access.granted` audit; (T2) `outsider2@example.com` is denied with `access.denied`/`domain_not_approved` and no participants row; (T3) re-invoking the hook for the existing `alpha` sub does not duplicate the row. | 3 |
| 8 | `slice-001-api-me-rls.sql` | T030 — 4 `is(...)` assertions. With `participants_self_or_admin_read` (migration 0007), each persona (alpha, bravo) sees exactly their own row through the RLS layer and zero rows for the sibling. Asserts FR-001 / FR-002 at the RLS layer (Constitution Principle II, layer 4). | 4 |
| 9 | `participants_rls_mid_session_deny.sql` | T030 — 3 `is(...)` assertions. With `tournament_config.eligibility.approved_domains` mutated to `[]` mid-transaction, `is_approved_domain(alpha@nortal.com)` returns false, so the policy's USING clause drops alpha's own row from her view. Asserts the mid-session deny safety net at the RLS layer (Clarifications 2026-05-15, Edge Case E-3). | 4 |

### 1b. Playwright tests — `apps/web/tests/playwright/`

Eleven `.spec.ts` files (US1 carried three; US2 adds eight).

| # | File | Purpose | Phase added |
|---|------|---------|-------------|
| 1 | `smoke.spec.ts` | T003 harness probe — landing page loads with the canonical title and the "Sign in" link. Not a US1/US2 acceptance scenario. | 1 |
| 2 | `slice-001-login-approved.spec.ts` | T016 — 3 runnable tests (Scenarios 1, 2, 3a) + 1 `test.fixme` (Scenario 3b, mid-session deactivation, owned by T034). Asserts first-login provisioning, returning-login `last_login_at` advance, and `/api/me` per-request re-verification. | 3 |
| 3 | `slice-001-login-missing-claims.spec.ts` | T017 — 2 runnable tests (missing-email, missing-display_name) + 2 `test.fixme` cases (`email_verified=false` per gap G-2; forged signature per gap G-3). Asserts the `/auth/denied?reason=missing_claims` redirect path and absence of a session/participant row. | 3 |
| 4 | `slice-001-login-denied-domain.spec.ts` | T029 — 1 runnable test (`@us2`). `outsider2@example.com` is rejected at the auth hook; the browser lands on `/auth/denied?reason=domain_not_approved`; no participants row is provisioned; exactly one `audit_log` row with `action='access.denied'`, `source='auth_hook'`, `reason='domain_not_approved'`. Asserts US2 AS-1. | 4 |
| 5 | `slice-001-api-me-401.spec.ts` | T029 — 1 runnable test (`@us2`). Unauthenticated `GET /api/me` returns 401 with `{ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }` and the contract-mandated `Cache-Control: private, max-age=0, must-revalidate` header. Asserts the contract's 401 branch. | 4 |
| 6 | `slice-001-api-me-403-domain-removed.spec.ts` | T029 — 1 runnable test (`@us2`). Service-role helper flips `eligibility.approved_domains` to `[]`, then `GET /api/me` from alpha's session returns 403 with `{ error: { code: 'DOMAIN_NOT_APPROVED', ... } }` and the API guard writes exactly one `audit_log` row with `source='api_guard'`, `reason='domain_not_approved'`. Asserts FR-002 mid-session deny at the API-guard layer. | 4 |
| 7 | `slice-001-api-me-no-leak.spec.ts` | T029 — 1 runnable test (`@us2`). Same setup as row 6; asserts the 403 body contains NO `email`, `display_name`, `id`, `auth_user_id`, `region`, or `created_at` field (Principle V — no PII in error responses). | 4 |
| 8 | `slice-001-callback-denied-domain.spec.ts` | T029 — 1 runnable test (`@us2`). `outsider2@example.com` hits `/auth/callback`; the hook denies; the browser lands on `/auth/denied`; no leftover `sb-*` access-token cookie remains in the browser jar (partial-session cleanup on denial). Asserts US2 AS-2. | 4 |
| 9 | `slice-001-denied-no-leak.spec.ts` | T029 — 1 runnable test (`@us2`, `@edge`). `GET /auth/denied?reason=foo-bar-unknown` returns 200 with the generic denial UI; the rendered HTML does NOT echo the raw query string, an arbitrary email, or any internal log link. Asserts FR-006 / Principle V on the denial page. | 4 |
| 10 | `slice-001-denied-renders-without-session.spec.ts` | T029 — 1 runnable test (`@us2`, `@edge`). Cookieless `GET /auth/denied?reason=domain_not_approved` returns 200, renders the localized denial heading, and offers the "Sign in with a different account" affordance (no session required to render the deny page). | 4 |
| 11 | `slice-001-callback-no-code.spec.ts` | T029 — 1 runnable test (`@us2`, `@edge`). `GET /auth/callback` with neither `?code=` nor `?error=` redirects to `/auth/denied?reason=unknown` rather than 500-ing. Defensive bare-GET branch. | 4 |

### 1c. Playwright test-only helper — `apps/web/tests/playwright/helpers/`

| File | Purpose |
|---|---|
| `service-role.ts` | DEV-ONLY service-role Supabase client + 3 exported helpers used by US2 specs only: `withTemporaryConfig(key, value, fn)` (snapshot/mutate/restore `tournament_config`), `readAuditLog(filter)` (admin-only audit read for assertion), `countParticipantsByEmail(email)` (assert non-provisioning on denial). Carries a `// no-emit` marker at the top of the file as a belt-and-braces signal that this code MUST NEVER be picked up by `next build`. Requires `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` at runtime; the helpers throw a clear error if either is missing. |

### 1d. TypeScript compile

| Command | Purpose |
|---|---|
| `pnpm -F web exec tsc --noEmit` | Project-wide TS strict compile of `apps/web/`. Establishes the cross-slice contract for `lib/types/participant.ts`, `lib/auth/requireEligible.ts` (now extended with the audit-write side-effect under T033), `lib/auth/getCurrentParticipant.ts`, `/api/me` route handler, `/auth/callback`, `/auth/denied`, and `/dashboard`. |

---

## 2. Migration inventory — `supabase/migrations/`

Eleven `.sql` files (US1 carried nine; US2 adds two). All apply in numeric order via `supabase db reset` (which also loads `supabase/seed/slice-001-fixture.sql`).

| # | File | Phase | Summary |
|---|------|-------|---------|
| 0001 | `0001_participants.sql` | 2 | Creates `public.participants` (citext email, generated `domain`, `participation_status` enum {active, deactivated}, UNIQUE on `auth_user_id` and `email`, CHECK constraints, indexes, `set_updated_at` trigger). Locks the cross-slice schema. |
| 0002 | `0002_tournament_config_stub.sql` | 2 | Stubs `public.tournament_config (key, value jsonb, updated_at)` and seeds `eligibility.approved_domains = ["nortal.com"]`. Slice 008 owns the full schema additively. |
| 0003 | `0003_audit_log_stub.sql` | 2 | Stubs `public.audit_log` with the canonical columns (`actor`, `action`, `entity_type`, `entity_id`, `previous_value`, `new_value`, `reason`, `source`, `occurred_at`) + CHECK on `source ∈ {auth_hook, rls, api_guard, ui, trigger}` + retrieval indexes. Locks the canonical shape. |
| 0004 | `0004_is_approved_domain.sql` | 2 | Defines `public.is_approved_domain(p_email text) RETURNS boolean STABLE SECURITY INVOKER`. Takes the FULL email (not a bare domain), extracts the segment internally, fails closed on NULL/empty/missing config (R-007). |
| 0005 | `0005_is_eligible_nortal_participant.sql` | 2 | Defines the LOCKED cross-slice predicate `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE SECURITY INVOKER`. SELECT-EXISTS against `participants` where `auth_user_id=p_uid AND status='active' AND is_approved_domain(email)`. |
| 0006 | `0006_is_admin_stub.sql` | 2 | Stubs `public.is_admin(p_user_id uuid) RETURNS boolean STABLE` returning constant FALSE. Signature LOCKED; Slice 006 will CREATE OR REPLACE the body. |
| 0007 | `0007_participants_rls.sql` | 2 | Enables + FORCEs RLS on `participants`, `audit_log`, `tournament_config`. Authenticated self-or-admin SELECT on participants — the policy's `USING` clause has the **eligibility predicate front-loaded**: `(auth_user_id = auth.uid() AND public.is_eligible_nortal_participant(auth.uid())) OR public.is_admin(auth.uid())`. Self-or-admin SELECT on audit_log. Broad authenticated SELECT on tournament_config. REVOKEs INSERT/UPDATE/DELETE from `authenticated`/`anon`. See D-004 — this front-loading is the substance of why migration 0011 is a no-op. |
| 0008 | `0008_participants_audit_trigger.sql` | 2 | `participants_write_audit()` (SECURITY DEFINER) AFTER INSERT OR UPDATE trigger on `participants`. Emits `participant.created` / `participant.updated` audit rows with `source='trigger'`. Skips no-op UPDATEs via `row(NEW.*) IS DISTINCT FROM row(OLD.*)`. |
| 0009 | `0009_auth_hooks.sql` | 3 | `handle_auth_user_created(event jsonb) RETURNS jsonb` (SECURITY DEFINER). Extracts identity claims (primary path `event->>'user_id'`, fallback `event->'user'->>'id'`); denies on missing claims (`access.denied`/`missing_claims`) or unapproved domain (`access.denied`/`domain_not_approved`); on success INSERTs/UPSERTs `participants` (ON CONFLICT participants_auth_user_id_uk DO UPDATE last_login_at) and writes `access.granted`. EXECUTE granted to `supabase_auth_admin` + `service_role`. `handle_auth_user_signed_in` (T040) lands in this same file later — see D-001. |
| 0010 | `0010_audit_log_api_guard_insert.sql` | 4 | T033 — narrow INSERT carve-out on `audit_log` for the API-guard helper running under the caller's JWT. `GRANT INSERT ON public.audit_log TO authenticated`; CREATE POLICY `audit_log_api_guard_self_insert` admits exactly one row shape via its `WITH CHECK`: `action='access.denied' AND source='api_guard' AND reason IN ('not_eligible','domain_not_approved','participant_not_provisioned') AND actor IS NOT DISTINCT FROM (SELECT id FROM participants WHERE auth_user_id = auth.uid())`. No UPDATE/DELETE policies (append-only). The SECURITY DEFINER writers (auth hook, trigger) continue to bypass RLS by virtue of running as the table owner. |
| 0011 | `0011_participants_rls_eligibility_tighten.sql` | 4 | T034 — **NO-OP MARKER MIGRATION**. `BEGIN; SELECT 1; COMMIT;`. Header comment documents that the tightening T034 was created to perform was already shipped in migration 0007 (predicate front-loaded into `participants_self_or_admin_read.USING`). Slot reserved for sequence gap-free continuity and to keep downstream slice numbering stable. See D-004. |

---

## 3. App-code inventory

| Layer | File | Role |
|---|---|---|
| Types | `apps/web/lib/types/participant.ts` | T015 / T025 — the `Participant` type + `ParticipantMe` 8-field narrowed shape returned by `/api/me`. Cross-slice contract. |
| Auth lib | `apps/web/lib/auth/requireEligible.ts` | T026 / **T033** — server-side guard called by `/api/me` (and any future protected route). Re-fetches the participant row through the user JWT, runs the eligibility predicate, returns a discriminated union. **T033 added the audit-write side-effect**: on every denial branch (`not_eligible`, `domain_not_approved`, `participant_not_provisioned`) the helper INSERTs one `audit_log` row matching migration 0010's `WITH CHECK` shape; INSERT failures are logged but do not break the deny path. |
| Auth lib | `apps/web/lib/auth/getCurrentParticipant.ts` | T026 — lightweight helper used by `/dashboard` and `/api/me` to load the caller's participant row through the user JWT (no service-role). |
| App routes | `apps/web/app/auth/callback/page.tsx` | T026 — OIDC code-exchange landing page. On success, redirects to `/dashboard`. On hook denial (`?error=...`) or bare GET (no code, no error), redirects to `/auth/denied?reason=...`. |
| App routes | `apps/web/app/auth/denied/page.tsx` | **T032 (new in Phase 4)** — the localized denial page. Renders the canonical denial heading, a generic "do not echo user input" message, and a "Sign in with a different account" affordance. Whitelists known `reason` codes (`domain_not_approved`, `missing_claims`, `not_eligible`, `unknown`); arbitrary or unknown reason values render the same generic copy without echoing the query string. Renders without a session. |
| App routes | `apps/web/app/dashboard/page.tsx` | T026 — minimal authenticated landing page; loads the caller's participant row via `getCurrentParticipant` and displays a confirmation. |
| API | `apps/web/app/api/me/route.ts` | T027 / D-003 reconciliation — GET `/api/me`. Pinned to the contract body shape: `{ participant: {...} }` on 200 (8 fields, no `auth_user_id` / `created_at` / `updated_at`); `{ error: { code, message } }` on 401 / 403 / 500. Emits `Cache-Control: private, max-age=0, must-revalidate` on every response (D-003 patch). 403 path goes through `requireEligible`, which writes the API-guard audit row via 0010's carve-out (T033). |

---

## 4. Expected GREEN state (per test)

Inferred from each test body; not observed.

### pgTAP

- `_harness_smoke.sql` → 1/1 passing. pgTAP extension boots; `supabase test db` is wired.
- `is_approved_domain.sql` → 9/9 passing. Case 9 (config row deleted mid-transaction) must NOT raise; it must return FALSE.
- `is_eligible_active_approved.sql` → 1/1 passing. Depends on the fixture row for `alpha` and on migration 0005.
- `is_eligible_deactivated.sql` → 1/1 passing. Depends on the fixture row for `zulu` (status='deactivated').
- `is_eligible_unknown_uid.sql` → 1/1 passing.
- `is_eligible_null_uid.sql` → 2/2 passing. The `isnt(..., NULL::boolean)` assertion is the RLS-safety guard.
- `auth_hook_first_login.sql` → 9/9 passing.
- `slice-001-api-me-rls.sql` → 4/4 passing. Alpha and bravo each see exactly their own row; cross-reads return zero. **GREEN both pre- and post-migration 0011** (see D-004).
- `participants_rls_mid_session_deny.sql` → 3/3 passing. After `withTemporaryConfig` flips `approved_domains` to `[]`, alpha's `SELECT count(*) FROM participants` returns 0. **GREEN both pre- and post-migration 0011** (see D-004).

### Playwright

- `smoke.spec.ts → landing page loads` → PASS.
- `slice-001-login-approved.spec.ts`:
  - Scenario 1 — first-login provisioning. PASS.
  - Scenario 2 — returning login (`last_login_at` advances). PASS.
  - Scenario 3a — happy-path re-verification (two `/api/me` calls). PASS.
  - Scenario 3b — mid-session deactivation. `test.fixme` (still owned by T034; see § 5).
- `slice-001-login-missing-claims.spec.ts`:
  - missing email — PASS.
  - missing display_name — PASS.
  - email_verified=false — `test.fixme` (G-2).
  - forged signature — `test.fixme` (G-3).
- `slice-001-login-denied-domain.spec.ts → outsider denied at hook` — PASS: lands on `/auth/denied?reason=domain_not_approved`; `countParticipantsByEmail('outsider2@example.com')` returns 0; `readAuditLog({ action: 'access.denied', source: 'auth_hook', reason: 'domain_not_approved', since: testStart })` returns exactly one row.
- `slice-001-api-me-401.spec.ts → unauthenticated GET returns 401` — PASS: status 401, body `{ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }`, `Cache-Control: private, max-age=0, must-revalidate`.
- `slice-001-api-me-403-domain-removed.spec.ts → domain removed mid-session` — PASS: status 403, body `{ error: { code: 'DOMAIN_NOT_APPROVED', ... } }`, `readAuditLog({ action: 'access.denied', source: 'api_guard', reason: 'domain_not_approved' })` returns exactly one row for alpha's `participants.id`.
- `slice-001-api-me-no-leak.spec.ts → 403 body has no PII` — PASS: status 403; body JSON does not contain `email`, `display_name`, `id`, `auth_user_id`, `region`, or `created_at`.
- `slice-001-callback-denied-domain.spec.ts → callback denial cleans cookies` — PASS: redirected to `/auth/denied`; no `sb-*` access-token cookies remain in the jar.
- `slice-001-denied-no-leak.spec.ts → arbitrary reason renders generic copy` — PASS: status 200; rendered HTML contains the canonical denial heading and does NOT echo `foo-bar-unknown` or any other raw user input.
- `slice-001-denied-renders-without-session.spec.ts → cookieless denial render` — PASS: status 200; heading + "Sign in with a different account" affordance visible without any session cookie.
- `slice-001-callback-no-code.spec.ts → bare-GET callback redirects` — PASS: redirected to `/auth/denied?reason=unknown`; no 500.

### TypeScript

- `pnpm -F web exec tsc --noEmit` → exits 0. Strict-mode compile of `apps/web/` with no errors.

---

## 5. Verification commands (operator runbook)

Run from the repo root in order, on branch `001-eligibility-login`. Stop on the first non-zero exit.

```powershell
# 1. Bring up the local Supabase stack (Docker required).
supabase start

# 2. Apply every migration (now 11: 0001..0011) + load slice-001 fixtures.
supabase db reset

# 3. Run every pgTAP file (PowerShell).
Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object { supabase test db $_.FullName }
#    bash:
#    for f in supabase/tests/pgtap/*.sql; do supabase test db "$f" || exit 1; done

# 4. TypeScript strict compile.
pnpm -F web exec tsc --noEmit

# 5. Playwright (slice-001 tag filter — covers both @us1 and @us2).
pnpm -F web e2e -- --grep '@slice-001'
```

A passing run produces:
- Step 3: 9 files all `# Result: PASS`. Slice-001 assertion totals: 1 + 9 + 1 + 1 + 1 + 2 + 9 + 4 + 3 = **31 assertions** across slice-001 pgTAP files (excluding the harness probe).
- Step 4: no output, exit 0.
- Step 5: every `@slice-001`-tagged test that is not `test.fixme` passes. Runnable counts: 3 in `slice-001-login-approved`, 2 in `slice-001-login-missing-claims`, plus 8 single-test US2 specs = **13 runnable Playwright tests**. `smoke.spec.ts` is not `@slice-001`-tagged and will be skipped by `--grep`.

---

## 6. Open deferred work blocking a fully observed GREEN

The following items were authored or invoked but their **execution-time verification** was deferred due to Docker being down or to GitHub push not yet having happened.

| Task / case | Why deferred | What still needs running |
|---|---|---|
| T005 | pgTAP harness smoke (`supabase test db supabase/tests/pgtap/_harness_smoke.sql`) — Docker down | Run after `supabase start`; expect `# Result: PASS`. |
| T006 | OIDC stub `supabase start` boot-verification — Docker down | Confirm the OIDC sidecar URL is reachable from `assertOidcStubReachable()`. |
| T007 | CI workflow PR-trigger verification — repo not yet pushed to GitHub | Open a PR after first push; observe `.github/workflows/ci.yml` runs and gates merge. |
| T021 | RED-gate verification for US1 (`red-gate-us1.md`) — Docker down at T021 execution; equivalent confirmation is now the GREEN of the suite under the commands above. | See `red-gate-us1.md`. |
| T031 | RED-gate verification for US2 (`red-gate-us2.md`) — Docker down at T031 execution. Rows 1–8 of that document's inventory expected RED pre-implementation; rows 9–10 expected GREEN-already (D-004). | See `red-gate-us2.md` § Verification commands; the stash-and-test recipe walks through capturing RED then GREEN transcripts. |
| T016 Scenario 3b | `test.fixme` — needs T034 (no-op per D-004) + a service-role helper for flipping `participation_status` from the test runner. The service-role helper now exists (`helpers/service-role.ts`); only the test promotion is outstanding. | Promote `test.fixme` → `test` once Docker is up; use `getServiceClient()` to flip alpha's `participation_status` mid-test. |
| T017 `email_verified=false` | `test.fixme` — gap G-2 in the auth-hook contract (no `email_unverified` reason code). | Update `contracts/auth-hook.sql.md` Decision matrix first; then promote. |
| T017 forged signature | `test.fixme` — gap G-3 in T006's OIDC fixture (no `signWithAlternateKey` flag). | Grow T006's fixture; then promote. |
| **NEW: service-role env var** | The audit-INSERT policy (migration 0010) requires the **service-role test helper** at `apps/web/tests/playwright/helpers/service-role.ts` AND the `SUPABASE_SERVICE_ROLE_KEY` env var at runtime for any US2 Playwright test that reads `audit_log` (rows 6, 7) or mutates `tournament_config` (rows 6, 7). The helper throws a clear error if the env var is missing. | User MUST populate `SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`) in `apps/web/.env.local` (or the Playwright env) before step 5 of the verification commands. Copy the key from `supabase status` output. |

---

## 7. Cross-slice contracts locked by Phases 1–4

Per Constitution Principle XI, these signatures and schemas are now LOCKED. Every downstream slice (002–008) references them. Changing any of these requires coordinating regression tests in every consuming slice. Entries marked **(new in Phase 4)** were added or refined by US2.

| Symbol | Lock |
|---|---|
| `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE SECURITY INVOKER` | Referenced by every slice 002–008 RLS policy via `auth.uid()`. Body changes require sweep across every consuming slice. |
| `public.is_admin(p_user_id uuid) RETURNS boolean STABLE` | Stub returning constant FALSE. Slice 006 owns the body; signature LOCKED. |
| `public.participants(id, auth_user_id, email citext, display_name, domain citext GENERATED, region, status participation_status, first_login_at, last_login_at, created_at, updated_at)` | Every downstream slice FKs to `participants(id)`. The `participation_status` enum is LOCKED to exactly `{active, deactivated}`. |
| `public.audit_log(id, actor, action, entity_type, entity_id, previous_value, new_value, reason, source, occurred_at)` | Canonical column names finalized. Slice 007 may ADD columns additively but MUST NOT alter or drop these. |
| `public.tournament_config(key text PK, value jsonb NOT NULL, updated_at timestamptz)` | Slice 008 will ALTER additively (`value_type`, `updated_by`, `version_id`, RLS, `config_read()` helper). |
| **`audit_log` INSERT carve-out (new in Phase 4)** — policy `audit_log_api_guard_self_insert` on `public.audit_log FOR INSERT TO authenticated WITH CHECK (action='access.denied' AND source='api_guard' AND reason IN ('not_eligible','domain_not_approved','participant_not_provisioned') AND actor IS NOT DISTINCT FROM <caller-participants.id>)` | LOCKED by migration 0010. Slice 007's audit hardening MUST preserve this exact carve-out (or migrate it explicitly), because `requireEligible` depends on it for the 403 audit-row write. The four `WITH CHECK` conjuncts are the entire contract — any future audit-write path that wants to run under the caller's JWT must satisfy them or ship its own carve-out. |
| **`/api/me` response shape (new in Phase 4 — D-003 reconciliation)** — 200: `{ participant: { id, email, display_name, domain, region, status, first_login_at, last_login_at } }`; 401: `{ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }`; 403: `{ error: { code: 'DOMAIN_NOT_APPROVED', message: '...' } }`; 500: `{ error: { code: 'INTERNAL', ... } }`. Every response carries `Cache-Control: private, max-age=0, must-revalidate`. | LOCKED by `apps/web/app/api/me/route.ts` and asserted by 4 of the 11 Playwright specs. |
| **`/auth/denied` page (new in Phase 4)** — `/auth/denied[?reason=<code>]` renders the canonical denial heading and a "Sign in with a different account" affordance. Unknown `reason` values fall back to the generic copy without echoing the query. Renders without a session. | LOCKED by T032 and asserted by 4 of the 8 US2 Playwright specs. |

---

## 8. Spec deviations consolidated

Recorded here so the next maintainer doesn't re-derive them from the tasks.md running log. The full entries live in `specs/001-eligibility-login/tasks.md § Implementation deviations`.

| ID | One-liner | Full entry |
|---|---|---|
| D-001 | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]` (CLI v2.98.2 does not parse the spec's key). T040/T041 implement to the `custom_access_token` signature. | `tasks.md` § Implementation deviations § D-001 |
| D-002 | `is_approved_domain(p_email text)` accepts a FULL email, not a bare domain — the function extracts the domain segment internally. T019 patched post-contract-review. | `tasks.md` § Implementation deviations § D-002 |
| D-003 | `/api/me` body shape reconciled to `contracts/participant-me.read.md`: 200 returns `{ participant: {...} }` (8 narrowed fields), errors return `{ error: { code, message } }`, every response sets `Cache-Control: private, max-age=0, must-revalidate`. | `tasks.md` § Implementation deviations § D-003 |
| D-004 | `participants` RLS tightening already shipped under T012 (migration 0007 embeds the eligibility predicate in `participants_self_or_admin_read.USING`). Migration 0011 is therefore a header-only no-op marker; the predicate-path tightening T034 was created to perform is already live. Both US2 pgTAP files were authored to GREEN against T012's body alone. | `tasks.md` § Implementation deviations § D-004 |

No new deviation (D-005) was reserved by this checkpoint. Phase 4 implementation aligned with the spec text and the locked contracts modulo the four deviations above.

---

## 9. Pre-merge action items (explicit list)

Tick each before opening the slice 001 PR or before starting Phase 5:

- [ ] Start Docker Desktop and wait for it to be healthy.
- [ ] Populate `SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_URL` if not already set) in `apps/web/.env.local` (or the equivalent Playwright env). Copy values from `supabase status` after step 1. Without this, the US2 Playwright tests that call `withTemporaryConfig` / `readAuditLog` will fail with a clear error from `getServiceClient()`.
- [ ] Run `supabase start`.
- [ ] Run `supabase db reset` (loads all 11 migrations + `supabase/seed/slice-001-fixture.sql`).
- [ ] Run the pgTAP loop:
  `Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object { supabase test db $_.FullName }`
  Expect 9 files all `PASS`, 31 slice-001 assertions plus the harness probe.
- [ ] Run `pnpm -F web exec tsc --noEmit`. Expect exit 0 with no output.
- [ ] Run `pnpm -F web e2e -- --grep '@slice-001'`. Expect 13 runnable tests all `passed`, 4 `test.fixme` skipped (and accounted for in § 6).
- [ ] Manually verify the deferred US1 RED-gate items (T005, T006, T007) once Docker is up — see `red-gate-us1.md` and `regression-checkpoint-us1.md` § 5.
- [ ] Manually verify the US2 RED-gate transition per `red-gate-us2.md` § Implementation note (stash GREEN implementation, observe RED for rows 1–8, `git stash pop`, observe GREEN for rows 1–10). Append both transcripts (or CI links) to the slice 001 PR description.
- [ ] Confirm T034's disposition per D-004 in the PR description: migration 0011 ships as a no-op marker; the predicate-path tightening is the responsibility of migration 0007 / T012.

Until every box above is ticked AND every command returns GREEN, Slice 001 does not satisfy Constitution Principle XI for US2 and must not start Phase 5 or merge to `main`.
