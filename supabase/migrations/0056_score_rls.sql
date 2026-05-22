-- Slice 005 / T007 / data-model.md § RLS posture summary.
-- Migration slot 0056 per D-023.
-- RLS on score_records (participant + admin read), score_calculation_runs (admin read only),
-- tournament_award (eligible read + admin write).
-- Writes to score_records flow through service_role from Edge Function (T015/T020); no auth-role insert policy.
-- is_admin is the Slice 001 stub by default; Slice 006 replaces with real semantics.

BEGIN;

-- ---------------------------------------------------------------------------
-- Section 1 -- score_records RLS
-- ---------------------------------------------------------------------------
-- data-model.md § RLS posture summary: participants can read their own
-- score_records rows (eligible Nortal predicate gated); admins can read all.
-- Writes flow exclusively through the score-trigger Edge Function (T015/T020)
-- under service_role (which bypasses RLS) -- NO insert/update/delete policies
-- are defined here, so any direct auth-role write attempt is denied by default.
ALTER TABLE public.score_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.score_records FORCE ROW LEVEL SECURITY;

-- D-024: score_records.participant_id FKs to public.participants(id), NOT auth.users(id).
-- Mirror slice 004's pattern (0042_final_predictions_rls.sql) by mapping auth.uid() -> participants.id.
CREATE POLICY score_records_self_read ON public.score_records
  FOR SELECT
  TO authenticated
  USING (
    participant_id IN (
      SELECT id FROM public.participants WHERE auth_user_id = auth.uid()
    )
    AND public.is_eligible_nortal_participant(auth.uid())
  );

CREATE POLICY score_records_admin_read ON public.score_records
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Section 2 -- score_calculation_runs RLS
-- ---------------------------------------------------------------------------
-- data-model.md § RLS posture summary: admin-only read. No participant
-- visibility (this is internal scoring-run bookkeeping). Writes flow through
-- service_role from the score-trigger Edge Function -- no write policy here.
ALTER TABLE public.score_calculation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.score_calculation_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY score_calculation_runs_admin_read ON public.score_calculation_runs
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Section 3 -- tournament_award RLS
-- ---------------------------------------------------------------------------
-- data-model.md § RLS posture summary: read for eligible Nortal participants
-- (needed by leaderboard / personal_breakdown / peer_final_pick views) OR
-- admins. Write for admins only (Slice 006 owns the admin UI; this slice
-- expresses the policy now so the table is locked down on first deploy).
ALTER TABLE public.tournament_award ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_award FORCE ROW LEVEL SECURITY;

CREATE POLICY tournament_award_eligible_read ON public.tournament_award
  FOR SELECT
  TO authenticated
  USING (
    public.is_eligible_nortal_participant(auth.uid())
    OR public.is_admin(auth.uid())
  );

CREATE POLICY tournament_award_admin_write ON public.tournament_award
  FOR ALL
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

COMMIT;
