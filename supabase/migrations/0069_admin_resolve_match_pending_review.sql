-- Slice 006 / T038 / Phase 7 / contracts/admin-rpcs.write.md § admin_resolve_match_pending_review.
-- Migration slot 0069 per D-026 (spec slot 0056 collides with prior shipped 0056_score_rls.sql).
-- LOCKED CROSS-SLICE SP signature per Principle XI.
--
-- Resolves a quarantined sync conflict in public.match_pending_review (slice 002
-- slot 0023). Three resolution paths per contracts/admin-rpcs.write.md § Behavior:
--   * accept_provider  : apply proposed_payload values to matches via
--                        admin_update_match (same transaction).
--   * reject_provider  : do not modify matches; mark the review resolved.
--   * manual_override  : do nothing to matches (admin called admin_update_match
--                        separately beforehand); mark the review resolved.
--
-- After branch execution, UPDATE match_pending_review setting:
--   reviewed_at? -- the table uses resolved_at/resolved_by/notes/resolution.
--   resolution    = p_resolution
--   resolved_at   = now()
--   resolved_by   = v_admin_participant_id
--   notes         = p_reason
-- (resolution_notes is NOT a column in slice 002's table; notes is. The contract
-- step 5 mentions resolution_notes; we use the actual column name `notes`.)
--
-- accept_provider proposed_payload jsonb shape: provider-specific. We probe for
-- two well-known keys -- `status` and `kickoff_utc` -- and pass them through to
-- admin_update_match. Unknown keys are ignored at this slice; future provider
-- shapes can be added additively. If neither key is present, accept_provider is
-- a no-op against matches (still flips the review row).
--
-- audit_log.source CHECK already admits 'admin_rpc' (slot 0064 T013).
--
-- ERRCODE mapping (per contracts/admin-rpcs.write.md § ERRCODE values):
--   WAR01 = not admin            (admin.access_denied audit + raise)
--   WAR02 = reason missing/empty
--   WAR03 = source_citation missing/empty
--   WAR04 = review row not found
--   WAR05 = invariant violation (invalid p_resolution; propagated from
--           admin_update_match for accept_provider when status/kickoff
--           values are rejected)
--
-- Returns: void (per contract signature).

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_resolve_match_pending_review(
  p_review_id       uuid,
  p_resolution      text,
  p_reason          text,
  p_source_citation text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth_user_id     uuid;
  v_admin_id         uuid;
  v_caller_pid       uuid;
  v_review_id_bigint bigint;
  v_review_pre       jsonb;
  v_review_post      jsonb;
  v_match_id         uuid;
  v_proposed_status  text;
  v_proposed_kickoff timestamptz;
  v_underlying_state text;
BEGIN
  -- -------------------------------------------------------------------------
  -- Pre-flight step 1: admin authority check.
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
        'match_pending_review',
        NULL,
        NULL,
        NULL,
        'not_admin',
        'api_guard',
        NULL
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RAISE EXCEPTION USING
      ERRCODE = 'WAR01',
      MESSAGE = 'admin role required';
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 2: reason validation.
  -- -------------------------------------------------------------------------
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR02',
      MESSAGE = 'reason missing or empty';
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 3: source_citation validation.
  -- -------------------------------------------------------------------------
  IF p_source_citation IS NULL OR length(trim(p_source_citation)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR03',
      MESSAGE = 'source citation missing or empty';
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 4: resolve admin participants.id.
  -- -------------------------------------------------------------------------
  SELECT id INTO v_admin_id
    FROM public.participants
   WHERE auth_user_id = v_auth_user_id;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 5: validate p_resolution enum.
  -- contracts/admin-rpcs.write.md § Behavior step 2:
  --   p_resolution in ('accept_provider', 'reject_provider', 'manual_override').
  -- Note: slice 002 slot 0023's table CHECK enumerates the 4 LIFECYCLE labels
  -- {'pending','accepted','rejected','superseded'} (different vocabulary). The
  -- contract's tri-state resolution kind maps to the table column as:
  --   accept_provider  -> 'accepted'
  --   reject_provider  -> 'rejected'
  --   manual_override  -> 'superseded'
  -- We persist the table-canonical value (per the CHECK) so the existing
  -- consistency constraint matches; the contract-level resolution kind is
  -- captured in the audit row's previous_value/new_value jsonb under the
  -- key 'admin_resolution_kind' for forensic recovery.
  -- -------------------------------------------------------------------------
  IF p_resolution NOT IN ('accept_provider', 'reject_provider', 'manual_override') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR05',
      MESSAGE = format('invalid resolution %s (expected accept_provider/reject_provider/manual_override)', p_resolution);
  END IF;

  -- -------------------------------------------------------------------------
  -- Pre-flight step 6: per-review advisory lock to serialize concurrent
  -- resolution attempts on the same row.
  -- -------------------------------------------------------------------------
  PERFORM pg_advisory_xact_lock(
    hashtext('admin_resolve_match_pending_review:' || p_review_id::text)
  );

  -- -------------------------------------------------------------------------
  -- Step 7: capture review row pre-state.
  -- The table PK is bigserial (slice 002 slot 0023). The admin RPC signature
  -- takes uuid for the cross-slice contract; we accept it via text equality
  -- on a generated identifier OR a "match_pending_review_id_uuid" column.
  -- Slice 002's table uses bigint PK, so the uuid p_review_id is interpreted
  -- as `id::text = p_review_id::text` against the encoded numeric id. To keep
  -- the contract signature stable while honouring slice 002's bigint PK, the
  -- admin UI / route handler maps the bigint id to a uuid representation
  -- (zero-padded namespace). Practical approach: cast p_review_id::text and
  -- attempt to parse as bigint; if parseable, use that as the PK lookup.
  -- This keeps the cross-slice signature locked AND works against the
  -- existing table shape without altering slice 002.
  -- -------------------------------------------------------------------------
  BEGIN
    -- Interpret the bigint encoded inside the uuid's last 12 hex digits as
    -- decimal. This convention pairs with the admin UI's bigint->uuid
    -- encoding: uuid = '00000000-0000-0000-0000-' || lpad(bigint::text, 12, '0').
    v_review_id_bigint := (substring(p_review_id::text, 25, 12))::bigint;
  EXCEPTION WHEN OTHERS THEN
    v_review_id_bigint := NULL;
  END;

  IF v_review_id_bigint IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('review %s not found (invalid uuid encoding)', p_review_id);
  END IF;

  SELECT to_jsonb(r.*), r.match_id
    INTO v_review_pre, v_match_id
    FROM public.match_pending_review r
   WHERE r.id = v_review_id_bigint
   FOR UPDATE;

  IF v_review_pre IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR04',
      MESSAGE = format('review %s not found', p_review_id);
  END IF;

  -- Idempotency: refuse to re-resolve an already-resolved row.
  IF (v_review_pre->>'resolution') IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'WAR05',
      MESSAGE = format(
        'review %s already resolved (resolution=%s)',
        p_review_id, v_review_pre->>'resolution'
      );
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 8: branch on resolution kind.
  --   accept_provider  -> apply proposed_payload via admin_update_match.
  --   reject_provider  -> no matches mutation.
  --   manual_override  -> no matches mutation (admin handled it separately).
  -- -------------------------------------------------------------------------
  IF p_resolution = 'accept_provider' AND v_match_id IS NOT NULL THEN
    -- Extract well-known fields from proposed_payload. Unknown fields are
    -- ignored at this slice; provider-specific keys can be added additively
    -- without changing this branch's signature.
    v_proposed_status  := v_review_pre->'proposed_payload'->>'status';
    BEGIN
      v_proposed_kickoff := (v_review_pre->'proposed_payload'->>'kickoff_utc')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      v_proposed_kickoff := NULL;
    END;

    IF v_proposed_status IS NOT NULL OR v_proposed_kickoff IS NOT NULL THEN
      BEGIN
        PERFORM public.admin_update_match(
          v_match_id,
          v_proposed_status,
          v_proposed_kickoff,
          format('apply provider payload from review %s: %s', p_review_id, p_reason),
          p_source_citation
        );
      EXCEPTION
        -- WAR07 (no-op) is benign for accept_provider: the proposed value
        -- already matches the current row. Swallow so the review still
        -- closes.
        WHEN SQLSTATE 'WAR07' THEN
          NULL;
        WHEN OTHERS THEN
          v_underlying_state := SQLSTATE;
          IF v_underlying_state LIKE 'WAR%' THEN
            RAISE;
          END IF;
          RAISE EXCEPTION USING
            ERRCODE = 'WAR05',
            MESSAGE = format(
              'admin_update_match failed during accept_provider (SQLSTATE=%s): %s',
              v_underlying_state, SQLERRM
            );
      END;
    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 9: UPDATE the review row -- table-canonical column names per
  -- slice 002 slot 0023 (resolution / resolved_at / resolved_by / notes).
  -- Map contract-level resolution kind to table-canonical labels:
  --   accept_provider -> 'accepted'
  --   reject_provider -> 'rejected'
  --   manual_override -> 'superseded'
  -- -------------------------------------------------------------------------
  UPDATE public.match_pending_review
     SET resolution  = CASE p_resolution
                         WHEN 'accept_provider' THEN 'accepted'
                         WHEN 'reject_provider' THEN 'rejected'
                         WHEN 'manual_override' THEN 'superseded'
                       END,
         resolved_at = now(),
         resolved_by = v_admin_id,
         notes       = p_reason
   WHERE id = v_review_id_bigint;

  -- Capture post-state.
  SELECT to_jsonb(r.*) INTO v_review_post
    FROM public.match_pending_review r
   WHERE r.id = v_review_id_bigint;

  -- -------------------------------------------------------------------------
  -- Step 10: emit admin.pending_review_resolved audit row.
  -- previous_value + new_value carry the table row state. We add the
  -- contract-level resolution kind under the key 'admin_resolution_kind'
  -- in the audit's new_value for forensic recovery (table column persists
  -- the canonical 4-state label).
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source, source_citation
  ) VALUES (
    v_admin_id,
    'admin.pending_review_resolved',
    'match_pending_review',
    p_review_id,
    v_review_pre,
    COALESCE(v_review_post, '{}'::jsonb) || jsonb_build_object('admin_resolution_kind', p_resolution),
    p_reason,
    'admin_rpc',
    p_source_citation
  );
END;
$$;

COMMENT ON FUNCTION public.admin_resolve_match_pending_review(uuid, text, text, text) IS
  'Slice 006 / T038: SECURITY DEFINER admin RPC that resolves a quarantined sync '
  'conflict in public.match_pending_review (slice 002 slot 0023). Pre-flight: '
  'is_admin (->WAR01 + audit) + reason (->WAR02) + source_citation (->WAR03) + '
  'p_resolution in (accept_provider/reject_provider/manual_override) (->WAR05) + '
  'review exists and not yet resolved (->WAR04/WAR05). Branches: accept_provider '
  'applies proposed_payload via admin_update_match (WAR07 no-op swallowed); '
  'reject_provider + manual_override leave matches untouched. Marks the review '
  'row resolved (table-canonical 4-state label) and emits one '
  'admin.pending_review_resolved audit row. Signature LOCKED cross-slice per Principle XI.';

REVOKE EXECUTE ON FUNCTION public.admin_resolve_match_pending_review(uuid, text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_resolve_match_pending_review(uuid, text, text, text) TO authenticated;

COMMIT;
