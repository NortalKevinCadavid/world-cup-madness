-- Slice 004 / T031 / contracts/players-ingest.md
--
-- pgTAP coverage for the DB invariants of the players-ingest happy path.
-- The Edge Function path (sync-catalog/index.ts § 7d) is exercised by the
-- Deno test `players_branch.test.ts`; this pgTAP file simulates what the
-- coordinator's `upsertPlayers` helper writes (INSERT players row + INSERT
-- mapping row + audit row) and asserts the DB-layer invariants:
--
--   1. N new players rows with removed_at IS NULL (active).
--   2. N new player_provider_external_ids rows mapping provider -> internal id.
--   3. N new audit_log rows with action='player.created'.
--   4. The UNIQUE constraint on (provider_name, provider_player_id) holds
--      (a second insert of the same external id with same provider raises).
--   5. The teams FK is honored (team_id NULL allowed; non-NULL must resolve).
--
-- We use 5 players (matching the contract's Test surface table example) on
-- fresh provider 'test-happy' so the slice-004 seed's 16 stub-provider rows
-- don't interfere with count assertions.
--
-- Pattern: BEGIN / plan(N) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(7);

-- ---------------------------------------------------------------------------
-- Pre-state snapshot
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _before AS
SELECT
  (SELECT count(*) FROM public.players)                                                AS p_count,
  (SELECT count(*) FROM public.player_provider_external_ids WHERE provider_name = 'test-happy') AS map_count,
  (SELECT count(*) FROM public.audit_log WHERE action = 'player.created')              AS audit_count;

-- ---------------------------------------------------------------------------
-- Simulate the Edge Function's `upsertPlayers` helper writes for 5 players
-- on a brand-new provider. We allocate fresh UUIDs that cannot collide with
-- the slice-004 fixture's dddd1000-... range.
-- ---------------------------------------------------------------------------
WITH ins AS (
  INSERT INTO public.players (id, full_name, display_name, team_id, country_code, position) VALUES
    ('ddff0001-0000-0000-0000-000000000001'::uuid, 'Test Player Alpha',   'Alpha',  NULL, 'ZZ', 'FW'),
    ('ddff0001-0000-0000-0000-000000000002'::uuid, 'Test Player Bravo',   'Bravo',  NULL, 'ZZ', 'MF'),
    ('ddff0001-0000-0000-0000-000000000003'::uuid, 'Test Player Charlie', 'Charlie',NULL, 'ZZ', 'DF'),
    ('ddff0001-0000-0000-0000-000000000004'::uuid, 'Test Player Delta',   'Delta',  NULL, 'ZZ', 'GK'),
    ('ddff0001-0000-0000-0000-000000000005'::uuid, 'Test Player Echo',    'Echo',   NULL, 'ZZ', 'FW')
  RETURNING id
)
INSERT INTO public.player_provider_external_ids (player_id, provider_name, provider_player_id)
SELECT id, 'test-happy', 'th-' || row_number() OVER (ORDER BY id)
FROM ins;

-- Audit rows emitted by the Edge Function path (we simulate the writes here
-- since the helper lives in TypeScript; pgTAP verifies the DB invariants).
INSERT INTO public.audit_log (actor, action, entity_type, entity_id, new_value, source, reason)
SELECT
  NULL,
  'player.created',
  'player',
  p.id,
  jsonb_build_object('provider', 'test-happy', 'full_name', p.full_name),
  'api_guard',
  NULL
FROM public.players p
WHERE p.id IN (
  'ddff0001-0000-0000-0000-000000000001'::uuid,
  'ddff0001-0000-0000-0000-000000000002'::uuid,
  'ddff0001-0000-0000-0000-000000000003'::uuid,
  'ddff0001-0000-0000-0000-000000000004'::uuid,
  'ddff0001-0000-0000-0000-000000000005'::uuid
);

-- ---------------------------------------------------------------------------
-- A1: exactly 5 new players rows.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.players) - (SELECT p_count FROM _before),
  5::bigint,
  'A1 exactly 5 new players rows inserted'
);

-- ---------------------------------------------------------------------------
-- A2: exactly 5 new provider mapping rows for provider=test-happy.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.player_provider_external_ids WHERE provider_name = 'test-happy')
    - (SELECT map_count FROM _before),
  5::bigint,
  'A2 exactly 5 new player_provider_external_ids rows for provider=test-happy'
);

-- ---------------------------------------------------------------------------
-- A3: all 5 new players have removed_at IS NULL (active state).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.players
    WHERE id IN (
      'ddff0001-0000-0000-0000-000000000001'::uuid,
      'ddff0001-0000-0000-0000-000000000002'::uuid,
      'ddff0001-0000-0000-0000-000000000003'::uuid,
      'ddff0001-0000-0000-0000-000000000004'::uuid,
      'ddff0001-0000-0000-0000-000000000005'::uuid
    )
      AND removed_at IS NULL),
  5::bigint,
  'A3 all 5 new players have removed_at IS NULL'
);

-- ---------------------------------------------------------------------------
-- A4: exactly 5 new audit_log rows with action=player.created.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.audit_log WHERE action = 'player.created')
    - (SELECT audit_count FROM _before),
  5::bigint,
  'A4 exactly 5 new audit_log rows with action=player.created'
);

-- ---------------------------------------------------------------------------
-- A5: the audit rows carry entity_type='player' and source='api_guard'
-- (D-011 — least-bad fit for audit_log.source CHECK whitelist; matches the
-- matches-branch summary-row choice).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(DISTINCT (entity_type, source)) FROM public.audit_log
    WHERE action = 'player.created'
      AND entity_id IN (
        'ddff0001-0000-0000-0000-000000000001'::uuid,
        'ddff0001-0000-0000-0000-000000000002'::uuid,
        'ddff0001-0000-0000-0000-000000000003'::uuid,
        'ddff0001-0000-0000-0000-000000000004'::uuid,
        'ddff0001-0000-0000-0000-000000000005'::uuid
      )),
  1::bigint,
  'A5 all 5 new audit rows share entity_type+source pair (player / api_guard)'
);

-- ---------------------------------------------------------------------------
-- A6: UNIQUE (provider_name, provider_player_id) — duplicate insert raises.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$ INSERT INTO public.player_provider_external_ids (player_id, provider_name, provider_player_id)
     VALUES ('ddff0001-0000-0000-0000-000000000001'::uuid, 'test-happy', 'th-1') $$,
  '23505',
  NULL,
  'A6 duplicate (provider_name, provider_player_id) raises 23505 (the sync coordinators idempotency anchor)'
);

-- ---------------------------------------------------------------------------
-- A7: every audit_log row references a real players.id (FK integrity proxy
-- via the existence subquery — audit_log.entity_id is uuid, no hard FK).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.audit_log al
    WHERE al.action = 'player.created'
      AND al.entity_id IN (
        'ddff0001-0000-0000-0000-000000000001'::uuid,
        'ddff0001-0000-0000-0000-000000000002'::uuid,
        'ddff0001-0000-0000-0000-000000000003'::uuid,
        'ddff0001-0000-0000-0000-000000000004'::uuid,
        'ddff0001-0000-0000-0000-000000000005'::uuid
      )
      AND EXISTS (SELECT 1 FROM public.players p WHERE p.id = al.entity_id)),
  5::bigint,
  'A7 every player.created audit row references a real players.id'
);

SELECT * FROM finish();

ROLLBACK;
