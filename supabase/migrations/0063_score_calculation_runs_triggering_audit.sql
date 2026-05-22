-- Slice 006 / T005 / FR-013 / data-model.md § score_calculation_runs additive column / research.md § R-008.
-- Migration slot 0063 per D-026.
-- ADDS score_calculation_runs.triggering_audit_log_id NULL column with FK to audit_log.
-- Additive only -- slice 005's score_match / score_finals / score_all SPs continue to write rows
-- without this field. Slice 006 admin SPs will populate this on their RPC-driven runs.
-- ON DELETE SET NULL preserves run history if audit row is purged (Slice 007 retention).
--
-- Cross-slice ownership (data-model.md § Cross-slice ownership map):
--   * `score_calculation_runs` table shape is owned by Slice 005 (migration 0050).
--   * This slice (006) ADDS one nullable column; Slice 005's column set remains locked.
--   * The column lets queries answer "which admin override triggered this recalc?" in
--     a single JOIN: score_records.run_id -> score_calculation_runs.id ->
--     triggering_audit_log_id -> audit_log.id (the admin override audit row).
--
-- Population semantics:
--   * Slice 006's `admin_trigger_recalc` and other admin RPCs set this column when
--     they INSERT the run row, pointing at the `audit_log` row they emitted in the
--     same transaction (the `admin.*` action that justifies the run).
--   * NULL for non-admin-triggered runs: auto match_finish, auto award_confirmed,
--     and system batches. The existing slice 005 paths (score_match, score_finals,
--     score_all SPs) DO NOT set this field and remain unmodified by this migration.
--
-- FK posture:
--   * ON DELETE SET NULL (not RESTRICT): if Slice 007's retention sweep purges an
--     `audit_log` row, the run history MUST survive. The score_calculation_runs
--     table is append-only run history; losing a run row would silently corrupt
--     scoring provenance. Better to lose the back-pointer than the run record.
--   * Contrast with score_calculation_runs.target_id / triggered_by (RESTRICT):
--     those reference live operational rows (matches, participants) whose deletion
--     is itself a corruption signal. audit_log rows, by Slice 007 retention design,
--     have a legitimate purge path.
--
-- Constitution: V (audit traceability), XI (cross-slice additive contract).

BEGIN;

ALTER TABLE public.score_calculation_runs
  ADD COLUMN triggering_audit_log_id uuid NULL
    REFERENCES public.audit_log(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.score_calculation_runs.triggering_audit_log_id IS
  'Slice 006 / T005: FK to the audit_log row that initiated this scoring run (admin actions).
   NULL for non-admin-triggered runs (auto match-finish, auto award-confirm, system batches).
   ON DELETE SET NULL preserves run history if audit row is purged by Slice 007 retention.';

-- Index for "find runs triggered by audit log row X" (admin investigation path).
-- Partial index: only populated rows are interesting; auto-triggered runs (the
-- vast majority) leave this column NULL and need not bloat the index.
CREATE INDEX score_calculation_runs_triggering_audit_idx
  ON public.score_calculation_runs(triggering_audit_log_id)
  WHERE triggering_audit_log_id IS NOT NULL;

COMMIT;
