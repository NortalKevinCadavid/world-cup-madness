-- Slice 002 fixture: 8 teams (Groups A/B), 8 matches across statuses, 1 finished match_result. Loaded after migrations during supabase db reset. Idempotent. Test-only.
--
-- Tables touched (by INSERT, with ON CONFLICT DO NOTHING on each PK):
--   public.teams                          -- 8 rows
--   public.team_provider_external_ids     -- 8 rows (provider_name='stub')
--   public.matches                        -- 8 rows: 6 scheduled + 1 in_progress + 1 finished
--   public.match_provider_external_ids    -- 8 rows (provider_name='stub')
--   public.match_results                  -- 1 row (the finished ARG vs MEX match)
--
-- Tables NOT touched: provider_sync_runs, provider_sync_state, match_pending_review.
-- Those are created at runtime by the sync coordinator and admin workflows.
--
-- Deterministic UUID conventions:
--   Teams   : aaaa0000-0000-0000-0000-00000000000N  (N = 1..8)
--   Matches : bbbb0000-0000-0000-0000-00000000000N  (N = 1..8)
--
-- Schema reconciliation (D-006): migrations 0019-0021 are authoritative for column
-- shape. Notably matches uses (home_team_id, away_team_id, stage public.match_stage,
-- group_id, kickoff_utc, venue, status public.match_status, last_synced_at, ...);
-- match_results uses (home_score, away_score, extra_time_*, penalty_*,
-- home_score_for_scoring, away_score_for_scoring, result_status, recorded_at,
-- recorded_by, source).
--
-- This file is loaded after migrations during `supabase db reset` per
-- supabase/config.toml [db.seed] sql_paths.

BEGIN;

-- ---------------------------------------------------------------------------
-- public.teams  (8 rows: Group A {ARG, MEX, CAN, POL}, Group B {ESP, BRA, USA, JPN})
-- ---------------------------------------------------------------------------
-- flag_url is NULL for every row: slice 002 does not ship CDN assets; admin
-- uploads via slice 006 may populate this later. created_at / updated_at use
-- the column defaults so re-running the seed against a pre-existing row is a
-- no-op via ON CONFLICT DO NOTHING on the PK.

INSERT INTO public.teams (id, name, short_code, flag_url) VALUES
  ('aaaa0000-0000-0000-0000-000000000001', 'Argentina', 'ARG', NULL),
  ('aaaa0000-0000-0000-0000-000000000002', 'Mexico',    'MEX', NULL),
  ('aaaa0000-0000-0000-0000-000000000003', 'Canada',    'CAN', NULL),
  ('aaaa0000-0000-0000-0000-000000000004', 'Poland',    'POL', NULL),
  ('aaaa0000-0000-0000-0000-000000000005', 'Spain',     'ESP', NULL),
  ('aaaa0000-0000-0000-0000-000000000006', 'Brazil',    'BRA', NULL),
  ('aaaa0000-0000-0000-0000-000000000007', 'USA',       'USA', NULL),
  ('aaaa0000-0000-0000-0000-000000000008', 'Japan',     'JPN', NULL)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- public.team_provider_external_ids  (8 rows, provider_name='stub')
-- ---------------------------------------------------------------------------
-- provider_team_id is the team's short_code lowercased. Deterministic surrogate
-- UUIDs so re-runs are no-ops on the PK conflict target.

INSERT INTO public.team_provider_external_ids (id, team_id, provider_name, provider_team_id) VALUES
  ('cccc0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000001', 'stub', 'arg'),
  ('cccc0000-0000-0000-0000-000000000002', 'aaaa0000-0000-0000-0000-000000000002', 'stub', 'mex'),
  ('cccc0000-0000-0000-0000-000000000003', 'aaaa0000-0000-0000-0000-000000000003', 'stub', 'can'),
  ('cccc0000-0000-0000-0000-000000000004', 'aaaa0000-0000-0000-0000-000000000004', 'stub', 'pol'),
  ('cccc0000-0000-0000-0000-000000000005', 'aaaa0000-0000-0000-0000-000000000005', 'stub', 'esp'),
  ('cccc0000-0000-0000-0000-000000000006', 'aaaa0000-0000-0000-0000-000000000006', 'stub', 'bra'),
  ('cccc0000-0000-0000-0000-000000000007', 'aaaa0000-0000-0000-0000-000000000007', 'stub', 'usa'),
  ('cccc0000-0000-0000-0000-000000000008', 'aaaa0000-0000-0000-0000-000000000008', 'stub', 'jpn')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- public.matches  (8 rows: 6 scheduled + 1 in_progress + 1 finished)
-- ---------------------------------------------------------------------------
-- All rows are stage='group' with a non-NULL group_id (satisfies the
-- matches_group_id_consistency CHECK). Kickoffs span 2026-06-11..2026-06-19
-- so chronological-sort tests are unambiguous.
--
-- Group A pairings (group_id='A'):
--   M1  ARG vs MEX  finished      2026-06-11T20:00:00Z   <-- match_results row below
--   M2  CAN vs POL  in_progress   2026-06-12T20:00:00Z
--   M3  ARG vs CAN  scheduled     2026-06-16T20:00:00Z
--   M4  MEX vs POL  scheduled     2026-06-17T20:00:00Z
--
-- Group B pairings (group_id='B'), all scheduled:
--   M5  ESP vs BRA  scheduled     2026-06-13T20:00:00Z
--   M6  USA vs JPN  scheduled     2026-06-14T20:00:00Z
--   M7  ESP vs USA  scheduled     2026-06-18T20:00:00Z
--   M8  BRA vs JPN  scheduled     2026-06-19T20:00:00Z

INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, venue, status) VALUES
  -- M1: ARG vs MEX, Group A, finished
  ('bbbb0000-0000-0000-0000-000000000001',
   'aaaa0000-0000-0000-0000-000000000001',
   'aaaa0000-0000-0000-0000-000000000002',
   'group', 'A', '2026-06-11T20:00:00Z', 'Estadio Azteca',           'finished'),
  -- M2: CAN vs POL, Group A, in_progress
  ('bbbb0000-0000-0000-0000-000000000002',
   'aaaa0000-0000-0000-0000-000000000003',
   'aaaa0000-0000-0000-0000-000000000004',
   'group', 'A', '2026-06-12T20:00:00Z', 'BMO Field',                'in_progress'),
  -- M3: ARG vs CAN, Group A, scheduled
  ('bbbb0000-0000-0000-0000-000000000003',
   'aaaa0000-0000-0000-0000-000000000001',
   'aaaa0000-0000-0000-0000-000000000003',
   'group', 'A', '2026-06-16T20:00:00Z', 'MetLife Stadium',          'scheduled'),
  -- M4: MEX vs POL, Group A, scheduled
  ('bbbb0000-0000-0000-0000-000000000004',
   'aaaa0000-0000-0000-0000-000000000002',
   'aaaa0000-0000-0000-0000-000000000004',
   'group', 'A', '2026-06-17T20:00:00Z', 'Estadio Akron',            'scheduled'),
  -- M5: ESP vs BRA, Group B, scheduled
  ('bbbb0000-0000-0000-0000-000000000005',
   'aaaa0000-0000-0000-0000-000000000005',
   'aaaa0000-0000-0000-0000-000000000006',
   'group', 'B', '2026-06-13T20:00:00Z', 'Mercedes-Benz Stadium',    'scheduled'),
  -- M6: USA vs JPN, Group B, scheduled
  ('bbbb0000-0000-0000-0000-000000000006',
   'aaaa0000-0000-0000-0000-000000000007',
   'aaaa0000-0000-0000-0000-000000000008',
   'group', 'B', '2026-06-14T20:00:00Z', 'SoFi Stadium',             'scheduled'),
  -- M7: ESP vs USA, Group B, scheduled
  ('bbbb0000-0000-0000-0000-000000000007',
   'aaaa0000-0000-0000-0000-000000000005',
   'aaaa0000-0000-0000-0000-000000000007',
   'group', 'B', '2026-06-18T20:00:00Z', 'Lincoln Financial Field',  'scheduled'),
  -- M8: BRA vs JPN, Group B, scheduled
  ('bbbb0000-0000-0000-0000-000000000008',
   'aaaa0000-0000-0000-0000-000000000006',
   'aaaa0000-0000-0000-0000-000000000008',
   'group', 'B', '2026-06-19T20:00:00Z', 'NRG Stadium',              'scheduled')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- public.match_provider_external_ids  (8 rows, provider_name='stub')
-- ---------------------------------------------------------------------------
-- provider_match_id follows the 'stub-match-<n>' convention matching the
-- match's UUID suffix.

INSERT INTO public.match_provider_external_ids (id, match_id, provider_name, provider_match_id) VALUES
  ('dddd0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'stub', 'stub-match-1'),
  ('dddd0000-0000-0000-0000-000000000002', 'bbbb0000-0000-0000-0000-000000000002', 'stub', 'stub-match-2'),
  ('dddd0000-0000-0000-0000-000000000003', 'bbbb0000-0000-0000-0000-000000000003', 'stub', 'stub-match-3'),
  ('dddd0000-0000-0000-0000-000000000004', 'bbbb0000-0000-0000-0000-000000000004', 'stub', 'stub-match-4'),
  ('dddd0000-0000-0000-0000-000000000005', 'bbbb0000-0000-0000-0000-000000000005', 'stub', 'stub-match-5'),
  ('dddd0000-0000-0000-0000-000000000006', 'bbbb0000-0000-0000-0000-000000000006', 'stub', 'stub-match-6'),
  ('dddd0000-0000-0000-0000-000000000007', 'bbbb0000-0000-0000-0000-000000000007', 'stub', 'stub-match-7'),
  ('dddd0000-0000-0000-0000-000000000008', 'bbbb0000-0000-0000-0000-000000000008', 'stub', 'stub-match-8')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- public.match_results  (1 row: the finished ARG vs MEX match, M1)
-- ---------------------------------------------------------------------------
-- ARG 2 - 0 MEX, regulation result. No extra time, no penalties. The
-- _for_scoring columns equal home_score + COALESCE(extra_time_home_score, 0)
-- per the match_results_for_scoring_matches CHECK in 0021_match_results.sql.
-- source='provider_sync' (recorded_by NULL).

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
) VALUES (
  'bbbb0000-0000-0000-0000-000000000001',
  2,
  0,
  NULL,
  NULL,
  NULL,
  NULL,
  2,
  0,
  'regulation',
  '2026-06-11T22:00:00Z',
  NULL,
  'provider_sync'
)
ON CONFLICT (match_id) DO NOTHING;

COMMIT;
