# Quickstart end-to-end verification — Slice 002

- **Slice**: `002-match-catalog`
- **Phase**: 6 (Polish)
- **Date**: 2026-05-20
- **Constitution anchor**: Principle X (NON-NEGOTIABLE) — "Vertical Slice Delivery: the quickstart confirms the slice runs end-to-end."
- **Owning task**: T045 (`specs/002-match-catalog/tasks.md` line 1628)
- **Source of truth for steps**: `specs/002-match-catalog/quickstart.md` § Manual verification checklist (lines 119–145, 8 steps).
- **Sibling artifact**: `specs/001-eligibility-login/quickstart-verification.md` — same `Status: DEFERRED` pattern.
- **Purpose**: Record the manual run of every quickstart step against a fresh local stack. Pre-merge gate for Slice 002 per Principle X (slice runs end-to-end) and Principle XI (regression GREEN before merge).

---

## Status: DEFERRED

Docker Desktop AND Deno were both unavailable on the execution host at the time of T045. The Slice 002 quickstart requires:

- The local Supabase stack (`supabase start`) — needs Docker.
- The OIDC stub sidecar from Slice 001 — needs Docker.
- The Next.js dev server (`pnpm -F web dev`) for `/matches` + `/api/matches`.
- The `sync-catalog` Edge Function (`supabase functions serve`) — needs Docker.
- The Deno test runner for `supabase/functions/sync-catalog/tests/` (referenced inline as part of validating the Edge Function before each manual step) — needs Deno.
- Repeated `psql` + `curl` invocations against the local Postgres.

None of these can run while the Docker daemon is unavailable and the Deno toolchain is absent. This document is therefore a **documentation artifact**, not an observation.

All 8 steps below are marked `DEFERRED` with the expected behavior captured inline. The user MUST replace each row's `DEFERRED` with `PASS` (and paste the exact terminal / browser output) before slice 002 can merge. Per the T045 prompt's wording, a `FAIL` on any step means: stop, file a bug task, and pause T045 until the bug is fixed at the source (Edge Function, RLS, `record_match_result`, sync adapter, conflict-quarantine flow, or `/matches` UI).

---

## Prerequisites

Tick each before running step 1:

- [ ] **Docker Desktop running** and healthy. `docker ps` returns 0 with no error.
- [ ] **Deno installed** (`deno --version` ≥ 1.40) — required for `deno test supabase/functions/sync-catalog/tests/` as a smoke check before the manual sync triggers below.
- [ ] **Supabase CLI installed** (`supabase --version` ≥ 1.150).
- [ ] **Node 20+** and **pnpm 8+** on PATH.
- [ ] **`apps/web/.env.local` populated** with (in addition to Slice 001's OIDC env vars `SUPABASE_AUTH_OIDC_ISSUER`, `SUPABASE_AUTH_OIDC_AUDIENCE`, `SUPABASE_AUTH_OIDC_CLIENT_ID`, `SUPABASE_AUTH_OIDC_CLIENT_SECRET`):
  - `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` (copy from `supabase status` "API URL")
  - `SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (copy from `supabase status` "anon key")
  - `SUPABASE_SERVICE_ROLE_KEY` (copy from `supabase status` "service_role key") — required for any privileged psql / function calls in steps 4–8.
  - `SYNC_TRIGGER_SECRET` (the internal-auth header the manual `curl` triggers send; matches the value passed to `supabase secrets set` and `app.sync_trigger_secret` GUC).
- [ ] **One-time GUC configuration for T043's cron schedule** — after `supabase start` succeeds, the operator MUST run once against the local Postgres so `pg_cron` can call the Edge Function with the correct URL and internal-auth header:
  ```sql
  ALTER DATABASE postgres SET app.sync_trigger_url    = 'http://localhost:54321/functions/v1/sync-catalog';
  ALTER DATABASE postgres SET app.sync_trigger_secret = '<the SYNC_TRIGGER_SECRET value>';
  ```
  Without these two GUCs the cron-driven path will 401/connect-refused; the manual `curl` path below still works without them.
- [ ] **`supabase start` succeeds** end-to-end (Postgres + Auth + Realtime + Edge Functions + OIDC stub sidecar from Slice 001 all healthy). Confirm with `supabase status` — every line reports a URL, no line reports "unhealthy".
- [ ] **`SUPABASE_DB_URL`** exported in the current shell (PowerShell: `$env:SUPABASE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"`).
- [ ] **EITHER** `supabase functions serve sync-catalog --env-file apps/web/.env.local` is running in a dedicated terminal (recommended for fast iteration), **OR** `supabase functions deploy sync-catalog` has been run against the local stack (required if the operator wants the `pg_cron`-driven invocation path exercised).
- [ ] **`supabase db reset` succeeds** and both fixtures are loaded (see § Reset commands below).
- [ ] **`pnpm -F web dev` is running** on `http://localhost:3000` in a separate terminal.

Without every box ticked, the steps below are not runnable.

### Reset commands (run before step 1, and again between any two steps that mutate state)

```powershell
# From repo root.
supabase db reset
psql $env:SUPABASE_DB_URL -f supabase/seed/slice-001-fixture.sql
psql $env:SUPABASE_DB_URL -f supabase/seed/slice-002-fixture.sql

# Re-assert the active provider for local dev (idempotent):
psql $env:SUPABASE_DB_URL -c "INSERT INTO tournament_config(key, value) VALUES ('provider.active', '`"stub`"'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"

# Restore the stub fixture file if a prior step mutated it:
git checkout -- supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json
```

Then in additional terminals:

```powershell
# Terminal A — Supabase stack (already running from prerequisites)
supabase status   # sanity check; every service URL present

# Terminal B — Next.js dev server
pnpm -F web dev   # binds http://localhost:3000

# Terminal C — Sync Edge Function
supabase functions serve sync-catalog --env-file apps/web/.env.local
```

---

## Step inventory

Eight steps, all `DEFERRED`. Each row mirrors the corresponding paragraph of `quickstart.md` § Manual verification checklist (lines 123–145).

### Step 1 — Participant sees the catalog (FR-001 / US1.1)

- **Status**: `DEFERRED`
- **Expected behavior**: After signing in via the OIDC stub as `alpha@nortal.com`, navigating to `/matches` renders the 4 seeded matches (M1–M4) with stages (group / r16), team names, kickoff times localized to the browser locale, and statuses (scheduled / in-progress / finished). The API `GET /api/matches` returns exactly 4 matches.
- **Commands** (PowerShell):
  ```powershell
  # 1. Open browser to http://localhost:3000, click "Sign in".
  #    Complete the OIDC stub flow as:
  #      email        = alpha@nortal.com
  #      display_name = Alpha (already in slice-001 fixture)

  # 2. Navigate to http://localhost:3000/matches.
  #    Confirm 4 match cards render with stages, teams, kickoff times,
  #    and statuses (1 finished, 1 in-progress, 2 scheduled per fixture).

  # 3. Capture the session cookie from the browser dev tools (or via
  #    Playwright's storageState file) into $cookie, then:
  curl.exe -H "Cookie: $cookie" http://localhost:3000/api/matches | ConvertFrom-Json | ForEach-Object { $_.matches.Count }
  # Expected: 4

  # 4. Sanity-check the DB row count matches:
  psql $env:SUPABASE_DB_URL -c "SELECT count(*) FROM matches"
  # Expected: 4
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` and paste the exact terminal / browser output, or with `FAIL — <one-line reason>` and stop.

### Step 2 — Late-added fixture appears after sync (US1.3)

- **Status**: `DEFERRED`
- **Expected behavior**: After adding a 5th fixture (M5) to the stub provider's snapshot and re-triggering sync, the response carries `outcome='success'` with `counts.created=1`. The DB now has 5 matches. `GET /api/matches` includes M5.
- **Commands** (PowerShell):
  ```powershell
  # 1. Edit supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json
  #    to add a 5th match (e.g. id "M5", group-stage, both teams already
  #    in the seeded teams table or add them too).

  # 2. Trigger sync with a fresh run_id:
  curl.exe -X POST "http://localhost:54321/functions/v1/sync-catalog" `
    -H "X-Internal-Auth: $env:SYNC_TRIGGER_SECRET" `
    -H "Content-Type: application/json" `
    -d '{"provider":"stub","trigger":"manual","run_id":"00000000-0000-0000-0000-00000000C002"}'
  # Expected JSON: outcome="success", counts.created=1, counts.unchanged=4

  # 3. Confirm DB row count:
  psql $env:SUPABASE_DB_URL -c "SELECT count(*) FROM matches"
  # Expected: 5

  # 4. Confirm M5 is exposed by the API:
  curl.exe -H "Cookie: $cookie" "http://localhost:3000/api/matches" | Select-String -Pattern "M5"
  # Expected: at least one line back
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` and paste output, or `FAIL — <reason>`.

### Step 3 — Locale display (FR-002 / SC-004)

- **Status**: `DEFERRED`
- **Expected behavior**: With browser language `es-ES`, kickoff times on `/matches` render in a Spanish locale format (e.g. `dd/MM/aaaa HH:mm`). The DB column `matches.kickoff_utc` remains a UTC timestamp; the `/api/matches` JSON still carries an ISO-8601 UTC string (locale formatting is client-side only).
- **Commands** (PowerShell):
  ```powershell
  # 1. Set browser language to es-ES (Chrome/Edge: Settings -> Languages -> add Spanish, move to top).
  #    Reload http://localhost:3000/matches.
  #    Confirm kickoff times now display in Spanish locale formatting.

  # 2. Confirm DB column is still UTC:
  psql $env:SUPABASE_DB_URL -c "SELECT id, kickoff_utc FROM matches WHERE id = '00000000-0000-0000-0000-0000000000M1'"
  # Expected: timestamptz returned as UTC (e.g. "2026-06-11 18:00:00+00")

  # 3. Confirm API response is still ISO-8601 UTC:
  curl.exe -H "Cookie: $cookie" "http://localhost:3000/api/matches" | Select-String -Pattern "kickoff_utc"
  # Expected: ISO-8601 string ending in Z (e.g. "2026-06-11T18:00:00Z")
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` / `FAIL`.

### Step 4 — Provider failure → last-known-good served (US3.1 / SC-002)

- **Status**: `DEFERRED`
- **Expected behavior**: With the stub fixture set to `[]`, the sync response is 422 with `outcome='rejected_empty'`. The matches table is UNCHANGED — `GET /api/matches` still returns the prior 4 (or 5, depending on step 2 outcome) matches.
- **Commands** (PowerShell):
  ```powershell
  # 1. Snapshot the current match count:
  $before = psql $env:SUPABASE_DB_URL -t -A -c "SELECT count(*) FROM matches"

  # 2. Overwrite the stub fixture to an empty array:
  Set-Content -Path supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json -Value "[]"

  # 3. Trigger sync:
  curl.exe -i -X POST "http://localhost:54321/functions/v1/sync-catalog" `
    -H "X-Internal-Auth: $env:SYNC_TRIGGER_SECRET" `
    -H "Content-Type: application/json" `
    -d '{"provider":"stub","trigger":"manual","run_id":"00000000-0000-0000-0000-00000000C003"}'
  # Expected: HTTP 422, JSON body outcome="rejected_empty"

  # 4. Confirm matches table is unchanged:
  $after = psql $env:SUPABASE_DB_URL -t -A -c "SELECT count(*) FROM matches"
  Write-Host "Before: $before  After: $after  (expected: equal)"

  # 5. Confirm API still serves last-known-good:
  curl.exe -H "Cookie: $cookie" http://localhost:3000/api/matches | ConvertFrom-Json | ForEach-Object { $_.matches.Count }
  # Expected: equal to $before

  # 6. Restore the fixture for subsequent steps:
  git checkout -- supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` (paste HTTP response + before/after counts) or `FAIL`.

### Step 5 — Sustained outage alert dedup (US3.2 / SC-003)

- **Status**: `DEFERRED`
- **Expected behavior**: With the fixture malformed (so the adapter throws), repeated sync triggers DO NOT emit duplicate `provider.outage_alert_emitted` audit rows — exactly ONE such row is recorded across all triggers within the dedup window. After restoring the fixture and triggering sync, an `audit_log` row with `action='provider.recovered'` is emitted.
- **Commands** (PowerShell):
  ```powershell
  # 1. (Optional) Lower the dedup threshold for the test:
  psql $env:SUPABASE_DB_URL -c "UPDATE tournament_config SET value = '1'::jsonb WHERE key = 'sync.outage_alert_threshold_minutes'"

  # 2. Corrupt the stub fixture so JSON.parse throws:
  Set-Content -Path supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json -Value "{ not valid json"

  # 3. Trigger sync 3 times in rapid succession with distinct run_ids:
  1..3 | ForEach-Object {
    $rid = "00000000-0000-0000-0000-00000000C10$_"
    curl.exe -X POST "http://localhost:54321/functions/v1/sync-catalog" `
      -H "X-Internal-Auth: $env:SYNC_TRIGGER_SECRET" `
      -H "Content-Type: application/json" `
      -d "{`"provider`":`"stub`",`"trigger`":`"manual`",`"run_id`":`"$rid`"}"
  }

  # 4. Wait until first_failure_after_success_at is older than the threshold,
  #    then trigger one more time:
  Start-Sleep -Seconds 70
  curl.exe -X POST "http://localhost:54321/functions/v1/sync-catalog" `
    -H "X-Internal-Auth: $env:SYNC_TRIGGER_SECRET" `
    -H "Content-Type: application/json" `
    -d '{"provider":"stub","trigger":"manual","run_id":"00000000-0000-0000-0000-00000000C105"}'

  # 5. Confirm exactly ONE outage_alert_emitted row exists:
  psql $env:SUPABASE_DB_URL -c "SELECT count(*) FROM audit_log WHERE action='provider.outage_alert_emitted'"
  # Expected: 1

  # 6. Restore the fixture and trigger sync once more:
  git checkout -- supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json
  curl.exe -X POST "http://localhost:54321/functions/v1/sync-catalog" `
    -H "X-Internal-Auth: $env:SYNC_TRIGGER_SECRET" `
    -H "Content-Type: application/json" `
    -d '{"provider":"stub","trigger":"manual","run_id":"00000000-0000-0000-0000-00000000C106"}'

  # 7. Confirm the recovery audit row:
  psql $env:SUPABASE_DB_URL -c "SELECT action, occurred_at FROM audit_log WHERE action='provider.recovered' ORDER BY occurred_at DESC LIMIT 1"
  # Expected: 1 row
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` / `FAIL`. Capture both counts.

### Step 6 — Conflict quarantine (US2 Edge Case / FR-009)

- **Status**: `DEFERRED`
- **Expected behavior**: After mutating one team in an existing fixture row, the sync responds `outcome='conflict_quarantined'`. Exactly one `match_pending_review` row is open (`reviewed_at IS NULL`). The `matches` row is UNCHANGED. The `audit_log` carries one new `action='match.conflict_quarantined'` row.
- **Commands** (PowerShell):
  ```powershell
  # 1. Snapshot the M2 match row's team_a / team_b:
  $before = psql $env:SUPABASE_DB_URL -t -A -c "SELECT team_a_id || ',' || team_b_id FROM matches WHERE id = '00000000-0000-0000-0000-0000000000M2'"

  # 2. Edit wc2026-snapshot.json: for M2, swap one of the two team external IDs
  #    to a different mapped team (e.g. swap Brazil for Germany).

  # 3. Trigger sync:
  curl.exe -X POST "http://localhost:54321/functions/v1/sync-catalog" `
    -H "X-Internal-Auth: $env:SYNC_TRIGGER_SECRET" `
    -H "Content-Type: application/json" `
    -d '{"provider":"stub","trigger":"manual","run_id":"00000000-0000-0000-0000-00000000C201"}'
  # Expected JSON: outcome="conflict_quarantined", counts.quarantined>=1

  # 4. Confirm exactly one open pending-review row:
  psql $env:SUPABASE_DB_URL -c "SELECT count(*) FROM match_pending_review WHERE reviewed_at IS NULL"
  # Expected: 1 (or 2 if step 1's fixture row counts as one already; ensure delta from snapshot is 1)

  # 5. Confirm M2 row is UNCHANGED:
  $after = psql $env:SUPABASE_DB_URL -t -A -c "SELECT team_a_id || ',' || team_b_id FROM matches WHERE id = '00000000-0000-0000-0000-0000000000M2'"
  Write-Host "Before: $before  After: $after  (expected: equal)"

  # 6. Confirm the audit row:
  psql $env:SUPABASE_DB_URL -c "SELECT action, occurred_at FROM audit_log WHERE action='match.conflict_quarantined' ORDER BY occurred_at DESC LIMIT 1"
  # Expected: 1 row

  # 7. Restore the fixture for subsequent steps:
  git checkout -- supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` / `FAIL`.

### Step 7 — Provider swap (FR-005 / SC-005)

- **Status**: `DEFERRED`
- **Expected behavior**: After creating a second stub adapter (`stub2`) with a DIFFERENT internal schema but the same contract-compliant output, flipping `tournament_config.provider.active = "stub2"` and triggering sync, the `matches` table is byte-identical to its prior state. No code change is required outside the new adapter file (validates the `MatchDataProviderAdapter` contract is the only coupling point).
- **Commands** (PowerShell):
  ```powershell
  # 1. Create supabase/functions/_shared/providers/stub2/ with the same
  #    contract surface as stub/ but a deliberately different internal
  #    parsing path. Copy the fixture into stub2/fixtures/.

  # 2. Snapshot the matches table's hashable content:
  $before = psql $env:SUPABASE_DB_URL -t -A -c "SELECT md5(string_agg(id::text || coalesce(stage,'') || coalesce(team_a_id::text,'') || coalesce(team_b_id::text,'') || kickoff_utc::text || status, '|' ORDER BY id)) FROM matches"

  # 3. Flip the active provider:
  psql $env:SUPABASE_DB_URL -c "UPDATE tournament_config SET value = '`"stub2`"'::jsonb WHERE key = 'provider.active'"

  # 4. Trigger sync:
  curl.exe -X POST "http://localhost:54321/functions/v1/sync-catalog" `
    -H "X-Internal-Auth: $env:SYNC_TRIGGER_SECRET" `
    -H "Content-Type: application/json" `
    -d '{"provider":"stub2","trigger":"manual","run_id":"00000000-0000-0000-0000-00000000C301"}'
  # Expected: outcome="success_no_changes" or "success" with counts.created=0, counts.updated=0

  # 5. Confirm the matches table is byte-identical:
  $after = psql $env:SUPABASE_DB_URL -t -A -c "SELECT md5(string_agg(id::text || coalesce(stage,'') || coalesce(team_a_id::text,'') || coalesce(team_b_id::text,'') || kickoff_utc::text || status, '|' ORDER BY id)) FROM matches"
  Write-Host "Before: $before  After: $after  (expected: equal hashes)"

  # 6. Restore the active provider:
  psql $env:SUPABASE_DB_URL -c "UPDATE tournament_config SET value = '`"stub`"'::jsonb WHERE key = 'provider.active'"
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` / `FAIL`. Note that PASS REQUIRES no edits to files outside `supabase/functions/_shared/providers/stub2/` and `tournament_config` — `git status` after the test SHOULD only show the new adapter directory.

### Step 8 — Score-before-kickoff rejection (Edge case)

- **Status**: `DEFERRED`
- **Expected behavior**: Sending a fixture that carries a result for a match still in `status='scheduled'` returns `outcome='conflict_quarantined'`; no `match_results` row is inserted for that match; an alert audit row is recorded.
- **Commands** (PowerShell):
  ```powershell
  # 1. Snapshot the match_results count for a scheduled match (e.g. M1):
  $before = psql $env:SUPABASE_DB_URL -t -A -c "SELECT count(*) FROM match_results WHERE match_id = '00000000-0000-0000-0000-0000000000M1'"
  # Expected: 0

  # 2. Edit wc2026-snapshot.json: for M1 (scheduled), set a result block
  #    (e.g. home_score=2, away_score=1, status still 'scheduled').

  # 3. Trigger sync:
  curl.exe -X POST "http://localhost:54321/functions/v1/sync-catalog" `
    -H "X-Internal-Auth: $env:SYNC_TRIGGER_SECRET" `
    -H "Content-Type: application/json" `
    -d '{"provider":"stub","trigger":"manual","run_id":"00000000-0000-0000-0000-00000000C401"}'
  # Expected: outcome="conflict_quarantined"

  # 4. Confirm no match_results row was inserted for M1:
  $after = psql $env:SUPABASE_DB_URL -t -A -c "SELECT count(*) FROM match_results WHERE match_id = '00000000-0000-0000-0000-0000000000M1'"
  Write-Host "Before: $before  After: $after  (expected: equal, both 0)"

  # 5. Confirm the alert audit row was recorded:
  psql $env:SUPABASE_DB_URL -c "SELECT action, reason FROM audit_log WHERE entity_id = '00000000-0000-0000-0000-0000000000M1' ORDER BY occurred_at DESC LIMIT 1"
  # Expected: a row evidencing the score-before-kickoff rejection
  #           (action="match.conflict_quarantined" or similar guard signature).

  # 6. Restore the fixture for any subsequent runs:
  git checkout -- supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json
  ```
- **Operator records below**: replace `DEFERRED` with `PASS` (paste both `psql` outputs) or `FAIL`.

---

## Overall result

**DEFERRED — 0/8 PASS, 0/8 FAIL, 8/8 DEFERRED.**

Slice 002 cannot merge to `main` while this line still reads "8/8 DEFERRED" — that violates Principle X (slice must run end-to-end against the quickstart) and Principle XI (regression suite GREEN before merge).

---

## Pre-merge directive

Before opening (or merging) the Slice 002 PR:

1. The user MUST install Docker Desktop AND Deno, then complete every box in § Prerequisites (including the one-time `app.sync_trigger_url` / `app.sync_trigger_secret` GUC inserts for T043's cron schedule).
2. The user MUST run all 8 steps in order against a fresh stack, exactly as written in § Step inventory, applying the reset commands between any two steps that mutate fixture state.
3. For each step, the user MUST replace the `Status: DEFERRED` line with `Status: PASS` (and paste the exact terminal / browser output below the row) OR with `Status: FAIL — <one-line reason>`.
4. If ANY step yields `FAIL`:
   - **STOP**. Do not run later steps until the failure is investigated.
   - File a bug task under `specs/002-match-catalog/tasks.md § Implementation deviations` (or as a follow-up issue) referencing the failed step number, the expected behavior, and the observed output.
   - PAUSE this task — T045 stays unchecked-effectively-failed even though the checkbox is marked done by the documentation pass — until the bug is fixed at the source (sync Edge Function, `record_match_result` SP, RLS, conflict-quarantine flow, dedup window, `MatchDataProviderAdapter` contract surface, or `/matches` / `/api/matches` UI) and the step re-runs GREEN.
   - Do NOT edit application code to make a step pass without first cutting a bug task — the quickstart is the user-facing contract per Principle X.
5. Update the § Overall result line to read `PASS — 8/8 PASS, 0/8 FAIL, 0/8 DEFERRED` and link this file from the Slice 002 PR description alongside `regression-final.md` (T046).
6. Until both this file's overall result is `PASS — 8/8` AND `regression-final.md` (T046) is GREEN, Slice 002 does not satisfy Constitution Principle X + Principle XI and must not merge.
