# Quickstart: Match Predictions with Locking (Slice 003)

**Audience**: A developer or reviewer who wants to run, exercise, and validate this slice locally end-to-end. **Assumes Slices 001 and 002 are already running** locally (the participants/auth surface, the match catalog, the `/matches` page, and `tournament_config` are all live).

## Prerequisites

Inherited from Slice 001 + Slice 002 (Node, pnpm, Supabase CLI, Deno, Docker, Playwright, pgTAP, psql, OIDC stub sidecar). No new tools.

## One-time setup (additive over Slices 001 + 002)

```bash
# 1. Confirm Slice 001 + Slice 002 are running
supabase start && supabase db reset      # rebuilds DB from supabase/migrations/

# 2. Load Slice 001 + Slice 002 + Slice 003 fixtures
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-001-fixture.sql
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-002-fixture.sql
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-003-fixture.sql

# 3. Start the Next.js dev server
cd apps/web && pnpm dev
```

## Seed data

This slice ships `supabase/seed/slice-003-fixture.sql` with:

- 6 prediction-scenario matches with **carefully calibrated `kickoff_utc` values relative to `now()`** so boundary tests are deterministic:
  - M-EDIT: `kickoff_utc = now() + INTERVAL '120 minutes'` — comfortably editable.
  - M-BOUNDARY: `kickoff_utc = now() + INTERVAL '60 minutes'` — exactly at the strict boundary (locked per BR-LOCK-003).
  - M-EDGE-JUST-OUTSIDE: `kickoff_utc = now() + INTERVAL '60 minutes 1 second'` — just-still-editable.
  - M-EDGE-JUST-INSIDE: `kickoff_utc = now() + INTERVAL '59 minutes 59 seconds'` — locked.
  - M-IN-PROGRESS: status='in_progress' with kickoff in the past — locked per BR-LOCK-004.
  - M-FINISHED: status='finished' — locked per BR-LOCK-004.
- 4 pre-submitted predictions for participant `alpha@nortal.com` covering the existing-active and history paths.
- Stable UUIDs (`00000000-0000-0000-0000-0000000000P1`…`P6`) for tests to reference.
- Top-of-file comment block "Hand-verified scenario coverage" mapping each spec Acceptance Scenario + Edge Case to which fixture row exercises it.

```bash
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-003-fixture.sql
```

The fixture is **safe to re-run** — every INSERT uses `ON CONFLICT DO NOTHING` and the kickoff times are computed as `now() + INTERVAL` at load time, so each load gets fresh boundary timings.

## Run the slice end-to-end

```bash
# Terminal 1 — Supabase stack
supabase start

# Terminal 2 — Next.js app
cd apps/web && pnpm dev     # http://localhost:3000

# Terminal 3 — Sign in as alpha (via OIDC stub) and submit a prediction
curl -X POST "http://localhost:3000/api/predictions" \
  -H "Authorization: Bearer $LOCAL_ALPHA_JWT" \
  -H "Content-Type: application/json" \
  -d '{"match_id":"00000000-0000-0000-0000-0000000000P1","home":2,"away":1}'
# → 200 OK with the created prediction
```

## Run automated tests

```bash
# Playwright (UI + API)
cd apps/web
pnpm exec playwright test apps/web/tests/playwright/slice-003-*.spec.ts

# pgTAP (SQL-level lock + SP + RLS)
supabase test db --file supabase/tests/pgtap/is_prediction_locked_far_before.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_strict_boundary_at.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_strict_boundary_just_outside.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_strict_boundary_just_inside.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_status_in_progress.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_status_finished.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_status_postponed.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_status_cancelled.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_unknown_match.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_config_changes.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_uses_db_clock.sql
supabase test db --file supabase/tests/pgtap/is_prediction_locked_perf.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_create_happy.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_update_supersedes.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_locked_window.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_locked_status_in_progress.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_invalid_score.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_invalid_match.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_ineligible.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_serializes_concurrent.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_audit_format.sql
supabase test db --file supabase/tests/pgtap/submit_prediction_admin_override.sql
supabase test db --file supabase/tests/pgtap/slice-003-me-predictions-rls.sql
```

All MUST be GREEN before Slice 004's `/speckit-implement` begins (Constitution Principle XI).

## Manual verification checklist

Execute each step against a fresh local stack. Record pass/fail in `specs/003-match-predictions/quickstart-verification.md` when this is run as part of `/speckit-implement`.

1. **Submit a valid prediction more than 60 minutes before kickoff (FR-001 / US1.1 / §15.1 "Submit > 60 min before kickoff")**.
   Sign in as `alpha@nortal.com`. Navigate to `/matches`. Locate M-EDIT (kickoff ~120 min out). Click the inline prediction form, enter home=2, away=1, submit. Expected: confirmation message; the form now shows "Your pick: 2-1"; `psql -c "SELECT predicted_home, predicted_away FROM predictions WHERE participant_id=(SELECT id FROM participants WHERE email='alpha@nortal.com') AND match_id='...P1' AND superseded_at IS NULL"` returns `(2, 1)`. `audit_log` has `action='prediction.created'`.

2. **Edit a prediction more than 60 minutes before kickoff (FR-003 / US2.1 / §15.1 "Edit 61 min before kickoff")**.
   While still on M-EDIT, change the prediction to home=3, away=0, submit. Expected: confirmation; new value shown. `psql -c "SELECT COUNT(*) FROM predictions WHERE participant_id=... AND match_id='...P1'"` returns `2` (active + superseded). `psql -c "SELECT id, predicted_home, predicted_away, superseded_at IS NOT NULL AS is_superseded FROM predictions WHERE participant_id=... AND match_id='...P1' ORDER BY submitted_at"` shows the chain. `audit_log` has BOTH `prediction.superseded` (the previous row) AND `prediction.created` (the new row).

3. **Edit attempt at exactly kickoff − 60 minutes — REJECTED (FR-004 / US3.1 / §15.1 "Edit at exactly kickoff − 60 min")**.
   Navigate to M-BOUNDARY (kickoff exactly 60 min out). Attempt to submit. Expected: response 409 with `code='PREDICTION_LOCKED', reason='lock_window_passed'`. UI shows "Predictions for this match closed at ...". `psql -c "SELECT count(*) FROM predictions WHERE match_id='...P2'"` returns 0. `audit_log` has `action='prediction.rejected_locked', reason='lock_window_passed'`.

4. **Edit attempt 59 minutes before kickoff — REJECTED (FR-004 / US3.2 / §15.1 "Edit 59 min before kickoff")**.
   Navigate to M-EDGE-JUST-INSIDE (kickoff ~59:59). Attempt to submit. Expected: same 409 + audit row.

5. **Edit attempt at kickoff − 60 min + 1 second — ACCEPTED (US3.5 / SC-001)**.
   Navigate to M-EDGE-JUST-OUTSIDE (kickoff ~60:01). Submit home=1, away=1. Expected: 200 OK; prediction stored.

6. **Direct API attempt inside lock window — REJECTED at the API gate, not just the UI (FR-006 / US3.3 / §15.1 "Edit at 59 min before kickoff via direct API")**.
   `curl -X POST http://localhost:3000/api/predictions -H "Authorization: Bearer $LOCAL_ALPHA_JWT" -H "Content-Type: application/json" -d '{"match_id":"00000000-0000-0000-0000-0000000000P4","home":1,"away":1}'` (where P4 is M-EDGE-JUST-INSIDE). Expected: 409 with `reason='lock_window_passed'`. UI gating is NOT the gate.

7. **Client clock manipulation is IGNORED (US3.4 / BR-LOCK-001)**.
   Open browser dev tools; set `Date.now = () => server_time + 24*60*60*1000` (i.e., pretend the client clock thinks it's 24 hours from now). Navigate to M-IN-PROGRESS. Attempt to submit. Expected: server still rejects via `is_prediction_locked()` based on database clock. The client clock has no effect on the lock decision.

8. **Started match — REJECTED regardless of remaining time (BR-LOCK-004 / Spec Edge Case)**.
   Navigate to M-IN-PROGRESS (status='in_progress', kickoff in past). Attempt to submit. Expected: 409 with `reason='match_status_locked'`. UI shows "This match has already started — predictions are closed."

9. **Cancelled match — predictions preserved, NEW edits REJECTED (Spec Edge Case)**.
   First submit a prediction for M-EDIT. Then `psql -c "UPDATE matches SET status='cancelled' WHERE id='...P1'"`. Refresh `/matches`. Expected: the prior prediction is STILL VISIBLE in the page ("Your pick: 3-0") but the form is hidden / disabled with "This match has been cancelled — predictions remain for audit only". `psql -c "SELECT count(*) FROM predictions WHERE match_id='...P1' AND superseded_at IS NULL"` returns 1 (still active). Attempt to re-submit via direct API → 409 with `reason='match_status_locked'`.

10. **Score upper bound enforcement (FR-008)**.
    Submit a prediction with home=21, away=0 (above the default upper bound of 20) for M-EDIT. Expected: 400 (route-handler validation) with `code='BAD_REQUEST'`. Try the SP directly via `psql -c "SELECT public.submit_prediction(...)"` with home=21 — Expected: EXCEPTION with ERRCODE='WCM03', audit row `prediction.rejected_invalid_score`.

11. **Configuration change responsiveness (SC-005)**.
    Submit for M-EDGE-JUST-OUTSIDE (kickoff ~60:01) — accepted at lock_window=60. Then `psql -c "UPDATE tournament_config SET value = '180'::jsonb WHERE key = 'lock_window_minutes'"` (bump to 180 min). Wait < 1 min. Re-submit for the same match. Expected: 409 — the match is now inside the new 180-min lock window. Restore `lock_window_minutes = 60` after the test.

12. **Concurrent submissions (FR-009 / SC-003)**.
    Open two browser tabs as alpha. In tab 1, submit home=1, away=0 for M-EDIT. In tab 2 (before tab 1 confirms), submit home=2, away=1 for the same match. Expected: both POSTs return 200 (the SP serializes correctly); `psql -c "SELECT count(*) FROM predictions WHERE participant_id=... AND match_id='...P1' AND superseded_at IS NULL"` returns exactly 1; total chain length is 2 or 3 (depending on whether prior predictions exist). No race produces two active rows.

13. **Personal predictions read (FR-002 / R-013)**.
    `curl http://localhost:3000/api/me/predictions -H "Authorization: Bearer $LOCAL_ALPHA_JWT"`. Expected: 200 with an array of all alpha's current active predictions. Verify that B's predictions are NOT visible to A (cross-RLS check): `curl http://localhost:3000/api/me/predictions -H "Authorization: Bearer $LOCAL_BETA_JWT"` returns only beta's predictions.

14. **Audit trail completeness (FR-011 / SC-007)**.
    After exercising steps 1, 2, 3, 8, 10 above, `psql -c "SELECT action, reason FROM audit_log WHERE entity_type='prediction' ORDER BY occurred_at"` shows a complete trail: created → superseded → created → rejected_locked → rejected_locked → rejected_invalid_score. Every state change and every rejected attempt accounted for.

## Definition of Done (for this slice)

- All 14 manual verification steps PASS on a clean local stack.
- All Playwright specs in `apps/web/tests/playwright/slice-003-*.spec.ts` GREEN.
- All pgTAP files listed in § Run automated tests GREEN.
- `is_prediction_locked(uuid)`, `submit_prediction(...)`, and the `predictions` table shape match the contracts exactly — cross-slice locks for Slices 005 + 006 (Constitution Principle XI).
- The `Match.lock_state` field is present in every `/api/matches` response.
- Slice 001 + Slice 002 regression suites still GREEN (no regressions from this slice's additions).
- The slice runs end-to-end without service-role key in any client bundle (`grep -r "service_role" apps/web/` returns nothing).

## Cross-slice handoff

After this slice merges:

- **Slice 004 (Final Tournament Predictions)** can start. Its `final_predictions` table FKs to `participants(id)` and references `tournament_config.first_kickoff_utc` (locked by Slice 005's research § R-014 but seeded via Slice 002 / Slice 008). The lock pattern Slice 004 follows is a per-tournament variant of `is_prediction_locked` — it should reuse the predicate's posture (`STABLE`, `SECURITY INVOKER`, `now()`-based).
- **Slice 005 (Scoring & Leaderboard)** can read `predictions.predicted_home` / `predicted_away` (active rows only) for its `score_match` function. Its `peer_pick_v` view's lock filter calls `public.is_prediction_locked(m.id)` directly.
- **Slice 006 (Admin Overrides)** will wrap `submit_prediction(..., source='admin_override')` in an `admin_submit_prediction` RPC and the corresponding admin UI.
- **Slice 007 (Audit Trail)** will harden `audit_log` retention; this slice's `prediction.*` action labels are locked.
- **Slice 008 (Configuration)** owns the admin UI for `tournament_config.lock_window_minutes` and `tournament_config.score_upper_bound`. Until Slice 008 ships, both are changed via psql (see step 11 above).
