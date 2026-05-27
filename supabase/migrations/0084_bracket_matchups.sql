-- ============================================================================
-- 0084_bracket_matchups.sql  — Slice 010 (Bracket Team Selection) / T004
-- ============================================================================
-- The fixed single-elimination knockout structure: 31 matchups
-- (16 R32 + 8 R16 + 4 QF + 2 SF + 1 Final). Global seed data (NOT per
-- participant) per spec Q1/FR-026/FR-030 — the R32 field is pre-seeded.
--
-- data-model.md § Entity 1. RLS: world-readable to authenticated eligible
-- participants (structure is not secret); no authenticated write.
-- ============================================================================

BEGIN;

CREATE TYPE public.bracket_round AS ENUM ('r32', 'r16', 'qf', 'sf', 'final');

CREATE TABLE public.bracket_matchups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round            public.bracket_round NOT NULL,
  position         int NOT NULL,
  team_a_id        uuid NULL REFERENCES public.teams (id) ON DELETE RESTRICT,
  team_b_id        uuid NULL REFERENCES public.teams (id) ON DELETE RESTRICT,
  next_matchup_id  uuid NULL REFERENCES public.bracket_matchups (id) ON DELETE RESTRICT,
  next_slot        char(1) NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bracket_matchups_round_position_uk UNIQUE (round, position),

  -- next_slot is 'A' or 'B' when present.
  CONSTRAINT bracket_matchups_next_slot_valid
    CHECK (next_slot IS NULL OR next_slot IN ('A', 'B')),

  -- The final has no downstream; every other round MUST feed forward.
  CONSTRAINT bracket_matchups_advancement_shape
    CHECK (
      (round = 'final' AND next_matchup_id IS NULL AND next_slot IS NULL)
      OR
      (round <> 'final' AND next_matchup_id IS NOT NULL AND next_slot IS NOT NULL)
    ),

  -- R32 rows carry the pre-seeded competitors; later rounds resolve from
  -- upstream winners and MUST leave both team slots NULL.
  CONSTRAINT bracket_matchups_seed_shape
    CHECK (
      (round = 'r32' AND team_a_id IS NOT NULL AND team_b_id IS NOT NULL)
      OR
      (round <> 'r32' AND team_a_id IS NULL AND team_b_id IS NULL)
    )
);

CREATE INDEX bracket_matchups_round_idx ON public.bracket_matchups (round, position);
CREATE INDEX bracket_matchups_next_idx ON public.bracket_matchups (next_matchup_id) WHERE next_matchup_id IS NOT NULL;

ALTER TABLE public.bracket_matchups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bracket_matchups FORCE ROW LEVEL SECURITY;

-- Structure is readable by any eligible authenticated participant (the
-- bracket shape is public knowledge; only per-participant PICKS are private).
CREATE POLICY bracket_matchups_eligible_read
  ON public.bracket_matchups
  FOR SELECT
  TO authenticated
  USING (public.is_eligible_nortal_participant(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.bracket_matchups FROM authenticated, anon;

COMMENT ON TABLE public.bracket_matchups IS
  'Slice 010 / T004. Fixed knockout structure (31 matchups). Global seed data; '
  'R32 rows carry pre-seeded competitors, later rounds resolve from winners. '
  'See specs/010-bracket-team-selection/data-model.md Entity 1.';

COMMIT;
