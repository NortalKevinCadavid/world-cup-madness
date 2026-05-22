-- Slice 005 / T043 / SC-003 + SC-008 load-test fixture.
--
-- Generates 500 synthetic Nortal-domain participants + 2,000 final_predictions
-- (one of each item_kind per participant). Designed to be loaded ONLY for the
-- k6 load test (loadtest/slice-005-leaderboard-consistency.k6.ts) AFTER the
-- base slice-005-fixture.sql has been loaded.
--
-- DO NOT load this fixture for unit/integration tests -- the hand-verified
-- leaderboard at the bottom of slice-005-fixture.sql is computed against the
-- 6 base participants only; adding these 500 synthetic rows changes the
-- expected leaderboard ordering and breaks the deterministic pgTAP assertions.
--
-- =============================================================================
-- UUID conventions (avoid collisions with slices 001-005)
-- =============================================================================
-- auth.users:
--   loadtest-XXXX-0000-0000-000000000000  where XXXX is the zero-padded index 0001..0500
--   -- NOTE: 'loadtest' is 8 hex-incompatible chars; we substitute the first 8 hex digits
--   --        of the uuid with the literal hex sequence 'aabbccdd' so the uuid stays
--   --        syntactically valid:
--   --        aabbccdd-XXXX-0000-0000-000000000000
-- participants: same uuid as auth.users.id (1:1).
-- final_predictions:
--   aabbcc01-XXXX-NNNN-0000-000000000000  where NNNN is the item_kind index 0001..0004
--     0001 = champion       (target_team   = ARG)
--     0002 = runner_up      (target_team   = ESP)
--     0003 = top_scorer     (target_player = Messi)
--     0004 = best_player    (target_player = Pedri)
--
-- Existing UUIDs reused (NOT re-inserted):
--   ARG    = aaaa0000-0000-0000-0000-000000000001  (slice 002)
--   ESP    = aaaa0000-0000-0000-0000-000000000005  (slice 002)
--   Messi  = dddd1000-0000-0000-0000-000000000001  (slice 004)
--   Pedri  = dddd1000-0000-0000-0000-000000000009  (slice 004)
--
-- =============================================================================
-- Constraints honored
-- =============================================================================
-- * final_predictions_active_uk (participant_id, item_kind WHERE superseded_at IS NULL):
--     each synthetic participant gets exactly 1 active row per item_kind = 4 active rows,
--     all distinct on (participant_id, item_kind). No conflict with slice 004 or slice 005
--     base fixture rows because every synthetic participant's UUID is new.
-- * Nortal-domain RLS check (Slice 001 is_eligible_nortal_participant):
--     every synthetic email ends in '@nortal.com'. Eligibility predicate trusts the email
--     domain claim; the fixture seeds it directly on auth.users.
--
-- =============================================================================
-- Bcrypt password constant (copied from slice 001 / 005 fixtures for byte-identical rows).
-- Tests NEVER authenticate via password against load-test rows; the k6 reader scenario
-- uses the Supabase anon key, not a per-user JWT.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. auth.users -- 500 synthetic rows.
--    UUIDs use prefix 'aabbccdd' (valid hex) so the uuid stays syntactically valid
--    while remaining easy to grep / clean up after a load-test run.
-- ---------------------------------------------------------------------------

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
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid,
  'authenticated',
  'authenticated',
  'loadtest' || lpad(i::text, 4, '0') || '@nortal.com',
  '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('display_name', 'Load Test ' || i),
  now(),
  now(),
  '',
  '',
  '',
  ''
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. public.participants -- 500 synthetic rows (1:1 with auth.users).
-- ---------------------------------------------------------------------------

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
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid,
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid,
  'loadtest' || lpad(i::text, 4, '0') || '@nortal.com',
  'Load Test ' || i,
  'EE-North',
  'active',
  now(),
  now(),
  now(),
  now()
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. public.final_predictions -- 4 rows per participant = 2,000 rows total.
--
--    Every synthetic participant submits all four item kinds, all pointing at the
--    teams/players that match the slice-005 base fixture's tournament_award --
--    champion=ARG, runner_up=ESP, top_scorer=Messi, best_player=Pedri (pending).
--
--    This means after a full score-trigger pass:
--      * champion (ARG)        scores 'correct'  -> +20 per synthetic participant
--      * runner_up (ESP)       scores 'correct'  -> +20 per synthetic participant
--      * top_scorer (Messi)    scores 'correct'  -> +20 per synthetic participant
--      * best_player (Pedri)   scores 'pending'  ->   0 per synthetic participant
--    -> every synthetic participant ends at final_points = 60 (deterministic; the
--       k6 reader scenario doesn't care about specific values, only consistency).
--
--    No match predictions are seeded: ~52,000 rows are out of scope for a read-
--    consistency test. score_records (final) rows for the 4 item_kinds suffice
--    to populate leaderboard_v with 500 ranked rows.
-- ---------------------------------------------------------------------------

-- champion = ARG (item_kind index 0001)
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
)
SELECT
  ('aabbcc01-' || lpad(i::text, 4, '0') || '-0001-0000-000000000000')::uuid,
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid,
  'champion'::public.final_prediction_item_kind,
  'aaaa0000-0000-0000-0000-000000000001'::uuid,  -- ARG
  NULL,
  'ui'::public.final_prediction_source,
  NULL, NULL,
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

-- runner_up = ESP (item_kind index 0002)
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
)
SELECT
  ('aabbcc01-' || lpad(i::text, 4, '0') || '-0002-0000-000000000000')::uuid,
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid,
  'runner_up'::public.final_prediction_item_kind,
  'aaaa0000-0000-0000-0000-000000000005'::uuid,  -- ESP
  NULL,
  'ui'::public.final_prediction_source,
  NULL, NULL,
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

-- top_scorer = Messi (item_kind index 0003)
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
)
SELECT
  ('aabbcc01-' || lpad(i::text, 4, '0') || '-0003-0000-000000000000')::uuid,
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid,
  'top_scorer'::public.final_prediction_item_kind,
  NULL,
  'dddd1000-0000-0000-0000-000000000001'::uuid,  -- Messi
  'ui'::public.final_prediction_source,
  NULL, NULL,
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

-- best_player = Pedri (item_kind index 0004) -- award is 'pending', so this scores 0.
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
)
SELECT
  ('aabbcc01-' || lpad(i::text, 4, '0') || '-0004-0000-000000000000')::uuid,
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid,
  'best_player'::public.final_prediction_item_kind,
  NULL,
  'dddd1000-0000-0000-0000-000000000009'::uuid,  -- Pedri
  'ui'::public.final_prediction_source,
  NULL, NULL,
  ('aabbccdd-' || lpad(i::text, 4, '0') || '-0000-0000-000000000000')::uuid
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- =============================================================================
-- POST-LOAD ROW-COUNT EXPECTATIONS
-- =============================================================================
-- Run AFTER loading:
--   SELECT count(*) FROM public.participants WHERE email LIKE 'loadtest%@nortal.com';
--     -> 500
--   SELECT count(*) FROM public.final_predictions
--   WHERE participant_id IN (
--     SELECT id FROM public.participants WHERE email LIKE 'loadtest%@nortal.com'
--   );
--     -> 2000
--
-- After a single score-trigger pass:
--   score_records (final, target_kind='final_<item_kind>') = 4 * 500 = 2000 rows
--                                                            for the synthetic
--                                                            participants alone
--                                                            (plus the base
--                                                            fixture's 24 rows
--                                                            for the 6 originals).
--   leaderboard_v row count (current calculation_version)   = 506 participants.
--
-- =============================================================================
-- CLEANUP (to drop the synthetic load-test data only)
-- =============================================================================
--   DELETE FROM public.final_predictions
--   WHERE participant_id IN (
--     SELECT id FROM public.participants WHERE email LIKE 'loadtest%@nortal.com'
--   );
--   DELETE FROM public.participants WHERE email LIKE 'loadtest%@nortal.com';
--   DELETE FROM auth.users          WHERE email LIKE 'loadtest%@nortal.com';
-- =============================================================================
