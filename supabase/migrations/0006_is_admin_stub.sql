-- Slice 001 stub. Slice 006 will CREATE OR REPLACE this function with the real admin_roles lookup. Signature is LOCKED -- do not change.

CREATE OR REPLACE FUNCTION public.is_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT false;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;
