# Quickstart: Eligibility & Login (Slice 001)

**Audience**: A developer or reviewer who wants to run, exercise, and validate this slice locally end-to-end. This is the **foundation** slice — nothing else in the product runs without it; if you can't sign in via this slice, every later slice's tests will fail at setup.

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node | 20+ | Next.js app at `apps/web/` |
| pnpm | 8+ | Package manager (npm/yarn also acceptable) |
| Supabase CLI | 1.150+ | Local Supabase stack (Postgres + Auth + Realtime + Edge Functions) |
| Deno | 1.40+ | Supabase Edge Function runtime (`supabase functions serve`) |
| Playwright | latest | E2E tests (Constitution Principle IX mandates Playwright) |
| pgTAP | bundled with Supabase CLI | SQL unit tests |
| psql | 15+ | Manual DB inspection during dev |

## One-time setup

```bash
# 1. Bring up the local Supabase stack
supabase start

# 2. Apply migrations for this slice
supabase db reset           # rebuilds DB from supabase/migrations/

# 3. Install web app deps
cd apps/web && pnpm install

# 4. Install Playwright browsers (first run only)
pnpm exec playwright install --with-deps

# 5. Configure local OAuth provider stub (see § Auth provider setup below)
cp .env.example .env.local  # supplies SUPABASE_AUTH_OIDC_* env vars for the stub IdP
```

## Auth provider setup (local stub)

For local dev and CI we use a **fake OIDC provider** that signs JWTs with a known keypair so tests can synthesize arbitrary identity payloads (eligible, ineligible, missing-claims, etc.). The fake provider runs as a sidecar Docker container started by `supabase start`.

Production uses **Microsoft Entra ID** (per [research.md § R-001](./research.md#r-001--identity-provider-integration)); the configuration lives in `supabase/config.toml` under `[auth.external.azure]` and is keyed by env vars set per deployment. Switching providers is config-only — no code changes in this slice.

## Seed data

This slice ships a deterministic seed fixture in `supabase/seed/slice-001-fixture.sql`. It creates:

- **3 eligible accounts** with `@nortal.com` emails (`alpha@nortal.com`, `bravo@nortal.com`, `charlie@nortal.com`), pre-provisioned `participants` rows with `status='active'`.
- **1 deactivated account** (`zulu@nortal.com`) with `status='deactivated'` — for the FR-002 returning-but-deactivated path.
- **1 ineligible account** (`outsider@example.com`) — no `participants` row (the auth-hook would reject); the fixture stages a fake auth.users row only so the API-guard path is testable.
- **`tournament_config.eligibility.approved_domains` = `["nortal.com"]`** (the seed default; production is changed by Slice 008 admin UI).

```bash
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-001-fixture.sql
```

The fixture is **safe to re-run**: every INSERT uses `ON CONFLICT DO NOTHING`.

## Run the slice end-to-end

```bash
# Terminal 1 — Supabase stack (Postgres + Auth + Realtime + functions)
supabase start

# Terminal 2 — Next.js app
cd apps/web && pnpm dev   # http://localhost:3000

# Terminal 3 — Open the app and exercise the flows from § Manual verification checklist
```

## Run automated tests

```bash
# Playwright (Constitution Principle IX — these must all pass before any other slice starts)
cd apps/web
pnpm exec playwright test apps/web/tests/playwright/slice-001-*.spec.ts

# pgTAP (SQL-level eligibility + auth-hook + RLS tests)
supabase test db --file supabase/tests/pgtap/is_eligible_active_approved.sql
supabase test db --file supabase/tests/pgtap/is_eligible_deactivated.sql
supabase test db --file supabase/tests/pgtap/is_eligible_unknown_uid.sql
supabase test db --file supabase/tests/pgtap/is_eligible_null_uid.sql
supabase test db --file supabase/tests/pgtap/is_eligible_domain_removed.sql
supabase test db --file supabase/tests/pgtap/is_eligible_config_missing.sql
supabase test db --file supabase/tests/pgtap/is_eligible_rls_applied.sql
supabase test db --file supabase/tests/pgtap/is_eligible_perf.sql
supabase test db --file supabase/tests/pgtap/auth_hook_first_login.sql
supabase test db --file supabase/tests/pgtap/auth_hook_returning_login.sql
supabase test db --file supabase/tests/pgtap/auth_hook_fails_closed_on_missing_config.sql
supabase test db --file supabase/tests/pgtap/slice-001-api-me-rls.sql
```

All of the above MUST be GREEN before `/speckit-implement` for Slice 002 starts (Constitution Principle XI).

## Manual verification checklist

Execute each step in order against a fresh local stack (`supabase db reset && psql -f supabase/seed/slice-001-fixture.sql`). Record pass/fail in `specs/001-eligibility-login/quickstart-verification.md` when this is run as part of `/speckit-implement`.

1. **First-time eligible login (FR-001, FR-003 / US1 Acceptance Scenario 1)**.
   Open `http://localhost:3000`. Click "Sign in". Complete the OIDC stub flow with email `newuser@nortal.com` and display_name `New User`. Expected: redirected to `/dashboard` showing "Welcome, New User". `psql -c "SELECT id, email, display_name, status FROM public.participants WHERE email = 'newuser@nortal.com'"` returns one row with `status='active'`. `psql -c "SELECT action, reason FROM public.audit_log WHERE entity_id = (SELECT id FROM participants WHERE email = 'newuser@nortal.com') ORDER BY occurred_at"` shows `access.granted` and `participant.created`.

2. **Returning eligible login + display-name refresh (FR-004 / US3)**.
   Sign out. Sign back in as `newuser@nortal.com` but in the OIDC stub change display_name to `New User (UPDATED)`. Expected: `/dashboard` shows the new display name. `psql -c "SELECT display_name, first_login_at < last_login_at FROM participants WHERE email = 'newuser@nortal.com'"` shows updated display_name and `last_login_at > first_login_at`. Exactly one `participants` row exists for that email (no duplicate).

3. **Ineligible domain rejected at UI (FR-002 / US2 Acceptance Scenario 1)**.
   Sign out. Sign in as `outsider@example.com` via the OIDC stub. Expected: redirected to `/auth/denied?reason=domain_not_approved`. The denial screen renders the configured message. `psql -c "SELECT count(*) FROM participants WHERE email = 'outsider@example.com'"` returns `0`. `psql -c "SELECT action, reason, source FROM audit_log WHERE new_value->>'email' = 'outsider@example.com' ORDER BY occurred_at DESC LIMIT 1"` returns `access.denied / domain_not_approved / auth_hook`.

4. **Ineligible domain rejected at API (FR-002 / US2 Acceptance Scenario 2)**.
   Synthesize a Supabase JWT for the ineligible `auth.users` row staged by the fixture (`outsider@example.com`). `curl -H "Authorization: Bearer <jwt>" http://localhost:3000/api/me`. Expected: HTTP 403 with body `{"error":{"code":"DOMAIN_NOT_APPROVED", ...}}`. `psql -c "SELECT count(*) FROM audit_log WHERE action='access.denied' AND source='api_guard'"` increments by 1.

5. **Missing claim (Edge case E-1)**.
   Sign in via the OIDC stub with no `email` claim. Expected: redirect to `/auth/denied?reason=missing_claims`. Audit row: `access.denied / missing_claims / auth_hook`.

6. **Mid-tournament domain removal (Edge case E-3 / FR-007)**.
   While `newuser@nortal.com` has an active session (cookies in browser), as admin run `psql -c "UPDATE tournament_config SET value = '[]'::jsonb WHERE key = 'eligibility.approved_domains'"`. Wait ≤ 1 minute (SC-004). Refresh the dashboard. Expected: redirect to `/auth/denied?reason=domain_not_approved`. The `participants` row STILL exists (predictions/audit preserved). Re-run `psql -c "UPDATE tournament_config SET value = '[\"nortal.com\"]'::jsonb WHERE key = 'eligibility.approved_domains'"` and verify the user can sign back in.

7. **Fail-closed on config unavailable (Edge case E-5 / FR-008)**.
   `psql -c "DELETE FROM tournament_config WHERE key = 'eligibility.approved_domains'"`. Attempt to sign in as `alpha@nortal.com`. Expected: redirect to `/auth/denied?reason=config_unavailable` (NOT a 500). Audit row: `access.denied / config_unavailable`. Restore: `psql -c "INSERT INTO tournament_config(key, value) VALUES ('eligibility.approved_domains', '[\"nortal.com\"]'::jsonb)"`.

8. **Email drift (R-010)**.
   Pre-create a participant via fixture for `alpha@nortal.com`. In the OIDC stub, set the email claim to `alpha-newalias@nortal.com` but the `sub` claim to alpha's existing `auth.users.id`. Sign in. Expected: dashboard renders; `participants.email` STILL equals `alpha@nortal.com`; audit row `participant.email_drift` with `previous_value.email='alpha@nortal.com'` and `new_value.email='alpha-newalias@nortal.com'`.

## Definition of Done (for this slice)

- All 8 manual verification steps PASS on a clean local stack.
- All Playwright specs in `apps/web/tests/playwright/slice-001-*.spec.ts` GREEN.
- All pgTAP files listed in § Run automated tests GREEN.
- `is_eligible_nortal_participant(uuid)`, `is_approved_domain(text)`, and the `participants` table shape match this slice's contracts exactly — they are cross-slice locks (Constitution Principle XI).
- `audit_log` rows are written in the same transaction as the action they audit (Constitution Principle V) — verified by killing the auth hook between participant INSERT and audit INSERT and confirming both roll back.
- The slice runs end-to-end without service-role key in any client bundle (`grep -r "service_role" apps/web/` returns nothing).

## Cross-slice handoff

After this slice merges:

- **Slice 002 (Match Catalog)** can start. Its RLS uses `is_eligible_nortal_participant(auth.uid())` directly.
- **Slice 006 (Admin Overrides)** will replace this slice's `is_admin()` stub. Slice 006's first task MUST keep the signature `is_admin(uuid) RETURNS boolean STABLE` so this slice's RLS continues to work.
- **Slice 007 (Audit Trail)** will extend the `audit_log` table this slice stubs. Slice 007 MAY add columns; it MUST NOT alter or drop columns introduced here.
- **Slice 008 (Configuration)** owns the admin UI for `tournament_config.eligibility.approved_domains`. Until Slice 008 ships, the value is changed via psql (see step 6 above).
