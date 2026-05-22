-- Slice 006 / T004 / FR-013 / data-model.md § audit_log additive column.
-- Migration slot 0061 per D-026.
-- ADDS audit_log.source_citation NULL column. Future admin SPs in slice 006 will require this for certain action types.
-- Additive only -- no existing rows mutated; slice 001 + 005 audit triggers continue to emit without this field.

BEGIN;

ALTER TABLE public.audit_log
  ADD COLUMN source_citation text NULL;

COMMENT ON COLUMN public.audit_log.source_citation IS
  'Slice 006 / T004: free-text citation for admin actions (e.g., FIFA decision number, news URL).
   Required by some admin SPs via CHECK constraints; NULL for system-emitted rows. See FR-013.';

COMMIT;
