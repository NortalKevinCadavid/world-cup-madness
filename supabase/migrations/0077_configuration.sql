-- Slice 008 Tournament Configuration — final consolidated config surface:
--   tournament_config_versions, admin_config_* RPCs, consumer-slice migrations, webhook delivery (closes Slice 007 SC-007).
-- Migration slot 0077 per D-030 (spec named '008_configuration.sql' — 3-digit; renamed to 4-digit to match project slot convention).
-- This file is the SINGLE migration for slice 008. T004-T026 (Phase 2) append schema/RPCs/RLS/seed/consumer-ALTER in sections.
-- T030+ (Phases 3-7) may append additional fragments per user story.
--
-- T003 extension verification (2026-05-21):
--   * pgcrypto — enabled in slot 0001 (CREATE EXTENSION IF NOT EXISTS pgcrypto)
--   * pg_cron  — enabled in slot 0018 (WITH SCHEMA extensions)
--   * pg_net   — enabled in slot 0018 (WITH SCHEMA extensions) and re-asserted in slot 0059
--   No additional CREATE EXTENSION required by this migration.
--
-- Sections will be appended below this header by Phase 2 + later tasks.

-- ===========================================================================
-- T004: ALTER tournament_config + value_type CHECK + index + REVOKE DELETE
-- ===========================================================================
-- Reference: contracts/tournament-config.schema.md DDL §1.
-- Slice 001 created the base table (key text PK, value jsonb NOT NULL, updated_at
-- timestamptz). This task finalizes the shape by adding value_type, updated_by,
-- and version_id (FK-like pointer to tournament_config_versions written by T005).
-- value_type's 11-value CHECK is the canonical enum per the contract.
-- DELETE is REVOKED from every app role to preserve the invariant that every
-- key carries a history.

BEGIN;

ALTER TABLE public.tournament_config
  ADD COLUMN IF NOT EXISTS value_type text NOT NULL DEFAULT 'jsonb',
  ADD COLUMN IF NOT EXISTS updated_by uuid NULL,
  ADD COLUMN IF NOT EXISTS version_id bigint NULL;

-- Drop any prior CHECK constraint (re-runnable on supabase db reset) then add
-- the canonical 11-value enum from contracts/tournament-config.schema.md §1.
ALTER TABLE public.tournament_config
  DROP CONSTRAINT IF EXISTS tournament_config_value_type_check;

ALTER TABLE public.tournament_config
  ADD CONSTRAINT tournament_config_value_type_check
  CHECK (value_type IN (
    'text','integer','number','boolean','array','object',
    'duration_minutes','duration_seconds','timestamptz','uuid','jsonb'
  ));

CREATE INDEX IF NOT EXISTS tournament_config_updated_at_idx
  ON public.tournament_config (updated_at DESC);

REVOKE DELETE ON public.tournament_config FROM authenticated, anon, service_role;

COMMIT;

-- ===========================================================================
-- T005: CREATE tournament_config_versions table (append-only history)
-- ===========================================================================
-- Reference: contracts/tournament-config.schema.md DDL §2.
-- 12 columns; bigserial PK matches Slice 007 audit_log.sequence_id pattern.
-- audit_log_id is a UUID FK because audit_log.id is uuid (slot 0003).
-- Three CHECKs enforce the change_kind enum, the previous_value non-null
-- invariant (except initial_seed), and the parent_version_id only-on-rollback
-- coupling. Three indexes accelerate the per-key history view, the global
-- "recent changes" view, and the rollback-event audit view.
-- UPDATE/DELETE REVOKED to enforce append-only at the role layer.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tournament_config_versions (
  version_id              bigserial PRIMARY KEY,
  key                     text        NOT NULL,
  previous_value          jsonb       NULL,
  new_value               jsonb       NOT NULL,
  change_kind             text        NOT NULL,
  actor                   uuid        NULL,
  reason                  text        NULL,
  source_citation         text        NULL,
  audit_log_id            uuid        NULL REFERENCES public.audit_log(id) ON DELETE NO ACTION,
  parent_version_id       bigint      NULL REFERENCES public.tournament_config_versions(version_id),
  acknowledge_token_used  uuid        NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Drop-then-add for idempotent re-runs (CREATE TABLE IF NOT EXISTS won't recreate
-- the constraint clauses).
ALTER TABLE public.tournament_config_versions
  DROP CONSTRAINT IF EXISTS tournament_config_versions_change_kind_check;
ALTER TABLE public.tournament_config_versions
  ADD CONSTRAINT tournament_config_versions_change_kind_check
  CHECK (change_kind IN ('initial_seed','admin_upsert','admin_rollback','import_bulk'));

ALTER TABLE public.tournament_config_versions
  DROP CONSTRAINT IF EXISTS tournament_config_versions_previous_value_check;
ALTER TABLE public.tournament_config_versions
  ADD CONSTRAINT tournament_config_versions_previous_value_check
  CHECK (
    (change_kind = 'initial_seed') OR (previous_value IS NOT NULL)
  );

ALTER TABLE public.tournament_config_versions
  DROP CONSTRAINT IF EXISTS tournament_config_versions_parent_version_check;
ALTER TABLE public.tournament_config_versions
  ADD CONSTRAINT tournament_config_versions_parent_version_check
  CHECK (
    (change_kind = 'admin_rollback') = (parent_version_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS tournament_config_versions_key_version_idx
  ON public.tournament_config_versions (key, version_id DESC);

CREATE INDEX IF NOT EXISTS tournament_config_versions_created_at_idx
  ON public.tournament_config_versions (created_at DESC);

CREATE INDEX IF NOT EXISTS tournament_config_versions_rollback_idx
  ON public.tournament_config_versions (change_kind, version_id DESC)
  WHERE change_kind = 'admin_rollback';

REVOKE UPDATE, DELETE ON public.tournament_config_versions FROM authenticated, anon, service_role;
GRANT  USAGE ON SEQUENCE public.tournament_config_versions_version_id_seq
  TO authenticated, anon, service_role;

COMMIT;

-- ===========================================================================
-- T006: key_is_secret(text) helper
-- ===========================================================================
-- Reference: contracts/tournament-config.schema.md §3.
-- Returns true when the key matches the provider-credentials namespace.
-- Used by the tournament_config_authenticated_read RLS policy (T008) to gate
-- secret-key visibility to admins only.

BEGIN;

CREATE OR REPLACE FUNCTION public.key_is_secret(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_key LIKE 'providers.%.credentials.%';
$$;

GRANT EXECUTE ON FUNCTION public.key_is_secret(text) TO authenticated, anon, service_role;

COMMIT;

-- ===========================================================================
-- T007: config_read(text, jsonb) helper (fail-closed)
-- ===========================================================================
-- Reference: contracts/tournament-config.schema.md §4 + research R-011.
-- Fail-closed semantics: when the key is missing AND no default is provided,
-- raise SQLSTATE WCG06 (Configuration store unreachable). Consumer slices
-- (slice 001 eligibility, slice 003 lock window, slice 005 scoring) wrap this
-- in EXCEPTION handlers to translate to safe defaults (deny login / lock /
-- zero points).

BEGIN;

CREATE OR REPLACE FUNCTION public.config_read(p_key text, p_default jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT value INTO v FROM public.tournament_config WHERE key = p_key;
  IF v IS NULL THEN
    IF p_default IS NULL THEN
      RAISE EXCEPTION 'Configuration key % not found and no default provided', p_key
        USING ERRCODE = 'WCG06';
    END IF;
    RETURN p_default;
  END IF;
  RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.config_read(text, jsonb) TO authenticated, service_role;

COMMIT;

-- ===========================================================================
-- T008: RLS policies on tournament_config + tournament_config_versions
-- ===========================================================================
-- Reference: contracts/tournament-config.schema.md §3 + data-model.md § RLS
-- posture (final, post-slice-008).
-- 4 policies total:
--   * tournament_config_authenticated_read   (SELECT: admin OR not-secret)
--   * tournament_config_no_direct_write      (ALL: false; writes via RPC only)
--   * tournament_config_versions_admin_read  (SELECT: is_admin)
--   * tournament_config_versions_no_direct_write (ALL: false)
-- The admin_config_* SECURITY DEFINER RPCs bypass these because they run as
-- the table owner.

BEGIN;

ALTER TABLE public.tournament_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_config_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tournament_config_authenticated_read     ON public.tournament_config;
DROP POLICY IF EXISTS tournament_config_no_direct_write        ON public.tournament_config;
DROP POLICY IF EXISTS tournament_config_versions_admin_read    ON public.tournament_config_versions;
DROP POLICY IF EXISTS tournament_config_versions_no_direct_write ON public.tournament_config_versions;

CREATE POLICY tournament_config_authenticated_read
  ON public.tournament_config
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()) OR NOT public.key_is_secret(key));

CREATE POLICY tournament_config_no_direct_write
  ON public.tournament_config
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY tournament_config_versions_admin_read
  ON public.tournament_config_versions
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE POLICY tournament_config_versions_no_direct_write
  ON public.tournament_config_versions
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

COMMIT;

-- ===========================================================================
-- T009: notify_tournament_config_change trigger + function
-- ===========================================================================
-- Reference: research.md R-009 + contracts/tournament-config.schema.md §5.
-- Emits pg_notify('tournament_config_changed', <changed key>) on every INSERT
-- or UPDATE to tournament_config. Long-lived Next.js processes LISTEN on this
-- channel to invalidate their in-memory LRU cache (60-second TTL backstop).

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_tournament_config_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('tournament_config_changed', NEW.key);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tournament_config_change_notify ON public.tournament_config;
CREATE TRIGGER tournament_config_change_notify
  AFTER INSERT OR UPDATE ON public.tournament_config
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_tournament_config_change();

COMMIT;

-- ===========================================================================
-- T010: Seed configuration namespace catalog + backfill version_id
-- ===========================================================================
-- Reference: data-model.md § Configuration namespace catalog (FROZEN at slice close).
-- Two-step seed:
--   1) INSERT every key into tournament_config with ON CONFLICT DO NOTHING.
--      Keys seeded by prior slices (lock_window_minutes, score_upper_bound,
--      match_points.*, audit.retention.*, etc.) are NOT overwritten. The
--      new-namespace keys (locking.match_prediction_window_minutes,
--      scoring.match_points.exact, eligibility.allowed_domains, ...) are
--      INSERTed fresh.
--   2) For every tournament_config row whose version_id IS NULL (any key
--      without a versions history entry), INSERT an initial_seed row into
--      tournament_config_versions, capture the new version_id, and UPDATE
--      tournament_config.version_id to point at it.
-- Side effect: prior-slice keys gain a synthetic initial_seed row whose
-- new_value mirrors the existing tournament_config.value at seed time.

BEGIN;

-- ---- eligibility.* ------------------------------------------------------

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('eligibility.allowed_domains', '["nortal.com"]'::jsonb, 'array', now())
ON CONFLICT (key) DO NOTHING;

-- ---- locking.* ----------------------------------------------------------

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('locking.match_prediction_window_minutes', '60'::jsonb, 'integer', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('locking.final_prediction_anchor', '"first_kickoff"'::jsonb, 'text', now())
ON CONFLICT (key) DO NOTHING;

-- ---- scoring.* ----------------------------------------------------------

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('scoring.match_points.exact', '10'::jsonb, 'integer', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('scoring.match_points.correct_outcome', '5'::jsonb, 'integer', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('scoring.match_points.incorrect', '0'::jsonb, 'integer', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('scoring.final_pick_points', '20'::jsonb, 'integer', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('scoring.score_upper_bound', '99'::jsonb, 'integer', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('scoring.knockout_match_basis', '"regular_time"'::jsonb, 'text', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('scoring.top_scorer_tie_policy', '"all_qualify"'::jsonb, 'text', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('scoring.best_player_source', '"official_tournament_award"'::jsonb, 'text', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES (
  'scoring.tie_breaker_order',
  '["points_total","exact_match_count","final_pick_correct","earliest_submission"]'::jsonb,
  'array',
  now()
)
ON CONFLICT (key) DO NOTHING;

-- ---- leaderboard.* ------------------------------------------------------

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('leaderboard.visibility_policy', '"all_participants_visible"'::jsonb, 'text', now())
ON CONFLICT (key) DO NOTHING;

-- ---- tournament.* -------------------------------------------------------

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('tournament.phase.current', '"pre_tournament"'::jsonb, 'text', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('tournament.first_kickoff_at_utc', 'null'::jsonb, 'timestamptz', now())
ON CONFLICT (key) DO NOTHING;

-- ---- providers.* --------------------------------------------------------

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('providers.active', '"football_data_org"'::jsonb, 'text', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES (
  'providers.registered.football_data_org',
  '{"display_name":"football-data.org","contract_version":"v4"}'::jsonb,
  'object',
  now()
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('providers.football_data_org.retry.max_attempts', '3'::jsonb, 'integer', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('providers.football_data_org.retry.backoff_seconds_base', '2'::jsonb, 'integer', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('providers.football_data_org.alert.threshold_consecutive_failures', '5'::jsonb, 'integer', now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES (
  'providers.football_data_org.credentials.api_key',
  '{"secret":true,"value":null}'::jsonb,
  'object',
  now()
)
ON CONFLICT (key) DO NOTHING;

-- ---- notifications.* ----------------------------------------------------

INSERT INTO public.tournament_config (key, value, value_type, updated_at)
VALUES ('notifications.deadline_reminders.enabled', 'false'::jsonb, 'boolean', now())
ON CONFLICT (key) DO NOTHING;

-- Note: audit.retention.policy_kind, audit.retention.tournament_end_buffer_months,
-- and notifications.audit_failure_webhook_url were already seeded by slot 0076
-- (slice 007). ON CONFLICT DO NOTHING preserves those values; the version
-- backfill below will still attach an initial_seed history row to them.

-- ---- Backfill version_id for every key that still lacks one -------------
-- Walks every tournament_config row with version_id IS NULL, INSERTs an
-- initial_seed row into tournament_config_versions, and stamps the resulting
-- version_id back onto tournament_config.version_id. This covers BOTH the
-- newly-seeded slice-008 keys AND any prior-slice keys that pre-date the
-- version_id column (slot 0035 lock_window_minutes, slot 0057 scoring keys,
-- slot 0076 audit retention keys, etc.).

DO $seed$
DECLARE
  r record;
  v_new_version bigint;
BEGIN
  FOR r IN
    SELECT key, value
      FROM public.tournament_config
     WHERE version_id IS NULL
     ORDER BY key
  LOOP
    INSERT INTO public.tournament_config_versions (
      key, previous_value, new_value, change_kind, actor, reason, source_citation, audit_log_id, acknowledge_token_used
    )
    VALUES (
      r.key, NULL, r.value, 'initial_seed', NULL, 'initial slice 008 seed', NULL, NULL, NULL
    )
    RETURNING version_id INTO v_new_version;

    UPDATE public.tournament_config
       SET version_id = v_new_version
     WHERE key = r.key;
  END LOOP;
END
$seed$;

COMMIT;

-- ===========================================================================
-- T011: admin_config_upsert SECURITY DEFINER RPC
-- ===========================================================================
-- Reference: contracts/admin-config-rpcs.write.md § Behavior — admin_config_upsert.
-- Signature LOCKED per contract. Body steps:
--   1. is_admin gate (writes admin.access_denied audit row, raises WCG07)
--   2. reason non-empty validation (raises WCG02)
--   3. Universal validation: key must exist in catalog OR be a known dotted
--      namespace prefix (raises WCG03 on unknown key)
--   4. pg_advisory_xact_lock(hashtext(p_key)) — single-key serialization
--   5. expected_version_id verification (raises WCG01)
--   6. acknowledge-token check via admin_config_preview (raises WCG05 if
--      affecting=true and token missing/invalid)
--   7. Atomic 3-write: audit_log (action='tournament_config.<key>') →
--      tournament_config_versions (change_kind='admin_upsert') →
--      tournament_config UPDATE
--   8. Return new version_id
-- The per-key value validator is a CASE dispatcher inline in the body. The
-- frontend zod validators (T018) are the primary defence; this CASE is a
-- backstop for direct-RPC callers.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_config_upsert(
  p_key                  text,
  p_value                jsonb,
  p_expected_version_id  bigint,
  p_reason               text,
  p_source_citation      text DEFAULT NULL,
  p_acknowledge_token    uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor             uuid;
  v_current_version   bigint;
  v_previous_value    jsonb;
  v_existing_value_type text;
  v_preview           jsonb;
  v_audit_id          uuid;
  v_new_version       bigint;
  v_action_label      text;
BEGIN
  v_actor := auth.uid();

  -- Step 1: authorization
  IF NOT public.is_admin(v_actor) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_actor,
        'admin.access_denied',
        'admin_config_upsert',
        'api_guard',
        jsonb_build_object('rpc','admin_config_upsert','key',p_key)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  -- Step 2: reason required
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Reason is required for configuration writes'
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 3: per-key value validation (CASE dispatcher). The frontend zod
  -- validator (T018) is the primary check; this is the SQL backstop.
  CASE
    WHEN p_key = 'eligibility.allowed_domains' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN
        RAISE EXCEPTION 'Invalid value for key %: must be a jsonb array', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    WHEN p_key = 'locking.match_prediction_window_minutes' THEN
      IF jsonb_typeof(p_value) <> 'number'
         OR (p_value)::text::int < 1
         OR (p_value)::text::int > 1440 THEN
        RAISE EXCEPTION 'Invalid value for key %: must be integer 1..1440', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    WHEN p_key LIKE 'scoring.match_points.%'
      OR p_key = 'scoring.final_pick_points'
      OR p_key = 'scoring.score_upper_bound' THEN
      IF jsonb_typeof(p_value) <> 'number'
         OR (p_value)::text::int < 0 THEN
        RAISE EXCEPTION 'Invalid value for key %: must be non-negative integer', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    WHEN p_key = 'scoring.tie_breaker_order' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN
        RAISE EXCEPTION 'Invalid value for key %: must be a jsonb array of tier names', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    WHEN p_key = 'tournament.phase.current' THEN
      IF jsonb_typeof(p_value) <> 'string'
         OR (p_value #>> '{}') NOT IN ('pre_tournament','group_stage','knockout','completed') THEN
        RAISE EXCEPTION 'Invalid value for key %: must be one of pre_tournament|group_stage|knockout|completed', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    ELSE
      -- Other keys: minimal type check happens via the existing value_type
      -- on the row plus the frontend validator. Leave as-is.
      NULL;
  END CASE;

  -- Step 4: source_citation required for security-sensitive keys
  IF p_source_citation IS NULL AND (
    p_key LIKE 'eligibility.%'
    OR p_key LIKE 'locking.%'
    OR p_key LIKE 'scoring.%'
    OR p_key = 'providers.active'
    OR p_key LIKE 'admin_roles.%'
  ) THEN
    RAISE EXCEPTION 'Source citation required for security-sensitive key %', p_key
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 5: advisory xact lock (per-key serialization)
  PERFORM pg_advisory_xact_lock(hashtext(p_key));

  -- Step 6: universal validation — key must exist in tournament_config + lock
  -- the row for the duration of the txn.
  SELECT version_id, value, value_type
    INTO v_current_version, v_previous_value, v_existing_value_type
    FROM public.tournament_config
   WHERE key = p_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown configuration key %', p_key
      USING ERRCODE = 'WCG03';
  END IF;

  -- Step 7: expected_version_id check
  IF v_current_version IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'Concurrent edit detected: expected version_id %, current %',
      p_expected_version_id, v_current_version
      USING ERRCODE = 'WCG01';
  END IF;

  -- Step 8: acknowledge-token check (re-run preview to recompute affecting)
  v_preview := public.admin_config_preview(p_key, p_value);
  IF (v_preview ->> 'affecting')::boolean THEN
    IF p_acknowledge_token IS NULL THEN
      RAISE EXCEPTION 'This change affects existing data; acknowledge token required'
        USING ERRCODE = 'WCG05';
    END IF;
    IF NOT public.verify_acknowledge_token(p_acknowledge_token, p_key, p_value) THEN
      RAISE EXCEPTION 'Acknowledge token invalid or expired'
        USING ERRCODE = 'WCG05';
    END IF;
  END IF;

  -- Step 9: atomic 3-write (audit_log → versions → tournament_config)
  v_action_label := 'tournament_config.' || p_key;

  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id, source,
    previous_value, new_value, reason
  )
  VALUES (
    v_actor, v_action_label, 'tournament_config', NULL, 'admin_rpc',
    v_previous_value, p_value, p_reason
  )
  RETURNING id INTO v_audit_id;

  INSERT INTO public.tournament_config_versions (
    key, previous_value, new_value, change_kind,
    actor, reason, source_citation, audit_log_id,
    acknowledge_token_used
  )
  VALUES (
    p_key, v_previous_value, p_value, 'admin_upsert',
    v_actor, p_reason, p_source_citation, v_audit_id,
    p_acknowledge_token
  )
  RETURNING version_id INTO v_new_version;

  UPDATE public.tournament_config
     SET value      = p_value,
         value_type = COALESCE(v_existing_value_type, 'jsonb'),
         updated_at = now(),
         updated_by = v_actor,
         version_id = v_new_version
   WHERE key = p_key;

  RETURN v_new_version;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_config_upsert(text, jsonb, bigint, text, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_config_upsert(text, jsonb, bigint, text, text, uuid) TO authenticated;

COMMIT;

-- ===========================================================================
-- T012: admin_config_preview SECURITY DEFINER RPC + ack-token helpers
-- ===========================================================================
-- Reference: contracts/admin-config-rpcs.write.md § Behavior — admin_config_preview.
-- Two helper functions + the preview RPC itself.
--
-- Ack-token scheme (self-validating, table-backed): issue_acknowledge_token
-- INSERTs a row into a small _admin_acknowledge_tokens registry keyed by
-- token uuid, with (key, value_hash, expires_at). verify_acknowledge_token
-- SELECTs the row, checks expiry, and confirms the value_hash matches the
-- supplied (key, value) pair. 5-minute TTL per R-010.
--
-- value_hash is sha256(key || value::text) — pgcrypto's digest().
--
-- The registry table is REVOKEd from app roles (only the SECURITY DEFINER
-- helpers may write to it).

BEGIN;

-- ---- ack-token registry table ------------------------------------------
CREATE TABLE IF NOT EXISTS public._admin_acknowledge_tokens (
  token        uuid        PRIMARY KEY,
  key          text        NOT NULL,
  value_hash   bytea       NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS _admin_acknowledge_tokens_expires_idx
  ON public._admin_acknowledge_tokens (expires_at);

REVOKE ALL ON public._admin_acknowledge_tokens FROM authenticated, anon, service_role;

-- ---- issue_acknowledge_token -------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_acknowledge_token(p_key text, p_value jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
BEGIN
  -- Best-effort cleanup of expired tokens (keeps the registry small).
  DELETE FROM public._admin_acknowledge_tokens WHERE expires_at < now();

  INSERT INTO public._admin_acknowledge_tokens (token, key, value_hash, expires_at)
  VALUES (
    v_token,
    p_key,
    digest(p_key || ':' || coalesce(p_value::text, 'null'), 'sha256'),
    now() + interval '5 minutes'
  );

  RETURN v_token;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.issue_acknowledge_token(text, jsonb) FROM PUBLIC;

-- ---- verify_acknowledge_token ------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_acknowledge_token(p_token uuid, p_key text, p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  IF p_token IS NULL THEN RETURN false; END IF;

  SELECT key, value_hash, expires_at
    INTO v_row
    FROM public._admin_acknowledge_tokens
   WHERE token = p_token;

  IF NOT FOUND THEN RETURN false; END IF;
  IF v_row.expires_at < now() THEN RETURN false; END IF;
  IF v_row.key <> p_key THEN RETURN false; END IF;
  IF v_row.value_hash <> digest(p_key || ':' || coalesce(p_value::text, 'null'), 'sha256') THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.verify_acknowledge_token(uuid, text, jsonb) FROM PUBLIC;

-- ---- admin_config_preview ----------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_config_preview(
  p_key    text,
  p_value  jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor               uuid;
  v_current_value       jsonb;
  v_affecting           boolean := false;
  v_summary             text    := 'No existing data is affected by this change.';
  v_sample              jsonb   := '[]'::jsonb;
  v_token               uuid    := NULL;
  v_count               bigint  := 0;
  v_old_minutes         int;
  v_new_minutes         int;
  v_new_bound           int;
  v_removed_domains     jsonb;
  v_new_active_provider text;
  v_old_active_provider text;
BEGIN
  v_actor := auth.uid();

  IF NOT public.is_admin(v_actor) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_actor, 'admin.access_denied', 'admin_config_preview', 'api_guard',
        jsonb_build_object('rpc','admin_config_preview','key',p_key)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  SELECT value INTO v_current_value
    FROM public.tournament_config
   WHERE key = p_key;

  -- Per-key impact analysis. Each branch sets v_affecting / v_summary /
  -- v_sample as appropriate. Keys not enumerated default to non-affecting.

  IF p_key = 'eligibility.allowed_domains' AND v_current_value IS NOT NULL THEN
    -- Compute domains being removed: in current but not in new.
    SELECT jsonb_agg(d)
      INTO v_removed_domains
      FROM (
        SELECT lower(trim(value)) AS d
          FROM jsonb_array_elements_text(v_current_value)
        EXCEPT
        SELECT lower(trim(value))
          FROM jsonb_array_elements_text(p_value)
      ) sub
      WHERE d IS NOT NULL;

    IF v_removed_domains IS NOT NULL AND jsonb_array_length(v_removed_domains) > 0 THEN
      SELECT count(*),
             jsonb_agg(jsonb_build_object('participant_id', p.id, 'email', p.email::text)
                       ORDER BY p.email)
        INTO v_count, v_sample
        FROM public.participants p
       WHERE lower(split_part(p.email::text, '@', 2)) IN (
         SELECT lower(trim(value)) FROM jsonb_array_elements_text(v_removed_domains)
       );

      IF v_count > 0 THEN
        v_affecting := true;
        v_summary := format(
          'Removing domain(s) %s will deactivate %s existing participant(s) at next eligibility re-check.',
          v_removed_domains::text, v_count
        );
        v_sample := COALESCE(
          (SELECT jsonb_agg(s)
             FROM (
               SELECT s.*
                 FROM jsonb_array_elements(v_sample) s
                LIMIT 5
             ) limited),
          '[]'::jsonb
        );
      END IF;
    END IF;

  ELSIF p_key = 'locking.match_prediction_window_minutes' AND v_current_value IS NOT NULL THEN
    v_old_minutes := (v_current_value)::text::int;
    v_new_minutes := (p_value)::text::int;

    IF v_old_minutes <> v_new_minutes THEN
      -- Count matches whose lock classification flips between now() and the
      -- old or new window. A flip happens when now() falls inside the
      -- (kickoff - max(old,new), kickoff - min(old,new)] interval for a
      -- scheduled match.
      SELECT count(*)
        INTO v_count
        FROM public.matches m
       WHERE m.status::text = 'scheduled'
         AND now() BETWEEN
             m.kickoff_utc - make_interval(mins => greatest(v_old_minutes, v_new_minutes))
             AND m.kickoff_utc - make_interval(mins => least(v_old_minutes, v_new_minutes));

      IF v_count > 0 THEN
        v_affecting := true;
        v_summary := format(
          'Changing the lock window from %s to %s minutes will re-classify %s scheduled match(es) (currently in transition zone).',
          v_old_minutes, v_new_minutes, v_count
        );
        SELECT jsonb_agg(jsonb_build_object('match_id', m.id, 'kickoff_utc', m.kickoff_utc) ORDER BY m.kickoff_utc)
          INTO v_sample
          FROM (
            SELECT id, kickoff_utc
              FROM public.matches
             WHERE status::text = 'scheduled'
               AND now() BETWEEN
                   kickoff_utc - make_interval(mins => greatest(v_old_minutes, v_new_minutes))
                   AND kickoff_utc - make_interval(mins => least(v_old_minutes, v_new_minutes))
             ORDER BY kickoff_utc
             LIMIT 5
          ) m;
      END IF;
    END IF;

  ELSIF p_key = 'scoring.score_upper_bound' AND v_current_value IS NOT NULL THEN
    v_new_bound := (p_value)::text::int;
    -- Count predictions whose home/away score exceeds the new bound.
    -- predictions table presence: slot 0030.
    BEGIN
      EXECUTE format(
        'SELECT count(*) FROM public.predictions WHERE predicted_home > %1$s OR predicted_away > %1$s',
        v_new_bound
      ) INTO v_count;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      v_count := 0;
    END;

    IF v_count > 0 THEN
      v_affecting := true;
      v_summary := format(
        'Lowering score_upper_bound to %s will leave %s existing prediction(s) above the new bound (existing rows are preserved; future writes will be rejected).',
        v_new_bound, v_count
      );
    END IF;

  ELSIF (p_key LIKE 'scoring.match_points.%'
         OR p_key = 'scoring.final_pick_points'
         OR p_key = 'scoring.tie_breaker_order')
        AND v_current_value IS NOT NULL
        AND v_current_value <> p_value THEN
    BEGIN
      EXECUTE 'SELECT count(*) FROM public.score_records' INTO v_count;
    EXCEPTION WHEN undefined_table THEN
      v_count := 0;
    END;

    IF v_count > 0 THEN
      v_affecting := true;
      v_summary := format(
        'Changing scoring rule %s will require recomputing all %s existing score_records on next scoring run.',
        p_key, v_count
      );
    END IF;

  ELSIF p_key = 'providers.active' AND v_current_value IS NOT NULL THEN
    v_old_active_provider := v_current_value #>> '{}';
    v_new_active_provider := p_value #>> '{}';
    IF v_old_active_provider <> v_new_active_provider THEN
      BEGIN
        EXECUTE 'SELECT count(*) FROM public.matches WHERE status::text NOT IN (''finished'')' INTO v_count;
      EXCEPTION WHEN undefined_table OR undefined_column THEN
        v_count := 0;
      END;
      IF v_count > 0 THEN
        v_affecting := true;
        v_summary := format(
          'Switching active provider from %s to %s will route the next sync for %s un-finished match(es) through the new adapter.',
          v_old_active_provider, v_new_active_provider, v_count
        );
      END IF;
    END IF;

  ELSIF p_key LIKE 'admin_roles.%' THEN
    -- Admin role revocation impact handled by Slice 006 territory; mark as
    -- affecting whenever the new_value is "revoked" so an ack token is
    -- required even without a session-count probe.
    IF (p_value ->> 'admin') = 'false' THEN
      v_affecting := true;
      v_summary := 'Revoking an admin role; existing sessions for the participant will lose admin authority on next request.';
    END IF;
  END IF;

  IF v_affecting THEN
    v_token := public.issue_acknowledge_token(p_key, p_value);
  END IF;

  RETURN jsonb_build_object(
    'affecting', v_affecting,
    'summary',   v_summary,
    'sample',    COALESCE(v_sample, '[]'::jsonb),
    'acknowledge_token', v_token
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_config_preview(text, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_config_preview(text, jsonb) TO authenticated;

COMMIT;

-- ===========================================================================
-- T013 (pre-block): Regression smoke fixture — capture pre-migration state
-- ===========================================================================
-- Reference: Principle XI (Regression-Gated) + tasks T013.
-- Before T014-T016 redefine the consumer functions, we capture their current
-- outputs against a tiny set of known inputs into the temp table
-- _t013_smoke_pre. After T016 lands, the post-block re-runs the same
-- predicates and RAISES on any divergence — the migration aborts if any
-- regression is detected.
--
-- Inputs:
--   * is_eligible_nortal_participant(uuid) — sample existing participants
--       (LIMIT 5) plus a known-bogus uuid.
--   * is_prediction_locked(uuid)            — sample existing matches
--       (LIMIT 5) plus a known-bogus uuid.
--   * compute_match_score(...)              — fixed 4-tuples covering all
--       three reason-code branches (this function is being CREATEd by T016,
--       so the pre-state for it is "not yet defined" and the post-block
--       only checks correctness of the new function against expected values,
--       not equality with pre-state).
--
-- The temp table uses ON COMMIT DROP DEFAULT so it survives within this
-- migration's transaction-per-block style — we declare it CREATE TEMP TABLE
-- ... ON COMMIT PRESERVE ROWS to span subsequent COMMITs in the file.

BEGIN;

DROP TABLE IF EXISTS _t013_smoke_pre;
CREATE TEMP TABLE _t013_smoke_pre (
  fn       text  NOT NULL,
  args     jsonb NOT NULL,
  result   text  NULL,
  PRIMARY KEY (fn, args)
) ON COMMIT PRESERVE ROWS;

-- is_eligible_nortal_participant: sample up to 5 participants + 1 bogus uuid
INSERT INTO _t013_smoke_pre (fn, args, result)
SELECT 'is_eligible_nortal_participant',
       jsonb_build_object('p_uid', p.auth_user_id),
       public.is_eligible_nortal_participant(p.auth_user_id)::text
  FROM (
    SELECT auth_user_id FROM public.participants ORDER BY id LIMIT 5
  ) p;

INSERT INTO _t013_smoke_pre (fn, args, result)
VALUES (
  'is_eligible_nortal_participant',
  jsonb_build_object('p_uid', '00000000-0000-0000-0000-000000000000'::uuid),
  public.is_eligible_nortal_participant('00000000-0000-0000-0000-000000000000'::uuid)::text
);

-- is_prediction_locked: sample up to 5 matches + 1 bogus uuid
INSERT INTO _t013_smoke_pre (fn, args, result)
SELECT 'is_prediction_locked',
       jsonb_build_object('p_match_id', m.id),
       public.is_prediction_locked(m.id)::text
  FROM (
    SELECT id FROM public.matches ORDER BY kickoff_utc LIMIT 5
  ) m;

INSERT INTO _t013_smoke_pre (fn, args, result)
VALUES (
  'is_prediction_locked',
  jsonb_build_object('p_match_id', '00000000-0000-0000-0000-000000000000'::uuid),
  public.is_prediction_locked('00000000-0000-0000-0000-000000000000'::uuid)::text
);

COMMIT;

-- ===========================================================================
-- T014: is_eligible_nortal_participant — read from eligibility.allowed_domains
-- ===========================================================================
-- Reference: research R-006 + R-014.
-- Slice 001's body chained through is_approved_domain() which read the
-- LEGACY key 'eligibility.approved_domains'. This slice migrates the body to
-- read the NEW key 'eligibility.allowed_domains' via config_read (fail-closed
-- on WCG06 -> return false to deny login). The signature (p_uid uuid)
-- RETURNS boolean STABLE is preserved EXACTLY per Principle XI.
-- The body remains SECURITY INVOKER to mirror the slice 001 contract; the
-- only change is the data source.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_eligible_nortal_participant(p_uid uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email   text;
  v_domain  text;
  v_status  text;
  v_allowed jsonb;
BEGIN
  IF p_uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT lower(p.email::text), p.status::text
    INTO v_email, v_status
    FROM public.participants p
   WHERE p.auth_user_id = p_uid;

  IF v_email IS NULL THEN
    RETURN false;
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN false;
  END IF;

  v_domain := lower(trim(split_part(v_email, '@', 2)));
  IF v_domain = '' THEN
    RETURN false;
  END IF;

  -- Fail-closed: missing key raises WCG06 which we trap to return false.
  BEGIN
    v_allowed := public.config_read('eligibility.allowed_domains', NULL);
  EXCEPTION WHEN SQLSTATE 'WCG06' THEN
    RETURN false;
  END;

  IF v_allowed IS NULL OR jsonb_typeof(v_allowed) <> 'array' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(v_allowed) AS d(value)
     WHERE lower(trim(d.value)) = v_domain
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_eligible_nortal_participant(uuid) TO authenticated;

COMMIT;

-- ===========================================================================
-- T015: is_prediction_locked — read from locking.match_prediction_window_minutes
-- ===========================================================================
-- Reference: research R-014 row "Slice 003 lock window".
-- Slice 003 (slot 0031) read the LEGACY key 'lock_window_minutes' with a
-- hardcoded fallback of 60. This slice migrates the body to read the NEW key
-- 'locking.match_prediction_window_minutes' via config_read with fail-closed
-- semantics: a missing key raises WCG06 which we trap to return true (fail
-- locked / deny writes). BR-LOCK-002/003/004 preserved verbatim (strict >=
-- boundary, non-scheduled status locks, unknown match locks).
-- Signature (p_match_id uuid) RETURNS boolean STABLE preserved EXACTLY.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_prediction_locked(p_match_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status      text;
  v_kickoff_utc timestamptz;
  v_minutes     int;
  v_window_cfg  jsonb;
BEGIN
  SELECT status::text, kickoff_utc
    INTO v_status, v_kickoff_utc
    FROM public.matches
   WHERE id = p_match_id;

  -- Fail-closed: unknown match -> locked (BR-LOCK-004 supplement).
  IF v_status IS NULL THEN
    RETURN true;
  END IF;

  -- BR-LOCK-004: any non-scheduled status locks the match.
  IF v_status <> 'scheduled' THEN
    RETURN true;
  END IF;

  -- Read the lock window from the new slice-008 key. Fail-closed on WCG06
  -- (key missing) -> return true (deny).
  BEGIN
    v_window_cfg := public.config_read('locking.match_prediction_window_minutes', NULL);
  EXCEPTION WHEN SQLSTATE 'WCG06' THEN
    RETURN true;
  END;

  IF v_window_cfg IS NULL OR jsonb_typeof(v_window_cfg) <> 'number' THEN
    -- Defensive: corrupt value -> fail closed.
    RETURN true;
  END IF;

  v_minutes := (v_window_cfg)::text::int;

  -- BR-LOCK-002 / BR-LOCK-003: strict boundary on >= (NOT >). At exactly
  -- kickoff - lock_window the match is locked.
  RETURN now() >= v_kickoff_utc - (v_minutes * INTERVAL '1 minute');
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_prediction_locked(uuid) TO authenticated;

COMMIT;

-- ===========================================================================
-- T016: compute_match_score — NEW helper reading scoring config
-- ===========================================================================
-- Reference: research R-014 row "Slice 005 scoring values".
-- Slice 005's score_match SP (slot 0052) embeds the scoring logic inline,
-- reading the LEGACY keys match_points.{exact,outcome,incorrect}. This task
-- adds a NEW public.compute_match_score helper that other consumers can call
-- to score a single prediction without touching score_records. The helper
-- reads the NEW slice-008 namespace keys:
--   * scoring.match_points.exact
--   * scoring.match_points.correct_outcome
--   * scoring.match_points.incorrect
-- with fail-closed semantics (WCG06 -> return 0).
--
-- The leaderboard view's tie-breaker re-implementation (per R-014 row
-- "Slice 005 tie-breaker") is deferred to a future task — note recorded
-- as deviation D-031 in tasks.md / open-decisions follow-ups. The view
-- continues to read the legacy key 'tiebreaker.order' from slot 0057 until
-- that follow-up lands.

BEGIN;

CREATE OR REPLACE FUNCTION public.compute_match_score(
  p_pred_home   int,
  p_pred_away   int,
  p_actual_home int,
  p_actual_away int
)
RETURNS int
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_pts_exact     int;
  v_pts_outcome   int;
  v_pts_incorrect int;
BEGIN
  -- NULL inputs -> 0 (no valid prediction or unfinished result)
  IF p_pred_home IS NULL OR p_pred_away IS NULL
     OR p_actual_home IS NULL OR p_actual_away IS NULL THEN
    RETURN 0;
  END IF;

  -- Read scoring constants from slice-008 namespace. Fail-closed on WCG06.
  BEGIN
    v_pts_exact     := (public.config_read('scoring.match_points.exact', NULL))::text::int;
    v_pts_outcome   := (public.config_read('scoring.match_points.correct_outcome', NULL))::text::int;
    v_pts_incorrect := (public.config_read('scoring.match_points.incorrect', NULL))::text::int;
  EXCEPTION WHEN SQLSTATE 'WCG06' THEN
    RETURN 0;
  END;

  -- Exact score match
  IF p_pred_home = p_actual_home AND p_pred_away = p_actual_away THEN
    RETURN v_pts_exact;
  END IF;

  -- Correct outcome (sign of goal difference matches)
  IF sign(p_pred_home - p_pred_away) = sign(p_actual_home - p_actual_away) THEN
    RETURN v_pts_outcome;
  END IF;

  RETURN v_pts_incorrect;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.compute_match_score(int, int, int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.compute_match_score(int, int, int, int) TO authenticated, service_role;

COMMIT;

-- ===========================================================================
-- T013 (post-block): Regression smoke fixture — re-run + assert equality
-- ===========================================================================
-- Re-runs the predicates captured in _t013_smoke_pre and RAISES EXCEPTION on
-- any divergence. This is the regression gate per Principle XI: if the
-- consumer-function ALTERs above changed any observable behavior for the
-- captured inputs, the migration aborts here and the entire transaction is
-- rolled back.
--
-- Special case: the eligibility predicate's data source changed from
-- 'eligibility.approved_domains' (slot 0002 seed) to 'eligibility.allowed_domains'
-- (T010 seed). Both keys default to ["nortal.com"], so the per-row results
-- should match. If the deployment has DIVERGED the two seed values, the
-- regression gate will catch it and the operator must reconcile.
-- Similarly, is_prediction_locked moves from 'lock_window_minutes'=60 to
-- 'locking.match_prediction_window_minutes'=60 — same default, same behavior.

BEGIN;

DO $verify$
DECLARE
  r          record;
  v_actual   text;
  v_mismatch int := 0;
BEGIN
  FOR r IN SELECT fn, args, result FROM _t013_smoke_pre LOOP
    IF r.fn = 'is_eligible_nortal_participant' THEN
      v_actual := public.is_eligible_nortal_participant((r.args ->> 'p_uid')::uuid)::text;
    ELSIF r.fn = 'is_prediction_locked' THEN
      v_actual := public.is_prediction_locked((r.args ->> 'p_match_id')::uuid)::text;
    ELSE
      CONTINUE;
    END IF;

    IF v_actual IS DISTINCT FROM r.result THEN
      RAISE WARNING 'T013 regression: % args=% pre=% post=%', r.fn, r.args, r.result, v_actual;
      v_mismatch := v_mismatch + 1;
    END IF;
  END LOOP;

  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'T013 regression gate: % consumer-predicate output(s) diverged after slice-008 migration', v_mismatch
      USING ERRCODE = 'WCG06';
  END IF;
END
$verify$;

-- compute_match_score correctness probe (T016 is newly created; no pre-state
-- to compare against, so we assert against expected values directly).
DO $probe$
DECLARE
  v_exact   int := (public.config_read('scoring.match_points.exact', NULL))::text::int;
  v_outcome int := (public.config_read('scoring.match_points.correct_outcome', NULL))::text::int;
  v_inc     int := (public.config_read('scoring.match_points.incorrect', NULL))::text::int;
  v_res     int;
BEGIN
  -- Exact match
  v_res := public.compute_match_score(2, 1, 2, 1);
  IF v_res <> v_exact THEN
    RAISE EXCEPTION 'T016 probe: compute_match_score(2,1,2,1) returned %, expected % (exact)', v_res, v_exact;
  END IF;

  -- Correct outcome (home win predicted, home win actual, different score)
  v_res := public.compute_match_score(3, 0, 2, 1);
  IF v_res <> v_outcome THEN
    RAISE EXCEPTION 'T016 probe: compute_match_score(3,0,2,1) returned %, expected % (outcome)', v_res, v_outcome;
  END IF;

  -- Incorrect outcome (home win predicted, away win actual)
  v_res := public.compute_match_score(2, 0, 0, 2);
  IF v_res <> v_inc THEN
    RAISE EXCEPTION 'T016 probe: compute_match_score(2,0,0,2) returned %, expected % (incorrect)', v_res, v_inc;
  END IF;

  -- NULL input -> 0
  v_res := public.compute_match_score(NULL, NULL, 0, 0);
  IF v_res <> 0 THEN
    RAISE EXCEPTION 'T016 probe: compute_match_score(NULL,NULL,0,0) returned %, expected 0', v_res;
  END IF;
END
$probe$;

DROP TABLE IF EXISTS _t013_smoke_pre;

COMMIT;

-- ===========================================================================
-- T037: admin_config_get_secret SECURITY DEFINER RPC
-- ===========================================================================
-- Reference: contracts/admin-config-rpcs.write.md § Behavior — admin_config_get_secret.
-- Logic:
--   1. is_admin gate (writes admin.access_denied audit row, raises WCG07).
--   2. key_is_secret(p_key) check (raises WCG03 if false — non-secret keys
--      MUST go through admin_config_upsert's read path which is RLS-gated).
--   3. SELECT the stored value (raises WCG03 if the row is absent).
--   4. Write a forensic admin.config_secret_accessed audit row containing
--      ONLY the key (no secret value — Clarification Q9 / contract § Behavior).
--   5. Return the {secret: true, value: <plain>} jsonb from tournament_config.value.
--
-- D-T037-A: contract states "STABLE" but the function MUST INSERT into
--   audit_log per its own documented behavior. STABLE forbids data-modifying
--   statements; we ship VOLATILE. Contract signature is otherwise verbatim
--   (RETURNS jsonb, LANGUAGE plpgsql, SECURITY DEFINER, SET search_path).
--   Logged as cross-slice deviation; locked signature parameters unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_config_get_secret(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_value jsonb;
BEGIN
  v_actor := auth.uid();

  -- Step 1: authorization
  IF NOT public.is_admin(v_actor) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_actor,
        'admin.access_denied',
        'admin_config_get_secret',
        'api_guard',
        jsonb_build_object('rpc','admin_config_get_secret','key',p_key)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  -- Step 2: key must be in the secret namespace.
  IF NOT public.key_is_secret(p_key) THEN
    RAISE EXCEPTION 'Unknown configuration key %: not a secret-namespace key', p_key
      USING ERRCODE = 'WCG03';
  END IF;

  -- Step 3: fetch the stored value (WCG03 if absent).
  SELECT value INTO v_value
  FROM public.tournament_config
  WHERE key = p_key;

  IF v_value IS NULL THEN
    RAISE EXCEPTION 'Unknown configuration key %', p_key
      USING ERRCODE = 'WCG03';
  END IF;

  -- Step 4: forensic audit row — key only, NEVER the secret value.
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id, source, new_value
  ) VALUES (
    v_actor,
    'admin.config_secret_accessed',
    'tournament_config',
    NULL,
    'api_guard',
    jsonb_build_object('key', p_key)
  );

  RETURN v_value;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_config_get_secret(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_config_get_secret(text) TO authenticated;

COMMIT;

-- ===========================================================================
-- T038: admin_config_grant_admin_role / admin_config_revoke_admin_role
-- ===========================================================================
-- Reference: contracts/admin-config-rpcs.write.md § Behavior — admin role wrappers.
--
-- D-T038-A (CONTRACT DRIFT): The contract states these wrappers "call Slice 006's
--   admin_grant_admin_role / admin_revoke_admin_role internally." Those SPs DO
--   NOT EXIST in any Slice 006 migration — Slice 006 ships the admin_roles table
--   (slot 0060) plus an AFTER INSERT/UPDATE trigger (log_admin_role_change) that
--   auto-writes admin.role_granted / admin.role_revoked audit rows. There is no
--   public.admin_grant_admin_role(uuid,text,text) function.
--
--   Resolution (no slice 006 amendment needed): T038 directly INSERTs/UPDATEs
--   the admin_roles table under the SECURITY DEFINER context. The slice 006
--   trigger fires as a side effect, producing the canonical admin.role_granted /
--   admin.role_revoked audit row. T038 then links a tournament_config_versions
--   row to that audit row via audit_log.id, capturing p_reason +
--   p_source_citation (which the slice 006 trigger does not carry through).
--
--   The contract-locked PARAMETER signature (p_participant_id uuid, p_reason text,
--   p_source_citation text) and RETURN type (uuid / void) are preserved verbatim.
--   Only the contract's PROSE about "calls Slice 006's SP" is amended.
--
-- Audit chain:
--   1. is_admin gate (WCG07) — admin.access_denied on failure (same pattern as
--      admin_config_upsert).
--   2. INSERT/UPDATE admin_roles → trigger writes admin.role_granted /
--      admin.role_revoked audit row (entity_type='admin_role',
--      entity_id=admin_roles.id, source='trigger').
--   3. INSERT tournament_config_versions with key='admin_roles.<participant_id>',
--      change_kind='admin_upsert', linked to the trigger-produced audit row by
--      its id (looked up via the just-inserted admin_roles.id, which is the
--      audit row's entity_id).

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_config_grant_admin_role(
  p_participant_id   uuid,
  p_reason           text,
  p_source_citation  text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor       uuid;
  v_role_id     uuid;
  v_audit_id    uuid;
BEGIN
  v_actor := auth.uid();

  -- Step 1: authorization
  IF NOT public.is_admin(v_actor) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_actor,
        'admin.access_denied',
        'admin_config_grant_admin_role',
        'api_guard',
        jsonb_build_object('rpc','admin_config_grant_admin_role','participant_id',p_participant_id)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  -- Step 2: reason required.
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Reason is required for admin role grants'
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 3: source citation required (admin_roles.* is in the security-sensitive list).
  IF p_source_citation IS NULL OR length(trim(p_source_citation)) = 0 THEN
    RAISE EXCEPTION 'Source citation required for admin role grants'
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 4: insert into admin_roles. Trigger log_admin_role_change writes the
  --         admin.role_granted audit row (source='trigger', entity_id=NEW.id).
  INSERT INTO public.admin_roles (participant_id, granted_by)
  VALUES (p_participant_id, v_actor)
  RETURNING id INTO v_role_id;

  -- Step 5: locate the audit row the trigger just produced (entity_id=role_id,
  --         action='admin.role_granted'). Newest sequence_id wins (defensive
  --         against re-grant cycles).
  SELECT id
    INTO v_audit_id
    FROM public.audit_log
   WHERE action = 'admin.role_granted'
     AND entity_type = 'admin_role'
     AND entity_id = v_role_id
   ORDER BY sequence_id DESC
   LIMIT 1;

  -- Step 6: link a tournament_config_versions row to the audit chain.
  INSERT INTO public.tournament_config_versions (
    key, previous_value, new_value, change_kind,
    actor, reason, source_citation, audit_log_id
  ) VALUES (
    'admin_roles.' || p_participant_id::text,
    jsonb_build_object('admin', false),
    jsonb_build_object('admin', true),
    'admin_upsert',
    v_actor, p_reason, p_source_citation, v_audit_id
  );

  RETURN p_participant_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_config_revoke_admin_role(
  p_participant_id   uuid,
  p_reason           text,
  p_source_citation  text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor       uuid;
  v_role_id     uuid;
  v_audit_id    uuid;
BEGIN
  v_actor := auth.uid();

  -- Step 1: authorization
  IF NOT public.is_admin(v_actor) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_actor,
        'admin.access_denied',
        'admin_config_revoke_admin_role',
        'api_guard',
        jsonb_build_object('rpc','admin_config_revoke_admin_role','participant_id',p_participant_id)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  -- Step 2: reason required.
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Reason is required for admin role revocations'
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 3: source citation required.
  IF p_source_citation IS NULL OR length(trim(p_source_citation)) = 0 THEN
    RAISE EXCEPTION 'Source citation required for admin role revocations'
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 4: update admin_roles (active row → revoked). Trigger writes the
  --         admin.role_revoked audit row on the NULL→NOT NULL transition.
  UPDATE public.admin_roles
     SET revoked_at    = now(),
         revoked_by    = v_actor,
         revoke_reason = p_reason
   WHERE participant_id = p_participant_id
     AND revoked_at IS NULL
   RETURNING id INTO v_role_id;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'No active admin role for participant %', p_participant_id
      USING ERRCODE = 'WCG03';
  END IF;

  -- Step 5: locate the audit row.
  SELECT id
    INTO v_audit_id
    FROM public.audit_log
   WHERE action = 'admin.role_revoked'
     AND entity_type = 'admin_role'
     AND entity_id = v_role_id
   ORDER BY sequence_id DESC
   LIMIT 1;

  -- Step 6: link a tournament_config_versions row.
  INSERT INTO public.tournament_config_versions (
    key, previous_value, new_value, change_kind,
    actor, reason, source_citation, audit_log_id
  ) VALUES (
    'admin_roles.' || p_participant_id::text,
    jsonb_build_object('admin', true),
    jsonb_build_object('admin', false),
    'admin_upsert',
    v_actor, p_reason, p_source_citation, v_audit_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_config_grant_admin_role(uuid, text, text)  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_config_revoke_admin_role(uuid, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_config_grant_admin_role(uuid, text, text)  TO authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_config_revoke_admin_role(uuid, text, text) TO authenticated;

COMMIT;

-- ===========================================================================
-- T046: _config_rollback_retention_horizon + admin_config_rollback
-- ===========================================================================
-- Reference: contracts/admin-config-rpcs.write.md § Behavior — admin_config_rollback.
--
-- Retention horizon semantics (D-T046-A): contract says "defaults to all
-- history kept per Slice 007 retention policy". Slice 007 (slot 0076) seeded
--   audit.retention.policy_kind = 'keep'
--   audit.retention.tournament_end_buffer_months = 12
-- We interpret policy_kind='keep' as "horizon = -infinity" (no rollback ever
-- raises WCG04). Any other policy_kind sets horizon = now() - buffer_months,
-- so versions older than the buffer become un-rollback-able. The default
-- production posture stays at 'keep'; admins who want pruning flip the
-- policy_kind config key. T050 exercises the 'prune' branch.
--
-- Logic per contract:
--   1. is_admin gate (WCG07 + admin.access_denied audit row).
--   2. Reason required (WCG02).
--   3. Target version must exist (WCG03).
--   4. Target's created_at >= retention_horizon() else WCG04.
--   5. Acquire advisory xact lock on hashtext(key).
--   6. Read current state of tournament_config for the target's key.
--   7. Insert audit row with action='tournament_config.<key>',
--        previous_value=<current>, new_value=<target's new_value>,
--        reason = 'Rollback to version N: ' || p_reason.
--   8. Insert versions row with change_kind='admin_rollback',
--        parent_version_id=p_target_version_id, audit_log_id linked.
--   9. Update tournament_config to target value + new version_id.
--  10. Return the new version_id.

BEGIN;

CREATE OR REPLACE FUNCTION public._config_rollback_retention_horizon()
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_policy_kind   text;
  v_buffer_months int;
BEGIN
  -- Default 'keep' policy means all history is eligible for rollback.
  BEGIN
    v_policy_kind := (public.config_read('audit.retention.policy_kind', '"keep"'::jsonb) #>> '{}');
  EXCEPTION WHEN OTHERS THEN
    v_policy_kind := 'keep';
  END;

  IF v_policy_kind IS NULL OR v_policy_kind = 'keep' THEN
    RETURN '-infinity'::timestamptz;
  END IF;

  BEGIN
    v_buffer_months := COALESCE(
      (public.config_read('audit.retention.tournament_end_buffer_months', '12'::jsonb))::text::int,
      12
    );
  EXCEPTION WHEN OTHERS THEN
    v_buffer_months := 12;
  END;

  RETURN now() - (v_buffer_months || ' months')::interval;
END;
$$;

GRANT EXECUTE ON FUNCTION public._config_rollback_retention_horizon() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_config_rollback(
  p_target_version_id  bigint,
  p_reason             text,
  p_source_citation    text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor         uuid;
  v_target_key    text;
  v_target_value  jsonb;
  v_target_created timestamptz;
  v_horizon       timestamptz;
  v_current_value jsonb;
  v_audit_id      uuid;
  v_new_version   bigint;
BEGIN
  v_actor := auth.uid();

  -- Step 1: authorization
  IF NOT public.is_admin(v_actor) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_actor,
        'admin.access_denied',
        'admin_config_rollback',
        'api_guard',
        jsonb_build_object('rpc','admin_config_rollback','target_version_id',p_target_version_id)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  -- Step 2: reason required
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Reason is required for configuration rollbacks'
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 3: target must exist; capture its key/value/created_at
  SELECT key, new_value, created_at
    INTO v_target_key, v_target_value, v_target_created
    FROM public.tournament_config_versions
   WHERE version_id = p_target_version_id;

  IF v_target_key IS NULL THEN
    RAISE EXCEPTION 'Rollback target version % does not exist', p_target_version_id
      USING ERRCODE = 'WCG03';
  END IF;

  -- Step 4: retention horizon check.
  v_horizon := public._config_rollback_retention_horizon();
  IF v_target_created < v_horizon THEN
    RAISE EXCEPTION 'Rollback target version % exceeds retention horizon %', p_target_version_id, v_horizon
      USING ERRCODE = 'WCG04';
  END IF;

  -- Step 5: advisory lock on the affected key
  PERFORM pg_advisory_xact_lock(hashtext(v_target_key));

  -- Step 6: read current value (also serves as FOR UPDATE lock on the row)
  SELECT value
    INTO v_current_value
    FROM public.tournament_config
   WHERE key = v_target_key
   FOR UPDATE;

  -- If the key was deleted between target capture and rollback (we have no
  -- DELETE policy, so this is defensive), surface as WCG03.
  IF v_current_value IS NULL THEN
    RAISE EXCEPTION 'Rollback target key % is no longer present in tournament_config', v_target_key
      USING ERRCODE = 'WCG03';
  END IF;

  -- Step 7: audit row carrying the canonical prefixed reason.
  INSERT INTO public.audit_log (
    actor, action, entity_type, entity_id,
    previous_value, new_value, reason, source, source_citation
  ) VALUES (
    v_actor,
    'tournament_config.' || v_target_key,
    'tournament_config',
    NULL,
    v_current_value,
    v_target_value,
    'Rollback to version ' || p_target_version_id || ': ' || p_reason,
    'api_guard',
    p_source_citation
  )
  RETURNING id INTO v_audit_id;

  -- Step 8: versions row capturing the rollback as a new write.
  INSERT INTO public.tournament_config_versions (
    key, previous_value, new_value, change_kind,
    actor, reason, source_citation, audit_log_id,
    parent_version_id
  ) VALUES (
    v_target_key,
    v_current_value,
    v_target_value,
    'admin_rollback',
    v_actor,
    'Rollback to version ' || p_target_version_id || ': ' || p_reason,
    p_source_citation,
    v_audit_id,
    p_target_version_id
  )
  RETURNING version_id INTO v_new_version;

  -- Step 9: stamp the new value + version onto tournament_config.
  UPDATE public.tournament_config
     SET value = v_target_value,
         version_id = v_new_version,
         updated_at = now()
   WHERE key = v_target_key;

  -- Step 10
  RETURN v_new_version;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_config_rollback(bigint, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_config_rollback(bigint, text, text) TO authenticated;

COMMIT;

-- ===========================================================================
-- T047: config_version_history(p_key, p_limit, p_offset) RETURNS TABLE
-- ===========================================================================
-- Reference: contracts/config-version-history.read.md § Behavior — config_version_history.
-- Read-only enumeration. NO audit row on success (high-volume; would be noisy).
-- WCG07 on non-admin; WCG02 on invalid p_limit/p_offset.

BEGIN;

CREATE OR REPLACE FUNCTION public.config_version_history(
  p_key     text DEFAULT NULL,
  p_limit   int  DEFAULT 50,
  p_offset  int  DEFAULT 0
)
RETURNS TABLE (
  version_id              bigint,
  key                     text,
  previous_value          jsonb,
  new_value               jsonb,
  change_kind             text,
  actor                   uuid,
  reason                  text,
  source_citation         text,
  audit_log_id            uuid,
  parent_version_id       bigint,
  acknowledge_token_used  uuid,
  created_at              timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
BEGIN
  v_actor := auth.uid();

  -- Authorization
  IF NOT public.is_admin(v_actor) THEN
    -- D-T047-A: contract says STABLE but admin.access_denied audit on denial
    -- requires an INSERT. We emit the audit row via a separate function call
    -- to keep this body STABLE — denial path RAISEs WCG07 with no audit
    -- (the route layer / RLS layer logs the denial separately).
    --
    -- Trade-off: drops the in-body audit row on denial vs preserving the
    -- contract-locked STABLE volatility. Route handlers should write the
    -- audit row themselves via the existing admin.access_denied helper.
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  -- Input validation
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 500 (got %)', p_limit
      USING ERRCODE = 'WCG02';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'p_offset must be >= 0 (got %)', p_offset
      USING ERRCODE = 'WCG02';
  END IF;

  RETURN QUERY
  SELECT
    v.version_id, v.key, v.previous_value, v.new_value, v.change_kind,
    v.actor, v.reason, v.source_citation, v.audit_log_id,
    v.parent_version_id, v.acknowledge_token_used, v.created_at
  FROM public.tournament_config_versions v
  WHERE (p_key IS NULL OR v.key = p_key)
  ORDER BY v.version_id DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.config_version_history(text, int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.config_version_history(text, int, int) TO authenticated;

COMMIT;

-- ===========================================================================
-- T052: admin_config_export — signed JSON envelope of current config + history
-- ===========================================================================
-- Reference: contracts/config-version-history.read.md § Behavior — admin_config_export.
--
-- Signature strategy (D-T052-A): the contract spec references a helper
-- `canonical_jsonb_to_bytea` which does not ship in Postgres. We instead rely
-- on Postgres' built-in deterministic text representation of jsonb: `::text`
-- produces keys-sorted, minimal-whitespace output. The signer T057
-- (sign-import.sh) and the verifier T053 both compute HMAC-SHA256 over the
-- result of `(envelope - 'signature')::text`. Edge cases where jq's `-c -S`
-- canonical form diverges from Postgres jsonb text output (numeric formatting,
-- escape sequences) are surfaced as WCG08 signature mismatch.
--
-- D-T052-B: contract says STABLE but the body INSERTs an admin.config_exported
-- audit row. Same trade-off as T037/T046 — ship VOLATILE, document drift.
--
-- GUC dependency: `app.config_export_secret` must be set at the Supabase
-- project level (env var → role-level SET). Reads via current_setting(...,true)
-- so missing GUC returns NULL and we surface WCG08 rather than crash. Production
-- deployment runbook is T075.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_config_export()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor            uuid;
  v_secret           text;
  v_environment      text;
  v_current_config   jsonb;
  v_version_history  jsonb;
  v_key_count        int;
  v_body             jsonb;
  v_signature_hex    text;
  v_envelope         jsonb;
BEGIN
  v_actor := auth.uid();

  -- Step 1: authorization
  IF NOT public.is_admin(v_actor) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_actor,
        'admin.access_denied',
        'admin_config_export',
        'api_guard',
        jsonb_build_object('rpc','admin_config_export')
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  -- Step 2: read the signing secret. Empty → WCG08 (refuse to export an
  -- unsigned envelope; security posture).
  v_secret := current_setting('app.config_export_secret', true);
  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE EXCEPTION 'app.config_export_secret GUC is not configured; refusing to export'
      USING ERRCODE = 'WCG08';
  END IF;

  v_environment := COALESCE(current_setting('app.environment_label', true), 'unknown');

  -- Step 3: build current_config with secret redaction.
  SELECT COALESCE(jsonb_object_agg(
    key,
    CASE WHEN public.key_is_secret(key)
         THEN jsonb_build_object('secret', true, 'value', NULL)
         ELSE value
    END
  ), '{}'::jsonb)
    INTO v_current_config
    FROM public.tournament_config;

  v_key_count := jsonb_array_length(COALESCE(jsonb_path_query_array(v_current_config, '$.keyvalue().key'), '[]'::jsonb));

  -- Step 4: full version history (chronological).
  SELECT COALESCE(jsonb_agg(to_jsonb(v.*) ORDER BY v.version_id ASC), '[]'::jsonb)
    INTO v_version_history
    FROM public.tournament_config_versions v;

  -- Step 5: assemble body (sans signature) for hashing.
  v_body := jsonb_build_object(
    'schema_version',  '1.0.0',
    'exported_at',     now()::text,
    'exported_by',     v_actor::text,
    'environment',     v_environment,
    'current_config',  v_current_config,
    'version_history', v_version_history
  );

  -- Step 6: HMAC-SHA256 over the deterministic text form of the body.
  v_signature_hex := encode(
    extensions.hmac(v_body::text::bytea, v_secret::bytea, 'sha256'),
    'hex'
  );

  v_envelope := v_body || jsonb_build_object('signature', v_signature_hex);

  -- Step 7: forensic audit row.
  INSERT INTO public.audit_log (
    actor, action, entity_type, source, new_value
  ) VALUES (
    v_actor,
    'admin.config_exported',
    'tournament_config',
    'api_guard',
    jsonb_build_object(
      'key_count',     v_key_count,
      'environment',   v_environment,
      'schema_version','1.0.0'
    )
  );

  RETURN v_envelope;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_config_export() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_config_export() TO authenticated;

COMMIT;

-- ===========================================================================
-- T053: admin_config_import — verify signature, validate all keys, bulk apply
-- ===========================================================================
-- Reference: contracts/config-import.write.md.
--
-- Atomicity: the whole import runs inside the SECURITY DEFINER body (which is
-- one statement-level transaction wrapped by the caller). A WCG08 raise
-- before/during the per-key loop rolls back every INSERT/UPDATE.
--
-- Acknowledge-token bypass: per contract, bulk-import deliberately SKIPS the
-- per-key affecting acknowledge_token check. An admin running an import has
-- already vetted the source.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_config_import(
  p_envelope  jsonb,
  p_reason    text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor              uuid;
  v_secret             text;
  v_body               jsonb;
  v_signature_hex      text;
  v_expected_signature text;
  v_schema_version     text;
  v_environment        text;
  v_audit_id           uuid;
  v_key                text;
  v_value              jsonb;
  v_previous_value     jsonb;
  v_new_version        bigint;
  v_imported_keys      int := 0;
  v_version_ids        bigint[] := ARRAY[]::bigint[];
  v_skipped_keys       jsonb := '[]'::jsonb;
  v_validation_errors  jsonb := '[]'::jsonb;
BEGIN
  v_actor := auth.uid();

  -- Step 1: authorization
  IF NOT public.is_admin(v_actor) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_actor,
        'admin.access_denied',
        'admin_config_import',
        'api_guard',
        jsonb_build_object('rpc','admin_config_import')
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  -- Step 2: reason required
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Reason is required for configuration imports'
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 3: schema_version check
  v_schema_version := p_envelope ->> 'schema_version';
  IF v_schema_version IS DISTINCT FROM '1.0.0' THEN
    RAISE EXCEPTION 'Import envelope schema_version % is not supported; expected 1.0.0', v_schema_version
      USING ERRCODE = 'WCG08';
  END IF;

  -- Step 4: signature verification
  v_signature_hex := p_envelope ->> 'signature';
  IF v_signature_hex IS NULL OR length(v_signature_hex) = 0 THEN
    RAISE EXCEPTION 'Import envelope missing signature' USING ERRCODE = 'WCG08';
  END IF;

  v_secret := current_setting('app.config_export_secret', true);
  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE EXCEPTION 'app.config_export_secret GUC is not configured; refusing to import'
      USING ERRCODE = 'WCG08';
  END IF;

  v_body := p_envelope - 'signature';
  v_expected_signature := encode(
    extensions.hmac(v_body::text::bytea, v_secret::bytea, 'sha256'),
    'hex'
  );
  IF v_expected_signature IS DISTINCT FROM v_signature_hex THEN
    RAISE EXCEPTION 'Import envelope signature invalid' USING ERRCODE = 'WCG08';
  END IF;

  -- Step 5: per-key validation aggregate (collect ALL failures before raising).
  FOR v_key, v_value IN
    SELECT key, value FROM jsonb_each(p_envelope -> 'current_config')
  LOOP
    -- Skip secret-redacted entries (don't validate the null placeholder).
    IF public.key_is_secret(v_key)
       AND (v_value ->> 'value') IS NULL
       AND COALESCE((v_value ->> 'secret')::boolean, false) = true THEN
      CONTINUE;
    END IF;

    -- Apply the same backstop CASE dispatcher as admin_config_upsert step 3.
    -- We inline the per-key checks here (rather than calling admin_config_upsert
    -- one-by-one) so the import remains a single atomic write.
    BEGIN
      CASE
        WHEN v_key = 'eligibility.allowed_domains' THEN
          IF jsonb_typeof(v_value) <> 'array' THEN
            RAISE EXCEPTION 'must be a jsonb array';
          END IF;
        WHEN v_key = 'locking.match_prediction_window_minutes' THEN
          IF jsonb_typeof(v_value) <> 'number'
             OR (v_value)::text::int < 1
             OR (v_value)::text::int > 1440 THEN
            RAISE EXCEPTION 'must be integer 1..1440';
          END IF;
        WHEN v_key LIKE 'scoring.match_points.%'
          OR v_key = 'scoring.final_pick_points'
          OR v_key = 'scoring.score_upper_bound' THEN
          IF jsonb_typeof(v_value) <> 'number'
             OR (v_value)::text::int < 0 THEN
            RAISE EXCEPTION 'must be non-negative integer';
          END IF;
        WHEN v_key = 'scoring.tie_breaker_order' THEN
          IF jsonb_typeof(v_value) <> 'array' THEN
            RAISE EXCEPTION 'must be a jsonb array of tier names';
          END IF;
        WHEN v_key = 'tournament.phase.current' THEN
          IF jsonb_typeof(v_value) <> 'string'
             OR (v_value #>> '{}') NOT IN ('pre_tournament','group_stage','knockout','completed') THEN
            RAISE EXCEPTION 'must be one of pre_tournament|group_stage|knockout|completed';
          END IF;
        ELSE
          -- Unknown / forward-compatible keys pass without backstop validation.
          NULL;
      END CASE;
    EXCEPTION WHEN OTHERS THEN
      v_validation_errors := v_validation_errors || jsonb_build_object(
        'key',    v_key,
        'value',  v_value,
        'reason', SQLERRM
      );
    END;
  END LOOP;

  IF jsonb_array_length(v_validation_errors) > 0 THEN
    RAISE EXCEPTION 'Import validation failed for % keys: %',
      jsonb_array_length(v_validation_errors),
      v_validation_errors::text
      USING ERRCODE = 'WCG08';
  END IF;

  v_environment := p_envelope ->> 'environment';

  -- Step 6: single audit row for the whole bulk import.
  INSERT INTO public.audit_log (
    actor, action, entity_type, source,
    previous_value, new_value, reason, source_citation
  )
  VALUES (
    v_actor, 'admin.config_imported', 'tournament_config', 'api_guard',
    NULL,
    jsonb_build_object(
      'source_environment', v_environment,
      'exported_at',        p_envelope ->> 'exported_at',
      'exported_by',        p_envelope ->> 'exported_by',
      'schema_version',     v_schema_version,
      'key_count',          (SELECT count(*)::int FROM jsonb_each(p_envelope -> 'current_config'))
    ),
    p_reason,
    'config-import: ' || COALESCE(v_environment, 'unknown')
  )
  RETURNING id INTO v_audit_id;

  -- Step 7: iterate keys, upsert version + tournament_config.
  FOR v_key, v_value IN
    SELECT key, value FROM jsonb_each(p_envelope -> 'current_config')
  LOOP
    IF public.key_is_secret(v_key)
       AND (v_value ->> 'value') IS NULL
       AND COALESCE((v_value ->> 'secret')::boolean, false) = true THEN
      v_skipped_keys := v_skipped_keys || to_jsonb(v_key);
      CONTINUE;
    END IF;

    SELECT value INTO v_previous_value
      FROM public.tournament_config
      WHERE key = v_key;

    INSERT INTO public.tournament_config_versions (
      key, previous_value, new_value, change_kind,
      actor, reason, source_citation, audit_log_id
    )
    VALUES (
      v_key, v_previous_value, v_value, 'import_bulk',
      v_actor, p_reason,
      'config-import: ' || COALESCE(v_environment, 'unknown'),
      v_audit_id
    )
    RETURNING version_id INTO v_new_version;

    v_version_ids := array_append(v_version_ids, v_new_version);
    v_imported_keys := v_imported_keys + 1;

    INSERT INTO public.tournament_config (key, value, value_type, updated_at, version_id)
    VALUES (v_key, v_value, 'jsonb', now(), v_new_version)
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at,
          version_id = EXCLUDED.version_id;
  END LOOP;

  RETURN jsonb_build_object(
    'imported_keys', v_imported_keys,
    'version_ids',   to_jsonb(v_version_ids),
    'skipped_keys',  v_skipped_keys
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_config_import(jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_config_import(jsonb, text) TO authenticated;

COMMIT;

-- ===========================================================================
-- T061: notification_dispatch_queue
-- ===========================================================================
-- Reference: contracts/audit-failure-webhook.outbound.md §Tables.
-- Closes Slice 007's deferred SC-007 (5-minute audit-failure alert delivery).
-- Privilege posture mirrors audit_log: app roles have NO access; only SECURITY
-- DEFINER paths (enqueue_alert) write rows.

BEGIN;

CREATE TABLE IF NOT EXISTS public.notification_dispatch_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL,
  payload         jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz NULL,
  failed_at       timestamptz NULL,
  last_error      text NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Partial index over rows still eligible for dispatch (delivered_at/failed_at NULL).
CREATE INDEX IF NOT EXISTS notification_dispatch_queue_pending_idx
  ON public.notification_dispatch_queue (next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;

-- Privilege posture: app roles have no access. SECURITY DEFINER functions
-- (enqueue_alert + dispatch_pending_alerts) bypass via DEFINER ownership.
REVOKE ALL ON public.notification_dispatch_queue FROM authenticated, anon;

COMMIT;

-- ===========================================================================
-- T062: enqueue_alert(p_alert_kind, p_summary, p_details, p_audit_log_id)
-- ===========================================================================
-- Reference: contracts/audit-failure-webhook.outbound.md §Enqueue path.
-- No-op (returns NULL) when notifications.audit_failure_webhook_url is unset
-- — keeps every audit-write call site fail-soft when webhook delivery is not
-- yet configured.

BEGIN;

CREATE OR REPLACE FUNCTION public.enqueue_alert(
  p_alert_kind   text,
  p_summary      text,
  p_details      jsonb,
  p_audit_log_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id  uuid;
  v_url text;
BEGIN
  -- Read the webhook URL fail-soft. If config_read raises (WCG06: key absent
  -- AND no default), we treat that as "not configured" and no-op.
  BEGIN
    v_url := public.config_read('notifications.audit_failure_webhook_url', 'null'::jsonb) #>> '{}';
  EXCEPTION WHEN OTHERS THEN
    v_url := NULL;
  END;

  IF v_url IS NULL OR length(v_url) = 0 OR v_url = 'null' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notification_dispatch_queue (channel, payload)
  VALUES (
    'webhook:audit_failure',
    jsonb_build_object(
      'schema_version', '1.0.0',
      'alert_kind',     p_alert_kind,
      'environment',    COALESCE(current_setting('app.environment_label', true), 'unknown'),
      'occurred_at',    now()::text,
      'summary',        p_summary,
      'details',        p_details,
      'audit_log_id',   p_audit_log_id
    )
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_alert(text, text, jsonb, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.enqueue_alert(text, text, jsonb, uuid) TO authenticated, service_role;

COMMIT;

-- ===========================================================================
-- T063: dispatch_pending_alerts() — pg_net delivery worker
-- ===========================================================================
-- Reference: contracts/audit-failure-webhook.outbound.md §Delivery worker.
-- Walks the queue in created_at order (LIMIT 50 per tick), HMAC-signs each
-- payload, POSTs via pg_net.http_post with a 10s timeout, then schedules an
-- exponential-backoff retry. Rows that exhaust max_attempts get failed_at
-- stamped.
--
-- D-T063-A: contract refers to `canonical_jsonb_to_bytea` helper (does not
-- ship in Postgres). Same fallback as T052/T053: use payload::text::bytea.
-- The receiving endpoint must compute the HMAC over the same canonical form.
--
-- D-T063-B: the contract describes a separate trigger on net._http_response
-- that finalizes delivered_at on 2xx and failed_at on 4xx. pg_net's response
-- table is async and Supabase-managed; the trigger lives outside the
-- migration's transactional scope. This migration ships the dispatch tick
-- WITHOUT the response-side finalizer — the queue row's attempts counter
-- still increments and exponential backoff still fires, but delivered_at
-- remains NULL until the operator wires the response trigger (documented in
-- T075 runbook).

BEGIN;

CREATE OR REPLACE FUNCTION public.dispatch_pending_alerts()
RETURNS int
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_url         text;
  v_secret      text;
  v_row         record;
  v_signed_body jsonb;
  v_request_id  bigint;
  v_dispatched  int := 0;
BEGIN
  BEGIN
    v_url := public.config_read('notifications.audit_failure_webhook_url', 'null'::jsonb) #>> '{}';
  EXCEPTION WHEN OTHERS THEN
    v_url := NULL;
  END;

  IF v_url IS NULL OR length(v_url) = 0 OR v_url = 'null' THEN
    RETURN 0;
  END IF;

  BEGIN
    v_secret := public.config_read('notifications.audit_failure_webhook_secret', 'null'::jsonb) #>> '{}';
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  FOR v_row IN
    SELECT id, payload, attempts, max_attempts
    FROM public.notification_dispatch_queue
    WHERE delivered_at IS NULL
      AND failed_at IS NULL
      AND next_attempt_at <= now()
    ORDER BY created_at ASC
    LIMIT 50
  LOOP
    -- Sign the payload (omits signature → recompute on receiver).
    -- Empty secret → signature placeholder; receiver should treat unsigned
    -- envelopes as untrusted (informational only) per contract.
    IF v_secret IS NULL OR length(v_secret) = 0 THEN
      v_signed_body := v_row.payload || jsonb_build_object('signature', NULL);
    ELSE
      v_signed_body := v_row.payload || jsonb_build_object(
        'signature',
        encode(extensions.hmac(v_row.payload::text::bytea, v_secret::bytea, 'sha256'), 'hex')
      );
    END IF;

    BEGIN
      -- Schema-qualified to pg_net's installed location (slot 0018 → extensions schema).
      SELECT extensions.http_post(
        url     := v_url,
        body    := v_signed_body,
        headers := jsonb_build_object('Content-Type', 'application/json'),
        timeout_milliseconds := 10000
      ) INTO v_request_id;

      UPDATE public.notification_dispatch_queue
         SET attempts        = attempts + 1,
             next_attempt_at = now() + ((attempts + 1) * interval '60 seconds')
       WHERE id = v_row.id;

      v_dispatched := v_dispatched + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.notification_dispatch_queue
         SET attempts        = attempts + 1,
             last_error      = SQLERRM,
             next_attempt_at = now() + ((attempts + 1) * interval '60 seconds')
       WHERE id = v_row.id;
    END;
  END LOOP;

  -- Sweep exhausted-attempt rows into failed_at terminal state.
  UPDATE public.notification_dispatch_queue
     SET failed_at = now()
   WHERE delivered_at IS NULL
     AND failed_at   IS NULL
     AND attempts   >= max_attempts;

  RETURN v_dispatched;
END;
$$;

-- dispatch_pending_alerts is called by pg_cron only; no app-role grants.
REVOKE EXECUTE ON FUNCTION public.dispatch_pending_alerts() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.dispatch_pending_alerts() TO service_role;

COMMIT;

-- ===========================================================================
-- T064: pg_cron schedule
-- ===========================================================================
-- Reference: contracts/audit-failure-webhook.outbound.md §Delivery worker.
-- 30-second cadence to meet SC-007's 5-minute target with retry margin
-- (worst-case: 30s tick + 10s pg_net timeout + 1m exponential backoff × ~3
-- retries ≈ ~4-5 min). Supabase's pg_cron supports 6-field crontab syntax
-- (seconds + 5 traditional fields).
--
-- D-T064-A: dropping/recreating the schedule is idempotent via the unique
-- jobname constraint. If the cron extension is unavailable at migration time
-- (very rare; slot 0018 enables it), the SELECT raises — we catch + skip
-- so dev environments without pg_cron still apply.

BEGIN;

DO $cron$
BEGIN
  -- Unschedule first (idempotent), then schedule.
  BEGIN
    PERFORM cron.unschedule('tournament-config-alert-dispatcher');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    PERFORM cron.schedule(
      'tournament-config-alert-dispatcher',
      '*/30 * * * * *',
      $cron_body$SELECT public.dispatch_pending_alerts();$cron_body$
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule failed (likely missing extension in dev env): %', SQLERRM;
  END;
END
$cron$;

COMMIT;

-- ===========================================================================
-- T065: audit-writer EXCEPTION wrappers (audit_write_failure alert routing)
-- ===========================================================================
-- Reference: contracts/audit-failure-webhook.outbound.md §Enqueue path bullet 1.
--
-- T062 shipped public.enqueue_alert(p_alert_kind, p_summary, p_details,
-- p_audit_log_id) which is fail-soft: returns NULL no-op when
-- notifications.audit_failure_webhook_url is unset, so the call is safe in
-- every environment. T065 wires the highest-traffic / business-critical
-- audit_log INSERT writers across slices 001-006 + this slice to route
-- write failures through that alert path.
--
-- Wrapping pattern (applied uniformly):
--
--   BEGIN
--     INSERT INTO public.audit_log (...) VALUES (...);
--   EXCEPTION WHEN OTHERS THEN
--     -- Best-effort alert (enqueue_alert is itself fail-soft).
--     BEGIN
--       PERFORM public.enqueue_alert(
--         'audit_write_failure',
--         'audit_log INSERT failed in <writer_name>',
--         jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
--                            'writer', '<writer_name>'),
--         NULL
--       );
--     EXCEPTION WHEN OTHERS THEN
--       NULL;  -- never let alert path masquerade as the primary failure
--     END;
--     RAISE;   -- propagate so the business transaction aborts atomically
--   END;
--
-- For audit writers that are ALREADY wrapped in BEGIN/EXCEPTION/NULL
-- (intentional fire-and-forget — e.g. admin.access_denied paths), the swallow
-- semantic is preserved. We UPGRADE such sites to call enqueue_alert BEFORE
-- the NULL so an operator gets paged but the denial RAISE still fires.
--
-- Function bodies are otherwise BYTE-IDENTICAL to the source migrations.
-- CREATE OR REPLACE makes this block idempotent on re-run.
--
-- Inventory (slices 001-006 + 008 audit_log INSERT writers — see also the
-- T065 final report appended to the slice 008 phase 8b notes):
--   PATCHED IN THIS BLOCK (top-5 criticality):
--     [001] public.participants_write_audit                (slot 0008)
--     [001] public.handle_auth_user_created                (slot 0009)
--     [001] public.handle_auth_user_signed_in              (slot 0009)
--     [006] public.log_admin_role_change                   (slot 0060)
--     [008] public.admin_config_upsert                     (slot 0077 above)
--
--   DEFERRED to a future polish pass (lower-frequency admin RPC success
--   paths; the access-denied INSERTs in these RPCs are already wrapped in
--   BEGIN/EXCEPTION/NULL — those would be UPGRADED, not introduced):
--     [006] admin_record_match_result          (slot 0064)
--     [006] admin_update_match                 (slot 0065)
--     [006] admin_submit_prediction            (slot 0066)
--     [006] admin_submit_final_prediction      (slot 0067)
--     [006] admin_update_tournament_award      (slot 0068)
--     [006] admin_resolve_match_pending_review (slot 0069)
--     [006] admin_trigger_recalc               (slot 0070)
--     [006] reap_stale_recalc_runs             (slot 0072)
--     [002] catalog audit triggers             (slot 0025)
--     [002] predictions/final/score audit triggers (slots 0033/0043/0055)
--     [002] kickoff/first-kickoff correction triggers (slots 0036/0046)
--     [002] record_match_result audit row      (slot 0024 — naked)
--     [002] submit_*_prediction supersede rows (slots 0037/0048)
--     [007] admin_audit_trail readers          (slot 0076 — read-only RPC,
--           no audit writes)
--     [008] admin_config_get_secret + admin_config_grant/revoke_admin_role
--           (slot 0077 above)
--
-- All deferred writers continue to function — their failure modes raise
-- through to the calling business transaction, which is the pre-T065
-- baseline behaviour. The deferred work is purely about routing operator
-- visibility through enqueue_alert.

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) public.participants_write_audit  — slice 001, slot 0008
-- ---------------------------------------------------------------------------
-- Trigger function on public.participants AFTER INSERT OR UPDATE.
-- Body preserved byte-identical to slot 0008 apart from the EXCEPTION wraps.
CREATE OR REPLACE FUNCTION public.participants_write_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Provisioning path (auth hook on first eligible sign-in). The auth hook
    -- also writes an `access.granted` row from its own SECURITY DEFINER path;
    -- this trigger guarantees the `participant.created` audit row is present
    -- in the same transaction as the row insert, regardless of hook wiring.
    BEGIN
      INSERT INTO public.audit_log (
        actor,
        action,
        entity_type,
        entity_id,
        previous_value,
        new_value,
        source
      ) VALUES (
        NEW.auth_user_id,
        'participant.created',
        'participant',
        NEW.id,
        NULL,
        to_jsonb(NEW),
        'trigger'
      );
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.enqueue_alert(
          'audit_write_failure',
          'audit_log INSERT failed in participants_write_audit (INSERT branch)',
          jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                             'writer', 'participants_write_audit',
                             'tg_op', 'INSERT',
                             'participant_id', NEW.id),
          NULL
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      RAISE;
    END;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Skip no-op UPDATEs (e.g. SET display_name = display_name) so the audit
    -- log doesn't accumulate noise rows. row(...) IS DISTINCT FROM row(...)
    -- is NULL-safe whole-row comparison.
    IF row(NEW.*) IS DISTINCT FROM row(OLD.*) THEN
      BEGIN
        INSERT INTO public.audit_log (
          actor,
          action,
          entity_type,
          entity_id,
          previous_value,
          new_value,
          source
        ) VALUES (
          -- Prefer the calling user's JWT subject when available (admin edits,
          -- API guard paths). Fall back to the participant's own auth_user_id
          -- so trigger-only paths (e.g. the auth hook's last_login_at refresh,
          -- which runs SECURITY DEFINER without a meaningful auth.uid()) still
          -- record a non-NULL actor whenever possible. NULL remains acceptable
          -- per the audit_log schema (actor uuid NULL).
          COALESCE(auth.uid(), NEW.auth_user_id),
          'participant.updated',
          'participant',
          NEW.id,
          to_jsonb(OLD),
          to_jsonb(NEW),
          'trigger'
        );
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          PERFORM public.enqueue_alert(
            'audit_write_failure',
            'audit_log INSERT failed in participants_write_audit (UPDATE branch)',
            jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                               'writer', 'participants_write_audit',
                               'tg_op', 'UPDATE',
                               'participant_id', NEW.id),
            NULL
          );
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
        RAISE;
      END;
    END IF;
  END IF;

  -- AFTER triggers ignore the return value but plpgsql requires one.
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- (2) public.handle_auth_user_created  — slice 001, slot 0009
-- ---------------------------------------------------------------------------
-- Supabase before_user_created hook. Four audit INSERT sites:
--   * missing_claims    (DENY path — RAISE not used; function returns reject)
--   * domain_not_approved (DENY path — same)
--   * access.granted    (CONTINUE path)
-- All three are wrapped to alert + RE-RAISE on failure. The function's
-- decision envelope already lives downstream of those INSERTs; if the audit
-- write fails, raising aborts the auth transaction (correct: the eligibility
-- decision MUST be durably audited, per Constitution Principle V).
CREATE OR REPLACE FUNCTION public.handle_auth_user_created(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
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

  v_display_name := COALESCE(
    NULLIF(v_metadata ->> 'display_name', ''),
    NULLIF(v_metadata ->> 'name', ''),
    NULLIF(v_metadata ->> 'given_name', ''),
    NULLIF(v_metadata ->> 'preferred_username', ''),
    NULLIF(split_part(COALESCE(v_email, ''), '@', 1), '')
  );

  v_region := NULLIF(v_metadata ->> 'region', '');

  -- ---- Step 2: claim presence check ----
  IF v_user_id IS NULL OR v_email IS NULL OR trim(v_email) = '' THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, entity_id,
        previous_value, new_value, reason, source
      ) VALUES (
        NULL, 'access.denied', NULL, NULL,
        NULL, event, 'missing_claims', 'auth_hook'
      );
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.enqueue_alert(
          'audit_write_failure',
          'audit_log INSERT failed in handle_auth_user_created (missing_claims)',
          jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                             'writer', 'handle_auth_user_created',
                             'branch', 'missing_claims'),
          NULL
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      RAISE;
    END;

    RETURN jsonb_build_object(
      'decision', 'reject',
      'message', 'missing required identity claims'
    );
  END IF;

  -- ---- Step 3: eligibility (domain) check ----
  IF NOT public.is_approved_domain(v_email) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, entity_id,
        previous_value, new_value, reason, source
      ) VALUES (
        NULL, 'access.denied', NULL, NULL,
        NULL,
        jsonb_build_object('user_id', v_user_id, 'email', v_email),
        'domain_not_approved', 'auth_hook'
      );
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.enqueue_alert(
          'audit_write_failure',
          'audit_log INSERT failed in handle_auth_user_created (domain_not_approved)',
          jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                             'writer', 'handle_auth_user_created',
                             'branch', 'domain_not_approved'),
          NULL
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      RAISE;
    END;

    RETURN jsonb_build_object(
      'decision', 'reject',
      'message', 'domain not approved'
    );
  END IF;

  -- ---- Step 4: idempotent provisioning ----
  INSERT INTO public.participants (
    auth_user_id, email, display_name, region, status
  ) VALUES (
    v_user_id, v_email, v_display_name, v_region, 'active'
  )
  ON CONFLICT ON CONSTRAINT participants_auth_user_id_uk DO UPDATE
    SET last_login_at = now()
  RETURNING id INTO v_participant_id;

  -- ---- Step 5: write the auth-decision audit row ----
  BEGIN
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
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      PERFORM public.enqueue_alert(
        'audit_write_failure',
        'audit_log INSERT failed in handle_auth_user_created (access.granted)',
        jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                           'writer', 'handle_auth_user_created',
                           'branch', 'access.granted',
                           'participant_id', v_participant_id),
        NULL
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE;
  END;

  -- ---- Step 6: continue ----
  RETURN jsonb_build_object('decision', 'continue');
END;
$$;

-- ---------------------------------------------------------------------------
-- (3) public.handle_auth_user_signed_in  — slice 001, slot 0009
-- ---------------------------------------------------------------------------
-- Supabase custom_access_token hook (D-001 / D-005). Four audit INSERT sites:
--   * access.denied (deactivated)
--   * access.denied (domain_not_approved on stored email)
--   * participant.email_drift
--   * access.granted (success path)
-- All wrapped to alert + RE-RAISE. The auth transaction is the right scope
-- to abort if the audit row cannot be durably recorded.
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

  v_display_name := COALESCE(
    NULLIF(v_claims -> 'user_metadata' ->> 'display_name', ''),
    NULLIF(v_claims -> 'user_metadata' ->> 'name', ''),
    NULLIF(v_claims -> 'user_metadata' ->> 'given_name', ''),
    NULLIF(v_claims -> 'user_metadata' ->> 'preferred_username', '')
  );

  v_region := NULLIF(v_claims -> 'user_metadata' ->> 'region', '');

  -- ---- Step 1a: defensive guard on missing user_id ----
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

    SELECT * INTO v_participant
      FROM public.participants
     WHERE auth_user_id = v_user_id;
  END IF;

  -- ---- Step 4: deactivated check ----
  IF v_participant.status = 'deactivated' THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, entity_id,
        previous_value, new_value, reason, source
      ) VALUES (
        v_participant.id, 'access.denied', 'participant', v_participant.id,
        NULL,
        jsonb_build_object('user_id', v_user_id::text, 'email', v_email),
        'deactivated', 'auth_hook'
      );
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.enqueue_alert(
          'audit_write_failure',
          'audit_log INSERT failed in handle_auth_user_signed_in (deactivated)',
          jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                             'writer', 'handle_auth_user_signed_in',
                             'branch', 'deactivated',
                             'participant_id', v_participant.id),
          NULL
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      RAISE;
    END;

    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message',   'This account is currently deactivated.'
      )
    );
  END IF;

  -- ---- Step 5: domain re-check on STORED email ----
  IF NOT public.is_approved_domain(v_participant.email) THEN
    BEGIN
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
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.enqueue_alert(
          'audit_write_failure',
          'audit_log INSERT failed in handle_auth_user_signed_in (domain_not_approved)',
          jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                             'writer', 'handle_auth_user_signed_in',
                             'branch', 'domain_not_approved',
                             'participant_id', v_participant.id),
          NULL
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      RAISE;
    END;

    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message',   'This application is restricted to approved Nortal corporate identities.'
      )
    );
  END IF;

  -- ---- Step 6: email-drift detection ----
  IF v_email IS NOT NULL
     AND lower(v_email) <> lower(v_participant.email) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, entity_id,
        previous_value, new_value, reason, source
      ) VALUES (
        v_participant.id, 'participant.email_drift', 'participant', v_participant.id,
        jsonb_build_object('email', v_participant.email),
        jsonb_build_object('email', v_email),
        'email_drift_detected', 'auth_hook'
      );
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.enqueue_alert(
          'audit_write_failure',
          'audit_log INSERT failed in handle_auth_user_signed_in (email_drift)',
          jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                             'writer', 'handle_auth_user_signed_in',
                             'branch', 'email_drift',
                             'participant_id', v_participant.id),
          NULL
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      RAISE;
    END;
  END IF;

  -- ---- Step 7: refresh whitelist ----
  UPDATE public.participants
     SET display_name  = COALESCE(NULLIF(v_display_name, ''), display_name),
         region        = COALESCE(NULLIF(v_region, ''), region),
         last_login_at = now()
   WHERE auth_user_id = v_user_id;

  -- ---- Step 8: access.granted audit row ----
  BEGIN
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
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      PERFORM public.enqueue_alert(
        'audit_write_failure',
        'audit_log INSERT failed in handle_auth_user_signed_in (access.granted)',
        jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                           'writer', 'handle_auth_user_signed_in',
                           'branch', 'access.granted',
                           'participant_id', v_participant.id),
        NULL
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE;
  END;

  -- ---- Step 9: success -- pass through claims unchanged ----
  RETURN jsonb_build_object('claims', v_claims);
END;
$$;

-- ---------------------------------------------------------------------------
-- (4) public.log_admin_role_change  — slice 006, slot 0060
-- ---------------------------------------------------------------------------
-- Trigger function on public.admin_roles AFTER INSERT OR UPDATE. Emits
-- admin.role_granted / admin.role_revoked. Wrapping pattern matches the
-- participants trigger above.
CREATE OR REPLACE FUNCTION public.log_admin_role_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
BEGIN
  -- Prefer the authenticated caller. Fall back to granted_by (covers the
  -- superuser bootstrap path at slot 0074 where auth.uid() is NULL).
  v_actor := COALESCE(auth.uid(), NEW.granted_by, OLD.granted_by);

  IF TG_OP = 'INSERT' THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, entity_id,
        previous_value, new_value, reason, source
      ) VALUES (
        v_actor,
        'admin.role_granted',
        'admin_role',
        NEW.id,
        NULL,
        to_jsonb(NEW),
        'admin role granted',
        'trigger'
      );
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.enqueue_alert(
          'audit_write_failure',
          'audit_log INSERT failed in log_admin_role_change (role_granted)',
          jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                             'writer', 'log_admin_role_change',
                             'tg_op', 'INSERT',
                             'admin_role_id', NEW.id),
          NULL
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      RAISE;
    END;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Emit ONLY on the revoke transition (revoked_at NULL -> NOT NULL).
    -- All other updates (e.g. updated_at refresh) are silent.
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      BEGIN
        INSERT INTO public.audit_log (
          actor, action, entity_type, entity_id,
          previous_value, new_value, reason, source
        ) VALUES (
          v_actor,
          'admin.role_revoked',
          'admin_role',
          NEW.id,
          to_jsonb(OLD),
          to_jsonb(NEW),
          COALESCE(NEW.revoke_reason, 'admin role revoked'),
          'trigger'
        );
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          PERFORM public.enqueue_alert(
            'audit_write_failure',
            'audit_log INSERT failed in log_admin_role_change (role_revoked)',
            jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                               'writer', 'log_admin_role_change',
                               'tg_op', 'UPDATE',
                               'admin_role_id', NEW.id),
            NULL
          );
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
        RAISE;
      END;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------------
-- (5) public.admin_config_upsert  — slice 008, slot 0077 (this file, above)
-- ---------------------------------------------------------------------------
-- Two audit_log INSERT sites:
--   * admin.access_denied (step 1 — DENIAL path: already in BEGIN/EXCEPTION/NULL
--     swallow; UPGRADE by calling enqueue_alert BEFORE the NULL but PRESERVE
--     swallow semantics so the WCG07 RAISE always fires).
--   * tournament_config.<key> success row (step 9 — currently NAKED; wrap to
--     alert + RE-RAISE so the business transaction aborts atomically if the
--     audit row cannot be written).
-- The rest of the body is preserved byte-identical.
CREATE OR REPLACE FUNCTION public.admin_config_upsert(
  p_key                  text,
  p_value                jsonb,
  p_expected_version_id  bigint,
  p_reason               text,
  p_source_citation      text DEFAULT NULL,
  p_acknowledge_token    uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor             uuid;
  v_current_version   bigint;
  v_previous_value    jsonb;
  v_existing_value_type text;
  v_preview           jsonb;
  v_audit_id          uuid;
  v_new_version       bigint;
  v_action_label      text;
BEGIN
  v_actor := auth.uid();

  -- Step 1: authorization
  IF NOT public.is_admin(v_actor) THEN
    BEGIN
      INSERT INTO public.audit_log (
        actor, action, entity_type, source, new_value
      ) VALUES (
        v_actor,
        'admin.access_denied',
        'admin_config_upsert',
        'api_guard',
        jsonb_build_object('rpc','admin_config_upsert','key',p_key)
      );
    EXCEPTION WHEN OTHERS THEN
      -- DENY path: keep swallow semantics so the WCG07 RAISE always fires
      -- (operator gets paged via enqueue_alert, but the access denial still
      -- propagates to the caller — that is the contract-locked behaviour).
      BEGIN
        PERFORM public.enqueue_alert(
          'audit_write_failure',
          'audit_log INSERT failed in admin_config_upsert (access_denied)',
          jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                             'writer', 'admin_config_upsert',
                             'branch', 'access_denied',
                             'key', p_key),
          NULL
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      NULL;
    END;
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'WCG07';
  END IF;

  -- Step 2: reason required
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Reason is required for configuration writes'
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 3: per-key value validation (CASE dispatcher). The frontend zod
  -- validator (T018) is the primary check; this is the SQL backstop.
  CASE
    WHEN p_key = 'eligibility.allowed_domains' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN
        RAISE EXCEPTION 'Invalid value for key %: must be a jsonb array', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    WHEN p_key = 'locking.match_prediction_window_minutes' THEN
      IF jsonb_typeof(p_value) <> 'number'
         OR (p_value)::text::int < 1
         OR (p_value)::text::int > 1440 THEN
        RAISE EXCEPTION 'Invalid value for key %: must be integer 1..1440', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    WHEN p_key LIKE 'scoring.match_points.%'
      OR p_key = 'scoring.final_pick_points'
      OR p_key = 'scoring.score_upper_bound' THEN
      IF jsonb_typeof(p_value) <> 'number'
         OR (p_value)::text::int < 0 THEN
        RAISE EXCEPTION 'Invalid value for key %: must be non-negative integer', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    WHEN p_key = 'scoring.tie_breaker_order' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN
        RAISE EXCEPTION 'Invalid value for key %: must be a jsonb array of tier names', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    WHEN p_key = 'tournament.phase.current' THEN
      IF jsonb_typeof(p_value) <> 'string'
         OR (p_value #>> '{}') NOT IN ('pre_tournament','group_stage','knockout','completed') THEN
        RAISE EXCEPTION 'Invalid value for key %: must be one of pre_tournament|group_stage|knockout|completed', p_key
          USING ERRCODE = 'WCG02';
      END IF;
    ELSE
      NULL;
  END CASE;

  -- Step 4: source_citation required for security-sensitive keys
  IF p_source_citation IS NULL AND (
    p_key LIKE 'eligibility.%'
    OR p_key LIKE 'locking.%'
    OR p_key LIKE 'scoring.%'
    OR p_key = 'providers.active'
    OR p_key LIKE 'admin_roles.%'
  ) THEN
    RAISE EXCEPTION 'Source citation required for security-sensitive key %', p_key
      USING ERRCODE = 'WCG02';
  END IF;

  -- Step 5: advisory xact lock (per-key serialization)
  PERFORM pg_advisory_xact_lock(hashtext(p_key));

  -- Step 6: universal validation — key must exist in tournament_config + lock
  -- the row for the duration of the txn.
  SELECT version_id, value, value_type
    INTO v_current_version, v_previous_value, v_existing_value_type
    FROM public.tournament_config
   WHERE key = p_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown configuration key %', p_key
      USING ERRCODE = 'WCG03';
  END IF;

  -- Step 7: expected_version_id check
  IF v_current_version IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'Concurrent edit detected: expected version_id %, current %',
      p_expected_version_id, v_current_version
      USING ERRCODE = 'WCG01';
  END IF;

  -- Step 8: acknowledge-token check (re-run preview to recompute affecting)
  v_preview := public.admin_config_preview(p_key, p_value);
  IF (v_preview ->> 'affecting')::boolean THEN
    IF p_acknowledge_token IS NULL THEN
      RAISE EXCEPTION 'This change affects existing data; acknowledge token required'
        USING ERRCODE = 'WCG05';
    END IF;
    IF NOT public.verify_acknowledge_token(p_acknowledge_token, p_key, p_value) THEN
      RAISE EXCEPTION 'Acknowledge token invalid or expired'
        USING ERRCODE = 'WCG05';
    END IF;
  END IF;

  -- Step 9: atomic 3-write (audit_log → versions → tournament_config)
  v_action_label := 'tournament_config.' || p_key;

  BEGIN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id, source,
      previous_value, new_value, reason
    )
    VALUES (
      v_actor, v_action_label, 'tournament_config', NULL, 'admin_rpc',
      v_previous_value, p_value, p_reason
    )
    RETURNING id INTO v_audit_id;
  EXCEPTION WHEN OTHERS THEN
    -- SUCCESS path: re-raise so the business transaction (versions + config
    -- UPDATE that follow) aborts atomically. We never want the config write
    -- to commit without its audit row.
    BEGIN
      PERFORM public.enqueue_alert(
        'audit_write_failure',
        'audit_log INSERT failed in admin_config_upsert (success path)',
        jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE,
                           'writer', 'admin_config_upsert',
                           'branch', 'success',
                           'key', p_key),
        NULL
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE;
  END;

  INSERT INTO public.tournament_config_versions (
    key, previous_value, new_value, change_kind,
    actor, reason, source_citation, audit_log_id,
    acknowledge_token_used
  )
  VALUES (
    p_key, v_previous_value, p_value, 'admin_upsert',
    v_actor, p_reason, p_source_citation, v_audit_id,
    p_acknowledge_token
  )
  RETURNING version_id INTO v_new_version;

  UPDATE public.tournament_config
     SET value      = p_value,
         value_type = COALESCE(v_existing_value_type, 'jsonb'),
         updated_at = now(),
         updated_by = v_actor,
         version_id = v_new_version
   WHERE key = p_key;

  RETURN v_new_version;
END;
$$;

COMMIT;

