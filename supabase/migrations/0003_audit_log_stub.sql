-- Slice 001 stub. Slice 007 will ALTER to add partitions, retention triggers, and the regulatory audit envelope.
--
-- Append-only audit table. Slice 001 writes rows from two paths:
--   1. The auth hook (T024, T041) — access.granted / access.denied /
--      participant.email_drift (see contracts/auth-hook.sql.md).
--   2. The participants row trigger (T013) — participant.created /
--      participant.updated (see data-model.md Entity 1 "Audit posture").
--
-- The columns defined here are LOCKED by Principle XI (cross-slice
-- contracts). Slice 007 may ADD columns (e.g. partition keys, signature
-- columns, retention markers) but MUST NOT alter or drop any of these.
-- The canonical shape is data-model.md § Entity 3 and research.md § R-008.
--
-- RLS is intentionally NOT enabled here. T012 owns the policies and the
-- REVOKE UPDATE, DELETE that enforces append-only at the role layer.
-- Slice 007 will additionally enforce append-only via triggers and
-- WITH CHECK policies.

CREATE TABLE IF NOT EXISTS public.audit_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor           uuid        NULL,
  action          text        NOT NULL,
  entity_type     text        NULL,
  entity_id       uuid        NULL,
  previous_value  jsonb       NULL,
  new_value       jsonb       NULL,
  reason          text        NULL,
  source          text        NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_source_check
    CHECK (source IN ('auth_hook', 'rls', 'api_guard', 'ui', 'trigger'))
);

-- Retrieval per SC-006 (recent events first) and Slice 007 retention sweeps.
CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx
  ON public.audit_log (occurred_at DESC);

-- Forensic search: "every access.denied in the last hour", "every
-- participant.email_drift since launch", etc.
CREATE INDEX IF NOT EXISTS audit_log_action_occurred_at_idx
  ON public.audit_log (action, occurred_at DESC);

-- Participant-scoped queries: "show this participant's audit trail"
-- (Slice 006 admin tooling, dispute resolution). Partial index because
-- `actor` is NULL for denied-pre-create attempts and we never query those
-- by actor.
CREATE INDEX IF NOT EXISTS audit_log_actor_occurred_at_idx
  ON public.audit_log (actor, occurred_at DESC)
  WHERE actor IS NOT NULL;
