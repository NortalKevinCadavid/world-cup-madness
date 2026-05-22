-- Slice 002 / T008 / FR-001 / Constitution V (Auditability). AFTER INSERT/UPDATE triggers on teams, matches, match_results emit audit_log rows with source='trigger'. Mirrors slice 001's participants audit trigger pattern (0008_participants_audit_trigger.sql).
--
-- Scope discipline (Constitution Principle X):
--   * This migration touches ONLY the three new trigger functions and their
--     trigger bindings on public.teams, public.matches, public.match_results.
--     It does NOT alter the table DDLs (owned by T003 / T004 / T005) and does
--     NOT touch RLS / GRANT / REVOKE (owned by T009, migration 0026).
--   * No DELETE branch on any of the three triggers: catalog rows are never
--     deleted in this product (matches and teams use ON DELETE RESTRICT from
--     downstream slices; match_results uses ON DELETE RESTRICT toward matches).
--     Corrections happen via UPDATE — captured by the UPDATE branch.
--
-- Security model (mirrors 0008_participants_audit_trigger.sql):
--   * SECURITY DEFINER so each trigger can INSERT into public.audit_log even
--     though Slice 001's audit_log RLS denies INSERT to all client roles
--     (only triggers and the auth hook write audit rows).
--   * SET search_path = public, pg_temp per Supabase security best-practice
--     for SECURITY DEFINER functions (prevents search_path hijacking).
--
-- Actor resolution:
--   * Sync coordinator writes via SECURITY DEFINER paths with no JWT context,
--     so auth.uid() is NULL and actor is recorded as NULL.
--   * match_results admin-override writes (Slice 006) populate
--     match_results.recorded_by; that column is the canonical actor for those
--     rows, so the match_results trigger reads NEW.recorded_by directly.
--
-- Change detection (UPDATE branches):
--   * row(NEW.*) IS DISTINCT FROM row(OLD.*) — NULL-safe whole-row comparison.
--     No-op UPDATEs (e.g. UPDATE ... SET name = name) do not produce audit
--     rows, matching the slice 001 convention in 0008.
--
-- See data-model.md § Entity 1/2/3 "Audit posture" and § Entity 3 "Write paths".

BEGIN;

-- ---------------------------------------------------------------------------
-- public.teams_write_audit()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.teams_write_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- First observation of a team row — written by the sync coordinator under
    -- a SECURITY DEFINER path with no JWT context, so actor is NULL.
    INSERT INTO public.audit_log (
      actor,
      action,
      entity_type,
      entity_id,
      previous_value,
      new_value,
      source
    ) VALUES (
      NULL,
      'team.created',
      'team',
      NEW.id,
      NULL,
      to_jsonb(NEW),
      'trigger'
    );

  ELSIF TG_OP = 'UPDATE' THEN
    -- Skip no-op UPDATEs so the audit log doesn't accumulate noise rows.
    -- row(...) IS DISTINCT FROM row(...) is NULL-safe whole-row comparison.
    IF row(NEW.*) IS DISTINCT FROM row(OLD.*) THEN
      INSERT INTO public.audit_log (
        actor,
        action,
        entity_type,
        entity_id,
        previous_value,
        new_value,
        source
      ) VALUES (
        NULL,
        'team.updated',
        'team',
        NEW.id,
        to_jsonb(OLD),
        to_jsonb(NEW),
        'trigger'
      );
    END IF;
  END IF;

  -- AFTER triggers ignore the return value but plpgsql requires one.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.teams_write_audit() IS
  'Slice 002 / T008: AFTER INSERT OR UPDATE trigger function on public.teams. '
  'Emits one audit_log row per mutation with source=''trigger''. '
  'Actor is NULL (sync coordinator writes via SECURITY DEFINER without JWT).';

-- ---------------------------------------------------------------------------
-- public.matches_write_audit()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.matches_write_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_log (
      actor,
      action,
      entity_type,
      entity_id,
      previous_value,
      new_value,
      source
    ) VALUES (
      NULL,
      'match.created',
      'match',
      NEW.id,
      NULL,
      to_jsonb(NEW),
      'trigger'
    );

  ELSIF TG_OP = 'UPDATE' THEN
    -- Skip no-op UPDATEs. Otherwise emit a single audit row: 'match.status_changed'
    -- when status flipped (Slice 003's lock-window logic listens by action),
    -- 'match.updated' for any other column change.
    IF row(NEW.*) IS DISTINCT FROM row(OLD.*) THEN
      INSERT INTO public.audit_log (
        actor,
        action,
        entity_type,
        entity_id,
        previous_value,
        new_value,
        source
      ) VALUES (
        NULL,
        CASE
          WHEN OLD.status IS DISTINCT FROM NEW.status THEN 'match.status_changed'
          ELSE 'match.updated'
        END,
        'match',
        NEW.id,
        to_jsonb(OLD),
        to_jsonb(NEW),
        'trigger'
      );
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.matches_write_audit() IS
  'Slice 002 / T008: AFTER INSERT OR UPDATE trigger function on public.matches. '
  'Emits one audit_log row per mutation with source=''trigger''. '
  'UPDATE action is ''match.status_changed'' when OLD.status IS DISTINCT FROM NEW.status, '
  'else ''match.updated''. Actor is NULL (sync coordinator path).';

-- ---------------------------------------------------------------------------
-- public.match_results_write_audit()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_results_write_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Sync-driven recordings leave recorded_by NULL; Slice 006 admin overrides
    -- populate it with the admin's participants.id. The trigger reads
    -- NEW.recorded_by as the canonical actor either way.
    INSERT INTO public.audit_log (
      actor,
      action,
      entity_type,
      entity_id,
      previous_value,
      new_value,
      source
    ) VALUES (
      NEW.recorded_by,
      'match_result.recorded',
      'match_result',
      NEW.match_id,
      NULL,
      to_jsonb(NEW),
      'trigger'
    );

  ELSIF TG_OP = 'UPDATE' THEN
    -- Admin-override correction path (Slice 006). Skip no-op UPDATEs.
    IF row(NEW.*) IS DISTINCT FROM row(OLD.*) THEN
      INSERT INTO public.audit_log (
        actor,
        action,
        entity_type,
        entity_id,
        previous_value,
        new_value,
        source
      ) VALUES (
        NEW.recorded_by,
        'match_result.updated',
        'match_result',
        NEW.match_id,
        to_jsonb(OLD),
        to_jsonb(NEW),
        'trigger'
      );
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.match_results_write_audit() IS
  'Slice 002 / T008: AFTER INSERT OR UPDATE trigger function on public.match_results. '
  'Emits one audit_log row per mutation with source=''trigger''. '
  'entity_id is NEW.match_id (the PK of match_results). Actor is NEW.recorded_by '
  '(NULL for sync, participants.id for Slice 006 admin overrides).';

-- ---------------------------------------------------------------------------
-- Trigger bindings (DROP IF EXISTS first for `supabase db reset` idempotency)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS teams_audit_trigger ON public.teams;

CREATE TRIGGER teams_audit_trigger
  AFTER INSERT OR UPDATE ON public.teams
  FOR EACH ROW
  EXECUTE FUNCTION public.teams_write_audit();

DROP TRIGGER IF EXISTS matches_audit_trigger ON public.matches;

CREATE TRIGGER matches_audit_trigger
  AFTER INSERT OR UPDATE ON public.matches
  FOR EACH ROW
  EXECUTE FUNCTION public.matches_write_audit();

DROP TRIGGER IF EXISTS match_results_audit_trigger ON public.match_results;

CREATE TRIGGER match_results_audit_trigger
  AFTER INSERT OR UPDATE ON public.match_results
  FOR EACH ROW
  EXECUTE FUNCTION public.match_results_write_audit();

COMMIT;
