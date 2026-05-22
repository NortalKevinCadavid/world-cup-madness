-- Slice 003 / Constitution II (NON-NEGOTIABLE participant-private predictions) / data-model.md § RLS posture / mirrors slice 001 + 002 pattern. NO INSERT/UPDATE/DELETE policies — submit_prediction() SECURITY DEFINER SP (T013) is the sole writer. Migration slot 0032 per D-012.

BEGIN;

ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.predictions FORCE ROW LEVEL SECURITY;

CREATE POLICY predictions_self_read
  ON public.predictions
  FOR SELECT
  TO authenticated
  USING (
    participant_id IN (
      SELECT id FROM public.participants WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY predictions_admin_read
  ON public.predictions
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.predictions FROM authenticated, anon;

COMMIT;
