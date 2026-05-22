-- Slice 001 / FR-001 / FR-002 / FR-003 / FR-006 / contracts/auth-hook.sql.md / spec Clarifications 2026-05-15 (status enum, email-drift handling -- drift code lives in T040)
--
-- Migration 0009: install the `before_user_created` Supabase Auth hook function
-- `public.handle_auth_user_created(event jsonb) RETURNS jsonb`.
--
-- Wiring: `supabase/config.toml` declares
--   [auth.hook.before_user_created]
--   enabled = true
--   uri     = "pg-functions://postgres/public/handle_auth_user_created"
-- so Supabase Auth invokes this function synchronously inside the auth
-- transaction for every first-time sign-in. The function is the PRIMARY
-- server-side eligibility gate (research § R-002, R-004); it either admits
-- the user (provisioning a participants row + emitting access.granted) or
-- rejects the sign-up (no auth.users row is created, denial is audited).
--
-- Decision matrix (contracts/auth-hook.sql.md § Decision matrix):
--   missing user_id / email      -> reject, audit access.denied / missing_claims
--   domain not on approved list  -> reject, audit access.denied / domain_not_approved
--   approved + first login       -> continue, INSERT participants, audit access.granted
--   approved + same auth_user_id -> continue (idempotent ON CONFLICT path)
--
-- The audit trigger from migration 0008 fires its OWN `participant.created`
-- row with source='trigger' on the participants INSERT; that's the regulatory
-- event. The `access.granted` row this function writes (source='auth_hook')
-- is the auth-decision event. Both rows exist by design and commit together.
--
-- Security model:
--   * SECURITY DEFINER so the function can write `participants` and
--     `audit_log` regardless of the RLS lock-down from T012.
--   * `SET search_path = public, pg_temp` per Supabase SECURITY DEFINER
--     guidance (prevents search_path hijacking).
--   * EXECUTE granted ONLY to `supabase_auth_admin` (the Supabase Auth hook
--     runner identity) and `service_role`. Clients (`authenticated`, `anon`)
--     never call this directly -- the only entry point is the Auth pipeline.
--
-- Scope discipline (Constitution Principle X):
--   * T040 owns `handle_auth_user_signed_in` (returning-login hook + email
--     drift detection). Placeholder comment at the bottom of this file marks
--     its landing site so the file stays a single source for both hooks once
--     T040 ships.

BEGIN;

-- ---------------------------------------------------------------------------
-- handle_auth_user_created(event jsonb) RETURNS jsonb
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_auth_user_created(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Resolve the user identity claims. The Supabase before_user_created event
  -- per contracts/auth-hook.sql.md exposes claims at the top level
  -- (`event->>'user_id'`, `event->'user_metadata'->>'...'`). We also accept
  -- the nested `event->'user'->...` shape so the same function tolerates
  -- variants observed in Supabase Auth releases without re-deploying.
  v_user_id        uuid;
  v_email          text;
  v_display_name   text;
  v_region         text;
  v_participant_id uuid;
  v_metadata       jsonb;
BEGIN
  -- ---- Step 1: extract identity claims from the event payload ----
  v_user_id := COALESCE(
    NULLIF(event ->> 'user_id', ''),
    NULLIF(event -> 'user' ->> 'id', '')
  )::uuid;

  v_metadata := COALESCE(
    event -> 'user_metadata',
    event -> 'user' -> 'user_metadata',
    event -> 'user' -> 'raw_user_meta_data',
    '{}'::jsonb
  );

  v_email := COALESCE(
    NULLIF(v_metadata ->> 'email', ''),
    NULLIF(event ->> 'email', ''),
    NULLIF(event -> 'user' ->> 'email', '')
  );

  -- Display-name fallback ladder: explicit display_name / name / given_name /
  -- preferred_username, finally the email local-part. The test payloads use
  -- `display_name` directly; the broader fallback ladder protects against
  -- thinner IdP claim sets without changing the success path.
  v_display_name := COALESCE(
    NULLIF(v_metadata ->> 'display_name', ''),
    NULLIF(v_metadata ->> 'name', ''),
    NULLIF(v_metadata ->> 'given_name', ''),
    NULLIF(v_metadata ->> 'preferred_username', ''),
    NULLIF(split_part(COALESCE(v_email, ''), '@', 1), '')
  );

  -- Region is optional (FR-003); NULL when absent.
  v_region := NULLIF(v_metadata ->> 'region', '');

  -- ---- Step 2: claim presence check ----
  -- Per contract: user_id OR email missing => deny with reason='missing_claims'.
  -- Display-name is recoverable from the email local-part above; the only
  -- truly fatal absences are the identity (user_id) and the email used by
  -- the eligibility check.
  IF v_user_id IS NULL OR v_email IS NULL OR trim(v_email) = '' THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, reason, source
    ) VALUES (
      NULL, 'access.denied', NULL, NULL,
      NULL, event, 'missing_claims', 'auth_hook'
    );

    RETURN jsonb_build_object(
      'decision', 'reject',
      'message', 'missing required identity claims'
    );
  END IF;

  -- ---- Step 3: eligibility (domain) check ----
  -- is_approved_domain fails closed on missing/unreachable config (R-007), so
  -- the same branch covers both "domain literally not on the list" and
  -- "config unavailable" -- both surface as reason='domain_not_approved'.
  -- The forensic detail (attempted email + user_id) goes into new_value;
  -- actor is NULL because no participants row exists yet to attribute to.
  IF NOT public.is_approved_domain(v_email) THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, reason, source
    ) VALUES (
      NULL, 'access.denied', NULL, NULL,
      NULL,
      jsonb_build_object('user_id', v_user_id, 'email', v_email),
      'domain_not_approved', 'auth_hook'
    );

    RETURN jsonb_build_object(
      'decision', 'reject',
      'message', 'domain not approved'
    );
  END IF;

  -- ---- Step 4: idempotent provisioning ----
  -- ON CONFLICT (auth_user_id) keeps a re-invocation of the hook against the
  -- same sub a no-op INSERT (UPDATE last_login_at only) so the pgTAP
  -- T3.a invariant (exactly one participants row per sub) holds even if the
  -- hook is replayed. The participants_audit_trigger (migration 0008)
  -- emits `participant.created` for the INSERT branch automatically.
  INSERT INTO public.participants (
    auth_user_id, email, display_name, region, status
  ) VALUES (
    v_user_id, v_email, v_display_name, v_region, 'active'
  )
  ON CONFLICT ON CONSTRAINT participants_auth_user_id_uk DO UPDATE
    SET last_login_at = now()
  RETURNING id INTO v_participant_id;

  -- ---- Step 5: write the auth-decision audit row ----
  -- This is the access.granted event (source='auth_hook'). The provisioning
  -- event (`participant.created`, source='trigger') is emitted separately by
  -- the audit trigger; the hook MUST NOT duplicate that row.
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source
  ) VALUES (
    v_participant_id, 'access.granted', 'participant', v_participant_id,
    NULL,
    jsonb_build_object(
      'user_id', v_user_id,
      'email', v_email,
      'display_name', v_display_name,
      'region', v_region,
      'participant_id', v_participant_id
    ),
    NULL, 'auth_hook'
  );

  -- ---- Step 6: continue ----
  RETURN jsonb_build_object('decision', 'continue');
END;
$$;

COMMENT ON FUNCTION public.handle_auth_user_created(jsonb) IS
  'Slice 001 / FR-001, FR-002, FR-003, FR-006: Supabase before_user_created '
  'hook. Invoked via pg-functions://postgres/public/handle_auth_user_created. '
  'Returns {"decision":"continue"} on eligible identities (after provisioning '
  'a participants row) or {"decision":"reject","message":...} on missing '
  'claims / domain not approved. Every invocation writes exactly one '
  'access.granted or access.denied row to public.audit_log.';

-- ---------------------------------------------------------------------------
-- GRANTs
-- ---------------------------------------------------------------------------
-- Revoke the default PUBLIC EXECUTE before issuing narrow grants so only the
-- Supabase Auth hook runner and the service_role can invoke the function.
-- Clients (`authenticated`, `anon`) never call this directly.
REVOKE EXECUTE ON FUNCTION public.handle_auth_user_created(jsonb) FROM PUBLIC;

DO $$
BEGIN
  -- supabase_auth_admin is the role Supabase Auth uses to dispatch hook
  -- functions over pg-functions://. The role is created by the Supabase
  -- platform; guard the GRANT with a role-existence check so this migration
  -- still applies cleanly on local Postgres images where the role may be
  -- absent during early bootstrap.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.handle_auth_user_created(jsonb) TO supabase_auth_admin';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.handle_auth_user_created(jsonb) TO service_role';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- handle_auth_user_signed_in(event jsonb) RETURNS jsonb  (T040)
-- ---------------------------------------------------------------------------
-- Slice 001 / T040 / FR-002 / FR-004 / US3.
-- Bound to [auth.hook.custom_access_token] (D-001). Output shape is custom_access_token (D-005):
--   success: { "claims": {...} }
--   reject:  { "error": { "http_code": 403, "message": "..." } }
-- Implements Clarifications 2026-05-15 Q2 (email-drift = audit only, never mutate stored email)
-- and Q4 (missing optional claim = no signal, never clear stored value).
--
-- Decision matrix (mirrors contracts/auth-hook.sql.md § Decision matrix, mapped
-- onto the custom_access_token envelope per D-005):
--   missing user_id              -> {error:{http_code:400, message:'missing user_id'}} (defensive)
--   no participants row          -> delegate to handle_auth_user_created; on its reject
--                                   surface as {error:{http_code:403, message:<reason>}};
--                                   on continue fall through to refresh/audit
--   status='deactivated'         -> {error:{http_code:403}}, audit access.denied / deactivated
--   stored email not approved    -> {error:{http_code:403}}, audit access.denied / domain_not_approved
--   email drift (lower-cmp)      -> continue; audit participant.email_drift / email_drift_detected
--   refresh whitelist            -> UPDATE display_name, region, last_login_at with COALESCE
--                                   (NULL claim = leave column unchanged per Clarifications Q4)
--   success                      -> {claims: <event->claims unchanged>}, audit access.granted
--
-- The T013 participants_audit_trigger emits participant.updated automatically
-- on the UPDATE branch when any column actually changed -- this function does
-- NOT write that row itself (scope discipline; avoid duplicate audit rows).
CREATE OR REPLACE FUNCTION public.handle_auth_user_signed_in(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id        uuid;
  v_claims         jsonb;
  v_email          text;
  v_display_name   text;
  v_region         text;
  v_participant    public.participants%ROWTYPE;
  v_created_result jsonb;
  v_synth_event    jsonb;
BEGIN
  -- ---- Step 1: extract identity claims from the custom_access_token event ----
  -- custom_access_token shape per D-005:
  --   event->>'user_id'                  -- auth.users.id of the signing-in user
  --   event->'claims'                    -- the JWT claims object (sub, email,
  --                                         role, aal, user_metadata, ...)
  --   event->>'authentication_method'    -- 'oauth' / 'password' / etc.
  BEGIN
    v_user_id := NULLIF(event ->> 'user_id', '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_user_id := NULL;
  END;

  v_claims := COALESCE(event -> 'claims', '{}'::jsonb);

  v_email := COALESCE(
    NULLIF(v_claims ->> 'email', ''),
    NULLIF(v_claims -> 'user_metadata' ->> 'email', '')
  );

  -- Display-name fallback ladder matches T024's so first-login provisioning
  -- (when we delegate to handle_auth_user_created below) and returning-login
  -- refresh resolve display_name from the same precedence.
  v_display_name := COALESCE(
    NULLIF(v_claims -> 'user_metadata' ->> 'display_name', ''),
    NULLIF(v_claims -> 'user_metadata' ->> 'name', ''),
    NULLIF(v_claims -> 'user_metadata' ->> 'given_name', ''),
    NULLIF(v_claims -> 'user_metadata' ->> 'preferred_username', '')
  );

  v_region := NULLIF(v_claims -> 'user_metadata' ->> 'region', '');

  -- ---- Step 1a: defensive guard on missing user_id ----
  -- Custom_access_token MUST carry user_id; if it does not, fail fast with a
  -- 400 envelope rather than letting the participants lookup throw. No audit
  -- row -- there is no identity to attribute the attempt to.
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 400,
        'message',   'missing user_id'
      )
    );
  END IF;

  -- ---- Step 2: lookup participant by auth_user_id ----
  SELECT * INTO v_participant
    FROM public.participants
   WHERE auth_user_id = v_user_id;

  -- ---- Step 3: defensive fall-through to handle_auth_user_created ----
  -- The participant SHOULD exist -- T024 ran on first sign-in. If not (e.g.
  -- the user was provisioned by a Supabase Auth version that did not fire
  -- before_user_created, or pre-existing auth.users rows from a prior
  -- environment), synthesise the before_user_created event shape and call
  -- T024. T024 returns the {decision} envelope, which we translate into the
  -- custom_access_token envelope for the caller.
  IF NOT FOUND THEN
    v_synth_event := jsonb_build_object(
      'user_id', v_user_id::text,
      'user_metadata', jsonb_build_object(
        'email',        v_email,
        'display_name', v_display_name,
        'region',       v_region
      )
    );

    v_created_result := public.handle_auth_user_created(v_synth_event);

    IF v_created_result ->> 'decision' = 'reject' THEN
      RETURN jsonb_build_object(
        'error', jsonb_build_object(
          'http_code', 403,
          'message',   COALESCE(v_created_result ->> 'message', 'denied')
        )
      );
    END IF;

    -- T024 succeeded -- re-fetch the now-existing participants row so the
    -- subsequent deactivated / domain / drift / refresh / audit branches
    -- have a populated v_participant to work against.
    SELECT * INTO v_participant
      FROM public.participants
     WHERE auth_user_id = v_user_id;
  END IF;

  -- ---- Step 4: deactivated check (Clarifications Q3, decision matrix row 4) ----
  -- A deactivated participant is rejected at the gate -- their JWT issuance
  -- is blocked by the custom_access_token reject envelope. Audit attributes
  -- the attempt to the participants.id (we have it; no need to put user_id
  -- in actor).
  IF v_participant.status = 'deactivated' THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, reason, source
    ) VALUES (
      v_participant.id, 'access.denied', 'participant', v_participant.id,
      NULL,
      jsonb_build_object('user_id', v_user_id::text, 'email', v_email),
      'deactivated', 'auth_hook'
    );

    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message',   'This account is currently deactivated.'
      )
    );
  END IF;

  -- ---- Step 5: domain re-check on STORED email (Clarifications Q2) ----
  -- The stored email is the source of truth (account-takeover guard). The
  -- IdP-supplied email may differ -- that is captured as a drift event in
  -- Step 6 but does NOT change the domain decision. is_approved_domain
  -- fails closed on missing config (R-007), so this branch also covers
  -- the "config unavailable" decision-matrix row.
  IF NOT public.is_approved_domain(v_participant.email) THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, reason, source
    ) VALUES (
      v_participant.id, 'access.denied', 'participant', v_participant.id,
      NULL,
      jsonb_build_object(
        'user_id',      v_user_id::text,
        'stored_email', v_participant.email
      ),
      'domain_not_approved', 'auth_hook'
    );

    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message',   'This application is restricted to approved Nortal corporate identities.'
      )
    );
  END IF;

  -- ---- Step 6: email-drift detection (Clarifications Q2, R-010) ----
  -- Lower-cased comparison so casing changes alone do not trip a drift
  -- event. previous_value = stored, new_value = IdP-supplied. The stored
  -- email is NEVER mutated.
  IF v_email IS NOT NULL
     AND lower(v_email) <> lower(v_participant.email) THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, reason, source
    ) VALUES (
      v_participant.id, 'participant.email_drift', 'participant', v_participant.id,
      jsonb_build_object('email', v_participant.email),
      jsonb_build_object('email', v_email),
      'email_drift_detected', 'auth_hook'
    );
  END IF;

  -- ---- Step 7: refresh whitelist (R-010, Clarifications Q4) ----
  -- Whitelist: display_name, region, last_login_at. Missing claim (NULL or
  -- empty after the NULLIF ladder above) leaves the stored column unchanged
  -- -- the COALESCE on the SET side falls back to the existing column value
  -- when the new value is NULL. The T013 audit trigger emits
  -- participant.updated automatically iff any column actually changed
  -- (IS DISTINCT FROM semantics).
  UPDATE public.participants
     SET display_name  = COALESCE(NULLIF(v_display_name, ''), display_name),
         region        = COALESCE(NULLIF(v_region, ''), region),
         last_login_at = now()
   WHERE auth_user_id = v_user_id;

  -- ---- Step 8: access.granted audit row ----
  -- Distinct from the (possible) participant.updated row emitted by the
  -- T013 trigger -- source='auth_hook' vs source='trigger'. new_value
  -- carries the STORED email (the source of truth) so reviewers can
  -- correlate to participants without joining.
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source
  ) VALUES (
    v_participant.id, 'access.granted', 'participant', v_participant.id,
    NULL,
    jsonb_build_object(
      'user_id', v_user_id::text,
      'email',   v_participant.email
    ),
    NULL, 'auth_hook'
  );

  -- ---- Step 9: success -- pass through claims unchanged ----
  -- Per the custom_access_token contract the function MUST return the
  -- claims it wants Supabase Auth to embed in the issued JWT. We pass the
  -- input claims through unchanged in this slice -- Slice 002+ may decide
  -- to inject current_participant_id here, but that is out of scope for
  -- T040.
  RETURN jsonb_build_object('claims', v_claims);
END;
$$;

COMMENT ON FUNCTION public.handle_auth_user_signed_in(jsonb) IS
  'Slice 001 / FR-002, FR-004 / US3: Supabase custom_access_token hook (D-001). '
  'Returns {"claims": ...} on continue, {"error": {"http_code": 403, "message": ...}} '
  'on reject. Refreshes display_name / region / last_login_at on the whitelist '
  '(missing claim = no signal, Clarifications Q4); detects email drift WITHOUT '
  'mutating participants.email (Clarifications Q2). Every invocation writes '
  'exactly one access.granted or access.denied row to public.audit_log.';

-- ---------------------------------------------------------------------------
-- GRANTs for handle_auth_user_signed_in
-- ---------------------------------------------------------------------------
-- Mirrors T024's pattern: revoke PUBLIC, then grant to supabase_auth_admin
-- (the Supabase Auth hook runner identity) and service_role (used by the
-- pgTAP test runner). Each GRANT is guarded by a pg_roles existence check
-- so the migration applies cleanly on bare Postgres images where those
-- Supabase platform roles may not yet exist.
REVOKE EXECUTE ON FUNCTION public.handle_auth_user_signed_in(jsonb) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.handle_auth_user_signed_in(jsonb) TO supabase_auth_admin';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.handle_auth_user_signed_in(jsonb) TO service_role';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- End of slice 001 auth hooks: handle_auth_user_created (T024) +
-- handle_auth_user_signed_in (T040). No further hook functions in this slice.
-- ---------------------------------------------------------------------------

COMMIT;
