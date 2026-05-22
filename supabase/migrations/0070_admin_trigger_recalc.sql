-- Slice 006 / T021 / US2 / contracts/admin-rpcs.write.md § admin_trigger_recalc.
-- Migration slot 0070 per D-026.
-- LOCKED CROSS-SLICE SP signature.
-- Two-step audit-then-run INSERT: audit_log row INSERTed FIRST so its id can populate
-- score_calculation_runs.triggering_audit_log_id (per data-model § score_calculation_runs additive column).
-- pg_net.http_post dispatches to score-trigger Edge Function with X-Internal-Auth header
-- (mirrors slice 005 slot 0059 auto-trigger pattern).
-- Concurrency: synchronous check for in-flight 'running' run for same scope -> raises WAR06.
--
-- ERRCODE table (locked per contracts/admin-rpcs.write.md § ERRCODE values):
--   WAR01 = admin role required (caller is not in admin_roles)
--   WAR02 = reason missing/empty OR invalid scope/target_id shape
--   WAR06 = concurrent admin action (in-flight 'running' run exists for same scope)
--
-- p_source_citation is OPTIONAL for recalc per contract § Pre-flight step 3
-- ("only for override RPCs; recalc + role grant skip").
--
-- Audit-first ordering:
--   The audit_log INSERT comes BEFORE the score_calculation_runs INSERT so that
--   v_audit_id can be captured via RETURNING id and populated into
--   score_calculation_runs.triggering_audit_log_id (slot 0063 / T005 added that
--   nullable FK column). The data-model contract requires this link to be set
--   for admin-triggered runs so a single JOIN answers "which admin override
--   triggered this recalc?"
--
-- pg_net dispatch is best-effort:
--   If app.score_trigger_url or app.score_trigger_secret GUCs are unset, the
--   HTTP call is skipped with a RAISE NOTICE. This keeps `supabase db reset`
--   working in CI / local envs that have not yet provisioned the GUCs. The
--   in-DB run row + audit row are committed regardless. Operators MUST set
--   both GUCs before relying on the admin recalc dispatch path in production.
--   This mirrors slice 005 slot 0059's invoke_score_trigger() defensive posture.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_trigger_recalc(
  p_scope           text,
  p_target_id       uuid,
  p_reason          text,
  p_source_citation text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp, net
AS $$
DECLARE
  v_auth_user_id uuid;
  v_admin_id     uuid;
  v_caller_pid   uuid;
  v_run_id       uuid;
  v_audit_id     uuid;
  v_url          text;
  v_secret       text;
BEGIN
  v_auth_user_id := auth.uid();

  -- -------------------------------------------------------------------------
  -- Step 1: admin authority check (-> WAR01 + access_denied audit).
  -- Audit insert is sub-blocked so any failure (constraint, RLS) does NOT
  -- prevent the WAR01 raise. Source = 'api_guard' to match slot 0073's
  -- narrow RLS INSERT policy + the access-denied pgTAP assertions in the
  -- broader admin RPC family. Mirrors slot 0064 T013 pattern.
  -- -------------------------------------------------------------------------
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
        'score_calculation_run',
        NULL,
        NULL,
        NULL,
        'admin_trigger_recalc called by non-admin',
        'api_guard',
        NULL
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- swallow; WAR01 raise must still fire
    END;

    RAISE EXCEPTION USING
      ERRCODE = 'WAR01',
      MESSAGE = 'admin authority required';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 2: validate scope (-> WAR02).
  -- -------------------------------------------------------------------------
  IF p_scope NOT IN ('all', 'match', 'finals') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR02',
      MESSAGE = format('invalid scope: %s', p_scope);
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 3: validate reason is non-empty (-> WAR02).
  -- score_calculation_runs CHECK score_calculation_runs_reason_required_for_admin_and_config
  -- (slot 0050) ALSO enforces this at the table level for trigger='admin_recalc';
  -- we enforce it here so the WAR02 ERRCODE surfaces with a clean message
  -- before the table-level constraint fires.
  -- -------------------------------------------------------------------------
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR02',
      MESSAGE = 'reason is required';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 4: validate scope/target_id shape (-> WAR02).
  -- Mirrors slot 0050's score_calculation_runs_target_xor_scope CHECK so the
  -- ERRCODE surfaces with a clean WAR02 before the table-level constraint
  -- would fire with a generic 23514.
  -- -------------------------------------------------------------------------
  IF p_scope = 'match' AND p_target_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR02',
      MESSAGE = 'scope=match requires target_id';
  END IF;
  IF p_scope IN ('all', 'finals') AND p_target_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR02',
      MESSAGE = format('scope %s forbids target_id', p_scope);
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 5: synchronous concurrency check (-> WAR06).
  -- Per contract step 7 + FR-008 "only one recalculation per scope at a time":
  -- if an in-flight 'running' run already exists for this scope, raise WAR06
  -- BEFORE creating a second run row. For scope='match', narrow on target_id
  -- so concurrent recalcs on different matches do not block each other.
  -- Note: this is a synchronous check; slice 005's score-trigger Edge Function
  -- still owns the advisory lock + run_id idempotency gate as defence in depth.
  -- -------------------------------------------------------------------------
  IF EXISTS (
    SELECT 1
      FROM public.score_calculation_runs
     WHERE scope  = p_scope::public.score_run_scope
       AND status = 'running'
       AND (p_scope <> 'match' OR target_id = p_target_id)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR06',
      MESSAGE = format('in-flight %s run exists', p_scope);
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 6: resolve admin's participants.id.
  -- is_admin already returned TRUE so this row MUST exist (admin_roles FK
  -- guarantees it via participant_id).
  -- -------------------------------------------------------------------------
  SELECT id INTO v_admin_id
    FROM public.participants
   WHERE auth_user_id = v_auth_user_id;

  v_run_id := gen_random_uuid();

  -- -------------------------------------------------------------------------
  -- Step 7: INSERT audit_log FIRST.
  -- The audit row id is captured via RETURNING so it can populate the run
  -- row's triggering_audit_log_id column (the link asserted by the
  -- admin_trigger_recalc_audit_links_run pgTAP file). Source='admin_rpc'
  -- (admitted by slot 0064's extended audit_log_source_check CHECK).
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source, source_citation
  ) VALUES (
    v_admin_id,
    'admin.recalc_triggered',
    'score_calculation_run',
    v_run_id,
    NULL,
    jsonb_build_object(
      'scope',     p_scope,
      'target_id', p_target_id,
      'run_id',    v_run_id
    ),
    p_reason,
    'admin_rpc',
    p_source_citation
  )
  RETURNING id INTO v_audit_id;

  -- -------------------------------------------------------------------------
  -- Step 8: INSERT score_calculation_runs with triggering_audit_log_id set.
  -- status='running'; trigger='admin_recalc'; triggered_by=v_admin_id.
  -- triggering_audit_log_id links back to the audit row inserted in step 7.
  -- -------------------------------------------------------------------------
  INSERT INTO public.score_calculation_runs (
    id,
    scope,
    target_id,
    "trigger",
    triggered_by,
    status,
    started_at,
    triggering_audit_log_id,
    reason
  ) VALUES (
    v_run_id,
    p_scope::public.score_run_scope,
    p_target_id,
    'admin_recalc'::public.score_run_trigger,
    v_admin_id,
    'running'::public.score_run_status,
    now(),
    v_audit_id,
    p_reason
  );

  -- -------------------------------------------------------------------------
  -- Step 9: best-effort pg_net dispatch to slice 005's score-trigger Edge Fn.
  -- Mirrors slot 0059's invoke_score_trigger() defensive posture: if GUCs are
  -- unset, RAISE NOTICE and skip the HTTP call so the migration suite + CI
  -- runs cleanly without Supabase stack provisioned. The run row + audit row
  -- are already persisted -- the Edge Function will be invoked end-to-end in
  -- environments where the GUCs are set.
  -- -------------------------------------------------------------------------
  v_url    := current_setting('app.score_trigger_url',    true);
  v_secret := current_setting('app.score_trigger_secret', true);

  IF v_url IS NOT NULL AND v_url <> ''
     AND v_secret IS NOT NULL AND v_secret <> '' THEN
    PERFORM net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type',    'application/json',
        'X-Internal-Auth', v_secret
      ),
      body    := jsonb_build_object(
        'scope',        p_scope,
        'target_id',    p_target_id,
        'trigger',      'admin_recalc',
        'run_id',       v_run_id,
        'reason',       p_reason,
        'triggered_by', v_admin_id
      )
    );
  ELSE
    RAISE NOTICE
      'admin_trigger_recalc: app.score_trigger_url / app.score_trigger_secret unset; '
      'HTTP dispatch skipped (run_id=%)',
      v_run_id;
  END IF;

  RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION public.admin_trigger_recalc(text, uuid, text, text) IS
  'Slice 006 / T021 / US2 / FR-008: SECURITY DEFINER admin RPC that initiates a '
  'manual scoring recalculation. Two-step audit-then-run INSERT so '
  'score_calculation_runs.triggering_audit_log_id points at the admin.recalc_triggered '
  'audit row. Synchronous concurrency check raises WAR06 when an in-flight ''running'' '
  'run already exists for the same scope. Dispatches to slice 005''s score-trigger '
  'Edge Function via pg_net.http_post (best-effort: skipped with NOTICE when '
  'app.score_trigger_url / app.score_trigger_secret GUCs are unset). '
  'Signature LOCKED cross-slice per Principle XI.';

-- ---------------------------------------------------------------------------
-- Permissions.
-- The SP is invoked by the /api/admin/recalc route handler running under the
-- admin's JWT (role=authenticated). SECURITY DEFINER gives the SP the privileges
-- to write score_calculation_runs + audit_log + invoke net.http_post; the GRANT
-- EXECUTE here is what lets authenticated callers reach the function at all.
-- PUBLIC is REVOKEd defensively.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.admin_trigger_recalc(
  text, uuid, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_trigger_recalc(
  text, uuid, text, text
) TO authenticated;

COMMIT;
