-- Slice 002 / T005 / FR-006 / data-model.md § match_results. home_score_for_scoring / away_score_for_scoring are LOCKED cross-slice contract names (Slice 005 reads them by name). NO RLS (T009), NO audit (T008), NO seed (T012).

BEGIN;

-- ---------------------------------------------------------------------------
-- public.match_results
-- ---------------------------------------------------------------------------
-- data-model.md § Entity match_results. Exactly one result row per match.
-- The columns `home_score_for_scoring` / `away_score_for_scoring` are the
-- LOCKED cross-slice contract names that Slice 005's scoring engine reads
-- by name; they are NOT to be renamed without a coordinated regression
-- update across slices 003-008 (Constitution Principle XI).
--
-- FR-006 (penalty shoot-out / extra-time handling): regulation + extra-time
-- goals are the scoring input. Penalty shoot-out goals decide the winner
-- but do NOT count as goals toward the for-scoring totals. This is enforced
-- by the `match_results_for_scoring_matches` CHECK below.
--
-- Schema-only in this migration: RLS lands in T009, audit triggers in T008,
-- seed data (if any) in T012.
CREATE TABLE public.match_results (
  -- One result row per match. ON DELETE RESTRICT so deleting a fixture row
  -- (data-model.md § Entity matches) cannot silently orphan scoring history.
  match_id                  uuid PRIMARY KEY
                              REFERENCES public.matches (id) ON DELETE RESTRICT,

  -- Regulation (90-minute) score, home / away. Always present for any
  -- recorded result regardless of result_status.
  home_score                int NOT NULL,
  away_score                int NOT NULL,

  -- Extra-time goals. NULL when no extra time was played (e.g., group-stage
  -- matches, knockout matches decided in regulation). Both columns are
  -- either both NULL or both set (see match_results_et_consistency CHECK).
  extra_time_home_score     int NULL,
  extra_time_away_score     int NULL,

  -- Penalty shoot-out goals. NULL when no shoot-out was needed. Both columns
  -- are either both NULL or both set (match_results_pen_consistency). A
  -- shoot-out implies extra time was played (match_results_pen_implies_et).
  penalty_home_score        int NULL,
  penalty_away_score        int NULL,

  -- LOCKED CROSS-SLICE NAME (Slice 005 reads by name).
  -- Equals home_score + COALESCE(extra_time_home_score, 0) per FR-006:
  -- regulation + extra time only; penalty-shootout goals decide the winner
  -- but do not count toward the scoring totals. Enforced by the
  -- match_results_for_scoring_matches CHECK so the contract is a CHECK,
  -- not just a convention.
  home_score_for_scoring    int NOT NULL,
  away_score_for_scoring    int NOT NULL,

  -- How the match concluded; tells /api/matches how to format the score
  -- string and tells the scoring engine that _for_scoring may differ from
  -- the official totals when result_status = 'penalty_shootout'.
  -- Enum-by-CHECK (match_results_status_enum) rather than a Postgres ENUM
  -- to keep additions cheap (no coordinated ALTER TYPE across slices).
  result_status             text NOT NULL,

  -- When this result row was first recorded. Slice 005 may key its
  -- "results approved since last scoring" query off this column.
  recorded_at               timestamptz NOT NULL DEFAULT now(),

  -- The admin who recorded the result, when applicable. NULL for
  -- provider_sync-driven recordings (no human actor). Slice 006 sets
  -- this on admin-override writes. ON DELETE SET NULL so removing a
  -- participant row does not block historical match-result reads.
  recorded_by               uuid NULL
                              REFERENCES public.participants (id) ON DELETE SET NULL,

  -- Origin of this row. 'provider_sync' = written by the sync coordinator;
  -- 'admin_override' = written by an admin via Slice 006's UI. The naming
  -- aligns loosely with audit_log.source conventions.
  source                    text NOT NULL,

  -- Standard housekeeping. updated_at is trigger-maintained below.
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- ---------------------------------------------------------------------
  -- CHECK invariants (named for greppability)
  -- ---------------------------------------------------------------------

  -- Regulation scores must be sane non-negative integers. Upper bound 999
  -- is a sanity guard against runaway provider data; no real match will
  -- ever approach it.
  CONSTRAINT match_results_home_score_nonneg
    CHECK (home_score >= 0 AND home_score <= 999),
  CONSTRAINT match_results_away_score_nonneg
    CHECK (away_score >= 0 AND away_score <= 999),

  -- Extra-time columns are either both NULL or both set. A match either
  -- went to extra time (both scores recorded, possibly 0) or it did not.
  CONSTRAINT match_results_et_consistency
    CHECK ((extra_time_home_score IS NULL) = (extra_time_away_score IS NULL)),

  -- Penalty-shootout columns are either both NULL or both set, same
  -- reasoning as the extra-time pair.
  CONSTRAINT match_results_pen_consistency
    CHECK ((penalty_home_score IS NULL) = (penalty_away_score IS NULL)),

  -- If extra time was played, the goals must be non-negative. Combined
  -- with match_results_et_consistency this also guarantees the away
  -- column is non-NULL when checked.
  CONSTRAINT match_results_et_nonneg
    CHECK (
      extra_time_home_score IS NULL
      OR (extra_time_home_score >= 0 AND extra_time_away_score >= 0)
    ),

  -- Same non-negativity guard for penalty-shootout columns.
  CONSTRAINT match_results_pen_nonneg
    CHECK (
      penalty_home_score IS NULL
      OR (penalty_home_score >= 0 AND penalty_away_score >= 0)
    ),

  -- Penalties require extra time to have been played first. You cannot
  -- skip from regulation to a shoot-out per FIFA knockout rules.
  CONSTRAINT match_results_pen_implies_et
    CHECK (penalty_home_score IS NULL OR extra_time_home_score IS NOT NULL),

  -- LOCKED CROSS-SLICE CONTRACT enforced as a CHECK: the for-scoring totals
  -- equal regulation + extra-time goals (FR-006). Slice 005 reads only the
  -- _for_scoring columns and trusts this invariant. Penalty shoot-out goals
  -- are deliberately excluded.
  CONSTRAINT match_results_for_scoring_matches
    CHECK (
      home_score_for_scoring = home_score + COALESCE(extra_time_home_score, 0)
      AND away_score_for_scoring = away_score + COALESCE(extra_time_away_score, 0)
    ),

  -- result_status enum-by-CHECK. 'walkover' covers awarded-without-play
  -- cases; 'no_result' covers abandoned / void matches. /api/matches uses
  -- these names verbatim to format the score string.
  CONSTRAINT match_results_status_enum
    CHECK (result_status IN ('regulation','extra_time','penalty_shootout','walkover','no_result')),

  -- source enum-by-CHECK. The two writer paths in scope for the platform:
  -- provider_sync (the sync coordinator) and admin_override (Slice 006).
  CONSTRAINT match_results_source_enum
    CHECK (source IN ('provider_sync','admin_override'))
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Admin override audit-trail view: most-recently-recorded results first.
-- Also supports Slice 005's "results recorded since last scoring run"
-- query pattern.
CREATE INDEX match_results_recorded_at_idx
  ON public.match_results (recorded_at DESC);

-- Filter provider_sync vs admin_override results. Used by the admin
-- dashboard's "show me admin-overridden results" filter and by ops
-- forensics when reconciling provider discrepancies.
CREATE INDEX match_results_source_idx
  ON public.match_results (source);

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger
-- ---------------------------------------------------------------------------
-- Reuses Slice 001's public.set_updated_at() function (established in
-- 0001_participants.sql line 43). Same convention as 0019_teams.sql and
-- 0020_matches.sql (T003 / T004).
CREATE TRIGGER match_results_set_updated_at
  BEFORE UPDATE ON public.match_results
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Documentation comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.match_results IS
  'Post-match result rows. One row per finished match. The columns home_score_for_scoring / away_score_for_scoring are LOCKED cross-slice contract names read by Slice 005 by name; they equal regulation + extra-time goals per FR-006 (penalty-shootout goals decide the winner but are excluded from scoring totals).';

COMMENT ON COLUMN public.match_results.match_id IS
  'PK and FK to public.matches(id). Exactly one result row per match. ON DELETE RESTRICT.';
COMMENT ON COLUMN public.match_results.home_score IS
  'Regulation (90-minute) goals scored by the home team.';
COMMENT ON COLUMN public.match_results.away_score IS
  'Regulation (90-minute) goals scored by the away team.';
COMMENT ON COLUMN public.match_results.extra_time_home_score IS
  'Goals scored by the home team in extra time. NULL when no extra time was played.';
COMMENT ON COLUMN public.match_results.extra_time_away_score IS
  'Goals scored by the away team in extra time. NULL when no extra time was played.';
COMMENT ON COLUMN public.match_results.penalty_home_score IS
  'Home team penalty-shootout score. NULL when no shootout was needed.';
COMMENT ON COLUMN public.match_results.penalty_away_score IS
  'Away team penalty-shootout score. NULL when no shootout was needed.';
COMMENT ON COLUMN public.match_results.home_score_for_scoring IS
  'LOCKED cross-slice contract name. Slice 005 reads this column by name. Equals home_score + COALESCE(extra_time_home_score, 0) per FR-006.';
COMMENT ON COLUMN public.match_results.away_score_for_scoring IS
  'LOCKED cross-slice contract name. Slice 005 reads this column by name. Equals away_score + COALESCE(extra_time_away_score, 0) per FR-006.';
COMMENT ON COLUMN public.match_results.result_status IS
  'How the match concluded: regulation | extra_time | penalty_shootout | walkover | no_result. Used by /api/matches to format the score string.';
COMMENT ON COLUMN public.match_results.recorded_at IS
  'When this result row was first recorded.';
COMMENT ON COLUMN public.match_results.recorded_by IS
  'Admin participant who recorded this result. NULL for provider_sync-driven rows.';
COMMENT ON COLUMN public.match_results.source IS
  'Origin of the row: provider_sync | admin_override.';
COMMENT ON COLUMN public.match_results.updated_at IS
  'Trigger-maintained on every UPDATE via public.set_updated_at(); never set by application code.';

COMMIT;
