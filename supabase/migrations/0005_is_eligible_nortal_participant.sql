-- Slice 001 / T023. LOCKED cross-slice contract -- referenced by every slice's RLS. Signature MUST NOT change.
-- Slice 001 / FR-001 / data-model.md § Cross-slice ownership map / contracts/eligibility-predicate.sql.md -- LOCKED CROSS-SLICE CONTRACT: signature (p_uid uuid) RETURNS boolean STABLE. Slices 002-008 reference this function in their RLS. Body changes require coordinating regression tests in every consuming slice (Constitution Principle XI).

BEGIN;

CREATE OR REPLACE FUNCTION public.is_eligible_nortal_participant(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
-- D-T021-007: SECURITY DEFINER so the SELECT on public.participants bypasses
-- the participants RLS policy. The RLS policy uses
-- is_eligible_nortal_participant(auth.uid()) as its row-eligibility check;
-- running SECURITY INVOKER causes the participants read inside this function
-- to re-trigger the RLS policy, which re-calls this function — infinite
-- recursion that surfaces as Postgres "stack depth limit exceeded" on any
-- caller. DEFINER breaks the cycle. The function is read-only and the
-- LOCKED signature is preserved.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.participants p
    WHERE p.auth_user_id = p_uid
      AND p.status = 'active'
      AND public.is_approved_domain(p.email)
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_eligible_nortal_participant(uuid) TO authenticated;

COMMIT;
