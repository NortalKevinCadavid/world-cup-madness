# Quickstart: Final Tournament Predictions (Slice 004)

**Audience**: Dev or reviewer running this slice locally end-to-end. **Assumes Slices 001 + 002 + 003 are already running** locally.

## Prerequisites

Inherited from prior slices (Node, pnpm, Supabase CLI, Deno, Docker, Playwright, pgTAP, psql, OIDC stub). No new tools.

## One-time setup (additive over Slices 001 + 002 + 003)

```bash
# 1. Ensure prior slices are up
supabase start && supabase db reset

# 2. Load prior-slice fixtures
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-001-fixture.sql
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-002-fixture.sql
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-003-fixture.sql

# 3. Load Slice 004 fixture
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-004-fixture.sql

# 4. Configure first_kickoff_utc for boundary tests
# (Slice 002 sync would normally compute this; for the fixture we set it directly)
psql "$SUPABASE_DB_URL" -c "
  INSERT INTO tournament_config(key, value) VALUES
    ('first_kickoff_utc', to_jsonb((now() + INTERVAL '2 hours')::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
"

# 5. Start the Next.js dev server
cd apps/web && pnpm dev
```

## Seed data

`supabase/seed/slice-004-fixture.sql` includes:

- **8 players** from the Slice 002 fixture's 8 teams (Lionel Messi → Argentina, Pedri → Spain via a placeholder team adjustment, etc.). Stable UUIDs `00000000-0000-0000-0000-0000000000PL1`…`PL8`.
- **1 player marked `removed_at IS NOT NULL`** for testing the player-removed handling.
- **3 sample final-prediction sets**:
  - `alpha`: all 4 picks submitted (champion=ARG, runner_up=BRA, top_scorer=PL1, best_player=PL2).
  - `bravo`: 2 picks submitted (champion=FRA, top_scorer=PL3); runner_up + best_player unset.
  - `charlie`: 0 picks submitted (clean slate for "first-time submission" tests).
- **Boundary-calibrated `first_kickoff_utc`**:
  - On default fixture load: `now() + 2 hours` (everything editable).
  - The quickstart steps include `psql` commands to mutate this for specific boundary tests.

Top-of-file comment block "Hand-verified scenario coverage" maps each spec Acceptance Scenario + Edge Case to which fixture row exercises it.

```bash
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-004-fixture.sql
```

Re-runnable via `ON CONFLICT DO NOTHING`.

## Run the slice end-to-end

```bash
# Terminal 1 — Supabase stack
supabase start

# Terminal 2 — Next.js app
cd apps/web && pnpm dev      # http://localhost:3000

# Terminal 3 — Submit a final prediction
curl -X POST "http://localhost:3000/api/final-predictions" \
  -H "Authorization: Bearer $LOCAL_CHARLIE_JWT" \
  -H "Content-Type: application/json" \
  -d '{"item_kind":"champion","target_team_id":"00000000-0000-0000-0000-0000000000T1"}'
# → 200 OK with the created prediction
```

## Run automated tests

```bash
# Playwright
cd apps/web
pnpm exec playwright test apps/web/tests/playwright/slice-004-*.spec.ts

# pgTAP (lock predicate + SP + RLS + ingest)
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_before.sql
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_at_boundary.sql
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_just_before.sql
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_just_after.sql
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_far_after.sql
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_config_missing.sql
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_config_changes.sql
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_uses_db_clock.sql
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_perf.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_create_champion_happy.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_create_top_scorer_happy.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_update_supersedes.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_locked.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_invalid_kind.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_invalid_target_shape.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_invalid_target_missing.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_invalid_target_removed_player.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_identical_champion_runner_up.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_serializes_concurrent.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_audit_format.sql
supabase test db --file supabase/tests/pgtap/submit_final_prediction_admin_override.sql
supabase test db --file supabase/tests/pgtap/slice-004-me-final-predictions-rls.sql
supabase test db --file supabase/tests/pgtap/players_ingest_happy.sql
supabase test db --file supabase/tests/pgtap/players_ingest_update.sql
supabase test db --file supabase/tests/pgtap/players_ingest_soft_delete.sql
supabase test db --file supabase/tests/pgtap/players_ingest_undersized_quarantined.sql

# Deno (Slice 002 sync coordinator extension)
deno test supabase/functions/sync-catalog/tests/players_branch.test.ts
```

All MUST be GREEN before Slice 005's `/speckit-implement` begins.

## Manual verification checklist

Execute each step against a fresh local stack. Record pass/fail in `specs/004-final-predictions/quickstart-verification.md`.

1. **Submit champion before lock (US1.1 / FR-001)**.
   Sign in as `charlie@nortal.com`. Navigate to `/me/finals`. Pick "Argentina" as champion. Submit. Expected: confirmation; the champion picker now shows "Your pick: Argentina". `psql -c "SELECT item_kind, target_team_id FROM final_predictions WHERE participant_id=(SELECT id FROM participants WHERE email='charlie@nortal.com') AND superseded_at IS NULL"` returns `(champion, <ARG-uuid>)`. `audit_log` has `action='final_prediction.created'`.

2. **Independent items (US1.2 / FR-002)**.
   Still as charlie: submit "France" as runner-up. Don't touch top_scorer / best_player. Expected: 2 active rows for charlie; the other two items remain unset.

3. **Update champion (US1.3 / US3.1)**.
   Still as charlie: change champion from "Argentina" to "Brazil". Submit. Expected: `psql -c "SELECT count(*) FROM final_predictions WHERE participant_id=... AND item_kind='champion'"` returns 2 (active = Brazil; superseded = Argentina). Runner_up (France) UNTOUCHED. `audit_log` has `final_prediction.superseded` + `final_prediction.created`.

4. **Lock at exactly first_kickoff_utc — REJECT (US2.1 / SC-001 strict boundary)**.
   `psql -c "UPDATE tournament_config SET value=to_jsonb(now()::text) WHERE key='first_kickoff_utc'"`. Wait 1 second. As charlie: attempt to update top_scorer. Expected: 409 with `reason='lock_window_passed'`. `audit_log` has `final_prediction.rejected_locked`.

5. **Lock at first_kickoff_utc + 1 second — REJECT (US2.2)**.
   Same as step 4 (lock has fired). Verify a separate attempt also rejects.

6. **Lock at first_kickoff_utc − 1 second — ACCEPT (US2.3 / SC-001)**.
   `psql -c "UPDATE tournament_config SET value=to_jsonb((now() + INTERVAL '1 second')::text) WHERE key='first_kickoff_utc'"`. Immediately as charlie: submit best_player. Expected: 200.

7. **Direct API attempt after lock — REJECT (US2.2 / SC-002)**.
   Reset lock to past: step 4. `curl -X POST http://localhost:3000/api/final-predictions -H "Authorization: Bearer $LOCAL_ALPHA_JWT" -H "Content-Type: application/json" -d '{"item_kind":"champion","target_team_id":"00000000-0000-0000-0000-0000000000T2"}'`. Expected: 409 with `reason='lock_window_passed'`.

8. **Identical champion/runner-up rejected (FR-007 default)**.
   Reset lock to far future. Sign in as charlie (champion=Brazil from step 3). Attempt to submit runner_up=Brazil. Expected: 409 with `reason='identical_champion_runner_up'`. Toggle config: `psql -c "UPDATE tournament_config SET value='true'::jsonb WHERE key='predictions.allow_identical_champion_runner_up'"`. Re-attempt: 200.

9. **Invalid player target (FR-006)**.
   `curl POST /api/final-predictions -d '{"item_kind":"top_scorer","target_player_id":"00000000-0000-0000-0000-0000000000XX"}'` (non-existent player). Expected: 404 with `reason='player_not_found'`.

10. **Removed player target (Edge Case "player removed before lock")**.
    Pick the removed-player fixture row. Expected: 404 with `reason='player_removed'`. Audit row `final_prediction.target_player_removed` exists from an earlier sync.

11. **Concurrent edits to the same item (US3 concurrent / SC-004)**.
    Open two tabs as charlie. Tab A: submit champion=Spain. Tab B: submit champion=Germany. Expected: both 200; exactly 1 active row in DB; total chain length 3 (Brazil → Spain or Germany → the other). No race produces 2 active rows.

12. **First-kickoff correction (FR-009 / SC-005)**.
    Set first_kickoff_utc to `now() + INTERVAL '1 hour'`. Sign in as charlie, submit top_scorer. Expected: 200 (editable). Then `psql -c "UPDATE tournament_config SET value=to_jsonb((now() - INTERVAL '1 hour')::text) WHERE key='first_kickoff_utc'"` (move kickoff into the past). Wait < 1 minute. Attempt to update top_scorer. Expected: 409 (now locked). `psql -c "SELECT count(*) FROM audit_log WHERE action='final_prediction.first_kickoff_corrected' AND new_value->>'first_kickoff_utc' != previous_value->>'first_kickoff_utc'"` returns ≥ 1 (one row per active final_prediction).

13. **Personal final predictions read (FR-010 / R-010)**.
    `curl http://localhost:3000/api/me/final-predictions -H "Authorization: Bearer $LOCAL_CHARLIE_JWT"`. Expected: 200 with charlie's active picks AND `lock_state`. Verify B cannot see charlie's picks: `curl http://localhost:3000/api/me/final-predictions -H "Authorization: Bearer $LOCAL_BRAVO_JWT"` returns bravo's picks only.

14. **Audit trail completeness (FR-011 / SC-006)**.
    After all prior steps, `psql -c "SELECT action, reason FROM audit_log WHERE entity_type IN ('final_prediction','tournament') ORDER BY occurred_at"`. Expect: created, superseded, rejected_locked, rejected_identical_champion_runner_up, target_player_removed, first_kickoff_corrected, recovered, etc. Complete narrative.

15. **Player ingest end-to-end (R-004 / players ingest contract)**.
    Trigger a sync against the stub adapter that includes `fetchPlayers()` returning a roster. Expected: `players` rows appear; `player_provider_external_ids` rows correctly mapped; `audit_log` has `player.created` rows. Re-trigger with one player removed: that player gets `removed_at` set; an audit `final_prediction.target_player_removed` row fires for any active prediction referencing them.

## Definition of Done

- All 15 manual steps PASS on a clean stack.
- All Playwright + pgTAP + Deno tests GREEN.
- `is_final_prediction_locked()`, `submit_final_prediction(...)`, `final_predictions` / `players` table shapes match contracts exactly.
- Slices 001 + 002 + 003 regression suites still GREEN.
- No service-role key in any client bundle.

## Cross-slice handoff

After this slice merges:

- **Slice 005 (Scoring & Leaderboard)** can read `final_predictions` (active rows) for `score_finals` AND can build `peer_final_pick_v` using `is_final_prediction_locked()` filter.
- **Slice 006 (Admin Overrides)** will wrap `submit_final_prediction(..., source='admin_override')` and consume `final_prediction.target_player_removed` audit rows for the admin reopen-finals UI.
- **Slice 007 (Audit Trail)** will harden retention for the `final_prediction.*` and `tournament.first_kickoff_corrected` action labels.
- **Slice 008 (Configuration)** owns the admin UI for `tournament_config.first_kickoff_utc` + `tournament_config.predictions.allow_identical_champion_runner_up` + roster sync cadence.
