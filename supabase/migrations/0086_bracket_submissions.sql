-- ============================================================================
-- 0086_bracket_submissions.sql  — Slice 010 / T006
-- ============================================================================
-- Per-participant submit state. One row per participant. Writes flow ONLY
-- through the submit_bracket() SECURITY DEFINER RPC (T027 / migration 0089);
-- no direct authenticated INSERT/UPDATE (Principle II — server-side gate).
--
-- data-model.md § Entity 3.
-- ============================================================================

BEGIN;

CREATE TYPE public.bracket_submission_status AS ENUM ('draft', 'complete', 'submitted', 'locked');

CREATE TABLE public.bracket_submissions (
  participant_id     uuid PRIMARY KEY REFERENCES public.participants (id) ON DELETE CASCADE,
  submission_status  public.bracket_submission_status NOT NULL DEFAULT 'submitted',
  submitted_at       timestamptz NULL,
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bracket_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bracket_submissions FORCE ROW LEVEL SECURITY;

CREATE POLICY bracket_submissions_self_read
  ON public.bracket_submissions
  FOR SELECT
  TO authenticated
  USING (
    participant_id IN (
      SELECT id FROM public.participants WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY bracket_submissions_admin_read
  ON public.bracket_submissions
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- No write policy: submit_bracket() (SECURITY DEFINER, owner=postgres) is the
-- sole writer. authenticated/anon cannot INSERT/UPDATE/DELETE directly.
REVOKE INSERT, UPDATE, DELETE ON public.bracket_submissions FROM authenticated, anon;

COMMENT ON TABLE public.bracket_submissions IS
  'Slice 010 / T006. Per-participant submit state; written only by '
  'submit_bracket() RPC. See data-model.md Entity 3.';

COMMIT;
