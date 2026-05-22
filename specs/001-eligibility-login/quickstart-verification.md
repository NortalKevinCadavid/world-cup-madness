# Quickstart end-to-end verification — Slice 001

- **Slice**: `001-eligibility-login`
- **Phase**: 6 (Polish)
- **Date**: 2026-05-19
- **Constitution anchor**: Principle X (NON-NEGOTIABLE) — "Vertical Slice Delivery: the quickstart confirms the slice runs end-to-end."
- **Owning task**: T044 (`specs/001-eligibility-login/tasks.md` line 1609)
- **Source of truth for steps**: `specs/001-eligibility-login/quickstart.md` § Manual verification checklist (lines 93–119, 8 steps).
- **Sibling artifact**: `specs/001-eligibility-login/regression-checkpoint-us3.md` — same `Status: DEFERRED` pattern and verification-commands template.
- **Purpose**: Record the manual run of every quickstart step against a fresh local stack. Pre-merge gate for Slice 001 per Principle X (slice runs end-to-end) and Principle XI (regression GREEN before merge).

---

## Status: DEFERRED

Docker Desktop was DOWN at execution time. The quickstart's manual verification requires the local Supabase stack (`supabase start`), the OIDC stub sidecar container, the Next.js dev server, and per-step `psql` / `curl` invocations against the local Postgres — none of which can run while the Docker daemon is unavailable. This document is therefore a **documentation artifact**, not an observation.

All 8 steps below are marked `DEFERRED` with the expected behavior captured inline. The user MUST replace each row's `DEFERRED` with `PASS` (and paste the exact terminal / browser output) before slice 001 can merge. Per the task's "Do NOT edit code to make a step pass" directive, a `FAIL` on any step means: stop, file a bug task, and pause T044 until the bug is fixed at the source (auth hook, RLS, API guard, or denial page).

---

## Prerequisites

Tick each before running step 1:

- [ ] **Docker Desktop running** and healthy. `docker ps` returns 0 with no error.
- [ ] **Supabase CLI installed** (`supabase --version` ≥ 1.150).
- [ ] **Node 20+** and **pnpm 8+** on PATH.
- [ ] **`apps/web/.env.local` populated** with the keys T006 declared in `apps/web/.env.example`:
  - `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` (copy from `supabase status` "API URL")
  - `SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (copy from `supabase status` "anon key")
  - `SUPABASE_SERVICE_ROLE_KEY` (copy from `supabase status` "service_role key") — required for step 6's `withTemporaryConfig` workflow and for synthesising the step 4 JWT
  - `SUPABASE_AUTH_OIDC_ISSUER`, `SUPABASE_AUTH_OIDC_AUDIENCE`, `SUPABASE_AUTH_OIDC_CLIENT_ID`, `SUPABASE_AUTH_OIDC_CLIENT_SECRET` (the OIDC-stub variables declared by T006 / T008)
- [ ] **`supabase start` succeeds** end-to-end (Postgres + Auth + Realtime + Edge Functions + OIDC stub sidecar all healthy). Confirm with `supabase status` — every line reports a URL, no line reports "unhealthy".
- [ ] **`SUPABASE_DB_URL`** exported in the current shell (PowerShell: `$env:SUPABASE_DB_URL = (supabase status --output env | Select-String 'DB_URL' | …)` — easiest is to read it from `supabase status` output and `$env:SUPABASE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"`).
- [ ] **`supabase db reset` succeeds** and the seed fixture is loaded (see § Reset commands below).
- [ ] **`pnpm -F web dev` is running** on `http://localhost:3000` in a separate terminal.

Without every box ticked, the steps below are not runnable.

### Reset commands (run before step 1, and again between any two steps that mutate state)

```powershell
# From repo root.
supabase db reset
psql $env:SUPABASE_DB_URL -f supabase/seed/slice-001-fixture.sql
```

Then in two more terminals:

```powershell
# Terminal A — Supabase stack (already running from prerequisites)
supabase status   # sanity check; every service URL present

# Terminal B — Next.js dev server
pnpm -F web dev   # binds http://localhost:3000
```

---

## Step inventory

Eight steps, all `DEFERRED`. Each row mirrors the corresponding paragraph of `quickstart.md` § Manual verification checklist (lines 97–119).

### Step 1 — First-time eligible login (FR-001, FR-003 / US1 AS-1)

- **Status**: `DEFERRED`
- **Expected behavior**: Browser lands on `/dashboard` showing "Welcome, New User". One `participants` row for `newuser@nortal.com` with `status='active'`. Two audit rows for that participant: `access.granted` and `participant.created`.
- **Commands** (PowerShell):
  ```powershell
  # 1. Open browser to http://localhost:3000, click "Sign in".
  #    Complete the OIDC stub flow:
  #      email        = newuser@nortal.com
  #      display_name = New User
  # 2. Confirm /dashboard renders "Welcome, New User".

  # 3. Confirm participants row:
  psql $env:SUPABASE_DB_URL -c "SELECT id, email, display_name, status FROM public.participants WHERE email = 'newuser@nortal.com'"

  # 4. Confirm audit trail:
  psql $env:SUPABASE_DB_URL -c "SELECT action, reason FROM public.audit_log WHERE entity_id = (SELECT id FROM participants WHERE email = 'newuser@nortal.com') ORDER BY occurred_at"
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` and paste the exact `psql` output, or with `FAIL — <one-line reason>` and stop.

### Step 2 — Returning eligible login + display-name refresh (FR-004 / US3)

- **Status**: `DEFERRED`
- **Expected behavior**: `/dashboard` shows "Welcome, New User (UPDATED)". `participants.display_name` updates to the new value; `last_login_at > first_login_at`; exactly one `participants` row for that email (no duplicate).
- **Commands** (PowerShell):
  ```powershell
  # 1. Click "Sign out" in the dashboard.
  # 2. Click "Sign in", complete the OIDC stub flow:
  #      email        = newuser@nortal.com  (unchanged)
  #      display_name = New User (UPDATED)

  # 3. Confirm refresh:
  psql $env:SUPABASE_DB_URL -c "SELECT display_name, first_login_at < last_login_at AS last_after_first FROM participants WHERE email = 'newuser@nortal.com'"

  # 4. Confirm no duplicate provisioning:
  psql $env:SUPABASE_DB_URL -c "SELECT count(*) FROM participants WHERE email = 'newuser@nortal.com'"
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` and paste output, or `FAIL — <reason>`.

### Step 3 — Ineligible domain rejected at UI (FR-002 / US2 AS-1)

- **Status**: `DEFERRED`
- **Expected behavior**: Browser lands on `/auth/denied?reason=domain_not_approved`. Denial screen renders the configured generic message (no PII echo). `participants` count for `outsider@example.com` is 0. One audit row with `action='access.denied'`, `reason='domain_not_approved'`, `source='auth_hook'`.
- **Commands** (PowerShell):
  ```powershell
  # 1. Sign out. Sign in via the OIDC stub with email = outsider@example.com.

  # 2. Confirm no participants row was created:
  psql $env:SUPABASE_DB_URL -c "SELECT count(*) FROM participants WHERE email = 'outsider@example.com'"

  # 3. Confirm the denial audit row:
  psql $env:SUPABASE_DB_URL -c "SELECT action, reason, source FROM audit_log WHERE new_value->>'email' = 'outsider@example.com' ORDER BY occurred_at DESC LIMIT 1"
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` / `FAIL`.

### Step 4 — Ineligible domain rejected at API (FR-002 / US2 AS-2)

- **Status**: `DEFERRED`
- **Expected behavior**: `curl` returns HTTP 403 with body `{"error":{"code":"DOMAIN_NOT_APPROVED", ...}}` and `Cache-Control: private, max-age=0, must-revalidate`. The `audit_log` count of `access.denied` + `source='api_guard'` rows increments by exactly 1.
- **Commands** (PowerShell):
  ```powershell
  # 1. Synthesize a Supabase JWT for the staged outsider@example.com auth.users row.
  #    Easiest path: use a small Deno / Node script signed with the local JWT secret
  #    (visible in `supabase status` as "JWT secret"). Capture the JWT in $jwt.

  # 2. Capture the baseline api_guard denial count:
  $before = psql $env:SUPABASE_DB_URL -t -A -c "SELECT count(*) FROM audit_log WHERE action='access.denied' AND source='api_guard'"

  # 3. Call /api/me with the JWT:
  curl.exe -i -H "Authorization: Bearer $jwt" http://localhost:3000/api/me

  # 4. Confirm api_guard denial count incremented by exactly 1:
  $after  = psql $env:SUPABASE_DB_URL -t -A -c "SELECT count(*) FROM audit_log WHERE action='access.denied' AND source='api_guard'"
  Write-Host "Before: $before  After: $after  (expected: After = Before + 1)"
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` (paste the full HTTP response and the before/after counts) or `FAIL`.

### Step 5 — Missing claim (Edge case E-1)

- **Status**: `DEFERRED`
- **Expected behavior**: Browser lands on `/auth/denied?reason=missing_claims`. One audit row: `action='access.denied'`, `reason='missing_claims'`, `source='auth_hook'`.
- **Commands** (PowerShell):
  ```powershell
  # 1. Sign out. Sign in via the OIDC stub with NO email claim set
  #    (the stub UI's "Custom claims" panel lets you omit fields per T006).

  # 2. Confirm the missing-claims audit row:
  psql $env:SUPABASE_DB_URL -c "SELECT action, reason, source FROM audit_log WHERE action='access.denied' AND reason='missing_claims' ORDER BY occurred_at DESC LIMIT 1"
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` / `FAIL`.

### Step 6 — Mid-tournament domain removal (Edge case E-3 / FR-007)

- **Status**: `DEFERRED`
- **Expected behavior**: Within ≤ 1 minute of clearing the approved-domains config (SC-004), `/dashboard` refresh redirects to `/auth/denied?reason=domain_not_approved`. The participant row is **preserved** (predictions/audit not destroyed). After restoring the config, the same user can sign back in successfully.
- **Commands** (PowerShell):
  ```powershell
  # Pre-condition: newuser@nortal.com has an active session (from steps 1+2).

  # 1. As admin, clear the approved-domains config:
  psql $env:SUPABASE_DB_URL -c "UPDATE tournament_config SET value = '[]'::jsonb WHERE key = 'eligibility.approved_domains'"

  # 2. Wait <= 1 minute (SC-004). Refresh /dashboard in the browser.
  #    Expected: redirect to /auth/denied?reason=domain_not_approved.

  # 3. Confirm participants row is PRESERVED (not deleted):
  psql $env:SUPABASE_DB_URL -c "SELECT id, email, status FROM participants WHERE email = 'newuser@nortal.com'"

  # 4. Restore the approved-domains config:
  psql $env:SUPABASE_DB_URL -c "UPDATE tournament_config SET value = '[\"nortal.com\"]'::jsonb WHERE key = 'eligibility.approved_domains'"

  # 5. Sign in again as newuser@nortal.com via the OIDC stub.
  #    Expected: /dashboard renders normally.
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` / `FAIL`. Capture the elapsed time between step 1 and the dashboard's redirect — it MUST be ≤ 60s per SC-004.

### Step 7 — Fail-closed on config unavailable (Edge case E-5 / FR-008)

- **Status**: `DEFERRED`
- **Expected behavior**: Browser lands on `/auth/denied?reason=config_unavailable` (NOT a 500 / "Application error" page). One audit row: `action='access.denied'`, `reason='config_unavailable'`. After restoring the config row, the same flow succeeds.
- **Commands** (PowerShell):
  ```powershell
  # 1. Delete the approved-domains config row entirely:
  psql $env:SUPABASE_DB_URL -c "DELETE FROM tournament_config WHERE key = 'eligibility.approved_domains'"

  # 2. Sign in as alpha@nortal.com via the OIDC stub.
  #    Expected: redirect to /auth/denied?reason=config_unavailable
  #    (NOT a 500 page — the hook fails closed, not loud).

  # 3. Confirm the config_unavailable audit row:
  psql $env:SUPABASE_DB_URL -c "SELECT action, reason, source FROM audit_log WHERE reason='config_unavailable' ORDER BY occurred_at DESC LIMIT 1"

  # 4. Restore the config row:
  psql $env:SUPABASE_DB_URL -c "INSERT INTO tournament_config(key, value) VALUES ('eligibility.approved_domains', '[\"nortal.com\"]'::jsonb)"

  # 5. Sign in as alpha@nortal.com again — expect successful /dashboard render.
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` / `FAIL`. If step 2 yields a 500 page, that is a FAIL — file a bug against the auth hook's exception handling.

### Step 8 — Email drift (R-010)

- **Status**: `DEFERRED`
- **Expected behavior**: `/dashboard` renders normally. `participants.email` for alpha is UNCHANGED (`alpha@nortal.com`). Exactly one new audit row with `action='participant.email_drift'`, `previous_value->>'email'='alpha@nortal.com'`, `new_value->>'email'='alpha-newalias@nortal.com'`, `source='auth_hook'`.
- **Commands** (PowerShell):
  ```powershell
  # Pre-condition: the slice-001 fixture has already seeded alpha@nortal.com.

  # 1. In the OIDC stub, sign in with:
  #      sub   = <alpha's existing auth.users.id, copied from the stub or psql>
  #      email = alpha-newalias@nortal.com
  #    (Look up alpha's sub via:
  #      psql $env:SUPABASE_DB_URL -c "SELECT id FROM auth.users WHERE email = 'alpha@nortal.com'"
  #    )

  # 2. Confirm /dashboard renders.

  # 3. Confirm participants.email was NOT mutated:
  psql $env:SUPABASE_DB_URL -c "SELECT email FROM participants WHERE id = (SELECT id FROM participants WHERE email = 'alpha@nortal.com')"

  # 4. Confirm the email_drift audit row:
  psql $env:SUPABASE_DB_URL -c "SELECT action, source, previous_value->>'email' AS prev, new_value->>'email' AS next FROM audit_log WHERE action='participant.email_drift' ORDER BY occurred_at DESC LIMIT 1"
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` (paste both `psql` outputs) or `FAIL`.

---

## Overall result

**DEFERRED — 0/8 PASS, 0/8 FAIL, 8/8 DEFERRED.**

Slice 001 cannot merge to `main` while this line still reads "8/8 DEFERRED" — that violates Principle X (slice must run end-to-end against the quickstart) and Principle XI (regression suite GREEN before merge).

---

## Pre-merge directive

Before opening (or merging) the Slice 001 PR:

1. The user MUST start Docker Desktop and complete every box in § Prerequisites.
2. The user MUST run all 8 steps in order against a fresh stack, exactly as written in § Step inventory.
3. For each step, the user MUST replace the `Status: DEFERRED` line with `Status: PASS` (and paste the exact terminal / browser output below the row) OR with `Status: FAIL — <one-line reason>`.
4. If ANY step yields `FAIL`:
   - **STOP**. Do not run later steps until the failure is investigated.
   - File a bug task under `specs/001-eligibility-login/tasks.md § Implementation deviations` (or as a follow-up issue) referencing the failed step number, the expected behavior, and the observed output.
   - PAUSE this task — T044 stays unchecked-effectively-failed even though the checkbox is marked done by the documentation pass — until the bug is fixed at the source (auth hook body, RLS policy, API guard, or denial page) and the step re-runs GREEN.
   - Do NOT edit application code to make a step pass without first cutting a bug task — the quickstart is the user-facing contract per the T044 prompt's "Do NOT edit code to make a step pass" directive.
5. Update the § Overall result line to read `PASS — 8/8 PASS, 0/8 FAIL, 0/8 DEFERRED` and link this file from the Slice 001 PR description alongside `regression-checkpoint-us3.md` and `regression-final.md` (T045).
6. Until both this file's overall result is `PASS — 8/8` AND `regression-final.md` (T045) is GREEN, Slice 001 does not satisfy Constitution Principle X + Principle XI and must not merge.
