-- Slice 004 fixture: 16 players (2 per team × 8 teams) + 16 stub provider mappings + 6 sample final_predictions covering all 4 item_kinds across alpha/bravo/charlie. Loaded after slice 001+002+003 fixtures during supabase db reset. Idempotent.
--
-- Tables touched (by INSERT, with ON CONFLICT DO NOTHING on each PK):
--   public.players                      -- 16 rows
--   public.player_provider_external_ids -- 16 rows
--   public.final_predictions            --  6 rows
--
-- Tables NOT touched: audit_log (T008's audit triggers fire automatically on
-- the final_predictions inserts); teams / participants (slice 001/002 own
-- those); tournament_config (slice 003 already seeded first_kickoff_utc).
--
-- Deterministic UUID conventions (avoid collisions with slices 001/002/003):
--   Players               : dddd1000-0000-0000-0000-0000000000NN   (NN = 01..16)
--   Provider mappings     : dddd1500-0000-0000-0000-0000000000NN   (NN = 01..16)
--   Final predictions     : dddd2000-0000-0000-0000-0000000000NN   (NN = 01..06)
--
-- Cross-slice UUID references (verified against prior fixtures):
--   Participants (slice 001):
--     alpha    = 11111111-1111-1111-1111-111111111111  (ACTIVE)
--     bravo    = 22222222-2222-2222-2222-222222222222  (ACTIVE)
--     charlie  = 33333333-3333-3333-3333-333333333333  (ACTIVE)
--   Teams (slice 002):
--     ARG = aaaa0000-0000-0000-0000-000000000001
--     MEX = aaaa0000-0000-0000-0000-000000000002
--     CAN = aaaa0000-0000-0000-0000-000000000003
--     POL = aaaa0000-0000-0000-0000-000000000004
--     ESP = aaaa0000-0000-0000-0000-000000000005
--     BRA = aaaa0000-0000-0000-0000-000000000006
--     USA = aaaa0000-0000-0000-0000-000000000007
--     JPN = aaaa0000-0000-0000-0000-000000000008
--
-- Player roster (2 per team × 8 teams = 16):
--   01 Lionel Messi          (FW) ARG
--   02 Julián Álvarez        (FW) ARG
--   03 Hirving Lozano        (MF) MEX
--   04 Raúl Jiménez          (FW) MEX
--   05 Alphonso Davies       (DF) CAN
--   06 Jonathan David        (FW) CAN
--   07 Robert Lewandowski    (FW) POL
--   08 Piotr Zieliński       (MF) POL
--   09 Pedri                 (MF) ESP
--   10 Lamine Yamal          (FW) ESP
--   11 Vinícius Júnior       (FW) BRA
--   12 Endrick               (FW) BRA
--   13 Christian Pulisic     (FW) USA
--   14 Tyler Adams           (MF) USA
--   15 Takefusa Kubo         (FW) JPN
--   16 Wataru Endo           (MF) JPN
--
-- Final-prediction picks (6 rows; 4 item_kinds across 3 participants):
--   01 alpha   champion    -> ARG    (team-kind)
--   02 alpha   runner_up   -> ESP    (team-kind)
--   03 alpha   top_scorer  -> Messi  (player-kind, player 01)
--   04 bravo   champion    -> BRA    (team-kind)
--   05 bravo   top_scorer  -> Vinícius (player-kind, player 11)
--   06 charlie best_player -> Pedri  (player-kind, player 09)
--
-- All six rows are active (superseded_at = NULL, superseded_by = NULL),
-- source = 'ui', created_by = participant_id. Inserts respect the
-- final_predictions_target_xor_kind CHECK: team-kind rows populate
-- target_team_id only; player-kind rows populate target_player_id only.

BEGIN;

-- ===========================================================================
-- Players
-- ===========================================================================

INSERT INTO public.players (id, full_name, display_name, team_id, country_code, position) VALUES
  ('dddd1000-0000-0000-0000-000000000001'::uuid, 'Lionel Messi',       'Messi',       'aaaa0000-0000-0000-0000-000000000001'::uuid, 'AR', 'FW'),
  ('dddd1000-0000-0000-0000-000000000002'::uuid, 'Julián Álvarez',     'Álvarez',     'aaaa0000-0000-0000-0000-000000000001'::uuid, 'AR', 'FW'),
  ('dddd1000-0000-0000-0000-000000000003'::uuid, 'Hirving Lozano',     'Lozano',      'aaaa0000-0000-0000-0000-000000000002'::uuid, 'MX', 'MF'),
  ('dddd1000-0000-0000-0000-000000000004'::uuid, 'Raúl Jiménez',       'Jiménez',     'aaaa0000-0000-0000-0000-000000000002'::uuid, 'MX', 'FW'),
  ('dddd1000-0000-0000-0000-000000000005'::uuid, 'Alphonso Davies',    'Davies',      'aaaa0000-0000-0000-0000-000000000003'::uuid, 'CA', 'DF'),
  ('dddd1000-0000-0000-0000-000000000006'::uuid, 'Jonathan David',     'David',       'aaaa0000-0000-0000-0000-000000000003'::uuid, 'CA', 'FW'),
  ('dddd1000-0000-0000-0000-000000000007'::uuid, 'Robert Lewandowski', 'Lewandowski', 'aaaa0000-0000-0000-0000-000000000004'::uuid, 'PL', 'FW'),
  ('dddd1000-0000-0000-0000-000000000008'::uuid, 'Piotr Zieliński',    'Zieliński',   'aaaa0000-0000-0000-0000-000000000004'::uuid, 'PL', 'MF'),
  ('dddd1000-0000-0000-0000-000000000009'::uuid, 'Pedri',              'Pedri',       'aaaa0000-0000-0000-0000-000000000005'::uuid, 'ES', 'MF'),
  ('dddd1000-0000-0000-0000-000000000010'::uuid, 'Lamine Yamal',       'Yamal',       'aaaa0000-0000-0000-0000-000000000005'::uuid, 'ES', 'FW'),
  ('dddd1000-0000-0000-0000-000000000011'::uuid, 'Vinícius Júnior',    'Vinícius',    'aaaa0000-0000-0000-0000-000000000006'::uuid, 'BR', 'FW'),
  ('dddd1000-0000-0000-0000-000000000012'::uuid, 'Endrick',            'Endrick',     'aaaa0000-0000-0000-0000-000000000006'::uuid, 'BR', 'FW'),
  ('dddd1000-0000-0000-0000-000000000013'::uuid, 'Christian Pulisic',  'Pulisic',     'aaaa0000-0000-0000-0000-000000000007'::uuid, 'US', 'FW'),
  ('dddd1000-0000-0000-0000-000000000014'::uuid, 'Tyler Adams',        'Adams',       'aaaa0000-0000-0000-0000-000000000007'::uuid, 'US', 'MF'),
  ('dddd1000-0000-0000-0000-000000000015'::uuid, 'Takefusa Kubo',      'Kubo',        'aaaa0000-0000-0000-0000-000000000008'::uuid, 'JP', 'FW'),
  ('dddd1000-0000-0000-0000-000000000016'::uuid, 'Wataru Endo',        'Endo',        'aaaa0000-0000-0000-0000-000000000008'::uuid, 'JP', 'MF')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- Player provider external IDs (stub provider — parallels slice 002 teams)
-- ===========================================================================

INSERT INTO public.player_provider_external_ids (id, player_id, provider_name, provider_player_id) VALUES
  ('dddd1500-0000-0000-0000-000000000001'::uuid, 'dddd1000-0000-0000-0000-000000000001'::uuid, 'stub', 'stub-player-01'),
  ('dddd1500-0000-0000-0000-000000000002'::uuid, 'dddd1000-0000-0000-0000-000000000002'::uuid, 'stub', 'stub-player-02'),
  ('dddd1500-0000-0000-0000-000000000003'::uuid, 'dddd1000-0000-0000-0000-000000000003'::uuid, 'stub', 'stub-player-03'),
  ('dddd1500-0000-0000-0000-000000000004'::uuid, 'dddd1000-0000-0000-0000-000000000004'::uuid, 'stub', 'stub-player-04'),
  ('dddd1500-0000-0000-0000-000000000005'::uuid, 'dddd1000-0000-0000-0000-000000000005'::uuid, 'stub', 'stub-player-05'),
  ('dddd1500-0000-0000-0000-000000000006'::uuid, 'dddd1000-0000-0000-0000-000000000006'::uuid, 'stub', 'stub-player-06'),
  ('dddd1500-0000-0000-0000-000000000007'::uuid, 'dddd1000-0000-0000-0000-000000000007'::uuid, 'stub', 'stub-player-07'),
  ('dddd1500-0000-0000-0000-000000000008'::uuid, 'dddd1000-0000-0000-0000-000000000008'::uuid, 'stub', 'stub-player-08'),
  ('dddd1500-0000-0000-0000-000000000009'::uuid, 'dddd1000-0000-0000-0000-000000000009'::uuid, 'stub', 'stub-player-09'),
  ('dddd1500-0000-0000-0000-000000000010'::uuid, 'dddd1000-0000-0000-0000-000000000010'::uuid, 'stub', 'stub-player-10'),
  ('dddd1500-0000-0000-0000-000000000011'::uuid, 'dddd1000-0000-0000-0000-000000000011'::uuid, 'stub', 'stub-player-11'),
  ('dddd1500-0000-0000-0000-000000000012'::uuid, 'dddd1000-0000-0000-0000-000000000012'::uuid, 'stub', 'stub-player-12'),
  ('dddd1500-0000-0000-0000-000000000013'::uuid, 'dddd1000-0000-0000-0000-000000000013'::uuid, 'stub', 'stub-player-13'),
  ('dddd1500-0000-0000-0000-000000000014'::uuid, 'dddd1000-0000-0000-0000-000000000014'::uuid, 'stub', 'stub-player-14'),
  ('dddd1500-0000-0000-0000-000000000015'::uuid, 'dddd1000-0000-0000-0000-000000000015'::uuid, 'stub', 'stub-player-15'),
  ('dddd1500-0000-0000-0000-000000000016'::uuid, 'dddd1000-0000-0000-0000-000000000016'::uuid, 'stub', 'stub-player-16')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- Final predictions (6 rows; covers all 4 item_kinds across alpha/bravo/charlie)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Row 1: alpha — champion -> ARG (team-kind)
-- ---------------------------------------------------------------------------
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'dddd2000-0000-0000-0000-000000000001'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'champion',
  'aaaa0000-0000-0000-0000-000000000001'::uuid, NULL,
  'ui', NULL, NULL,
  '11111111-1111-1111-1111-111111111111'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 2: alpha — runner_up -> ESP (team-kind)
-- ---------------------------------------------------------------------------
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'dddd2000-0000-0000-0000-000000000002'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'runner_up',
  'aaaa0000-0000-0000-0000-000000000005'::uuid, NULL,
  'ui', NULL, NULL,
  '11111111-1111-1111-1111-111111111111'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 3: alpha — top_scorer -> Messi (player-kind, player 01)
-- ---------------------------------------------------------------------------
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'dddd2000-0000-0000-0000-000000000003'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'top_scorer',
  NULL, 'dddd1000-0000-0000-0000-000000000001'::uuid,
  'ui', NULL, NULL,
  '11111111-1111-1111-1111-111111111111'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 4: bravo — champion -> BRA (team-kind)
-- ---------------------------------------------------------------------------
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'dddd2000-0000-0000-0000-000000000004'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid,
  'champion',
  'aaaa0000-0000-0000-0000-000000000006'::uuid, NULL,
  'ui', NULL, NULL,
  '22222222-2222-2222-2222-222222222222'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 5: bravo — top_scorer -> Vinícius (player-kind, player 11)
-- ---------------------------------------------------------------------------
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'dddd2000-0000-0000-0000-000000000005'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid,
  'top_scorer',
  NULL, 'dddd1000-0000-0000-0000-000000000011'::uuid,
  'ui', NULL, NULL,
  '22222222-2222-2222-2222-222222222222'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 6: charlie — best_player -> Pedri (player-kind, player 09)
-- ---------------------------------------------------------------------------
INSERT INTO public.final_predictions (
  id, participant_id, item_kind,
  target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'dddd2000-0000-0000-0000-000000000006'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,
  'best_player',
  NULL, 'dddd1000-0000-0000-0000-000000000009'::uuid,
  'ui', NULL, NULL,
  '33333333-3333-3333-3333-333333333333'::uuid
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Slice 004 dev-only: seed tournament_config.first_kickoff_utc so the locked
-- predicate `public.is_final_prediction_locked()` (slot 0041) doesn't
-- fail-closed during local dev / test runs. Set to the slice 002 fixture's
-- earliest SCHEDULED match (M3 ARG-CAN, kickoff 2026-06-16T20:00:00Z) so
-- the predicate returns FALSE (editable) for any test run before that date.
--
-- D-017 / Slice 004 design choice: tournament_config.first_kickoff_utc is
-- an ADMIN-OWNED key. T010's trigger is OBSERVABILITY only (audits when
-- matches.kickoff_utc / status mutate), NOT a maintenance trigger. In
-- production, Slice 008's admin UI sets first_kickoff_utc explicitly at
-- tournament setup. For local dev + slice-004 tests, this seed row
-- substitutes for the admin action.
-- ---------------------------------------------------------------------------

INSERT INTO public.tournament_config (key, value)
VALUES ('first_kickoff_utc', '"2026-06-16T20:00:00Z"'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
