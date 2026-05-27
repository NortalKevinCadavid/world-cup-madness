-- ============================================================================
-- 0090_submit_bracket_rpc.sql  — Slice 010 / T027 (US3)
-- ============================================================================
-- public.submit_bracket(p_run_token uuid) — SECURITY DEFINER, the SOLE writer
-- of bracket_submissions. Single-transaction submit per
-- contracts/bracket.submit.write.md + research R-003:
--   1. resolve caller → participant; reject if ineligible (WCB05)
--   2. lock from tournament_config.first_kickoff_utc (server time, Principle VI);
--      now() >= lock → WCB03 BRACKET_LOCKED
--   3. idempotent on run_token (mirror slice-005 scoring run_id idempotency):
--      a repeat with the same token returns the recorded result, no 2nd audit
--   4. server-side completeness recompute — first purge any now-impossible
--      picks via bracket_clear_invalid_picks (defeats stale client state),
--      then require all 31 matchups picked; else WCB04 BRACKET_INCOMPLETE
--      (missing count in DETAIL)
--   5. upsert bracket_submissions → submitted, bump version
--   6. one audit_log row (action='bracket.submitted') in the SAME transaction
--      (Principle V) — function owner is postgres (superuser) so RLS/FORCE on
--      audit_log is bypassed, exactly as the slice-006 admin RPCs rely on.
--
-- ERRCODE → HTTP mapping is owned by the route (T028):
--   WCB03 → 409 BRACKET_LOCKED   WCB04 → 422 BRACKET_INCOMPLETE   WCB05 → 403
-- ============================================================================

BEGIN;

-- Idempotency token store. The submit RPC is the only writer of this table, so
-- adding the column here (rather than in 0086) keeps the submit contract
-- self-contained.
ALTER TABLE public.bracket_submissions
  ADD COLUMN IF NOT EXISTS last_run_token uuid;

CREATE OR REPLACE FUNCTION public.submit_bracket(p_run_token uuid)
RETURNS TABLE (
  submission_status text,
  submitted_at      timestamptz,
  version           int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth         uuid;
  v_pid          uuid;
  v_lock         timestamptz;
  v_total        int;
  v_completed    int;
  v_missing      int;
  v_existing     public.bracket_submissions;
  v_version      int;
  v_submitted_at timestamptz;
BEGIN
  IF p_run_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'WCB02', MESSAGE = 'run_token is required';
  END IF;

  -- 1. Eligibility (defence-in-depth; the route already ran requireEligible).
  v_auth := auth.uid();
  IF v_auth IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'WCB05', MESSAGE = 'unauthenticated';
  END IF;

  SELECT id INTO v_pid
    FROM public.participants
   WHERE auth_user_id = v_auth;

  IF v_pid IS NULL OR NOT public.is_eligible_nortal_participant(v_auth) THEN
    RAISE EXCEPTION USING ERRCODE = 'WCB05', MESSAGE = 'participant not eligible';
  END IF;

  -- Serialize concurrent submits for the same participant.
  PERFORM pg_advisory_xact_lock(hashtext('submit_bracket:' || v_pid::text));

  -- Idempotency: a repeat with the same run_token returns the recorded result
  -- without re-running completeness or emitting a second audit row.
  SELECT * INTO v_existing
    FROM public.bracket_submissions
   WHERE participant_id = v_pid;

  IF v_existing.participant_id IS NOT NULL
     AND v_existing.last_run_token IS NOT DISTINCT FROM p_run_token THEN
    submission_status := v_existing.submission_status::text;
    submitted_at      := v_existing.submitted_at;
    version           := v_existing.version;
    RETURN NEXT;
    RETURN;
  END IF;

  -- 2. Lock check (server/DB time — client clock is never authoritative).
  SELECT (value #>> '{}')::timestamptz INTO v_lock
    FROM public.tournament_config
   WHERE key = 'first_kickoff_utc';

  IF v_lock IS NOT NULL AND now() >= v_lock THEN
    RAISE EXCEPTION USING ERRCODE = 'WCB03', MESSAGE = 'bracket is locked';
  END IF;

  -- 3. Server-authoritative completeness. Purge any picks made impossible by a
  --    later upstream change FIRST (stale-client defence — a client that thinks
  --    it is complete but holds a cleared pick falls below 31 here), then count.
  PERFORM public.bracket_clear_invalid_picks(v_pid);

  SELECT count(*) INTO v_total FROM public.bracket_matchups;

  SELECT count(*) INTO v_completed
    FROM public.bracket_picks
   WHERE participant_id = v_pid;

  IF v_completed < v_total THEN
    v_missing := v_total - v_completed;
    RAISE EXCEPTION USING
      ERRCODE = 'WCB04',
      MESSAGE = format('bracket incomplete: %s of %s picks', v_completed, v_total),
      DETAIL  = v_missing::text;
  END IF;

  -- 4. Upsert submission → submitted; bump version on re-submit (FR-028).
  v_version      := COALESCE(v_existing.version, 0) + 1;
  v_submitted_at := now();

  INSERT INTO public.bracket_submissions (
    participant_id, submission_status, submitted_at, version, last_run_token, updated_at
  ) VALUES (
    v_pid, 'submitted', v_submitted_at, v_version, p_run_token, now()
  )
  ON CONFLICT (participant_id) DO UPDATE
    SET submission_status = 'submitted',
        submitted_at      = excluded.submitted_at,
        version           = excluded.version,
        last_run_token    = excluded.last_run_token,
        updated_at        = now();

  -- 5. Audit in-transaction (Principle V). Owner=postgres bypasses audit_log RLS.
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source, source_citation
  ) VALUES (
    v_pid,
    'bracket.submitted',
    'bracket',
    v_pid,
    CASE WHEN v_existing.participant_id IS NOT NULL
         THEN jsonb_build_object('version', v_existing.version)
         ELSE NULL END,
    jsonb_build_object('version', v_version, 'submitted_at', v_submitted_at),
    NULL,
    'api_guard',
    NULL
  );

  submission_status := 'submitted';
  submitted_at      := v_submitted_at;
  version           := v_version;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.submit_bracket(uuid) IS
  'Slice 010 / T027 / FR-012,FR-013,FR-028. Sole writer of bracket_submissions. '
  'Server-recompute completeness (31/31, cascade-purged first), lock-gated on '
  'first_kickoff_utc, idempotent on run_token, one bracket.submitted audit row '
  'in-transaction. See contracts/bracket.submit.write.md.';

REVOKE EXECUTE ON FUNCTION public.submit_bracket(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_bracket(uuid) TO authenticated;

COMMIT;
