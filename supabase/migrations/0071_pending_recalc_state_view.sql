-- Slice 006 / T022 / US2 / data-model.md § Pending Recalc State VIEW.
-- Migration slot 0071 per D-026 (spec slot 0058 reassigned; D-026 mapping).
--
-- VIEW: public.pending_recalc_state
--
-- recalc_pending = TRUE iff there exists at least one audit_log row with
--   action LIKE 'tournament_config.scoring%'
--   AND occurred_at > COALESCE(max(score_calculation_runs.completed_at)
--                              WHERE status='succeeded', '1970-01-01'::timestamptz)
--
-- Column shape (data-model.md § 4 Pending Recalc State + T018 pgTAP A1/A4 contract):
--   * last_scoring_config_change_at         timestamptz   -- max(audit.occurred_at) for scoring config changes
--   * last_successful_recalc_completed_at   timestamptz   -- max(score_calculation_runs.completed_at) WHERE status='succeeded'
--   * pending_config_changes_count          bigint        -- COUNT of scoring-config audit rows AFTER last succeeded recalc
--   * recalc_pending                        boolean       -- TRUE iff pending_config_changes_count > 0
--
-- Cross-slice expectation (locked contract):
--   Slice 008 MUST emit audit_log rows with action='tournament_config.scoring.<key>'
--   (e.g., 'tournament_config.scoring.match_points.exact') whenever an admin changes a
--   scoring-relevant config key. The view's LIKE 'tournament_config.scoring%' filter is
--   the contract surface. Slice 008's tournament_config writer owns producing these rows;
--   this view is the consumer.
--
-- security_invoker = true so the caller's RLS on audit_log and score_calculation_runs
-- applies. Both underlying tables are admin-gated via public.is_admin(auth.uid()) policies
-- (Slice 001 audit_log + Slice 005 score_calculation_runs), so non-admin callers cannot
-- observe rows -- the view inherits that posture rather than re-implementing it.
--
-- Constitution: III (Composable Capabilities -- composes from audit_log + score_calculation_runs
-- with no new state), VIII (Operational Resilience -- visibility into recalc-debt).
--
-- DO NOT modify audit_log or score_calculation_runs here -- view-only.

BEGIN;

CREATE OR REPLACE VIEW public.pending_recalc_state
WITH (security_invoker = true)
AS
SELECT
  (
    SELECT max(occurred_at)
      FROM public.audit_log
     WHERE action LIKE 'tournament_config.scoring%'
  ) AS last_scoring_config_change_at,
  (
    SELECT max(completed_at)
      FROM public.score_calculation_runs
     WHERE status = 'succeeded'
  ) AS last_successful_recalc_completed_at,
  (
    SELECT count(*)
      FROM public.audit_log al
     WHERE al.action LIKE 'tournament_config.scoring%'
       AND al.occurred_at > COALESCE(
             (SELECT max(completed_at)
                FROM public.score_calculation_runs
               WHERE status = 'succeeded'),
             '1970-01-01'::timestamptz
           )
  ) AS pending_config_changes_count,
  (
    SELECT count(*) > 0
      FROM public.audit_log al
     WHERE al.action LIKE 'tournament_config.scoring%'
       AND al.occurred_at > COALESCE(
             (SELECT max(completed_at)
                FROM public.score_calculation_runs
               WHERE status = 'succeeded'),
             '1970-01-01'::timestamptz
           )
  ) AS recalc_pending;

COMMENT ON VIEW public.pending_recalc_state IS
  'Slice 006 / FR-010: surfaces whether scoring-config has changed since the last successful recalc. '
  'security_invoker=true so caller RLS on audit_log + score_calculation_runs applies (admin-only). '
  'Slice 008 must emit audit rows with action LIKE ''tournament_config.scoring%'' for scoring keys.';

GRANT SELECT ON public.pending_recalc_state TO authenticated;

COMMIT;
