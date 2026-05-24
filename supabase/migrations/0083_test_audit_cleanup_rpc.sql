-- ============================================================================
-- 0083_test_audit_cleanup_rpc.sql
-- ============================================================================
-- Slice 007 follow-up — test-only audit_log cleanup RPC.
--
-- Problem (see specs/007-audit-trail/follow-up-test-audit-log-cleanup-permission.md):
--   Migration 0076 (slice 007) REVOKEs UPDATE + DELETE on audit_log from
--   authenticated, anon, AND service_role to enforce LOCKED tamper-resistance
--   per R-001 + Principle II. This is the correct production posture, but it
--   blocks the test fixture cleanup path in ~10 slice-006 specs (audit-search,
--   audit-by-target, recalc-*, finals-*, match-*, etc.). Those tests pass
--   individually but cascade-fail when run together because the prior test's
--   seeded audit rows can't be deleted in afterEach.
--
-- Solution:
--   Create a SECURITY DEFINER function owned by postgres (the table owner,
--   unaffected by the REVOKEs) that deletes audit rows by ID. Gate it on a
--   tournament_config flag (`dev.test_audit_cleanup_enabled`) that is set to
--   TRUE only by a local-dev seed file (see supabase/seed/local-dev-enable
--   -test-cleanup.sql). Production deployments never seed that key, so the
--   function fails-closed there.
--
--   Test fixtures call `client.rpc('__test_delete_audit_rows', { p_ids: [...] })`
--   instead of `client.from('audit_log').delete().in('id', [...])`.
--
-- Why a SECURITY DEFINER function instead of an ALTER DATABASE GUC:
--   - tournament_config is the project's canonical "config that varies by
--     environment" surface — already used for retention policy, lock windows,
--     etc. The seed/config drift story for adding another key is well-trodden.
--   - GUC-based gating (current_setting('app.env')) would require an
--     ALTER DATABASE statement that we can't safely scope to local clusters.
--   - The check is one SELECT per cleanup call; not on any hot path.
--
-- Why fail-closed (default-deny) is the right posture:
--   - If the seed flag is missing or false, the function raises. Tests fail
--     loudly with a clear message, rather than silently working in dev and
--     surprise-tampering in prod.
--   - Prod deployments that apply this migration without the seed simply have
--     a function that refuses to run. Audit_log remains as locked as before
--     migration 0076 made it.
--
-- See:
--   - specs/007-audit-trail/follow-up-test-audit-log-cleanup-permission.md
--   - supabase/migrations/0076_audit_trail.sql (the tamper-resistance lock)
--   - supabase/seed/local-dev-enable-test-cleanup.sql (the local-dev gate)
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.__test_delete_audit_rows(p_ids uuid[])
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled  boolean;
  v_deleted  int;
BEGIN
  -- Gate: refuse unless the local-dev seed has explicitly enabled this RPC.
  -- The fail-closed default-deny is the load-bearing safety property — a
  -- production deployment that applies this migration without the seed (which
  -- ships in supabase/seed/, not in migrations/) will see every call raise.
  SELECT (value)::boolean
    INTO v_enabled
    FROM public.tournament_config
   WHERE key = 'dev.test_audit_cleanup_enabled';

  IF v_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      '__test_delete_audit_rows is local-dev-only; tournament_config[dev.test_audit_cleanup_enabled] must be TRUE'
      USING ERRCODE = '42501';  -- insufficient_privilege
  END IF;

  -- Inside the SECURITY DEFINER wrapper, the DELETE runs as the function
  -- owner (postgres) — which is the audit_log table owner and therefore
  -- unaffected by the REVOKE on authenticated / anon / service_role.
  DELETE FROM public.audit_log WHERE id = ANY (p_ids);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.__test_delete_audit_rows(uuid[]) IS
  'Slice 007 follow-up — test-only cleanup RPC for audit_log rows. '
  'Refuses to run unless tournament_config[dev.test_audit_cleanup_enabled]=TRUE. '
  'See specs/007-audit-trail/follow-up-test-audit-log-cleanup-permission.md.';

-- Grant EXECUTE to service_role only — the test fixtures use the service-role
-- client, and we don't want authenticated callers reaching this even by
-- accident. The function still fails-closed even if called by an
-- accidentally-granted role, but defense in depth.
REVOKE EXECUTE ON FUNCTION public.__test_delete_audit_rows(uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.__test_delete_audit_rows(uuid[]) TO service_role;

COMMIT;
