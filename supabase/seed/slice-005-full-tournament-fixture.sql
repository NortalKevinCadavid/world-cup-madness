-- =============================================================================
-- Slice 005 / T044 — Full-tournament PERF fixture.
--
-- Workload anchored to spec.md § SC-004 + § SC-005:
--   * SC-004: "personal breakdown for a full tournament (104 matches + 4 final
--             picks) loads in under 3 seconds under normal load."
--   * SC-005: "after a corrected match score, every affected participant's
--             leaderboard rank reflects the new value within 1 minute of
--             recalculation completion."
--
-- Fixture shape (LARGER than slice-005-fixture.sql's 6-participant toy AND
-- larger than the T043 load-test fixture; this is the worst-case perf gate):
--   * 500 participants                                — auth.users + participants
--   * 104 finished matches                            — full FIFA 2026 fixture
--                                                       (48 group + 56 knockout)
--   * 104 match_results rows (all 'regulation', 2-1)  — boring scores so the
--                                                       perf test focuses on
--                                                       throughput not correctness
--   * 52,000 active match predictions                 — 500 × 104, one per
--                                                       (participant, match)
--                                                       active row
--   * 2,000 final_predictions rows                    — 500 × 4 item_kinds
--                                                       (champion, runner_up,
--                                                       top_scorer, best_player)
--   * tournament_award                                — single row, all four
--                                                       items 'confirmed' so
--                                                       score_finals scores
--                                                       a deterministic mix
--                                                       of correct/incorrect
--                                                       per the (i % N)
--                                                       deterministic-variety
--                                                       pattern below
--
-- This file is NOT loaded by `supabase db reset` — it is NOT listed in
-- supabase/config.toml's [db.seed] sql_paths and would slow the regular dev
-- loop dramatically. To load it for a perf run:
--
--   psql "$DATABASE_URL" -f supabase/seed/slice-005-full-tournament-fixture.sql
--
-- After loading, run a scope='all' scoring pass via the score-trigger Edge
-- Function so personal_breakdown_v + leaderboard_v have rows at the latest
-- calculation_version. Then run:
--
--   RUN_PERF_TESTS=1 npx playwright test slice-005-breakdown.perf.spec.ts
--   RUN_EDGE_FN_TESTS=1 RUN_PERF_TESTS=1 deno test \
--     supabase/functions/score-trigger/tests/all_scope_perf.test.ts
--
-- Idempotent: every INSERT uses ON CONFLICT DO NOTHING with deterministic
-- UUIDs so re-running against a partially-loaded DB is safe. INSERT...SELECT
-- with generate_series is used aggressively to keep the file readable while
-- producing ~54K rows.
--
-- =============================================================================
-- UUID conventions (avoid collisions with slices 001-004 + slice-005-fixture)
-- =============================================================================
--
-- auth.users / participants (T044-new — 500 perf-test identities):
--   auth.users.id      = 00000000-0000-0000-0000-0000000aNNNN  (NNNN = hex 0001..01F4)
--   participants.id    = 0000a000-0000-0000-0000-0000000NNNN   (NNNN = hex 0001..01F4)
-- The auth.users 0xa* prefix is distinct from slice-005-fixture's 0xd* prefix
-- (delta/epsilon/zeta/admin1) and slice-001's 0x{a,b,c,e}.
--
-- teams (T044-new): we need at least 48 distinct teams to fill 24 group-stage
-- pairings per match round + knockout teams. Slice 002 seeds 8. We add 56
-- more (52 + 4 spare) so 48-team World Cup formats are representable. UUIDs:
--   aaaa0044-0000-0000-0000-00000000NNNN   (NNNN = hex 0001..0044, 68 teams)
-- which never collides with slice 002's `aaaa0000-...` UUIDs.
--
-- matches (T044-new): 104 finished matches with deterministic UUIDs:
--   ffff0050-NNNN-0000-0000-000000000000   (NNNN = hex 0001..0068)
-- The all_scope_perf.test.ts targets ffff0050-0001-... as "match 1" for the
-- scope='match' perf gate. The ffff* prefix never collides with slice 002's
-- bbbb*, slice-005-fixture's eeee0050-*, or any other slice's match UUIDs.
--
-- match_results: keyed by match_id, no separate UUID.
--
-- predictions (T044-new): 52,000 rows. UUIDs derived from
--   ffff0051-<participant>-<match>-0000-000000000000
-- but UUIDs are 8-4-4-4-12 hex; we slot participant_index into bytes 9-12 and
-- match_index into bytes 14-17 so the surface is collision-free with all
-- prior slices' eeee* / cccc* prediction UUIDs.
--
-- final_predictions (T044-new): 2,000 rows. UUIDs:
--   ffff0052-<participant>-<kind>-0000-000000000000
-- where <kind> is one of 0001..0004 (one per item_kind in the canonical order
-- champion, runner_up, top_scorer, best_player).
--
-- Players (T044-new): we reuse slice-004's Messi/Vinícius/Pedri for the
-- player-kind finals so the tournament_award single confirmed top_scorer +
-- best_player lookup hits the existing rows. No new players inserted.
--
-- =============================================================================
-- Constraints honored
-- =============================================================================
--   * matches_distinct_teams              — home_team_id != away_team_id; we
--     use (i, i+24) mod 48 for group pairings and (i, 48 + (i+1)) mod knockout
--     for knockout, both guaranteeing distinct teams.
--   * matches_group_id_consistency        — stage='group' rows have group_id
--     'A'..'L'; knockout rows have NULL group_id.
--   * match_results_for_scoring_matches   — every row has home_score=2,
--     away_score=1, no extra time, so home_score_for_scoring=2 +
--     COALESCE(NULL,0)=2 and away_score_for_scoring=1 + COALESCE(NULL,0)=1.
--   * match_results_status_enum           — every row 'regulation'.
--   * match_results_source_enum           — every row 'provider_sync'.
--   * predictions_active_uk               — exactly one active prediction per
--     (participant, match) pair: all 52K rows have superseded_at=NULL and
--     the unique (participant_index, match_index) join guarantees uniqueness.
--   * predictions.predicted_home / _away >= 0 — (i % 5) + 1 and (i+1) % 5
--     both in [0..5].
--   * final_predictions_active_uk         — exactly one active row per
--     (participant, item_kind): we INSERT exactly one row per (i, kind) pair.
--   * final_predictions_target_xor_kind   — team-kind rows populate
--     target_team_id and NULL target_player_id; player-kind rows the inverse.
-- =============================================================================

BEGIN;

-- ===========================================================================
-- 0. Configuration constants (kept local to this transaction).
-- ===========================================================================
-- We choose tiny derived-team values via integer math rather than a TEMP TABLE
-- so the fixture stays a single self-contained file. The numeric counts are
-- 500 participants, 48 teams (8 from slice 002 + 40 here), 104 matches
-- (48 group + 56 knockout), and 4 final-prediction item kinds.

-- ===========================================================================
-- 1. Extra teams (40 NEW rows so we have 48 distinct teams to draw from).
--    Slice 002 seeds 8 teams (ARG, MEX, CAN, POL, ESP, BRA, USA, JPN). We add
--    40 more so 48 group-stage participants are representable. UUIDs use
--    the aaaa0044-* prefix to never collide with slice 002's aaaa0000-*.
--    short_code MUST match the ^[A-Z]{3}$ pattern; we use T01..T40 mapped to
--    'TAA'..'TBN' (three-letter codes generated deterministically from i).
-- ===========================================================================

INSERT INTO public.teams (id, name, short_code, flag_url)
SELECT
  ('aaaa0044-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  'Perftest Team ' || lpad(i::text, 2, '0'),
  -- Build a deterministic 3-uppercase-letter code from i in range 1..40.
  -- 'T' + 2-char base-26 of (i-1) → 'TAA' (i=1) ... 'TBN' (i=40).
  'T' ||
    chr(65 + ((i - 1) / 26) % 26) ||
    chr(65 + ((i - 1) % 26)),
  NULL
FROM generate_series(1, 40) AS i
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 2. auth.users — 500 new perf-test identities.
--    All eligible (@nortal.com). Bcrypt password constant copied from
--    slice 001's pattern so the row shape is byte-identical to existing
--    auth.users rows; tests never authenticate via password (JWTs are
--    synthesised against the local stub IdP) but Supabase's auth schema
--    requires the column to be non-empty for some downstream triggers.
-- ===========================================================================

INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
)
SELECT
  '00000000-0000-0000-0000-000000000000'::uuid,
  ('00000000-0000-0000-0000-0000000a' || lpad(to_hex(i), 4, '0'))::uuid,
  'authenticated',
  'authenticated',
  'perftest-' || lpad(i::text, 4, '0') || '@nortal.com',
  '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  ('{"display_name":"Perftest ' || lpad(i::text, 4, '0') || '"}')::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
FROM generate_series(1, 500) AS i
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 3. participants — 500 new perf-test participant rows.
-- ===========================================================================

INSERT INTO public.participants (
  id,
  auth_user_id,
  email,
  display_name,
  region,
  status,
  first_login_at,
  last_login_at,
  created_at,
  updated_at
)
SELECT
  ('0000a000-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  ('00000000-0000-0000-0000-0000000a' || lpad(to_hex(i), 4, '0'))::uuid,
  'perftest-' || lpad(i::text, 4, '0') || '@nortal.com',
  'Perftest ' || lpad(i::text, 4, '0'),
  'EE-North',
  'active',
  '2026-04-01T10:00:00Z',
  '2026-04-01T10:00:00Z',
  '2026-04-01T10:00:00Z',
  '2026-04-01T10:00:00Z'
FROM generate_series(1, 500) AS i
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 4. matches — 104 finished matches.
--    Split: 48 group-stage (i = 1..48, stage='group', group_id = 'A'..'L' by
--    (i-1)/4), 56 knockout (i = 49..104, stage cycling r16 → qf → sf → final
--    → third_place by chunk size). Team pairings are derived from i so that
--    home_team_id != away_team_id is always satisfied (the
--    matches_distinct_teams CHECK is the load-bearing invariant here).
--
--    Team lookup strategy: we use a CTE that aggregates ALL teams (slice 002's
--    8 + this file's 40 = 48 total) ordered by short_code, then index by
--    row-number. Team N is the (N-1)-th in that ordering.
-- ===========================================================================

WITH ordered_teams AS (
  -- Numbered 1..48 in deterministic order. The ORDER BY short_code gives a
  -- stable ordering across rebuilds; the count is 48 (8 + 40) once this
  -- fixture's teams insert completes.
  SELECT
    id,
    row_number() OVER (ORDER BY short_code) AS team_index
  FROM public.teams
)
INSERT INTO public.matches (
  id, home_team_id, away_team_id, stage, group_id, kickoff_utc, venue, status
)
SELECT
  ('ffff0050-' || lpad(to_hex(i), 4, '0') || '-0000-0000-000000000000')::uuid,
  home.id,
  away.id,
  -- 48 group matches (i = 1..48), then knockout stages.
  CASE
    WHEN i <= 48 THEN 'group'::public.match_stage
    WHEN i <= 80 THEN 'r16'::public.match_stage         -- 32 r16 matches (i = 49..80)
    WHEN i <= 96 THEN 'qf'::public.match_stage          -- 16 qf matches (i = 81..96)
    WHEN i <= 102 THEN 'sf'::public.match_stage         -- 6 sf matches (i = 97..102) - generous buffer
    WHEN i = 103 THEN 'third_place'::public.match_stage -- 1 third-place
    ELSE 'final'::public.match_stage                    -- 1 final (i = 104)
  END,
  -- group_id consistent with stage: 'A'..'L' for groups, NULL for knockout.
  CASE
    WHEN i <= 48 THEN chr(65 + ((i - 1) / 4))::text   -- 4 matches per group, 12 groups A..L
    ELSE NULL
  END,
  -- Kickoffs span 2026-06-11..2026-07-19 deterministically; the exact times
  -- don't matter for the perf gate (every match is 'finished' below).
  ('2026-06-10T20:00:00Z'::timestamptz + (i * INTERVAL '6 hours')),
  'Perftest Venue ' || i::text,
  'finished'::public.match_status
FROM generate_series(1, 104) AS i
JOIN ordered_teams home
  ON home.team_index = (((i - 1) % 48) + 1)
JOIN ordered_teams away
  -- Offset of 24 in mod 48 guarantees home_team_index != away_team_index
  -- for every i (since 24 != 0 mod 48). Pair counts are deterministic.
  ON away.team_index = (((i - 1 + 24) % 48) + 1)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 5. match_results — 104 rows, all 'regulation' 2-1 (home win, deterministic
--    "boring" score so the perf test stresses throughput not correctness).
--    Every match: home_score=2, away_score=1, no extra time, no penalty
--    shootout. home_score_for_scoring=2, away_score_for_scoring=1
--    (matches the match_results_for_scoring_matches CHECK).
-- ===========================================================================

INSERT INTO public.match_results (
  match_id,
  home_score,
  away_score,
  extra_time_home_score,
  extra_time_away_score,
  penalty_home_score,
  penalty_away_score,
  home_score_for_scoring,
  away_score_for_scoring,
  result_status,
  recorded_at,
  recorded_by,
  source
)
SELECT
  ('ffff0050-' || lpad(to_hex(i), 4, '0') || '-0000-0000-000000000000')::uuid,
  2, 1,
  NULL, NULL,
  NULL, NULL,
  2, 1,
  'regulation',
  '2026-06-10T22:00:00Z'::timestamptz + (i * INTERVAL '6 hours'),
  NULL,
  'provider_sync'
FROM generate_series(1, 104) AS i
ON CONFLICT (match_id) DO NOTHING;

-- ===========================================================================
-- 6. predictions — 52,000 rows (500 participants × 104 matches).
--    Each participant predicts EVERY match. Deterministic variety:
--      predicted_home = (i + p) % 5         in 0..4
--      predicted_away = (i + p + 1) % 5     in 0..4
--    where i = match index 1..104, p = participant index 1..500. This yields
--    a mix of exact / outcome / incorrect against the official 2-1 home-win
--    result — perfectly fine for a perf gate (we are NOT asserting any
--    correctness here; only that scope='match' / scope='all' completes
--    under 60 s on a workload of this shape).
--
--    Active-row invariant: every row has superseded_at=NULL +
--    superseded_by=NULL. The (participant_id, match_id) join is one-to-one
--    so predictions_active_uk holds.
--
--    UUID layout: ffff0051-PPPP-MMMM-0000-000000000000 where PPPP = hex(p)
--    and MMMM = hex(i). Both fit in 4 hex chars (p <= 500 < 0x1F4,
--    i <= 104 < 0x68).
-- ===========================================================================

INSERT INTO public.predictions (
  id,
  participant_id,
  match_id,
  predicted_home,
  predicted_away,
  source,
  superseded_at,
  superseded_by,
  created_by,
  submitted_at
)
SELECT
  ('ffff0051-'
    || lpad(to_hex(p), 4, '0') || '-'
    || lpad(to_hex(i), 4, '0') || '-0000-000000000000')::uuid,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid,
  ('ffff0050-' || lpad(to_hex(i), 4, '0') || '-0000-0000-000000000000')::uuid,
  ((i + p) % 5),
  ((i + p + 1) % 5),
  'ui'::public.prediction_source,
  NULL,
  NULL,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid,
  -- Submitted well before kickoff so any lock-window check is trivially
  -- satisfied. The perf test doesn't exercise lock logic; this is purely
  -- defensive against unrelated invariants.
  '2026-06-01T10:00:00Z'::timestamptz
FROM generate_series(1, 500) AS p
CROSS JOIN generate_series(1, 104) AS i
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 7. tournament_award — single row, all four items 'confirmed'.
--    * champion = first ordered team (deterministic) — Argentina under the
--      slice 002 + T044 short_code ordering.
--    * runner_up = second ordered team.
--    * top_scorer = Messi (dddd1000-0000-0000-0000-000000000001 from slice 004).
--    * best_player = Pedri (dddd1000-0000-0000-0000-000000000009 from slice 004).
--
--    The tournament placeholder UUID 00000000-0000-0000-0000-000000000001
--    matches slice-005-fixture's convention so the two fixtures don't fight
--    over the single-row-per-tournament constraint. If slice-005-fixture has
--    already inserted a row at this UUID, ON CONFLICT DO NOTHING leaves it
--    in place — the existing row is compatible with this perf fixture (both
--    fixtures want the awards 'confirmed' on the canonical IDs, modulo
--    best_player which slice-005-fixture leaves pending; for the perf gate
--    we WANT 'confirmed' across the board so score_finals scores all 2,000
--    final_predictions rows in one pass rather than leaving 500 best_player
--    rows in 'final_pending').
-- ===========================================================================

WITH ordered_teams AS (
  SELECT id, row_number() OVER (ORDER BY short_code) AS team_index
  FROM public.teams
)
INSERT INTO public.tournament_award (
  tournament_id,
  champion_team_id, champion_status,
  runner_up_team_id, runner_up_status,
  top_scorer_player_id, top_scorer_status,
  best_player_player_id, best_player_status,
  set_at, set_by
)
SELECT
  '00000000-0000-0000-0000-000000000001'::uuid,
  (SELECT id FROM ordered_teams WHERE team_index = 1), 'confirmed'::public.award_status,
  (SELECT id FROM ordered_teams WHERE team_index = 2), 'confirmed'::public.award_status,
  'dddd1000-0000-0000-0000-000000000001'::uuid, 'confirmed'::public.award_status,
  'dddd1000-0000-0000-0000-000000000009'::uuid, 'confirmed'::public.award_status,
  '2026-07-01T00:00:00Z'::timestamptz,
  NULL
ON CONFLICT (tournament_id) DO NOTHING;

-- ===========================================================================
-- 8. final_predictions — 2,000 rows (500 participants × 4 item_kinds).
--    Deterministic variety: each participant picks one of the 48 teams (for
--    team-kind items) or one of slice 004's three pre-seeded players (for
--    player-kind items), cycling through the available options by index.
--
--    Active-row invariant: exactly one active row per (participant_id,
--    item_kind) pair, no supersede chain.
--
--    UUID layout: ffff0052-PPPP-000K-0000-000000000000 where PPPP = hex(p)
--    and K = 1..4 for the four item kinds.
--
--    target_xor_kind: 'champion'/'runner_up' set target_team_id, leave
--    target_player_id NULL; 'top_scorer'/'best_player' do the inverse.
-- ===========================================================================

-- 8a. champion picks (item_kind='champion') — team-kind.
WITH ordered_teams AS (
  SELECT id, row_number() OVER (ORDER BY short_code) AS team_index
  FROM public.teams
)
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
)
SELECT
  ('ffff0052-' || lpad(to_hex(p), 4, '0') || '-0001-0000-000000000000')::uuid,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid,
  'champion'::public.final_prediction_item_kind,
  t.id,
  NULL,
  'ui'::public.final_prediction_source,
  NULL,
  NULL,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid
FROM generate_series(1, 500) AS p
JOIN ordered_teams t
  -- Cycle through 48 teams: participant p picks team ((p-1) % 48) + 1.
  ON t.team_index = (((p - 1) % 48) + 1)
ON CONFLICT (id) DO NOTHING;

-- 8b. runner_up picks (item_kind='runner_up') — team-kind.
WITH ordered_teams AS (
  SELECT id, row_number() OVER (ORDER BY short_code) AS team_index
  FROM public.teams
)
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
)
SELECT
  ('ffff0052-' || lpad(to_hex(p), 4, '0') || '-0002-0000-000000000000')::uuid,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid,
  'runner_up'::public.final_prediction_item_kind,
  t.id,
  NULL,
  'ui'::public.final_prediction_source,
  NULL,
  NULL,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid
FROM generate_series(1, 500) AS p
JOIN ordered_teams t
  -- Offset by 1 from champion to give a mix of correct vs incorrect picks.
  ON t.team_index = ((p % 48) + 1)
ON CONFLICT (id) DO NOTHING;

-- 8c. top_scorer picks (item_kind='top_scorer') — player-kind.
--     Cycle through the 3 slice-004 players. Only one is the official
--     top_scorer (Messi at index 1) so roughly 1/3 of picks are correct.
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
)
SELECT
  ('ffff0052-' || lpad(to_hex(p), 4, '0') || '-0003-0000-000000000000')::uuid,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid,
  'top_scorer'::public.final_prediction_item_kind,
  NULL,
  CASE ((p - 1) % 3)
    WHEN 0 THEN 'dddd1000-0000-0000-0000-000000000001'::uuid  -- Messi
    WHEN 1 THEN 'dddd1000-0000-0000-0000-000000000011'::uuid  -- Vinícius
    ELSE         'dddd1000-0000-0000-0000-000000000009'::uuid  -- Pedri
  END,
  'ui'::public.final_prediction_source,
  NULL,
  NULL,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid
FROM generate_series(1, 500) AS p
ON CONFLICT (id) DO NOTHING;

-- 8d. best_player picks (item_kind='best_player') — player-kind.
--     Cycle through the same 3 players, offset by 1 so the correct-pick
--     rate is similar but the picks differ from top_scorer.
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
)
SELECT
  ('ffff0052-' || lpad(to_hex(p), 4, '0') || '-0004-0000-000000000000')::uuid,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid,
  'best_player'::public.final_prediction_item_kind,
  NULL,
  CASE (p % 3)
    WHEN 0 THEN 'dddd1000-0000-0000-0000-000000000009'::uuid  -- Pedri (official)
    WHEN 1 THEN 'dddd1000-0000-0000-0000-000000000001'::uuid  -- Messi
    ELSE         'dddd1000-0000-0000-0000-000000000011'::uuid  -- Vinícius
  END,
  'ui'::public.final_prediction_source,
  NULL,
  NULL,
  ('0000a000-0000-0000-0000-' || lpad(to_hex(p), 12, '0'))::uuid
FROM generate_series(1, 500) AS p
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- =============================================================================
-- HAND-VERIFIED ROW COUNTS (post-load; pre-scoring)
-- =============================================================================
-- public.teams (delta over slice 002)   = 8 base + 40 NEW = 48 teams total
-- auth.users (delta)                    = 500 NEW
-- public.participants (delta)           = 500 NEW
-- public.matches (delta)                = 104 NEW (status='finished')
-- public.match_results (delta)          = 104 NEW (all 'regulation', 2-1)
-- public.predictions (delta)            = 52,000 NEW (500 × 104, all active)
-- public.tournament_award (delta)       = 0..1 NEW (idempotent: respects
--                                          slice-005-fixture's pre-existing row)
-- public.final_predictions (delta)      = 2,000 NEW (500 × 4 item_kinds)
--
-- Post-scoring (after a single scope='all' run via the score-trigger Edge
-- Function):
-- public.score_records (T044 contribution) = 52,000 match rows + 2,000 final
--                                            rows = ~54,000 rows at
--                                            calculation_version=N where N is
--                                            the version the run bumps to.
-- public.score_calculation_runs            = 1 row, status='succeeded',
--                                            affected_record_count ≈ 54,000.
--
-- =============================================================================
-- WHAT THIS FIXTURE DELIBERATELY DOES NOT INSERT
-- =============================================================================
-- * NO public.score_records rows. T013 / T019 / T037 own all score_records
--   writes at runtime (the scope='all' Edge Function pass is the canonical
--   entry point — running it produces the ~54K score_records rows that the
--   perf gates measure against).
-- * NO public.score_calculation_runs rows. T013 / T019 / T037 own these
--   (the run_id PK is caller-supplied at write time).
-- * NO admin_roles row attaching any perftest participant to admin — Slice
--   006 owns admin role assignments. The perf gates do not need admin auth;
--   they use the X-Internal-Auth bypass header pattern from T015.
-- * NO modification to slice 001/002/003/004/005's existing fixtures. Every
--   cross-slice UUID this fixture references already exists OR is namespaced
--   to ffff*/aaaa0044*/0xa* prefixes that cannot collide.
-- =============================================================================
