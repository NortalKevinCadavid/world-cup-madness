-- Slice 005 / T037 / FR-011 (scope='all') / scoring-model.md / migration slot 0058.
--
-- public.score_all(p_run_id uuid) RETURNS uuid
--   The admin-recalc / config-change full-tournament scoring SP. Computes one
--   score_records row per (active eligible participant, finished match) pair
--   PLUS one score_records row per (active final_predictions row), all under
--   a single caller-supplied run_id so the run row's affected_record_count is
--   the sum across both passes (research.md § R-002, task body T037).
--
-- Why a separate SP (NOT a loop calling score_match / score_finals):
--   score_match (slot 0052) and score_finals (slot 0053) each manage their
--   own score_calculation_runs lifecycle: they INSERT the run row, set
--   scope='match' / scope='finals', and on terminal success UPDATE the run
--   row to status='succeeded'. If scope='all' tried to share a single run_id
--   across multiple score_match calls, the FIRST call would mark the run
--   'succeeded' and every subsequent call would early-return on the
--   replay-idempotency check (status='succeeded' -> RETURN). This SP
--   therefore inlines the score-record INSERT logic instead, mirroring the
--   shape of slot 0052 + slot 0053 with one shared lifecycle managed by THIS
--   SP. Future polish may refactor the three SPs to share helper subroutines
--   that do not touch score_calculation_runs.
--
-- Security posture (MIRRORS score_match / score_finals):
--   * LANGUAGE plpgsql / SECURITY DEFINER -- runs with the owner's rights so
--       it can write to score_records / score_calculation_runs /
--       tournament_config without depending on caller RLS. This is the only
--       legitimate RLS bypass path; every other write to score_records MUST
--       go through this SP (or score_match / score_finals).
--   * SET search_path = public, pg_temp -- defence against search-path
--       hijacking by malicious callers that prepend a schema.
--   * EXECUTE granted to authenticated only (Edge Function callers) plus
--       service_role for admin paths; PUBLIC revoked.
--
-- Idempotency (research.md § R-002):
--   * Caller-supplied run_id is the idempotency key. The first INSERT into
--       score_calculation_runs uses ON CONFLICT (id) DO NOTHING; on replay
--       the re-read shows status='succeeded' and the SP returns early
--       without re-scoring. The score_records_uk unique constraint on
--       (participant_id, target_kind, target_id, calculation_version) is
--       the belt-and-braces guarantee that any duplicate insert raises
--       23505.
--
-- Calculation version (research.md § R-003):
--   * All score_records rows (both match and final) are written AT the
--       CURRENT value of tournament_config.current_calculation_version. The
--       pointer is bumped to current+1 ONCE at the end (NOT per finished
--       match), so the whole all-scope pass appears as one self-consistent
--       version-transition to readers (FR-012 / SC-008).
--
-- Reason-code logic:
--   * Match pass: identical to score_match § 7.2 (exact / outcome /
--       incorrect / none).
--   * Final pass: identical to score_finals § 7.3 (final_pending /
--       final_correct / final_incorrect).
--
-- Rules-from-config (Principle VIII):
--   * Match points come from tournament_config.match_points.{exact,outcome,
--       incorrect}. Final points come from tournament_config.final_points.
--       each_item. None are hard-coded.
--
-- Audit rows:
--   * Produced by the AFTER INSERT trigger on score_records (T014, slot
--       0055). This SP does NOT write to audit_log directly; the trigger
--       fan-out is the single source of truth for audit emission
--       (Principle V).
--
-- Eligibility filter:
--   * Match pass: same as score_match -- participants with status='active'
--       AND is_eligible_nortal_participant(auth_user_id) contribute one row
--       per finished match. LEFT JOIN to predictions so eligible
--       participants without an active prediction still emit a row with
--       reason_code='none' (US1.4 + Acceptance Scenario US4.1).
--   * Final pass: same as score_finals -- active final_predictions rows
--       (superseded_at IS NULL) are scored; the participant whose pick this
--       is is taken at face value (deactivated participants whose old
--       picks remain active in final_predictions are intentionally still
--       scored).

BEGIN;

CREATE OR REPLACE FUNCTION public.score_all(
  p_run_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_status     public.score_run_status;
  v_existing_reason     text;
  v_award               public.tournament_award%ROWTYPE;
  v_pts_exact           int;
  v_pts_outcome         int;
  v_pts_incorrect       int;
  v_pts_each            int;
  v_target_version      int;
  v_match_affected      int := 0;
  v_final_affected      int := 0;
  v_total_affected      int := 0;
BEGIN
  -- -------------------------------------------------------------------------
  -- Step 1: Idempotency guard. UPSERT the run row keyed by caller-supplied
  -- p_run_id. ON CONFLICT DO NOTHING means a replay with the same run_id is
  -- a no-op at the run-row level. We then re-read the row to learn whether
  -- this is a fresh run (we inserted it) or a replay (a prior call inserted
  -- it). Same shape as score_match / slot 0052 Step 1 + score_finals / slot
  -- 0053 Step 1, except scope='all' and trigger='admin_recalc' (which the
  -- reason CHECK requires a non-empty reason for; the Edge Function caller
  -- MUST therefore have supplied one, and we re-read its value below to
  -- pass through. If the caller did not pre-insert a run row with a reason
  -- we fall back to 'scope=all batch' so the CHECK is satisfied).
  -- -------------------------------------------------------------------------
  INSERT INTO public.score_calculation_runs (
    id, scope, target_id, "trigger", triggered_by, started_at, status, reason
  )
  VALUES (
    p_run_id,
    'all',
    NULL,
    'admin_recalc',
    auth.uid(),
    now(),
    'running',
    'scope=all batch'
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT status, reason
    INTO v_existing_status, v_existing_reason
    FROM public.score_calculation_runs
   WHERE id = p_run_id;

  -- Idempotent replay: a previously-succeeded run returns p_run_id without
  -- writing new score_records (and without bumping the calculation_version
  -- pointer). Mirrors score_match / score_finals's "true no-op contract".
  IF v_existing_status = 'succeeded' THEN
    RETURN p_run_id;
  END IF;

  -- A prior run with the same run_id that failed must NOT silently retry --
  -- the admin must explicitly reset the row so the failure surface stays
  -- visible.
  IF v_existing_status = 'failed' THEN
    RAISE EXCEPTION
      'score_all: run % previously failed; admin must reset before retry',
      p_run_id
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 2: Load the tournament_award row. Single-tournament-for-now posture
  -- (slot 0051 § header). ORDER BY set_at DESC LIMIT 1 picks the most
  -- recently-mutated row; in practice there is exactly one row per
  -- tournament and exactly one tournament in flight at a time. UNLIKE
  -- score_finals we DO NOT raise when the award row is missing -- a
  -- scope='all' call might be made before the tournament concludes (admin
  -- recalc after a config change mid-tournament). The final pass simply
  -- writes zero rows in that case and the match pass proceeds normally.
  -- -------------------------------------------------------------------------
  SELECT *
    INTO v_award
    FROM public.tournament_award
   ORDER BY set_at DESC
   LIMIT 1;

  -- -------------------------------------------------------------------------
  -- Step 3: Read scoring constants from tournament_config. All point values
  -- come from config (Principle VIII).
  -- -------------------------------------------------------------------------
  SELECT (value)::int INTO v_pts_exact
    FROM public.tournament_config
   WHERE key = 'match_points.exact';

  SELECT (value)::int INTO v_pts_outcome
    FROM public.tournament_config
   WHERE key = 'match_points.outcome';

  SELECT (value)::int INTO v_pts_incorrect
    FROM public.tournament_config
   WHERE key = 'match_points.incorrect';

  SELECT (value)::int INTO v_pts_each
    FROM public.tournament_config
   WHERE key = 'final_points.each_item';

  IF v_pts_exact IS NULL OR v_pts_outcome IS NULL
     OR v_pts_incorrect IS NULL OR v_pts_each IS NULL THEN
    UPDATE public.score_calculation_runs
       SET status       = 'failed',
           completed_at = now(),
           notes        = 'tournament_config missing one of match_points.{exact,outcome,incorrect} / final_points.each_item'
     WHERE id = p_run_id;
    RAISE EXCEPTION
      'score_all: tournament_config missing one of match_points.{exact,outcome,incorrect} / final_points.each_item'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 4: Read the current calculation_version pointer. ALL new
  -- score_records rows (match + final) are written AT this version; the
  -- pointer is bumped ONCE at the end so the whole scope='all' pass is
  -- one atomic version-transition.
  -- -------------------------------------------------------------------------
  SELECT (value)::int INTO v_target_version
    FROM public.tournament_config
   WHERE key = 'current_calculation_version';

  IF v_target_version IS NULL THEN
    UPDATE public.score_calculation_runs
       SET status       = 'failed',
           completed_at = now(),
           notes        = 'tournament_config missing current_calculation_version'
     WHERE id = p_run_id;
    RAISE EXCEPTION
      'score_all: tournament_config missing current_calculation_version'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 5: Defensive cleanup at v_target_version. On a fresh run this
  -- DELETE is a no-op (no rows exist yet at v_target_version). On a retry-
  -- after-error path it prevents the upcoming INSERTs from tripping
  -- score_records_uk. Scope: ALL target_kind rows at this version (both
  -- match and final), because score_all is the single owner of v_target_version
  -- rows during this transaction.
  -- -------------------------------------------------------------------------
  DELETE FROM public.score_records
   WHERE calculation_version = v_target_version;

  -- -------------------------------------------------------------------------
  -- Step 6a: Match pass. INSERT one row per (eligible active participant,
  -- finished match) pair across every match where status='finished'.
  -- LEFT JOIN to predictions so participants without an active prediction
  -- still emit a row with reason_code='none' for that match.
  --
  -- Inlines the score_match § 7.2 truth table:
  --   pr.id IS NULL                                  -> 'none' / 0
  --   predicted == official (exact)                  -> 'exact' / v_pts_exact
  --   sign(predicted_diff) == sign(official_diff)    -> 'outcome' / v_pts_outcome
  --   otherwise                                       -> 'incorrect' / v_pts_incorrect
  -- -------------------------------------------------------------------------
  INSERT INTO public.score_records (
    participant_id,
    target_kind,
    target_id,
    match_id,
    final_item_kind,
    predicted_home,
    predicted_away,
    predicted_team_or_player_id,
    official_home,
    official_away,
    official_team_or_player_id,
    points,
    reason_code,
    calculation_version,
    calculated_at,
    run_id,
    source
  )
  SELECT
    p.id                                                        AS participant_id,
    'match'::public.score_target_kind                            AS target_kind,
    m.id                                                         AS target_id,
    m.id                                                         AS match_id,
    NULL::public.final_item_kind                                 AS final_item_kind,
    pr.predicted_home                                            AS predicted_home,
    pr.predicted_away                                            AS predicted_away,
    NULL::uuid                                                   AS predicted_team_or_player_id,
    CASE WHEN pr.id IS NULL THEN NULL ELSE mr.home_score_for_scoring END AS official_home,
    CASE WHEN pr.id IS NULL THEN NULL ELSE mr.away_score_for_scoring END AS official_away,
    NULL::uuid                                                   AS official_team_or_player_id,
    CASE
      WHEN pr.id IS NULL                                                              THEN 0
      WHEN pr.predicted_home = mr.home_score_for_scoring
       AND pr.predicted_away = mr.away_score_for_scoring                              THEN v_pts_exact
      WHEN sign(pr.predicted_home - pr.predicted_away)
         = sign(mr.home_score_for_scoring - mr.away_score_for_scoring)                THEN v_pts_outcome
      ELSE                                                                                 v_pts_incorrect
    END                                                          AS points,
    CASE
      WHEN pr.id IS NULL                                                              THEN 'none'::public.score_reason_code
      WHEN pr.predicted_home = mr.home_score_for_scoring
       AND pr.predicted_away = mr.away_score_for_scoring                              THEN 'exact'::public.score_reason_code
      WHEN sign(pr.predicted_home - pr.predicted_away)
         = sign(mr.home_score_for_scoring - mr.away_score_for_scoring)                THEN 'outcome'::public.score_reason_code
      ELSE                                                                                 'incorrect'::public.score_reason_code
    END                                                          AS reason_code,
    v_target_version                                             AS calculation_version,
    now()                                                        AS calculated_at,
    p_run_id                                                     AS run_id,
    'auto'::public.score_source                                  AS source
  FROM public.matches m
  JOIN public.match_results mr ON mr.match_id = m.id
  CROSS JOIN public.participants p
  LEFT JOIN public.predictions pr
         ON pr.participant_id = p.id
        AND pr.match_id       = m.id
        AND pr.superseded_at IS NULL
  WHERE m.status = 'finished'
    AND mr.home_score_for_scoring IS NOT NULL
    AND mr.away_score_for_scoring IS NOT NULL
    AND p.status = 'active'
    AND public.is_eligible_nortal_participant(p.auth_user_id);

  GET DIAGNOSTICS v_match_affected = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Step 6b: Final pass. INSERT one row per active final_predictions row.
  -- Only executes if a tournament_award row exists; otherwise the final
  -- pass is a no-op (v_final_affected stays 0).
  --
  -- Inlines the score_finals § 7.3 truth table:
  --   *_status='pending'                  -> 'final_pending'   / 0   / NULL official
  --   confirmed AND pick==official        -> 'final_correct'   / v_pts_each
  --   confirmed AND pick!=official        -> 'final_incorrect' / 0
  -- -------------------------------------------------------------------------
  IF v_award.tournament_id IS NOT NULL THEN
    INSERT INTO public.score_records (
      participant_id,
      target_kind,
      target_id,
      match_id,
      final_item_kind,
      predicted_home,
      predicted_away,
      predicted_team_or_player_id,
      official_home,
      official_away,
      official_team_or_player_id,
      points,
      reason_code,
      calculation_version,
      calculated_at,
      run_id,
      source
    )
    SELECT
      fp.participant_id                                  AS participant_id,
      'final'::public.score_target_kind                  AS target_kind,
      fp.id                                              AS target_id,
      NULL::uuid                                         AS match_id,
      fp.item_kind::text::public.final_item_kind         AS final_item_kind,
      NULL::int                                          AS predicted_home,
      NULL::int                                          AS predicted_away,
      COALESCE(fp.target_team_id, fp.target_player_id)   AS predicted_team_or_player_id,
      NULL::int                                          AS official_home,
      NULL::int                                          AS official_away,
      CASE fp.item_kind
        WHEN 'champion'    THEN CASE WHEN v_award.champion_status    = 'confirmed' THEN v_award.champion_team_id      END
        WHEN 'runner_up'   THEN CASE WHEN v_award.runner_up_status   = 'confirmed' THEN v_award.runner_up_team_id     END
        WHEN 'top_scorer'  THEN CASE WHEN v_award.top_scorer_status  = 'confirmed' THEN v_award.top_scorer_player_id  END
        WHEN 'best_player' THEN CASE WHEN v_award.best_player_status = 'confirmed' THEN v_award.best_player_player_id END
      END                                                AS official_team_or_player_id,
      CASE fp.item_kind
        WHEN 'champion' THEN
          CASE
            WHEN v_award.champion_status = 'pending'                         THEN 0
            WHEN fp.target_team_id = v_award.champion_team_id                THEN v_pts_each
            ELSE                                                                  0
          END
        WHEN 'runner_up' THEN
          CASE
            WHEN v_award.runner_up_status = 'pending'                        THEN 0
            WHEN fp.target_team_id = v_award.runner_up_team_id               THEN v_pts_each
            ELSE                                                                  0
          END
        WHEN 'top_scorer' THEN
          CASE
            WHEN v_award.top_scorer_status = 'pending'                       THEN 0
            WHEN fp.target_player_id = v_award.top_scorer_player_id          THEN v_pts_each
            ELSE                                                                  0
          END
        WHEN 'best_player' THEN
          CASE
            WHEN v_award.best_player_status = 'pending'                      THEN 0
            WHEN fp.target_player_id = v_award.best_player_player_id         THEN v_pts_each
            ELSE                                                                  0
          END
      END                                                AS points,
      CASE fp.item_kind
        WHEN 'champion' THEN
          CASE
            WHEN v_award.champion_status = 'pending'                         THEN 'final_pending'::public.score_reason_code
            WHEN fp.target_team_id = v_award.champion_team_id                THEN 'final_correct'::public.score_reason_code
            ELSE                                                                  'final_incorrect'::public.score_reason_code
          END
        WHEN 'runner_up' THEN
          CASE
            WHEN v_award.runner_up_status = 'pending'                        THEN 'final_pending'::public.score_reason_code
            WHEN fp.target_team_id = v_award.runner_up_team_id               THEN 'final_correct'::public.score_reason_code
            ELSE                                                                  'final_incorrect'::public.score_reason_code
          END
        WHEN 'top_scorer' THEN
          CASE
            WHEN v_award.top_scorer_status = 'pending'                       THEN 'final_pending'::public.score_reason_code
            WHEN fp.target_player_id = v_award.top_scorer_player_id          THEN 'final_correct'::public.score_reason_code
            ELSE                                                                  'final_incorrect'::public.score_reason_code
          END
        WHEN 'best_player' THEN
          CASE
            WHEN v_award.best_player_status = 'pending'                      THEN 'final_pending'::public.score_reason_code
            WHEN fp.target_player_id = v_award.best_player_player_id         THEN 'final_correct'::public.score_reason_code
            ELSE                                                                  'final_incorrect'::public.score_reason_code
          END
      END                                                AS reason_code,
      v_target_version                                   AS calculation_version,
      now()                                              AS calculated_at,
      p_run_id                                           AS run_id,
      'auto'::public.score_source                        AS source
    FROM public.final_predictions fp
    WHERE fp.superseded_at IS NULL;

    GET DIAGNOSTICS v_final_affected = ROW_COUNT;
  END IF;

  v_total_affected := v_match_affected + v_final_affected;

  -- -------------------------------------------------------------------------
  -- Step 7: Bump the current_calculation_version pointer ONCE. Done in the
  -- same transaction as the INSERTs so MVCC readers see either the pre-run
  -- snapshot (old pointer + no new rows visible) or the post-run snapshot
  -- (new pointer + new rows visible) -- never a partial state (FR-012 /
  -- SC-008). Conditional on v_total_affected > 0: an empty all-pass (no
  -- finished matches AND no active final_predictions) leaves the pointer
  -- untouched.
  -- -------------------------------------------------------------------------
  IF v_total_affected > 0 THEN
    UPDATE public.tournament_config
       SET value      = to_jsonb(v_target_version + 1),
           updated_at = now()
     WHERE key = 'current_calculation_version';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 8: Mark the run terminal-success. The score_calculation_runs CHECK
  -- score_calculation_runs_succeeded_completeness requires completed_at,
  -- affected_record_count, AND calculation_version_written all populated on
  -- transition to 'succeeded' -- all three are set in one UPDATE.
  -- -------------------------------------------------------------------------
  UPDATE public.score_calculation_runs
     SET status                       = 'succeeded',
         completed_at                 = now(),
         affected_record_count        = v_total_affected,
         calculation_version_written  = v_target_version
   WHERE id = p_run_id;

  RETURN p_run_id;
END;
$$;

COMMENT ON FUNCTION public.score_all(uuid) IS
  'Slice 005 / T037 / FR-011 (scope=all). Scores all finished matches AND all active final_predictions '
  'in one transaction under a single caller-supplied run_id. Inlines score_match § 7.2 + score_finals '
  '§ 7.3 logic so all rows share one run_id and one calculation_version (single-pointer-bump). '
  'Idempotent by run_id (R-002). All point values come from tournament_config (Principle VIII). '
  'Audit rows are emitted by the AFTER INSERT trigger on score_records (T014, slot 0055); this SP '
  'does not write to audit_log directly. SECURITY DEFINER is the only legitimate RLS-bypass write '
  'path to score_records alongside score_match (slot 0052) and score_finals (slot 0053).';

-- ---------------------------------------------------------------------------
-- Permissions: lock down PUBLIC, grant to authenticated (Edge Function
-- caller surface) and service_role (admin recalc surface). Mirrors slot 0052
-- + slot 0053 permissions blocks.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.score_all(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.score_all(uuid) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.score_all(uuid) TO service_role';
  END IF;
END
$$;

COMMIT;
