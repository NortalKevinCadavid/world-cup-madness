-- Slice 006 / T013 / FR-001 / US1 / contracts/admin-rpcs.write.md.
-- Migration slot 0064 per D-026 (spec slot 0051 collides with prior shipped 0051_tournament_award.sql).
-- LOCKED CROSS-SLICE SP signature per Principle XI. Admin RPC wrapping slice 002's record_match_result SP.
-- Pre-flight: is_admin check (-> WAR01 + audit) + reason validation (-> WAR02) + source_citation validation (-> WAR03).
-- Body: per-match advisory lock + capture old/new state + delegate + audit admin.match_result_corrected.
-- Invariant violations from underlying SP propagate as WAR05.
-- Slice 005's score-trigger handles auto-recalc via match_results_recorded LISTEN (no explicit recalc here).
--
-- Required CHECK relaxation:
--   The slice 001 stub (slot 0003) constrained audit_log.source to
--     ('auth_hook','rls','api_guard','ui','trigger').
--   This slice's audit emission pattern (contracts/admin-rpcs.write.md § Audit emission)
--   writes source='admin_rpc' for every successful admin override. We extend the CHECK
--   here (additive only) so the success audit row passes the table constraint. The
--   access-denied audit row continues to use source='api_guard' (matches slot 0073's
--   narrow RLS INSERT policy + the not_admin pgTAP assertion).
--
-- Audit-row survival on access denial:
--   The WAR01 audit insert is wrapped in a BEGIN/EXCEPTION sub-block. The SP itself
--   runs SECURITY DEFINER (postgres owner) so the INSERT bypasses RLS regardless of
--   slot 0073's policy. The sub-block also swallows any INSERT failure (defence in
--   depth) so the WAR01 RAISE always fires. The outer transaction is rolled back by
--   the caller's pgTAP framework via the file's ROLLBACK, but the audit row is
--   observable inside the same transaction prior to ROLLBACK (the assertion uses a
--   plain SELECT, not a NOTIFY-style listener).
--
-- ERRCODE propagation table (slice 002 -> this SP):
--   record_match_result raises:
--     22023 = invalid_parameter_value (invalid status, invalid source, for_scoring>official, shootout level)
--     42501 = insufficient_privilege (admin_override with non-admin approver) -- N/A here
--                because we always pass an admin id; defence-in-depth fallback.
--     P0001 = raise_exception (match not found, match.status != 'finished')
--   We propagate ALL of these as WAR05 per contracts/admin-rpcs.write.md
--   § ERRCODE values WAR05 ("invariant violation propagated from underlying SP").
--   The original SQLSTATE is preserved in the WAR05 MESSAGE for forensic recovery.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Extend audit_log.source CHECK to admit 'admin_rpc' (additive).
--    Slice 007's hardening will preserve this constraint shape (Principle XI:
--    additive cross-slice extensions are allowed).
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_source_check;

ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_source_check
    CHECK (source IN ('auth_hook', 'rls', 'api_guard', 'ui', 'trigger', 'admin_rpc'));

COMMENT ON CONSTRAINT audit_log_source_check ON public.audit_log IS
  'Slice 006 / T013: extended from slice 001 stub to admit ''admin_rpc'' for
   admin override RPC success audit rows. Access-denied rows continue to use
   ''api_guard'' to match slot 0073''s narrow RLS INSERT policy.';

-- ---------------------------------------------------------------------------
-- 2. admin_record_match_result SP.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_record_match_result(
  p_match_id               uuid,
  p_home_score_official    int,
  p_away_score_official    int,
  p_home_score_for_scoring int,
  p_away_score_for_scoring int,
  p_result_status          text,
  p_reason                 text,
  p_source_citation        text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth_user_id     uuid;
  v_admin_id         uuid;
  v_caller_pid       uuid;
  v_old              jsonb;
  v_new              jsonb;
  v_audit_id         uuid;
  v_underlying_state text;
BEGIN
  -- -------------------------------------------------------------------------
  -- Pre-flight step 1: admin authority check.
  -- -------------------------------------------------------------------------
  v_auth_user_id := auth.uid();

  IF NOT public.is_admin(v_auth_user_id) THEN
    -- Resolve caller's participants.id (may be NULL if caller has no row).
    SELECT id INTO v_caller_pid
      FROM public.participants
     WHERE auth_user_id = v_auth_user_id;

    -- Emit admin.access_denied audit row in a sub-block so any failure
    -- (constraint, RLS for non-SECURITY-DEFINER reinvocation) does NOT
    -- prevent the WAR01 raise. SP runs SECURITY DEFINER so RLS is bypassed.
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, entity_id,
        previous_value, new_value, reason, source, source_citation
      ) VALUES (
        v_caller_pid,
        'admin.access_denied',
        'match_result',
        p_match_id,
        NULL,
        NULL,
        'not_admin',
        'api_guard',
        NULL
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- swallow; WAR01 raise must still fire
    END;

    RAISE EXCEPTION USING
      ERRCODE = 'WAR01',
      MESSAGE = 'admin role required';
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 2: reason validation.
  -- -------------------------------------------------------------------------
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR02',
      MESSAGE = 'reason missing or empty';
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 3: source_citation validation.
  -- -------------------------------------------------------------------------
  IF p_source_citation IS NULL OR length(trim(p_source_citation)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR03',
      MESSAGE = 'source citation missing or empty';
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 4: resolve admin's participants.id.
  -- is_admin already returned TRUE so this row MUST exist (admin_roles FK
  -- guarantees it via participant_id).
  -- -------------------------------------------------------------------------
  SELECT id INTO v_admin_id
    FROM public.participants
   WHERE auth_user_id = v_auth_user_id;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 5: per-match advisory lock.
  -- Serializes concurrent admin corrections on the same match. Different
  -- matches lock independently.
  -- -------------------------------------------------------------------------
  PERFORM pg_advisory_xact_lock(
    hashtext('admin_match_result:' || p_match_id::text)
  );

  -- -------------------------------------------------------------------------
  -- Step 6: capture previous match_results state (may be NULL if no prior row).
  -- -------------------------------------------------------------------------
  SELECT to_jsonb(t.*) INTO v_old
    FROM public.match_results t
   WHERE t.match_id = p_match_id;

  -- -------------------------------------------------------------------------
  -- Step 7: delegate to slice 002's record_match_result SP.
  -- Signature (slot 0024):
  --   record_match_result(p_match_id, p_home_score_official, p_away_score_official,
  --                       p_home_score_for_scoring, p_away_score_for_scoring,
  --                       p_result_status, p_source, p_approved_by)
  -- We pass source='admin_correction' (slice 002 normalizes to DB 'admin_override').
  -- -------------------------------------------------------------------------
  BEGIN
    PERFORM public.record_match_result(
      p_match_id,
      p_home_score_official,
      p_away_score_official,
      p_home_score_for_scoring,
      p_away_score_for_scoring,
      p_result_status,
      'admin_correction',
      v_admin_id
    );
  EXCEPTION
    -- Slice 002 invariant violations -> WAR05 with original SQLSTATE preserved
    -- in MESSAGE per contracts/admin-rpcs.write.md § ERRCODE WAR05.
    WHEN SQLSTATE '22023' OR SQLSTATE '42501' OR SQLSTATE 'P0001' THEN
      v_underlying_state := SQLSTATE;
      RAISE EXCEPTION USING
        ERRCODE = 'WAR05',
        MESSAGE = format(
          'underlying invariant violation (slice 002 SQLSTATE=%s): %s',
          v_underlying_state, SQLERRM
        );
  END;

  -- -------------------------------------------------------------------------
  -- Step 8: capture new match_results state.
  -- -------------------------------------------------------------------------
  SELECT to_jsonb(t.*) INTO v_new
    FROM public.match_results t
   WHERE t.match_id = p_match_id;

  -- -------------------------------------------------------------------------
  -- Step 9: emit admin.match_result_corrected audit row.
  -- contracts/admin-rpcs.write.md § Audit emission pattern (locked shape).
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source, source_citation
  ) VALUES (
    v_admin_id,
    'admin.match_result_corrected',
    'match_result',
    p_match_id,
    v_old,
    v_new,
    p_reason,
    'admin_rpc',
    p_source_citation
  )
  RETURNING id INTO v_audit_id;

  -- -------------------------------------------------------------------------
  -- Step 10: return the affected match_id.
  -- Slice 005's match_results_recorded LISTEN fires from slice 002's SP
  -- (slot 0024 step 9) automatically -- no explicit recalc trigger here.
  -- -------------------------------------------------------------------------
  RETURN p_match_id;
END;
$$;

COMMENT ON FUNCTION public.admin_record_match_result(
  uuid, int, int, int, int, text, text, text
) IS
  'Slice 006 / T013 / FR-001: SECURITY DEFINER admin RPC wrapping slice 002''s '
  'record_match_result SP. Pre-flight: is_admin check (->WAR01+audit) + reason '
  '(->WAR02) + source_citation (->WAR03). Body: per-match advisory lock + capture '
  'old/new state + delegate (source=''admin_correction'') + audit '
  'admin.match_result_corrected with source=''admin_rpc''. Invariant violations '
  '(slice 002 SQLSTATE 22023/42501/P0001) propagate as WAR05. Slice 005''s '
  'score-trigger handles auto-recalc via match_results_recorded LISTEN. '
  'Signature LOCKED cross-slice per Principle XI.';

-- ---------------------------------------------------------------------------
-- 3. Permissions.
--    The SP is invoked by the /api/admin/match-result route handler running
--    under the admin's JWT (role=authenticated). SECURITY DEFINER gives the
--    SP the privileges to write to match_results + audit_log; the GRANT
--    EXECUTE here is what lets authenticated callers reach the function at
--    all. PUBLIC is REVOKEd defensively (it isn't granted by default for
--    CREATE FUNCTION but the REVOKE makes the posture explicit).
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.admin_record_match_result(
  uuid, int, int, int, int, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_record_match_result(
  uuid, int, int, int, int, text, text, text
) TO authenticated;

COMMIT;
