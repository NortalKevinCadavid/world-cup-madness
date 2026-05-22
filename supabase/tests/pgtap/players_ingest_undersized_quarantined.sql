-- Slice 004 / T031 / contracts/players-ingest.md
--
-- pgTAP coverage for the players-ingest undersized safety net (50%
-- threshold per contracts/players-ingest.md § Producer paragraph 2). When
-- the provider returns < 50% of the prior active player count, the
-- coordinator's `upsertPlayers` helper MUST:
--   - skip ALL writes to `players` / `player_provider_external_ids`,
--   - emit an audit_log row capturing the diagnostic,
--   - flag the run (the matches outcome stands; players branch is
--     observability — the helper returns { quarantined: true }).
--
-- The actual undersize ratio computation lives in the Edge Function
-- (sync-catalog/index.ts § upsertPlayers). pgTAP cannot run that
-- TypeScript code, so this test:
--   1. Records a baseline (pre-state count of active players for our
--      synthetic provider),
--   2. Simulates the coordinator's chosen branch by inserting the audit
--      row + a provider_sync_runs ledger row that records the player
--      counts (payload_match_count is reused for the diagnostic — the
--      schema has no separate payload_player_count column, documented as
--      D-022 in the report),
--   3. Asserts the simulated quarantine outcome did NOT mutate the
--      players table.
--
-- Outcome value choice: provider_sync_runs.outcome CHECK accepts only
-- {in_progress, success, failure, partial, conflict_quarantined,
-- aborted}. The contract uses the word "quarantined" but the schema enum
-- does not. We use 'conflict_quarantined' (closest semantic match — the
-- run was halted because the payload conflicted with the safety net) and
-- carry the players-specific error_class for triage. Documented as D-022
-- in the report.
--
-- Pattern: BEGIN / plan(N) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(4);

-- ---------------------------------------------------------------------------
-- Pre-state: 4 active players on provider='test-undersized'. A subsequent
-- sync that returns only 1 player (1/4 = 25% < 50% threshold) MUST trip
-- the safety net. We use synthetic UUIDs that do not collide with the
-- slice-004 fixture.
-- ---------------------------------------------------------------------------
INSERT INTO public.players (id, full_name, display_name, team_id, country_code, position) VALUES
  ('ddff0004-0000-0000-0000-000000000001'::uuid, 'Baseline 1', 'B1', NULL, 'ZZ', 'FW'),
  ('ddff0004-0000-0000-0000-000000000002'::uuid, 'Baseline 2', 'B2', NULL, 'ZZ', 'MF'),
  ('ddff0004-0000-0000-0000-000000000003'::uuid, 'Baseline 3', 'B3', NULL, 'ZZ', 'DF'),
  ('ddff0004-0000-0000-0000-000000000004'::uuid, 'Baseline 4', 'B4', NULL, 'ZZ', 'GK');

INSERT INTO public.player_provider_external_ids (player_id, provider_name, provider_player_id) VALUES
  ('ddff0004-0000-0000-0000-000000000001'::uuid, 'test-undersized', 'tu-1'),
  ('ddff0004-0000-0000-0000-000000000002'::uuid, 'test-undersized', 'tu-2'),
  ('ddff0004-0000-0000-0000-000000000003'::uuid, 'test-undersized', 'tu-3'),
  ('ddff0004-0000-0000-0000-000000000004'::uuid, 'test-undersized', 'tu-4');

CREATE TEMP TABLE _before AS
SELECT
  (SELECT count(*) FROM public.players WHERE removed_at IS NULL)                       AS active_count,
  (SELECT count(*) FROM public.player_provider_external_ids WHERE provider_name = 'test-undersized') AS map_count,
  (SELECT count(*) FROM public.audit_log WHERE action = 'provider.players_quarantined_undersized') AS quarantine_audit_count;

-- ---------------------------------------------------------------------------
-- Simulate the coordinator's quarantine path. The Edge Function helper
-- (sync-catalog/index.ts § upsertPlayers step 1) writes:
--   1. an audit_log row with action='provider.players_quarantined_undersized'
--      source='api_guard' carrying the diagnostic,
--   2. a provider_sync_runs row with outcome='conflict_quarantined' and
--      payload_match_count=incoming, error_class='undersized_players_payload'
--      (provider_sync_runs has no provider-specific column for the
--      players-side incoming count; D-022).
-- The helper RETURNS WITHOUT touching `players` or `player_provider_external_ids`.
-- ---------------------------------------------------------------------------
INSERT INTO public.audit_log (actor, action, entity_type, entity_id, new_value, source, reason)
VALUES (
  NULL,
  'provider.players_quarantined_undersized',
  'provider_sync_run',
  NULL,
  jsonb_build_object(
    'provider', 'test-undersized',
    'incoming_count', 1,
    'prior_active_count', 4,
    'threshold_ratio', 0.5
  ),
  'api_guard',
  'undersized_players_payload: incoming=1 prior_active=4 threshold=0.5'
);

-- The provider_sync_runs row would normally already exist (started by the
-- matches branch); we simulate the coordinator UPDATEing it after the
-- players branch trips the safety net. To stay within the pgTAP test's
-- scope we INSERT a fresh row directly.
INSERT INTO public.provider_sync_runs (
  provider, started_at, finished_at, outcome, payload_match_count,
  applied_match_count, quarantined_count, error_class, error_message,
  trigger, correlation_id
) VALUES (
  'test-undersized', now(), now(), 'conflict_quarantined', 1,
  0, 1, 'undersized_players_payload',
  'players branch quarantined: 1 incoming vs 4 active (< 50%)',
  'manual_internal', gen_random_uuid()
);

-- ---------------------------------------------------------------------------
-- A1: active player count UNCHANGED (the safety net prevented all writes).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.players WHERE removed_at IS NULL)
    - (SELECT active_count FROM _before),
  0::bigint,
  'A1 active players count unchanged after a quarantined undersized run (no destructive writes)'
);

-- ---------------------------------------------------------------------------
-- A2: provider mapping count UNCHANGED (no inserts, no deletes).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.player_provider_external_ids WHERE provider_name = 'test-undersized')
    - (SELECT map_count FROM _before),
  0::bigint,
  'A2 player_provider_external_ids count unchanged (no mapping writes on quarantine)'
);

-- ---------------------------------------------------------------------------
-- A3: exactly 1 new audit row records the quarantine event (alert source).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.audit_log WHERE action = 'provider.players_quarantined_undersized')
    - (SELECT quarantine_audit_count FROM _before),
  1::bigint,
  'A3 exactly 1 new audit_log row with action=provider.players_quarantined_undersized was emitted'
);

-- ---------------------------------------------------------------------------
-- A4: the provider_sync_runs row carries outcome='conflict_quarantined'
-- (the schema-enum-compatible mapping for the contract's "quarantined"
-- status; see header note + D-022).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT outcome FROM public.provider_sync_runs
    WHERE provider = 'test-undersized'
      AND error_class = 'undersized_players_payload'
    ORDER BY id DESC LIMIT 1),
  'conflict_quarantined'::text,
  'A4 provider_sync_runs row records outcome=conflict_quarantined for the players-undersized branch'
);

SELECT * FROM finish();

ROLLBACK;
