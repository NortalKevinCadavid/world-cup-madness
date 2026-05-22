-- Slice 002 / T029 / FR-011 / contracts/match-results.write.md.
-- CROSS-SLICE LOCKED: signature is part of Slice 006's admin RPC contract;
-- pg_notify channel 'match_results_recorded' is part of Slice 005's score-trigger LISTEN contract.
-- D-007 reconciliation: SP accepts contract param names (home_score_official, _for_scoring,
-- result_status='penalties_shootout') and maps to the DB split-shape from T005 (migration 0021).
-- D-009: audit action 'match_result.recorded'/'match_result.updated' (per T008/migration 0025)
-- not 'match_result.corrected' (per contract). Future Slice 006 may reconcile.
--
-- The SP is the ONLY supported write path into public.match_results outside Slice 006's
-- admin override RPC. It runs SECURITY DEFINER so the sync coordinator (running under
-- service_role with no JWT context) and the future admin RPC (running under the admin's
-- JWT) can both invoke it; RLS on match_results (T009) denies direct INSERT to client
-- roles so the SP is the chokepoint where every invariant from the contract is enforced.
--
-- Body design choices:
--   1. matches.status='finished' precondition is checked before any write so a rejected
--      call leaves match_results untouched and the audit trigger never fires.
--   2. Contract enum 'penalties_shootout' (plural) is mapped to the DB CHECK enum
--      'penalty_shootout' (singular). Both spellings are accepted on input.
--   3. Source values: contract uses 'sync'/'admin_correction'; DB CHECK uses
--      'provider_sync'/'admin_override'. We accept all four spellings on input and
--      normalize to the DB enum before INSERT so the CHECK in 0021 cannot fire.
--   4. for_scoring <= official invariant: rejected with SQLSTATE 22023 (invalid
--      parameter value). Stops the DB-layer match_results_for_scoring_matches CHECK
--      from being the one that fires on bad inputs — clearer error for callers.
--   5. Shootout level invariant: when status is the shootout enum, for_scoring must
--      be level (home == away) because a real shootout happens only after ET ties.
--   6. admin_override: requires p_approved_by IS NOT NULL AND is_admin(p_approved_by).
--      is_admin is Slice 001's stub returning false for everyone; Slice 006 ships the
--      real body. SQLSTATE 42501 (insufficient_privilege) for the admin-check failure.
--   7. Split-column derivation: per D-007 we store home_score = p_home_score_for_scoring
--      and leave extra_time_home_score NULL for non-shootout statuses. The DB CHECK
--      match_results_for_scoring_matches passes because for_scoring = home_score + 0.
--      For 'penalty_shootout' the penalty column carries the official-minus-for_scoring
--      delta. Provider-data ET split (regulation vs ET portion of the for_scoring total)
--      is noise the SP doesn't need to reconstruct.
--   8. UPSERT by match_id: idempotent re-CALL semantics for sync retries + admin
--      corrections. The match_results_audit_trigger (migration 0025) emits
--      'match_result.recorded' on INSERT and 'match_result.updated' on UPDATE.
--   9. pg_notify('match_results_recorded', ...) is the LOCKED channel Slice 005's
--      score trigger LISTENs on. The payload shape is part of the cross-slice contract.

BEGIN;

CREATE OR REPLACE FUNCTION public.record_match_result(
  p_match_id uuid,
  p_home_score_official int,
  p_away_score_official int,
  p_home_score_for_scoring int,
  p_away_score_for_scoring int,
  p_result_status text,
  p_source text,
  p_approved_by uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_db_status text;
  v_db_source text;
  v_match_status public.match_status;
  v_home_regulation int;
  v_away_regulation int;
  v_home_et int;
  v_away_et int;
  v_home_pen int;
  v_away_pen int;
BEGIN
  -- 1. Status precondition: matches.status MUST be 'finished'.
  --    The sync coordinator (R-002) flips status to 'finished' immediately
  --    before invoking the SP inside the same transaction. Admin overrides
  --    (Slice 006) require the match to already be finished.
  SELECT status INTO v_match_status FROM public.matches WHERE id = p_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = format('match %s does not exist', p_match_id);
  END IF;
  IF v_match_status <> 'finished' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = format('match %s not finished (status=%s)', p_match_id, v_match_status);
  END IF;

  -- 2. Map contract enum -> DB enum.
  --    Contract uses plural 'penalties_shootout'; DB CHECK uses singular
  --    'penalty_shootout'. All other enum values are identical between
  --    contract and DB so a CASE-passthrough is sufficient.
  v_db_status := CASE p_result_status
    WHEN 'penalties_shootout' THEN 'penalty_shootout'
    ELSE p_result_status
  END;
  IF v_db_status NOT IN ('regulation','extra_time','penalty_shootout','walkover','no_result') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = format('invalid result_status %s', p_result_status);
  END IF;

  -- 3. Map source: contract 'sync'/'admin_correction' OR DB
  --    'provider_sync'/'admin_override' -> normalized DB enum. Anything
  --    else is rejected before the INSERT so the DB CHECK in 0021 never
  --    fires on this path.
  v_db_source := CASE p_source
    WHEN 'sync' THEN 'provider_sync'
    WHEN 'provider_sync' THEN 'provider_sync'
    WHEN 'admin_correction' THEN 'admin_override'
    WHEN 'admin_override' THEN 'admin_override'
    ELSE NULL
  END;
  IF v_db_source IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = format('invalid source %s', p_source);
  END IF;

  -- 4. for_scoring <= official invariant. The scoring engine (Slice 005)
  --    consumes _for_scoring exclusively; a for_scoring total exceeding the
  --    official total would inflate prediction-points relative to the real
  --    result. Reject before INSERT so the DB-layer CHECK is not the one
  --    that fires.
  IF p_home_score_for_scoring > p_home_score_official
     OR p_away_score_for_scoring > p_away_score_official THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'for_scoring exceeds official score (forbidden by contract)';
  END IF;

  -- 5. Shootout level invariant. When the result is decided by a penalty
  --    shoot-out, the for_scoring totals (regulation + ET) MUST be level
  --    because a shootout only happens after ET ties.
  IF v_db_status = 'penalty_shootout'
     AND p_home_score_for_scoring <> p_away_score_for_scoring THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'penalties_shootout requires level for_scoring (regulation+ET must tie before penalties)';
  END IF;

  -- 6. Admin-source invariants: admin_override REQUIRES a non-NULL
  --    p_approved_by AND that participant MUST be admin. Defense-in-depth:
  --    the Slice 006 admin RPC wrapper will also check, but the SP enforces
  --    so direct invocations (sync coordinator, future migration scripts)
  --    cannot bypass.
  IF v_db_source = 'admin_override' THEN
    IF p_approved_by IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'admin_override requires p_approved_by';
    END IF;
    IF NOT public.is_admin(p_approved_by) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = format('p_approved_by %s is not admin', p_approved_by);
    END IF;
  END IF;

  -- 7. Derive split columns from contract args (per D-007 simplification).
  --    Store home_score := p_home_score_for_scoring and leave ET split NULL
  --    for non-shootout statuses; the DB CHECK match_results_for_scoring_matches
  --    passes because for_scoring = home_score + COALESCE(et, 0) = home_score + 0.
  --    For 'penalty_shootout' the penalty column carries official - for_scoring.
  v_home_regulation := p_home_score_for_scoring;
  v_away_regulation := p_away_score_for_scoring;
  v_home_et := NULL;
  v_away_et := NULL;
  IF v_db_status = 'penalty_shootout' THEN
    v_home_pen := p_home_score_official - p_home_score_for_scoring;
    v_away_pen := p_away_score_official - p_away_score_for_scoring;
  ELSE
    v_home_pen := NULL;
    v_away_pen := NULL;
  END IF;

  -- 8. UPSERT by match_id. INSERT path fires the match_results_audit_trigger
  --    with TG_OP='INSERT' -> action='match_result.recorded'. UPDATE path
  --    fires with TG_OP='UPDATE' -> action='match_result.updated' (D-009:
  --    contract spelling is 'match_result.corrected'; slice 002 ships the
  --    'updated' spelling per the as-built migration 0025 trigger).
  INSERT INTO public.match_results (
    match_id,
    home_score,
    away_score,
    extra_time_home_score,
    extra_time_away_score,
    penalty_home_score,
    penalty_away_score,
    home_score_for_scoring,
    away_score_for_scoring,
    result_status,
    source,
    recorded_by
  )
  VALUES (
    p_match_id,
    v_home_regulation,
    v_away_regulation,
    v_home_et,
    v_away_et,
    v_home_pen,
    v_away_pen,
    p_home_score_for_scoring,
    p_away_score_for_scoring,
    v_db_status,
    v_db_source,
    p_approved_by
  )
  ON CONFLICT (match_id) DO UPDATE SET
    home_score             = EXCLUDED.home_score,
    away_score             = EXCLUDED.away_score,
    extra_time_home_score  = EXCLUDED.extra_time_home_score,
    extra_time_away_score  = EXCLUDED.extra_time_away_score,
    penalty_home_score     = EXCLUDED.penalty_home_score,
    penalty_away_score     = EXCLUDED.penalty_away_score,
    home_score_for_scoring = EXCLUDED.home_score_for_scoring,
    away_score_for_scoring = EXCLUDED.away_score_for_scoring,
    result_status          = EXCLUDED.result_status,
    source                 = EXCLUDED.source,
    recorded_by            = EXCLUDED.recorded_by,
    recorded_at            = now();

  -- 9. Notify the Slice 005 score-trigger LISTEN consumer. LOCKED channel
  --    name 'match_results_recorded'. Payload shape is part of the
  --    cross-slice contract — do not reshape without coordinated update.
  PERFORM pg_notify(
    'match_results_recorded',
    json_build_object(
      'match_id', p_match_id,
      'source', v_db_source,
      'result_status', v_db_status
    )::text
  );

  RETURN p_match_id;
END;
$$;

COMMENT ON FUNCTION public.record_match_result(
  uuid, int, int, int, int, text, text, uuid
) IS
  'Slice 002 / T029 / FR-011: SECURITY DEFINER write path for public.match_results. '
  'Accepts contract parameter names (D-007) and maps to the DB split-shape from migration 0021. '
  'Enforces 8 invariants before INSERT/UPDATE: match exists, match.status=''finished'', valid '
  'result_status enum, valid source enum, for_scoring <= official, shootout level-check, '
  'admin_override requires non-NULL approver, admin_override approver must be is_admin(). '
  'UPSERT by match_id; audit row emitted by match_results_audit_trigger (migration 0025). '
  'pg_notify channel ''match_results_recorded'' is LOCKED for Slice 005 score-trigger LISTEN.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- The SP is invoked by:
--   * supabase_auth_admin -- not actually a caller in this slice, but granted
--                            for parity with slice 001's T024/T040 pattern in
--                            case future Auth hooks need to invoke directly.
--   * service_role        -- the sync coordinator Edge Function (T032) runs
--                            under service_role and calls the SP per match.
-- Each grant is wrapped in a pg_roles existence check so the migration applies
-- cleanly on bare Postgres images where the Supabase platform roles may be
-- absent during early bootstrap (mirrors slice 001 T024).
REVOKE EXECUTE ON FUNCTION public.record_match_result(
  uuid, int, int, int, int, text, text, uuid
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.record_match_result(uuid, int, int, int, int, text, text, uuid) TO supabase_auth_admin';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.record_match_result(uuid, int, int, int, int, text, text, uuid) TO service_role';
  END IF;
END;
$$;

COMMIT;
