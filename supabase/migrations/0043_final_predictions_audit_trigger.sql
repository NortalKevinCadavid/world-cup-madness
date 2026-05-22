-- Slice 004 / T008 / FR-011 / V (NON-NEGOTIABLE same-transaction audit) / mirrors slice 003 predictions trigger pattern. Migration slot 0043 per D-016. Player-removal fan-out audit lives in slot 0045 (T009).

BEGIN;

CREATE OR REPLACE FUNCTION public.log_final_prediction_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.superseded_at IS NULL THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, source
    )
    VALUES (
      COALESCE(NEW.created_by, NEW.participant_id),
      'final_prediction.created',
      'final_prediction',
      NEW.id,
      NULL,
      to_jsonb(NEW),
      'trigger'
    );
  ELSIF TG_OP = 'UPDATE'
        AND OLD.superseded_at IS NULL
        AND NEW.superseded_at IS NOT NULL THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, source
    )
    VALUES (
      (SELECT COALESCE(created_by, participant_id) FROM public.final_predictions WHERE id = NEW.superseded_by),
      'final_prediction.superseded',
      'final_prediction',
      NEW.id,
      to_jsonb(OLD),
      to_jsonb(NEW),
      'trigger'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS log_final_predictions_change ON public.final_predictions;
CREATE TRIGGER log_final_predictions_change
  AFTER INSERT OR UPDATE ON public.final_predictions
  FOR EACH ROW
  EXECUTE FUNCTION public.log_final_prediction_change();

COMMIT;
