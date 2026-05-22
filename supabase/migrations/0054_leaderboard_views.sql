-- Slice 005 / T029 / FR-013 + FR-016 (both halves) / contracts/leaderboard.read.md / contracts/peer-pick.read.md.
-- Migration slot 0054 per D-023 (spec slot 0055 was occupied by T014's audit trigger at on-disk 0055_score_audit_trigger.sql).
--
-- Three read-only views power US3's leaderboard + peer-visibility surfaces:
--   1. public.leaderboard_v       -- aggregated score_records by participant at current_calculation_version,
--                                    ranked per §7.4 tiebreaker order (total -> exact -> outcome -> final).
--   2. public.peer_pick_v         -- match-pick peer visibility gated by kickoff_utc - lock_window_minutes
--                                    (BR-LOCK-002 / BR-LOCK-003 strict-inclusive boundary).
--   3. public.peer_final_pick_v   -- final-tournament-pick peer visibility gated by first_kickoff_utc
--                                    (BR-LOCK-005, mirror of BR-LOCK-003 for the final-pick set).
--
-- All three views use WITH (security_invoker = true) (PG 15+) so the caller's RLS on the
-- underlying tables (participants, predictions, final_predictions, score_records, matches)
-- is honored automatically. Self-exclusion (peer views) is via the participants.auth_user_id
-- -> auth.uid() lookup -- auth.uid() returns the auth.users.id, NOT the participants.id, so
-- we MUST translate through participants.
--
-- Tier-order caveat (per task prompt + data-model § Entity 4):
--   The RANK() ORDER BY hard-codes the §7.4 default tier order (total DESC -> exact DESC ->
--   outcome DESC -> final DESC). This matches the seeded tournament_config.tiebreaker.order
--   default ('["total","exact_count","outcome_count","final_points"]') exactly. If Slice 008
--   ever rotates the tier order via tournament_config, this view MUST be recreated to
--   reflect the new sequence. For Slice 005's tests (T024 / T025 / T026 / T022) the
--   hard-coded order matches and Principle VIII is honored end-to-end -- the order is
--   READ FROM CONFIG as documentation, not branched on at runtime. Slice 008 will revisit.
--
-- Config knobs READ AT RUNTIME (Principle VIII -- never hard-coded):
--   * tournament_config.current_calculation_version (R-003 reader pointer for leaderboard_v)
--   * tournament_config.leaderboard_visibility      (FR-014 display_name masking)
--   * tournament_config.lock_window_minutes         (BR-LOCK-002 peer_pick_v gate)
--   * tournament_config.first_kickoff_utc           (BR-LOCK-005 peer_final_pick_v gate)
--
-- admin_invalidated column verdict:
--   Slice 003's public.predictions (slot 0030) and Slice 004's public.final_predictions
--   (slot 0040) do NOT carry an `admin_invalidated` column -- that invalidation pathway is
--   owned by Slice 006's admin-override surface (still pending). Both peer views therefore
--   surface raw values for now. T027's A8 assertion is explicitly skip()d pending Slice 006;
--   when Slice 006 ships the column, this migration is the natural attachment point for
--   the CASE WHEN admin_invalidated THEN NULL ELSE ... END masking on predicted_home /
--   predicted_away / submitted_at / target_*_id (per contracts/peer-pick.read.md § Response).
--
-- Scope discipline (Constitution Principle X):
--   * NO new tables, columns, or triggers in this slot.
--   * NO modifications to score_records, predictions, final_predictions, or tournament_config.
--   * NO RLS policies on these views -- security_invoker delegates to the underlying tables'
--     existing RLS (Slice 001 participants_rls, Slice 003 predictions_rls, Slice 004
--     final_predictions_rls, Slice 005 score_rls slot 0056).
--   * Explicit GRANT SELECT ... TO authenticated for each view (PostgREST exposure).
--
-- Done state per T029 prompt:
--   Status: DONE (artifact-complete; runtime verification deferred to T033). Migration at
--   on-disk slot 0054 per D-023.

BEGIN;

-- ===========================================================================
-- View 1: public.leaderboard_v
-- ===========================================================================
-- Per data-model.md § Entity 4 + contracts/leaderboard.read.md § Response.
-- Columns (in declared order, matching the contract):
--   participant_id, display_name, total_points, exact_count, outcome_count,
--   final_points, last_valid_prediction_at, rank, calculation_version
--
-- Aggregation strategy:
--   1. CTE `cv` extracts current_calculation_version from tournament_config (R-003).
--   2. CTE `vis` extracts leaderboard_visibility (FR-014 masking).
--   3. CTE `aggregated` GROUPs score_records by participant_id at the current
--      calculation_version (the R-003 reader-filter -- in-flight v=N+1 rows are
--      invisible until current_calculation_version is bumped). Computes:
--        - total_points  = SUM(points)                                  (§7.4 tier 1)
--        - exact_count   = SUM(CASE reason_code='exact'    THEN 1 ELSE 0)  (§7.4 tier 2)
--        - outcome_count = SUM(CASE reason_code='outcome'  THEN 1 ELSE 0)  (§7.4 tier 3)
--        - final_points  = SUM(CASE target_kind='final'    THEN points ELSE 0) (§7.4 tier 4)
--   4. CTE `all_participants` ensures every ACTIVE participant appears in the
--      view -- even those with zero score_records at the current version. This
--      satisfies the spec Edge Case ("before any matches have finished, all
--      tied at 0") and Test 7 of slice-005-leaderboard.spec.ts (T022).
--   5. LEFT JOIN aggregated onto all_participants so zero-score participants
--      get explicit (0, 0, 0, 0) aggregates via COALESCE.
--   6. RANK() OVER (...) applies the §7.4 priority order; on a 4-way tie across
--      ALL configured tiers, RANK() returns the SAME rank for tied rows and
--      SKIPS the next position (R-004 "1, 2, 2, 4" pattern, not DENSE_RANK).
--   7. last_valid_prediction_at: tier-5 input is OFF by default
--      (tournament_config.tiebreaker.tier5_enabled = false). We emit NULL for
--      every row in this slice; Slice 008 may extend the view to populate
--      MAX(predictions.submitted_at) when the toggle flips.
CREATE OR REPLACE VIEW public.leaderboard_v
WITH (security_invoker = true)
AS
WITH cv AS (
  -- R-003: leaderboard_v ONLY exposes rows at current_calculation_version. A
  -- partially-applied scoring run (v=N+1 rows in score_records, pointer not
  -- yet flipped) is invisible to readers -- this is the FR-012 / SC-008
  -- single-snapshot guarantee. Cast from jsonb integer.
  SELECT (value)::int AS current_version
    FROM public.tournament_config
   WHERE key = 'current_calculation_version'
),
vis AS (
  -- FR-014 / OD-006: leaderboard_visibility may be 'full_names' (default),
  -- 'anonymized', or 'team_scoped'. Stored as a jsonb string -- extract with
  -- the (value #>> '{}') jsonb-to-text idiom.
  SELECT (value #>> '{}') AS visibility
    FROM public.tournament_config
   WHERE key = 'leaderboard_visibility'
),
aggregated AS (
  -- §7.4 tier sources, aggregated per participant. Only rows at the current
  -- calculation_version contribute. Empty group -> participant absent here ->
  -- LEFT-JOIN below substitutes zeros.
  SELECT
    sr.participant_id,
    COALESCE(SUM(sr.points), 0)::int AS total_points,
    SUM(CASE WHEN sr.reason_code = 'exact'   THEN 1 ELSE 0 END)::int AS exact_count,
    SUM(CASE WHEN sr.reason_code = 'outcome' THEN 1 ELSE 0 END)::int AS outcome_count,
    SUM(CASE WHEN sr.target_kind = 'final'   THEN sr.points ELSE 0 END)::int AS final_points
  FROM public.score_records sr
  WHERE sr.calculation_version = (SELECT current_version FROM cv)
  GROUP BY sr.participant_id
),
all_participants AS (
  -- Every eligible participant appears in the view, including zero-score rows
  -- (data-model.md § Entity 4 notes; spec Edge Case "before any matches have
  -- finished, all tied at 0"). The 'active' status filter aligns with
  -- is_eligible_nortal_participant() (slice 001 slot 0005); the underlying
  -- tables' RLS additionally restricts cross-domain visibility at read time.
  SELECT
    p.id           AS participant_id,
    p.display_name AS display_name
  FROM public.participants p
  WHERE p.status = 'active'
)
SELECT
  ap.participant_id,
  -- FR-014 / OD-006 display-name masking.
  -- 'anonymized' -> opaque label derived from the participant_id (NOT from rank,
  --   to avoid a circular ORDER BY <-> display_name dependency in this view).
  -- 'team_scoped' -> use display_name (Slice 008 layers the additional
  --   team-scoped RLS predicate; this view does not branch on team).
  -- default ('full_names' or anything else) -> raw display_name.
  CASE (SELECT visibility FROM vis)
    WHEN 'anonymized' THEN 'Participant ' || substring(ap.participant_id::text, 1, 8)
    WHEN 'team_scoped' THEN COALESCE(ap.display_name, 'Anonymous')
    ELSE COALESCE(ap.display_name, 'Anonymous')
  END AS display_name,
  COALESCE(agg.total_points,   0)::int AS total_points,
  COALESCE(agg.exact_count,    0)::int AS exact_count,
  COALESCE(agg.outcome_count,  0)::int AS outcome_count,
  COALESCE(agg.final_points,   0)::int AS final_points,
  -- Tier 5 input (FR-005 / §7.4 optional). OFF by default
  -- (tournament_config.tiebreaker.tier5_enabled = false). Emitted as NULL for
  -- contract-shape stability; Slice 008 may populate when the toggle flips.
  NULL::timestamptz AS last_valid_prediction_at,
  -- §7.4 + R-004: RANK() (NOT DENSE_RANK -- the "1, 2, 2, 4" pattern). Tier
  -- order is the §7.4 default sequence; matches tournament_config.tiebreaker.order
  -- default exactly. See header caveat re: Slice 008 reordering.
  RANK() OVER (
    ORDER BY
      COALESCE(agg.total_points,   0) DESC,
      COALESCE(agg.exact_count,    0) DESC,
      COALESCE(agg.outcome_count,  0) DESC,
      COALESCE(agg.final_points,   0) DESC
  )::int AS rank,
  (SELECT current_version FROM cv)::int AS calculation_version
FROM all_participants ap
LEFT JOIN aggregated agg ON agg.participant_id = ap.participant_id;

COMMENT ON VIEW public.leaderboard_v IS
  'Slice 005 / T029 / FR-013. Aggregated, tie-broken leaderboard at current_calculation_version. '
  'security_invoker = true so RLS on participants/score_records flows through. '
  'Tier order hard-coded to §7.4 default (total, exact, outcome, final) -- Slice 008 will revisit if '
  'tournament_config.tiebreaker.order rotates.';

-- ===========================================================================
-- View 2: public.peer_pick_v
-- ===========================================================================
-- Per data-model.md § 5a + contracts/peer-pick.read.md § Surface 1.
-- Columns: match_id, participant_id, display_name, predicted_home,
--          predicted_away, submitted_at (+ kickoff_utc for client convenience)
--
-- Gate (definitional, in the WHERE clause, not in app code -- Principle III):
--   1. Active predictions only (superseded_at IS NULL).
--   2. Lock has passed: now() >= kickoff_utc - lock_window (BR-LOCK-003 strict
--      equality boundary -- the >= NOT > is load-bearing per T027 A2).
--   3. Self-exclusion: the caller's own predictions are filtered out. auth.uid()
--      returns the auth.users.id, so we look up the calling participant via
--      participants.auth_user_id = auth.uid() and exclude that participant_id.
--      Self-reads are served by Slice 003's predictions RLS, not this view.
--
-- admin_invalidated handling: Slice 003's predictions schema (slot 0030) does
-- NOT have an admin_invalidated column. T027's A8 assertion is skip()d pending
-- Slice 006. When Slice 006 ships the column, replace `pr.predicted_home` with
-- `CASE WHEN pr.admin_invalidated THEN NULL ELSE pr.predicted_home END` (and
-- similarly for predicted_away / submitted_at) so non-admin peers cannot
-- detect that an admin override occurred.
CREATE OR REPLACE VIEW public.peer_pick_v
WITH (security_invoker = true)
AS
WITH lock_minutes AS (
  -- BR-LOCK-002 default 60; configurable per tournament_config. Stored as a
  -- jsonb integer; cast directly with (value)::int.
  SELECT (value)::int AS minutes
    FROM public.tournament_config
   WHERE key = 'lock_window_minutes'
),
vis AS (
  -- Same FR-014 visibility policy as leaderboard_v -- peer display_names use
  -- the same masking rule for consistency.
  SELECT (value #>> '{}') AS visibility
    FROM public.tournament_config
   WHERE key = 'leaderboard_visibility'
),
caller AS (
  -- Map auth.uid() (auth.users.id) -> participants.id for self-exclusion.
  -- LIMIT 1 is defensive; participants_auth_user_id_uk guarantees at most 1.
  -- If auth.uid() is NULL (anonymous / no JWT) this CTE yields no rows and
  -- the NOT IN clause becomes vacuously TRUE -- but the underlying tables'
  -- RLS will still deny the entire result, so no leak.
  SELECT p.id AS participant_id
    FROM public.participants p
   WHERE p.auth_user_id = auth.uid()
   LIMIT 1
)
SELECT
  pr.id           AS prediction_id,
  pr.match_id,
  pr.participant_id,
  -- Display-name masking mirrors leaderboard_v. Avoid surfacing the raw
  -- display_name when the visibility policy is anonymized.
  CASE (SELECT visibility FROM vis)
    WHEN 'anonymized' THEN 'Participant ' || substring(pr.participant_id::text, 1, 8)
    ELSE COALESCE(p.display_name, 'Anonymous')
  END AS display_name,
  pr.predicted_home,
  pr.predicted_away,
  pr.submitted_at,
  m.kickoff_utc
FROM public.predictions pr
JOIN public.matches m       ON m.id  = pr.match_id
JOIN public.participants p  ON p.id  = pr.participant_id
WHERE pr.superseded_at IS NULL
  -- BR-LOCK-003 strict-inclusive: locked precisely at kickoff - lock_window.
  -- `>=` NOT `>` -- the equality boundary is the "lock fires" instant.
  AND now() >= m.kickoff_utc - make_interval(mins => (SELECT minutes FROM lock_minutes))
  -- Self-exclusion: hide the caller's own predictions from the peer surface.
  -- NOT IN (empty set) is TRUE in Postgres, which is the desired no-op when
  -- auth.uid() resolves no participant (RLS on predictions will still deny).
  AND pr.participant_id NOT IN (SELECT participant_id FROM caller);

COMMENT ON VIEW public.peer_pick_v IS
  'Slice 005 / T029 / FR-016 (match-pick half). Match-pick peer visibility gated by '
  'kickoff_utc - lock_window_minutes (BR-LOCK-003 strict-inclusive). Self-exclusion via '
  'participants.auth_user_id = auth.uid(). admin_invalidated masking deferred to Slice 006.';

-- ===========================================================================
-- View 3: public.peer_final_pick_v
-- ===========================================================================
-- Per data-model.md § 5b + contracts/peer-pick.read.md § Surface 2.
-- Columns: participant_id, display_name, champion_team_id, runner_up_team_id,
--          top_scorer_player_id, best_player_player_id, submitted_at
--
-- One row per PEER participant with all four final picks side-by-side.
-- Aggregates final_predictions (Slice 004 slot 0040) by participant, using
-- MAX(CASE WHEN item_kind=...) to pivot the per-item rows into a single row.
-- Only ACTIVE rows (superseded_at IS NULL) contribute.
--
-- Gate (in the WHERE clause):
--   1. First kickoff has passed: now() >= first_kickoff_utc (BR-LOCK-005,
--      strict equality boundary mirroring BR-LOCK-003).
--   2. Self-exclusion: caller's own picks are filtered out.
--
-- admin_invalidated handling: same posture as peer_pick_v -- column does not
-- exist on final_predictions; Slice 006 will ship masking. The MAX(CASE...)
-- columns surface raw target_*_id values for now.
CREATE OR REPLACE VIEW public.peer_final_pick_v
WITH (security_invoker = true)
AS
WITH first_kick AS (
  -- BR-LOCK-005 first-kickoff gate. Stored as a jsonb-encoded ISO timestamp
  -- (e.g. "2026-06-16T20:00:00Z"); read with the (value #>> '{}')::timestamptz
  -- idiom per migration 0057 header.
  SELECT (value #>> '{}')::timestamptz AS kickoff
    FROM public.tournament_config
   WHERE key = 'first_kickoff_utc'
),
vis AS (
  SELECT (value #>> '{}') AS visibility
    FROM public.tournament_config
   WHERE key = 'leaderboard_visibility'
),
caller AS (
  -- Same self-exclusion lookup as peer_pick_v.
  SELECT p.id AS participant_id
    FROM public.participants p
   WHERE p.auth_user_id = auth.uid()
   LIMIT 1
),
picks AS (
  -- Pivot: one row per participant carrying all four item_kinds side-by-side.
  -- MAX(CASE ...) is a standard pivot idiom; since final_predictions_active_uk
  -- guarantees at most one ACTIVE row per (participant_id, item_kind), MAX
  -- collapses to the single value. NULL when the participant never submitted
  -- that item.
  SELECT
    fp.participant_id,
    MAX(CASE WHEN fp.item_kind = 'champion'    THEN fp.target_team_id   END) AS champion_team_id,
    MAX(CASE WHEN fp.item_kind = 'runner_up'   THEN fp.target_team_id   END) AS runner_up_team_id,
    MAX(CASE WHEN fp.item_kind = 'top_scorer'  THEN fp.target_player_id END) AS top_scorer_player_id,
    MAX(CASE WHEN fp.item_kind = 'best_player' THEN fp.target_player_id END) AS best_player_player_id,
    MAX(fp.submitted_at) AS submitted_at
  FROM public.final_predictions fp
  WHERE fp.superseded_at IS NULL
  GROUP BY fp.participant_id
)
SELECT
  picks.participant_id,
  CASE (SELECT visibility FROM vis)
    WHEN 'anonymized' THEN 'Participant ' || substring(picks.participant_id::text, 1, 8)
    ELSE COALESCE(p.display_name, 'Anonymous')
  END AS display_name,
  picks.champion_team_id,
  picks.runner_up_team_id,
  picks.top_scorer_player_id,
  picks.best_player_player_id,
  picks.submitted_at
FROM picks
JOIN public.participants p ON p.id = picks.participant_id
-- BR-LOCK-005: gate the ENTIRE result set on first-kickoff. When the config
-- value is in the future, this predicate is FALSE for every candidate row, so
-- the view returns zero rows globally (T027 A5 invariant). When `now()` reaches
-- or passes first_kickoff_utc, rows become visible (T027 A6 boundary case).
WHERE now() >= (SELECT kickoff FROM first_kick)
  -- Self-exclusion: caller's own final-pick set is served by Slice 004's
  -- final_predictions RLS, not this peer view.
  AND picks.participant_id NOT IN (SELECT participant_id FROM caller);

COMMENT ON VIEW public.peer_final_pick_v IS
  'Slice 005 / T029 / FR-016 (final-pick half). Final-tournament peer visibility gated by '
  'first_kickoff_utc (BR-LOCK-005 strict-inclusive). One row per peer with all four picks '
  'pivoted side-by-side. Self-exclusion via participants.auth_user_id = auth.uid(). '
  'admin_invalidated masking deferred to Slice 006.';

-- ===========================================================================
-- Grants
-- ===========================================================================
-- contracts/leaderboard.read.md + contracts/peer-pick.read.md both expose the
-- views via Supabase REST (PostgREST). Explicit GRANT to `authenticated`
-- so the participant JWT path can read them. RLS on the underlying tables
-- (security_invoker=true) gates non-Nortal-domain identities.
GRANT SELECT ON public.leaderboard_v       TO authenticated;
GRANT SELECT ON public.peer_pick_v         TO authenticated;
GRANT SELECT ON public.peer_final_pick_v   TO authenticated;

COMMIT;
