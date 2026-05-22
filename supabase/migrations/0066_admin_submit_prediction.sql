-- Slice 006 / T038 / Phase 7 / contracts/admin-rpcs.write.md § admin_submit_prediction.
-- Migration slot 0066 per D-026 (spec slot 0053 collides with prior shipped 0053_score_finals_fn.sql).
-- LOCKED CROSS-SLICE SP signature per Principle XI.
--
-- Two SECURITY DEFINER functions land here:
--   1. public.admin_submit_prediction_bypass_lock(...) RETURNS uuid
--        Mirrors slice 003's submit_prediction (slots 0034 + 0037) EXCEPT the
--        is_prediction_locked() gate at step 6 is skipped. Everything else
--        (score range, eligibility, existence, supersede-then-insert with the
--        D-014 self-reference placeholder pattern) is preserved verbatim so the
--        bypass variant produces identical predictions/audit shapes to the
--        normal path on an unlocked match.
--
--        Slice 003's submit_prediction signature remains unchanged; this slice
--        OWNS the bypass-lock sibling per contracts/admin-rpcs.write.md §
--        admin_submit_prediction Cross-slice notes ("this slice owns
--        admin_submit_prediction_bypass_lock (a sibling, NOT a replacement)").
--
--   2. public.admin_submit_prediction(...) RETURNS uuid
--        Admin wrapper. Pre-flight (WAR01..WAR03), branch on
--        is_prediction_locked(p_match_id):
--          locked   -> delegate to admin_submit_prediction_bypass_lock(...) (this slice)
--          unlocked -> delegate to public.submit_prediction(..., 'admin_override')
--        Emit one admin.prediction_submitted audit row carrying
--        previous_value->>'lock_bypass' = 'true'/'false' to distinguish paths
--        (per contract § Audit emission "Distinguish bypass-lock variant via
--        audit_log.previous_value jsonb field `lock_bypass: true`").
--
-- audit_log.source CHECK was already extended to admit 'admin_rpc' by slot 0064
-- (T013). No further CHECK relaxation needed here.
--
-- ERRCODE mapping (per contracts/admin-rpcs.write.md § ERRCODE values):
--   WAR01 = not admin            (admin.access_denied audit + raise)
--   WAR02 = reason missing/empty
--   WAR03 = source_citation missing/empty
--   WAR04 = participant_id not found OR match_id not found
--   WAR05 = invariant violation propagated from underlying SP
--           (slice 003 SQLSTATE 'WCM01'..'WCM06' / 22023 / P0001)
--
-- Audit-row survival on access denial:
--   Mirrors slot 0064 T013 pattern: BEGIN/EXCEPTION sub-block around the
--   admin.access_denied INSERT so any constraint/RLS failure does NOT prevent
--   the WAR01 raise. SECURITY DEFINER bypasses RLS on the audit_log table.

BEGIN;

-- ===========================================================================
-- 1. admin_submit_prediction_bypass_lock(...) sibling SP.
--    Owned by this slice (Principle XI: slice 003's submit_prediction signature
--    is preserved verbatim; this is an ADDITIVE sibling, not a replacement).
--    Same body as slot 0037 EXCEPT step 6 (lock check) is removed.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.admin_submit_prediction_bypass_lock(
  p_participant_id uuid,
  p_match_id       uuid,
  p_home           int,
  p_away           int,
  p_source         text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth_user_id      uuid;
  v_score_upper_bound int;
  v_match_status      public.match_status;
  v_new_id            uuid;
  v_existing_id       uuid;
BEGIN
  -- 1. Per-pair advisory transaction lock. Concurrent submits for the same
  --    (participant, match) serialize through this lock; different pairs
  --    proceed in parallel. Lock auto-releases at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_participant_id::text || ':' || p_match_id::text)
  );

  -- 2. Validate source enum membership. Caller is the admin RPC wrapper
  --    which always passes 'admin_override'. We accept the same enum
  --    membership as slice 003's SP so the column cast at step 7 succeeds.
  IF p_source NOT IN ('ui', 'api', 'admin_override') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WCM03',
      MESSAGE = format('invalid source %s', p_source);
  END IF;

  -- 3. Validate score range against tournament_config.score_upper_bound
  --    (slot 0035 default = 20). Mirrors slice 003.
  SELECT (value::text)::int INTO v_score_upper_bound
    FROM public.tournament_config
   WHERE key = 'score_upper_bound';
  IF v_score_upper_bound IS NULL THEN
    v_score_upper_bound := 20;
  END IF;
  IF p_home < 0
     OR p_home > v_score_upper_bound
     OR p_away < 0
     OR p_away > v_score_upper_bound THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WCM03',
      MESSAGE = format(
        'score out of range: home=%s away=%s (max %s)',
        p_home, p_away, v_score_upper_bound
      );
  END IF;

  -- 4. Eligibility check (defense-in-depth). The admin RPC wrapper already
  --    confirmed admin authority; this validates the TARGET participant
  --    (whose prediction is being submitted on behalf of), not the caller.
  SELECT auth_user_id INTO v_auth_user_id
    FROM public.participants
   WHERE id = p_participant_id;
  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WCM05',
      MESSAGE = format('participant %s not found', p_participant_id);
  END IF;
  IF NOT public.is_eligible_nortal_participant(v_auth_user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WCM05',
      MESSAGE = format('participant %s ineligible', p_participant_id);
  END IF;

  -- 5. Validate match existence. (No status / lock check beyond this -- the
  --    whole point of the bypass-lock variant is to admit submissions on
  --    locked OR non-scheduled matches per FR-002 admin override semantics.)
  SELECT status INTO v_match_status
    FROM public.matches
   WHERE id = p_match_id;
  IF v_match_status IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WCM04',
      MESSAGE = format('match %s not found', p_match_id);
  END IF;

  -- 6. *** LOCK CHECK SKIPPED *** -- this is the only difference vs slice 003.
  --    Slice 003 slot 0037 enforces is_prediction_locked() here. The bypass
  --    variant intentionally omits that gate so admin overrides can land
  --    after kickoff (and on cancelled/finished matches). The contract makes
  --    this explicit at admin_submit_prediction § Behavior step 3:
  --      "the bypass-lock variant performs the same INSERT + supersede logic
  --       but skips the lock check."

  -- 7. SUPERSEDE / CREATE branch (mirrors slice 003 slot 0037 step 7 verbatim,
  --    including the D-014 self-reference placeholder pattern). The slot-0033
  --    audit trigger on predictions emits prediction.created / prediction.
  --    superseded automatically; we do NOT emit those here.
  v_new_id := gen_random_uuid();

  SELECT id INTO v_existing_id
    FROM public.predictions
   WHERE participant_id = p_participant_id
     AND match_id       = p_match_id
     AND superseded_at IS NULL
   FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    -- c.1: self-reference placeholder (slice 003 D-014 pattern).
    UPDATE public.predictions
       SET superseded_at = now(),
           superseded_by = v_existing_id
     WHERE id = v_existing_id;

    -- c.2: INSERT new active row.
    INSERT INTO public.predictions (
      id, participant_id, match_id,
      predicted_home, predicted_away,
      source, created_by
    ) VALUES (
      v_new_id, p_participant_id, p_match_id,
      p_home, p_away,
      p_source::public.prediction_source, p_participant_id
    );

    -- c.3: fix the placeholder.
    UPDATE public.predictions
       SET superseded_by = v_new_id
     WHERE id = v_existing_id;
  ELSE
    -- Fresh prediction -- plain INSERT.
    INSERT INTO public.predictions (
      id, participant_id, match_id,
      predicted_home, predicted_away,
      source, created_by
    ) VALUES (
      v_new_id, p_participant_id, p_match_id,
      p_home, p_away,
      p_source::public.prediction_source, p_participant_id
    );
  END IF;

  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION public.admin_submit_prediction_bypass_lock(
  uuid, uuid, int, int, text
) IS
  'Slice 006 / T038: lock-bypass sibling of slice 003 submit_prediction (slot 0037). '
  'Identical body EXCEPT step 6 (is_prediction_locked gate) is skipped so admin '
  'overrides can land on locked / non-scheduled matches per FR-002. Called by '
  'admin_submit_prediction when is_prediction_locked(p_match_id) returns TRUE. '
  'Slice 003 submit_prediction signature remains unchanged (additive sibling per '
  'Principle XI).';

REVOKE EXECUTE ON FUNCTION public.admin_submit_prediction_bypass_lock(
  uuid, uuid, int, int, text
) FROM PUBLIC;

-- The bypass-lock SP is callable only from inside admin_submit_prediction
-- (which runs SECURITY DEFINER as postgres). authenticated does NOT get
-- direct EXECUTE -- this prevents a non-admin from bypassing the admin
-- wrapper's WAR01 check. SECURITY DEFINER on the wrapper bypasses the
-- bypass-lock SP's missing grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.admin_submit_prediction_bypass_lock(uuid, uuid, int, int, text) TO service_role';
  END IF;
END $$;

-- ===========================================================================
-- 2. admin_submit_prediction(...) wrapper SP.
--    Pre-flight + lock-state branch + audit.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.admin_submit_prediction(
  p_participant_id  uuid,
  p_match_id        uuid,
  p_home            int,
  p_away            int,
  p_reason          text,
  p_source_citation text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth_user_id     uuid;
  v_admin_id         uuid;
  v_caller_pid       uuid;
  v_is_locked        boolean;
  v_new_id           uuid;
  v_old              jsonb;
  v_new              jsonb;
  v_underlying_state text;
BEGIN
  -- -------------------------------------------------------------------------
  -- Pre-flight step 1: admin authority check.
  -- Mirrors slot 0064 T013 pattern. The access-denied INSERT runs in a sub-
  -- block so any failure does NOT prevent the WAR01 raise. SECURITY DEFINER
  -- bypasses RLS on audit_log; sub-block is defence-in-depth.
  -- -------------------------------------------------------------------------
  v_auth_user_id := auth.uid();

  IF NOT public.is_admin(v_auth_user_id) THEN
    SELECT id INTO v_caller_pid
      FROM public.participants
     WHERE auth_user_id = v_auth_user_id;

    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, entity_id,
        previous_value, new_value, reason, source, source_citation
      ) VALUES (
        v_caller_pid,
        'admin.access_denied',
        'prediction',
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
  -- Pre-flight step 4: resolve admin's participants.id (must exist because
  -- is_admin already returned TRUE; admin_roles FK guarantees it).
  -- -------------------------------------------------------------------------
  SELECT id INTO v_admin_id
    FROM public.participants
   WHERE auth_user_id = v_auth_user_id;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 5: validate target participant exists. The underlying SP
  -- raises WCM05 (which we'd remap to WAR05) but raising WAR04 here gives
  -- the route handler the right HTTP 404 mapping per contract § ERRCODE table.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM public.participants WHERE id = p_participant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('participant %s not found', p_participant_id);
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 6: validate match exists.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM public.matches WHERE id = p_match_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('match %s not found', p_match_id);
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 7: per-pair advisory lock to serialize concurrent admin
  -- submissions on the same (participant, match). The underlying SP ALSO
  -- takes the same per-pair advisory lock at step 1; pg_advisory_xact_lock
  -- is re-entrant within a transaction so the double acquisition is a no-op.
  -- -------------------------------------------------------------------------
  PERFORM pg_advisory_xact_lock(
    hashtext('admin_submit_prediction:' || p_participant_id::text || ':' || p_match_id::text)
  );

  -- -------------------------------------------------------------------------
  -- Step 8: capture existing-active prediction (if any) for the audit row's
  -- previous_value. NULL when no prior active row exists.
  -- -------------------------------------------------------------------------
  SELECT to_jsonb(t.*) INTO v_old
    FROM public.predictions t
   WHERE t.participant_id = p_participant_id
     AND t.match_id       = p_match_id
     AND t.superseded_at IS NULL;

  -- -------------------------------------------------------------------------
  -- Step 9: branch on lock state. is_prediction_locked() is the single
  -- authoritative lock predicate (Principle III). Locked -> bypass-lock
  -- sibling. Unlocked -> slice 003's locked SP path.
  -- -------------------------------------------------------------------------
  v_is_locked := public.is_prediction_locked(p_match_id);

  BEGIN
    IF v_is_locked THEN
      v_new_id := public.admin_submit_prediction_bypass_lock(
        p_participant_id,
        p_match_id,
        p_home,
        p_away,
        'admin_override'
      );
    ELSE
      v_new_id := public.submit_prediction(
        p_participant_id,
        p_match_id,
        p_home,
        p_away,
        'admin_override'
      );
    END IF;
  EXCEPTION
    -- Underlying SP invariant violations -> WAR05 with original SQLSTATE
    -- preserved in MESSAGE per contracts/admin-rpcs.write.md § ERRCODE WAR05.
    -- Slice 003 raises WCM01..WCM06 (custom SQLSTATEs) plus native 22023 etc.
    WHEN OTHERS THEN
      v_underlying_state := SQLSTATE;
      -- Re-raise our own pre-flight raises untouched so the route handler
      -- sees the correct WAR0x ERRCODE. Slice 003 SQLSTATEs all start with
      -- 'WCM' (custom 5-char codes); native PG codes start with digits.
      IF v_underlying_state LIKE 'WAR%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION USING
        ERRCODE = 'WAR05',
        MESSAGE = format(
          'underlying invariant violation (slice 003 SQLSTATE=%s): %s',
          v_underlying_state, SQLERRM
        );
  END;

  -- -------------------------------------------------------------------------
  -- Step 10: capture new prediction state.
  -- -------------------------------------------------------------------------
  SELECT to_jsonb(t.*) INTO v_new
    FROM public.predictions t
   WHERE t.id = v_new_id;

  -- -------------------------------------------------------------------------
  -- Step 11: emit admin.prediction_submitted audit row. The
  -- previous_value JSON carries a `lock_bypass` boolean per contract § Audit
  -- emission: the bypass-lock variant is distinguished by
  -- audit_log.previous_value->>'lock_bypass' = 'true'. When v_old is non-NULL
  -- we MERGE the lock_bypass flag into it; when NULL we emit a JSON object
  -- carrying only the flag (so consumers can always rely on the field's
  -- presence).
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source, source_citation
  ) VALUES (
    v_admin_id,
    'admin.prediction_submitted',
    'prediction',
    v_new_id,
    COALESCE(v_old, '{}'::jsonb) || jsonb_build_object('lock_bypass', v_is_locked),
    v_new,
    p_reason,
    'admin_rpc',
    p_source_citation
  );

  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION public.admin_submit_prediction(
  uuid, uuid, int, int, text, text
) IS
  'Slice 006 / T038: SECURITY DEFINER admin RPC wrapping slice 003 submit_prediction. '
  'Pre-flight: is_admin (->WAR01 + audit) + reason (->WAR02) + source_citation (->WAR03) '
  '+ participant_id existence (->WAR04) + match_id existence (->WAR04). Lock-state '
  'branch: is_prediction_locked(p_match_id) -> admin_submit_prediction_bypass_lock; '
  'else -> public.submit_prediction(..., ''admin_override''). Underlying-SP exceptions '
  'propagate as WAR05 (own WAR0x raises preserved). Audit row '
  'action=''admin.prediction_submitted'' with previous_value->>''lock_bypass'' true/false. '
  'Signature LOCKED cross-slice per Principle XI.';

REVOKE EXECUTE ON FUNCTION public.admin_submit_prediction(
  uuid, uuid, int, int, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_submit_prediction(
  uuid, uuid, int, int, text, text
) TO authenticated;

COMMIT;
