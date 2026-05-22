-- Slice 001 / T022. Helper for is_eligible_nortal_participant() (T023) and the auth hook (T024). Reads tournament_config.eligibility.approved_domains. Fail-closed on missing config (R-007).

BEGIN;

CREATE OR REPLACE FUNCTION public.is_approved_domain(p_email text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_domain text;
  v_value  jsonb;
  v_match  boolean;
BEGIN
  -- Guard 1: NULL or whitespace-only input fails closed without raising.
  IF p_email IS NULL OR trim(p_email) = '' THEN
    RETURN false;
  END IF;

  -- Extract, lowercase, and trim the domain segment of the email.
  -- trim() the input first so leading whitespace doesn't sneak past
  -- split_part's anchor; trim() the result so trailing whitespace
  -- on the original input doesn't survive into the domain string
  -- (Case 4 of supabase/tests/pgtap/is_approved_domain.sql).
  v_domain := trim(lower(split_part(trim(p_email), '@', 2)));

  -- Guard 2: no '@' or empty domain segment fails closed.
  IF v_domain = '' THEN
    RETURN false;
  END IF;

  -- Read the approved-domains config row. If absent, fail closed (R-007).
  SELECT c.value
    INTO v_value
    FROM public.tournament_config c
   WHERE c.key = 'eligibility.approved_domains';

  IF v_value IS NULL THEN
    RETURN false;
  END IF;

  -- Exact-match scan of the jsonb string array (case-insensitive).
  -- No suffix expansion: 'nortal.co.uk' must not match 'nortal.com'
  -- (Case 8 of the pgTAP suite).
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(v_value) AS d
     WHERE lower(trim(d)) = v_domain
  )
  INTO v_match;

  RETURN COALESCE(v_match, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_approved_domain(text) TO authenticated;

COMMIT;
