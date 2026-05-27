-- ============================================================================
-- slice-010-fixture.sql  — Slice 010 / T009
-- ============================================================================
-- Seeds the fixed Round-of-32 knockout bracket: 32 teams (cccc0010-* ns),
-- 31 matchups (dddd* ns) wired R32→Final, plus partial picks for alpha/bravo.
--
-- 32 distinct nations with unique short_codes that DO NOT collide with the
-- slice-002 set (ARG/MEX/CAN/POL/ESP/BRA/USA/JPN). One team (IRN, #32) has a
-- NULL flag_url to exercise the fallback placeholder (FR-002 / T014).
--
-- Matchups inserted Final→SF→QF→R16→R32 so each next_matchup_id FK already
-- exists. Wiring: R32 pos p → R16 ceil(p/2) slot (A if p odd else B); same
-- halving up each round; SF1→Final A, SF2→Final B; Final has no next.
-- ============================================================================

-- ---- 32 teams ----------------------------------------------------------------
INSERT INTO public.teams (id, name, short_code, flag_url) VALUES
  ('cccc0010-0000-0000-0000-000000000001','France','FRA','https://flagcdn.com/w320/fr.png'),
  ('cccc0010-0000-0000-0000-000000000002','Germany','GER','https://flagcdn.com/w320/de.png'),
  ('cccc0010-0000-0000-0000-000000000003','England','ENG','https://flagcdn.com/w320/gb-eng.png'),
  ('cccc0010-0000-0000-0000-000000000004','Portugal','POR','https://flagcdn.com/w320/pt.png'),
  ('cccc0010-0000-0000-0000-000000000005','Netherlands','NED','https://flagcdn.com/w320/nl.png'),
  ('cccc0010-0000-0000-0000-000000000006','Belgium','BEL','https://flagcdn.com/w320/be.png'),
  ('cccc0010-0000-0000-0000-000000000007','Italy','ITA','https://flagcdn.com/w320/it.png'),
  ('cccc0010-0000-0000-0000-000000000008','Croatia','CRO','https://flagcdn.com/w320/hr.png'),
  ('cccc0010-0000-0000-0000-000000000009','Uruguay','URU','https://flagcdn.com/w320/uy.png'),
  ('cccc0010-0000-0000-0000-000000000010','Colombia','COL','https://flagcdn.com/w320/co.png'),
  ('cccc0010-0000-0000-0000-000000000011','Switzerland','SUI','https://flagcdn.com/w320/ch.png'),
  ('cccc0010-0000-0000-0000-000000000012','Denmark','DEN','https://flagcdn.com/w320/dk.png'),
  ('cccc0010-0000-0000-0000-000000000013','Senegal','SEN','https://flagcdn.com/w320/sn.png'),
  ('cccc0010-0000-0000-0000-000000000014','Morocco','MAR','https://flagcdn.com/w320/ma.png'),
  ('cccc0010-0000-0000-0000-000000000015','South Korea','KOR','https://flagcdn.com/w320/kr.png'),
  ('cccc0010-0000-0000-0000-000000000016','Australia','AUS','https://flagcdn.com/w320/au.png'),
  ('cccc0010-0000-0000-0000-000000000017','Ecuador','ECU','https://flagcdn.com/w320/ec.png'),
  ('cccc0010-0000-0000-0000-000000000018','Ghana','GHA','https://flagcdn.com/w320/gh.png'),
  ('cccc0010-0000-0000-0000-000000000019','Cameroon','CMR','https://flagcdn.com/w320/cm.png'),
  ('cccc0010-0000-0000-0000-000000000020','Serbia','SRB','https://flagcdn.com/w320/rs.png'),
  ('cccc0010-0000-0000-0000-000000000021','Sweden','SWE','https://flagcdn.com/w320/se.png'),
  ('cccc0010-0000-0000-0000-000000000022','Norway','NOR','https://flagcdn.com/w320/no.png'),
  ('cccc0010-0000-0000-0000-000000000023','Egypt','EGY','https://flagcdn.com/w320/eg.png'),
  ('cccc0010-0000-0000-0000-000000000024','Nigeria','NGA','https://flagcdn.com/w320/ng.png'),
  ('cccc0010-0000-0000-0000-000000000025','Chile','CHI','https://flagcdn.com/w320/cl.png'),
  ('cccc0010-0000-0000-0000-000000000026','Peru','PER','https://flagcdn.com/w320/pe.png'),
  ('cccc0010-0000-0000-0000-000000000027','Paraguay','PAR','https://flagcdn.com/w320/py.png'),
  ('cccc0010-0000-0000-0000-000000000028','Austria','AUT','https://flagcdn.com/w320/at.png'),
  ('cccc0010-0000-0000-0000-000000000029','Turkey','TUR','https://flagcdn.com/w320/tr.png'),
  ('cccc0010-0000-0000-0000-000000000030','Scotland','SCO','https://flagcdn.com/w320/gb-sct.png'),
  ('cccc0010-0000-0000-0000-000000000031','Wales','WAL','https://flagcdn.com/w320/gb-wls.png'),
  ('cccc0010-0000-0000-0000-000000000032','Iran','IRN', NULL)   -- NULL flag → fallback test
ON CONFLICT (id) DO NOTHING;

-- ---- Final (no next) ---------------------------------------------------------
INSERT INTO public.bracket_matchups (id, round, position, next_matchup_id, next_slot) VALUES
  ('dddd0001-0000-0000-0000-000000000001','final',1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- ---- Semifinals → Final ------------------------------------------------------
INSERT INTO public.bracket_matchups (id, round, position, next_matchup_id, next_slot) VALUES
  ('dddd0002-0000-0000-0000-000000000001','sf',1,'dddd0001-0000-0000-0000-000000000001','A'),
  ('dddd0002-0000-0000-0000-000000000002','sf',2,'dddd0001-0000-0000-0000-000000000001','B')
ON CONFLICT (id) DO NOTHING;

-- ---- Quarterfinals → Semifinals ----------------------------------------------
INSERT INTO public.bracket_matchups (id, round, position, next_matchup_id, next_slot) VALUES
  ('dddd0004-0000-0000-0000-000000000001','qf',1,'dddd0002-0000-0000-0000-000000000001','A'),
  ('dddd0004-0000-0000-0000-000000000002','qf',2,'dddd0002-0000-0000-0000-000000000001','B'),
  ('dddd0004-0000-0000-0000-000000000003','qf',3,'dddd0002-0000-0000-0000-000000000002','A'),
  ('dddd0004-0000-0000-0000-000000000004','qf',4,'dddd0002-0000-0000-0000-000000000002','B')
ON CONFLICT (id) DO NOTHING;

-- ---- Round of 16 → Quarterfinals ---------------------------------------------
INSERT INTO public.bracket_matchups (id, round, position, next_matchup_id, next_slot) VALUES
  ('dddd0016-0000-0000-0000-000000000001','r16',1,'dddd0004-0000-0000-0000-000000000001','A'),
  ('dddd0016-0000-0000-0000-000000000002','r16',2,'dddd0004-0000-0000-0000-000000000001','B'),
  ('dddd0016-0000-0000-0000-000000000003','r16',3,'dddd0004-0000-0000-0000-000000000002','A'),
  ('dddd0016-0000-0000-0000-000000000004','r16',4,'dddd0004-0000-0000-0000-000000000002','B'),
  ('dddd0016-0000-0000-0000-000000000005','r16',5,'dddd0004-0000-0000-0000-000000000003','A'),
  ('dddd0016-0000-0000-0000-000000000006','r16',6,'dddd0004-0000-0000-0000-000000000003','B'),
  ('dddd0016-0000-0000-0000-000000000007','r16',7,'dddd0004-0000-0000-0000-000000000004','A'),
  ('dddd0016-0000-0000-0000-000000000008','r16',8,'dddd0004-0000-0000-0000-000000000004','B')
ON CONFLICT (id) DO NOTHING;

-- ---- Round of 32 → Round of 16 (with seeded competitors) ---------------------
-- pos p pairs teams (2p-1, 2p); feeds R16 ceil(p/2) slot A(odd)/B(even).
INSERT INTO public.bracket_matchups (id, round, position, team_a_id, team_b_id, next_matchup_id, next_slot) VALUES
  ('dddd0032-0000-0000-0000-000000000001','r32',1, 'cccc0010-0000-0000-0000-000000000001','cccc0010-0000-0000-0000-000000000002','dddd0016-0000-0000-0000-000000000001','A'),
  ('dddd0032-0000-0000-0000-000000000002','r32',2, 'cccc0010-0000-0000-0000-000000000003','cccc0010-0000-0000-0000-000000000004','dddd0016-0000-0000-0000-000000000001','B'),
  ('dddd0032-0000-0000-0000-000000000003','r32',3, 'cccc0010-0000-0000-0000-000000000005','cccc0010-0000-0000-0000-000000000006','dddd0016-0000-0000-0000-000000000002','A'),
  ('dddd0032-0000-0000-0000-000000000004','r32',4, 'cccc0010-0000-0000-0000-000000000007','cccc0010-0000-0000-0000-000000000008','dddd0016-0000-0000-0000-000000000002','B'),
  ('dddd0032-0000-0000-0000-000000000005','r32',5, 'cccc0010-0000-0000-0000-000000000009','cccc0010-0000-0000-0000-000000000010','dddd0016-0000-0000-0000-000000000003','A'),
  ('dddd0032-0000-0000-0000-000000000006','r32',6, 'cccc0010-0000-0000-0000-000000000011','cccc0010-0000-0000-0000-000000000012','dddd0016-0000-0000-0000-000000000003','B'),
  ('dddd0032-0000-0000-0000-000000000007','r32',7, 'cccc0010-0000-0000-0000-000000000013','cccc0010-0000-0000-0000-000000000014','dddd0016-0000-0000-0000-000000000004','A'),
  ('dddd0032-0000-0000-0000-000000000008','r32',8, 'cccc0010-0000-0000-0000-000000000015','cccc0010-0000-0000-0000-000000000016','dddd0016-0000-0000-0000-000000000004','B'),
  ('dddd0032-0000-0000-0000-000000000009','r32',9, 'cccc0010-0000-0000-0000-000000000017','cccc0010-0000-0000-0000-000000000018','dddd0016-0000-0000-0000-000000000005','A'),
  ('dddd0032-0000-0000-0000-000000000010','r32',10,'cccc0010-0000-0000-0000-000000000019','cccc0010-0000-0000-0000-000000000020','dddd0016-0000-0000-0000-000000000005','B'),
  ('dddd0032-0000-0000-0000-000000000011','r32',11,'cccc0010-0000-0000-0000-000000000021','cccc0010-0000-0000-0000-000000000022','dddd0016-0000-0000-0000-000000000006','A'),
  ('dddd0032-0000-0000-0000-000000000012','r32',12,'cccc0010-0000-0000-0000-000000000023','cccc0010-0000-0000-0000-000000000024','dddd0016-0000-0000-0000-000000000006','B'),
  ('dddd0032-0000-0000-0000-000000000013','r32',13,'cccc0010-0000-0000-0000-000000000025','cccc0010-0000-0000-0000-000000000026','dddd0016-0000-0000-0000-000000000007','A'),
  ('dddd0032-0000-0000-0000-000000000014','r32',14,'cccc0010-0000-0000-0000-000000000027','cccc0010-0000-0000-0000-000000000028','dddd0016-0000-0000-0000-000000000007','B'),
  ('dddd0032-0000-0000-0000-000000000015','r32',15,'cccc0010-0000-0000-0000-000000000029','cccc0010-0000-0000-0000-000000000030','dddd0016-0000-0000-0000-000000000008','A'),
  ('dddd0032-0000-0000-0000-000000000016','r32',16,'cccc0010-0000-0000-0000-000000000031','cccc0010-0000-0000-0000-000000000032','dddd0016-0000-0000-0000-000000000008','B')
ON CONFLICT (id) DO NOTHING;

-- ---- Partial picks: alpha (3 R32 winners), bravo (1 R32 winner) ---------------
-- Gives the view/status tests a non-empty, incomplete bracket to read.
INSERT INTO public.bracket_picks (participant_id, matchup_id, winner_team_id) VALUES
  ('11111111-1111-1111-1111-111111111111','dddd0032-0000-0000-0000-000000000001','cccc0010-0000-0000-0000-000000000001'), -- alpha: France over Germany
  ('11111111-1111-1111-1111-111111111111','dddd0032-0000-0000-0000-000000000002','cccc0010-0000-0000-0000-000000000003'), -- alpha: England over Portugal
  ('11111111-1111-1111-1111-111111111111','dddd0032-0000-0000-0000-000000000003','cccc0010-0000-0000-0000-000000000005'), -- alpha: Netherlands over Belgium
  ('22222222-2222-2222-2222-222222222222','dddd0032-0000-0000-0000-000000000001','cccc0010-0000-0000-0000-000000000002')  -- bravo: Germany over France
ON CONFLICT (participant_id, matchup_id) DO NOTHING;
