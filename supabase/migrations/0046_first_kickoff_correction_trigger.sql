-- Slice 004 / T010 / FR-010 / BR-LOCK-005 / data-model.md § first_kickoff invariant. Captures audit visibility when any matches mutation could shift the dynamic first_kickoff_utc anchor that is_final_prediction_locked() reads. Predicate itself responds dynamically -- this trigger is OBSERVABILITY only, slice 006 admin tooling consumes. Migration slot 0046 per D-016.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_first_kickoff_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_first timestamptz;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Compute the current first scheduled kickoff (post-mutation state).
  SELECT MIN(kickoff_utc) INTO v_new_first
    FROM public.matches
   WHERE status = 'scheduled';

  -- Conservative: emit an audit row for every active final_prediction
  -- whenever any matches mutation could plausibly shift first_kickoff.
  -- The audit row captures the trigger event (which match changed, what
  -- changed, and what the new first kickoff is). Slice 006 admin tooling
  -- can deduplicate / filter as needed; this trigger errs on the side of
  -- visibility.
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source
  )
  SELECT
    fp.participant_id,
    'final_prediction.first_kickoff_correction',
    'final_prediction',
    fp.id,
    jsonb_build_object(
      'changed_match_id', NEW.id,
      'changed_match_old_kickoff', (CASE WHEN TG_OP = 'UPDATE' THEN OLD.kickoff_utc ELSE NULL END),
      'changed_match_old_status', (CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text ELSE NULL END)
    ),
    jsonb_build_object(
      'changed_match_id', NEW.id,
      'changed_match_new_kickoff', NEW.kickoff_utc,
      'changed_match_new_status', NEW.status::text,
      'first_kickoff_utc', v_new_first
    ),
    'first_kickoff_correction',
    'trigger'
  FROM public.final_predictions fp
  WHERE fp.superseded_at IS NULL;

  RETURN NEW;
END;
$$;

-- One trigger per event type. Use WHEN clauses to filter precisely so we
-- don't audit irrelevant column updates (e.g. venue).
DROP TRIGGER IF EXISTS log_first_kickoff_correction_update ON public.matches;
CREATE TRIGGER log_first_kickoff_correction_update
  AFTER UPDATE OF kickoff_utc, status ON public.matches
  FOR EACH ROW
  WHEN (
    OLD.kickoff_utc IS DISTINCT FROM NEW.kickoff_utc
    OR OLD.status IS DISTINCT FROM NEW.status
  )
  EXECUTE FUNCTION public.log_first_kickoff_correction();

DROP TRIGGER IF EXISTS log_first_kickoff_correction_insert ON public.matches;
CREATE TRIGGER log_first_kickoff_correction_insert
  AFTER INSERT ON public.matches
  FOR EACH ROW
  EXECUTE FUNCTION public.log_first_kickoff_correction();

COMMIT;
