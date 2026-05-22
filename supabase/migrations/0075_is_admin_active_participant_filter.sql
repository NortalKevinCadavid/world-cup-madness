-- Slice 006 / T036 / D-028 / contracts/is-admin.predicate.sql.md § Semantics.
-- Migration slot 0075.
-- PATCHES the is_admin(uuid) body shipped by T007 (slot 0062): adds `AND p.status = 'active'` filter.
-- The contract requires deactivated participants to return FALSE, but T007 omitted this filter.
-- This migration is strictly additive — existing rows where the participant is active still match.
-- Cross-slice contract: signature unchanged per Principle XI.

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
       AND p.status = 'active'
       AND ar.revoked_at IS NULL
  );
$$;

COMMENT ON FUNCTION public.is_admin(uuid) IS
  'Returns TRUE iff the auth_user_id maps to an ACTIVE participant with a non-revoked admin_role.
   Body replaced by T036 (slot 0075) to add the status filter per D-028.
   SECURITY DEFINER bypasses admin_roles RLS (circular dependency).
   STABLE; signature locked per Principle XI.';

COMMIT;
