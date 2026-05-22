-- Slice 006 / T030 / US3 / contracts/admin-rpcs.write.md § admin_update_match.
-- Migration slot 0065 per D-026 (spec slot 0052 collides with prior shipped 0052_score_match_fn.sql).
-- LOCKED CROSS-SLICE SP signature per Principle XI.
-- Updates matches.status and/or matches.kickoff_utc; both args nullable for partial update.
-- Slice 003's kickoff-correction trigger (slot 0036, AFTER UPDATE OF kickoff_utc) AND
-- slice 004's first_kickoff_correction trigger (slot 0046, AFTER UPDATE OF kickoff_utc, status)
-- fire automatically from the single UPDATE the SP issues. Their WHEN clauses gate fan-out:
--   * slice 003 only fires when kickoff_utc changed (OLD.kickoff_utc IS DISTINCT FROM NEW).
--   * slice 004 fires when EITHER kickoff_utc OR status changed.
-- No-op (both args NULL OR effective values unchanged from current) raises WAR07.
-- Audit emission: admin.match_updated with previous/new state as to_jsonb(matches row).
--
-- audit_log.source CHECK was already extended to admit 'admin_rpc' by slot 0064 (T013).
-- This SP reuses that additive extension; no further CHECK relaxation needed.
--
-- ERRCODE table (per contracts/admin-rpcs.write.md):
--   WAR01  not admin                       (admin.access_denied audit + raise)
--   WAR02  reason missing/empty
--   WAR03  source_citation missing/empty
--   WAR04  match row not found
--   WAR07  no-op (status + kickoff both NULL or both equal to current)
-- (WAR05 reserved for invariant violations from underlying SP delegations; this SP issues
--  a direct UPDATE rather than delegating, so WAR05 is N/A here. Enum-cast violations on
--  p_new_status surface as Postgres native 22P02 / 22023 invalid_text_representation —
--  no explicit whitelist per brief.)

BEGIN;

-- ---------------------------------------------------------------------------
-- admin_update_match SP.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_match(
  p_match_id        uuid,
  p_new_status      text,
  p_new_kickoff_utc timestamptz,
  p_reason          text,
  p_source_citation text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth_user_id      uuid;
  v_admin_id          uuid;
  v_caller_pid        uuid;
  v_old               jsonb;
  v_new               jsonb;
  v_old_status        text;
  v_old_kickoff       timestamptz;
  v_effective_status  text;
  v_effective_kickoff timestamptz;
BEGIN
  -- -------------------------------------------------------------------------
  -- Step 1: admin authority check (+ access_denied audit on failure).
  -- The access-denied INSERT runs in a sub-block so any failure (constraint,
  -- RLS for non-SECURITY-DEFINER reinvocation) does NOT prevent the WAR01
  -- raise. SP runs SECURITY DEFINER so RLS is bypassed; sub-block is
  -- defence-in-depth.
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
        'match',
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
  -- Step 2: reason validation.
  -- -------------------------------------------------------------------------
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR02',
      MESSAGE = 'reason missing or empty';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 3: source_citation validation.
  -- -------------------------------------------------------------------------
  IF p_source_citation IS NULL OR length(trim(p_source_citation)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR03',
      MESSAGE = 'source citation missing or empty';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 4: resolve admin's participants.id.
  -- is_admin already returned TRUE so this row MUST exist (admin_roles FK
  -- guarantees it via participant_id).
  -- -------------------------------------------------------------------------
  SELECT id INTO v_admin_id
    FROM public.participants
   WHERE auth_user_id = v_auth_user_id;

  -- -------------------------------------------------------------------------
  -- Step 5: per-match advisory lock. Serializes concurrent admin updates on
  -- the same match. Different matches lock independently.
  -- -------------------------------------------------------------------------
  PERFORM pg_advisory_xact_lock(
    hashtext('admin_update_match:' || p_match_id::text)
  );

  -- -------------------------------------------------------------------------
  -- Step 6: capture current matches row state + scalar columns needed for
  -- the no-op / COALESCE logic below.
  -- -------------------------------------------------------------------------
  SELECT to_jsonb(m.*), m.status::text, m.kickoff_utc
    INTO v_old, v_old_status, v_old_kickoff
    FROM public.matches m
   WHERE m.id = p_match_id;

  IF v_old IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('match %s not found', p_match_id);
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 7: compute effective new values via COALESCE (NULL = no change)
  -- and detect no-op. WAR07 fires when:
  --   * both args are NULL, OR
  --   * args are non-NULL but match the current row values verbatim.
  -- IS NOT DISTINCT FROM handles the NULL-safe comparison uniformly.
  -- -------------------------------------------------------------------------
  v_effective_status  := COALESCE(p_new_status, v_old_status);
  v_effective_kickoff := COALESCE(p_new_kickoff_utc, v_old_kickoff);

  IF v_effective_status  IS NOT DISTINCT FROM v_old_status
     AND v_effective_kickoff IS NOT DISTINCT FROM v_old_kickoff THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR07',
      MESSAGE = 'no changes specified (status and kickoff both NULL or unchanged)';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 8: apply the UPDATE.
  -- Cross-slice trigger fire-through (locked behaviour):
  --   * slice 003 slot 0036 log_kickoff_correction_crossed_lock — AFTER
  --     UPDATE OF kickoff_utc WHEN OLD.kickoff_utc IS DISTINCT FROM NEW.
  --     Fan-out: one prediction.kickoff_correction_crossed_lock audit row
  --     per active prediction (predictions.match_id = NEW.id AND
  --     superseded_at IS NULL).
  --   * slice 004 slot 0046 log_first_kickoff_correction_update — AFTER
  --     UPDATE OF kickoff_utc, status WHEN either changed. Conservative
  --     fan-out: one final_prediction.first_kickoff_correction audit row
  --     per active final_prediction tournament-wide.
  -- The enum cast on v_effective_status surfaces invalid status values as
  -- Postgres-native 22P02 / 22023 (no separate whitelist per brief).
  -- -------------------------------------------------------------------------
  UPDATE public.matches
     SET status      = v_effective_status::public.match_status,
         kickoff_utc = v_effective_kickoff
   WHERE id = p_match_id;

  -- -------------------------------------------------------------------------
  -- Step 9: capture post-UPDATE matches row state.
  -- -------------------------------------------------------------------------
  SELECT to_jsonb(m.*) INTO v_new
    FROM public.matches m
   WHERE m.id = p_match_id;

  -- -------------------------------------------------------------------------
  -- Step 10: emit admin.match_updated audit row (locked shape per
  -- contracts/admin-rpcs.write.md § Audit emission).
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source, source_citation
  ) VALUES (
    v_admin_id,
    'admin.match_updated',
    'match',
    p_match_id,
    v_old,
    v_new,
    p_reason,
    'admin_rpc',
    p_source_citation
  );
END;
$$;

COMMENT ON FUNCTION public.admin_update_match(uuid, text, timestamptz, text, text) IS
  'Slice 006 / T030 / US3: SECURITY DEFINER admin RPC that updates matches.status '
  'and/or matches.kickoff_utc. Both p_new_status and p_new_kickoff_utc are nullable; '
  'NULL means "no change to that column". Pre-flight: is_admin (->WAR01 + audit) + '
  'reason (->WAR02) + source_citation (->WAR03). Body: per-match advisory lock + '
  'capture old/new state + UPDATE via COALESCE + audit admin.match_updated with '
  'source=''admin_rpc''. Match-not-found -> WAR04. No-op (both args NULL or equal '
  'to current) -> WAR07. Slice 003 slot 0036 kickoff-correction fan-out trigger and '
  'slice 004 slot 0046 first_kickoff_correction trigger fire automatically from the '
  'UPDATE based on their WHEN clauses. Signature LOCKED cross-slice per Principle XI.';

-- ---------------------------------------------------------------------------
-- Permissions.
-- The SP is invoked by the /api/admin/match route handler running under the
-- admin's JWT (role=authenticated). SECURITY DEFINER gives the SP the privs
-- to write to matches + audit_log; the GRANT EXECUTE here is what lets
-- authenticated callers reach the function at all. PUBLIC is REVOKEd
-- defensively (it isn't granted by default but the REVOKE makes the posture
-- explicit, matching slot 0064's pattern).
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.admin_update_match(uuid, text, timestamptz, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_update_match(uuid, text, timestamptz, text, text) TO authenticated;

COMMIT;
