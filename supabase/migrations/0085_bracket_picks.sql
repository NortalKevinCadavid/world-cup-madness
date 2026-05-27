-- ============================================================================
-- 0085_bracket_picks.sql  — Slice 010 / T005
-- ============================================================================
-- Per-participant winner selections. One winner per (participant, matchup).
-- Self-only RLS mirroring slice-003 predictions (Constitution II — picks are
-- participant-private until lock). Writes flow through the pick route + the
-- submit RPC; no blanket authenticated write policy beyond self-write while
-- unlocked (lock re-checked in the write path, not solely in RLS).
--
-- data-model.md § Entity 2.
-- ============================================================================

BEGIN;

CREATE TABLE public.bracket_picks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id  uuid NOT NULL REFERENCES public.participants (id) ON DELETE CASCADE,
  matchup_id      uuid NOT NULL REFERENCES public.bracket_matchups (id) ON DELETE RESTRICT,
  winner_team_id  uuid NOT NULL REFERENCES public.teams (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bracket_picks_participant_matchup_uk UNIQUE (participant_id, matchup_id)
);

CREATE INDEX bracket_picks_participant_idx ON public.bracket_picks (participant_id);

ALTER TABLE public.bracket_picks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bracket_picks FORCE ROW LEVEL SECURITY;

-- Self-read: a participant sees only their own picks.
CREATE POLICY bracket_picks_self_read
  ON public.bracket_picks
  FOR SELECT
  TO authenticated
  USING (
    participant_id IN (
      SELECT id FROM public.participants WHERE auth_user_id = auth.uid()
    )
  );

-- Admin-read (parity with predictions/final_predictions).
CREATE POLICY bracket_picks_admin_read
  ON public.bracket_picks
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Self-write while eligible. The lock (now() < first_kickoff_utc) is enforced
-- in the pick route + submit RPC, not in RLS, because RLS cannot cleanly read
-- tournament_config per-row without coupling; the server path is the gate
-- (Principle II/III — server-side, not client-only).
CREATE POLICY bracket_picks_self_write
  ON public.bracket_picks
  FOR ALL
  TO authenticated
  USING (
    participant_id IN (
      SELECT id FROM public.participants WHERE auth_user_id = auth.uid()
    )
    AND public.is_eligible_nortal_participant(auth.uid())
  )
  WITH CHECK (
    participant_id IN (
      SELECT id FROM public.participants WHERE auth_user_id = auth.uid()
    )
    AND public.is_eligible_nortal_participant(auth.uid())
  );

REVOKE INSERT, UPDATE, DELETE ON public.bracket_picks FROM anon;

COMMENT ON TABLE public.bracket_picks IS
  'Slice 010 / T005. One winner pick per (participant, matchup). Self-only RLS. '
  'Lock enforced server-side in the pick route + submit RPC. '
  'See specs/010-bracket-team-selection/data-model.md Entity 2.';

COMMIT;
