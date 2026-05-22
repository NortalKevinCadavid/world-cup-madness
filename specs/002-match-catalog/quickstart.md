# Quickstart: Match Catalog & Provider Sync (Slice 002)

**Audience**: A developer or reviewer who wants to run, exercise, and validate this slice locally end-to-end. **Assumes Slice 001 is already running** locally (the `participants` table, `is_eligible_nortal_participant` function, auth-hook + OIDC stub are all live).

## Prerequisites

Inherited from Slice 001 (Node, pnpm, Supabase CLI, Deno, Docker, Playwright, pgTAP, psql, OIDC stub sidecar). One additional environment variable for this slice:

| Env var | Purpose | Where set |
|---|---|---|
| `FOOTBALLDATA_API_TOKEN` | Real-provider API token for football-data.org (production only) | `supabase secrets set FOOTBALLDATA_API_TOKEN=...` |
| `SYNC_TRIGGER_SECRET` | Internal-auth header value used by `pg_cron` to call the Edge Function | `supabase secrets set SYNC_TRIGGER_SECRET=...` AND `supabase/config.toml [db.settings] app.sync_trigger_secret = "<same>"` |

For local dev, the slice ships a **stub provider** under `supabase/functions/_shared/providers/stub/` that returns canned fixtures from a JSON fixture file — no real API token needed. Production swaps to `footballdata` via `tournament_config.provider.active`.

## One-time setup (additive over Slice 001)

```bash
# 1. Ensure Slice 001 is up
supabase start && supabase db reset

# 2. Apply Slice 001 + Slice 002 migrations
supabase db reset           # rebuilds DB from supabase/migrations/

# 3. Load Slice 001 fixture (creates eligible participants)
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-001-fixture.sql

# 4. Load Slice 002 fixture (creates teams + a few matches against the stub provider's IDs)
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-002-fixture.sql

# 5. Configure the stub provider as the active provider for local dev
psql "$SUPABASE_DB_URL" -c "
  INSERT INTO tournament_config(key, value) VALUES
    ('provider.active', '\"stub\"'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
"

# 6. Set the SYNC_TRIGGER_SECRET locally
supabase secrets set SYNC_TRIGGER_SECRET=local-dev-secret-do-not-use-in-prod

# 7. Start the sync-catalog Edge Function
supabase functions serve sync-catalog --env-file .env.local &
```

## Seed data

This slice ships `supabase/seed/slice-002-fixture.sql` with:

- 8 teams covering the matches in the fixture (Argentina, Brazil, France, Germany, USA, Mexico, Canada, Japan — chosen for variety; production sync will populate the full set of 32).
- 4 matches: 2 group-stage scheduled, 1 group-stage in-progress, 1 r16 finished (with a `match_results` row in `regulation` result_status). Stable UUIDs (`00000000-0000-0000-0000-0000000000M1`…`M4`) so tests reference them directly.
- 1 `match_pending_review` open conflict row (used by Slice 006-preview tests).
- Stub-provider mapping rows in `match_provider_external_ids` so the stub adapter's fixture file matches.

The stub-provider fixture file is at `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json` — editing it lets test-authoring tasks craft specific sync scenarios (empty payload, duplicate, conflict, etc.) without touching live providers.

```bash
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-002-fixture.sql
```

The fixture is **safe to re-run** (every INSERT uses `ON CONFLICT DO NOTHING`).

## Run the slice end-to-end

```bash
# Terminal 1 — Supabase stack
supabase start

# Terminal 2 — Next.js app (serves /api/matches; uses Slice 001's session)
cd apps/web && pnpm dev      # http://localhost:3000

# Terminal 3 — Sync Edge Function
supabase functions serve sync-catalog --env-file .env.local

# Terminal 4 — Trigger a sync manually (no need to wait for pg_cron during dev)
curl -X POST "http://localhost:54321/functions/v1/sync-catalog" \
  -H "X-Internal-Auth: local-dev-secret-do-not-use-in-prod" \
  -H "Content-Type: application/json" \
  -d '{"provider":"stub","trigger":"cron","run_id":"00000000-0000-0000-0000-00000000C001"}'
```

Expected response:

```jsonc
{
  "run_id": "00000000-0000-0000-0000-00000000C001",
  "provider": "stub",
  "outcome": "success_no_changes",                  // fixture already matches stub data
  "counts": { "created": 0, "updated": 0, "unchanged": 4, "rejected": 0, "quarantined": 0 },
  "started_at":  "2026-05-15T20:00:00Z",
  "finished_at": "2026-05-15T20:00:01Z",
  "attempts": 1
}
```

## Run automated tests

```bash
# Playwright (UI + API + locale display)
cd apps/web
pnpm exec playwright test apps/web/tests/playwright/slice-002-*.spec.ts

# pgTAP (SQL-level catalog + RLS + record_match_result)
supabase test db --file supabase/tests/pgtap/record_match_result_happy.sql
supabase test db --file supabase/tests/pgtap/record_match_result_rejects_pre_finished.sql
supabase test db --file supabase/tests/pgtap/record_match_result_enforces_for_scoring_invariant.sql
supabase test db --file supabase/tests/pgtap/record_match_result_enforces_shootout_invariant.sql
supabase test db --file supabase/tests/pgtap/record_match_result_admin_correction_requires_approver.sql
supabase test db --file supabase/tests/pgtap/record_match_result_admin_correction_requires_admin.sql
supabase test db --file supabase/tests/pgtap/record_match_result_emits_notification.sql
supabase test db --file supabase/tests/pgtap/record_match_result_audit_format.sql
supabase test db --file supabase/tests/pgtap/slice-002-catalog-rls.sql

# Deno (Edge Function)
deno test supabase/functions/sync-catalog/tests/
```

All MUST be GREEN before Slice 003's `/speckit-implement` begins (Constitution Principle XI).

## Manual verification checklist

Execute each step against a fresh local stack (`supabase db reset && psql -f supabase/seed/slice-001-fixture.sql && psql -f supabase/seed/slice-002-fixture.sql`). Record pass/fail in `specs/002-match-catalog/quickstart-verification.md` when this is run as part of `/speckit-implement`.

1. **Participant sees the catalog (FR-001 / US1.1)**.
   Sign in via the OIDC stub as `alpha@nortal.com`. Navigate to `/matches` (or whichever route the slice's UI page lives at — placeholder until participant UI lands in this slice's Next.js work). Expected: the 4 seeded matches render with stages, teams, kickoff times localized to the browser locale, and statuses. `curl -H "Cookie: <session>" http://localhost:3000/api/matches | jq '.matches | length'` returns `4`.

2. **Late-added fixture appears after sync (US1.3)**.
   Edit `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json` to add a new fixture (e.g., M5). Re-trigger sync via the curl in § Run the slice end-to-end (use a new `run_id`). Expected response `outcome='success'`, `counts.created=1`. `psql -c "SELECT count(*) FROM matches"` returns `5`. `GET /api/matches` includes M5.

3. **Locale display (FR-002 / SC-004)**.
   Set browser language to `es-ES`. Reload `/matches`. Expected: kickoff times display in `dd/MM/aaaa HH:mm` (or similar Spanish locale formatting). `psql -c "SELECT kickoff_utc FROM matches WHERE id = '...M1'"` STILL returns the UTC timestamp. Network response from `/api/matches` STILL contains the ISO-8601 UTC string.

4. **Provider failure → last-known-good served (US3.1 / SC-002)**.
   Edit `wc2026-snapshot.json` to be `[]` (empty array). Re-trigger sync. Expected: response 422 + `outcome='rejected_empty'`. `GET /api/matches` STILL returns the prior 4 (or 5) matches. `psql -c "SELECT count(*) FROM matches"` UNCHANGED.

5. **Sustained outage alert dedup (US3.2 / SC-003)**.
   Edit `wc2026-snapshot.json` to be malformed JSON (so the adapter throws). Trigger sync 3 times in rapid succession. Wait until `now() - first_failure_after_success_at > 30 minutes` (or temporarily set `outage_alert_threshold_minutes` to `1` for the test). Trigger sync again. Expected: `audit_log` has exactly ONE row with `action='provider.outage_alert_emitted'` across all triggers (dedup invariant). Restore the file; trigger sync; expected `audit_log` row `action='provider.recovered'`.

6. **Conflict quarantine (US2 Edge Case / FR-009)**.
   Edit `wc2026-snapshot.json` for an existing match to swap one of its teams. Trigger sync. Expected: response `outcome='conflict_quarantined'`. `psql -c "SELECT count(*) FROM match_pending_review WHERE reviewed_at IS NULL"` returns `1`. `matches` row UNCHANGED. `audit_log` has `action='match.conflict_quarantined'`.

7. **Provider swap (FR-005 / SC-005)**.
   Create a second stub adapter `supabase/functions/_shared/providers/stub2/` with a DIFFERENT internal schema but the same contract-compliant output. Flip `tournament_config.provider.active = "stub2"`. Trigger sync. Expected: `matches` byte-identical to before; no code change outside the new adapter file.

8. **Score-before-kickoff rejection (Edge case)**.
   Edit `wc2026-snapshot.json` to set a result for a `status='scheduled'` match. Trigger sync. Expected: `outcome='conflict_quarantined'`; `match_results` for that match NOT inserted; alert fires.

## Definition of Done (for this slice)

- All 8 manual-verification steps PASS on a clean local stack.
- All Playwright specs in `apps/web/tests/playwright/slice-002-*.spec.ts` GREEN.
- All pgTAP files listed in § Run automated tests GREEN.
- All Deno tests under `supabase/functions/sync-catalog/tests/` GREEN.
- The `MatchDataProviderAdapter` interface, `matches` table shape, `match_results` columns (especially `home_score_for_scoring` / `away_score_for_scoring`), and `record_match_result` SP signature match the contracts exactly — cross-slice locks for Slices 003–008 (Constitution Principle XI).
- The provider-swap test (§ Manual step 7) demonstrates SC-005 with zero domain-code changes.
- Slice 001's regression suite still GREEN (no `participants` / `audit_log` / `is_eligible_nortal_participant` regressions from this slice's RLS additions).

## Cross-slice handoff

After this slice merges:

- **Slice 003 (Match Predictions)** can start. Its `predictions` table FKs `match_id` to `matches(id)`. Its lock-decision SQL reads `matches.kickoff_utc`.
- **Slice 004 (Final Predictions)** can start. Its `final_predictions.champion_team_id` FKs `teams(id)`. Its adapter consumption uses `fetchPlayers?()` (introduced in this slice's contract, not called here).
- **Slice 005 (Scoring & Leaderboard)** can read `match_results.home_score_for_scoring`. Its `score-trigger` Edge Function will listen on the `match_results_recorded` LISTEN channel emitted by `record_match_result`.
- **Slice 006 (Admin Overrides)** will call `public.record_match_result(..., source='admin_correction', approved_by=<admin>)` from its admin UI and resolve `match_pending_review` rows.
- **Slice 007 (Audit Trail)** will harden `audit_log` retention; the column shape this slice writes to is locked.
- **Slice 008 (Configuration)** owns the admin UI for `tournament_config.provider.*` and the sync cadence/retry settings.
