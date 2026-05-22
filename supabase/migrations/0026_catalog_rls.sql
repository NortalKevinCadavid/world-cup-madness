-- Slice 002 / T009 / data-model.md § RLS posture summary. Participant-readable:
-- teams, matches, match_results (eligibility gate). Admin-only: 5 internal-
-- plumbing tables. All 8 tables ENABLE + FORCE RLS; INSERT/UPDATE/DELETE
-- REVOKEd from authenticated/anon. Sync coordinator writes via SECURITY DEFINER
-- (T032+).
--
-- Depends on Slice 001's is_eligible_nortal_participant(uuid) (0023) and
-- is_admin(uuid) stub (0006). service_role is NOT revoked: it bypasses RLS by
-- design and is required by the sync coordinator and migration paths.
--
-- Defense-in-depth posture (mirrors Slice 001 / 0007):
--   * ENABLE + FORCE RLS so owner-role queries also respect policies.
--   * REVOKE INSERT/UPDATE/DELETE from authenticated/anon — baseline closed.
--   * Only SELECT (and one admin UPDATE on match_pending_review) policies.
--   * Sync coordinator writes via SECURITY DEFINER stored procedures (T032+).
--   * Slice 006 owns the admin override resolution path for match_pending_review.

BEGIN;

-- ===========================================================================
-- public.teams
-- ===========================================================================
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams FORCE ROW LEVEL SECURITY;

-- SELECT: any eligible Nortal participant may read the full team catalog.
-- The predicate re-evaluates on every read so a caller whose domain was
-- removed mid-session is denied immediately (FR-002, mirrors Slice 001).
CREATE POLICY teams_eligible_read
  ON public.teams
  FOR SELECT
  TO authenticated
  USING (public.is_eligible_nortal_participant(auth.uid()));

-- No write policies. Sync coordinator writes via SECURITY DEFINER (T032+);
-- Slice 006 owns the admin override path.
REVOKE INSERT, UPDATE, DELETE ON public.teams FROM authenticated, anon;

-- ===========================================================================
-- public.matches
-- ===========================================================================
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches FORCE ROW LEVEL SECURITY;

-- SELECT: eligible participants see the full match catalog (locked + open).
-- Row-level filtering is intentionally absent — the predicate gates access
-- to the table, not to specific rows.
CREATE POLICY matches_eligible_read
  ON public.matches
  FOR SELECT
  TO authenticated
  USING (public.is_eligible_nortal_participant(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.matches FROM authenticated, anon;

-- ===========================================================================
-- public.match_results
-- ===========================================================================
ALTER TABLE public.match_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_results FORCE ROW LEVEL SECURITY;

-- SELECT: eligible participants see scores for finished matches. Slice 005's
-- leaderboard reads these via SECURITY DEFINER and is unaffected by RLS.
CREATE POLICY match_results_eligible_read
  ON public.match_results
  FOR SELECT
  TO authenticated
  USING (public.is_eligible_nortal_participant(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.match_results FROM authenticated, anon;

-- ===========================================================================
-- public.team_provider_external_ids
-- ===========================================================================
-- Internal plumbing: maps Nortal team ids to provider-specific external ids.
-- Participants must not see provider names; admin-only read.
ALTER TABLE public.team_provider_external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_provider_external_ids FORCE ROW LEVEL SECURITY;

CREATE POLICY team_provider_external_ids_admin_read
  ON public.team_provider_external_ids
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.team_provider_external_ids FROM authenticated, anon;

-- ===========================================================================
-- public.match_provider_external_ids
-- ===========================================================================
-- Internal plumbing: maps Nortal match ids to provider-specific external ids.
-- Admin-only read; sync coordinator writes via SECURITY DEFINER (T032+).
ALTER TABLE public.match_provider_external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_provider_external_ids FORCE ROW LEVEL SECURITY;

CREATE POLICY match_provider_external_ids_admin_read
  ON public.match_provider_external_ids
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.match_provider_external_ids FROM authenticated, anon;

-- ===========================================================================
-- public.provider_sync_runs
-- ===========================================================================
-- Sync ledger. Participants must not see sync run history; admin-only read.
ALTER TABLE public.provider_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_sync_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_sync_runs_admin_read
  ON public.provider_sync_runs
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.provider_sync_runs FROM authenticated, anon;

-- ===========================================================================
-- public.provider_sync_state
-- ===========================================================================
-- Per-provider checkpoint / cursor state. Admin-only read.
ALTER TABLE public.provider_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_sync_state FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_sync_state_admin_read
  ON public.provider_sync_state
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.provider_sync_state FROM authenticated, anon;

-- ===========================================================================
-- public.match_pending_review
-- ===========================================================================
-- Quarantine queue for provider-conflict matches. Admin-only read AND update
-- (Slice 006 resolves rows via the admin override UI). INSERT/DELETE remain
-- closed at the role layer — the sync coordinator inserts via SECURITY DEFINER.
ALTER TABLE public.match_pending_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_pending_review FORCE ROW LEVEL SECURITY;

CREATE POLICY match_pending_review_admin_read
  ON public.match_pending_review
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Slice 006 resolves quarantine rows via this UPDATE policy. WITH CHECK
-- mirrors USING so an admin cannot pivot a row out of admin-visibility
-- (e.g., by mutating a discriminator column) within the same statement.
CREATE POLICY match_pending_review_admin_update
  ON public.match_pending_review
  FOR UPDATE
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

REVOKE INSERT, DELETE ON public.match_pending_review FROM authenticated, anon;
-- UPDATE intentionally NOT revoked: the admin_update policy above gates it.

COMMIT;
