-- Slice 004 / T031 / contracts/players-ingest.md
--
-- pgTAP coverage for the players-ingest set-difference soft-delete path
-- and the `log_player_removed_fan_out` trigger from migration 0045.
--
-- Pre-state: 2 existing players + mappings on provider='test-softdel'.
-- One has a final_prediction targeting it (charlie/best_player), so we can
-- verify the trigger fans out a `final_prediction.target_player_removed`
-- audit row when that player gets soft-deleted.
--
-- Simulation: the coordinator's set-difference computation determines that
-- only ONE of the two players appeared in the incoming roster — the OTHER
-- gets `removed_at = now()`. We do the UPDATE directly here (the
-- coordinator helper does the same write); the 0045 trigger fires on the
-- NULL -> non-NULL transition regardless of who issued the UPDATE.
--
-- Assertions:
--   1. The seen player remains active (removed_at IS NULL).
--   2. The unseen player has removed_at IS NOT NULL.
--   3. Exactly 1 new `final_prediction.target_player_removed` audit row was
--      emitted (the slice-004 fan-out trigger fires per active prediction
--      that references the just-removed player).
--   4. The audit row's entity_id points at the affected final_prediction.
--   5. The audit row's source = 'trigger' (per the migration 0045 function).
--
-- Pattern: BEGIN / plan(N) / asserts / finish / ROLLBACK. ROLLBACK undoes
-- the simulated UPDATE so subsequent tests see the original fixture.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Pre-state: 2 players on provider='test-softdel', one of which is
-- referenced by an active final_prediction. We use the EXISTING slice-004
-- fixture's charlie/best_player -> Pedri row (Row 6, fp id dddd2000-...-6)
-- as the predicate-bearing prediction; we add a NEW player to soft-delete
-- so we don't violate any other tests' fixture assumptions. The "kept"
-- player is a new synthetic that nothing references.
-- ---------------------------------------------------------------------------

-- "kept" player (will remain in the incoming roster)
INSERT INTO public.players (id, full_name, display_name, team_id, country_code, position) VALUES
  ('ddff0003-0000-0000-0000-000000000001'::uuid, 'Kept Player',    'Kept',    NULL, 'ZZ', 'FW');

-- "to-be-soft-deleted" player — referenced by an active prediction. We
-- INSERT a fresh prediction row pointing at this player so the trigger
-- fan-out has something to write about. Use charlie (33333333-...) +
-- item_kind='top_scorer' (charlie has best_player in the fixture but no
-- top_scorer, so this fresh row passes the unique partial index).
INSERT INTO public.players (id, full_name, display_name, team_id, country_code, position) VALUES
  ('ddff0003-0000-0000-0000-000000000002'::uuid, 'Removed Player', 'Removed', NULL, 'ZZ', 'FW');

INSERT INTO public.player_provider_external_ids (player_id, provider_name, provider_player_id) VALUES
  ('ddff0003-0000-0000-0000-000000000001'::uuid, 'test-softdel', 'tsd-1'),
  ('ddff0003-0000-0000-0000-000000000002'::uuid, 'test-softdel', 'tsd-2');

INSERT INTO public.final_predictions (
  id, participant_id, item_kind, target_team_id, target_player_id,
  source, superseded_at, superseded_by, created_by
) VALUES (
  'ddff0099-0000-0000-0000-000000000001'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie (slice-001 fixture)
  'top_scorer',
  NULL,
  'ddff0003-0000-0000-0000-000000000002'::uuid,  -- the to-be-removed player
  'ui', NULL, NULL,
  '33333333-3333-3333-3333-333333333333'::uuid
);

CREATE TEMP TABLE _before AS
SELECT
  (SELECT count(*) FROM public.audit_log WHERE action = 'final_prediction.target_player_removed') AS removed_audit_count;

-- ---------------------------------------------------------------------------
-- Simulate the coordinator's set-difference soft-delete on the unseen
-- player. The 0045 trigger fires AFTER the UPDATE of removed_at NULL ->
-- non-NULL and writes the fan-out audit row in the SAME transaction.
-- ---------------------------------------------------------------------------
UPDATE public.players
   SET removed_at = now()
 WHERE id = 'ddff0003-0000-0000-0000-000000000002'::uuid
   AND removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- A1: the "kept" player remains active.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT removed_at FROM public.players WHERE id = 'ddff0003-0000-0000-0000-000000000001'::uuid),
  NULL::timestamptz,
  'A1 the kept player remains active (removed_at IS NULL)'
);

-- ---------------------------------------------------------------------------
-- A2: the "to-be-removed" player has removed_at set.
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT removed_at FROM public.players WHERE id = 'ddff0003-0000-0000-0000-000000000002'::uuid)
    IS NOT NULL,
  'A2 the unseen player has removed_at IS NOT NULL after the soft-delete'
);

-- ---------------------------------------------------------------------------
-- A3: exactly 1 new `final_prediction.target_player_removed` audit row was
-- emitted by the 0045 trigger fan-out.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.audit_log
    WHERE action = 'final_prediction.target_player_removed')
    - (SELECT removed_audit_count FROM _before),
  1::bigint,
  'A3 exactly 1 new final_prediction.target_player_removed audit row (trigger fan-out)'
);

-- ---------------------------------------------------------------------------
-- A4: the new audit row's entity_id points at the affected final_prediction.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT entity_id FROM public.audit_log
    WHERE action    = 'final_prediction.target_player_removed'
      AND entity_id = 'ddff0099-0000-0000-0000-000000000001'::uuid
    ORDER BY occurred_at DESC
    LIMIT 1),
  'ddff0099-0000-0000-0000-000000000001'::uuid,
  'A4 the audit row.entity_id matches the affected final_prediction.id'
);

-- ---------------------------------------------------------------------------
-- A5: the audit row source='trigger' (migration 0045 writes the fan-out as
-- a trigger-side-effect; this distinguishes it from the player-level
-- 'player.removed' rows the Edge Function writes with source='api_guard').
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT source FROM public.audit_log
    WHERE action    = 'final_prediction.target_player_removed'
      AND entity_id = 'ddff0099-0000-0000-0000-000000000001'::uuid
    ORDER BY occurred_at DESC
    LIMIT 1),
  'trigger'::text,
  'A5 the trigger-emitted audit row carries source=trigger'
);

SELECT * FROM finish();

ROLLBACK;
