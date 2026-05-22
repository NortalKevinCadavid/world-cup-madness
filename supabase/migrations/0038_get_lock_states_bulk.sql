-- Slice 003 / T031 / D-015 — bulk lock-state helper for the /api/matches route.
--
-- Why this exists:
--   T031 needs to add an additive `lock_state` field to the /api/matches
--   response. The route handler uses Supabase's PostgREST `.select()` with
--   foreign-key embed syntax (`home_team:teams!fkey(...)`), which does not
--   support arbitrary SQL expressions like
--   `CASE WHEN public.is_prediction_locked(m.id) THEN 'locked' ELSE
--   'editable' END AS lock_state`.
--
--   Calling `is_prediction_locked` once per row would be N+1 round trips
--   (50 per default page). This helper resolves all lock states for the
--   page in a single RPC call.
--
-- Why this is a deviation (D-015):
--   The slice 003 task plan did not anticipate this helper. It was added
--   during T031 implementation because the cleanest PostgREST-compatible
--   approach to populating an additive computed field is a bulk RPC, not
--   a CASE expression inline.
--
--   The helper is SECURITY INVOKER so it honors the caller's RLS on
--   `public.matches` (via `is_prediction_locked` which is also INVOKER and
--   reads tournament_config + matches under the caller's JWT). The contract
--   of `is_prediction_locked` (locked cross-slice predicate) is unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_lock_states(p_match_ids uuid[])
RETURNS TABLE(match_id uuid, lock_state text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    m.id::uuid AS match_id,
    CASE WHEN public.is_prediction_locked(m.id) THEN 'locked' ELSE 'editable' END AS lock_state
  FROM unnest(p_match_ids) AS m(id);
$$;

-- Least-privilege grant. The function is SECURITY INVOKER so RLS on the
-- underlying tables still enforces caller-scoped visibility.
REVOKE EXECUTE ON FUNCTION public.get_lock_states(uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_lock_states(uuid[]) TO authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_lock_states(uuid[]) TO service_role';
  END IF;
END $$;

COMMIT;
