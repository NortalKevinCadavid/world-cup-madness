-- Slice 006 / T003 / FR-009 / data-model.md § Entity 1.
-- Migration slot 0060 per D-026 (slice 006 renumber: spec slots 0047-0061 shift to on-disk 0060-0074
-- because slice 005 occupies 0049-0059 + 0054b).
-- Cross-slice locked: admin_roles is the source-of-truth for is_admin(uuid) at slot 0062 (T007).
-- Slice 008 will ship the assignment UI but cannot alter shape.
--
-- D-026 mapping (slice 006 on-disk slots):
--   0060 admin_roles (this file, T003)
--   0061 audit_log.source_citation (T004)
--   0062 is_admin real body (T007)
--   0063 score_calculation_runs.triggering_audit_log_id (T005)
--   0064 admin_record_match_result (T013)
--   0065 admin_update_match (T030)
--   0066 admin_submit_prediction (T038)
--   0067 admin bypass-lock siblings (T038)
--   0068 admin_update_tournament_award (T030)
--   0069 admin_resolve_match_pending_review (T038)
--   0070 admin_trigger_recalc (T021)
--   0071 pending_recalc_state (T022)
--   0072 reap_stale_recalc_runs (T023)
--   0073 audit_log narrow INSERT policy (T006)
--   0074 admin bootstrap (T009)
--
-- Scope discipline (Constitution Principle X):
--   * DOES NOT replace the slice 001 permissive is_admin(uuid) stub — T007 owns that at slot 0062.
--   * DOES NOT seed any admin rows — T009 owns the superuser bootstrap at slot 0074.
--   * Until 0062 lands, is_admin() returns FALSE, so the WITH CHECK / USING predicates
--     deny every non-superuser INSERT/UPDATE/SELECT. This is intentional: the 0074
--     bootstrap runs as superuser and bypasses RLS.

BEGIN;

-- ---------------------------------------------------------------------------
-- public.admin_roles
-- ---------------------------------------------------------------------------
CREATE TABLE public.admin_roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FR-009 / data-model.md § Entity 1: subject participant. ON DELETE RESTRICT
  -- because we never want an admin's audit trail to dangle if their participant
  -- row is removed; deactivation flows through participants.status instead.
  participant_id  uuid NOT NULL
                    REFERENCES public.participants(id) ON DELETE RESTRICT,

  -- When the grant became effective.
  granted_at      timestamptz NOT NULL DEFAULT now(),

  -- Who granted the role. NULL only for the superuser-bootstrapped seed at
  -- slot 0074 (where no granting admin exists yet).
  granted_by      uuid NULL
                    REFERENCES public.participants(id),

  -- Revocation timestamp; NULL while the grant is active.
  revoked_at      timestamptz NULL,

  -- Who revoked the role; pairs with revoked_at (see CHECK).
  revoked_by      uuid NULL
                    REFERENCES public.participants(id),

  -- Optional human-readable reason for revocation (audit trail context).
  revoke_reason   text NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- data-model.md § Entity 1: revocation is atomic — either both revoked_at
  -- and revoked_by are set, or neither is.
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- One ACTIVE admin role per participant. Historical revoked rows are kept
-- (partial unique index).
CREATE UNIQUE INDEX admin_roles_active_uk
  ON public.admin_roles(participant_id)
  WHERE revoked_at IS NULL;

-- Lookup by participant (audit timeline, "show this participant's role history").
CREATE INDEX admin_roles_participant_idx
  ON public.admin_roles(participant_id, granted_at DESC);

-- ---------------------------------------------------------------------------
-- BEFORE UPDATE trigger: maintain updated_at
-- ---------------------------------------------------------------------------
-- Slice-local function (kept separate from public.set_updated_at to avoid
-- coupling slice 006 to slice 001's helper; behaviour is identical).
CREATE OR REPLACE FUNCTION public.admin_roles_set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER admin_roles_before_update
  BEFORE UPDATE ON public.admin_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.admin_roles_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS posture (data-model.md § RLS posture summary)
-- ---------------------------------------------------------------------------
-- FORCE so even table owners are subject to policies (defence in depth).
ALTER TABLE public.admin_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_roles FORCE ROW LEVEL SECURITY;

-- Admin-only read.
CREATE POLICY admin_roles_admin_read ON public.admin_roles
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

-- Admin-only INSERT (separate from UPDATE for clarity; matches data-model.md).
CREATE POLICY admin_roles_admin_write_insert ON public.admin_roles
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin(auth.uid()));

-- Admin-only UPDATE (revocation path).
CREATE POLICY admin_roles_admin_write_update ON public.admin_roles
  FOR UPDATE TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- NO DELETE policy. admin_roles is append-style: rows are revoked, not deleted.

-- ---------------------------------------------------------------------------
-- Audit trigger (FR-009 + Constitution Principle V same-transaction audit)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the trigger can INSERT into audit_log regardless of the
-- narrow audit_log INSERT policy that T006 ships at slot 0073.
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
  ELSIF TG_OP = 'UPDATE' THEN
    -- Emit ONLY on the revoke transition (revoked_at NULL -> NOT NULL).
    -- All other updates (e.g. updated_at refresh) are silent.
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
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
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER admin_roles_audit_after
  AFTER INSERT OR UPDATE ON public.admin_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.log_admin_role_change();

-- ---------------------------------------------------------------------------
-- Documentation
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.admin_roles IS
  'Slice 006 / FR-009: append-style admin role grants. Source-of-truth for is_admin(uuid) (T007 at slot 0062). Locked cross-slice contract.';

COMMENT ON COLUMN public.admin_roles.id             IS 'PK.';
COMMENT ON COLUMN public.admin_roles.participant_id IS 'FK -> participants(id). ON DELETE RESTRICT.';
COMMENT ON COLUMN public.admin_roles.granted_at     IS 'When the grant became effective.';
COMMENT ON COLUMN public.admin_roles.granted_by     IS 'Granting participant. NULL only for the superuser bootstrap seed (slot 0074).';
COMMENT ON COLUMN public.admin_roles.revoked_at     IS 'Revocation timestamp; NULL while active. Paired with revoked_by via CHECK.';
COMMENT ON COLUMN public.admin_roles.revoked_by     IS 'Revoking participant. Paired with revoked_at via CHECK.';
COMMENT ON COLUMN public.admin_roles.revoke_reason  IS 'Optional reason recorded into audit_log.reason on revoke.';

COMMIT;
