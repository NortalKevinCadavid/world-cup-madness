-- Slice 005 / T019 / FR-012 / scoring-model.md § 7.3 / research.md § R-007 + R-008.
-- Migration slot 0053 per D-023 (slice 005 renumber: spec slot 0054 collapses to
-- on-disk slot 0053 because the slice-005 slot block 0050-0058 shifts -1 across
-- the whole slice; prior shipped migrations occupy 0049 score_records, 0050
-- score_calculation_runs, 0051 tournament_award, 0052 score_match, 0055
-- score_audit_trigger, 0056 score_rls, 0057 score_config_defaults).
--
-- public.score_finals(p_run_id uuid) RETURNS uuid
--   The core scoring function for the four final-tournament items (champion,
--   runner_up, top_scorer, best_player). Computes one score_records row per
--   (active eligible participant, final_item_kind) pair for every participant
--   who has an active final_predictions row, per the §7.3 truth table, and
--   bumps the current_calculation_version pointer per the R-003
--   flip-the-pointer pattern.
--
-- Security posture (MIRRORS score_match / slot 0052):
--   * LANGUAGE plpgsql / SECURITY DEFINER -- the SP runs with the owner's
--       rights so it can write to score_records / score_calculation_runs /
--       tournament_config without depending on caller RLS. This is the only
--       legitimate RLS bypass path; every other write to these tables MUST go
--       through this SP (or score_match / admin recalc SP) so the audit trail
--       is complete (Principle V).
--   * SET search_path = public, pg_temp -- defence against search-path
--       hijacking by malicious callers that prepend a schema.
--   * EXECUTE granted to authenticated only (Edge Function callers) plus
--       service_role for admin paths; PUBLIC revoked.
--
-- Idempotency (research.md § R-002):
--   * Caller-supplied run_id is the idempotency key. The first INSERT into
--       score_calculation_runs uses ON CONFLICT (id) DO NOTHING; on replay the
--       re-read shows status='succeeded' and the SP returns early without
--       re-scoring. The score_records_uk unique constraint on
--       (participant_id, target_kind, target_id, calculation_version) is the
--       belt-and-braces guarantee that any duplicate insert raises 23505.
--       target_id is the final_predictions row id (UUIDv4 per slot 0040), so
--       each (participant, item_kind) pair has a stable distinct target_id
--       under the active-prediction supersede chain.
--
-- Calculation version (research.md § R-003):
--   * Same flip-the-pointer shape as score_match: the SP writes new rows AT
--       the CURRENT value of tournament_config.current_calculation_version,
--       then bumps the pointer to current+1 in the same transaction. Readers
--       filtering on tournament_config.current_calculation_version always
--       see one self-consistent snapshot. The pointer bump is conditional on
--       at least one row having been written (a no-op finals call -- e.g. no
--       active final_predictions rows yet -- leaves the pointer untouched).
--
-- Reason-code logic (scoring-model.md § 7.3 / research.md § R-007 + R-008):
--   * For each of the four final items (champion, runner_up, top_scorer,
--       best_player):
--       - tournament_award.<item>_status = 'pending'   -> ('final_pending',  0)
--           with official_team_or_player_id = NULL (the
--           score_records_final_official_required CHECK permits NULL only for
--           the 'final_pending' reason). The row IS written so the personal
--           breakdown surface can show "best-player scoring pending" per
--           spec.md § Edge Cases.
--       - tournament_award.<item>_status = 'confirmed' AND pick matches
--           official value -> ('final_correct',   final_points.each_item).
--       - tournament_award.<item>_status = 'confirmed' AND pick differs from
--           official value -> ('final_incorrect', 0). This branch covers the
--           OD-004 Golden Boot resolution: a top-scorer pick that "tied on
--           raw goals" but is NOT the officially-named Golden Boot winner
--           scores 0 -- only the single officially-named winner scores
--           (research.md § R-007).
--   * For champion / runner_up, the predicted value is target_team_id and the
--       official value is tournament_award.champion_team_id /
--       runner_up_team_id. For top_scorer / best_player, the predicted value
--       is target_player_id and the official value is
--       tournament_award.top_scorer_player_id / best_player_player_id.
--       final_predictions' target_team_id XOR target_player_id CHECK
--       (slot 0040) guarantees the right column is populated per item_kind.
--
-- Rules-from-config (Principle VIII):
--   * The per-item point value comes from tournament_config.final_points.each_item
--       (NOT hard-coded as 20). T006 seeds the default 20 in slot 0057.
--
-- Award row source of truth:
--   * One row in tournament_award per tournament (slot 0051). This SP reads
--       the most-recently-set row (ORDER BY set_at DESC LIMIT 1). The
--       single-tournament-for-now posture matches the slice-005 fixture
--       (tournament_id = 00000000-0000-0000-0000-000000000001). A later
--       slice MAY extend score_finals to accept a tournament_id argument
--       once a tournaments table exists; that addition is forward-compatible
--       (adding an argument creates a new function signature; the current
--       signature stays for the Edge Function call path).
--
-- Audit rows:
--   * Produced by the AFTER INSERT trigger on score_records (T014, slot 0055).
--       This SP does NOT write to audit_log directly; the trigger fan-out is
--       the single source of truth for audit emission (Principle V).
--
-- Eligibility filter:
--   * Active final_predictions rows (superseded_at IS NULL) are the source
--       set. The participant whose pick this is is taken at face value -- the
--       slice-004 submit_final_prediction SP (slot 0044) already enforced
--       active-Nortal eligibility at write time, and this SP does NOT need
--       to re-check (deactivated participants whose old picks remain active
--       in final_predictions are intentionally still scored; their rows
--       become read-only via the leaderboard RLS in T007). This matches the
--       data-model.md § Entity 1 column note that final_predictions rows are
--       append-only and outlive participant deactivation.
--   * Acceptance Scenario US2.4 ("participant with no active final pick")
--       is captured by the absence of a final_predictions row -- such a
--       participant simply emits no final score_records rows, which is the
--       intended behavior for the final-scoring path (unlike score_match,
--       which emits a ('none', 0) row, score_finals only writes rows for
--       participants who actively picked something -- no pick means no row,
--       and the leaderboard treats missing rows as 0 final points).

BEGIN;

CREATE OR REPLACE FUNCTION public.score_finals(
  p_run_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_status     public.score_run_status;
  v_award               public.tournament_award%ROWTYPE;
  v_pts_each            int;
  v_target_version      int;
  v_affected_count      int;
BEGIN
  -- -------------------------------------------------------------------------
  -- Step 1: Idempotency guard. UPSERT the run row keyed by caller-supplied
  -- p_run_id. ON CONFLICT DO NOTHING means a replay with the same run_id is
  -- a no-op at the run-row level. We then re-read the row to learn whether
  -- this is a fresh run (we inserted it) or a replay (a prior call inserted
  -- it). Same shape as score_match / slot 0052 Step 1.
  -- -------------------------------------------------------------------------
  INSERT INTO public.score_calculation_runs (
    id, scope, target_id, "trigger", triggered_by, started_at, status, reason
  )
  VALUES (
    p_run_id,
    'finals',
    NULL,
    'award_confirmed',
    auth.uid(),
    now(),
    'running',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT status
    INTO v_existing_status
    FROM public.score_calculation_runs
   WHERE id = p_run_id;

  -- Idempotent replay: a previously-succeeded run returns p_run_id without
  -- writing new score_records (and without bumping the calculation_version
  -- pointer). Mirrors score_match's "true no-op contract".
  IF v_existing_status = 'succeeded' THEN
    RETURN p_run_id;
  END IF;

  -- A prior run with the same run_id that failed must NOT silently retry --
  -- the admin must explicitly reset the row (e.g. via a Slice 006 admin
  -- recalc path) so the failure surface stays visible.
  IF v_existing_status = 'failed' THEN
    RAISE EXCEPTION
      'score_finals: run % previously failed; admin must reset before retry',
      p_run_id
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 2: Load the tournament_award row. Single-tournament-for-now posture
  -- (slot 0051 § header). ORDER BY set_at DESC LIMIT 1 picks the most
  -- recently-mutated row; in practice there is exactly one row per
  -- tournament and exactly one tournament in flight at a time. If no
  -- tournament_award row exists, the run is a structural error -- mark
  -- failed and raise so the caller surfaces it (no silent no-op).
  -- -------------------------------------------------------------------------
  SELECT *
    INTO v_award
    FROM public.tournament_award
   ORDER BY set_at DESC
   LIMIT 1;

  IF v_award.tournament_id IS NULL THEN
    UPDATE public.score_calculation_runs
       SET status       = 'failed',
           completed_at = now(),
           notes        = 'no tournament_award row exists'
     WHERE id = p_run_id;
    RAISE EXCEPTION 'score_finals: no tournament_award row exists'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 3: Read final_points.each_item from tournament_config. Principle
  -- VIII: NO hard-coded 20. T006 seeds the default 20 in slot 0057. jsonb-
  -- int extraction: `(value)::int` works because slot 0057 stores this key
  -- as a bare JSON number.
  -- -------------------------------------------------------------------------
  SELECT (value)::int
    INTO v_pts_each
    FROM public.tournament_config
   WHERE key = 'final_points.each_item';

  IF v_pts_each IS NULL THEN
    UPDATE public.score_calculation_runs
       SET status       = 'failed',
           completed_at = now(),
           notes        = 'tournament_config missing final_points.each_item'
     WHERE id = p_run_id;
    RAISE EXCEPTION
      'score_finals: tournament_config missing final_points.each_item key'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 4: Read the current calculation_version pointer. New score_records
  -- rows are written AT this version, matching score_match's pattern (slot
  -- 0052 Step 4). The pointer is bumped to v_target_version + 1 AFTER the
  -- INSERTs land if any rows were written.
  -- -------------------------------------------------------------------------
  SELECT (value)::int
    INTO v_target_version
    FROM public.tournament_config
   WHERE key = 'current_calculation_version';

  IF v_target_version IS NULL THEN
    UPDATE public.score_calculation_runs
       SET status       = 'failed',
           completed_at = now(),
           notes        = 'tournament_config missing current_calculation_version'
     WHERE id = p_run_id;
    RAISE EXCEPTION
      'score_finals: tournament_config missing current_calculation_version'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 5: Defensive cleanup at v_target_version. On a fresh run this
  -- DELETE is a no-op (no final rows exist yet at v_target_version). On a
  -- retry-after-error path it prevents the upcoming INSERTs from tripping
  -- score_records_uk. The append-only history at LOWER versions is
  -- untouched. Scope: target_kind='final' rows at this version, ALL four
  -- item kinds -- score_finals is the single owner of final-kind rows at
  -- a given version.
  -- -------------------------------------------------------------------------
  DELETE FROM public.score_records
   WHERE target_kind        = 'final'
     AND calculation_version = v_target_version;

  -- -------------------------------------------------------------------------
  -- Step 6: INSERT one score_records row per (active final_predictions row).
  -- The 4 item kinds branch in a single UNIONed INSERT so the SP scans
  -- final_predictions once and the GET DIAGNOSTICS ROW_COUNT at the end
  -- captures the full affected count in one read.
  --
  -- Per-branch logic (§7.3):
  --   * predicted_team_or_player_id: COALESCE(target_team_id, target_player_id)
  --       -- the slot 0040 CHECK guarantees exactly one of the two columns
  --       is populated per row, matching the item_kind.
  --   * official_team_or_player_id: from the award row, branching on
  --       item_kind. NULL when the corresponding *_status='pending' -- the
  --       score_records_final_official_required CHECK permits NULL ONLY
  --       when reason_code='final_pending' (which is what we set in the
  --       pending branch).
  --   * points: v_pts_each when correct + confirmed; 0 otherwise.
  --   * reason_code: 'final_pending' when *_status='pending';
  --       'final_correct' when confirmed + matching pick;
  --       'final_incorrect' when confirmed + non-matching pick.
  --
  -- final_predictions.id is used as target_id so each (participant,
  -- item_kind) pair has a stable distinct target_id under the active-
  -- prediction supersede chain. The score_records_uk unique constraint on
  -- (participant_id, target_kind, target_id, calculation_version) is thus
  -- satisfied trivially (one row per (participant, item_kind) per version,
  -- because the active-prediction unique partial index on
  -- final_predictions (slot 0040 final_predictions_active_uk) guarantees
  -- one active row per (participant, item_kind) pair).
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
    fp.participant_id                                  AS participant_id,
    'final'::public.score_target_kind                  AS target_kind,
    fp.id                                              AS target_id,
    NULL::uuid                                         AS match_id,
    -- Translate slice-004 final_prediction_item_kind enum to slice-005
    -- final_item_kind enum. The four values are 1:1 by name; an explicit
    -- text cast / re-cast keeps the enum boundary clean.
    fp.item_kind::text::public.final_item_kind         AS final_item_kind,
    NULL::int                                          AS predicted_home,
    NULL::int                                          AS predicted_away,
    -- Exactly one of target_team_id / target_player_id is populated per
    -- final_predictions row (slot 0040 final_predictions_target_xor_kind).
    COALESCE(fp.target_team_id, fp.target_player_id)   AS predicted_team_or_player_id,
    NULL::int                                          AS official_home,
    NULL::int                                          AS official_away,
    -- Per-item official value from the award row, NULL when the
    -- corresponding *_status='pending' (so the 'final_pending' branch
    -- below leaves it NULL, which the score_records_final_official_required
    -- CHECK permits ONLY for that reason).
    CASE fp.item_kind
      WHEN 'champion'    THEN CASE WHEN v_award.champion_status    = 'confirmed' THEN v_award.champion_team_id      END
      WHEN 'runner_up'   THEN CASE WHEN v_award.runner_up_status   = 'confirmed' THEN v_award.runner_up_team_id     END
      WHEN 'top_scorer'  THEN CASE WHEN v_award.top_scorer_status  = 'confirmed' THEN v_award.top_scorer_player_id  END
      WHEN 'best_player' THEN CASE WHEN v_award.best_player_status = 'confirmed' THEN v_award.best_player_player_id END
    END                                                AS official_team_or_player_id,
    -- Points: v_pts_each only when the award is confirmed AND the pick
    -- matches the officially-named value. All other branches (pending,
    -- confirmed-but-wrong) score 0.
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
    -- Reason code: 'final_pending' when the *_status is still 'pending'
    -- (R-008 Golden Ball delay branch -- writes the row but with NULL
    -- official and 0 points so the personal-breakdown UI can surface
    -- "scoring pending" per spec.md § Edge Cases). Otherwise
    -- 'final_correct' / 'final_incorrect' per the §7.3 truth table.
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

  GET DIAGNOSTICS v_affected_count = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Step 7: Bump the current_calculation_version pointer ONLY if any rows
  -- were written. A no-op finals call (no active final_predictions rows)
  -- leaves the pointer untouched so a downstream score_match call sees the
  -- correct lagging-by-one snapshot.
  --
  -- Done in the same transaction as the INSERTs so MVCC readers see either
  -- the pre-run snapshot (old pointer + no new rows visible) or the
  -- post-run snapshot (new pointer + new rows visible) -- never a partial
  -- state (FR-012 / SC-008). Same flip-the-pointer pattern as score_match
  -- (slot 0052 Step 7).
  -- -------------------------------------------------------------------------
  IF v_affected_count > 0 THEN
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
  -- calculation_version_written is v_target_version (the version the rows
  -- were just written at), matching score_match's bookkeeping.
  -- -------------------------------------------------------------------------
  UPDATE public.score_calculation_runs
     SET status                       = 'succeeded',
         completed_at                 = now(),
         affected_record_count        = v_affected_count,
         calculation_version_written  = v_target_version
   WHERE id = p_run_id;

  RETURN p_run_id;
END;
$$;

COMMENT ON FUNCTION public.score_finals(uuid) IS
  'Slice 005 / T019 / FR-012. Scores all four final-prediction items (champion, runner_up, '
  'top_scorer, best_player) for every participant with an active final_predictions row, '
  'against tournament_award. Pending-status items write rows with points=0 / '
  'reason_code=final_pending / official_team_or_player_id=NULL (R-008 Golden Ball delay). '
  'Confirmed-status items write 20 / final_correct on match, 0 / final_incorrect otherwise '
  '(R-007 OD-004: single officially-named winner only -- no tie-share). Idempotent by '
  'caller-supplied run_id (R-002). Writes new score_records rows at the current '
  'tournament_config.current_calculation_version, then bumps the pointer (R-003 '
  'flip-the-pointer) ONLY if at least one row was written. All point values come from '
  'tournament_config (Principle VIII). Audit rows are emitted by the AFTER INSERT trigger '
  'on score_records (T014, slot 0055); this SP does not write to audit_log directly. '
  'SECURITY DEFINER is the only legitimate RLS-bypass write path to score_records.';

-- ---------------------------------------------------------------------------
-- Permissions: lock down PUBLIC, grant to authenticated (Edge Function
-- caller surface) and service_role (admin recalc surface). Mirrors
-- slot 0052 score_match permissions block.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.score_finals(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.score_finals(uuid) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.score_finals(uuid) TO service_role';
  END IF;
END
$$;

COMMIT;
