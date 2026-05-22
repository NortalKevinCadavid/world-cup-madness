-- Slice 003 / FR-007 / FR-008 / contracts/prediction-lock.predicate.sql.md -- LOCKED CROSS-SLICE CONTRACT: signature (p_match_id uuid) RETURNS boolean STABLE. Slice 005 peer_pick_v + Slice 006 admin tooling reference this function by name. Renames/signature changes require coordinating regression updates across consumers. Migration slot 0031 per D-012.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_prediction_locked(p_match_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status          text;
  v_kickoff_utc     timestamptz;
  v_lock_window_min int;
BEGIN
  SELECT status::text, kickoff_utc INTO v_status, v_kickoff_utc
  FROM public.matches
  WHERE id = p_match_id;

  -- Fail-closed: unknown match -> locked.
  IF v_status IS NULL THEN RETURN true; END IF;

  -- BR-LOCK-004: any non-scheduled status locks the match.
  IF v_status <> 'scheduled' THEN RETURN true; END IF;

  -- BR-LOCK-002 / BR-LOCK-003: strict boundary on >= (NOT >). At exactly
  -- kickoff - lock_window the match is locked.
  SELECT COALESCE((value::text)::int, 60) INTO v_lock_window_min
  FROM public.tournament_config
  WHERE key = 'lock_window_minutes';

  RETURN now() >= v_kickoff_utc - (v_lock_window_min * INTERVAL '1 minute');
END $$;

GRANT EXECUTE ON FUNCTION public.is_prediction_locked(uuid) TO authenticated;

-- Smoke test (run manually after db reset):
--   SELECT public.is_prediction_locked(gen_random_uuid());
--   -- Expected: TRUE (fail-closed on unknown match per spec § Edge Cases)

COMMIT;
