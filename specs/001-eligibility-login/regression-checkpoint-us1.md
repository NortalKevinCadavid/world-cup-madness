# Regression checkpoint — Slice 001, Phase 3 (US1)

- **Slice**: `001-eligibility-login`
- **Phase**: 3 (US1 — eligible employee signs in)
- **Date**: 2026-05-19
- **Constitution anchor**: Principle XI (NON-NEGOTIABLE) — "the regression suite shipped so far in this slice must be GREEN before the next user-story phase begins or the slice merges."
- **Owning task**: T028 (`specs/001-eligibility-login/tasks.md` line 1060)
- **Purpose**: Record the state of the slice-001-so-far test suite at the moment US1 lands, inventory every test the user must run, and hand the exact verification commands to the operator who has a working Docker daemon.

---

## Status: DEFERRED

The Docker daemon was DOWN at execution time. `supabase start`, `supabase db reset`, `supabase test db`, and the Playwright run that depends on the local Supabase stack therefore could NOT be executed by the agent that produced this document.

This checkpoint is a **documentation artifact**, not an observation. It enumerates what passing looks like and the exact commands the user MUST run locally (or in CI, once T007 ships) before the slice can be merged or before Phase 4 (US2) begins. Per Principle XI no later phase may start, and the slice may not merge, until the verification commands below have all returned GREEN.

---

## 1. Suite inventory

### 1a. pgTAP tests — `supabase/tests/pgtap/`

Seven `.sql` files. Each file is wrapped in `BEGIN; … ROLLBACK;` so it leaves no residue in the database between runs.

| # | File | Purpose |
|---|------|---------|
| 1 | `_harness_smoke.sql` | Probes that the pgTAP extension loads under `supabase test db`; not a slice-001 assertion (harness boot only). |
| 2 | `is_approved_domain.sql` | 9 assertions covering `public.is_approved_domain(text)`: case-insensitive match, whitespace trim, unapproved domain, empty/NULL input, no suffix expansion (`nortal.co.uk` vs `nortal.com`), and fail-closed when the config row is absent. |
| 3 | `is_eligible_active_approved.sql` | Happy path — fixture row `alpha@nortal.com` (status='active', approved domain) is reported eligible by `public.is_eligible_nortal_participant(uuid)`. |
| 4 | `is_eligible_deactivated.sql` | Fixture row `zulu@nortal.com` (status='deactivated') is reported ineligible despite the approved domain. |
| 5 | `is_eligible_unknown_uid.sql` | A UUID with no `participants` row returns FALSE (fail-closed; not NULL, no exception). |
| 6 | `is_eligible_null_uid.sql` | 2 assertions: `NULL::uuid` input returns FALSE and is NOT NULL (RLS USING-clause safety). |
| 7 | `auth_hook_first_login.sql` | 9 assertions across 3 scenarios: (T1) first-login of `freshie@nortal.com` provisions a row + `access.granted` audit; (T2) `outsider2@example.com` is denied with `access.denied`/`domain_not_approved` and no participants row; (T3) re-invoking the hook for the existing `alpha` sub does not duplicate the row. |

### 1b. Playwright tests — `apps/web/tests/playwright/`

Three `.spec.ts` files.

| # | File | Purpose |
|---|------|---------|
| 1 | `smoke.spec.ts` | T003 harness probe — landing page loads with the canonical title and the "Sign in" link. Not a US1 acceptance scenario. |
| 2 | `slice-001-login-approved.spec.ts` | T016 — 3 runnable tests (Scenarios 1, 2, 3a) + 1 `test.fixme` (Scenario 3b, mid-session deactivation, owned by T034). Asserts first-login provisioning, returning-login `last_login_at` advance, and `/api/me` per-request re-verification. |
| 3 | `slice-001-login-missing-claims.spec.ts` | T017 — 2 runnable tests (missing-email, missing-display_name) + 2 `test.fixme` cases (`email_verified=false` per gap G-2; forged signature per gap G-3). Asserts the `/auth/denied?reason=missing_claims` redirect path and absence of a session/participant row. |

### 1c. TypeScript compile

| Command | Purpose |
|---|---|
| `pnpm -F web exec tsc --noEmit` | Project-wide TS strict compile of `apps/web/`. Establishes the cross-slice contract for `lib/types/participant.ts` and the API/lib helpers shipped by US1 (`requireEligible`, `/api/me` route handler). |

---

## 2. Migration inventory — `supabase/migrations/`

Nine `.sql` files. All apply in numeric order via `supabase db reset` (which also loads `supabase/seed/slice-001-fixture.sql`).

| # | File | Summary |
|---|------|---------|
| 0001 | `0001_participants.sql` | Creates `public.participants` (citext email, generated `domain`, `participation_status` enum {active, deactivated}, UNIQUE on `auth_user_id` and `email`, CHECK constraints, indexes, `set_updated_at` trigger). Locks the cross-slice schema. |
| 0002 | `0002_tournament_config_stub.sql` | Stubs `public.tournament_config (key, value jsonb, updated_at)` and seeds `eligibility.approved_domains = ["nortal.com"]`. Slice 008 owns the full schema additively. |
| 0003 | `0003_audit_log_stub.sql` | Stubs `public.audit_log` with the canonical columns (`actor`, `action`, `entity_type`, `entity_id`, `previous_value`, `new_value`, `reason`, `source`, `occurred_at`) + CHECK on `source ∈ {auth_hook, rls, api_guard, ui, trigger}` + retrieval indexes. Locks the canonical shape. |
| 0004 | `0004_is_approved_domain.sql` | Defines `public.is_approved_domain(p_email text) RETURNS boolean STABLE SECURITY INVOKER`. Takes the FULL email (not a bare domain), extracts the segment internally, fails closed on NULL/empty/missing config (R-007). |
| 0005 | `0005_is_eligible_nortal_participant.sql` | Defines the LOCKED cross-slice predicate `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE SECURITY INVOKER`. SELECT-EXISTS against `participants` where `auth_user_id=p_uid AND status='active' AND is_approved_domain(email)`. |
| 0006 | `0006_is_admin_stub.sql` | Stubs `public.is_admin(p_user_id uuid) RETURNS boolean STABLE` returning constant FALSE. Signature LOCKED; Slice 006 will CREATE OR REPLACE the body. |
| 0007 | `0007_participants_rls.sql` | Enables + FORCEs RLS on `participants`, `audit_log`, `tournament_config`. Authenticated self-or-admin SELECT on participants (with embedded eligibility re-check on every read), self-or-admin SELECT on audit_log, broad authenticated SELECT on tournament_config. REVOKEs INSERT/UPDATE/DELETE from `authenticated`/`anon`. |
| 0008 | `0008_participants_audit_trigger.sql` | `participants_write_audit()` (SECURITY DEFINER) AFTER INSERT OR UPDATE trigger on `participants`. Emits `participant.created` / `participant.updated` audit rows with `source='trigger'`. Skips no-op UPDATEs via `row(NEW.*) IS DISTINCT FROM row(OLD.*)`. |
| 0009 | `0009_auth_hooks.sql` | `handle_auth_user_created(event jsonb) RETURNS jsonb` (SECURITY DEFINER). Extracts identity claims (primary path `event->>'user_id'`, fallback `event->'user'->>'id'`); denies on missing claims (`access.denied`/`missing_claims`) or unapproved domain (`access.denied`/`domain_not_approved`); on success INSERTs/UPSERTs `participants` (ON CONFLICT participants_auth_user_id_uk DO UPDATE last_login_at) and writes `access.granted`. EXECUTE granted to `supabase_auth_admin` + `service_role`. `handle_auth_user_signed_in` (T040) lands in this same file later — see D-001. |

---

## 3. Expected GREEN state (per test)

Inferred from each test body; not observed.

### pgTAP

- `_harness_smoke.sql` → 1/1 passing. pgTAP extension boots; `supabase test db` is wired.
- `is_approved_domain.sql` → 9/9 passing. The Case 9 fail-closed assertion (config row deleted mid-transaction) must NOT raise; it must return FALSE.
- `is_eligible_active_approved.sql` → 1/1 passing. Depends on the fixture row for `alpha` and on migration 0005.
- `is_eligible_deactivated.sql` → 1/1 passing. Depends on the fixture row for `zulu` (status='deactivated').
- `is_eligible_unknown_uid.sql` → 1/1 passing.
- `is_eligible_null_uid.sql` → 2/2 passing. The `isnt(..., NULL::boolean)` assertion is the RLS-safety guard.
- `auth_hook_first_login.sql` → 9/9 passing. T1 stages an `auth.users` row first, invokes the hook, asserts `{decision: continue}` envelope + participants row landed + exactly one `access.granted` audit row scoped by `entity_id`. T2 asserts `{decision: reject}` + zero participants rows + `access.denied`/`domain_not_approved` audit row referencing the attempted email in `new_value`. T3 wraps re-invocation against the existing alpha sub in a SAVEPOINT (swallows `unique_violation`/`raise_exception`) and asserts the count remains 1.

### Playwright

- `smoke.spec.ts → landing page loads` → PASS. Renders `<h1>` "World Cup Madness" + sign-in link.
- `slice-001-login-approved.spec.ts`:
  - Scenario 1 — first-login provisioning. PASS: lands on `/dashboard`, `/api/me` returns 200 with the freshie row (`email`, `display_name`, `domain='nortal.com'`, `status='active'`, `first_login_at` within ±60 s of sign-in start, `last_login_at == first_login_at`), total elapsed ≤ 10 s (SC-002).
  - Scenario 2 — returning login. PASS: same `participants.id` as the fixture; `last_login_at` strictly advances after a 1.1 s wait; `first_login_at` unchanged; `status` still 'active'.
  - Scenario 3a — happy-path re-verification. PASS: two consecutive `/api/me` calls both return 200; second call must also pass the per-request eligibility predicate (FR-002).
  - Scenario 3b — mid-session deactivation. `test.fixme`. Owned by T034.
- `slice-001-login-missing-claims.spec.ts`:
  - missing email — PASS: redirect URL pathname is `/auth/denied`, `?reason=missing_claims`; denial heading is visible; `/api/me` returns 401 or 403 (no session cookie was issued).
  - missing display_name — PASS: same shape as the missing-email test.
  - email_verified=false — `test.fixme` (G-2 — contract has no `email_unverified` reason).
  - forged signature — `test.fixme` (G-3 — OIDC fixture lacks `signWithAlternateKey`).

### TypeScript

- `pnpm -F web exec tsc --noEmit` → exits 0. Strict-mode compile of `apps/web/` with no errors.

---

## 4. Verification commands (operator runbook)

Run from the repo root in order. Stop on the first non-zero exit.

```sh
# 1. Bring up the local Supabase stack (Docker required).
supabase start

# 2. Apply every migration + load slice-001 fixtures.
supabase db reset

# 3. Run every pgTAP file (PowerShell; cmd / bash equivalents below).
#    PowerShell:
Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object { supabase test db $_.FullName }
#    bash:
#    for f in supabase/tests/pgtap/*.sql; do supabase test db "$f" || exit 1; done

# 4. TypeScript strict compile.
pnpm -F web exec tsc --noEmit

# 5. Playwright (slice-001 tag filter).
pnpm -F web e2e -- --grep @slice-001
```

A passing run produces:
- step 3: 7 files, all with `# Result: PASS` / no failing diagnostics; assertion totals 1 + 9 + 1 + 1 + 1 + 2 + 9 = 24 assertions across slice-001 files (excluding the harness probe).
- step 4: no output, exit 0.
- step 5: every `@slice-001` test that is not `test.fixme` passes. Six runnable Playwright tests total across the two slice-001 spec files (3 in `slice-001-login-approved.spec.ts` + 2 runnable in `slice-001-login-missing-claims.spec.ts` + 1 in `smoke.spec.ts` if it carries the tag; `--grep` will skip `smoke.spec.ts` because it does not).

---

## 5. Open deferred work blocking a fully observed GREEN

The following items were authored or invoked but their **execution-time verification** was deferred due to Docker being down or to GitHub push not yet having happened. None of these block the documentation artifact T028 produces — they block the runtime confirmation that this document records as DEFERRED.

| Task | Why deferred | What still needs running |
|---|---|---|
| T005 | pgTAP harness smoke check (`supabase test db supabase/tests/pgtap/_harness_smoke.sql`) — Docker down | Run after `supabase start`; expect `# Result: PASS`. |
| T006 | OIDC stub `supabase start` boot-verification — Docker down | Confirm the OIDC sidecar URL is reachable from `assertOidcStubReachable()`. |
| T007 | CI workflow PR-trigger verification — repo not yet pushed to GitHub | Open a PR after first push; observe `.github/workflows/ci.yml` runs and gates merge. |
| T021 | RED-gate verification (`red-gate-us1.md`) — Docker down at T021 execution | Run T016 + T017 + T018 + T019 + T020 BEFORE shipping the implementations and confirm each one fails for an assertion-level reason, not a syntax error. With T022–T027 already landed this gate is now retrospective; the equivalent confirmation is the GREEN of the same suite under the commands above. |
| T016 Scenario 3b | `test.fixme` — needs T034 (per-request eligibility guard) + a service-role helper for flipping `participation_status` from the test runner | Flip to a live test once T034 ships. |
| T017 `email_verified=false` | `test.fixme` — gap G-2 in the auth-hook contract (no `email_unverified` reason code) | Update `contracts/auth-hook.sql.md` Decision matrix first; then promote. |
| T017 forged signature | `test.fixme` — gap G-3 in T006's OIDC fixture (no `signWithAlternateKey` flag) | Grow T006's fixture; then promote. |
| T017 audit-row assertions | Inline `FIXME(G-4)` comments — `audit_log` is admin-read-only at RLS, so Playwright cannot read it without a service-role helper | Land an admin-context DB helper (or service-role fetch) before promoting to live assertions. |

---

## 6. Cross-slice contracts locked by Phase 1 + 2 + 3

Per Constitution Principle XI, these signatures and schemas are now LOCKED. Every downstream slice (002–008) references them. Changing any of these requires coordinating regression tests in every consuming slice.

| Symbol | Lock |
|---|---|
| `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE SECURITY INVOKER` | Referenced by every slice 002–008 RLS policy via `auth.uid()`. Body changes require sweep across every consuming slice. |
| `public.is_admin(p_user_id uuid) RETURNS boolean STABLE` | Stub returning constant FALSE. Slice 006 owns the body; signature LOCKED. |
| `public.participants(id, auth_user_id, email citext, display_name, domain citext GENERATED, region, status participation_status, first_login_at, last_login_at, created_at, updated_at)` | Every downstream slice FKs to `participants(id)`. The `participation_status` enum is LOCKED to exactly `{active, deactivated}`. |
| `public.audit_log(id, actor, action, entity_type, entity_id, previous_value, new_value, reason, source, occurred_at)` | Canonical column names finalized — `actor` (not `actor_id`), `action` (not `event_type`), `source` (not `origin`), `previous_value`/`new_value` (not `before`/`after`). Slice 007 may ADD columns additively but MUST NOT alter or drop these. |
| `public.tournament_config(key text PK, value jsonb NOT NULL, updated_at timestamptz)` | Slice 008 will ALTER additively (`value_type`, `updated_by`, `version_id`, RLS, `config_read()` helper). |

---

## 7. Spec deviations consolidated

Recorded here so the next maintainer doesn't re-derive them from the tasks.md running log.

| ID | Where recorded | Summary |
|---|---|---|
| D-001 | `tasks.md` § Implementation deviations | Supabase CLI v2.98.2 does not support `[auth.hook.before_user_signed_in]`. Replaced with `[auth.hook.custom_access_token]`. PG function name stays `public.handle_auth_user_signed_in`. T040 must implement to the `custom_access_token` signature (inputs `{user_id, claims, authentication_method}`, returns `{claims}` or `{error}` envelope to deny). T041 expects re-verification on refresh-token issuance, not just full re-login. `contracts/auth-hook.sql.md` to be updated next open. |
| (post-contract-review patch) | `supabase/tests/pgtap/is_approved_domain.sql` header | `public.is_approved_domain` takes a **full email** (`p_email text`), not a bare domain. The function extracts the domain segment internally via `split_part(lower(trim(p_email)), '@', 2)`. T019 was patched post-contract-review to align the test against this signature; migration 0004's body matches. |
| (followed task body over contract) | `apps/web/app/api/me/route.ts` | `/api/me` 200 body returns the raw `Participant` row, not the `{ participant: {...} }` wrapper sketched in `contracts/participant-me.read.md`. The task body for T026 explicitly returns the participant unwrapped. Playwright tests in `slice-001-login-approved.spec.ts` **still expect the wrapped shape** via the local `ParticipantMeResponse` interface — this is a known divergence between contract, route handler, and test file. The user MUST decide one of: (a) update the route to wrap, (b) update the Playwright local interface to drop the wrapper, or (c) amend the contract — before step 5 of the verification commands can pass. |
| (contract gap, not in task body) | `apps/web/app/api/me/route.ts` | No `Cache-Control: private, max-age=0, must-revalidate` header is set on `/api/me` responses, although a sibling task prompt sketched it. The route relies on `export const dynamic = 'force-dynamic'` and `runtime = 'nodejs'` to disable build-time caching. If the cache header is required for FR-002 enforcement at proxies, add it before merge. |
| (event-payload shape) | `supabase/migrations/0009_auth_hooks.sql` | The auth hook accepts BOTH the primary `event->>'user_id'` shape and the fallback `event->'user'->>'id'` shape. The `user_metadata` lookup likewise checks `event->'user_metadata'`, then `event->'user'->'user_metadata'`, then `event->'user'->'raw_user_meta_data'`. Tolerant by design — Supabase Auth payload-shape variants across releases will not require a re-deploy. |
