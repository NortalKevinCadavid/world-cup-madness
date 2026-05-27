-- ============================================================================
-- 0088_bracket_v.sql  — Slice 010 / T008
-- ============================================================================
-- Own-bracket read view. One row per matchup with competitors RESOLVED from
-- the caller's upstream winner picks, plus the caller's own winner pick.
--
-- security_invoker = true: runs under the caller, so the bracket_picks
-- self-RLS scopes every pick subquery to the caller automatically.
--
-- Competitor resolution: a later-round matchup's slot-A competitor is the
-- winner the caller picked in the upstream matchup that feeds (this matchup,
-- slot 'A'). Because a pick stores winner_team_id directly, ONE level of
-- lookup resolves each slot for every round — no recursion needed (R32 uses
-- the stored seed; R16/QF/SF/Final read the single feeding pick).
--
-- data-model.md § View 1.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.bracket_v
WITH (security_invoker = true)
AS
SELECT
  m.id              AS matchup_id,
  m.round,
  m.position,
  -- Slot A: stored seed (R32) else the winner picked in the upstream
  -- matchup feeding slot A of this matchup.
  COALESCE(
    m.team_a_id,
    (SELECT bp.winner_team_id
       FROM public.bracket_picks bp
       JOIN public.bracket_matchups u ON u.id = bp.matchup_id
      WHERE u.next_matchup_id = m.id AND u.next_slot = 'A')
  )                 AS team_a_id,
  COALESCE(
    m.team_b_id,
    (SELECT bp.winner_team_id
       FROM public.bracket_picks bp
       JOIN public.bracket_matchups u ON u.id = bp.matchup_id
      WHERE u.next_matchup_id = m.id AND u.next_slot = 'B')
  )                 AS team_b_id,
  -- The caller's winner pick for this matchup (RLS-scoped to the caller).
  (SELECT bp.winner_team_id
     FROM public.bracket_picks bp
    WHERE bp.matchup_id = m.id)
                    AS winner_team_id,
  m.next_matchup_id,
  m.next_slot
FROM public.bracket_matchups m;

GRANT SELECT ON public.bracket_v TO authenticated;

COMMENT ON VIEW public.bracket_v IS
  'Slice 010 / T008. Own-bracket read: matchups with competitors resolved '
  'from the caller''s upstream winner picks. security_invoker=true. '
  'See data-model.md View 1.';

COMMIT;
