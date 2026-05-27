-- ============================================================================
-- 0089_bracket_clear_invalid_picks.sql  — Slice 010 / T020 (US2 cascade)
-- ============================================================================
-- Authoritative downstream-pick cascade (research R-005 / FR-006): after a
-- participant changes an upstream winner, any of their later picks whose
-- winner can no longer reach its matchup MUST be cleared. Only impossible
-- picks are removed (a later pick for a still-reachable team survives).
--
-- A pick on matchup M is INVALID iff its winner is neither resolved
-- competitor of M, where a competitor is the seeded team (R32) or the
-- winner the caller picked in the upstream matchup feeding that slot.
-- Clearing a pick can make its own downstream unresolved, so we iterate to
-- a fixpoint (bounded by the 5-level tree depth).
--
-- SECURITY INVOKER (default): runs under the caller; bracket_picks self-RLS
-- guarantees it can only ever delete the caller's own picks even if a
-- mismatched participant_id is passed. Returns the cleared matchup ids.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.bracket_clear_invalid_picks(p_participant_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_cleared uuid[] := ARRAY[]::uuid[];
  v_round   uuid[];
BEGIN
  LOOP
    WITH resolved AS (
      SELECT
        m.id AS matchup_id,
        COALESCE(
          m.team_a_id,
          (SELECT bp.winner_team_id
             FROM public.bracket_picks bp
             JOIN public.bracket_matchups u ON u.id = bp.matchup_id
            WHERE bp.participant_id = p_participant_id
              AND u.next_matchup_id = m.id AND u.next_slot = 'A')
        ) AS ta,
        COALESCE(
          m.team_b_id,
          (SELECT bp.winner_team_id
             FROM public.bracket_picks bp
             JOIN public.bracket_matchups u ON u.id = bp.matchup_id
            WHERE bp.participant_id = p_participant_id
              AND u.next_matchup_id = m.id AND u.next_slot = 'B')
        ) AS tb
      FROM public.bracket_matchups m
    ),
    del AS (
      DELETE FROM public.bracket_picks bp
        USING resolved r
       WHERE bp.participant_id = p_participant_id
         AND bp.matchup_id = r.matchup_id
         AND bp.winner_team_id IS DISTINCT FROM r.ta
         AND bp.winner_team_id IS DISTINCT FROM r.tb
      RETURNING bp.matchup_id
    )
    SELECT array_agg(matchup_id) INTO v_round FROM del;

    EXIT WHEN v_round IS NULL;          -- fixpoint reached
    v_cleared := v_cleared || v_round;
  END LOOP;

  RETURN v_cleared;
END;
$$;

COMMENT ON FUNCTION public.bracket_clear_invalid_picks(uuid) IS
  'Slice 010 / T020 / FR-006. Deletes the participant''s downstream picks made '
  'impossible by an upstream change, to fixpoint. Returns cleared matchup ids. '
  'SECURITY INVOKER — self-RLS scopes deletes to the caller.';

GRANT EXECUTE ON FUNCTION public.bracket_clear_invalid_picks(uuid) TO authenticated;

COMMIT;
