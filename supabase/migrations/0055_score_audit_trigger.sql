-- Slice 005 / T014 / FR-018 / research.md § R-012 / spec.md US1 Acceptance Scenario 5.
-- Migration slot 0055 per D-023 (slice 005 renumber: spec slot 0056 collapses to
-- on-disk slot 0055 because the slice-005 slot block 0050-0058 shifts -1 across
-- the whole slice; prior shipped migrations occupy 0049 score_records, 0050
-- score_calculation_runs, 0051 tournament_award, 0052 score_match, 0053 (reserved
-- for score_finals), 0054 (reserved for leaderboard_v), 0055 THIS audit trigger,
-- 0056 score_rls, 0057 score_config_defaults).
--
-- AFTER INSERT/UPDATE/DELETE trigger on public.score_records that writes one row
-- to public.audit_log per change, in the same transaction. Mirrors the slice 003
-- pattern (supabase/migrations/0033_predictions_audit_trigger.sql) and the slice
-- 004 pattern (supabase/migrations/0043_final_predictions_audit_trigger.sql),
-- both of which use SECURITY DEFINER + source='trigger'.
--
-- Security posture:
--   * SECURITY DEFINER bypasses audit_log RLS. Slice 001 / slot 0010
--       (0010_audit_log_api_guard_insert.sql) restricts authenticated INSERT to
--       action='access.denied' AND source='api_guard' rows only. This trigger
--       writes source='trigger' rows that would NOT pass that policy, so it
--       MUST run with definer rights (owner is postgres -> bypasses RLS).
--   * SET search_path = public, pg_temp -- defence against search-path
--       hijacking, matching slice 003 / 004 trigger functions.
--   * source='trigger' (CHECK-constrained value in audit_log_source_check).
--
-- Actor resolution:
--   * audit_log.actor is sourced from
--       public.score_calculation_runs.triggered_by, looked up via
--       COALESCE(NEW.run_id, OLD.run_id). score_records.run_id is NOT NULL
--       (slot 0049), so the lookup is total for INSERT and DELETE; for UPDATE
--       we accept either side via COALESCE for symmetry.
--   * For 'admin_recalc' / 'config_change' runs, triggered_by is the admin
--       participant id (slot 0050 column note). For auto runs ('match_finish'
--       / 'award_confirmed'), triggered_by is the synthetic 'system'
--       participant id (slot 0050 column note).
--
-- Reason field:
--   * audit_log.reason is set to NEW.reason_code (OLD on DELETE), captured as
--       text via the ::text cast on the score_reason_code enum. This gives
--       admins a free-text explanation column to scan
--       ('exact' / 'outcome' / 'incorrect' / 'none' / 'final_correct' /
--       'final_incorrect' / 'final_pending').
--
-- Payload:
--   * to_jsonb(NEW) / to_jsonb(OLD) captures the full row, including
--       participant_id, target_kind, target_id, points, reason_code,
--       calculation_version (T014 minimum per tasks.md line 569), plus every
--       other column. Future column additions to score_records flow through
--       automatically without changing this trigger.
--
-- Scope discipline (Constitution Principle X):
--   * OBSERVATION-only: trigger does not block / mutate / cancel the firing
--       statement. Returns NEW (INSERT/UPDATE) or OLD (DELETE) unchanged via
--       COALESCE.
--   * NO rejection-path audit (deferred to slice 007 per D-018 / slice 004
--       pattern; slice 005 only audits state changes that succeed in landing).
--   * NO retention / signature columns -- slice 007 owns the audit_log
--       hardening surface (retention, RLS tightening, partition keys).

BEGIN;

CREATE OR REPLACE FUNCTION public.log_score_record_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_run_id uuid;
BEGIN
  -- Resolve the run that produced this row. score_records.run_id is NOT NULL
  -- (slot 0049), so COALESCE always yields a value -- one side or the other
  -- is always populated (NEW on INSERT/UPDATE, OLD on DELETE/UPDATE).
  v_run_id := COALESCE(NEW.run_id, OLD.run_id);

  -- Look up the actor (the participant id of the run's caller).
  -- ON DELETE RESTRICT on score_records.run_id -> score_calculation_runs.id
  -- (slot 0050) guarantees this row exists as long as the score_records row
  -- exists. NULL would only occur if invariants are violated.
  SELECT triggered_by
    INTO v_actor
    FROM public.score_calculation_runs
   WHERE id = v_run_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, reason, source
    )
    VALUES (
      v_actor,
      'score_record.insert',
      'score_record',
      NEW.id,
      NULL,
      to_jsonb(NEW),
      NEW.reason_code::text,
      'trigger'
    );
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, reason, source
    )
    VALUES (
      v_actor,
      'score_record.update',
      'score_record',
      NEW.id,
      to_jsonb(OLD),
      to_jsonb(NEW),
      NEW.reason_code::text,
      'trigger'
    );
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.audit_log (
      actor, action, entity_type, entity_id,
      previous_value, new_value, reason, source
    )
    VALUES (
      v_actor,
      'score_record.delete',
      'score_record',
      OLD.id,
      to_jsonb(OLD),
      NULL,
      OLD.reason_code::text,
      'trigger'
    );
  END IF;

  -- Observation-only: return unchanged row so the firing statement proceeds.
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS score_records_audit_after ON public.score_records;
CREATE TRIGGER score_records_audit_after
  AFTER INSERT OR UPDATE OR DELETE ON public.score_records
  FOR EACH ROW
  EXECUTE FUNCTION public.log_score_record_change();

COMMIT;
