-- Slice 006 / T038 / Phase 7 / contracts/admin-rpcs.write.md § admin_submit_final_prediction.
-- Migration slot 0067 per D-026 (spec slot 0054 collides with prior shipped 0054_leaderboard_views.sql).
-- LOCKED CROSS-SLICE SP signature per Principle XI.
--
-- Two SECURITY DEFINER functions land here:
--   1. public.admin_submit_final_prediction_bypass_lock(...) RETURNS uuid
--        Mirrors slice 004's submit_final_prediction (slots 0044 + 0048) EXCEPT
--        the is_final_prediction_locked() gate at step 5 is skipped. Everything
--        else (item_kind validation, source enum, kind/target XOR, target
--        existence, eligibility, disjoint check, supersede "born-superseded
--        then resurrect" pattern from slot 0048) is preserved verbatim so the
--        bypass variant produces identical final_predictions/audit shapes to
--        the normal path on an unlocked tournament.
--
--        Slice 004's submit_final_prediction signature remains unchanged; this
--        slice OWNS the bypass-lock sibling per contracts/admin-rpcs.write.md §
--        admin_submit_final_prediction (mirrors the parallel decision for
--        admin_submit_prediction).
--
--   2. public.admin_submit_final_prediction(...) RETURNS uuid
--        Admin wrapper. Pre-flight (WAR01..WAR03), branch on
--        is_final_prediction_locked():
--          locked   -> delegate to admin_submit_final_prediction_bypass_lock(...) (this slice)
--          unlocked -> delegate to public.submit_final_prediction(..., 'admin_override')
--        Emit one admin.final_prediction_submitted audit row carrying
--        previous_value->>'lock_bypass' = 'true'/'false'.
--
-- audit_log.source CHECK already admits 'admin_rpc' (slot 0064 T013).
--
-- ERRCODE mapping (per contracts/admin-rpcs.write.md § ERRCODE values):
--   WAR01 = not admin            (admin.access_denied audit + raise)
--   WAR02 = reason missing/empty
--   WAR03 = source_citation missing/empty
--   WAR04 = participant_id not found OR target (team/player) not found
--   WAR05 = invariant violation propagated from underlying SP
--           (slice 004 SQLSTATE 'WFP01'..'WFP06' / 22023 / P0001)

BEGIN;

-- ===========================================================================
-- 1. admin_submit_final_prediction_bypass_lock(...) sibling SP.
--    Mirrors slot 0048 (the supersede variant) EXCEPT step 5 (is_final_-
--    prediction_locked gate) is removed. Audit emission is fully handled by
--    the slot-0043 trigger + the 7s.d manual INSERT for the resurrect path
--    (both copied verbatim).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.admin_submit_final_prediction_bypass_lock(
  p_participant_id   uuid,
  p_item_kind        text,
  p_target_team_id   uuid,
  p_target_player_id uuid,
  p_source           text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth_user_id            uuid;
  v_new_id                  uuid;
  v_existing_id             uuid;
  v_allow_identical         boolean;
  v_existing_champion_team  uuid;
  v_existing_runner_up_team uuid;
  v_new_row                 public.final_predictions%ROWTYPE;
BEGIN
  -- 1. Per-pair advisory lock for (participant, item_kind).
  PERFORM pg_advisory_xact_lock(
    hashtext(p_participant_id::text || ':' || p_item_kind)
  );

  -- 2a. Validate item_kind enum membership.
  IF p_item_kind NOT IN ('champion', 'runner_up', 'top_scorer', 'best_player') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WFP03',
      MESSAGE = format('invalid item_kind %s', p_item_kind);
  END IF;

  -- 2b. Validate source enum membership.
  IF p_source NOT IN ('ui', 'api', 'admin_override') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WFP03',
      MESSAGE = format('invalid source %s', p_source);
  END IF;

  -- 2c. Validate kind/target XOR shape.
  IF p_item_kind IN ('champion', 'runner_up') THEN
    IF p_target_team_id IS NULL OR p_target_player_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WFP03',
        MESSAGE = format(
          'item_kind %s requires target_team_id only',
          p_item_kind
        );
    END IF;
  ELSE
    IF p_target_player_id IS NULL OR p_target_team_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WFP03',
        MESSAGE = format(
          'item_kind %s requires target_player_id only',
          p_item_kind
        );
    END IF;
  END IF;

  -- 3. Validate target existence (Clarifications 2026-05-17 Q1: removed_at IS NULL).
  IF p_item_kind IN ('champion', 'runner_up') THEN
    IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = p_target_team_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WFP04',
        MESSAGE = format('team %s not found', p_target_team_id);
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.players
       WHERE id = p_target_player_id AND removed_at IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WFP04',
        MESSAGE = format('player %s not found or removed', p_target_player_id);
    END IF;
  END IF;

  -- 4. Defense-in-depth eligibility on the TARGET participant.
  SELECT auth_user_id INTO v_auth_user_id
    FROM public.participants
   WHERE id = p_participant_id;
  IF v_auth_user_id IS NULL
     OR NOT public.is_eligible_nortal_participant(v_auth_user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WFP05',
      MESSAGE = format('participant %s not eligible', p_participant_id);
  END IF;

  -- 5. *** LOCK CHECK SKIPPED *** -- this is the only difference vs slice 004.
  --    Slice 004 slot 0048 enforces is_final_prediction_locked() here. The
  --    bypass variant intentionally omits that gate so admin overrides can
  --    land after first kickoff.

  -- 6. Disjoint check (FR-007): champion != runner_up unless config allows.
  IF p_item_kind IN ('champion', 'runner_up') THEN
    SELECT (value::text)::boolean INTO v_allow_identical
      FROM public.tournament_config
     WHERE key = 'predictions.allow_identical_champion_runner_up';
    v_allow_identical := COALESCE(v_allow_identical, false);

    IF NOT v_allow_identical THEN
      IF p_item_kind = 'runner_up' THEN
        SELECT target_team_id INTO v_existing_champion_team
          FROM public.final_predictions
         WHERE participant_id = p_participant_id
           AND item_kind      = 'champion'
           AND superseded_at IS NULL;
        IF v_existing_champion_team IS NOT NULL
           AND v_existing_champion_team = p_target_team_id THEN
          RAISE EXCEPTION USING
            ERRCODE = 'WFP06',
            MESSAGE = 'runner_up cannot equal champion';
        END IF;
      ELSE
        SELECT target_team_id INTO v_existing_runner_up_team
          FROM public.final_predictions
         WHERE participant_id = p_participant_id
           AND item_kind      = 'runner_up'
           AND superseded_at IS NULL;
        IF v_existing_runner_up_team IS NOT NULL
           AND v_existing_runner_up_team = p_target_team_id THEN
          RAISE EXCEPTION USING
            ERRCODE = 'WFP06',
            MESSAGE = 'champion cannot equal runner_up';
        END IF;
      END IF;
    END IF;
  END IF;

  -- 7. SUPERSEDE / CREATE branch (mirrors slot 0048's "born-superseded NEW
  --    then resurrect" pattern verbatim, including the manual 7s.d audit
  --    INSERT for the resurrect path).
  SELECT id INTO v_existing_id
    FROM public.final_predictions
   WHERE participant_id = p_participant_id
     AND item_kind      = p_item_kind::public.final_prediction_item_kind
     AND superseded_at IS NULL
   FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    v_new_id := gen_random_uuid();

    -- 7s.a INSERT NEW born-superseded.
    INSERT INTO public.final_predictions (
      id, participant_id, item_kind,
      target_team_id, target_player_id,
      source, created_by, superseded_at, superseded_by
    ) VALUES (
      v_new_id, p_participant_id,
      p_item_kind::public.final_prediction_item_kind,
      p_target_team_id, p_target_player_id,
      p_source::public.final_prediction_source,
      p_participant_id, now(), v_existing_id
    );

    -- 7s.b supersede OLD -> v_new_id (slot-0043 trigger fires here).
    UPDATE public.final_predictions
       SET superseded_at = now(),
           superseded_by = v_new_id
     WHERE id = v_existing_id;

    -- 7s.c resurrect NEW.
    UPDATE public.final_predictions
       SET superseded_at = NULL,
           superseded_by = NULL
     WHERE id = v_new_id;

    -- 7s.d manually emit final_prediction.created (trigger missed it).
    SELECT * INTO v_new_row FROM public.final_predictions WHERE id = v_new_id;

    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, source
    ) VALUES (
      COALESCE(v_new_row.created_by, v_new_row.participant_id),
      'final_prediction.created',
      'final_prediction',
      v_new_id,
      NULL,
      to_jsonb(v_new_row),
      'trigger'
    );
  ELSE
    -- CREATE PATH -- plain INSERT; slot-0043 trigger emits final_prediction.created.
    INSERT INTO public.final_predictions (
      participant_id, item_kind,
      target_team_id, target_player_id,
      source, created_by
    ) VALUES (
      p_participant_id,
      p_item_kind::public.final_prediction_item_kind,
      p_target_team_id, p_target_player_id,
      p_source::public.final_prediction_source,
      p_participant_id
    )
    RETURNING id INTO v_new_id;
  END IF;

  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION public.admin_submit_final_prediction_bypass_lock(
  uuid, text, uuid, uuid, text
) IS
  'Slice 006 / T038: lock-bypass sibling of slice 004 submit_final_prediction (slot 0048). '
  'Identical body EXCEPT step 5 (is_final_prediction_locked gate) is skipped so admin '
  'overrides can land after the tournament''s first kickoff. Called by '
  'admin_submit_final_prediction when is_final_prediction_locked() returns TRUE. '
  'Slice 004 submit_final_prediction signature remains unchanged (additive sibling per '
  'Principle XI).';

REVOKE EXECUTE ON FUNCTION public.admin_submit_final_prediction_bypass_lock(
  uuid, text, uuid, uuid, text
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.admin_submit_final_prediction_bypass_lock(uuid, text, uuid, uuid, text) TO service_role';
  END IF;
END $$;

-- ===========================================================================
-- 2. admin_submit_final_prediction(...) wrapper SP.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.admin_submit_final_prediction(
  p_participant_id   uuid,
  p_item_kind        text,
  p_target_team_id   uuid,
  p_target_player_id uuid,
  p_reason           text,
  p_source_citation  text
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
  -- Pre-flight step 1: admin authority check (+ access_denied audit).
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
        'final_prediction',
        NULL,
        NULL,
        NULL,
        'not_admin',
        'api_guard',
        NULL
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RAISE EXCEPTION USING
      ERRCODE = 'WAR01',
      MESSAGE = 'admin role required';
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight steps 2/3: reason + source_citation validation.
  -- -------------------------------------------------------------------------
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR02',
      MESSAGE = 'reason missing or empty';
  END IF;

  IF p_source_citation IS NULL OR length(trim(p_source_citation)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR03',
      MESSAGE = 'source citation missing or empty';
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 4: resolve admin's participants.id.
  -- -------------------------------------------------------------------------
  SELECT id INTO v_admin_id
    FROM public.participants
   WHERE auth_user_id = v_auth_user_id;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 5: validate target participant exists (-> WAR04 for HTTP
  -- 404 mapping per contract).
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM public.participants WHERE id = p_participant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('participant %s not found', p_participant_id);
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 6: per-pair advisory lock (re-entrant; underlying SP also
  -- takes the same key per (participant, item_kind)).
  -- -------------------------------------------------------------------------
  PERFORM pg_advisory_xact_lock(
    hashtext('admin_submit_final_prediction:' || p_participant_id::text || ':' || p_item_kind)
  );

  -- -------------------------------------------------------------------------
  -- Step 7: capture existing-active final prediction (if any).
  -- We tolerate invalid p_item_kind here -- the cast would fail; instead we
  -- only do the lookup when the kind is in the valid enum (the underlying SP
  -- raises WFP03 for invalid kinds, which we remap to WAR05).
  -- -------------------------------------------------------------------------
  IF p_item_kind IN ('champion', 'runner_up', 'top_scorer', 'best_player') THEN
    SELECT to_jsonb(t.*) INTO v_old
      FROM public.final_predictions t
     WHERE t.participant_id = p_participant_id
       AND t.item_kind      = p_item_kind::public.final_prediction_item_kind
       AND t.superseded_at IS NULL;
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 8: branch on lock state. is_final_prediction_locked() is zero-arg
  -- (the tournament-global predicate).
  -- -------------------------------------------------------------------------
  v_is_locked := public.is_final_prediction_locked();

  BEGIN
    IF v_is_locked THEN
      v_new_id := public.admin_submit_final_prediction_bypass_lock(
        p_participant_id,
        p_item_kind,
        p_target_team_id,
        p_target_player_id,
        'admin_override'
      );
    ELSE
      v_new_id := public.submit_final_prediction(
        p_participant_id,
        p_item_kind,
        p_target_team_id,
        p_target_player_id,
        'admin_override'
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      v_underlying_state := SQLSTATE;
      -- Preserve our own pre-flight raises.
      IF v_underlying_state LIKE 'WAR%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION USING
        ERRCODE = 'WAR05',
        MESSAGE = format(
          'underlying invariant violation (slice 004 SQLSTATE=%s): %s',
          v_underlying_state, SQLERRM
        );
  END;

  -- -------------------------------------------------------------------------
  -- Step 9: capture new final_prediction state.
  -- -------------------------------------------------------------------------
  SELECT to_jsonb(t.*) INTO v_new
    FROM public.final_predictions t
   WHERE t.id = v_new_id;

  -- -------------------------------------------------------------------------
  -- Step 10: emit admin.final_prediction_submitted audit row with
  -- previous_value->>'lock_bypass' = is_locked.
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source, source_citation
  ) VALUES (
    v_admin_id,
    'admin.final_prediction_submitted',
    'final_prediction',
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

COMMENT ON FUNCTION public.admin_submit_final_prediction(
  uuid, text, uuid, uuid, text, text
) IS
  'Slice 006 / T038: SECURITY DEFINER admin RPC wrapping slice 004 submit_final_prediction. '
  'Pre-flight: is_admin (->WAR01 + audit) + reason (->WAR02) + source_citation (->WAR03) '
  '+ participant_id existence (->WAR04). Lock-state branch: is_final_prediction_locked() '
  '-> admin_submit_final_prediction_bypass_lock; else -> public.submit_final_prediction'
  '(..., ''admin_override''). Underlying-SP exceptions propagate as WAR05 (own WAR0x raises '
  'preserved). Audit row action=''admin.final_prediction_submitted'' with '
  'previous_value->>''lock_bypass'' true/false. Signature LOCKED cross-slice per Principle XI.';

REVOKE EXECUTE ON FUNCTION public.admin_submit_final_prediction(
  uuid, text, uuid, uuid, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_submit_final_prediction(
  uuid, text, uuid, uuid, text, text
) TO authenticated;

COMMIT;
