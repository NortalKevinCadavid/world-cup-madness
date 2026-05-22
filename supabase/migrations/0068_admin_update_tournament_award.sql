-- Slice 006 / T030 / US3 / contracts/admin-rpcs.write.md § admin_update_tournament_award.
-- Migration slot 0068 per D-026 (spec slot 0055 collides with prior shipped slot;
-- the slice-006 renumber assigns admin_update_tournament_award to physical 0068).
-- LOCKED CROSS-SLICE SP signature per Principle XI.
-- Updates one of the 4 tournament award slots (champion/runner_up/top_scorer/best_player)
-- by item_kind dispatch. Single-tournament posture (LIMIT 1 lookup; no
-- p_tournament_id parameter per contracts/admin-rpcs.write.md signature).
-- BEFORE UPDATE trigger (slot 0051 tournament_award_set_at_before_update)
-- refreshes set_at; AFTER UPDATE trigger (slot 0059 award_confirmed_trigger)
-- fires pg_net dispatch to score-trigger Edge Function scope='finals'.
-- Audit emission: admin.award_updated (LOCKED action label).
--
-- Pre-flight: is_admin check (-> WAR01 + audit) + item_kind validation (-> WAR04)
-- + status validation (-> WAR04) + kind/target shape validation (-> WAR04)
-- + reason validation (-> WAR02) + source_citation validation (-> WAR03).
-- Body: per-tournament advisory lock + capture old/new state + dispatch UPDATE
-- per item_kind + no-op detect (-> WAR07) + audit admin.award_updated.
--
-- ERRCODE mapping:
--   WAR01 = admin authority required (non-admin caller)
--   WAR02 = reason missing or empty
--   WAR03 = source_citation missing or empty
--   WAR04 = invalid item_kind, invalid status, kind/target shape mismatch,
--           confirmed status with NULL target id, or no tournament_award row exists
--   WAR07 = no-op (post-state identical to pre-state)
--
-- Audit-row survival on access denial:
--   The WAR01 audit insert is wrapped in BEGIN/EXCEPTION sub-block (mirrors
--   slot 0064 T013 pattern). SECURITY DEFINER bypasses RLS regardless of
--   slot 0073's policy. Any INSERT failure is swallowed so the WAR01 RAISE
--   always fires. source='api_guard' to match T013's access-denied audit row.
--
-- Cross-slice triggers fired by the UPDATE statement:
--   * slot 0051 BEFORE UPDATE trigger (tournament_award_set_at_before_update):
--       refreshes set_at on tracked-column changes (4 *_id + 4 *_status).
--   * slot 0059 AFTER UPDATE trigger (award_confirmed_trigger):
--       invokes invoke_score_trigger('finals', NULL) -> pg_net.http_post to
--       score-trigger Edge Function when any (id, status) pair changed.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_update_tournament_award(
  p_item_kind       text,
  p_new_team_id     uuid,
  p_new_player_id   uuid,
  p_new_status      text,
  p_reason          text,
  p_source_citation text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth_user_id  uuid;
  v_admin_id      uuid;
  v_caller_pid    uuid;
  v_tournament_id uuid;
  v_old           jsonb;
  v_new           jsonb;
BEGIN
  -- -------------------------------------------------------------------------
  -- Step 1: admin authority check (+ access_denied audit).
  -- -------------------------------------------------------------------------
  v_auth_user_id := auth.uid();

  IF NOT public.is_admin(v_auth_user_id) THEN
    -- Resolve caller's participants.id (may be NULL if caller has no row).
    SELECT id INTO v_caller_pid
      FROM public.participants
     WHERE auth_user_id = v_auth_user_id;

    -- Sub-block so any INSERT failure (constraint, RLS reinvocation) does NOT
    -- prevent the WAR01 raise. SECURITY DEFINER bypasses RLS regardless.
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, entity_id,
        previous_value, new_value, reason, source, source_citation
      ) VALUES (
        v_caller_pid,
        'admin.access_denied',
        'tournament_award',
        NULL,
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

  -- Resolve admin's participants.id (guaranteed to exist by admin_roles FK
  -- since is_admin already returned TRUE).
  SELECT id INTO v_admin_id
    FROM public.participants
   WHERE auth_user_id = v_auth_user_id;

  -- -------------------------------------------------------------------------
  -- Step 2: validate item_kind enum membership.
  -- -------------------------------------------------------------------------
  IF p_item_kind IS NULL
     OR p_item_kind NOT IN ('champion', 'runner_up', 'top_scorer', 'best_player') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('invalid item_kind: %L', p_item_kind);
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 3: validate status enum membership.
  -- -------------------------------------------------------------------------
  IF p_new_status IS NULL
     OR p_new_status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('invalid status: %L', p_new_status);
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 4: validate kind/target shape.
  --   * champion / runner_up MUST pass p_new_team_id and NULL p_new_player_id.
  --   * top_scorer / best_player MUST pass p_new_player_id and NULL p_new_team_id.
  --   * 'confirmed' status MUST carry a non-NULL target id (the tournament_award
  --     CHECK constraints at slot 0051 enforce this at the table level; we
  --     raise WAR04 here so the contract surfaces a clean WAR04 instead of a
  --     generic CHECK violation).
  -- -------------------------------------------------------------------------
  IF p_item_kind IN ('champion', 'runner_up') AND p_new_player_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('item_kind %L requires p_new_team_id only (p_new_player_id must be NULL)', p_item_kind);
  END IF;

  IF p_item_kind IN ('top_scorer', 'best_player') AND p_new_team_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('item_kind %L requires p_new_player_id only (p_new_team_id must be NULL)', p_item_kind);
  END IF;

  IF p_new_status = 'confirmed' THEN
    IF p_item_kind IN ('champion', 'runner_up') AND p_new_team_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WAR04',
        MESSAGE = format('confirmed %L requires non-NULL p_new_team_id', p_item_kind);
    END IF;
    IF p_item_kind IN ('top_scorer', 'best_player') AND p_new_player_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WAR04',
        MESSAGE = format('confirmed %L requires non-NULL p_new_player_id', p_item_kind);
    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 5: validate reason.
  -- -------------------------------------------------------------------------
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR02',
      MESSAGE = 'reason missing or empty';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 6: validate source_citation.
  -- -------------------------------------------------------------------------
  IF p_source_citation IS NULL OR length(trim(p_source_citation)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR03',
      MESSAGE = 'source citation missing or empty';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 7: locate the single tournament_award row.
  -- Single-tournament posture (contract: no p_tournament_id parameter).
  -- ORDER BY set_at ASC LIMIT 1 deterministically picks the original row
  -- should a future slice ever insert additional rows.
  -- -------------------------------------------------------------------------
  SELECT tournament_id INTO v_tournament_id
    FROM public.tournament_award
   ORDER BY set_at ASC
   LIMIT 1;

  IF v_tournament_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = 'no tournament_award row exists';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 8: per-tournament advisory lock.
  -- Serializes concurrent admin updates against the same tournament_award
  -- row. Different tournaments lock independently (future-proofing if the
  -- single-tournament constraint ever relaxes).
  -- -------------------------------------------------------------------------
  PERFORM pg_advisory_xact_lock(
    hashtext('admin_update_tournament_award:' || v_tournament_id::text)
  );

  -- -------------------------------------------------------------------------
  -- Step 9: capture previous state (jsonb).
  -- -------------------------------------------------------------------------
  SELECT to_jsonb(ta.*) INTO v_old
    FROM public.tournament_award ta
   WHERE ta.tournament_id = v_tournament_id;

  -- -------------------------------------------------------------------------
  -- Step 10: dynamic UPDATE per item_kind dispatch.
  -- COALESCE preserves the existing id if NULL is passed (admin may want to
  -- transition status without changing the id, e.g. confirmed -> pending).
  -- set_at is refreshed by slot 0051's BEFORE UPDATE trigger.
  -- award_confirmed_trigger (slot 0059) fires AFTER UPDATE -> pg_net dispatch
  -- to score-trigger Edge Function scope='finals'.
  -- -------------------------------------------------------------------------
  CASE p_item_kind
    WHEN 'champion' THEN
      UPDATE public.tournament_award
         SET champion_team_id = COALESCE(p_new_team_id, champion_team_id),
             champion_status  = p_new_status::public.award_status,
             set_by           = v_admin_id
       WHERE tournament_id = v_tournament_id;
    WHEN 'runner_up' THEN
      UPDATE public.tournament_award
         SET runner_up_team_id = COALESCE(p_new_team_id, runner_up_team_id),
             runner_up_status  = p_new_status::public.award_status,
             set_by            = v_admin_id
       WHERE tournament_id = v_tournament_id;
    WHEN 'top_scorer' THEN
      UPDATE public.tournament_award
         SET top_scorer_player_id = COALESCE(p_new_player_id, top_scorer_player_id),
             top_scorer_status    = p_new_status::public.award_status,
             set_by               = v_admin_id
       WHERE tournament_id = v_tournament_id;
    WHEN 'best_player' THEN
      UPDATE public.tournament_award
         SET best_player_player_id = COALESCE(p_new_player_id, best_player_player_id),
             best_player_status    = p_new_status::public.award_status,
             set_by                = v_admin_id
       WHERE tournament_id = v_tournament_id;
  END CASE;

  -- -------------------------------------------------------------------------
  -- Step 11: capture new state and detect no-op.
  -- A no-op (admin issued an update that changed nothing tracked) raises
  -- WAR07 per contract — the audit_log should not record a state-less change.
  -- The set_by column is excluded from the comparison by jsonb equality
  -- because v_old and v_new are full row dumps; however, set_by IS updated
  -- to v_admin_id by Step 10, so v_new MIGHT differ even on a pure status/id
  -- no-op. To suppress that false positive, we strip set_by from both sides
  -- before equality check. set_at is updated only when slot 0051's BEFORE
  -- UPDATE trigger detects a tracked-column change, so set_at IS a reliable
  -- diff signal — but we strip it anyway since it's derived state, not an
  -- input the admin proposed.
  -- -------------------------------------------------------------------------
  SELECT to_jsonb(ta.*) INTO v_new
    FROM public.tournament_award ta
   WHERE ta.tournament_id = v_tournament_id;

  IF (v_new - 'set_by' - 'set_at') = (v_old - 'set_by' - 'set_at') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR07',
      MESSAGE = format('no-op: %L produced no observable change', p_item_kind);
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 12: emit admin.award_updated audit row.
  -- contracts/admin-rpcs.write.md § Audit emission pattern (locked shape).
  -- Action label LOCKED: 'admin.award_updated' (NOT 'admin.tournament_award_updated').
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source, source_citation
  ) VALUES (
    v_admin_id,
    'admin.award_updated',
    'tournament_award',
    v_tournament_id,
    v_old,
    v_new,
    p_reason,
    'admin_rpc',
    p_source_citation
  );
END;
$$;

COMMENT ON FUNCTION public.admin_update_tournament_award(
  text, uuid, uuid, text, text, text
) IS
  'Slice 006 / T030 / US3 / FR (admin overrides). SECURITY DEFINER admin RPC '
  'that updates one of the 4 tournament_award items (champion/runner_up/'
  'top_scorer/best_player) via item_kind dispatch. Pre-flight: is_admin '
  '(->WAR01+audit) + item_kind/status/shape (->WAR04) + reason (->WAR02) + '
  'source_citation (->WAR03). Body: per-tournament advisory lock + capture '
  'old/new state + dispatch UPDATE + no-op detect (->WAR07) + audit '
  'admin.award_updated with source=''admin_rpc''. Slice 005''s slot 0051 '
  'BEFORE UPDATE trigger refreshes set_at; slot 0059 AFTER UPDATE '
  'award_confirmed_trigger invokes the score-trigger Edge Function with '
  'scope=''finals'' via pg_net. Single-tournament posture (no p_tournament_id '
  'parameter). Signature LOCKED cross-slice per Principle XI.';

-- ---------------------------------------------------------------------------
-- Permissions.
-- ---------------------------------------------------------------------------
-- The SP is invoked by the /api/admin/tournament-award route handler running
-- under the admin's JWT (role=authenticated). SECURITY DEFINER gives it the
-- privileges to write tournament_award + audit_log; GRANT EXECUTE lets
-- authenticated callers reach the function. PUBLIC REVOKE is defensive.
REVOKE EXECUTE ON FUNCTION public.admin_update_tournament_award(
  text, uuid, uuid, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_update_tournament_award(
  text, uuid, uuid, text, text, text
) TO authenticated;

COMMIT;
