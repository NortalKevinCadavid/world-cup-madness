-- Slice 004 / T016 / FR-001..FR-008 / contracts/final-predictions.write.md.
-- LOCKED CROSS-SLICE SP. Signature: submit_final_prediction(participant_id,
-- item_kind, target_team_id, target_player_id, source) RETURNS uuid.
-- ERRCODE values WFP01-WFP06.
-- Per Clarifications 2026-05-17 Q1: target_player must have removed_at IS NULL.
-- Per Clarifications 2026-05-17 Q2: NO disjoint between top_scorer/best_player.
-- T029 (US3) will extend with the supersede UPDATE+INSERT pattern (mirrors slice 003 D-014).
-- Migration slot 0044 per D-016 (spec said 0041; slot 0041 was renumbered for
-- is_final_prediction_locked()).
--
-- Scope discipline (Constitution Principle X):
--   * CREATE branch + all rejection branches only. T029 owns the supersede branch.
--   * Per-pair advisory lock serializes concurrent submits for the same
--     (participant, item_kind). Different items proceed in parallel.
--   * Happy-path audit rows are emitted by the slot-0043 trigger automatically;
--     this SP body intentionally does NOT INSERT into public.audit_log.
--     Rejection-path audit rows are the route handler's responsibility because
--     RAISE EXCEPTION rolls the SP transaction back, which would discard any
--     audit insert written here.
--   * SECURITY DEFINER + SET search_path = public, pg_temp (Constitution II).
--   * No service-role usage anywhere. The SECURITY DEFINER privilege is what
--     lets the SP write into final_predictions despite the table's RLS-locked-
--     down write surface (slot 0042).

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_final_prediction(
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
  v_allow_identical         boolean;
  v_existing_champion_team  uuid;
  v_existing_runner_up_team uuid;
BEGIN
  -- 1. Per-pair advisory transaction lock. Concurrent submits for the SAME
  --    (participant, item_kind) pair serialize through this lock; different
  --    pairs proceed in parallel. The hashtext() input combines both inputs
  --    so the lock key is unique per pair. Auto-releases at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_participant_id::text || ':' || p_item_kind)
  );

  -- 2a. Validate item_kind enum membership.
  IF p_item_kind NOT IN ('champion', 'runner_up', 'top_scorer', 'best_player') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WFP03',
      MESSAGE = format('invalid item_kind %s', p_item_kind);
  END IF;

  -- 2b. Validate source enum membership. The three documented channels are
  --     'ui'/'api' for normal flow and 'admin_override' for the Slice 006
  --     admin wrapper.
  IF p_source NOT IN ('ui', 'api', 'admin_override') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WFP03',
      MESSAGE = format('invalid source %s', p_source);
  END IF;

  -- 2c. Validate kind/target shape (XOR consistency with the
  --     final_predictions_target_xor_kind table CHECK):
  --       * champion / runner_up  -> target_team_id required, target_player_id NULL
  --       * top_scorer / best_player -> target_player_id required, target_team_id NULL
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
    -- top_scorer or best_player
    IF p_target_player_id IS NULL OR p_target_team_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WFP03',
        MESSAGE = format(
          'item_kind %s requires target_player_id only',
          p_item_kind
        );
    END IF;
  END IF;

  -- 3. Validate target existence. Team kinds look up public.teams; player
  --    kinds look up public.players with removed_at IS NULL (Clarifications
  --    2026-05-17 Q1 — a soft-removed player MUST NOT be a valid target).
  IF p_item_kind IN ('champion', 'runner_up') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.teams WHERE id = p_target_team_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WFP04',
        MESSAGE = format('team %s not found', p_target_team_id);
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
        FROM public.players
       WHERE id         = p_target_player_id
         AND removed_at IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WFP04',
        MESSAGE = format('player %s not found or removed', p_target_player_id);
    END IF;
  END IF;

  -- 4. Defense-in-depth eligibility check. The route handler already called
  --    requireEligible() at the HTTP boundary, but the SP MUST NOT trust it.
  --    A NULL auth_user_id means the participant row does not exist at all.
  SELECT auth_user_id INTO v_auth_user_id
    FROM public.participants
   WHERE id = p_participant_id;
  IF v_auth_user_id IS NULL
     OR NOT public.is_eligible_nortal_participant(v_auth_user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WFP05',
      MESSAGE = format('participant %s not eligible', p_participant_id);
  END IF;

  -- 5. Lock check. The single named predicate is_final_prediction_locked()
  --    (slot 0041) is the only place that combines the first-kickoff cutoff
  --    + fail-closed semantics (Constitution Principle III). After the
  --    tournament's first kickoff every final-prediction write is rejected.
  IF public.is_final_prediction_locked() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WFP01',
      MESSAGE = 'final predictions locked (post first kickoff)';
  END IF;

  -- 6. Disjoint check (FR-007): champion != runner_up unless the config flag
  --    'predictions.allow_identical_champion_runner_up' is set true (default
  --    false per seed slot 0047). Per Clarifications 2026-05-17 Q2 there is
  --    NO disjoint check between top_scorer and best_player — those two
  --    items are independent. The check only fires for champion/runner_up.
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
        -- p_item_kind = 'champion'
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

  -- 7. INSERT the new active prediction. The audit trigger on
  --    final_predictions (slot 0043) automatically emits a
  --    'final_prediction.created' audit_log row on INSERT when
  --    superseded_at IS NULL — do NOT write that row from this SP body
  --    (would duplicate the audit chain).
  --
  --    NO supersede in this phase (T029 owns). If an existing active row
  --    exists for (participant, item_kind), the partial unique index
  --    final_predictions_active_uk will reject this INSERT with 23505.
  --    That's expected behavior for US1's create-only scope; T029 (US3)
  --    will replace this INSERT with the supersede UPDATE+INSERT pattern
  --    per the D-014 placeholder approach (mirrors slice 003 T021).
  INSERT INTO public.final_predictions (
    participant_id,
    item_kind,
    target_team_id,
    target_player_id,
    source,
    created_by
  )
  VALUES (
    p_participant_id,
    p_item_kind::public.final_prediction_item_kind,
    p_target_team_id,
    p_target_player_id,
    p_source::public.final_prediction_source,
    p_participant_id
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permissions — least-privilege.
-- ---------------------------------------------------------------------------
-- Default PUBLIC EXECUTE on functions is undesirable for a SECURITY DEFINER
-- write SP. Revoke and grant only to the roles that should call it.
REVOKE EXECUTE ON FUNCTION public.submit_final_prediction(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.submit_final_prediction(uuid, text, uuid, uuid, text) TO authenticated;

-- service_role grant is conditional — local CI / pgTAP runs may not have the
-- Supabase-managed service_role created. The DO block keeps the migration
-- safely re-runnable across environments.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.submit_final_prediction(uuid, text, uuid, uuid, text) TO service_role';
  END IF;
END $$;

COMMIT;
