-- Slice 005 follow-up (2026-05-23) — fix the off-by-one between the score
-- SPs and the reader views (leaderboard_v + personal_breakdown_v).
--
-- See specs/005-scoring-leaderboard/follow-up-current-calculation-version-off-by-one.md
-- for the full diagnosis. Short version:
--
--   Original SPs (slots 0052/0053/0058) read the current pointer N,
--   wrote score_records at v=N, then bumped the pointer to v=N+1.
--   Reader views filter at the pointer, which is N+1, so the records at
--   v=N are invisible. Both leaderboard_v and personal_breakdown_v
--   return zero-data for every participant after a scoring run.
--
-- Fix (Option A in the follow-up doc): each SP now treats v_target_version
-- as "the version this run WRITES at" = current_pointer + 1. The
-- score_records rows go in at v=N+1, the pointer is then bumped to v=N+1,
-- and the reader views (which filter at v=N+1) see the just-committed
-- rows. The `calculation_version_written` returned to callers becomes the
-- new version (v=N+1), matching what the SPs actually wrote.
--
-- This migration re-creates the three SPs via CREATE OR REPLACE. The
-- function bodies are COPIED VERBATIM from the original migration files
-- (0052/0053/0058) with exactly two targeted edits per SP:
--
--   (1) After the NULL-check on v_target_version, the line
--         v_target_version := v_target_version + 1;
--       is inserted. v_target_version now represents the NEW version this
--       run writes at (was: the OLD current pointer).
--
--   (2) The pointer-bump UPDATE statement is changed from
--         SET value = to_jsonb(v_target_version + 1)
--       to
--         SET value = to_jsonb(v_target_version)
--       so the pointer matches the version we wrote, not "next slot."
--
-- Original migrations 0052/0053/0058 are NOT edited (immutability
-- convention for already-applied migrations).
--
-- @see supabase/migrations/0052_score_match_fn.sql
-- @see supabase/migrations/0053_score_finals_fn.sql
-- @see supabase/migrations/0058_score_all_fn.sql
-- @see supabase/migrations/0054_leaderboard_views.sql (the reader)
-- @see supabase/migrations/0078_personal_breakdown_view.sql (the reader)

-- ============================================================
-- Patched body of 0052_score_match_fn.sql
-- ============================================================
CREATE OR REPLACE FUNCTION public.score_match(
  p_match_id uuid,
  p_run_id   uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_status        public.score_run_status;
  v_match_status           public.match_status;
  v_official_home          int;
  v_official_away          int;
  v_pts_exact              int;
  v_pts_outcome            int;
  v_pts_incorrect          int;
  v_target_version         int;
  v_affected_count         int;
BEGIN
  -- -------------------------------------------------------------------------
  -- Step 1: Idempotency guard. UPSERT the run row keyed by caller-supplied
  -- p_run_id. ON CONFLICT DO NOTHING means a replay with the same run_id is
  -- a no-op at the run-row level. We then re-read the row to learn whether
  -- this is a fresh run (we inserted it) or a replay (a prior call inserted
  -- it). triggered_by uses auth.uid(); in pgTAP / direct-SQL contexts this
  -- may be NULL, which the score_calculation_runs.triggered_by NOT NULL
  -- constraint would reject -- runtime verification (T016) covers that path
  -- with a real JWT or an admin-seeded system participant fallback.
  -- -------------------------------------------------------------------------
  INSERT INTO public.score_calculation_runs (
    id, scope, target_id, "trigger", triggered_by, started_at, status, reason
  )
  VALUES (
    p_run_id,
    'match',
    p_match_id,
    'match_finish',
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
  -- pointer). This is the T011 A1/A2 "true no-op contract".
  IF v_existing_status = 'succeeded' THEN
    RETURN p_run_id;
  END IF;

  -- A prior run with the same run_id that failed must NOT silently retry --
  -- the admin must explicitly reset the row (e.g. via a Slice 006 admin
  -- recalc path) so the failure surface stays visible. Raising here keeps
  -- the caller honest.
  IF v_existing_status = 'failed' THEN
    RAISE EXCEPTION
      'score_match: run % previously failed; admin must reset before retry',
      p_run_id
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 2: Read the match's official result. The match MUST be 'finished'
  -- (per the match_status enum from slot 0020) and MUST have a match_results
  -- row populated. score_match is the runtime contract for "post-finish
  -- scoring" -- calling it on a scheduled / in_progress / postponed /
  -- cancelled match raises.
  -- -------------------------------------------------------------------------
  SELECT m.status,
         mr.home_score_for_scoring,
         mr.away_score_for_scoring
    INTO v_match_status, v_official_home, v_official_away
    FROM public.matches m
    LEFT JOIN public.match_results mr ON mr.match_id = m.id
   WHERE m.id = p_match_id;

  IF NOT FOUND THEN
    UPDATE public.score_calculation_runs
       SET status       = 'failed',
           completed_at = now(),
           notes        = format('match %s not found', p_match_id)
     WHERE id = p_run_id;
    RAISE EXCEPTION 'score_match: match % not found', p_match_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_match_status <> 'finished' THEN
    UPDATE public.score_calculation_runs
       SET status       = 'failed',
           completed_at = now(),
           notes        = format('match %s status=%s, expected finished',
                                 p_match_id, v_match_status)
     WHERE id = p_run_id;
    RAISE EXCEPTION
      'score_match: match % status=%, expected ''finished''',
      p_match_id, v_match_status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_official_home IS NULL OR v_official_away IS NULL THEN
    UPDATE public.score_calculation_runs
       SET status       = 'failed',
           completed_at = now(),
           notes        = format('match %s has no match_results row', p_match_id)
     WHERE id = p_run_id;
    RAISE EXCEPTION
      'score_match: match % has no match_results / for-scoring columns',
      p_match_id
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 3: Read scoring constants from tournament_config. ALL point values
  -- come from config -- the SP never hard-codes 10 / 5 / 0 (Principle VIII).
  -- jsonb-int extraction: `(value)::int` works because slot 0057 stores these
  -- keys as bare JSON numbers (e.g. '10'::jsonb).
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

  IF v_pts_exact IS NULL OR v_pts_outcome IS NULL OR v_pts_incorrect IS NULL THEN
    UPDATE public.score_calculation_runs
       SET status       = 'failed',
           completed_at = now(),
           notes        = 'tournament_config missing match_points.* keys'
     WHERE id = p_run_id;
    RAISE EXCEPTION
      'score_match: tournament_config missing one of match_points.{exact,outcome,incorrect}'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 4: Read the current calculation_version pointer. New score_records
  -- rows are written AT this version (matching the slice-005 fixture's
  -- hand-verified "calculation_version = 1" after the first scoring pass
  -- against a seed pointer of 1, and T011 A3/A4 which assert the FIRST run
  -- writes rows at v_initial and the SECOND run at v_initial + 1). After
  -- the INSERTs land we bump the pointer to v_target_version + 1 so the
  -- NEXT distinct-run_id call lands at the next version. Readers
  -- filtering on tournament_config.current_calculation_version always
  -- observe the latest committed snapshot (R-003).
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
      'score_match: tournament_config missing current_calculation_version'
      USING ERRCODE = 'P0001';
  END IF;

  -- 2026-05-23 follow-up patch: v_target_version is the NEW version this run
  -- writes at (= current pointer + 1). The pointer is bumped to v_target_version
  -- after the INSERT so reader views (leaderboard_v, personal_breakdown_v) that
  -- filter at the current pointer immediately observe the just-written rows.
  v_target_version := v_target_version + 1;

  -- -------------------------------------------------------------------------
  -- Step 5: Defensive cleanup. On a fresh run this DELETE is a no-op (no
  -- rows exist yet at v_target_version for this match). On a retry-after-
  -- error path (the prior run row was deleted or status='running' is
  -- somehow re-entered) it prevents the upcoming INSERT from tripping
  -- score_records_uk. The append-only history at LOWER versions is
  -- untouched.
  -- -------------------------------------------------------------------------
  DELETE FROM public.score_records
   WHERE target_kind        = 'match'
     AND target_id           = p_match_id
     AND calculation_version = v_target_version;

  -- -------------------------------------------------------------------------
  -- Step 6: INSERT one score_records row per (eligible active participant,
  -- match) pair. LEFT JOIN to predictions so participants without an
  -- active prediction still emit a row with reason_code='none' (US1.4).
  --
  -- Eligibility: status='active' AND
  -- public.is_eligible_nortal_participant(auth_user_id) -- the latter is
  -- the LOCKED cross-slice predicate from slot 0005 (signature uuid->boolean,
  -- STABLE, SECURITY INVOKER). Inside this SECURITY DEFINER SP it executes
  -- with the owner's rights but the predicate itself is a pure SELECT so
  -- the effective check is identical to the runtime auth path.
  --
  -- The CASE expression encodes the §7.2 truth table. sign(int) returns
  -- numeric (-1, 0, or 1) which compares cleanly. NULL handling: pr.id IS
  -- NULL detects the no-active-prediction branch BEFORE the score
  -- comparisons, so the CASE never compares NULL scores.
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
    p.id                                                    AS participant_id,
    'match'::public.score_target_kind                        AS target_kind,
    p_match_id                                               AS target_id,
    p_match_id                                               AS match_id,
    NULL::public.final_item_kind                             AS final_item_kind,
    pr.predicted_home                                        AS predicted_home,
    pr.predicted_away                                        AS predicted_away,
    NULL::uuid                                               AS predicted_team_or_player_id,
    CASE WHEN pr.id IS NULL THEN NULL ELSE v_official_home END AS official_home,
    CASE WHEN pr.id IS NULL THEN NULL ELSE v_official_away END AS official_away,
    NULL::uuid                                               AS official_team_or_player_id,
    CASE
      WHEN pr.id IS NULL                                                       THEN 0
      WHEN pr.predicted_home = v_official_home
       AND pr.predicted_away = v_official_away                                 THEN v_pts_exact
      WHEN sign(pr.predicted_home - pr.predicted_away)
         = sign(v_official_home  - v_official_away)                            THEN v_pts_outcome
      ELSE                                                                          v_pts_incorrect
    END                                                       AS points,
    CASE
      WHEN pr.id IS NULL                                                       THEN 'none'::public.score_reason_code
      WHEN pr.predicted_home = v_official_home
       AND pr.predicted_away = v_official_away                                 THEN 'exact'::public.score_reason_code
      WHEN sign(pr.predicted_home - pr.predicted_away)
         = sign(v_official_home  - v_official_away)                            THEN 'outcome'::public.score_reason_code
      ELSE                                                                          'incorrect'::public.score_reason_code
    END                                                       AS reason_code,
    v_target_version                                          AS calculation_version,
    now()                                                     AS calculated_at,
    p_run_id                                                  AS run_id,
    'auto'::public.score_source                               AS source
  FROM public.participants p
  LEFT JOIN public.predictions pr
         ON pr.participant_id = p.id
        AND pr.match_id       = p_match_id
        AND pr.superseded_at IS NULL
  WHERE p.status = 'active'
    AND public.is_eligible_nortal_participant(p.auth_user_id);

  GET DIAGNOSTICS v_affected_count = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Step 7: Bump the current_calculation_version pointer. Done in the same
  -- transaction as the INSERTs so MVCC readers see either the pre-run
  -- snapshot (old pointer + no new rows visible) or the post-run snapshot
  -- (new pointer + new rows visible) -- never a partial state (FR-012 /
  -- SC-008). The new pointer is v_target_version + 1 because the NEXT
  -- scoring run for any match must land at a higher version.
  -- -------------------------------------------------------------------------
  UPDATE public.tournament_config
     SET value      = to_jsonb(v_target_version),
         updated_at = now()
   WHERE key = 'current_calculation_version';

  -- -------------------------------------------------------------------------
  -- Step 8: Mark the run terminal-success. The score_calculation_runs CHECK
  -- score_calculation_runs_succeeded_completeness requires completed_at,
  -- affected_record_count, AND calculation_version_written all populated on
  -- transition to 'succeeded' -- all three are set in one UPDATE.
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

-- ============================================================
-- Patched body of 0053_score_finals_fn.sql
-- ============================================================
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

  -- 2026-05-23 follow-up patch: v_target_version is the NEW version this run
  -- writes at (= current pointer + 1). The pointer is bumped to v_target_version
  -- after the INSERT so reader views (leaderboard_v, personal_breakdown_v) that
  -- filter at the current pointer immediately observe the just-written rows.
  v_target_version := v_target_version + 1;

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
       SET value      = to_jsonb(v_target_version),
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

-- ============================================================
-- Patched body of 0058_score_all_fn.sql
-- ============================================================
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

  -- 2026-05-23 follow-up patch: v_target_version is the NEW version this run
  -- writes at (= current pointer + 1). The pointer is bumped to v_target_version
  -- after the INSERT so reader views (leaderboard_v, personal_breakdown_v) that
  -- filter at the current pointer immediately observe the just-written rows.
  v_target_version := v_target_version + 1;

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
       SET value      = to_jsonb(v_target_version),
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

