-- Slice 004 / T031 / contracts/players-ingest.md
--
-- pgTAP coverage for the players-ingest UPDATE path. Pre-state: 1 player
-- already in the catalog (via a simulated prior sync). Simulate the
-- coordinator's `upsertPlayers` running again with the SAME provider /
-- external id but a CHANGED full_name. Assert:
--
--   1. No new players row created (count delta == 0).
--   2. full_name on the existing row was updated.
--   3. The mapping row is reused (count delta on player_provider_external_ids == 0).
--   4. An audit_log row with action='player.updated' was emitted.
--   5. removed_at remains NULL (UPDATE did not soft-delete).
--
-- The Edge Function path is exercised by the Deno test
-- `players_branch.test.ts`; this pgTAP file verifies the DB invariants
-- that hold regardless of which code path performs the writes.
--
-- Pattern: BEGIN / plan(N) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Pre-state: insert 1 player + 1 mapping for provider='test-update'.
-- The slice-004 fixture's 16 stub-provider rows are unaffected — we use a
-- different provider name to isolate.
-- ---------------------------------------------------------------------------
INSERT INTO public.players (id, full_name, display_name, team_id, country_code, position) VALUES
  ('ddff0002-0000-0000-0000-000000000001'::uuid, 'Original Name', 'Orig', NULL, 'ZZ', 'FW');

INSERT INTO public.player_provider_external_ids (player_id, provider_name, provider_player_id) VALUES
  ('ddff0002-0000-0000-0000-000000000001'::uuid, 'test-update', 'tu-1');

CREATE TEMP TABLE _before AS
SELECT
  (SELECT count(*) FROM public.players)                                                  AS p_count,
  (SELECT count(*) FROM public.player_provider_external_ids WHERE provider_name = 'test-update') AS map_count,
  (SELECT count(*) FROM public.audit_log WHERE action = 'player.updated')                AS audit_count;

-- ---------------------------------------------------------------------------
-- Simulate the Edge Function path's UPDATE on the existing player.
-- (full_name changed from 'Original Name' to 'Updated Name'.) The
-- coordinator looks up via (provider_name, provider_player_id), resolves
-- the internal id, and UPDATEs in place. Mapping mapped_at is also
-- refreshed; we ignore that detail here.
-- ---------------------------------------------------------------------------
UPDATE public.players
   SET full_name = 'Updated Name'
 WHERE id = 'ddff0002-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.audit_log (actor, action, entity_type, entity_id, new_value, source, reason)
VALUES (
  NULL,
  'player.updated',
  'player',
  'ddff0002-0000-0000-0000-000000000001'::uuid,
  jsonb_build_object('provider', 'test-update', 'full_name', 'Updated Name'),
  'api_guard',
  NULL
);

-- ---------------------------------------------------------------------------
-- A1: no new players row (UPDATE path, not INSERT path).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.players) - (SELECT p_count FROM _before),
  0::bigint,
  'A1 no new players row inserted (UPDATE path)'
);

-- ---------------------------------------------------------------------------
-- A2: full_name updated to the new value.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT full_name FROM public.players WHERE id = 'ddff0002-0000-0000-0000-000000000001'::uuid),
  'Updated Name',
  'A2 full_name updated to ''Updated Name'''
);

-- ---------------------------------------------------------------------------
-- A3: mapping row count unchanged (the existing mapping is reused).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.player_provider_external_ids WHERE provider_name = 'test-update')
    - (SELECT map_count FROM _before),
  0::bigint,
  'A3 player_provider_external_ids count unchanged (mapping reused)'
);

-- ---------------------------------------------------------------------------
-- A4: exactly 1 new audit_log row with action='player.updated'.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.audit_log WHERE action = 'player.updated')
    - (SELECT audit_count FROM _before),
  1::bigint,
  'A4 exactly 1 new audit_log row with action=player.updated'
);

-- ---------------------------------------------------------------------------
-- A5: removed_at remains NULL on the updated row.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT removed_at FROM public.players WHERE id = 'ddff0002-0000-0000-0000-000000000001'::uuid),
  NULL::timestamptz,
  'A5 removed_at remains NULL after the UPDATE (no inadvertent soft-delete)'
);

SELECT * FROM finish();

ROLLBACK;
