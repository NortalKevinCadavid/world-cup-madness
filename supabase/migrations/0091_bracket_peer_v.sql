-- ============================================================================
-- 0091_bracket_peer_v.sql  — Slice 010 / T034 (US4)
-- ============================================================================
-- Post-lock peer-bracket read. One row per (peer participant × matchup) with
-- competitors resolved from THAT peer's upstream picks. The entire result set
-- is gated on the lock (now() >= first_kickoff_utc) and excludes the caller —
-- before lock, ANY target yields zero rows (FR-017/FR-018, SC-005 non-leak).
--
-- security_invoker = false (DEFINER, research R-002): bracket_picks has
-- self-only RLS (migration 0085), so under INVOKER this cross-participant view
-- would collapse to the caller's own rows (then self-exclusion drops those →
-- always empty). DEFINER bypasses the underlying self-RLS; the lock +
-- self-exclusion predicates in the view body ARE the visibility gate
-- (Principle III — rules outside the UI). Mirrors the slice-005 precedent
-- (migration 0082 peer_pick_v / peer_final_pick_v).
--
-- auth.uid() still resolves under DEFINER (it reads request.jwt.claims, which
-- PostgREST sets per-request regardless of view posture).
--
-- data-model.md § View 2. Contract: contracts/bracket-peer.read.md.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.bracket_peer_v
WITH (security_invoker = false)
AS
WITH first_kick AS (
  SELECT (value #>> '{}')::timestamptz AS kickoff
    FROM public.tournament_config
   WHERE key = 'first_kickoff_utc'
),
vis AS (
  -- Same FR-014 visibility policy as leaderboard_v / peer_*_v.
  SELECT (value #>> '{}') AS visibility
    FROM public.tournament_config
   WHERE key = 'leaderboard_visibility'
),
caller AS (
  -- auth.uid() → participants.id for self-exclusion. NULL JWT → no rows → the
  -- NOT IN is vacuously TRUE, but the lock gate + DEFINER grant still bound it.
  SELECT p.id AS participant_id
    FROM public.participants p
   WHERE p.auth_user_id = auth.uid()
   LIMIT 1
),
peers AS (
  -- Only participants who have actually made picks surface as peers.
  SELECT DISTINCT participant_id FROM public.bracket_picks
)
SELECT
  peers.participant_id,
  CASE (SELECT visibility FROM vis)
    WHEN 'anonymized' THEN 'Participant ' || substring(peers.participant_id::text, 1, 8)
    ELSE COALESCE(p.display_name, 'Anonymous')
  END AS display_name,
  m.id       AS matchup_id,
  m.round,
  m.position,
  COALESCE(
    m.team_a_id,
    (SELECT bp.winner_team_id
       FROM public.bracket_picks bp
       JOIN public.bracket_matchups u ON u.id = bp.matchup_id
      WHERE bp.participant_id = peers.participant_id
        AND u.next_matchup_id = m.id AND u.next_slot = 'A')
  )          AS team_a_id,
  COALESCE(
    m.team_b_id,
    (SELECT bp.winner_team_id
       FROM public.bracket_picks bp
       JOIN public.bracket_matchups u ON u.id = bp.matchup_id
      WHERE bp.participant_id = peers.participant_id
        AND u.next_matchup_id = m.id AND u.next_slot = 'B')
  )          AS team_b_id,
  (SELECT bp.winner_team_id
     FROM public.bracket_picks bp
    WHERE bp.participant_id = peers.participant_id
      AND bp.matchup_id = m.id)
             AS winner_team_id,
  m.next_matchup_id,
  m.next_slot,
  -- Post-lock the bracket is locked for everyone (precedence: locked dominates).
  'locked'::text AS submission_status
FROM peers
CROSS JOIN public.bracket_matchups m
JOIN public.participants p ON p.id = peers.participant_id
-- BR-LOCK-005 strict-inclusive: the whole set is hidden until first kickoff.
-- now() >= NULL is NULL (no rows) when the config is unset → fail-closed.
WHERE now() >= (SELECT kickoff FROM first_kick)
  AND peers.participant_id NOT IN (SELECT participant_id FROM caller);

COMMENT ON VIEW public.bracket_peer_v IS
  'Slice 010 / T034 / FR-017,FR-018,FR-019. Post-lock peer-bracket read. '
  'DEFINER (research R-002) — lock + self-exclusion gates live in the view body. '
  'Pre-lock returns zero rows for any target (non-leak). See data-model.md View 2.';

REVOKE ALL ON public.bracket_peer_v FROM PUBLIC, anon;
GRANT SELECT ON public.bracket_peer_v TO authenticated;

COMMIT;
