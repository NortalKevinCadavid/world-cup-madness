-- Slice 003 / T013 / FR-001..008 / contracts/predictions.write.md — LOCKED CROSS-SLICE SP.
-- Signature: submit_prediction(p_participant_id, p_match_id, p_home, p_away, p_source) RETURNS uuid.
-- ERRCODE values WCM01-WCM06 are stable; route handler maps to HTTP status.
-- Slice 006 admin path calls with source='admin_override'.
-- D-012: migration slot 0034 (the spec said 0033; slot 0033 was renumbered for predictions_audit_trigger).
-- D-013 (this task): WCM06 'duplicate active prediction' branch is provisional — T021 (US2) replaces it with the supersede branch per Clarifications 2026-05-16 Q1.
--
-- Scope discipline (Constitution Principle X):
--   * CREATE branch + all rejection branches only. T021 owns the supersede branch.
--   * Per-pair advisory lock serializes concurrent submits for the same (participant, match).
--   * Audit rows for the happy path are emitted by the slot-0033 trigger automatically;
--     this SP body intentionally does NOT INSERT into public.audit_log. Rejection-path
--     audit rows are the route handler's responsibility (T015) because RAISE EXCEPTION
--     rolls the SP transaction back, which would discard any audit insert written here.
--   * SECURITY DEFINER + SET search_path = public, pg_temp (Constitution II).
--   * No service-role usage anywhere; the caller's JWT drives the route handler that
--     invokes this SP. The SECURITY DEFINER privilege is what lets the SP write into
--     predictions despite the table's RLS-locked-down write surface (slot 0032).

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

  -- 7. Existing-active-prediction check (D-013 provisional branch).
  --    Per the contract § Stored procedure semantics step 8 the SP supersedes
  --    an existing active row and inserts a new one in the same transaction.
  --    That logic ships in T021 (US2). For T013 (US1 CREATE only) we raise
  --    WCM06 if an active row already exists. T021 will replace this branch
  --    with the supersede path. See D-013 in specs/003-match-predictions/
  --    tasks.md § Implementation deviations.
  SELECT id INTO v_existing_id
    FROM public.predictions
   WHERE participant_id = p_participant_id
     AND match_id       = p_match_id
     AND superseded_at IS NULL;
  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WCM06',
      MESSAGE = format(
        'active prediction already exists for (participant=%s, match=%s) — supersede branch ships in T021',
        p_participant_id, p_match_id
      );
  END IF;

  -- 8. Insert the new active prediction. The audit trigger on predictions
  --    (slot 0033) automatically emits a 'prediction.created' audit_log row
  --    when superseded_at IS NULL on INSERT — do NOT write that row from
  --    this SP body (would duplicate the audit chain).
  INSERT INTO public.predictions (
    participant_id,
    match_id,
    predicted_home,
    predicted_away,
    source,
    created_by
  )
  VALUES (
    p_participant_id,
    p_match_id,
    p_home,
    p_away,
    p_source::public.prediction_source,
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
