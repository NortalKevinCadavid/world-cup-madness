-- Slice 004 / T007 / data-model.md § RLS posture summary. Participant-private final_predictions; eligibility-gated players catalog; admin-only player_provider_external_ids. NO write policies -- submit_final_prediction SP (T016) + sync coordinator (slice 002) are sole writers via SECURITY DEFINER. Migration slot 0042 per D-016.

BEGIN;

-- final_predictions: participant-private + admin-read
ALTER TABLE public.final_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.final_predictions FORCE ROW LEVEL SECURITY;

CREATE POLICY final_predictions_self_read
  ON public.final_predictions
  FOR SELECT TO authenticated
  USING (
    participant_id IN (
      SELECT id FROM public.participants WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY final_predictions_admin_read
  ON public.final_predictions
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.final_predictions FROM authenticated, anon;

-- players: catalog read (eligibility-gated) + admin write later
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players FORCE ROW LEVEL SECURITY;

CREATE POLICY players_eligible_read
  ON public.players
  FOR SELECT TO authenticated
  USING (public.is_eligible_nortal_participant(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.players FROM authenticated, anon;

-- player_provider_external_ids: admin-only read (internal plumbing)
ALTER TABLE public.player_provider_external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_provider_external_ids FORCE ROW LEVEL SECURITY;

CREATE POLICY player_provider_external_ids_admin_read
  ON public.player_provider_external_ids
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.player_provider_external_ids FROM authenticated, anon;

COMMIT;
