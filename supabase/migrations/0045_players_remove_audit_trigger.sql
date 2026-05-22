-- Slice 004 / T009 / FR-009 / Clarifications 2026-05-17 Q1. Fans out audit_log rows when a player is removed (removed_at flips NULL->NOT NULL). Does NOT mutate final_predictions -- runtime evaluation at score time via players.removed_at IS NULL join. Migration slot 0045 per D-016.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_player_removed_fan_out()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Fan out: one audit_log row per active final_prediction referencing
  -- the just-removed player. The final_predictions table is NOT mutated
  -- (per Clarifications 2026-05-17 Q1: keep the pick row active; evaluate
  -- at score time via players.removed_at IS NULL join in slice 005).
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source
  )
  SELECT
    fp.participant_id,
    'final_prediction.target_player_removed',
    'final_prediction',
    fp.id,
    jsonb_build_object('player_id', OLD.id, 'removed_at', OLD.removed_at),
    jsonb_build_object('player_id', NEW.id, 'removed_at', NEW.removed_at),
    'player_removed_from_roster',
    'trigger'
  FROM public.final_predictions fp
  WHERE fp.target_player_id = NEW.id
    AND fp.superseded_at IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS log_player_removed_fan_out ON public.players;
CREATE TRIGGER log_player_removed_fan_out
  AFTER UPDATE OF removed_at ON public.players
  FOR EACH ROW
  WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL)
  EXECUTE FUNCTION public.log_player_removed_fan_out();

COMMIT;
