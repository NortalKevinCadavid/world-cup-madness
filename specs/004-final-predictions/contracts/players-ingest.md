# Contract: Player Roster Ingest

**Slice**: 004-final-predictions
**Date**: 2026-05-16
**Status**: Phase 1 (Plan).

How the `public.players` table is populated. This slice activates Slice 002's previously-reserved `MatchDataProviderAdapter.fetchPlayers?()` optional method. Slice 002 specifically reserved the signature for this purpose (`specs/002-match-catalog/contracts/provider-adapter.contract.md` § Interface — "Optional. Adapters that can resolve player metadata implement this. Slice 002 does NOT call it; Slice 004 does.").

This contract describes the **producer side** (Slice 002's sync coordinator extension) and the **consumer side** (Slice 004's `players` table writes). The adapter interface itself is unchanged from Slice 002.

## Producer — Slice 002 sync coordinator extension

The `sync-catalog` Edge Function from Slice 002 (`supabase/functions/sync-catalog/index.ts`) gains a new branch in its UPSERT loop:

```typescript
// supabase/functions/sync-catalog/index.ts — modification owned by Slice 004 tasks
// (Slice 002 already imports the adapter; the new code paths consume the optional fetchPlayers method)

if (adapter.fetchPlayers !== undefined) {
  const players: NormalizedPlayer[] = await retryWithBackoff(() => adapter.fetchPlayers!());
  await upsertPlayers(players, syncRunId);
}
```

The `upsertPlayers(players, syncRunId)` helper:

1. For each `NormalizedPlayer`:
   - Lookup mapping via `player_provider_external_ids` (provider_name + provider_player_id).
   - If no mapping → INSERT `players` row + INSERT mapping row in same transaction; audit `player.created`.
   - If mapping exists → diff against current row. Apply non-conflicting changes (name updates, alias additions, team_id changes). Audit `player.updated`.
2. After processing all incoming players, compute the **set difference**: `seen_player_ids` (from this sync) vs `existing_active_player_ids` (from DB). For each existing player NOT in the seen set (i.e., the provider no longer returns them):
   - UPDATE `players SET removed_at = now() WHERE id = <player_id> AND removed_at IS NULL`.
   - This triggers a cascade audit per-active-final-prediction row (R-013) via the `players_after_remove` trigger from this slice.

The empty-payload guard from Slice 002's coordinator (R-004 of Slice 002) is **NOT applied** to players: an empty roster from the provider during the tournament is a possible signal that the season ended; we soft-delete-all rather than rejecting. The undersized threshold (50%) IS applied as a safety net; if the provider returns < 50% of the prior player count, the players branch is quarantined and an alert fires.

## Trigger — `players_after_remove`

```sql
CREATE OR REPLACE FUNCTION public.log_player_removed() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Skip recursion (defense)
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  -- For each active final_predictions row referencing the now-removed player,
  -- emit one audit_log row so Slice 006 admin UI can show "your pick is no longer
  -- on the roster" to affected participants.
  INSERT INTO public.audit_log (actor, action, entity_type, entity_id, previous_value, new_value, reason, source)
  SELECT
    fp.created_by,
    'final_prediction.target_player_removed',
    'final_prediction',
    fp.id,
    jsonb_build_object('target_player_id', NEW.id, 'player_full_name', OLD.full_name),
    jsonb_build_object('target_player_id', NEW.id, 'player_full_name', OLD.full_name, 'removed_at', NEW.removed_at),
    'player_removed_from_roster',
    'trigger'
  FROM public.final_predictions fp
  WHERE fp.target_player_id = NEW.id
    AND fp.superseded_at IS NULL;

  RETURN NEW;
END $$;

CREATE TRIGGER players_after_remove
  AFTER UPDATE OF removed_at ON public.players
  FOR EACH ROW
  WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL)
  EXECUTE FUNCTION public.log_player_removed();
```

## Consumer side — `players` table writes

Only the sync coordinator writes to `players` (and the trigger above writes derived audit rows). No participant-facing or admin-direct writes — the table is RLS-locked to admin-read + eligible-read; service-role writes happen inside the Edge Function.

## First-time bootstrap

When this slice ships, the `players` table is initially empty. The first sync invocation (cron or admin manual) that runs `fetchPlayers?()` populates it. Until then:
- `/api/players` returns `{players: [], total_matching: 0}`.
- The picker UI for `top_scorer` and `best_player` renders an empty "No players available yet — administrator is syncing roster data" message.
- Participants can still submit champion / runner-up picks (which use `teams`, not `players`).

A `data-bootstrap-instructions.md` artifact (out of `/speckit-tasks` scope) documents the operator's "first sync" runbook.

## Test surface

| File | Test |
|---|---|
| `players_ingest_happy.sql` (pgTAP) | Stub adapter returns 5 players; coordinator invokes `upsertPlayers`; assert 5 new `players` rows; 5 mapping rows; 5 audit `player.created` rows |
| `players_ingest_update.sql` (pgTAP) | Pre-state: 5 players. Stub returns same 5 with updated names. Assert UPDATE on name; 0 new rows; 5 audit `player.updated` rows |
| `players_ingest_soft_delete.sql` (pgTAP) | Pre-state: 5 players. Stub returns 4 (one removed). Assert: 4 players still active; 1 player has `removed_at IS NOT NULL`; 1 audit `player.updated` row; trigger fires `final_prediction.target_player_removed` if any active final_prediction referenced the removed player |
| `players_ingest_undersized_quarantined.sql` (pgTAP) | Pre-state: 100 players. Stub returns 30. Assert: no players modified; alert fired (R-004 undersized branch) |
| `slice-002-fetch-players-optional.deno.test.ts` | Verifies the coordinator runs successfully when `adapter.fetchPlayers === undefined` (e.g., a future adapter that doesn't implement the optional method) — fetchPlayers branch is skipped silently |

## Cross-slice contract summary

| Surface | Locked? |
|---|---|
| `MatchDataProviderAdapter.fetchPlayers?()` method (Slice 002 reserved; this slice activates) | **Locked** — additive change to Slice 002's interface contract |
| `players` table shape | **Locked by this slice** — Slice 005 + Slice 006 consume |
| `player_provider_external_ids` mapping table shape | **Locked by this slice** — mirrors Slice 002's `team_provider_external_ids` |
| `audit_log` action labels `player.created`, `player.updated`, `player.removed` | **Locked label set** |
| Soft-delete semantics (`removed_at` column instead of DELETE) | **Locked** — FK integrity for `final_predictions.target_player_id` depends on this |
| `players_after_remove` trigger emitting per-affected-prediction audit row | **Locked** — Slice 006 admin UI consumes |
