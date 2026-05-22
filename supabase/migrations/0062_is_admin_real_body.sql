-- Slice 006 / T007 / FR-001 / contracts/is-admin.predicate.sql.md / data-model.md § is_admin replacement.
-- Migration slot 0062 per D-026 (spec slot 0049 collides with slice 005's score_records at 0049).
-- REPLACES slice 001's is_admin(uuid) stub body (which returned `SELECT false`).
-- New body reads admin_roles via auth_user_id -> participants.id mapping.
-- SECURITY DEFINER bypasses admin_roles RLS (otherwise circular dependency:
--   admin_roles RLS policies call is_admin(auth.uid()), which would need to
--   SELECT admin_roles, which would re-enter the same RLS predicate).
-- STABLE volatility preserved (matches slice 001 stub).
-- Signature locked per Principle XI: public.is_admin(p_user_id uuid) RETURNS boolean.
-- Parameter name p_user_id preserved verbatim from slice 0006 stub (CREATE OR REPLACE
-- requires identical signature including parameter names for SQL-language functions).
--
-- Deviation note: the tasks.md T007 prompt suggests SECURITY INVOKER and parameter
-- name p_uid. We use SECURITY DEFINER + p_user_id because:
--   (a) p_user_id matches the on-disk slice 001 stub (Principle XI signature lock),
--   (b) SECURITY DEFINER is required to break the admin_roles RLS circular dependency
--       described above; SECURITY INVOKER would cause infinite recursion or denial
--       when authenticated users call is_admin() on themselves.
-- The function returns only BOOLEAN; no admin row data is leaked.
--
-- Cross-slice contract: signature locked per Principle XI. Slice 008 admin-assignment UI
-- must INSERT into admin_roles to grant admin; cannot alter is_admin's behavior.
--
-- Existing slice 001 GRANT EXECUTE ... TO authenticated remains valid: CREATE OR
-- REPLACE preserves privileges. No re-GRANT needed.
--
-- NULL handling: if p_user_id IS NULL (e.g., unauthenticated context where auth.uid()
-- returns NULL), the WHERE clause `p.auth_user_id = NULL` yields UNKNOWN for every
-- row, so EXISTS returns false. This is the desired safe default.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_admin(p_user_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.admin_roles ar
      JOIN public.participants p ON p.id = ar.participant_id
     WHERE p.auth_user_id = p_user_id
       AND ar.revoked_at IS NULL
  );
$$;

COMMENT ON FUNCTION public.is_admin(uuid) IS
  'Slice 006 / T007 / FR-001: returns true iff p_user_id maps (via participants.auth_user_id) '
  'to a participant with an active admin_roles row (revoked_at IS NULL). '
  'SECURITY DEFINER to bypass admin_roles RLS circular dependency. '
  'Signature locked cross-slice per Principle XI.';

COMMIT;
