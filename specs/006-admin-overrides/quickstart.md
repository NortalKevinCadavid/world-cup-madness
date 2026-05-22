# Quickstart: Admin Overrides & Recalculation (Slice 006)

**Audience**: Dev or reviewer running this slice locally end-to-end. **Assumes Slices 001 + 002 + 003 + 004 + 005 are already running** locally.

## Prerequisites

Inherited from prior slices. No new tools.

## One-time setup (additive)

```bash
# 1. Ensure prior slices are up
supabase start && supabase db reset

# 2. Load all prior-slice fixtures
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-001-fixture.sql
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-002-fixture.sql
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-003-fixture.sql
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-004-fixture.sql
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-005-fixture.sql

# 3. Load Slice 006 fixture
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-006-fixture.sql

# 4. Start Next.js + Edge Functions
cd apps/web && pnpm dev
supabase functions serve score-trigger --env-file .env.local &
```

## Seed data

`supabase/seed/slice-006-fixture.sql` includes:

- **1 bootstrap admin**: `admin1@nortal.com` (from Slice 001's fixture) gets an active `admin_roles` row.
- **1 second admin candidate**: `admin2@nortal.com` (from Slice 001's fixture) — NO active admin_roles row initially; used for testing grant + revoke flows.
- **3 sample scored matches** (M1, M2, M3 from Slice 002 fixture) — used for override + recalc scenarios.
- **1 open `match_pending_review` row** (from Slice 002 fixture — team-swap conflict) — used for US3 resolution flows.
- **1 sample admin audit row** (`admin.match_result_corrected` from a hypothetical earlier session) — used to test the audit-search UI.

The fixture is **safe to re-run**.

## Run the slice end-to-end

```bash
# Sign in as admin1 via OIDC stub
# Navigate to http://localhost:3000/admin

# Or via curl:
curl -X POST "http://localhost:3000/api/admin/match-results" \
  -H "Authorization: Bearer $LOCAL_ADMIN1_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "match_id": "00000000-0000-0000-0000-000000000M1",
    "home_score_official": 2,
    "away_score_official": 2,
    "home_score_for_scoring": 2,
    "away_score_for_scoring": 2,
    "result_status": "regulation",
    "reason": "Provider had wrong score; corrected per official announcement",
    "source_citation": "https://example.com/announcement"
  }'
# → 200 OK with the updated match_result
```

## Run automated tests

```bash
cd apps/web && pnpm exec playwright test apps/web/tests/playwright/slice-006-*.spec.ts

# pgTAP
supabase test db --file supabase/tests/pgtap/is_admin_active_grant.sql
supabase test db --file supabase/tests/pgtap/is_admin_revoked_grant.sql
supabase test db --file supabase/tests/pgtap/is_admin_no_grant.sql
supabase test db --file supabase/tests/pgtap/is_admin_deactivated_participant.sql
supabase test db --file supabase/tests/pgtap/is_admin_unknown_uid.sql
supabase test db --file supabase/tests/pgtap/is_admin_null_uid.sql
supabase test db --file supabase/tests/pgtap/is_admin_revoke_then_regrant.sql
supabase test db --file supabase/tests/pgtap/is_admin_uses_db_state_not_jwt.sql
supabase test db --file supabase/tests/pgtap/is_admin_perf.sql
supabase test db --file supabase/tests/pgtap/admin_record_match_result_happy.sql
supabase test db --file supabase/tests/pgtap/admin_record_match_result_not_admin.sql
supabase test db --file supabase/tests/pgtap/admin_record_match_result_missing_reason.sql
supabase test db --file supabase/tests/pgtap/admin_record_match_result_missing_source.sql
supabase test db --file supabase/tests/pgtap/admin_record_match_result_invariant_propagates.sql
supabase test db --file supabase/tests/pgtap/admin_update_match_happy.sql
supabase test db --file supabase/tests/pgtap/admin_update_match_kickoff_fans_out.sql
supabase test db --file supabase/tests/pgtap/admin_submit_prediction_bypass_locked.sql
supabase test db --file supabase/tests/pgtap/admin_submit_prediction_unlocked.sql
supabase test db --file supabase/tests/pgtap/admin_submit_final_prediction_bypass_locked.sql
supabase test db --file supabase/tests/pgtap/admin_update_tournament_award_happy.sql
supabase test db --file supabase/tests/pgtap/admin_resolve_match_pending_review_accept_provider.sql
supabase test db --file supabase/tests/pgtap/admin_resolve_match_pending_review_reject_provider.sql
supabase test db --file supabase/tests/pgtap/admin_resolve_match_pending_review_manual_override.sql
supabase test db --file supabase/tests/pgtap/admin_trigger_recalc_scope_all.sql
supabase test db --file supabase/tests/pgtap/admin_trigger_recalc_concurrent.sql
supabase test db --file supabase/tests/pgtap/admin_trigger_recalc_audit_links_run.sql
supabase test db --file supabase/tests/pgtap/reap_stale_recalc_runs.sql
supabase test db --file supabase/tests/pgtap/pending_recalc_state_view.sql
```

All MUST be GREEN before any future slice's `/speckit-implement` begins.

## Manual verification checklist

Execute each step against a fresh local stack. Record pass/fail in `specs/006-admin-overrides/quickstart-verification.md`.

1. **Admin manually corrects a match score (FR-001 / US1.1)**.
   Sign in as `admin1@nortal.com`. Navigate to `/admin/matches/M1`. Click "Correct Score." Enter home=2, away=2 (was 2-1), reason "Provider was wrong", source `https://example.com`. Submit. Expected: 200 + match_results row updated. `psql -c "SELECT home_score_official FROM match_results WHERE match_id='M1'"` returns 2. Audit row `admin.match_result_corrected` exists with the reason + source_citation. Slice 005's score-trigger fires automatically — `score_calculation_runs` shows a new run. After completion, leaderboard reflects new scores within 1 minute (SC-003).

2. **Override missing reason rejected (FR-002 / US1.2)**.
   Open the same form. Leave reason empty; fill source. Submit. Expected: 400 with `code='BAD_REQUEST'` and a clear validation message.

3. **Override missing source rejected (FR-002 / US1.2)**.
   Reason filled; source empty. Submit. Expected: 400.

4. **Audit pointer from affected score back to override (FR-007 / US1.3)**.
   After step 1, query `score_records` for an affected participant. The row's `run_id` points at a `score_calculation_runs` row. That row's `triggering_audit_log_id` points back at the `admin.match_result_corrected` audit row from step 1. End-to-end traceability in two JOINs.

5. **Admin triggers full recalc (US2 / FR-003)**.
   Navigate to `/admin/recalc`. Click "Trigger Full Recalc." Provide reason. Submit. Expected: 200 with `run_id`. The UI's live status (Realtime subscription) shows the run transitioning `running → succeeded`. Total time < 5 minutes for the fixture's 6 participants × 4 matches (SC-002 is for 1,000 × 104 + 4 finals — fixture-scale is much smaller).

6. **Recalc idempotency (SC-006)**.
   Immediately after step 5 completes, trigger another full recalc with no intervening changes. Expected: 200; the second run completes with `affected_record_count=0` (all rows already at current calculation_version). Hash-equality of `score_records` content before/after.

7. **Recalc concurrent blocked (FR-008)**.
   Trigger a recalc. Before it completes, trigger a second one. Expected: 409 with `WAR06` mapped to `SYNC_IN_FLIGHT`.

8. **Recalc resumes after interrupt (SC-007)**.
   Trigger a recalc. Kill the Edge Function process mid-run (`supabase functions stop score-trigger`). Wait 30-60 seconds. `psql -c "SELECT status FROM score_calculation_runs ORDER BY started_at DESC LIMIT 1"` should show the row still as `running` until the reaper kicks in. After reaper fires: `supabase functions serve score-trigger` (restart); the next reaper cycle re-POSTs; run completes with `status='succeeded'`.

9. **Admin corrects final tournament award (US3)**.
   Navigate to `/admin/finals`. Change top_scorer to a different player. Reason + source. Submit. Expected: 200 + tournament_award row updated. Slice 005's score-trigger fires for `scope='finals'`. After completion, every participant whose top_scorer pick matched the new player gets 20 points; participants who matched the old player lose those 20 points.

10. **Non-admin rejected at UI (US4 / SC-005)**.
    Sign in as `alpha@nortal.com` (eligible participant, NOT admin). Visit `/admin`. Expected: redirect to `/admin/denied`. Audit row `admin.access_denied` with `actor=alpha.id`, `reason='not_admin'`, `source='api_guard'`.

11. **Non-admin rejected at API (US4 / SC-005)**.
    `curl -X POST http://localhost:3000/api/admin/match-results -H "Authorization: Bearer $LOCAL_ALPHA_JWT" -d '...'`. Expected: 403 with `code='ADMIN_FORBIDDEN'`. Audit row written.

12. **`is_admin` uses DB state, not JWT (US4 / R-001)**.
    Synthesize a JWT for `alpha@nortal.com` with `{"role": "admin"}` claim. Visit `/admin`. Expected: still 403 — the new function body reads `admin_roles` table, not JWT claim. (This is the migration from Slice 001 stub.)

13. **Admin role revocation takes effect immediately (FR-009)**.
    As admin1, navigate to `/admin/audit`. In a separate session, `psql -c "UPDATE admin_roles SET revoked_at = now(), revoked_by = (SELECT id FROM participants WHERE email='admin1@nortal.com'), revoke_reason = 'test' WHERE participant_id = (SELECT id FROM participants WHERE email='admin1@nortal.com')"`. Refresh admin1's browser. Expected: redirect to `/admin/denied`. No JWT refresh needed.

14. **Match pending review resolved (US2 Edge Case)**.
    Navigate to `/admin/pending-review`. Click "Accept Provider" on the open conflict row. Reason + source. Submit. Expected: 200; matches row updated to provider's quarantined observation; review row marked `reviewed_at`, `reviewer=admin1.id`, `resolution='accept_provider'`.

15. **`recalc_pending` banner appears after config change (FR-010)**.
    `psql -c "UPDATE tournament_config SET value = '15'::jsonb WHERE key = 'match_points.exact'"` (mutate scoring config). Within 5 seconds, refresh `/admin`. Expected: red banner reading "Configuration changed — recalculation pending." Click "Trigger Recalc" → recalc runs; banner disappears after run completes.

16. **Audit search by target (FR-011)**.
    After steps 1, 9, navigate to `/admin/audit/by-target/match/M1`. Expected: full lifecycle history for M1 — sync coordinator's `match.created` + `match.updated` + admin's `admin.match_result_corrected`. All ordered ASC by `occurred_at`.

## Definition of Done

- 16/16 manual steps PASS on a clean stack.
- All Playwright + pgTAP tests GREEN.
- `is_admin(uuid)`, `admin_*` RPC signatures + ERRCODE values, `admin_roles` shape, `audit_log.source_citation` column, audit action labels, and `pending_recalc_state` view match contracts exactly.
- Slices 001+002+003+004+005 regression suites still GREEN (no regressions from the `is_admin` body replacement or the additive column adds).
- No service-role key in any client bundle.

## Cross-slice handoff

After this slice merges:

- **Slice 007 (Audit Trail)** will harden retention + tamper-resistance on `audit_log`; the column shape (including `source_citation`) is locked.
- **Slice 008 (Configuration)** will ship the admin UI for `admin_roles` assignment + tournament_config admin pages; this slice's `admin_roles` table shape is locked.
- The locked `is_admin(uuid)` real body + `admin_*` RPC family is the foundation for all future admin-side workflows.
