-- Slice 001. Writes one audit_log row per participants mutation. Source='trigger'. Email-drift events are emitted separately by the auth hook (T040).
--
-- Scope discipline (Constitution Principle X):
--   * This migration touches ONLY the trigger function and trigger object.
--     It does NOT alter `public.audit_log` (owned by Slice 007 / stubbed by
--     migration 0003) and does NOT touch RLS / GRANT / REVOKE (owned by T012).
--   * No DELETE branch: `participants` rows are never deleted in this product
--     (FR-009 + the `ON DELETE RESTRICT` from auth.users). Soft-deletion via
--     `status = 'deactivated'` is an UPDATE and is covered by the UPDATE branch.
--
-- Security model:
--   * SECURITY DEFINER so the trigger can INSERT into `audit_log` even though
--     T012's RLS denies INSERT to all client roles (only the trigger and the
--     auth hook write audit rows).
--   * `SET search_path = public, pg_temp` per Supabase security best-practice
--     for SECURITY DEFINER functions (prevents search_path hijacking).
--
-- See data-model.md § Entity 1 "Audit posture" and § Entity 3 "Write paths".

BEGIN;

-- ---------------------------------------------------------------------------
-- Trigger function
-- ---------------------------------------------------------------------------
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

  ELSIF TG_OP = 'UPDATE' THEN
    -- Skip no-op UPDATEs (e.g. SET display_name = display_name) so the audit
    -- log doesn't accumulate noise rows. row(...) IS DISTINCT FROM row(...)
    -- is NULL-safe whole-row comparison.
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
    END IF;
  END IF;

  -- AFTER triggers ignore the return value but plpgsql requires one.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.participants_write_audit() IS
  'Slice 001: AFTER INSERT OR UPDATE trigger function on public.participants. '
  'Emits one audit_log row per mutation with source=''trigger''. '
  'Email-drift detection is owned by the auth hook (T040), not this trigger.';

-- ---------------------------------------------------------------------------
-- Trigger binding
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS participants_audit_trigger ON public.participants;

CREATE TRIGGER participants_audit_trigger
  AFTER INSERT OR UPDATE ON public.participants
  FOR EACH ROW
  EXECUTE FUNCTION public.participants_write_audit();

COMMIT;
