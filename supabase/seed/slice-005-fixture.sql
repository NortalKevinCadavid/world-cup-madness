-- Slice 005 / T008 / quickstart.md § Seed data.
-- Deterministic fixture: 6 eligible Nortal participants, 1 admin, 1 outsider, 4 matches (3 finished + 1 unfinished),
-- 24 match predictions (4 per participant), 1 tournament_award row, 6 final_predictions, hand-verified leaderboard.
-- Idempotent: every INSERT uses ON CONFLICT DO NOTHING so re-running against an already-seeded DB is safe.
-- READ THE "Hand-verified leaderboard" TRUTH TABLE AT THE BOTTOM BEFORE EDITING ANY DATA -- changes break US1-US4 tests.
--
-- =============================================================================
-- Cross-slice UUID references (verified against prior fixtures)
-- =============================================================================
--
-- Participants pre-seeded by slice 001 (slice-001-fixture.sql):
--   alpha    = 11111111-1111-1111-1111-111111111111   ACTIVE
--   bravo    = 22222222-2222-2222-2222-222222222222   ACTIVE
--   charlie  = 33333333-3333-3333-3333-333333333333   ACTIVE
--   zulu     = 99999999-9999-9999-9999-999999999999   DEACTIVATED (not used by slice 005)
--   outsider = (auth.users 00000000-0000-0000-0000-00000000000e; NO participants row)
--
-- Teams pre-seeded by slice 002 (slice-002-fixture.sql):
--   ARG = aaaa0000-0000-0000-0000-000000000001
--   MEX = aaaa0000-0000-0000-0000-000000000002
--   CAN = aaaa0000-0000-0000-0000-000000000003
--   POL = aaaa0000-0000-0000-0000-000000000004
--   ESP = aaaa0000-0000-0000-0000-000000000005
--   BRA = aaaa0000-0000-0000-0000-000000000006
--   USA = aaaa0000-0000-0000-0000-000000000007
--   JPN = aaaa0000-0000-0000-0000-000000000008
--
-- Players pre-seeded by slice 004 (slice-004-fixture.sql):
--   Messi    = dddd1000-0000-0000-0000-000000000001   (ARG, FW)
--   Vinícius = dddd1000-0000-0000-0000-000000000011   (BRA, FW)
--   Pedri    = dddd1000-0000-0000-0000-000000000009   (ESP, MF)
--
-- Final predictions pre-seeded by slice 004 (NOT re-inserted by T008; they remain active and contribute to
-- the participant's final-prediction score):
--   alpha    champion=ARG, runner_up=ESP, top_scorer=Messi  (all 3 will score CORRECT against this fixture's award)
--   bravo    champion=BRA, top_scorer=Vinícius              (both INCORRECT against this fixture's award)
--   charlie  best_player=Pedri                              (PENDING -- award best_player_status='pending')
--
-- =============================================================================
-- Slice 005 UUID conventions (avoid collisions with slices 001-004)
-- =============================================================================
--
-- auth.users (new):
--   00000000-0000-0000-0000-0000000000d0  delta      (eligible/active)
--   00000000-0000-0000-0000-0000000000d1  epsilon    (eligible/active)
--   00000000-0000-0000-0000-0000000000d2  zeta       (eligible/active)
--   00000000-0000-0000-0000-0000000000d3  admin1     (eligible/active, admin role TBD by Slice 006)
--
-- participants (new):
--   44444444-4444-4444-4444-444444444444  delta
--   55555555-5555-5555-5555-555555555555  epsilon
--   66666666-6666-6666-6666-666666666666  zeta
--   77777777-7777-7777-7777-777777777777  admin1
--
-- tournaments (no table yet -- single uuid placeholder per data-model § Entity 3):
--   00000000-0000-0000-0000-000000000001  the single 2026 FIFA World Cup tournament
--
-- matches (new -- distinct from slice 002's 8 fixtures so M1..M3 scores can be authored deterministically
-- WITHOUT colliding with slice 002's existing M1 (ARG-MEX 2-0) match_results row):
--   eeee0050-0000-0000-0000-000000000001  M1  ARG vs MEX  finished     2026-06-01T20:00:00Z  -> result 2-1
--   eeee0050-0000-0000-0000-000000000002  M2  ESP vs BRA  finished     2026-06-02T20:00:00Z  -> result 0-0
--   eeee0050-0000-0000-0000-000000000003  M3  CAN vs USA  finished     2026-06-03T20:00:00Z  -> result 1-2
--   eeee0050-0000-0000-0000-000000000004  M4  POL vs JPN  scheduled    2027-07-01T20:00:00Z  -> unfinished (kickoff in future, well outside lock_window)
--
-- predictions (new): 24 rows = 4 per participant x 6 participants. UUID pattern:
--   eeee0051-<participant_short>-<match_short>-0000-000000000000  -- composite, see comments below.
--
-- final_predictions (new -- 6 rows, one per participant, all on item_kind slots NOT occupied by slice 004):
--   eeee0052-0000-0000-0000-000000000001  alpha    best_player = Pedri      (pending -> 0)
--   eeee0052-0000-0000-0000-000000000002  bravo    runner_up   = ESP        (correct -> +20)
--   eeee0052-0000-0000-0000-000000000003  charlie  champion    = ARG        (correct -> +20)
--   eeee0052-0000-0000-0000-000000000004  delta    top_scorer  = Messi      (correct -> +20)
--   eeee0052-0000-0000-0000-000000000005  epsilon  champion    = BRA        (wrong   ->   0)
--   eeee0052-0000-0000-0000-000000000006  zeta     best_player = Pedri      (pending ->   0)
--
-- =============================================================================
-- Constraints honored
-- =============================================================================
-- * predictions_active_uk (participant_id, match_id WHERE superseded_at IS NULL): one active prediction per (participant, match) -- all 24 T008 inserts respect this.
-- * final_predictions_active_uk (participant_id, item_kind WHERE superseded_at IS NULL): T008 picks ONLY item_kind slots that slice 004 did not already occupy for alpha/bravo/charlie -- alpha gets best_player (slice 004 left it free), bravo gets runner_up (slice 004 left it free), charlie gets champion (slice 004 left it free).
-- * tournament_award single-row-per-tournament: one row keyed by tournament_id placeholder uuid.
-- * Slice 005 migrations 0049-0057 exist on disk (slot 0049 score_records, 0050 score_calculation_runs, 0051 tournament_award, 0056 RLS, 0057 config defaults); slots 0052-0055 (score_match SP, score_finals SP, views, audit trigger) are NOT yet shipped. This fixture DOES NOT INSERT into score_records or score_calculation_runs -- those rows are produced exclusively at runtime by score_match (T013) and score_finals (T019).
--
-- =============================================================================
-- Bcrypt password constant (copied from slice 001 fixture for byte-identical auth.users rows).
-- Tests NEVER authenticate via password; JWTs are synthesised against the local stub IdP.
-- =============================================================================

BEGIN;

-- ===========================================================================
-- 1. auth.users -- 4 new rows (delta, epsilon, zeta, admin1).
--    alpha/bravo/charlie/zulu/outsider already exist via slice-001-fixture.sql.
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
) VALUES
  -- delta -- eligible, active
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-0000000000d0',
    'authenticated',
    'authenticated',
    'delta@nortal.com',
    '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Delta"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  -- epsilon -- eligible, active
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-0000000000d1',
    'authenticated',
    'authenticated',
    'epsilon@nortal.com',
    '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Epsilon"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  -- zeta -- eligible, active
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-0000000000d2',
    'authenticated',
    'authenticated',
    'zeta@nortal.com',
    '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Zeta"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  -- admin1 -- eligible, active. Admin role itself is owned by Slice 006 (admin_roles table TBD);
  -- this fixture only ships the auth.users + participants identity. Tests that need an "admin JWT"
  -- synthesise it against this row + a slice-006-side admin_roles row, OR temporarily flip
  -- is_admin(...) in pgTAP via the SECURITY DEFINER hook -- both are slice-006 concerns.
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-0000000000d3',
    'authenticated',
    'authenticated',
    'admin1@nortal.com',
    '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Admin One"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  )
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 2. public.participants -- 4 new rows (delta, epsilon, zeta, admin1).
--    alpha/bravo/charlie/zulu already exist via slice-001-fixture.sql.
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
) VALUES
  -- delta
  (
    '44444444-4444-4444-4444-444444444444',
    '00000000-0000-0000-0000-0000000000d0',
    'delta@nortal.com',
    'Delta',
    'EE-North',
    'active',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z'
  ),
  -- epsilon
  (
    '55555555-5555-5555-5555-555555555555',
    '00000000-0000-0000-0000-0000000000d1',
    'epsilon@nortal.com',
    'Epsilon',
    'EE-North',
    'active',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z'
  ),
  -- zeta
  (
    '66666666-6666-6666-6666-666666666666',
    '00000000-0000-0000-0000-0000000000d2',
    'zeta@nortal.com',
    'Zeta',
    'EE-North',
    'active',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z'
  ),
  -- admin1 (admin role assignment is Slice 006's job; here we only seed the identity)
  (
    '77777777-7777-7777-7777-777777777777',
    '00000000-0000-0000-0000-0000000000d3',
    'admin1@nortal.com',
    'Admin One',
    'EE-North',
    'active',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z'
  )
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 3. public.matches -- 4 new rows.
--    Distinct from slice 002's 8 matches so M1..M3 official scores below can be authored
--    deterministically (slice 002's only finished match is its own M1 ARG-MEX 2-0 -- we
--    intentionally do NOT reuse that match_id; we use eeee0050-... uuids instead).
-- ===========================================================================

INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, venue, status) VALUES
  -- M1: ARG vs MEX, finished, official score 2-1 below
  ('eeee0050-0000-0000-0000-000000000001',
   'aaaa0000-0000-0000-0000-000000000001',  -- ARG (home)
   'aaaa0000-0000-0000-0000-000000000002',  -- MEX (away)
   'group', 'A', '2026-06-01T20:00:00Z', 'Estadio Azteca (slice-005 fixture)', 'finished'),
  -- M2: ESP vs BRA, finished, official score 0-0 below
  ('eeee0050-0000-0000-0000-000000000002',
   'aaaa0000-0000-0000-0000-000000000005',  -- ESP (home)
   'aaaa0000-0000-0000-0000-000000000006',  -- BRA (away)
   'group', 'B', '2026-06-02T20:00:00Z', 'Mercedes-Benz Stadium (slice-005 fixture)', 'finished'),
  -- M3: CAN vs USA, finished, official score 1-2 below
  ('eeee0050-0000-0000-0000-000000000003',
   'aaaa0000-0000-0000-0000-000000000003',  -- CAN (home)
   'aaaa0000-0000-0000-0000-000000000007',  -- USA (away)
   'group', 'A', '2026-06-03T20:00:00Z', 'BMO Field (slice-005 fixture)', 'finished'),
  -- M4: POL vs JPN, scheduled, kickoff in 2027 (well outside any 60-minute lock_window)
  ('eeee0050-0000-0000-0000-000000000004',
   'aaaa0000-0000-0000-0000-000000000004',  -- POL (home)
   'aaaa0000-0000-0000-0000-000000000008',  -- JPN (away)
   'group', 'B', '2027-07-01T20:00:00Z', 'NRG Stadium (slice-005 fixture)', 'scheduled')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 4. public.match_results -- 3 rows (M1, M2, M3).
--    home_score_for_scoring / away_score_for_scoring are LOCKED cross-slice contract
--    names (slice 002 / 0021_match_results.sql) that slice 005's score_match reads.
--    All three matches conclude in regulation (no extra time, no penalty shootout).
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
) VALUES
  -- M1 official: 2-1 (ARG home win)
  ('eeee0050-0000-0000-0000-000000000001', 2, 1, NULL, NULL, NULL, NULL, 2, 1, 'regulation', '2026-06-01T22:00:00Z', NULL, 'provider_sync'),
  -- M2 official: 0-0 (draw)
  ('eeee0050-0000-0000-0000-000000000002', 0, 0, NULL, NULL, NULL, NULL, 0, 0, 'regulation', '2026-06-02T22:00:00Z', NULL, 'provider_sync'),
  -- M3 official: 1-2 (USA away win)
  ('eeee0050-0000-0000-0000-000000000003', 1, 2, NULL, NULL, NULL, NULL, 1, 2, 'regulation', '2026-06-03T22:00:00Z', NULL, 'provider_sync')
ON CONFLICT (match_id) DO NOTHING;

-- ===========================================================================
-- 5. public.predictions -- 24 rows = 4 (M1..M4) x 6 participants.
--
--    Per-prediction (participant, match, predicted_home-predicted_away, reason_code, points)
--    derived from the truth table at the bottom of this file. M4 (unfinished) predictions
--    score 'none' / 0 until M4 finishes (out of scope for this fixture).
--
--    UUID pattern: eeee0051-<participant-letter>-<match-N>-0000-000000000000 -- but UUIDs
--    require 32 hex digits in 5 groups (8-4-4-4-12); we substitute the participant letter
--    into the second-group position (a..f) and match index into the third-group position.
--
--    Submitted_at: 1 hour pre-kickoff for finished matches (well before the 60-minute
--    BR-LOCK-002 lock_window so the prediction is "valid" at lock time); 90 days
--    pre-kickoff for M4 (well outside any window).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- alpha (participant_id 1111...): all 3 finished matches = EXACT (3x +10), M4 = no-score-yet
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES
  ('eeee0051-000a-0001-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'eeee0050-0000-0000-0000-000000000001', 2, 1, 'ui', NULL, NULL, '11111111-1111-1111-1111-111111111111', '2026-06-01T19:00:00Z'),  -- M1 2-1 -> exact
  ('eeee0051-000a-0002-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'eeee0050-0000-0000-0000-000000000002', 0, 0, 'ui', NULL, NULL, '11111111-1111-1111-1111-111111111111', '2026-06-02T19:00:00Z'),  -- M2 0-0 -> exact
  ('eeee0051-000a-0003-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'eeee0050-0000-0000-0000-000000000003', 1, 2, 'ui', NULL, NULL, '11111111-1111-1111-1111-111111111111', '2026-06-03T19:00:00Z'),  -- M3 1-2 -> exact
  ('eeee0051-000a-0004-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'eeee0050-0000-0000-0000-000000000004', 1, 1, 'ui', NULL, NULL, '11111111-1111-1111-1111-111111111111', '2027-04-01T10:00:00Z')   -- M4 1-1 -> no-score-yet
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- bravo (participant_id 2222...): M1 EXACT, M2 OUTCOME (draw -> 1-1), M3 OUTCOME (away win -> 0-1), M4 -- yields 1 exact + 2 outcomes -> 10+5+5=20 match points; +20 final (runner_up=ESP correct) = 40 total. Tied with charlie on total, tier 2 (exact_count) ranks charlie higher.
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES
  ('eeee0051-000b-0001-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'eeee0050-0000-0000-0000-000000000001', 2, 1, 'ui', NULL, NULL, '22222222-2222-2222-2222-222222222222', '2026-06-01T19:00:00Z'),  -- M1 2-1 -> exact
  ('eeee0051-000b-0002-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'eeee0050-0000-0000-0000-000000000002', 1, 1, 'ui', NULL, NULL, '22222222-2222-2222-2222-222222222222', '2026-06-02T19:00:00Z'),  -- M2 1-1 -> outcome (draw)
  ('eeee0051-000b-0003-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'eeee0050-0000-0000-0000-000000000003', 0, 1, 'ui', NULL, NULL, '22222222-2222-2222-2222-222222222222', '2026-06-03T19:00:00Z'),  -- M3 0-1 -> outcome (away win)
  ('eeee0051-000b-0004-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'eeee0050-0000-0000-0000-000000000004', 2, 2, 'ui', NULL, NULL, '22222222-2222-2222-2222-222222222222', '2027-04-01T10:00:00Z')   -- M4 2-2 -> no-score-yet
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- charlie (participant_id 3333...): M1 EXACT, M2 INCORRECT (1-0 -> home win, not draw), M3 EXACT, M4 -- yields 2 exact + 0 outcome = 20 match; +20 final (champion=ARG correct, T008-new) = 40 total. Tied with bravo on total, but charlie's exact_count (2) > bravo's (1) -> charlie ranks higher.
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES
  ('eeee0051-000c-0001-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'eeee0050-0000-0000-0000-000000000001', 2, 1, 'ui', NULL, NULL, '33333333-3333-3333-3333-333333333333', '2026-06-01T19:00:00Z'),  -- M1 2-1 -> exact
  ('eeee0051-000c-0002-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'eeee0050-0000-0000-0000-000000000002', 1, 0, 'ui', NULL, NULL, '33333333-3333-3333-3333-333333333333', '2026-06-02T19:00:00Z'),  -- M2 1-0 -> incorrect (home win vs draw)
  ('eeee0051-000c-0003-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'eeee0050-0000-0000-0000-000000000003', 1, 2, 'ui', NULL, NULL, '33333333-3333-3333-3333-333333333333', '2026-06-03T19:00:00Z'),  -- M3 1-2 -> exact
  ('eeee0051-000c-0004-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'eeee0050-0000-0000-0000-000000000004', 0, 0, 'ui', NULL, NULL, '33333333-3333-3333-3333-333333333333', '2027-04-01T10:00:00Z')   -- M4 0-0 -> no-score-yet
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- delta (participant_id 4444...): M1 OUTCOME (3-1), M2 OUTCOME (2-2), M3 INCORRECT (0-0 vs 1-2 -> draw not away win); +20 final (top_scorer=Messi correct, T008-new) = 30 total.
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES
  ('eeee0051-000d-0001-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'eeee0050-0000-0000-0000-000000000001', 3, 1, 'ui', NULL, NULL, '44444444-4444-4444-4444-444444444444', '2026-06-01T19:00:00Z'),  -- M1 3-1 -> outcome (home win)
  ('eeee0051-000d-0002-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'eeee0050-0000-0000-0000-000000000002', 2, 2, 'ui', NULL, NULL, '44444444-4444-4444-4444-444444444444', '2026-06-02T19:00:00Z'),  -- M2 2-2 -> outcome (draw)
  ('eeee0051-000d-0003-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'eeee0050-0000-0000-0000-000000000003', 0, 0, 'ui', NULL, NULL, '44444444-4444-4444-4444-444444444444', '2026-06-03T19:00:00Z'),  -- M3 0-0 -> incorrect (draw vs away win)
  ('eeee0051-000d-0004-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'eeee0050-0000-0000-0000-000000000004', 1, 2, 'ui', NULL, NULL, '44444444-4444-4444-4444-444444444444', '2027-04-01T10:00:00Z')   -- M4 1-2 -> no-score-yet
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- epsilon (participant_id 5555...): M1 INCORRECT (0-2 -> away win vs home win), M2 INCORRECT (1-0 -> home win vs draw), M3 EXACT (1-2); +0 final (champion=BRA wrong) = 10 total. exact_count=1.
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES
  ('eeee0051-000e-0001-0000-000000000000', '55555555-5555-5555-5555-555555555555', 'eeee0050-0000-0000-0000-000000000001', 0, 2, 'ui', NULL, NULL, '55555555-5555-5555-5555-555555555555', '2026-06-01T19:00:00Z'),  -- M1 0-2 -> incorrect (away win vs home win)
  ('eeee0051-000e-0002-0000-000000000000', '55555555-5555-5555-5555-555555555555', 'eeee0050-0000-0000-0000-000000000002', 1, 0, 'ui', NULL, NULL, '55555555-5555-5555-5555-555555555555', '2026-06-02T19:00:00Z'),  -- M2 1-0 -> incorrect (home win vs draw)
  ('eeee0051-000e-0003-0000-000000000000', '55555555-5555-5555-5555-555555555555', 'eeee0050-0000-0000-0000-000000000003', 1, 2, 'ui', NULL, NULL, '55555555-5555-5555-5555-555555555555', '2026-06-03T19:00:00Z'),  -- M3 1-2 -> exact
  ('eeee0051-000e-0004-0000-000000000000', '55555555-5555-5555-5555-555555555555', 'eeee0050-0000-0000-0000-000000000004', 3, 3, 'ui', NULL, NULL, '55555555-5555-5555-5555-555555555555', '2027-04-01T10:00:00Z')   -- M4 3-3 -> no-score-yet
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- zeta (participant_id 6666...): all 3 finished matches INCORRECT (predictions yield wrong winner each time); +0 final (best_player=Pedri pending) = 0 total. The "rock-bottom" anchor.
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES
  ('eeee0051-000f-0001-0000-000000000000', '66666666-6666-6666-6666-666666666666', 'eeee0050-0000-0000-0000-000000000001', 1, 2, 'ui', NULL, NULL, '66666666-6666-6666-6666-666666666666', '2026-06-01T19:00:00Z'),  -- M1 1-2 -> incorrect (away win vs home win)
  ('eeee0051-000f-0002-0000-000000000000', '66666666-6666-6666-6666-666666666666', 'eeee0050-0000-0000-0000-000000000002', 1, 0, 'ui', NULL, NULL, '66666666-6666-6666-6666-666666666666', '2026-06-02T19:00:00Z'),  -- M2 1-0 -> incorrect (home win vs draw)
  ('eeee0051-000f-0003-0000-000000000000', '66666666-6666-6666-6666-666666666666', 'eeee0050-0000-0000-0000-000000000003', 2, 0, 'ui', NULL, NULL, '66666666-6666-6666-6666-666666666666', '2026-06-03T19:00:00Z'),  -- M3 2-0 -> incorrect (home win vs away win)
  ('eeee0051-000f-0004-0000-000000000000', '66666666-6666-6666-6666-666666666666', 'eeee0050-0000-0000-0000-000000000004', 0, 1, 'ui', NULL, NULL, '66666666-6666-6666-6666-666666666666', '2027-04-01T10:00:00Z')   -- M4 0-1 -> no-score-yet
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 6. public.tournament_award -- 1 row.
--    champion=ARG confirmed, runner_up=ESP confirmed, top_scorer=Messi confirmed,
--    best_player=PENDING (exercises R-008 Golden Ball delay edge case).
-- ===========================================================================

INSERT INTO public.tournament_award (
  tournament_id,
  champion_team_id, champion_status,
  runner_up_team_id, runner_up_status,
  top_scorer_player_id, top_scorer_status,
  best_player_player_id, best_player_status,
  set_at, set_by
)
VALUES (
  '00000000-0000-0000-0000-000000000001',                    -- the single 2026 tournament placeholder uuid
  'aaaa0000-0000-0000-0000-000000000001', 'confirmed',       -- champion = ARG
  'aaaa0000-0000-0000-0000-000000000005', 'confirmed',       -- runner_up = ESP
  'dddd1000-0000-0000-0000-000000000001', 'confirmed',       -- top_scorer = Messi
  NULL,                                    'pending',        -- best_player = PENDING (Golden Ball not yet awarded)
  '2026-07-01T00:00:00Z',
  NULL                                                       -- system-seeded (no admin attribution)
)
ON CONFLICT (tournament_id) DO NOTHING;

-- ===========================================================================
-- 7. public.final_predictions -- 6 NEW rows (one per participant).
--
--    These are ADDITIONAL to slice 004's 6 pre-seeded rows. Each T008-new row uses an
--    item_kind that slice 004 did NOT already populate for that participant (the
--    final_predictions_active_uk unique partial index forbids two active rows for the
--    same (participant, item_kind)).
--
--    Slice 004 actives by participant:
--      alpha:   champion (ARG), runner_up (ESP), top_scorer (Messi)   -> free slot: best_player
--      bravo:   champion (BRA), top_scorer (Vinícius)                 -> free slots: runner_up, best_player
--      charlie: best_player (Pedri)                                   -> free slots: champion, runner_up, top_scorer
--      delta/epsilon/zeta: (none)                                     -> all 4 slots free
-- ===========================================================================

-- Row 1: alpha -- best_player = Pedri. Award status 'pending' -> 0 points (reason 'final_pending').
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'eeee0052-0000-0000-0000-000000000001'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'best_player',
  NULL, 'dddd1000-0000-0000-0000-000000000009'::uuid,
  'ui', NULL, NULL,
  '11111111-1111-1111-1111-111111111111'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- Row 2: bravo -- runner_up = ESP. Matches award.runner_up_team_id; status 'confirmed' -> +20 (reason 'final_correct').
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'eeee0052-0000-0000-0000-000000000002'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid,
  'runner_up',
  'aaaa0000-0000-0000-0000-000000000005'::uuid, NULL,
  'ui', NULL, NULL,
  '22222222-2222-2222-2222-222222222222'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- Row 3: charlie -- champion = ARG. Matches award.champion_team_id; status 'confirmed' -> +20 (reason 'final_correct').
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'eeee0052-0000-0000-0000-000000000003'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,
  'champion',
  'aaaa0000-0000-0000-0000-000000000001'::uuid, NULL,
  'ui', NULL, NULL,
  '33333333-3333-3333-3333-333333333333'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- Row 4: delta -- top_scorer = Messi. Matches award.top_scorer_player_id; status 'confirmed' -> +20 (reason 'final_correct').
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'eeee0052-0000-0000-0000-000000000004'::uuid,
  '44444444-4444-4444-4444-444444444444'::uuid,
  'top_scorer',
  NULL, 'dddd1000-0000-0000-0000-000000000001'::uuid,
  'ui', NULL, NULL,
  '44444444-4444-4444-4444-444444444444'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- Row 5: epsilon -- champion = BRA. Does NOT match award.champion_team_id (ARG); status 'confirmed' -> 0 (reason 'final_incorrect').
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'eeee0052-0000-0000-0000-000000000005'::uuid,
  '55555555-5555-5555-5555-555555555555'::uuid,
  'champion',
  'aaaa0000-0000-0000-0000-000000000006'::uuid, NULL,
  'ui', NULL, NULL,
  '55555555-5555-5555-5555-555555555555'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- Row 6: zeta -- best_player = Pedri. Award status 'pending' -> 0 points (reason 'final_pending').
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'eeee0052-0000-0000-0000-000000000006'::uuid,
  '66666666-6666-6666-6666-666666666666'::uuid,
  'best_player',
  NULL, 'dddd1000-0000-0000-0000-000000000009'::uuid,
  'ui', NULL, NULL,
  '66666666-6666-6666-6666-666666666666'::uuid
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- =============================================================================
-- HAND-VERIFIED LEADERBOARD (post-scoring; calculation_version = 1)
-- =============================================================================
-- Tournament_config values assumed (slice 005 / migration 0057_score_config_defaults.sql):
--   match_points.exact     = 10
--   match_points.outcome   = 5
--   match_points.incorrect = 0
--   final_points.each_item = 20
--   tiebreaker.order       = ['total','exact_count','outcome_count','final_points']
--   tiebreaker.rank_function = 'rank' (NOT dense_rank)
--
-- M1 official: 2-1 (ARG home win). M2 official: 0-0 (draw). M3 official: 1-2 (USA away win).
-- M4 unfinished (kickoff 2027-07-01) -- predictions exist, no score_records produced for M4 yet.
--
-- tournament_award:
--   champion   = ARG       confirmed
--   runner_up  = ESP       confirmed
--   top_scorer = Messi     confirmed
--   best_player= NULL      pending     <-- exercises R-008 Golden Ball delay (final_pending -> 0 points)
--
-- Per-participant final-prediction roll-up (combines slice 004 actives + T008 new):
--   alpha (slice4: champion=ARG[+20] + runner_up=ESP[+20] + top_scorer=Messi[+20]) + (T008: best_player=Pedri[pending=0]) = 60
--   bravo (slice4: champion=BRA[0]  + top_scorer=Vinícius[0])                       + (T008: runner_up=ESP[+20])         = 20
--   charlie (slice4: best_player=Pedri[pending=0])                                  + (T008: champion=ARG[+20])          = 20
--   delta (slice4: -)                                                               + (T008: top_scorer=Messi[+20])      = 20
--   epsilon (slice4: -)                                                             + (T008: champion=BRA[0])            =  0
--   zeta (slice4: -)                                                                + (T008: best_player=Pedri[pending=0]) =  0
--
-- Per-participant match scoring (each (participant, match) row in score_records,
-- target_kind='match', calculation_version=1):
--
-- | Participant | M1 (off 2-1) pred / pts / rsn         | M2 (off 0-0) pred / pts / rsn         | M3 (off 1-2) pred / pts / rsn         | M_match | exact | outcome |
-- |-------------|---------------------------------------|---------------------------------------|---------------------------------------|--------:|------:|--------:|
-- | alpha       | 2-1 / 10 / exact                       | 0-0 / 10 / exact                       | 1-2 / 10 / exact                       |      30 |     3 |       0 |
-- | bravo       | 2-1 / 10 / exact                       | 1-1 /  5 / outcome (draw)              | 0-1 /  5 / outcome (away win)          |      20 |     1 |       2 |
-- | charlie     | 2-1 / 10 / exact                       | 1-0 /  0 / incorrect (home win vs draw)| 1-2 / 10 / exact                       |      20 |     2 |       0 |
-- | delta       | 3-1 /  5 / outcome (home win)          | 2-2 /  5 / outcome (draw)              | 0-0 /  0 / incorrect (draw vs away)    |      10 |     0 |       2 |
-- | epsilon     | 0-2 /  0 / incorrect (away vs home)    | 1-0 /  0 / incorrect (home win vs draw)| 1-2 / 10 / exact                       |      10 |     1 |       0 |
-- | zeta        | 1-2 /  0 / incorrect (away vs home)    | 1-0 /  0 / incorrect (home win vs draw)| 2-0 /  0 / incorrect (home win vs away)|       0 |     0 |       0 |
--
-- Final leaderboard (sorted by total DESC, exact_count DESC, outcome_count DESC, final_points DESC):
--
-- | rank | Participant | display_name | total | exact_count | outcome_count | final_points | tie-break tier exercised               |
-- |-----:|-------------|--------------|------:|------------:|--------------:|-------------:|----------------------------------------|
-- |    1 | alpha       | Alpha        |    90 |           3 |             0 |           60 | n/a (clear leader)                      |
-- |    2 | charlie     | Charlie      |    40 |           2 |             0 |           20 | tier 2: exact_count breaks tie vs bravo |
-- |    3 | bravo       | Bravo        |    40 |           1 |             2 |           20 | tier 2 loser (exact_count=1 < charlie's 2) |
-- |    4 | delta       | Delta        |    30 |           0 |             2 |           20 | n/a (clear)                             |
-- |    5 | epsilon     | Epsilon      |    10 |           1 |             0 |            0 | n/a (clear)                             |
-- |    6 | zeta        | Zeta         |     0 |           0 |             0 |            0 | n/a (anchor)                            |
--
-- Tie-breaker design verification:
--   * total=40 tie between charlie (exact=2, outcome=0) and bravo (exact=1, outcome=2):
--     tier 2 (exact_count DESC) ranks charlie #2 and bravo #3. This is the only tie in
--     the fixture; it is intentional and is the assertion target for the
--     leaderboard_tie_breakers pgTAP test (T026).
--   * No shared-rank residual tie is exercised by this fixture (a separate test fixture
--     in T028 / leaderboard_shared_rank.sql adds a residual-tie row pair if needed).
--   * delta total=30 ties with no one; epsilon total=10 ties with no one; zeta total=0
--     ties with no one -- the gaps in the totals column are deliberate to keep the
--     hand-verification straightforward.
--
-- Audit row count expected after a single full score-trigger pass (score_match for each
-- of M1/M2/M3 + score_finals once):
--   score_records (match)  = 3 matches x 6 participants = 18 rows (calculation_version=1)
--   score_records (final)  = 4 final-item kinds x 6 participants = 24 rows
--                            (alpha: 3 from slice 004 + 1 from T008 = 4; bravo: 2+1=3 -- wait,
--                            this is total *picks per participant*, but score_finals emits ONE
--                            row per (participant, final_item_kind) regardless of how many
--                            active picks the participant has -- and slice 004 + T008 between
--                            them cover EXACTLY one active row per (participant, item_kind)
--                            for every (participant, item_kind) pair we ship picks for, by the
--                            final_predictions_active_uk constraint.)
--                            Per data-model.md § Entity 1, score_finals emits one row per
--                            (participant, final_item_kind) for the four item_kinds. For
--                            participants that did NOT submit any pick for a given item_kind,
--                            score_finals MAY emit a 'none'-reason row or skip the row
--                            entirely -- the choice is T019's implementation detail, not
--                            T008's fixture concern.
--   audit_log              = 18 match + 24 final = 42 inserts (one per score_records row),
--                            modulo the score_finals "none-vs-skip" choice noted above.
--
-- =============================================================================
-- WHAT THIS FIXTURE DELIBERATELY DOES NOT INSERT
-- =============================================================================
-- * NO public.score_records rows. T013 (score_match SP, migration slot 0052) and T019
--   (score_finals SP, slot 0053) own all score_records writes at runtime.
-- * NO public.score_calculation_runs rows. T013 / T019 own these writes (research § R-002:
--   the run_id PK is caller-supplied at write time, not seeded in advance).
-- * NO admin_roles row attaching admin1 to an admin role -- Slice 006 owns that table.
--   Tests that need an "admin JWT" synthesise the role via the slice-006 SECURITY DEFINER
--   path; the participants row for admin1 is the only T008 contribution to the admin surface.
-- * NO modification to slice 001/002/003/004 fixtures. Every cross-slice UUID this fixture
--   references is already on disk via the prior fixtures; this file is strictly additive.
-- =============================================================================
