-- Slice 005 / T035 / US4 / FR-014 / data-model.md § Entity 5 / contracts/personal-breakdown.read.md.
-- Migration slot 0054b per D-023 (spec slot 0055b -- on-disk slot 0054b is a sub-slot of
-- T029's 0054_leaderboard_views.sql, reserved for the personal-breakdown view alone so the
-- T029 multi-view migration is not rewritten in-place).
--
-- personal_breakdown_v: one row per (caller participant x finished match) PLUS one row per
-- (caller participant x active final_predictions row). The view powers US4's /me/breakdown
-- transparency surface (T036) and underwrites SC-002 ("sum of breakdown rows equals
-- leaderboard total") -- both halves of this view aggregate the same underlying score_records
-- as leaderboard_v, so the invariant is structural.
--
-- Self-only via RLS (security_invoker=true):
--   * The underlying score_records.RLS (slot 0056 / T007) restricts reads to
--       participant_id IN (SELECT id FROM participants WHERE auth_user_id = auth.uid()).
--   * Defense-in-depth: every CTE in this view ALSO filters on the same predicate so the
--       caller cannot trip a join that surfaces a different participant's row even if a
--       future RLS regression weakens the score_records policy. T029's peer views use the
--       same belt-and-braces pattern (caller CTE for self-exclusion); here we use the same
--       shape for self-inclusion.
--   * official_display is NULL when reason_code='final_pending' so the UI (T036) can render
--       "scoring pending" rather than implying 0 -- matches contract § Response.
--
-- Source columns wired through score_records (slot 0049):
--   * predicted_home / predicted_away                       (match-kind predicted score)
--   * predicted_team_or_player_id                           (final-kind predicted target)
--   * official_home / official_away                         (match-kind official score)
--   * official_team_or_player_id                            (final-kind official target;
--                                                            NULL when reason_code='final_pending')
--   * points / reason_code / calculation_version            (passthrough)
--   * final_item_kind                                       (NULL for match rows)
--
-- Defense-in-depth on the LEFT JOIN side (match rows):
--   * score_match (slot 0052) writes a ('none', 0) row for every (active eligible
--       participant, finished match) pair, so in practice the LEFT JOIN finds a score_records
--       row 100% of the time. Still, the LEFT JOIN + COALESCE(points,0) /
--       reason_code='none' default is what data-model.md § Entity 5 calls for and is what
--       the contract assumes structurally -- it keeps the breakdown showing zeros if
--       score_match's no-prediction row is ever absent (e.g. a participant joined after
--       a match was scored).
--   * For final rows we read score_records directly with NO cartesian padding: the contract
--       § Response says "one row per final-prediction item that has been scored" -- if a
--       participant never picked best_player, no row appears (Test 4 of slice-005-breakdown
--       explicitly tolerates either implementation: skip the row OR emit a 'none'-reason
--       row). score_finals only writes rows for participants with an active final_prediction
--       so the absence of a row is the natural outcome.
--
-- Reads tournament_config.current_calculation_version (R-003) so a partially-applied
-- scoring run is invisible to readers -- identical to leaderboard_v's posture.
--
-- Scope discipline (Constitution Principle X):
--   * NO new tables, columns, triggers, or RLS policies in this slot.
--   * NO modifications to score_records / predictions / final_predictions / score_rls /
--       tournament_config.
--   * NO RLS policy on the view -- security_invoker=true delegates to the underlying
--       tables' existing RLS.
--   * Explicit GRANT SELECT ... TO authenticated for PostgREST exposure.

BEGIN;

-- ===========================================================================
-- View: public.personal_breakdown_v
-- ===========================================================================
-- Per data-model.md § Entity 5 + contracts/personal-breakdown.read.md § Response.
-- Columns (in declared order, matching the contract):
--   participant_id, target_kind, target_id, target_label, predicted_display,
--   official_display, points, reason_code, final_item_kind, calculation_version
--
-- Composition strategy:
--   1. CTE `cv`     extracts current_calculation_version from tournament_config (R-003).
--   2. CTE `caller` maps auth.uid() -> participants.id for defense-in-depth self-filter.
--   3. CTE `match_rows` LEFT JOINs the caller's (participant_id x finished match) cartesian
--                       against score_records at current_calculation_version. predicted_display
--                       is '' (empty string per contract) when no prediction row exists OR
--                       reason_code='none'. official_display is read from match_results.
--   4. CTE `final_rows` SELECTs score_records WHERE target_kind='final' and the caller is
--                       the row's participant. predicted/official displays are resolved via
--                       lookups into teams (for champion/runner_up) / players (for
--                       top_scorer/best_player). official_display is NULL on final_pending.
--   5. UNION ALL of the two CTEs. ORDER BY is intentionally NOT applied here -- ORDER BY in
--      a view definition is not always preserved by Postgres; the T036 page resorts client-side
--      and the PostgREST surface accepts ?order= per the contract.
CREATE OR REPLACE VIEW public.personal_breakdown_v
WITH (security_invoker = true)
AS
WITH cv AS (
  -- R-003 reader pointer. Cast from jsonb integer; mirrors leaderboard_v's cv CTE.
  SELECT (value)::int AS current_version
    FROM public.tournament_config
   WHERE key = 'current_calculation_version'
),
caller AS (
  -- Map auth.uid() (auth.users.id) -> participants.id. The same idiom T029's peer views
  -- use for self-exclusion; here we use it for self-inclusion. LIMIT 1 is defensive
  -- (participants_auth_user_id_uk guarantees at most one row).
  SELECT p.id AS participant_id
    FROM public.participants p
   WHERE p.auth_user_id = auth.uid()
   LIMIT 1
),
match_rows AS (
  -- One row per (caller, finished match). LEFT JOIN score_records so a missing
  -- score row (defensive: should not happen because score_match writes a 'none' row
  -- for every eligible participant, but the LEFT JOIN is the data-model contract)
  -- yields points=0 / reason_code='none' / official_display from match_results.
  --
  -- predicted_display: empty string '' when no active prediction exists per contract
  -- § Response. When sr.reason_code='none' the score_records row has predicted_home /
  -- predicted_away NULL (score_match's no-prediction branch); the CASE collapses to ''.
  --
  -- target_label: '<HOME> vs <AWAY> · <Stage>'. Stage codes (group/r16/qf/sf/final/
  -- third_place) are surfaced verbatim from public.match_stage -- T036 may map them to
  -- localized labels client-side. group rows include the group letter via
  -- matches.group_id (e.g. 'Group A') -- the CASE below assembles it.
  SELECT
    c.participant_id,
    'match'::public.score_target_kind AS target_kind,
    m.id AS target_id,
    -- '<HOME> vs <AWAY> · <Stage label>' per data-model.md § Entity 5 + contract § Response.
    -- 'Group A' for group-stage matches (combines stage + group_id); the bare stage code
    -- for knockout rounds.
    (th.short_code || ' vs ' || ta.short_code || ' · ' ||
       CASE m.stage::text
         WHEN 'group'       THEN 'Group ' || COALESCE(m.group_id, '?')
         WHEN 'r16'         THEN 'Round of 16'
         WHEN 'qf'          THEN 'Quarter-final'
         WHEN 'sf'          THEN 'Semi-final'
         WHEN 'final'       THEN 'Final'
         WHEN 'third_place' THEN 'Third-place'
         ELSE m.stage::text
       END
    ) AS target_label,
    -- predicted_display: '<H>-<A>' from the active prediction (carried into score_records
    -- by score_match), '' if no valid prediction (contract § Response: 'empty string '' if
    -- no valid prediction was submitted').
    CASE
      WHEN sr.predicted_home IS NOT NULL AND sr.predicted_away IS NOT NULL
        THEN sr.predicted_home::text || '-' || sr.predicted_away::text
      ELSE ''
    END AS predicted_display,
    -- official_display: '<H>-<A>' from match_results.*_for_scoring (R-006 / OD-002). Always
    -- non-NULL because match_rows only iterates FINISHED matches (which guarantee a
    -- match_results row -- slice 002's record_match_result SP). Cast to text via concat.
    (mr.home_score_for_scoring::text || '-' || mr.away_score_for_scoring::text) AS official_display,
    COALESCE(sr.points, 0)::int AS points,
    COALESCE(sr.reason_code, 'none'::public.score_reason_code) AS reason_code,
    NULL::public.final_item_kind AS final_item_kind,
    (SELECT current_version FROM cv)::int AS calculation_version
  FROM caller c
  CROSS JOIN public.matches m
  JOIN public.match_results mr ON mr.match_id = m.id
  JOIN public.teams th ON th.id = m.home_team_id
  JOIN public.teams ta ON ta.id = m.away_team_id
  LEFT JOIN public.score_records sr
    ON sr.participant_id      = c.participant_id
   AND sr.target_kind         = 'match'
   AND sr.target_id           = m.id
   AND sr.calculation_version = (SELECT current_version FROM cv)
  WHERE m.status = 'finished'
),
final_rows AS (
  -- One row per active final score_records row owned by the caller. No cartesian padding
  -- against final_predictions: the contract emits a row only for final items that have been
  -- scored (i.e. the participant submitted a pick AND score_finals wrote a row at the
  -- current version). Test 4 in slice-005-breakdown.spec.ts explicitly allows the
  -- "no active best_player pick" case to surface zero rows -- score_finals writes nothing
  -- for that pair, so this CTE naturally omits it.
  --
  -- target_label: 'Champion' / 'Runner-up' / 'Top Scorer' / 'Best Player' per
  -- data-model.md § Entity 5 + contract § Response (verbatim casing per contract).
  --
  -- predicted_display: team short_code for champion/runner_up; player display_name (falling
  -- back to full_name) for top_scorer/best_player. score_records.predicted_team_or_player_id
  -- carries the FK target chosen at score-time (which the slice 004 supersede chain guarantees
  -- was the active pick at the moment score_finals fired).
  --
  -- official_display: NULL when reason_code='final_pending' (per contract § Response: "null
  -- if final_pending"); otherwise team short_code / player display_name resolved against
  -- score_records.official_team_or_player_id. score_finals stores the award's *_team_id /
  -- *_player_id at score-time so the breakdown surface does not need to re-read
  -- tournament_award (which avoids a TOCTOU window if the admin re-confirms after scoring).
  SELECT
    sr.participant_id,
    'final'::public.score_target_kind AS target_kind,
    sr.target_id,
    CASE sr.final_item_kind::text
      WHEN 'champion'    THEN 'Champion'
      WHEN 'runner_up'   THEN 'Runner-up'
      WHEN 'top_scorer'  THEN 'Top Scorer'
      WHEN 'best_player' THEN 'Best Player'
      ELSE sr.final_item_kind::text
    END AS target_label,
    -- predicted_display: short_code for team-kind items; display_name||full_name for player-kind.
    CASE sr.final_item_kind::text
      WHEN 'champion'    THEN COALESCE(pt.short_code, '')
      WHEN 'runner_up'   THEN COALESCE(pt.short_code, '')
      WHEN 'top_scorer'  THEN COALESCE(pp.display_name, pp.full_name, '')
      WHEN 'best_player' THEN COALESCE(pp.display_name, pp.full_name, '')
      ELSE ''
    END AS predicted_display,
    -- official_display: NULL when reason_code='final_pending' (contract: "null if final_pending");
    -- otherwise the official team short_code / player display_name resolved via score_records.
    CASE
      WHEN sr.reason_code = 'final_pending' THEN NULL
      WHEN sr.final_item_kind IN ('champion','runner_up')   THEN ot.short_code
      WHEN sr.final_item_kind IN ('top_scorer','best_player') THEN COALESCE(op.display_name, op.full_name)
      ELSE NULL
    END AS official_display,
    sr.points::int AS points,
    sr.reason_code,
    sr.final_item_kind,
    sr.calculation_version::int AS calculation_version
  FROM public.score_records sr
  -- Predicted team / player lookups -- only one of the two joins resolves to a row per
  -- final_item_kind (slot 0040's target_team_id XOR target_player_id CHECK is preserved
  -- through score_finals' predicted_team_or_player_id column).
  LEFT JOIN public.teams   pt ON pt.id = sr.predicted_team_or_player_id
                             AND sr.final_item_kind IN ('champion','runner_up')
  LEFT JOIN public.players pp ON pp.id = sr.predicted_team_or_player_id
                             AND sr.final_item_kind IN ('top_scorer','best_player')
  -- Official team / player lookups -- mirror shape; NULL official_team_or_player_id (the
  -- 'final_pending' branch) yields a no-match LEFT JOIN, which is fine because the CASE
  -- above forces NULL official_display on 'final_pending' regardless.
  LEFT JOIN public.teams   ot ON ot.id = sr.official_team_or_player_id
                             AND sr.final_item_kind IN ('champion','runner_up')
  LEFT JOIN public.players op ON op.id = sr.official_team_or_player_id
                             AND sr.final_item_kind IN ('top_scorer','best_player')
  WHERE sr.target_kind         = 'final'
    AND sr.calculation_version = (SELECT current_version FROM cv)
    -- Defense-in-depth self-filter mirrored from caller CTE. score_records.RLS already
    -- enforces this; the extra predicate is the belt-and-braces guard against an upstream
    -- policy regression. NOTE: omitting this would still be safe (RLS would deny) but the
    -- explicit predicate documents the contract at the view layer.
    AND sr.participant_id IN (SELECT participant_id FROM caller)
)
SELECT
  participant_id,
  target_kind,
  target_id,
  target_label,
  predicted_display,
  official_display,
  points,
  reason_code,
  final_item_kind,
  calculation_version
FROM match_rows
UNION ALL
SELECT
  participant_id,
  target_kind,
  target_id,
  target_label,
  predicted_display,
  official_display,
  points,
  reason_code,
  final_item_kind,
  calculation_version
FROM final_rows;

COMMENT ON VIEW public.personal_breakdown_v IS
  'Slice 005 / T035 / FR-014 / US4. One row per (caller x finished match) + one row per '
  '(caller x active final_predictions row at current_calculation_version). '
  'security_invoker = true so the underlying score_records self-read RLS (slot 0056) '
  'applies; the view ALSO filters by participants.auth_user_id = auth.uid() as '
  'defense-in-depth. official_display is NULL on reason_code=final_pending per '
  'contracts/personal-breakdown.read.md § Response.';

-- ===========================================================================
-- Grants
-- ===========================================================================
-- contracts/personal-breakdown.read.md § Access exposes the view via Supabase REST
-- (PostgREST). Explicit GRANT to `authenticated` so the participant JWT path can read
-- it; RLS on the underlying tables (security_invoker=true) gates non-Nortal-domain
-- identities and cross-participant access.
GRANT SELECT ON public.personal_breakdown_v TO authenticated;

COMMIT;
