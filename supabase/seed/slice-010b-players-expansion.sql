-- ============================================================================
-- slice-010b-players-expansion.sql
-- ============================================================================
-- Expands the player catalog so the Golden Boot (top_scorer) and Golden Ball
-- (best_player) final-prediction pickers have real options for every team —
-- two recognizable stars per team for the 32 teams introduced by the slice-010
-- bracket fixture (the original 8 match teams already have players from
-- slice-004). Idempotent: ON CONFLICT (id) DO NOTHING so reseeds are safe.
--
-- IDs use the dddd2000-* namespace (slice-004 used dddd1000-*). country_code
-- mirrors the team's short_code. Loaded after slice-010-fixture (these players
-- FK to its cccc0010-* teams).
-- ============================================================================

INSERT INTO public.players (id, full_name, team_id, country_code, position) VALUES
  -- Australia
  ('dddd2000-0000-0000-0000-000000000001','Mitchell Duke','cccc0010-0000-0000-0000-000000000016','AUS','FW'),
  ('dddd2000-0000-0000-0000-000000000002','Martin Boyle','cccc0010-0000-0000-0000-000000000016','AUS','FW'),
  -- Austria
  ('dddd2000-0000-0000-0000-000000000003','Marko Arnautović','cccc0010-0000-0000-0000-000000000028','AUT','FW'),
  ('dddd2000-0000-0000-0000-000000000004','David Alaba','cccc0010-0000-0000-0000-000000000028','AUT','DF'),
  -- Belgium
  ('dddd2000-0000-0000-0000-000000000005','Kevin De Bruyne','cccc0010-0000-0000-0000-000000000006','BEL','MF'),
  ('dddd2000-0000-0000-0000-000000000006','Romelu Lukaku','cccc0010-0000-0000-0000-000000000006','BEL','FW'),
  -- Chile
  ('dddd2000-0000-0000-0000-000000000007','Alexis Sánchez','cccc0010-0000-0000-0000-000000000025','CHI','FW'),
  ('dddd2000-0000-0000-0000-000000000008','Ben Brereton Díaz','cccc0010-0000-0000-0000-000000000025','CHI','FW'),
  -- Cameroon
  ('dddd2000-0000-0000-0000-000000000009','Vincent Aboubakar','cccc0010-0000-0000-0000-000000000019','CMR','FW'),
  ('dddd2000-0000-0000-0000-00000000000a','André-Frank Zambo Anguissa','cccc0010-0000-0000-0000-000000000019','CMR','MF'),
  -- Colombia
  ('dddd2000-0000-0000-0000-00000000000b','Luis Díaz','cccc0010-0000-0000-0000-000000000010','COL','FW'),
  ('dddd2000-0000-0000-0000-00000000000c','James Rodríguez','cccc0010-0000-0000-0000-000000000010','COL','MF'),
  -- Croatia
  ('dddd2000-0000-0000-0000-00000000000d','Luka Modrić','cccc0010-0000-0000-0000-000000000008','CRO','MF'),
  ('dddd2000-0000-0000-0000-00000000000e','Andrej Kramarić','cccc0010-0000-0000-0000-000000000008','CRO','FW'),
  -- Denmark
  ('dddd2000-0000-0000-0000-00000000000f','Christian Eriksen','cccc0010-0000-0000-0000-000000000012','DEN','MF'),
  ('dddd2000-0000-0000-0000-000000000010','Rasmus Højlund','cccc0010-0000-0000-0000-000000000012','DEN','FW'),
  -- Ecuador
  ('dddd2000-0000-0000-0000-000000000011','Enner Valencia','cccc0010-0000-0000-0000-000000000017','ECU','FW'),
  ('dddd2000-0000-0000-0000-000000000012','Moisés Caicedo','cccc0010-0000-0000-0000-000000000017','ECU','MF'),
  -- Egypt
  ('dddd2000-0000-0000-0000-000000000013','Mohamed Salah','cccc0010-0000-0000-0000-000000000023','EGY','FW'),
  ('dddd2000-0000-0000-0000-000000000014','Omar Marmoush','cccc0010-0000-0000-0000-000000000023','EGY','FW'),
  -- England
  ('dddd2000-0000-0000-0000-000000000015','Harry Kane','cccc0010-0000-0000-0000-000000000003','ENG','FW'),
  ('dddd2000-0000-0000-0000-000000000016','Jude Bellingham','cccc0010-0000-0000-0000-000000000003','ENG','MF'),
  -- France
  ('dddd2000-0000-0000-0000-000000000017','Kylian Mbappé','cccc0010-0000-0000-0000-000000000001','FRA','FW'),
  ('dddd2000-0000-0000-0000-000000000018','Antoine Griezmann','cccc0010-0000-0000-0000-000000000001','FRA','FW'),
  -- Germany
  ('dddd2000-0000-0000-0000-000000000019','Jamal Musiala','cccc0010-0000-0000-0000-000000000002','GER','MF'),
  ('dddd2000-0000-0000-0000-00000000001a','Kai Havertz','cccc0010-0000-0000-0000-000000000002','GER','FW'),
  -- Ghana
  ('dddd2000-0000-0000-0000-00000000001b','Mohammed Kudus','cccc0010-0000-0000-0000-000000000018','GHA','MF'),
  ('dddd2000-0000-0000-0000-00000000001c','Iñaki Williams','cccc0010-0000-0000-0000-000000000018','GHA','FW'),
  -- Iran
  ('dddd2000-0000-0000-0000-00000000001d','Mehdi Taremi','cccc0010-0000-0000-0000-000000000032','IRN','FW'),
  ('dddd2000-0000-0000-0000-00000000001e','Sardar Azmoun','cccc0010-0000-0000-0000-000000000032','IRN','FW'),
  -- Italy
  ('dddd2000-0000-0000-0000-00000000001f','Federico Chiesa','cccc0010-0000-0000-0000-000000000007','ITA','FW'),
  ('dddd2000-0000-0000-0000-000000000020','Gianluigi Donnarumma','cccc0010-0000-0000-0000-000000000007','ITA','GK'),
  -- South Korea
  ('dddd2000-0000-0000-0000-000000000021','Son Heung-min','cccc0010-0000-0000-0000-000000000015','KOR','FW'),
  ('dddd2000-0000-0000-0000-000000000022','Lee Kang-in','cccc0010-0000-0000-0000-000000000015','KOR','MF'),
  -- Morocco
  ('dddd2000-0000-0000-0000-000000000023','Youssef En-Nesyri','cccc0010-0000-0000-0000-000000000014','MAR','FW'),
  ('dddd2000-0000-0000-0000-000000000024','Achraf Hakimi','cccc0010-0000-0000-0000-000000000014','MAR','DF'),
  -- Netherlands
  ('dddd2000-0000-0000-0000-000000000025','Memphis Depay','cccc0010-0000-0000-0000-000000000005','NED','FW'),
  ('dddd2000-0000-0000-0000-000000000026','Cody Gakpo','cccc0010-0000-0000-0000-000000000005','NED','FW'),
  -- Nigeria
  ('dddd2000-0000-0000-0000-000000000027','Victor Osimhen','cccc0010-0000-0000-0000-000000000024','NGA','FW'),
  ('dddd2000-0000-0000-0000-000000000028','Ademola Lookman','cccc0010-0000-0000-0000-000000000024','NGA','FW'),
  -- Norway
  ('dddd2000-0000-0000-0000-000000000029','Erling Haaland','cccc0010-0000-0000-0000-000000000022','NOR','FW'),
  ('dddd2000-0000-0000-0000-00000000002a','Martin Ødegaard','cccc0010-0000-0000-0000-000000000022','NOR','MF'),
  -- Paraguay
  ('dddd2000-0000-0000-0000-00000000002b','Miguel Almirón','cccc0010-0000-0000-0000-000000000027','PAR','MF'),
  ('dddd2000-0000-0000-0000-00000000002c','Antonio Sanabria','cccc0010-0000-0000-0000-000000000027','PAR','FW'),
  -- Peru
  ('dddd2000-0000-0000-0000-00000000002d','Gianluca Lapadula','cccc0010-0000-0000-0000-000000000026','PER','FW'),
  ('dddd2000-0000-0000-0000-00000000002e','Christian Cueva','cccc0010-0000-0000-0000-000000000026','PER','MF'),
  -- Portugal
  ('dddd2000-0000-0000-0000-00000000002f','Cristiano Ronaldo','cccc0010-0000-0000-0000-000000000004','POR','FW'),
  ('dddd2000-0000-0000-0000-000000000030','Bruno Fernandes','cccc0010-0000-0000-0000-000000000004','POR','MF'),
  -- Scotland
  ('dddd2000-0000-0000-0000-000000000031','Scott McTominay','cccc0010-0000-0000-0000-000000000030','SCO','MF'),
  ('dddd2000-0000-0000-0000-000000000032','Che Adams','cccc0010-0000-0000-0000-000000000030','SCO','FW'),
  -- Senegal
  ('dddd2000-0000-0000-0000-000000000033','Sadio Mané','cccc0010-0000-0000-0000-000000000013','SEN','FW'),
  ('dddd2000-0000-0000-0000-000000000034','Nicolas Jackson','cccc0010-0000-0000-0000-000000000013','SEN','FW'),
  -- Serbia
  ('dddd2000-0000-0000-0000-000000000035','Dušan Vlahović','cccc0010-0000-0000-0000-000000000020','SRB','FW'),
  ('dddd2000-0000-0000-0000-000000000036','Aleksandar Mitrović','cccc0010-0000-0000-0000-000000000020','SRB','FW'),
  -- Switzerland
  ('dddd2000-0000-0000-0000-000000000037','Granit Xhaka','cccc0010-0000-0000-0000-000000000011','SUI','MF'),
  ('dddd2000-0000-0000-0000-000000000038','Breel Embolo','cccc0010-0000-0000-0000-000000000011','SUI','FW'),
  -- Sweden
  ('dddd2000-0000-0000-0000-000000000039','Alexander Isak','cccc0010-0000-0000-0000-000000000021','SWE','FW'),
  ('dddd2000-0000-0000-0000-00000000003a','Viktor Gyökeres','cccc0010-0000-0000-0000-000000000021','SWE','FW'),
  -- Turkey
  ('dddd2000-0000-0000-0000-00000000003b','Arda Güler','cccc0010-0000-0000-0000-000000000029','TUR','MF'),
  ('dddd2000-0000-0000-0000-00000000003c','Kenan Yıldız','cccc0010-0000-0000-0000-000000000029','TUR','FW'),
  -- Uruguay
  ('dddd2000-0000-0000-0000-00000000003d','Federico Valverde','cccc0010-0000-0000-0000-000000000009','URU','MF'),
  ('dddd2000-0000-0000-0000-00000000003e','Darwin Núñez','cccc0010-0000-0000-0000-000000000009','URU','FW'),
  -- Wales
  ('dddd2000-0000-0000-0000-00000000003f','Brennan Johnson','cccc0010-0000-0000-0000-000000000031','WAL','FW'),
  ('dddd2000-0000-0000-0000-000000000040','Harry Wilson','cccc0010-0000-0000-0000-000000000031','WAL','MF')
ON CONFLICT (id) DO NOTHING;
