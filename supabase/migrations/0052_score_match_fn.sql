-- Slice 005 / T013 / FR-011 / scoring-model.md § 7.2 / research.md § R-001 + R-002 + R-003.
-- Migration slot 0052 per D-023 (spec slot 0053 collapses to on-disk slot 0052 because
-- the slice-005 slot block 0050-0058 shifts -1 across the whole slice; prior shipped
-- migrations occupy 0049 score_records, 0050 score_calculation_runs, 0051 tournament_award,
-- 0056 RLS, 0057 score config defaults).
--
-- public.score_match(p_match_id uuid, p_run_id uuid) RETURNS uuid
--   The core scoring function for one finished match. Computes one
--   score_records row per (active eligible participant, match) pair per the
--   §7.2 truth table and bumps the current_calculation_version pointer per the
--   R-003 flip-the-pointer pattern.
--
-- Security posture:
--   * LANGUAGE plpgsql / SECURITY DEFINER -- the SP runs with the owner's
--       rights so it can write to score_records / score_calculation_runs /
--       tournament_config without depending on caller RLS. This is the
--       only legitimate RLS bypass path; every other write to these tables
--       must go through this SP (or score_finals / admin recalc SP) so the
--       audit trail is complete (Principle V).
--   * SET search_path = public, pg_temp -- defence against search-path
--       hijacking by malicious callers that prepend a schema.
--   * EXECUTE granted to authenticated only (Edge Function callers) plus
--       service_role for admin paths; PUBLIC revoked.
--
-- Idempotency (research.md § R-002):
--   * Caller-supplied run_id is the idempotency key. The first INSERT into
--       score_calculation_runs uses ON CONFLICT (id) DO NOTHING; on replay
--       the re-read shows status='succeeded' and the SP returns early without
--       re-scoring. The score_records_uk unique constraint on
--       (participant_id, target_kind, target_id, calculation_version) is the
--       belt-and-braces guarantee that any duplicate insert raises 23505.
--
-- Calculation version (research.md § R-003):
--   * The SP writes new rows at the CURRENT value of
--       tournament_config.current_calculation_version, then bumps the pointer
--       to current+1 in the same transaction. Readers filtering on
--       current_calculation_version always see one self-consistent snapshot.
--       This matches the hand-verified fixture truth table
--       (slice-005-fixture.sql: "calculation_version = 1" after the first
--       scoring pass against a seed pointer value of 1) and the T011
--       idempotency test's A3 / A4 assertions.
--
-- Reason-code logic (scoring-model.md § 7.2):
--   * No active prediction               -> ('none',       0 points)
--   * Predicted (h,a) == official (h,a)  -> ('exact',      match_points.exact)
--   * sign(h-a) == sign(off_h-off_a)     -> ('outcome',    match_points.outcome)
--   * Otherwise                          -> ('incorrect',  match_points.incorrect)
--
-- Rules-from-config (Principle VIII):
--   * All point values are SELECTed from public.tournament_config; NOT
--       hard-coded. Keys: match_points.exact / match_points.outcome /
--       match_points.incorrect / current_calculation_version. T006 seeds
--       these in slot 0057.
--
-- Audit rows:
--   * Produced by the AFTER INSERT trigger on score_records (T014, slot
--       0055 -- NOT YET SHIPPED at the time T013 lands). This SP does NOT
--       write to audit_log directly; the trigger fan-out is the single
--       source of truth for audit emission. The T011 A5 assertion
--       (audit_log >= 12 entries for two runs of 6 rows each) is RED until
--       T014 lands.
--
-- Knockout score basis (research.md § R-006 / OD-002):
--   * match_results.home_score_for_scoring / away_score_for_scoring are the
--       LOCKED cross-slice contract names (slot 0021 CHECK enforces them =
--       regulation + extra_time; penalty shoot-out goals are excluded). This
--       SP reads ONLY the for-scoring columns and trusts the contract.
--
-- Eligibility filter:
--   * Only participants with status='active' AND passing
--       public.is_eligible_nortal_participant(auth_user_id) contribute a
--       row. Deactivated or non-Nortal-domain participants are excluded.
--       Acceptance Scenario US1.4 ("no valid prediction") is captured by
--       the LEFT JOIN -- eligible participants without an active prediction
--       emit a ('none', 0) row.

BEGIN;

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
     SET value      = to_jsonb(v_target_version + 1),
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

COMMENT ON FUNCTION public.score_match(uuid, uuid) IS
  'Slice 005 / T013 / FR-011. Scores all eligible-participant predictions for one finished match. '
  'Idempotent by caller-supplied run_id (research.md § R-002). Writes one score_records row per '
  '(participant, match) pair at the current tournament_config.current_calculation_version, then '
  'bumps the pointer in the same transaction (research.md § R-003 flip-the-pointer). All point '
  'values come from tournament_config (Principle VIII). Audit rows are emitted by the AFTER INSERT '
  'trigger on score_records (T014, slot 0055); this SP does not write to audit_log directly. '
  'SECURITY DEFINER is the only legitimate RLS-bypass write path to score_records.';

-- ---------------------------------------------------------------------------
-- Permissions: lock down PUBLIC, grant to authenticated (Edge Function
-- caller surface) and service_role (admin recalc surface).
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.score_match(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.score_match(uuid, uuid) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.score_match(uuid, uuid) TO service_role';
  END IF;
END
$$;

COMMIT;
