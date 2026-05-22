-- Slice 001 / T033. Narrow INSERT carve-out for the API-guard audit-write path. Confirms no broader path opens up -- see WITH CHECK predicate.
--
-- Background:
--   * Migration 0007 (T012) REVOKEd INSERT on `public.audit_log` from
--     `authenticated` and `anon`. Until now, every audit row was written by
--     SECURITY DEFINER paths (auth hook -- migration 0009; participants row
--     trigger -- migration 0008), so the REVOKE held.
--   * T033 (this migration) introduces a fourth write path: the API-guard
--     helper `requireEligible()` (research.md § R-009) running under the
--     CALLER's JWT writes an `access.denied` row when a still-authenticated
--     session is rejected mid-tournament (spec Edge Case E-3, US2 AS2).
--   * That write path MUST NOT use the service-role client (contracts/
--     participant-me.read.md § Security invariants: "The route handler never
--     uses the service-role key"). Therefore the user-JWT-bound client needs
--     a narrowly-scoped INSERT capability on `audit_log`.
--
-- Posture:
--   * RLS remains enabled and FORCED on `audit_log` (migration 0007).
--   * GRANT INSERT to `authenticated` so the role can attempt INSERT at all;
--     the policy's WITH CHECK then constrains which exact rows are accepted.
--   * The policy admits EXACTLY ONE shape of row:
--       action = 'access.denied'
--       source = 'api_guard'
--       reason IN ('not_eligible','domain_not_approved','participant_not_provisioned')
--       actor  = caller's own participants.id (or NULL if no participants row)
--   * Any deviation in any of these four conjuncts -- e.g. action='access.granted',
--     source='auth_hook', reason='missing_claims', or actor=someone-else --
--     fails the WITH CHECK and the INSERT is rejected. The SECURITY DEFINER
--     audit writers (auth hook, trigger) continue to bypass RLS by virtue of
--     running as the table owner; this policy only ever applies to the
--     `authenticated` role.
--   * No UPDATE / DELETE policies are added: audit_log remains append-only at
--     the role layer for `authenticated`.
--
-- The `IS NOT DISTINCT FROM` comparison on `actor` is deliberate: it lets the
-- caller insert a row with `actor = NULL` when no participants row exists yet
-- (`participant_not_provisioned` defensive branch) without granting a broader
-- "actor = anything" surface, because the right-hand side is then also NULL
-- and the equality only holds for that single NULL case.
--
-- Forward compatibility: when Slice 007 hardens audit_log with trigger-level
-- immutability and signature columns, this policy continues to apply to the
-- INSERT path; Slice 007's changes are additive (Principle XI).

BEGIN;

GRANT INSERT ON public.audit_log TO authenticated;

CREATE POLICY audit_log_api_guard_self_insert
  ON public.audit_log
  FOR INSERT
  TO authenticated
  WITH CHECK (
    action = 'access.denied'
    AND source = 'api_guard'
    AND reason IN ('not_eligible','domain_not_approved','participant_not_provisioned')
    AND actor IS NOT DISTINCT FROM (
      SELECT p.id FROM public.participants p WHERE p.auth_user_id = auth.uid()
    )
  );

COMMIT;
