-- Slice 004 / T029 / US3 / FR-010 / contracts/final-predictions.write.md § Stored procedure semantics step 7.
-- T029 (US3): added supersede branch. Together with T016, the SP now satisfies
-- FR-010 (one active per pair) + US3 (updatable any number of times before lock).
-- Migration slot 0048 per D-016. Pattern: mirrors slice 003's D-014 supersede
-- approach in spirit (multi-step write to navigate the partial unique index +
-- FK constraints) but with a NEW ordering required by T026 assertion A7, which
-- asserts the 'final_prediction.superseded' audit row's
-- new_value->>'superseded_by' EQUALS v_new_id (the new active row id).
--
-- Why slice 003's exact 3-step self-reference pattern is INSUFFICIENT here
-- ------------------------------------------------------------------------
-- Slice 003's T021 sequence is:
--   1. UPDATE OLD SET superseded_at = now(), superseded_by = v_existing_id
--      (self-reference placeholder).
--   2. INSERT NEW (active).
--   3. UPDATE OLD SET superseded_by = v_new_id.
-- The slot-0033 audit trigger fires on step 1's superseded_at NULL -> NOT NULL
-- transition, which captures new_value->>superseded_by = v_existing_id (OLD's
-- own id), NOT v_new_id. Slice 003 explicitly documents this caveat (D-014).
-- Slice 003's T018 A5 only counts the audit row; it does NOT assert the
-- new_value JSONB shape. Slice 004's T026 A7 DOES:
--   bool_and(new_value->>'superseded_by' = current_setting('test.new_id'))
-- So we need the audit transition to capture v_new_id directly.
--
-- The chosen pattern: "born-superseded NEW, then resurrect"
-- ---------------------------------------------------------
-- For NEW.id to appear in the trigger-captured new_value->>'superseded_by'
-- on the audit row for the OLD->superseded transition, NEW must already exist
-- as a final_predictions row at the moment the UPDATE OLD statement completes
-- (FK constraint final_predictions_superseded_by_fkey is NOT deferrable).
-- We therefore INSERT NEW FIRST -- but if NEW were inserted as ACTIVE
-- (superseded_at IS NULL), two rows would coexist active for the same
-- (participant_id, item_kind) pair and the partial unique index
-- final_predictions_active_uk would reject the INSERT with 23505.
--
-- Resolution: INSERT NEW as "born superseded" -- i.e. with superseded_at = now()
-- and superseded_by = v_existing_id. This satisfies:
--   * partial unique index (NEW is outside its WHERE clause).
--   * supersede_consistency CHECK ((superseded_at IS NULL) = (superseded_by IS NULL)).
--   * FK superseded_by -> final_predictions(id) (v_existing_id exists).
-- The slot-0043 trigger's INSERT branch requires NEW.superseded_at IS NULL,
-- so this INSERT does NOT fire 'final_prediction.created' automatically.
--
-- Then UPDATE OLD SET superseded_at = now(), superseded_by = v_new_id:
--   * partial unique index: OLD is evicted (superseded_at IS NOT NULL).
--   * CHECK: both columns flip together.
--   * FK: v_new_id row now exists.
--   * Trigger fires the supersede transition with the correct new_value -->
--     A7 GREEN.
--
-- Then UPDATE NEW SET superseded_at = NULL, superseded_by = NULL ("resurrect"):
--   * partial unique index: OLD already evicted, NEW joins -- exactly one
--     active row.
--   * CHECK: both columns are NULL together.
--   * Trigger: TG_OP='UPDATE' with OLD.superseded_at IS NOT NULL and
--     NEW.superseded_at IS NULL matches NEITHER trigger branch -- no audit row.
--
-- Because the trigger does NOT fire on the resurrect-UPDATE for NEW, the SP
-- body MUST manually INSERT the 'final_prediction.created' audit row for NEW
-- to satisfy T026 A6. The manual write uses source='trigger' to match the
-- audit-source convention established by the slot-0043 trigger and to keep
-- audit_log forensic queries uniform regardless of which write path produced
-- the row (the contract makes no distinction).
--
-- Constraint matrix (every statement boundary):
--   step 2 INSERT NEW (born superseded):
--     superseded_at = now(), superseded_by = v_existing_id
--     CHECK: (false)=(false) PASS. unique: NEW excluded. FK: OLD exists. PASS.
--   step 3 UPDATE OLD:
--     superseded_at = now(), superseded_by = v_new_id
--     CHECK: (false)=(false) PASS. unique: OLD evicted, NEW still excluded. PASS.
--     FK: v_new_id row exists from step 2. PASS.
--   step 4 UPDATE NEW (resurrect):
--     superseded_at = NULL, superseded_by = NULL
--     CHECK: (true)=(true) PASS. unique: OLD already evicted, NEW now active --
--     exactly one. PASS.
--
-- Scope discipline (Constitution Principle X):
--   * CREATE OR REPLACE FUNCTION -- atomically swaps the SP body. T016's slot
--     0044 is NOT touched.
--   * All T016 logic preserved (advisory lock, WFP01..WFP06, eligibility,
--     disjoint check, signature).
--   * Permissions block re-issued for idempotence.
--   * No audit_log INSERT for rejection paths (route handler's responsibility,
--     since RAISE EXCEPTION rolls the SP transaction back).

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
  v_existing_id             uuid;
  v_allow_identical         boolean;
  v_existing_champion_team  uuid;
  v_existing_runner_up_team uuid;
  v_new_row                 public.final_predictions%ROWTYPE;
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
  --    2026-05-17 Q1 -- a soft-removed player MUST NOT be a valid target).
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
  --    NO disjoint check between top_scorer and best_player -- those two
  --    items are independent. The check only fires for champion/runner_up.
  --    The lookup filters superseded_at IS NULL so it correctly considers
  --    only the currently-active row in any existing supersede chain.
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

  -- 7. SUPERSEDE / CREATE branch.
  --    Locate any existing active row for (participant, item_kind) and take a
  --    row-level FOR UPDATE lock on it. Combined with the per-pair advisory
  --    lock from step 1 this gives belt-and-braces concurrency correctness:
  --      * advisory lock: serializes concurrent SP invocations for the SAME
  --        pair (only one transaction at a time may reach step 7 for a pair).
  --      * row lock: guards against a stale read in the unlikely event the
  --        advisory lock is bypassed (direct SQL, future refactor).
  --      * unique partial index final_predictions_active_uk (slot 0040):
  --        the DB-level invariant -- at most one row per pair with
  --        superseded_at IS NULL -- backstops both locks.
  SELECT id INTO v_existing_id
    FROM public.final_predictions
   WHERE participant_id = p_participant_id
     AND item_kind      = p_item_kind::public.final_prediction_item_kind
     AND superseded_at IS NULL
   FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    -- ---------------------------------------------------------------
    -- SUPERSEDE PATH: "born-superseded NEW, then resurrect" pattern.
    -- See file header for full rationale + constraint analysis.
    -- ---------------------------------------------------------------
    v_new_id := gen_random_uuid();

    -- 7s.a INSERT NEW as inactive (superseded_at = now(), superseded_by =
    --      v_existing_id). The slot-0043 audit trigger does NOT fire
    --      'final_prediction.created' here because NEW.superseded_at IS NOT
    --      NULL on INSERT. We write that audit row manually at step 7s.d.
    INSERT INTO public.final_predictions (
      id,
      participant_id,
      item_kind,
      target_team_id,
      target_player_id,
      source,
      created_by,
      superseded_at,
      superseded_by
    )
    VALUES (
      v_new_id,
      p_participant_id,
      p_item_kind::public.final_prediction_item_kind,
      p_target_team_id,
      p_target_player_id,
      p_source::public.final_prediction_source,
      p_participant_id,
      now(),
      v_existing_id
    );

    -- 7s.b UPDATE OLD to point at v_new_id and mark as superseded. THIS is
    --      the audit-firing transition: slot-0043 trigger emits
    --      'final_prediction.superseded' with previous_value = OLD row pre-
    --      update and new_value = OLD row post-update (with superseded_by =
    --      v_new_id). T026 A7 GREEN.
    UPDATE public.final_predictions
       SET superseded_at = now(),
           superseded_by = v_new_id
     WHERE id = v_existing_id;

    -- 7s.c "Resurrect" NEW -- restore active state (superseded_at = NULL,
    --      superseded_by = NULL). Partial unique index now contains exactly
    --      one row for this pair (NEW). The audit trigger does NOT fire
    --      here: TG_OP='UPDATE' with OLD.superseded_at IS NOT NULL and
    --      NEW.superseded_at IS NULL matches neither trigger branch.
    UPDATE public.final_predictions
       SET superseded_at = NULL,
           superseded_by = NULL
     WHERE id = v_new_id;

    -- 7s.d Manually emit 'final_prediction.created' for NEW. The trigger
    --      could not emit this because NEW was born superseded (step 7s.a)
    --      and the resurrect-UPDATE (step 7s.c) does not match any trigger
    --      branch. new_value is to_jsonb of NEW's CURRENT (post-resurrect)
    --      state, identical in shape to what the trigger would have written
    --      on a plain INSERT. source='trigger' matches the slot-0043 audit-
    --      source convention so downstream audit consumers (Slice 006 admin
    --      tooling, Slice 007 retention) do not need to special-case which
    --      code path produced the row.
    SELECT * INTO v_new_row FROM public.final_predictions WHERE id = v_new_id;

    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, source
    )
    VALUES (
      COALESCE(v_new_row.created_by, v_new_row.participant_id),
      'final_prediction.created',
      'final_prediction',
      v_new_id,
      NULL,
      to_jsonb(v_new_row),
      'trigger'
    );
  ELSE
    -- ---------------------------------------------------------------
    -- CREATE PATH (no existing active row). Plain INSERT; the slot-0043
    -- trigger emits 'final_prediction.created' automatically.
    -- ---------------------------------------------------------------
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
  END IF;

  RETURN v_new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permissions -- least-privilege. PostgreSQL preserves grants across REPLACE
-- but we re-issue the REVOKE+GRANT to keep the migration idempotent.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.submit_final_prediction(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.submit_final_prediction(uuid, text, uuid, uuid, text) TO authenticated;

-- service_role grant is conditional -- local CI / pgTAP runs may not have the
-- Supabase-managed service_role created. The DO block keeps the migration
-- safely re-runnable across environments.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.submit_final_prediction(uuid, text, uuid, uuid, text) TO service_role';
  END IF;
END $$;

COMMIT;
