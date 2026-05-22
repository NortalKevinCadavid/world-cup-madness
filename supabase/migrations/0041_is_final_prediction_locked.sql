-- Slice 004 / T005 / FR-010 / BR-LOCK-005 / contracts/final-prediction-lock.predicate.sql.md — LOCKED CROSS-SLICE CONTRACT: zero-arg, RETURNS boolean STABLE. Slice 005 peer-pick views + Slice 006 admin tooling reference by name. Migration slot 0041 per D-016. Body copied verbatim from the authoritative contract: fail-CLOSED on missing tournament_config.first_kickoff_utc; strict >= boundary inherited from BR-LOCK-002.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_final_prediction_locked()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first_kickoff timestamptz;
BEGIN
  SELECT (value::text)::timestamptz INTO v_first_kickoff
  FROM public.tournament_config
  WHERE key = 'first_kickoff_utc';

  IF v_first_kickoff IS NULL THEN RETURN true; END IF;    -- fail-closed
  RETURN now() >= v_first_kickoff;                        -- BR-LOCK-005 strict boundary
END $$;

REVOKE EXECUTE ON FUNCTION public.is_final_prediction_locked() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_final_prediction_locked() TO authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.is_final_prediction_locked() TO service_role';
  END IF;
END $$;

-- Smoke test (run manually after db reset):
--   SELECT public.is_final_prediction_locked();
--   -- Expected: TRUE when tournament_config has no 'first_kickoff_utc' row (fail-closed per contract).

COMMIT;
