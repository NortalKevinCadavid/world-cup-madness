-- Slice 003 / FR-011 / Constitution V (NON-NEGOTIABLE same-transaction audit) / mirrors slice 001 + 002 trigger patterns. Migration slot 0033 per D-012. Rejection-path audit rows are written by submit_prediction() SP (T013), not this trigger -- this trigger handles state-change audits only.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_prediction_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
BEGIN
  -- Recursion guard (mirrors slice 001 pattern)
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.superseded_at IS NULL THEN
    -- New active prediction (the SP creates the row; participant_id is the actor)
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, source
    )
    VALUES (
      COALESCE(NEW.created_by, NEW.participant_id),
      'prediction.created',
      'prediction',
      NEW.id,
      NULL,
      to_jsonb(NEW),
      'trigger'
    );
  ELSIF TG_OP = 'UPDATE'
        AND OLD.superseded_at IS NULL
        AND NEW.superseded_at IS NOT NULL THEN
    -- Supersede transition
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, source
    )
    VALUES (
      (SELECT COALESCE(created_by, participant_id) FROM public.predictions WHERE id = NEW.superseded_by),
      'prediction.superseded',
      'prediction',
      NEW.id,
      to_jsonb(OLD),
      to_jsonb(NEW),
      'trigger'
    );
  END IF;
  -- Other UPDATEs (e.g., updated_at maintenance) -> no audit row.

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS log_predictions_change ON public.predictions;
CREATE TRIGGER log_predictions_change
  AFTER INSERT OR UPDATE ON public.predictions
  FOR EACH ROW
  EXECUTE FUNCTION public.log_prediction_change();

COMMIT;
