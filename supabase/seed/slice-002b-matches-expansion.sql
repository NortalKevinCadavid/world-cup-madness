-- ============================================================================
-- slice-002b-matches-expansion.sql
-- ============================================================================
-- The base seed only has group-stage matches for groups A and B, all in
-- statuses scheduled / in_progress / finished. That makes the /matches Group
-- and Status filters look broken (filtering C–L or postponed/cancelled returns
-- nothing). This adds demo fixtures across groups C–F with postponed/cancelled
-- statuses so both filters are exercisable.
--
-- All rows are scheduled/postponed/cancelled (NO finished) → they carry no
-- match_results and therefore have ZERO scoring/leaderboard impact. Teams come
-- from the slice-010 bracket fixture (cccc0010-*), so this must load AFTER it.
-- Kickoffs are late June 2026 (after the seeded first_kickoff_utc) so the
-- first-kickoff audit trigger sees no earlier-kickoff correction.
-- Idempotent: ON CONFLICT (id) DO NOTHING.
-- ============================================================================

INSERT INTO public.matches (id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status, venue) VALUES
  -- Group C
  ('ffff0002-0000-0000-0000-000000000001','cccc0010-0000-0000-0000-000000000005','cccc0010-0000-0000-0000-000000000006','group','C','2026-06-20T16:00:00Z','scheduled','Estadio Azteca'),
  ('ffff0002-0000-0000-0000-000000000002','cccc0010-0000-0000-0000-000000000007','cccc0010-0000-0000-0000-000000000008','group','C','2026-06-20T19:00:00Z','postponed','BC Place'),
  -- Group D
  ('ffff0002-0000-0000-0000-000000000003','cccc0010-0000-0000-0000-000000000009','cccc0010-0000-0000-0000-000000000010','group','D','2026-06-21T16:00:00Z','scheduled','MetLife Stadium'),
  ('ffff0002-0000-0000-0000-000000000004','cccc0010-0000-0000-0000-000000000011','cccc0010-0000-0000-0000-000000000012','group','D','2026-06-21T19:00:00Z','cancelled','SoFi Stadium'),
  -- Group E
  ('ffff0002-0000-0000-0000-000000000005','cccc0010-0000-0000-0000-000000000013','cccc0010-0000-0000-0000-000000000014','group','E','2026-06-22T16:00:00Z','scheduled','Lumen Field'),
  ('ffff0002-0000-0000-0000-000000000006','cccc0010-0000-0000-0000-000000000015','cccc0010-0000-0000-0000-000000000016','group','E','2026-06-22T19:00:00Z','postponed','Hard Rock Stadium'),
  -- Group F
  ('ffff0002-0000-0000-0000-000000000007','cccc0010-0000-0000-0000-000000000017','cccc0010-0000-0000-0000-000000000018','group','F','2026-06-23T16:00:00Z','scheduled','Arrowhead Stadium'),
  ('ffff0002-0000-0000-0000-000000000008','cccc0010-0000-0000-0000-000000000019','cccc0010-0000-0000-0000-000000000020','group','F','2026-06-23T19:00:00Z','cancelled','Levi''s Stadium')
ON CONFLICT (id) DO NOTHING;
