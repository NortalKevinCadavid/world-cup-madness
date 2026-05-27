-- ============================================================================
-- 0087_bracket_status_fn.sql  — Slice 010 / T007
-- ============================================================================
-- Single source of truth for bracket progress (Constitution III / FR-014).
-- Returns total_required, completed, is_complete, missing_matchup_ids[],
-- submission_status. The lock is read from tournament_config.first_kickoff_utc
-- via server/DB time only (Principle VI).
--
-- data-model.md § Derived. SECURITY INVOKER (default): runs under the caller,
-- so bracket_picks self-RLS scopes the pick count to the caller. Admins
-- calling for another participant see that participant's picks via
-- bracket_picks_admin_read.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.bracket_status(p_participant_id uuid)
RETURNS TABLE (
  total_required       int,
  completed            int,
  is_complete          boolean,
  missing_matchup_ids  uuid[],
  submission_status    text
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_total      int;
  v_completed  int;
  v_missing    uuid[];
  v_lock       timestamptz;
  v_submitted  boolean;
  v_status     text;
BEGIN
  SELECT count(*) INTO v_total FROM public.bracket_matchups;

  SELECT count(DISTINCT bp.matchup_id) INTO v_completed
    FROM public.bracket_picks bp
   WHERE bp.participant_id = p_participant_id;

  SELECT array_agg(m.id ORDER BY m.round, m.position) INTO v_missing
    FROM public.bracket_matchups m
   WHERE NOT EXISTS (
     SELECT 1 FROM public.bracket_picks bp
      WHERE bp.participant_id = p_participant_id
        AND bp.matchup_id = m.id
   );

  v_missing := COALESCE(v_missing, ARRAY[]::uuid[]);

  SELECT (value #>> '{}')::timestamptz INTO v_lock
    FROM public.tournament_config WHERE key = 'first_kickoff_utc';

  SELECT EXISTS (
    SELECT 1 FROM public.bracket_submissions s
     WHERE s.participant_id = p_participant_id
  ) INTO v_submitted;

  -- Precedence: locked > submitted > complete > draft.
  IF v_lock IS NOT NULL AND now() >= v_lock THEN
    v_status := 'locked';
  ELSIF v_submitted THEN
    v_status := 'submitted';
  ELSIF v_completed = v_total AND v_total > 0 THEN
    v_status := 'complete';
  ELSE
    v_status := 'draft';
  END IF;

  total_required      := v_total;
  completed           := v_completed;
  is_complete         := (v_completed = v_total AND v_total > 0);
  missing_matchup_ids := v_missing;
  submission_status   := v_status;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.bracket_status(uuid) IS
  'Slice 010 / T007 / FR-014. Single bracket-progress source of truth. '
  'Lock from tournament_config.first_kickoff_utc (server time). '
  'See data-model.md § Derived.';

GRANT EXECUTE ON FUNCTION public.bracket_status(uuid) TO authenticated;

COMMIT;
