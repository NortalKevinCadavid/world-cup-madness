-- Slice 003 / T021 / FR-002 (one active per pair) + FR-003 (updatable before lock).
-- Replaces D-013's provisional WCM06 (duplicate-active) branch in T013 with the supersede
-- UPDATE+INSERT pattern per contracts/predictions.write.md § SP semantics step 7.
-- Three-layer concurrency correctness:
--   1. pg_advisory_xact_lock per (participant, match) pair (step 1) — serializes concurrent attempts.
--   2. SELECT ... FOR UPDATE row lock on existing active row (step 7a) — guards against
--      a stale read before the supersede UPDATE.
--   3. UNIQUE INDEX predictions_active_uk (slot 0030) — DB-level guarantee of exactly one active row.
-- Migration slot 0037 per D-012 + this task's note (spec said 0036; slot 0036 was renumbered for
-- kickoff_correction_audit_trigger).
-- WCM06 ERRCODE is RETIRED — the SP no longer raises it; tests T018 + T019 expect supersede success.

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_prediction(
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
  -- 1. Per-pair advisory transaction lock. Concurrent submits for the SAME
  --    (participant, match) pair serialize through this lock; different pairs
  --    proceed in parallel. The hashtext() input combines both ids so the
  --    lock key is unique per pair. Lock auto-releases at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_participant_id::text || ':' || p_match_id::text)
  );

  -- 2. Validate source enum membership. We accept the three documented
  --    channels; anything else is a programmer error (route handler should
  --    only ever pass 'ui'/'api'; Slice 006 admin RPC passes 'admin_override').
  IF p_source NOT IN ('ui', 'api', 'admin_override') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WCM03',
      MESSAGE = format('invalid source %s', p_source);
  END IF;

  -- 3. Validate score range. The upper bound is config-driven (Principle VIII):
  --    tournament_config.score_upper_bound (slot 0035 default = 20). If the
  --    key is missing for any reason, fall back to 20 — the table-level
  --    CHECK (predicted_home >= 0) is still a structural floor.
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

  -- 4. Look up participant + check eligibility (defense-in-depth — the route
  --    handler already called requireEligible() but the SP MUST NOT trust it).
  --    Ordering note: eligibility precedes match-existence because the
  --    ineligible pgTAP test (T010) asserts WCM05 for a deactivated participant
  --    against a VALID match — the eligibility branch must fire first.
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

  -- 5. Validate match existence. NULL match_status means the match row does
  --    not exist (matches.status is NOT NULL). Note: is_prediction_locked()
  --    fail-closes on unknown matches by returning TRUE, but the spec requires
  --    WCM04 (not WCM01/02) for the unknown-match branch, so we check here
  --    first.
  SELECT status INTO v_match_status
    FROM public.matches
   WHERE id = p_match_id;
  IF v_match_status IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WCM04',
      MESSAGE = format('match %s not found', p_match_id);
  END IF;

  -- 6. Lock check. The single named predicate is_prediction_locked() (slot
  --    0031) is the only place that combines status-based and time-based
  --    locking — Principle III. We branch on the underlying reason to pick
  --    the correct ERRCODE:
  --      * non-scheduled status      → WCM02 (match_status_locked)
  --      * lock window crossed       → WCM01 (lock_window_passed)
  IF public.is_prediction_locked(p_match_id) THEN
    IF v_match_status <> 'scheduled' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'WCM02',
        MESSAGE = format(
          'match %s status=%s — predictions locked',
          p_match_id, v_match_status
        );
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = 'WCM01',
        MESSAGE = format('match %s within lock window', p_match_id);
    END IF;
  END IF;

  -- 7. SUPERSEDE BRANCH (replaces D-013's provisional WCM06 from T013).
  --    Implements contracts/predictions.write.md § SP semantics step 7 +
  --    research.md § R-002 (chain) + § R-003 (SP body) + § R-004 (concurrency).
  --
  --    a. Pre-generate the new uuid via gen_random_uuid() so we can reference
  --       it from the supersede UPDATE BEFORE the INSERT lands. This is
  --       required because the partial UNIQUE INDEX predictions_active_uk
  --       (slot 0030) on (participant_id, match_id) WHERE superseded_at IS NULL
  --       is checked at INSERT time — so if the OLD row still has
  --       superseded_at IS NULL when the NEW row is INSERTed, the unique
  --       check fails. We avoid that by superseding the OLD row FIRST.
  v_new_id := gen_random_uuid();

  --    b. Find any existing active row for (participant, match) and take a
  --       row-level FOR UPDATE lock on it. Combined with the per-pair
  --       advisory lock from step 1, this gives belt-and-braces concurrency
  --       correctness:
  --         * advisory lock: serializes concurrent SP invocations for the
  --           SAME pair (only one transaction can be in step 7 at a time).
  --         * row lock: guards against a stale read in the unlikely event
  --           the advisory lock is bypassed (direct SQL, future refactor).
  --         * unique partial index predictions_active_uk (slot 0030):
  --           the DB-level invariant — at most one row per pair with
  --           superseded_at IS NULL — backstops both locks.
  SELECT id INTO v_existing_id
    FROM public.predictions
   WHERE participant_id = p_participant_id
     AND match_id       = p_match_id
     AND superseded_at IS NULL
   FOR UPDATE;

  --    c. SUPERSEDE-THEN-INSERT pattern with self-reference placeholder
  --       (D-014). Why this specific ordering:
  --
  --       Constraint A: partial UNIQUE INDEX predictions_active_uk (slot 0030)
  --         on (participant_id, match_id) WHERE superseded_at IS NULL — NOT
  --         deferrable (indexes never are). Checked at INSERT statement end.
  --         → We MUST supersede OLD before INSERTing NEW, or 2 active rows
  --         coexist briefly and the unique check fails.
  --
  --       Constraint B: FK predictions_superseded_by_fkey on superseded_by →
  --         predictions(id) — NOT declared DEFERRABLE in slot 0030. Checked
  --         at UPDATE statement end.
  --         → A naive "UPDATE OLD setting superseded_by = v_new_id" before
  --         INSERTing v_new_id fails the FK check at the UPDATE statement
  --         boundary.
  --
  --       Constraint C: table CHECK predictions_supersede_consistency
  --         requiring (superseded_at IS NULL) = (superseded_by IS NULL) —
  --         both columns MUST flip together.
  --
  --       Workable resolution: UPDATE OLD with superseded_by = v_existing_id
  --       (SELF-REFERENCE — OLD points at itself momentarily). All three
  --       constraints satisfied:
  --         A: OLD now has superseded_at IS NOT NULL → leaves partial index
  --            → INSERT v_new_id can land without unique violation.
  --         B: superseded_by = v_existing_id refers to OLD's own row, which
  --            already exists → FK check passes.
  --         C: both superseded_at and superseded_by are non-NULL → CHECK ok.
  --       Then INSERT NEW (now no active row competes). Then fix OLD's
  --       superseded_by from the self-reference to v_new_id. The slot-0033
  --       audit trigger emits 'prediction.superseded' on the FIRST UPDATE
  --       (the supersede transition); the SECOND UPDATE has OLD.superseded_at
  --       IS NOT NULL already, so the trigger's supersede-branch guard does
  --       NOT match → no duplicate audit row.
  --
  --       ⚠ Audit-row caveat (D-014): the 'prediction.superseded' audit row's
  --       new_value->>'superseded_by' carries the self-reference placeholder
  --       (= OLD.id), NOT the final v_new_id. The predictions table's final
  --       state is correct (OLD.superseded_by = v_new_id after step c.3).
  --       T018's audit-format test asserts new_value->>'superseded_at' IS NOT
  --       NULL — that holds. The direct DB assertion on
  --       OLD.superseded_by = NEW.id also holds (queried after the SP
  --       completes, post-step-c.3). Future Slice 007 audit forensics
  --       readers should reconstruct supersede_by from
  --       predictions.superseded_by (current state), not from audit_log
  --       new_value.
  IF v_existing_id IS NOT NULL THEN
    -- c.1: Self-reference placeholder. Audit trigger emits prediction.superseded.
    UPDATE public.predictions
       SET superseded_at = now(),
           superseded_by = v_existing_id
     WHERE id = v_existing_id;

    -- c.2: INSERT new active row. Audit trigger emits prediction.created.
    INSERT INTO public.predictions (
      id, participant_id, match_id,
      predicted_home, predicted_away,
      source, created_by
    ) VALUES (
      v_new_id, p_participant_id, p_match_id,
      p_home, p_away,
      p_source::public.prediction_source, p_participant_id
    );

    -- c.3: Fix the placeholder. Audit trigger does NOT emit (OLD.superseded_at
    -- is already non-NULL, so the trigger's supersede-transition guard
    -- "OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL" is false).
    UPDATE public.predictions
       SET superseded_by = v_new_id
     WHERE id = v_existing_id;
  ELSE
    -- Fresh prediction (no existing active row). Plain INSERT — the trigger
    -- emits 'prediction.created'.
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

  --    d. Return the new prediction id. The audit trigger (slot 0033) has
  --       written 'prediction.created' on the INSERT and, when v_existing_id
  --       was non-NULL, 'prediction.superseded' on the UPDATE — both in the
  --       same transaction (Constitution Principle V: same-transaction audit).
  RETURN v_new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permissions — least-privilege (re-grant after CREATE OR REPLACE as a
-- safety belt; PostgreSQL preserves grants across REPLACE but we re-issue
-- the REVOKE+GRANT to keep the migration idempotent).
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.submit_prediction(uuid, uuid, int, int, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.submit_prediction(uuid, uuid, int, int, text) TO authenticated;

-- service_role grant is conditional — local CI / pgTAP runs may not have the
-- Supabase-managed service_role created. The DO block makes the migration
-- safely re-runnable across environments.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.submit_prediction(uuid, uuid, int, int, text) TO service_role';
  END IF;
END $$;

COMMIT;
