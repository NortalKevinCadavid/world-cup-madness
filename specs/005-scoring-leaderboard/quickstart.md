# Quickstart: Scoring & Leaderboard (Slice 005)

**Audience**: A developer or reviewer who wants to run, exercise, and validate this slice locally end-to-end. Assumes Slices 001 (eligibility/login), 002 (match catalog), 003 (match predictions), and 004 (final predictions) are already running locally or in the same Supabase project.

## Prerequisites

| Tool | Purpose |
|---|---|
| Node 20+ + pnpm (or npm/yarn) | Next.js app at `apps/web/` |
| Deno 1.40+ | Supabase Edge Function runtime (`supabase functions serve`) |
| Supabase CLI 1.150+ | local Supabase stack |
| Playwright | E2E tests (mandated by Constitution Principle IX) |
| pgTAP | SQL unit tests; installed automatically by the supabase-cli local dev container |

## One-time setup

```bash
# 1. Bring up the local Supabase stack (Postgres + Auth + Realtime + Edge Functions)
supabase start

# 2. Apply migrations for this slice and all prior slices
supabase db reset      # rebuilds DB from supabase/migrations/

# 3. Install web app deps
cd apps/web && pnpm install

# 4. Install Playwright browsers (first run only)
pnpm exec playwright install --with-deps
```

## Seed data

This slice ships a Playwright-and-pgTAP-friendly fixture in `supabase/seed/slice-005-fixture.sql`. It creates:

- 6 eligible participants (`alpha`…`zeta`), 1 admin (`admin1`), 1 non-Nortal account that should be rejected.
- 3 finished matches with deterministic official scores (exact / outcome / incorrect representative).
- A `tournament_award` row with `champion_status='confirmed'`, `runner_up_status='confirmed'`, `top_scorer_status='confirmed'`, `best_player_status='pending'` (exercises the Golden Ball delay edge case).
- 24 match predictions (4 per participant × 6 participants, spanning all reason codes).
- 6 final-prediction sets, designed to produce known totals so the leaderboard can be hand-verified.

```bash
psql "$SUPABASE_DB_URL" -f supabase/seed/slice-005-fixture.sql
```

## Run the slice end-to-end

```bash
# 1. Start the Edge Function (scoring trigger)
supabase functions serve score-trigger --env-file .env.local &

# 2. Start the web app
cd apps/web && pnpm dev

# 3. Trigger an initial scoring run (in another terminal)
curl -X POST "http://localhost:54321/functions/v1/score-trigger" \
  -H "Authorization: Bearer $LOCAL_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"scope":"all","reason":"quickstart-bootstrap","run_id":"00000000-0000-0000-0000-000000000001"}'
```

You should receive a `200 OK` response shaped like the success body in `contracts/scoring-trigger.edge-fn.md`.

## Manual verification checklist

| # | Step | Expected |
|---|---|---|
| 1 | Sign in as `alpha@nortal.com` in the browser at `http://localhost:3000` | redirect to `/dashboard` |
| 2 | Visit `/leaderboard` | 6 participants, ranked, with hand-verifiable totals; `admin1` and `alpha`…`zeta` only; the non-Nortal account is absent |
| 3 | Visit `/me/breakdown` | per-match rows for the 3 finished matches; the 3 confirmed final items; the `best_player` row shows `final_pending` |
| 4 | Sign out, sign in as `bravo@nortal.com`, visit `/me/breakdown` | only `bravo`'s rows; sum of `points` equals `bravo`'s `total_points` from the leaderboard |
| 5 | While logged in as `bravo`, hit `GET /api/peer-pick/<unlocked-match-uuid>` | empty `picks` array — match still locked-to-peers because kickoff is in the future for an unfinished match in the fixture |
| 6 | Hit `GET /api/peer-pick/<finished-match-uuid>` | non-empty `picks` array including `alpha`'s pick |
| 7 | (Admin) Trigger a recalc with the same `run_id` as step (3) | response identical to step (3) — idempotent (R-002) |
| 8 | (Admin) Update `tournament_config.match_points.exact` from 10 to 15, then trigger `scope='all'` recalc | leaderboard totals shift accordingly; `score_calculation_runs.notes` includes `config_change`; audit log shows previous and new points per affected record |

If any of these fail, the slice is not ready to merge.

## Run automated tests

```bash
# E2E (Playwright) — must be red before any production code lands per Principle IX
cd apps/web && pnpm exec playwright test slice-005-*

# SQL (pgTAP)
supabase test db --file supabase/tests/pgtap/score_match_idempotent.sql
supabase test db --file supabase/tests/pgtap/score_match_award_table.sql
supabase test db --file supabase/tests/pgtap/leaderboard_tie_breakers.sql
supabase test db --file supabase/tests/pgtap/leaderboard_shared_rank.sql
supabase test db --file supabase/tests/pgtap/leaderboard_calc_version_consistency.sql
supabase test db --file supabase/tests/pgtap/peer_pick_rls_lock_boundary.sql

# Edge Function (Deno)
cd supabase/functions/score-trigger && deno test --allow-net --allow-env
```

The full regression suite (Slice 001…004 + this slice) MUST be green before merging (Principle XI).

## Common operations

### Re-score a single match after fixing its result

```bash
curl -X POST "http://localhost:54321/functions/v1/score-trigger" \
  -H "Authorization: Bearer $LOCAL_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"scope":"match","target_id":"<match-uuid>","reason":"Manual correction per ticket WCM-123"}'
```

### Confirm the FIFA Golden Ball winner once announced

```sql
UPDATE tournament_award
SET best_player_player_id = '<player-uuid>',
    best_player_status = 'confirmed',
    set_at = now(),
    set_by = '<admin-participant-uuid>'
WHERE tournament_id = '<tournament-uuid>';
-- The Postgres trigger on tournament_award fires score-trigger automatically.
```

### Switch leaderboard visibility to anonymized

```sql
UPDATE tournament_config
SET value = 'anonymized'
WHERE key = 'leaderboard_visibility';
-- No code change, no migration; next leaderboard read shows 'Participant N' display names.
```

## Where to look when things go wrong

| Symptom | First place to look |
|---|---|
| Leaderboard not updating after a match finishes | `score_calculation_runs` table for the most recent rows + Edge Function logs |
| Points are wrong | `score_records` rows for the affected match + `audit_log` for that record |
| A peer-pick endpoint returns data when it shouldn't | `peer_pick_v` definition + `tournament_config.lock_window_minutes` (must be 60 by default) |
| `leaderboard_v` slow | check the `(calculation_version, participant_id)` index on `score_records` (data-model §Indexes) |
| Admin "recalc all" times out | run `score-trigger` with `scope='match'` per match instead; verify no other run holds the advisory lock |

## Definition of Done for this slice

A reviewer can mark this slice "done" only when:
- ☐ All Acceptance Scenarios in `spec.md` US1–US4 have a green Playwright test.
- ☐ All Edge Cases in `spec.md` have a green test (Playwright or pgTAP, whichever is the natural surface).
- ☐ All Success Criteria SC-001…SC-009 are demonstrated by a named test or measurement.
- ☐ The full regression suite (Slices 001…005) is green on `main`.
- ☐ `docs/architecture/open-decisions.md` has been updated to flip OD-002 / OD-004 / OD-005 / OD-006 to `Resolved` with pointers to `spec.md` Clarifications (this slice's follow-up bullet in `checklists/requirements.md`).
