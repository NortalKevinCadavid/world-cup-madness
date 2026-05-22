-- Slice 003 / FR-013 / Clarifications 2026-05-16 Q2 / research § R-008 — emits one audit_log row per active prediction when matches.kickoff_utc changes. Existing predictions are NOT modified. Slice 006 admin UI consumes these rows for per-participant reopen/relock decisions. Migration slot 0036 per D-012.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_kickoff_correction_crossed_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Recursion guard
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source
  )
  SELECT
    COALESCE(p.created_by, p.participant_id),
    'prediction.kickoff_correction_crossed_lock',
    'prediction',
    p.id,
    jsonb_build_object('kickoff_utc', OLD.kickoff_utc),
    jsonb_build_object('kickoff_utc', NEW.kickoff_utc),
    'kickoff_correction_crossed_lock',
    'trigger'
  FROM public.predictions p
  WHERE p.match_id = NEW.id
    AND p.superseded_at IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS log_kickoff_correction_crossed_lock ON public.matches;
CREATE TRIGGER log_kickoff_correction_crossed_lock
  AFTER UPDATE OF kickoff_utc ON public.matches
  FOR EACH ROW
  WHEN (OLD.kickoff_utc IS DISTINCT FROM NEW.kickoff_utc)
  EXECUTE FUNCTION public.log_kickoff_correction_crossed_lock();

COMMIT;
