# Regression checkpoint — Slice 001, Phase 5 (US3)

- **Slice**: `001-eligibility-login`
- **Phase**: 5 (US3 — "Returning user with changed attributes")
- **Date**: 2026-05-19
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T041 (`specs/001-eligibility-login/tasks.md` line 1523)
- **Sibling artifacts**:
  - `specs/001-eligibility-login/regression-checkpoint-us1.md` (T028 — Phase 3 checkpoint; this document inherits its structure)
  - `specs/001-eligibility-login/regression-checkpoint-us2.md` (T035 — Phase 4 checkpoint; this document is its direct successor)
  - `specs/001-eligibility-login/red-gate-us3.md` (T039 — Phase 5 RED gate; this document records the GREEN-side inventory of the same suite, now extended by T040)
- **Purpose**: Record the state of the slice-001-so-far test suite at the moment US3 lands (T036–T040 all merged), inventory every test the user must run, enumerate the migrations and app code that participate, and hand the exact verification commands to the operator who has a working Docker daemon.

---

## Status: DEFERRED

The Docker daemon was DOWN at execution time. `supabase start`, `supabase db reset`, `supabase test db`, and the Playwright run (which boots the local Supabase stack as a fixture) therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like and the exact commands the user MUST run locally (or in CI, once T007 ships) before the slice can be merged. Per Principle XI the slice may not merge until the verification commands at the bottom of this document have all returned GREEN.

Unlike the US1 and US2 checkpoints, this is the **final** regression gate for Slice 001 — no further user-story phase follows US3. Phase 6 (Polish, T042+) is cross-cutting and gated separately. The next event after this checkpoint is the slice PR opening.

---

## 1. Suite inventory

### 1a. pgTAP tests — `supabase/tests/pgtap/`

Eleven `.sql` files (US2 carried nine; US3 adds two — both authored under T037 and T038). Each file is wrapped in `BEGIN; … ROLLBACK;` so it leaves no residue in the database between runs.

| # | File | Purpose | Phase added |
|---|------|---------|-------------|
| 1 | `_harness_smoke.sql` | Probes that the pgTAP extension loads under `supabase test db`; not a slice-001 assertion (harness boot only). | 1 |
| 2 | `is_approved_domain.sql` | 9 assertions covering `public.is_approved_domain(text)`: case-insensitive match, whitespace trim, unapproved domain, empty/NULL input, no suffix expansion (`nortal.co.uk` vs `nortal.com`), and fail-closed when the config row is absent. | 3 |
| 3 | `is_eligible_active_approved.sql` | Happy path — fixture row `alpha@nortal.com` (status='active', approved domain) is reported eligible by `public.is_eligible_nortal_participant(uuid)`. | 3 |
| 4 | `is_eligible_deactivated.sql` | Fixture row `zulu@nortal.com` (status='deactivated') is reported ineligible despite the approved domain. | 3 |
| 5 | `is_eligible_unknown_uid.sql` | A UUID with no `participants` row returns FALSE (fail-closed; not NULL, no exception). | 3 |
| 6 | `is_eligible_null_uid.sql` | 2 assertions: `NULL::uuid` input returns FALSE and is NOT NULL (RLS USING-clause safety). | 3 |
| 7 | `auth_hook_first_login.sql` | 9 assertions across 3 scenarios for `handle_auth_user_created`: (T1) first-login of `freshie@nortal.com` provisions a row + `access.granted` audit; (T2) `outsider2@example.com` is denied with `access.denied`/`domain_not_approved`; (T3) re-invoking the hook for the existing `alpha` sub does not duplicate the row. | 3 |
| 8 | `slice-001-api-me-rls.sql` | T030 — 4 `is(...)` assertions. With `participants_self_or_admin_read` (migration 0007), each persona (alpha, bravo) sees exactly their own row through the RLS layer and zero rows for the sibling. Asserts FR-001 / FR-002 at the RLS layer (Constitution Principle II, layer 4). | 4 |
| 9 | `participants_rls_mid_session_deny.sql` | T030 — 3 `is(...)` assertions. With `tournament_config.eligibility.approved_domains` mutated to `[]` mid-transaction, the policy's USING clause drops alpha's own row from her view. Asserts the mid-session deny safety net at the RLS layer (Clarifications 2026-05-15, Edge Case E-3). | 4 |
| 10 | `auth_hook_returning_login.sql` | T037 — `plan(15)` across 5 scenarios for `handle_auth_user_signed_in`: (S1) happy-path refresh advances `last_login_at` + emits `access.granted`; (S2) display_name + region claim drift triggers the `participant.updated` trigger via the refresh UPDATE; (S3) email-drift detection writes `participant.email_drift` audit row + does NOT mutate `participants.email`; (S4) `deactivated` participant is denied (`{error:{http_code:403}}`) + audit `access.denied`/`deactivated`; (S5) stored email's domain no longer approved → deny + audit `access.denied`/`domain_not_approved`. Asserts the locked `custom_access_token` envelope shape per D-005. | 5 |
| 11 | `auth_hook_fails_closed_on_missing_config.sql` | T038 — `plan(8)` across 3 mixed-function scenarios: (S1) `handle_auth_user_created` with no config row rejects with `{decision:'reject'}` + audits `access.denied`/`domain_not_approved`; (S2) `handle_auth_user_signed_in` with no config row rejects with `{error:{http_code:403}}` + audits same — this is the T040-gated half; (S3) `handle_auth_user_created` against an empty `[]` approved_domains array also rejects. Belt-and-braces for FR-008 (fail-closed). | 5 |

### 1b. Playwright tests — `apps/web/tests/playwright/`

Fifteen `.spec.ts` files (US2 carried eleven; US3 adds four — all authored under T036). Plus the harness smoke (`smoke.spec.ts`, not slice-001-tagged).

| # | File | Purpose | Phase added |
|---|------|---------|-------------|
| 1 | `smoke.spec.ts` | T003 harness probe — landing page loads with the canonical title and the "Sign in" link. Not a US1/US2/US3 acceptance scenario. | 1 |
| 2 | `slice-001-login-approved.spec.ts` | T016 — 3 runnable tests (Scenarios 1, 2, 3a) + 1 `test.fixme` (Scenario 3b, mid-session deactivation — see § 6). Asserts first-login provisioning, returning-login `last_login_at` advance, and `/api/me` per-request re-verification. | 3 |
| 3 | `slice-001-login-missing-claims.spec.ts` | T017 — 2 runnable tests (missing-email, missing-display_name) + 2 `test.fixme` cases (`email_verified=false` per gap G-2; forged signature per gap G-3). Asserts the `/auth/denied?reason=missing_claims` redirect path. | 3 |
| 4 | `slice-001-login-denied-domain.spec.ts` | T029 — 1 runnable test (`@us2`). `outsider2@example.com` is rejected at the auth hook; the browser lands on `/auth/denied?reason=domain_not_approved`; no participants row is provisioned; exactly one `audit_log` row with `action='access.denied'`, `source='auth_hook'`, `reason='domain_not_approved'`. Asserts US2 AS-1. | 4 |
| 5 | `slice-001-api-me-401.spec.ts` | T029 — 1 runnable test (`@us2`). Unauthenticated `GET /api/me` returns 401 with `{ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }` and the contract-mandated `Cache-Control: private, max-age=0, must-revalidate` header. | 4 |
| 6 | `slice-001-api-me-403-domain-removed.spec.ts` | T029 — 1 runnable test (`@us2`). Service-role helper flips `eligibility.approved_domains` to `[]`, then `GET /api/me` from alpha's session returns 403 with `{ error: { code: 'DOMAIN_NOT_APPROVED', ... } }` and the API guard writes exactly one `audit_log` row with `source='api_guard'`, `reason='domain_not_approved'`. Asserts FR-002 mid-session deny at the API-guard layer. | 4 |
| 7 | `slice-001-api-me-no-leak.spec.ts` | T029 — 1 runnable test (`@us2`). Same setup as row 6; asserts the 403 body contains NO `email`, `display_name`, `id`, `auth_user_id`, `region`, or `created_at` field (Principle V — no PII in error responses). | 4 |
| 8 | `slice-001-callback-denied-domain.spec.ts` | T029 — 1 runnable test (`@us2`). `outsider2@example.com` hits `/auth/callback`; the hook denies; the browser lands on `/auth/denied`; no leftover `sb-*` access-token cookie remains in the browser jar. Asserts US2 AS-2. | 4 |
| 9 | `slice-001-denied-no-leak.spec.ts` | T029 — 1 runnable test (`@us2`, `@edge`). `GET /auth/denied?reason=foo-bar-unknown` returns 200 with the generic denial UI; the rendered HTML does NOT echo the raw query string. Asserts FR-006 / Principle V on the denial page. | 4 |
| 10 | `slice-001-denied-renders-without-session.spec.ts` | T029 — 1 runnable test (`@us2`, `@edge`). Cookieless `GET /auth/denied?reason=domain_not_approved` returns 200, renders the localized denial heading, and offers the "Sign in with a different account" affordance. | 4 |
| 11 | `slice-001-callback-no-code.spec.ts` | T029 — 1 runnable test (`@us2`, `@edge`). `GET /auth/callback` with neither `?code=` nor `?error=` redirects to `/auth/denied?reason=unknown` rather than 500-ing. Defensive bare-GET branch. | 4 |
| 12 | `slice-001-returning-login-refresh.spec.ts` | T036 — 1 runnable test (`@us3`). Alpha signs in with IdP-claim drift in `display_name`; the `custom_access_token` hook fires on token issuance; `participants.display_name` refreshes to the new value; `last_login_at` advances; `audit_log` carries exactly one `participant.updated`/`trigger` row (emitted by the T013 trigger on the refresh UPDATE). Asserts US3 AS-1. | 5 |
| 13 | `slice-001-email-drift.spec.ts` | T036 — 1 runnable test (`@us3`). Alpha signs in with a drifted `email` claim; `handle_auth_user_signed_in` detects the drift, writes one `audit_log` row with `action='participant.email_drift'`, `source='auth_hook'`, `previous_value/new_value` set; `participants.email` is NOT mutated. Asserts Clarifications 2026-05-15 Q2. | 5 |
| 14 | `slice-001-domain-removed-mid-session.spec.ts` | T036 — 1 runnable test (`@us3`, `@edge`). Alpha is signed in; the test mutates `eligibility.approved_domains` to `[]` mid-session via `withTemporaryConfig`; on the next token refresh, `handle_auth_user_signed_in` rejects with `{error:{http_code:403}}` AND/OR the `/dashboard` server component's `requireEligible` call redirects to `/auth/denied?reason=domain_not_approved` and writes the `api_guard` audit row. Defense-in-depth at the hook + API-guard + RLS layers (Edge Case E-3 long-running session variant). | 5 |
| 15 | `slice-001-missing-optional-claim.spec.ts` | T036 — 1 runnable test (`@us3`). Alpha signs in WITHOUT a `region` claim (other claims present); `handle_auth_user_signed_in` must treat the missing claim as "no signal" — `participants.region` retains its prior value, NO audit row records a region change. Asserts Clarifications 2026-05-15 Q4. **Caveat**: pre-T040, this spec degenerates to a vacuous PASS (no hook = no writes); post-T040 it becomes a real guard. See § 6. | 5 |

### 1c. Playwright test-only helper — `apps/web/tests/playwright/helpers/`

| File | Purpose |
|---|---|
| `service-role.ts` | DEV-ONLY service-role Supabase client + helpers used by US2 + US3 specs: `withTemporaryConfig(key, value, fn)` (snapshot/mutate/restore `tournament_config`), `readAuditLog(filter)` (admin-only audit read for assertion), `countParticipantsByEmail(email)` (assert non-provisioning on denial). Carries a `// no-emit` marker as a belt-and-braces signal that this code MUST NEVER be picked up by `next build`. Requires `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` at runtime. **Unchanged in Phase 5** — the US3 specs reuse the existing helpers without extension. |

### 1d. TypeScript compile

| Command | Purpose |
|---|---|
| `pnpm -F web exec tsc --noEmit` | Project-wide TS strict compile of `apps/web/`. Establishes the cross-slice contract for `lib/types/participant.ts`, `lib/auth/requireEligible.ts`, `lib/auth/getCurrentParticipant.ts`, `/api/me` route handler, `/auth/callback`, `/auth/denied`, and `/dashboard`. **No new app TS files in Phase 5** — all US3 work landed in PostgreSQL (migration 0009 extension). |

---

## 2. Migration inventory — `supabase/migrations/`

Eleven `.sql` files — **unchanged count from US2**. T040 was implemented by APPENDING `handle_auth_user_signed_in(jsonb)` to the existing `0009_auth_hooks.sql` file rather than creating a new migration. This is the deliberate path documented in T024's slot reservation (`tasks.md` line 217 ff.). All migrations still apply in numeric order via `supabase db reset` (which also loads `supabase/seed/slice-001-fixture.sql`).

| # | File | Phase | Summary |
|---|------|-------|---------|
| 0001 | `0001_participants.sql` | 2 | Creates `public.participants` (citext email, generated `domain`, `participation_status` enum {active, deactivated}, UNIQUE on `auth_user_id` and `email`, CHECK constraints, indexes, `set_updated_at` trigger). Locks the cross-slice schema. |
| 0002 | `0002_tournament_config_stub.sql` | 2 | Stubs `public.tournament_config (key, value jsonb, updated_at)` and seeds `eligibility.approved_domains = ["nortal.com"]`. |
| 0003 | `0003_audit_log_stub.sql` | 2 | Stubs `public.audit_log` with the canonical columns + CHECK on `source ∈ {auth_hook, rls, api_guard, ui, trigger}` + retrieval indexes. Locks the canonical shape. |
| 0004 | `0004_is_approved_domain.sql` | 2 | Defines `public.is_approved_domain(p_email text) RETURNS boolean STABLE SECURITY INVOKER`. Takes the FULL email; fails closed on NULL/empty/missing config. |
| 0005 | `0005_is_eligible_nortal_participant.sql` | 2 | Defines the LOCKED cross-slice predicate `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE SECURITY INVOKER`. |
| 0006 | `0006_is_admin_stub.sql` | 2 | Stubs `public.is_admin(p_user_id uuid) RETURNS boolean STABLE` returning constant FALSE. Signature LOCKED. |
| 0007 | `0007_participants_rls.sql` | 2 | Enables + FORCEs RLS on `participants`, `audit_log`, `tournament_config`. `participants_self_or_admin_read` USING clause has the eligibility predicate front-loaded. See D-004. |
| 0008 | `0008_participants_audit_trigger.sql` | 2 | `participants_write_audit()` AFTER INSERT OR UPDATE trigger on `participants`. Emits `participant.created` / `participant.updated` audit rows with `source='trigger'`. Skips no-op UPDATEs. |
| 0009 | `0009_auth_hooks.sql` | 3 + **5 (T040)** | **EXTENDED IN PHASE 5.** Originally shipped `handle_auth_user_created(event jsonb) RETURNS jsonb` (T024 — `before_user_created` envelope `{decision, message}`; INSERT/UPSERT participants on success; audit `access.granted` / `access.denied`). **T040 appended** `handle_auth_user_signed_in(event jsonb) RETURNS jsonb` (SECURITY DEFINER) — `custom_access_token` envelope (`{claims, ...}` accept; `{error: {http_code, message}}` reject; D-005). Decision matrix: missing user_id → 400; no participants row → delegate to first-login path; status='deactivated' → 403 + `access.denied`/`deactivated`; stored email no longer in approved domains → 403 + `access.denied`/`domain_not_approved`; email-drift detected → continue, write `participant.email_drift` audit (Clarifications Q2 — NEVER mutate stored email); refresh whitelist via COALESCE so a NULL claim leaves the column untouched (Clarifications Q4); success → return `{claims: event->claims}` + audit `access.granted`. EXECUTE granted to `supabase_auth_admin` + `service_role`. The T013 `participants_audit_trigger` emits `participant.updated` automatically on the UPDATE branch; the function does NOT write that row itself (avoid duplicates). |
| 0010 | `0010_audit_log_api_guard_insert.sql` | 4 | T033 — narrow INSERT carve-out on `audit_log` for the API-guard helper. `audit_log_api_guard_self_insert` WITH CHECK pins exactly one row shape (`action='access.denied' AND source='api_guard' AND reason IN (...) AND actor IS NOT DISTINCT FROM <caller participants.id>`). Append-only — no UPDATE/DELETE. |
| 0011 | `0011_participants_rls_eligibility_tighten.sql` | 4 | T034 — **NO-OP MARKER MIGRATION** (`BEGIN; SELECT 1; COMMIT;`). The tightening it was created to perform was already shipped in migration 0007. Slot reserved for sequence gap-free continuity. See D-004. |

**Phase 5 net change to migrations:** 0 new files; 1 file extended (0009). The migration count is intentionally identical to US2's checkpoint because the hook-function implementation belongs in the same file as its sibling (`handle_auth_user_created`) per the original T024 plan-of-record.

---

## 3. App-code inventory

**Unchanged from the US2 checkpoint.** Phase 5 was a pure PostgreSQL phase — no Next.js, `apps/web/lib/`, `apps/web/app/`, or `lib/types/` files were created or modified by T036–T040. The US3 Playwright specs exercise the same `apps/web/app/auth/callback/page.tsx`, `apps/web/app/dashboard/page.tsx`, `apps/web/app/auth/denied/page.tsx`, `apps/web/app/api/me/route.ts`, `apps/web/lib/auth/requireEligible.ts`, and `apps/web/lib/auth/getCurrentParticipant.ts` that US1 and US2 already wired up.

| Layer | File | Role |
|---|---|---|
| Types | `apps/web/lib/types/participant.ts` | T015 / T025 — `Participant` type + `ParticipantMe` 8-field narrowed shape returned by `/api/me`. Cross-slice contract. |
| Auth lib | `apps/web/lib/auth/requireEligible.ts` | T026 / T033 — server-side guard called by `/api/me` (and any future protected route). On every denial branch INSERTs one `audit_log` row matching migration 0010's `WITH CHECK` shape. |
| Auth lib | `apps/web/lib/auth/getCurrentParticipant.ts` | T026 — lightweight helper used by `/dashboard` and `/api/me` to load the caller's participant row through the user JWT. |
| App routes | `apps/web/app/auth/callback/page.tsx` | T026 — OIDC code-exchange landing page. Redirects to `/dashboard` on success; to `/auth/denied?reason=...` on hook denial or bare GET. |
| App routes | `apps/web/app/auth/denied/page.tsx` | T032 — localized denial page. Whitelists known `reason` codes; arbitrary values render the same generic copy without echoing the query string. Renders without a session. |
| App routes | `apps/web/app/dashboard/page.tsx` | T026 — minimal authenticated landing page. |
| API | `apps/web/app/api/me/route.ts` | T027 / D-003 — GET `/api/me`. 200 body shape `{ participant: {...} }` (8 fields); error body `{ error: { code, message } }`; `Cache-Control: private, max-age=0, must-revalidate` on every response. |

---

## 4. Expected GREEN state (per test)

Inferred from each test body; not observed. The **newly-exercised** files for this checkpoint are the four US3 Playwright specs and both US3 pgTAP files. Among these, `auth_hook_returning_login.sql` is the most newly-exercised file post-T040 — it is the dense gate for the function body (5 scenarios × multiple assertions = `plan(15)`) and it was uniformly RED before T040 landed (every call to `public.handle_auth_user_signed_in(...)` aborted with `undefined_function`). Post-T040 it should report 15/15 GREEN.

### pgTAP

- `_harness_smoke.sql` → 1/1 passing. Harness probe.
- `is_approved_domain.sql` → 9/9 passing.
- `is_eligible_active_approved.sql` → 1/1 passing.
- `is_eligible_deactivated.sql` → 1/1 passing.
- `is_eligible_unknown_uid.sql` → 1/1 passing.
- `is_eligible_null_uid.sql` → 2/2 passing.
- `auth_hook_first_login.sql` → 9/9 passing.
- `slice-001-api-me-rls.sql` → 4/4 passing.
- `participants_rls_mid_session_deny.sql` → 3/3 passing.
- **`auth_hook_returning_login.sql` → 15/15 passing** (NEW, most newly-exercised). Scenario 1 success envelope `{claims: ...}` on happy refresh; Scenario 2 trigger-emitted `participant.updated` audit row on display_name/region drift; Scenario 3 `participant.email_drift` audit row + email NOT mutated; Scenarios 4 + 5 reject envelope `{error:{http_code:'403', message:'...'}}` + corresponding `access.denied` audit rows. Per D-005, every "decision" assertion is against the `custom_access_token` envelope (`?'claims'` vs `?'error'`), NOT the `{decision: ...}` shape from `contracts/auth-hook.sql.md`.
- **`auth_hook_fails_closed_on_missing_config.sql` → 8/8 passing** (NEW). S1 (`handle_auth_user_created` + no config) emits `{decision:'reject'}`; S2 (`handle_auth_user_signed_in` + no config) emits `{error:{http_code:'403'}}` AND writes an `access.denied`/`auth_hook` audit row — this was the T040-gated half and is the substance of D-005's mixed assertions in this file; S3 (`handle_auth_user_created` + empty `[]`) emits `{decision:'reject'}`.

Slice-001 pgTAP assertion totals: 9 + 1 + 1 + 1 + 2 + 9 + 4 + 3 + 15 + 8 = **53 assertions** (excluding the harness probe).

### Playwright

US1 + US2 specs (rows 2–11) — unchanged expectations from the US2 checkpoint § 4.

US3 specs (rows 12–15, all `@us3`-tagged):
- `slice-001-returning-login-refresh.spec.ts → @us3 returning login refreshes display_name + last_login_at` — PASS. `participants.display_name` updates to the IdP-drifted value; `participants.last_login_at` strictly increases; `audit_log` carries one `participant.updated`/`trigger` row (emitted by the T013 audit trigger on the UPDATE), and one `access.granted`/`auth_hook` row.
- `slice-001-email-drift.spec.ts → @us3 email drift is logged but not persisted` — PASS. `audit_log` carries one `participant.email_drift`/`auth_hook` row with `previous_value->>'email'='alpha@nortal.com'` and `new_value->>'email'` set to the drifted claim; `participants.email` reads as `alpha@nortal.com` (UNCHANGED).
- `slice-001-domain-removed-mid-session.spec.ts → @us3 @edge approved domains removed mid-session denies refresh` — PASS. After `withTemporaryConfig('eligibility.approved_domains', [], ...)`, the next token issuance is rejected by `handle_auth_user_signed_in` AND the page-server `requireEligible` call on `/dashboard` redirects to `/auth/denied?reason=domain_not_approved`. The `audit_log` carries the corresponding `access.denied`/`auth_hook` row (from the hook reject) and may also carry an `access.denied`/`api_guard` row (from `requireEligible`) — the spec asserts at least one denial row per FR-006.
- `slice-001-missing-optional-claim.spec.ts → @us3 missing region claim treated as no signal` — PASS. `participants.region` retains its prior value `'EE-North'`; the `audit_log` carries an `access.granted`/`auth_hook` row but NO row recording a region change. Note: pre-T040 this spec was vacuously RED-passing (no hook = no writes of any kind); post-T040 it is a real guard because the hook now runs and could-have-emitted a wrong row but doesn't.

### TypeScript

- `pnpm -F web exec tsc --noEmit` → exits 0. Strict-mode compile of `apps/web/` with no errors. No new TS files in Phase 5, so this expectation carries forward unchanged from US2.

---

## 5. Verification commands (operator runbook)

Run from the repo root in order, on branch `001-eligibility-login`. Stop on the first non-zero exit.

```powershell
# 1. Bring up the local Supabase stack (Docker required).
supabase start

# 2. Apply every migration (still 11: 0001..0011 — T040 extended 0009 in place)
#    + load slice-001 fixtures.
supabase db reset

# 3. Run every pgTAP file (PowerShell).
Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object { supabase test db $_.FullName }
#    bash equivalent:
#    for f in supabase/tests/pgtap/*.sql; do supabase test db "$f" || exit 1; done

# 4. TypeScript strict compile.
pnpm -F web exec tsc --noEmit

# 5. Playwright (slice-001 tag filter — covers @us1, @us2, AND @us3).
pnpm -F web e2e -- --grep '@slice-001'
```

A passing run produces:
- Step 2: 11 migrations applied with no error; seed fixtures loaded.
- Step 3: 11 files all `# Result: PASS`. Slice-001 assertion totals: 9 + 1 + 1 + 1 + 2 + 9 + 4 + 3 + 15 + 8 = **53 assertions** across slice-001 pgTAP files (excluding the harness probe).
- Step 4: no output, exit 0.
- Step 5: every `@slice-001`-tagged test that is not `test.fixme` passes. Runnable counts: 3 in `slice-001-login-approved`, 2 in `slice-001-login-missing-claims`, 8 US2 specs, 4 US3 specs = **17 runnable Playwright tests** (4 `test.fixme` skipped: Scenario 3b in `login-approved`, two in `login-missing-claims`, see § 6). `smoke.spec.ts` is not `@slice-001`-tagged and will be skipped by `--grep`.

---

## 6. Open deferred work blocking a fully observed GREEN

| Task / case | Why deferred | What still needs running |
|---|---|---|
| T005 | pgTAP harness smoke (`supabase test db supabase/tests/pgtap/_harness_smoke.sql`) — Docker down | Run after `supabase start`; expect `# Result: PASS`. |
| T006 | OIDC stub `supabase start` boot-verification — Docker down | Confirm the OIDC sidecar URL is reachable from `assertOidcStubReachable()`. |
| T007 | CI workflow PR-trigger verification — repo not yet pushed to GitHub | Open a PR after first push; observe `.github/workflows/ci.yml` runs and gates merge. |
| T021 | RED-gate verification for US1 (`red-gate-us1.md`) — Docker down at T021 execution. | See `red-gate-us1.md`. |
| T031 | RED-gate verification for US2 (`red-gate-us2.md`) — Docker down at T031 execution. | See `red-gate-us2.md` § Verification commands. |
| **T039** (new) | RED-gate verification for US3 (`red-gate-us3.md`) — Docker down at T039 execution. The four US3 Playwright specs + `auth_hook_returning_login.sql` should be uniformly RED pre-T040; `auth_hook_fails_closed_on_missing_config.sql` is mixed per D-005 (S1+S3 GREEN-already, S2 RED). | See `red-gate-us3.md` § Implementation note; the stash-and-test recipe walks through capturing RED then GREEN transcripts. |
| T016 Scenario 3b | `test.fixme` — promotion still outstanding once Docker is up. The service-role helper exists already. | Promote `test.fixme` → `test`; use `getServiceClient()` to flip alpha's `participation_status` mid-test. |
| T017 `email_verified=false` | `test.fixme` — gap G-2 in the auth-hook contract (no `email_unverified` reason code). | Update `contracts/auth-hook.sql.md` Decision matrix first; then promote. |
| T017 forged signature | `test.fixme` — gap G-3 in T006's OIDC fixture (no `signWithAlternateKey` flag). | Grow T006's fixture; then promote. |
| Service-role env var (carry-forward) | The audit-INSERT policy (migration 0010) requires `SUPABASE_SERVICE_ROLE_KEY` at runtime for every Playwright spec that calls `withTemporaryConfig`, `readAuditLog`, or `countParticipantsByEmail` — that's rows 6, 7, 12, 13, 14, 15 of § 1b. | User MUST populate `SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`) in `apps/web/.env.local` before step 5. Copy values from `supabase status` output. |
| **`slice-001-missing-optional-claim.spec.ts` partially vacuous RED** (new, surfaced by T039) | The spec was authored under T036 and the RED gate (T039) noted that pre-T040 the spec would pass *vacuously* (no hook running = no writes of any kind, so all "no region delete" assertions trivially pass). Once T040 ships (now done), the hook runs and could-have-emitted a wrong audit row but doesn't — so the assertions become real guards. | No follow-up code needed; the spec is correct as-authored. The user MUST simply confirm post-T040 GREEN by running step 5 of the verification commands and reading the test output for `@us3 missing region claim treated as no signal`. The pre-T040 vacuous PASS is documented in `red-gate-us3.md` row 4 and is acceptable per Principle IX (the spec is observationally RED on the assertions that count, which is the email-drift sibling spec — see row 13 of § 1b). |

---

## 7. Cross-slice contracts locked by Phases 1–5

Per Constitution Principle XI, these signatures and schemas are now LOCKED. Every downstream slice (002–008) references them. Entries marked **(new in Phase 5)** were added or refined by US3.

| Symbol | Lock |
|---|---|
| `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE SECURITY INVOKER` | Referenced by every slice 002–008 RLS policy via `auth.uid()`. Body changes require sweep across every consuming slice. |
| `public.is_admin(p_user_id uuid) RETURNS boolean STABLE` | Stub returning constant FALSE. Slice 006 owns the body; signature LOCKED. |
| `public.participants(id, auth_user_id, email citext, display_name, domain citext GENERATED, region, status participation_status, first_login_at, last_login_at, created_at, updated_at)` | Every downstream slice FKs to `participants(id)`. The `participation_status` enum is LOCKED to exactly `{active, deactivated}`. |
| `public.audit_log(id, actor, action, entity_type, entity_id, previous_value, new_value, reason, source, occurred_at)` | Canonical column names finalized. Slice 007 may ADD columns additively but MUST NOT alter or drop these. |
| `public.tournament_config(key text PK, value jsonb NOT NULL, updated_at timestamptz)` | Slice 008 will ALTER additively (`value_type`, `updated_by`, `version_id`, RLS, `config_read()` helper). |
| `audit_log` INSERT carve-out — policy `audit_log_api_guard_self_insert` on `public.audit_log FOR INSERT TO authenticated WITH CHECK (action='access.denied' AND source='api_guard' AND reason IN ('not_eligible','domain_not_approved','participant_not_provisioned') AND actor IS NOT DISTINCT FROM <caller-participants.id>)` | LOCKED by migration 0010. Slice 007's audit hardening MUST preserve this exact carve-out. |
| `/api/me` response shape — 200: `{ participant: { id, email, display_name, domain, region, status, first_login_at, last_login_at } }`; 401: `{ error: { code: 'UNAUTHENTICATED', ... } }`; 403: `{ error: { code: 'DOMAIN_NOT_APPROVED', ... } }`; 500: `{ error: { code: 'INTERNAL', ... } }`. Every response carries `Cache-Control: private, max-age=0, must-revalidate`. | LOCKED by `apps/web/app/api/me/route.ts` and asserted by 4 of the slice-001 Playwright specs. |
| `/auth/denied` page — `/auth/denied[?reason=<code>]` renders the canonical denial heading and a "Sign in with a different account" affordance. Unknown `reason` values fall back to the generic copy without echoing the query. Renders without a session. | LOCKED by T032 and asserted by 4 of the US2 Playwright specs. |
| **`public.handle_auth_user_created(event jsonb) RETURNS jsonb` (new in Phase 5 — locked surface)** | Bound to `[auth.hook.before_user_created]`. Return envelope: `{"decision":"continue"}` on accept; `{"decision":"reject","message":"<reason>"}` on reject. Supabase Auth invokes it on every first sign-in. No other slice's RLS calls it — but Supabase Auth's hook binding means the function signature and return shape are external surfaces of Slice 001 and cannot be altered without rotating the Auth configuration. |
| **`public.handle_auth_user_signed_in(event jsonb) RETURNS jsonb` (new in Phase 5 — locked surface)** | Bound to `[auth.hook.custom_access_token]` per D-001. Supabase Auth invokes it on **every token issuance** (initial sign-in + every refresh, per FR-002). Return envelope per D-005: `{"claims": {...}}` on accept; `{"error":{"http_code":403,"message":"<reason>"}}` on reject. No other slice's RLS calls it — but the binding makes the function signature and return shape effectively LOCKED. Slice 006 (admin re-verification) and Slice 008 (config writes that may change approved_domains) both depend on this hook firing correctly on refresh; altering it requires a coordinated bump across those slices. |

---

## 8. Spec deviations consolidated

Recorded here so the next maintainer doesn't re-derive them from the tasks.md running log. The full entries live in `specs/001-eligibility-login/tasks.md § Implementation deviations`.

| ID | One-liner | tasks.md ref |
|---|---|---|
| D-001 | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]` (CLI v2.98.2 does not parse the spec's key). T040 implements `handle_auth_user_signed_in` to the `custom_access_token` signature. | `tasks.md` § Implementation deviations § D-001 (lines 83–91) |
| D-002 | `is_approved_domain(p_email text)` accepts a FULL email, not a bare domain — the function extracts the domain segment internally. | `tasks.md` § D-002 (lines 77–81) |
| D-003 | `/api/me` body shape reconciled to `contracts/participant-me.read.md`: 200 returns `{ participant: {...} }` (8 narrowed fields), errors return `{ error: { code, message } }`, every response sets `Cache-Control: private, max-age=0, must-revalidate`. | `tasks.md` § D-003 (lines 69–75) |
| D-004 | `participants` RLS tightening already shipped under T012 (migration 0007 embeds the eligibility predicate in `participants_self_or_admin_read.USING`). Migration 0011 is therefore a header-only no-op marker. | `tasks.md` § D-004 (lines 58–67) |
| D-005 | `handle_auth_user_signed_in` returns the Supabase `custom_access_token` envelope (`{claims: ...}` accept / `{error: {http_code, message}}` reject), NOT the spec contract's `{decision, message}` envelope. `handle_auth_user_created` retains the `{decision, message}` envelope because `before_user_created` is a distinct hook key with a distinct contract. The two hooks are deliberately asymmetric. | `tasks.md` § D-005 (lines 48–56) |

No new deviation (D-006) was reserved by this checkpoint. Phase 5 implementation aligned with the spec text and the locked contracts modulo the five deviations above.

---

## 9. Pre-merge action items (explicit list)

Tick each before opening the slice 001 PR:

- [ ] Start Docker Desktop and wait for it to be healthy.
- [ ] Populate `SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_URL` if not already set) in `apps/web/.env.local` (or the equivalent Playwright env). Copy values from `supabase status` after step 1. Without this, the US2 + US3 Playwright tests that call `withTemporaryConfig` / `readAuditLog` will fail with a clear error from `getServiceClient()`.
- [ ] Run `supabase start`.
- [ ] Run `supabase db reset` (loads all 11 migrations + `supabase/seed/slice-001-fixture.sql`).
- [ ] **Confirm Supabase Auth picks up `handle_auth_user_signed_in` correctly** — the `[auth.hook.custom_access_token]` block in `supabase/config.toml` must point at `pg-functions://postgres/public/handle_auth_user_signed_in` (or the equivalent project-relative URI) and `supabase status` should NOT report a "hook function not found" error after `db reset`. If the block is missing or wired to the wrong function, US3's behavior is dead in the water — the hook never fires.
- [ ] Run the pgTAP loop:
  `Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object { supabase test db $_.FullName }`
  Expect 11 files all `PASS`, 53 slice-001 assertions plus the harness probe.
- [ ] Run `pnpm -F web exec tsc --noEmit`. Expect exit 0 with no output.
- [ ] Run `pnpm -F web e2e -- --grep '@slice-001'`. Expect 17 runnable tests all `passed`, 4 `test.fixme` skipped (and accounted for in § 6).
- [ ] Manually verify the deferred US1 RED-gate items (T005, T006, T007) once Docker is up — see `red-gate-us1.md` and `regression-checkpoint-us1.md` § 5.
- [ ] Manually verify the US2 RED-gate transition per `red-gate-us2.md` § Implementation note.
- [ ] Manually verify the US3 RED-gate transition per `red-gate-us3.md` § Implementation note (stash T040's body from migration 0009, observe RED for rows 1–5 and S2 of row 6, restore, observe GREEN). Capture both transcripts (or CI links) and reference from the slice 001 PR description.
- [ ] Confirm T034's disposition per D-004 in the PR description: migration 0011 ships as a no-op marker.
- [ ] Confirm T040's envelope per D-005 in the PR description: `handle_auth_user_signed_in` MUST return the `{claims}` / `{error}` shape; returning `{decision: ...}` would be silently ignored by Supabase Auth — a security-critical mismatch.

Until every box above is ticked AND every command returns GREEN, Slice 001 does not satisfy Constitution Principle XI and must not merge to `main`.
