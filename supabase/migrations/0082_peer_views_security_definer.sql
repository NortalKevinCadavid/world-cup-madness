-- ============================================================================
-- 0082_peer_views_security_definer.sql
-- ============================================================================
-- Slice 005 follow-up — peer-pick views must aggregate across participants.
--
-- Problem (identical to 0081 for leaderboard_v):
--   peer_pick_v and peer_final_pick_v were shipped at slot 0054 with
--   security_invoker = true. The peer views' design intent is to surface
--   OTHER participants' predictions once the lock window has passed (FR-016).
--   But the underlying predictions / final_predictions tables have self-only
--   RLS (slots 0032 / 0042). Under security_invoker, the caller's RLS applies
--   inside the view's defining query — meaning the view only ever sees the
--   caller's own predictions, then the view's own self-exclusion predicate
--   drops those too, leaving an empty result set for every non-admin caller.
--
-- Empirical (pre-fix, post-lock state):
--   GET /api/peer-pick/<post-lock-match-id> as alpha → { "picks": [] }
--   GET /api/peer-final-pick/<bravo-uuid> after first kickoff as alpha →
--     { "pick": null }
--   Whereas FR-016 (and the slice-005 T023 acceptance set) requires both
--   surfaces to return the peers' picks once the lock predicate has fired.
--
-- Solution:
--   Flip both peer views to security_invoker = false (DEFINER posture). The
--   view runs with the owner's privileges — bypassing the underlying tables'
--   self-only RLS — but every visibility predicate the contract requires is
--   still enforced by the view body:
--     - peer_pick_v: lock-window gate (now() >= kickoff_utc - lock_window)
--                    + self-exclusion via auth.uid() → participants.id lookup
--     - peer_final_pick_v: first-kickoff gate (now() >= first_kickoff_utc)
--                    + self-exclusion (same idiom)
--   auth.uid() still resolves correctly under security_definer because it
--   reads the per-request `request.jwt.claims` session GUC, which PostgREST
--   sets before the view runs regardless of the view's invoker/definer
--   posture.
--
--   This mirrors the precedent set by 0081 for leaderboard_v: views whose
--   entire purpose is cross-participant aggregation must run as DEFINER and
--   own their RLS predicates in the view body.
--
-- Audit / authorization model (unchanged):
--   - The route handlers (/api/peer-pick, /api/peer-final-pick) still call
--     requireEligible() before SELECTing the view. The 401/403 gate is in
--     the route, not the view; the view's predicates are the lock/self
--     gates, not the auth gate.
--   - Underlying tables' RLS is unchanged. Direct queries to
--     `predictions` / `final_predictions` still deny non-self / non-admin
--     reads (slots 0032 / 0042 / 0056).
--   - SC-009 ("100% of attempts ... rejected at the server boundary") is
--     preserved: direct PostgREST queries to /rest/v1/peer_pick_v still hit
--     the view's lock-and-self predicates, just without the predictions-RLS
--     double-filter that was making the predicates unreachable.
--
-- See:
--   - specs/005-scoring-leaderboard/contracts/peer-pick.read.md §
--     Server-side gate (the predicates the view MUST enforce).
--   - specs/005-scoring-leaderboard/follow-up-peer-views-rls-design-gap.md
--     (this follow-up's root-cause writeup).
--   - supabase/migrations/0081_leaderboard_v_security_definer.sql (the
--     leaderboard_v precedent).
-- ============================================================================

BEGIN;

-- ---- peer_pick_v ----------------------------------------------------------
-- The view body is unchanged; only the security posture flips. Postgres
-- accepts ALTER VIEW ... SET (security_invoker = false) without forcing a
-- recreate, which preserves any grants and dependent objects.
ALTER VIEW public.peer_pick_v SET (security_invoker = false);

GRANT SELECT ON public.peer_pick_v TO authenticated;

COMMENT ON VIEW public.peer_pick_v IS
  'Slice 005 / T029 / FR-016 (match-pick half). DEFINER-side aggregation across '
  'participants — see migration 0082. Lock-window + self-exclusion enforced in '
  'the view body. admin_invalidated masking deferred to Slice 006.';

-- ---- peer_final_pick_v ----------------------------------------------------
ALTER VIEW public.peer_final_pick_v SET (security_invoker = false);

GRANT SELECT ON public.peer_final_pick_v TO authenticated;

COMMENT ON VIEW public.peer_final_pick_v IS
  'Slice 005 / T029 / FR-016 (final-tournament-pick half). DEFINER-side '
  'aggregation across participants — see migration 0082. First-kickoff gate + '
  'self-exclusion enforced in the view body. admin_invalidated masking deferred '
  'to Slice 006.';

COMMIT;
