-- Slice 007 Audit Trail — finalize audit_log shape, REVOKE tamper privileges, ship audit_search RPC + retention config seed.
-- Migration slot 0076 per D-029 (spec named '007_audit_trail.sql' — 3-digit; renamed to 4-digit to match project slot convention; slice 006 ended at 0075).
-- This file is the SINGLE migration for slice 007. T003-T006 (Phase 2) ship the foundational schema + REVOKE + config seed.
-- T012-T013 (Phase 5) will append audit_search() + count_audit_search() RPC bodies later.

BEGIN;

-- ===========================================================================
-- T003: ADD COLUMN audit_log.sequence_id (bigserial NOT NULL) + unique index
-- ===========================================================================
-- Postgres bigserial auto-creates public.audit_log_sequence_id_seq.
-- Existing rows get monotonic NOT NULL values backfilled via the implicit sequence default.
-- Reference: contracts/audit-log.schema.md § DDL.

ALTER TABLE public.audit_log
  ADD COLUMN sequence_id bigserial NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS audit_log_sequence_id_uk
  ON public.audit_log (sequence_id);

-- ===========================================================================
-- T004: Three indexes for actor/target/source lookups
-- ===========================================================================
-- Reference: research.md § R-008 + data-model.md § Indexes.

CREATE INDEX IF NOT EXISTS audit_log_actor_occurred_idx
  ON public.audit_log (actor, occurred_at DESC)
  WHERE actor IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_target_idx
  ON public.audit_log (entity_type, entity_id, sequence_id ASC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_source_occurred_idx
  ON public.audit_log (source, occurred_at DESC);

-- ===========================================================================
-- T005: REVOKE UPDATE + DELETE from authenticated, anon, service_role
-- ===========================================================================
-- This is the LOCKED tamper-resistance posture per R-001 + Principle II.
-- Reference: contracts/audit-log.schema.md § Tamper-resistance posture (LOCKED).
-- Note: service_role typically bypasses RLS but NOT GRANT-revoked DML.
-- INSERT remains allowed (necessary for triggers + RPC writes).
-- Sequence USAGE is granted so INSERTs from any role still allocate sequence_id.

REVOKE UPDATE, DELETE ON public.audit_log FROM authenticated;
REVOKE UPDATE, DELETE ON public.audit_log FROM anon;
REVOKE UPDATE, DELETE ON public.audit_log FROM service_role;

GRANT USAGE ON SEQUENCE public.audit_log_sequence_id_seq TO authenticated, anon, service_role;

-- ===========================================================================
-- T006: Seed tournament_config keys for audit retention + notification
-- ===========================================================================
-- Defaults only; Slice 008 admin UI will mutate.
-- Reference: research.md § R-003 (retention) + R-011 (notification) + data-model.md § Audit Retention Policy.

INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('audit.retention.policy_kind', '"keep"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('audit.retention.tournament_end_buffer_months', '12'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('notifications.audit_failure_webhook_url', 'null'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ===========================================================================
-- T012: audit_search(...) RPC
-- ===========================================================================
-- Reference: contracts/audit-search.read.md § Signatures (LOCKED) + Behavior.
-- ERRCODE namespace: WAT01 (not admin), WAT02 (invalid input).
-- Parameter order is LOCKED per contract: actor, entity_type, entity_id, action_pattern, source, from, to, limit, offset.
-- Return column order is LOCKED per contract: id, sequence_id, actor, action, entity_type, entity_id, previous_value, new_value, reason, source_citation, source, occurred_at.

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_search(
  p_actor          uuid        DEFAULT NULL,
  p_entity_type    text        DEFAULT NULL,
  p_entity_id      uuid        DEFAULT NULL,
  p_action_pattern text        DEFAULT NULL,
  p_source         text        DEFAULT NULL,
  p_from           timestamptz DEFAULT NULL,
  p_to             timestamptz DEFAULT NULL,
  p_limit          int         DEFAULT 50,
  p_offset         int         DEFAULT 0
) RETURNS TABLE (
  id              uuid,
  sequence_id     bigint,
  actor           uuid,
  action          text,
  entity_type     text,
  entity_id       uuid,
  previous_value  jsonb,
  new_value       jsonb,
  reason          text,
  source_citation text,
  source          text,
  occurred_at     timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_user_id uuid;
BEGIN
  v_auth_user_id := auth.uid();

  -- Authorization check (WAT01)
  IF NOT public.is_admin(v_auth_user_id) THEN
    -- Write admin.access_denied audit row first (best-effort; survives the RAISE via sub-block).
    -- Uses Slice 006's narrow INSERT policy path for audit_log.
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_auth_user_id,
        'admin.access_denied',
        'audit_search',
        'api_guard',
        jsonb_build_object(
          'rpc', 'audit_search',
          'params', jsonb_build_object(
            'actor', p_actor,
            'entity_type', p_entity_type,
            'entity_id', p_entity_id,
            'action_pattern', p_action_pattern,
            'source', p_source,
            'from', p_from,
            'to', p_to,
            'limit', p_limit,
            'offset', p_offset
          )
        )
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required to read audit log'
      USING ERRCODE = 'WAT01';
  END IF;

  -- Input validation (WAT02)
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'Invalid limit; must be 1..500 (got %)', p_limit USING ERRCODE = 'WAT02';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid offset; must be >= 0 (got %)', p_offset USING ERRCODE = 'WAT02';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'Invalid date range; p_from must be <= p_to' USING ERRCODE = 'WAT02';
  END IF;
  IF p_source IS NOT NULL AND p_source NOT IN ('auth_hook','rls','api_guard','ui','trigger','admin_rpc','system') THEN
    RAISE EXCEPTION 'Invalid p_source: %', p_source USING ERRCODE = 'WAT02';
  END IF;
  IF p_action_pattern IS NOT NULL AND length(p_action_pattern) > 200 THEN
    RAISE EXCEPTION 'p_action_pattern too long (max 200 chars)' USING ERRCODE = 'WAT02';
  END IF;

  -- Filter-composition SELECT (locked column order per contract)
  RETURN QUERY
    SELECT
      a.id,
      a.sequence_id,
      a.actor,
      a.action,
      a.entity_type,
      a.entity_id,
      a.previous_value,
      a.new_value,
      a.reason,
      a.source_citation,
      a.source,
      a.occurred_at
      FROM public.audit_log a
     WHERE (p_actor          IS NULL OR a.actor = p_actor)
       AND (p_entity_type    IS NULL OR a.entity_type = p_entity_type)
       AND (p_entity_id      IS NULL OR a.entity_id = p_entity_id)
       AND (p_action_pattern IS NULL OR a.action LIKE p_action_pattern)
       AND (p_source         IS NULL OR a.source = p_source)
       AND (p_from           IS NULL OR a.occurred_at >= p_from)
       AND (p_to             IS NULL OR a.occurred_at < p_to)
     ORDER BY a.sequence_id ASC
     LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- Permissions: authenticated only (not anon)
REVOKE EXECUTE ON FUNCTION public.audit_search(uuid, text, uuid, text, text, timestamptz, timestamptz, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_search(uuid, text, uuid, text, text, timestamptz, timestamptz, int, int) TO authenticated;

COMMIT;

-- ===========================================================================
-- T013: count_audit_search(...) RPC
-- ===========================================================================
-- Reference: contracts/audit-search.read.md § Behavior > Input validation (WAT03 row).
-- 7 parameters (no limit/offset), returns bigint, with WAT03 unbounded-count refusal.

BEGIN;

CREATE OR REPLACE FUNCTION public.count_audit_search(
  p_actor          uuid        DEFAULT NULL,
  p_entity_type    text        DEFAULT NULL,
  p_entity_id      uuid        DEFAULT NULL,
  p_action_pattern text        DEFAULT NULL,
  p_source         text        DEFAULT NULL,
  p_from           timestamptz DEFAULT NULL,
  p_to             timestamptz DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_user_id uuid;
  v_total bigint;
BEGIN
  v_auth_user_id := auth.uid();

  -- Authorization check (WAT01)
  IF NOT public.is_admin(v_auth_user_id) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_auth_user_id,
        'admin.access_denied',
        'audit_search',
        'api_guard',
        jsonb_build_object(
          'rpc', 'count_audit_search',
          'params', jsonb_build_object(
            'actor', p_actor,
            'entity_type', p_entity_type,
            'entity_id', p_entity_id,
            'action_pattern', p_action_pattern,
            'source', p_source,
            'from', p_from,
            'to', p_to
          )
        )
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required to read audit log'
      USING ERRCODE = 'WAT01';
  END IF;

  -- Input validation (WAT02)
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'Invalid date range; p_from must be <= p_to' USING ERRCODE = 'WAT02';
  END IF;
  IF p_source IS NOT NULL AND p_source NOT IN ('auth_hook','rls','api_guard','ui','trigger','admin_rpc','system') THEN
    RAISE EXCEPTION 'Invalid p_source: %', p_source USING ERRCODE = 'WAT02';
  END IF;
  IF p_action_pattern IS NOT NULL AND length(p_action_pattern) > 200 THEN
    RAISE EXCEPTION 'p_action_pattern too long (max 200 chars)' USING ERRCODE = 'WAT02';
  END IF;

  -- Unbounded-count refusal (WAT03)
  -- If ALL filters are NULL AND audit_log has > 100,000 rows, refuse before counting.
  IF p_actor IS NULL
     AND p_entity_type IS NULL
     AND p_entity_id IS NULL
     AND p_action_pattern IS NULL
     AND p_source IS NULL
     AND p_from IS NULL
     AND p_to IS NULL THEN
    SELECT count(*) INTO v_total FROM public.audit_log;
    IF v_total > 100000 THEN
      RAISE EXCEPTION 'Unbounded count refused; narrow filters (audit_log has % rows, > 100000 limit)', v_total
        USING ERRCODE = 'WAT03';
    END IF;
    RETURN v_total;
  END IF;

  -- Filtered count (same composition as audit_search)
  RETURN (
    SELECT count(*) FROM public.audit_log a
     WHERE (p_actor          IS NULL OR a.actor = p_actor)
       AND (p_entity_type    IS NULL OR a.entity_type = p_entity_type)
       AND (p_entity_id      IS NULL OR a.entity_id = p_entity_id)
       AND (p_action_pattern IS NULL OR a.action LIKE p_action_pattern)
       AND (p_source         IS NULL OR a.source = p_source)
       AND (p_from           IS NULL OR a.occurred_at >= p_from)
       AND (p_to             IS NULL OR a.occurred_at < p_to)
  );
END;
$$;

-- Permissions: authenticated only (not anon)
REVOKE EXECUTE ON FUNCTION public.count_audit_search(uuid, text, uuid, text, text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_audit_search(uuid, text, uuid, text, text, timestamptz, timestamptz) TO authenticated;

COMMIT;
