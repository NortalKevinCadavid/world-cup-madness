-- Slice 006 / T006 / contracts/admin-ui.surface.md § requireAdmin helper / data-model.md § audit_log RLS posture.
-- Migration slot 0073 per D-026 (spec slot 0060 already taken by 0060_admin_roles.sql).
-- ADDS narrow audit_log INSERT policy for authenticated role to emit admin.access_denied rows.
-- Mirrors slot 0010's api_guard policy but for the admin-route-guard rejection path:
--   - action = 'admin.access_denied'
--   - source = 'api_guard'
--   - actor = caller's own participants.id (matches the requireAdmin helper which writes
--             { actor: participant.id, action: 'admin.access_denied', source: 'api_guard', ... })
-- Pattern: each authenticated INSERT policy is additive (OR'd at RLS evaluation).
-- The /api/admin/* route handlers in T015 / T031 / T039 use this when a non-admin caller is rejected.
--
-- Background:
--   * Slot 0007 (Slice 001) REVOKEd INSERT on audit_log from authenticated and FORCEd RLS.
--   * Slot 0010 (Slice 001 / T033) GRANTed INSERT back to authenticated and added the narrow
--     api_guard policy covering action='access.denied' (Slice 001's requireEligible path).
--   * This slot (Slice 006 / T006) adds a SECOND narrow policy covering Slice 006's
--     admin-route-guard path (action='admin.access_denied'). The two policies are OR'd
--     at RLS evaluation: a row matching EITHER policy's WITH CHECK is admitted.
--
-- Posture:
--   * RLS remains enabled and FORCED on audit_log (slot 0007).
--   * The INSERT privilege grant from slot 0010 already covers this role; no new GRANT needed.
--   * This policy admits EXACTLY ONE additional shape of row:
--       action = 'admin.access_denied'
--       source = 'api_guard'
--       actor  = caller's own participants.id (resolved via auth.uid() join on auth_user_id)
--   * Any deviation (action='admin.access_granted', source='admin_rpc',
--     actor=someone-else's participant_id, etc.) fails this policy's WITH CHECK.
--     Such rows continue to be admitted only via SECURITY DEFINER paths
--     (admin_* RPCs, triggers) which bypass RLS by virtue of running as the table owner.
--   * No UPDATE / DELETE policies are added: audit_log remains append-only at the
--     role layer for authenticated (Slice 007 will harden further).
--
-- Constraint: the actor predicate uses the same participants-id lookup as slot 0010
-- so the rejection path can pin the audit row to the caller's own participants.id
-- (the requireAdmin helper writes `actor: participant.id`, NOT auth.uid()).

BEGIN;

CREATE POLICY audit_log_admin_access_denied_insert
  ON public.audit_log
  FOR INSERT
  TO authenticated
  WITH CHECK (
    action = 'admin.access_denied'
    AND source = 'api_guard'
    AND actor = (
      SELECT p.id FROM public.participants p WHERE p.auth_user_id = auth.uid()
    )
  );

COMMIT;
