-- Slice 005 follow-up (2026-05-23) — flip leaderboard_v from
-- security_invoker=true to security_invoker=false (DEFINER).
--
-- See specs/005-scoring-leaderboard/follow-up-leaderboard-rls-design-gap.md
-- for the full diagnosis. Short version:
--
--   The score_records RLS (migration 0056) defines only two SELECT
--   policies: score_records_self_read (participant_id IN own) and
--   score_records_admin_read (is_admin). There is NO policy for
--   "eligible participants can read every row for aggregate purposes."
--
--   leaderboard_v was authored with `security_invoker = true`, expecting
--   RLS on score_records to allow cross-participant aggregate reads.
--   Under the existing RLS, however, a non-admin participant querying
--   the view sees only their OWN aggregate row — the leaderboard
--   collapses to a self-only view, defeating its purpose.
--
--   Slice 005 acceptance scenario AS1 ("alpha views /leaderboard, then
--   6 rows MUST render in strictly descending total_points order") is
--   impossible to satisfy under the current security model. The slice
--   005 author's design intent — visible in the migration's leading
--   comment block about FR-014 display_name masking — clearly was that
--   every eligible participant sees everyone's totals (with display_name
--   masking per `tournament_config.leaderboard_visibility`).
--
-- Fix: change leaderboard_v to `security_invoker = false`. The view then
-- runs with the view owner's privileges (typically `postgres`), bypassing
-- RLS on score_records. The view exposes only aggregate columns
-- (rank, totals, exact/outcome counts, masked display_name) — never
-- per-row predicted/official scores. Privacy is preserved by the view's
-- column set + the visibility-masked display_name logic, NOT by RLS on
-- the underlying score_records (where RLS still enforces self-only +
-- admin-only access for direct queries against the table).
--
-- Why DEFINER (not a new aggregate-read RLS policy):
--   Adding `score_records_leaderboard_read AS SELECT TO authenticated
--   USING (is_eligible_nortal_participant(auth.uid()))` would let any
--   eligible participant query the score_records table DIRECTLY via the
--   REST API and read every row's per-prediction details. That's a
--   privacy regression. The DEFINER view confines cross-participant
--   reads to the AGGREGATE view surface, where columns + display_name
--   masking are designed for the leaderboard use case.
--
-- Peer views (peer_pick_v, peer_final_pick_v) intentionally stay
-- security_invoker=true — they need RLS to enforce self-exclusion and
-- per-match lock-window visibility per BR-LOCK-002/003/005. They do
-- NOT have the same "everyone aggregates everyone" design intent.
--
-- @see supabase/migrations/0054_leaderboard_views.sql (original view)
-- @see supabase/migrations/0056_score_rls.sql (score_records RLS)
-- @see specs/005-scoring-leaderboard/follow-up-leaderboard-rls-design-gap.md

BEGIN;

ALTER VIEW public.leaderboard_v SET (security_invoker = false);

-- Re-grant SELECT to authenticated explicitly (no-op if already granted;
-- defensive against any prior privilege reshuffle).
GRANT SELECT ON public.leaderboard_v TO authenticated;

COMMIT;
