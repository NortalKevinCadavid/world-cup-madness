-- Slice 005 / T003 / FR-006 / data-model.md § Entity 1.
-- Migration slot 0049 per D-023 (slice 005 renumber: spec slots 0050-0058
-- shift -1 to 0049-0057, because slice 004 ended at on-disk slot 0048).
-- score_calculation_runs FK is added by slot 0050 (T004) via ALTER TABLE --
-- circular dependency avoided (this migration MUST run before 0050 can add
-- the FK; 0050 creates score_calculation_runs and then attaches the FK on
-- score_records.run_id).
--
-- Per data-model.md § Entity 1: the awarded points for one (participant,
-- target) pair, where target is either a finished match or a final-tournament
-- item. Append-only by (calculation_version, participant_id, target_kind,
-- target_id) -- newer versions supersede older ones, but the older rows MUST
-- be preserved (audit history). Replacing a row means inserting a new row
-- with a higher calculation_version; the old row stays.
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS, NO RLS policies, NO GRANT/REVOKE beyond default ownership.
--       T007 (slot 0056 per D-023) owns the full Slice 005 RLS surface.
--   * NO audit trigger. T014 (slot 0055 per D-023) owns the AFTER INSERT
--       trigger that emits score_record audit_log rows.
--   * NO foreign keys to teams / players. data-model.md § Indexes and access
--       patterns says references by UUID only -- the polymorphic
--       predicted_team_or_player_id / official_team_or_player_id columns
--       resolve to teams(id) for team-kind finals and players(id) for
--       player-kind finals, validated by CHECK constraints rather than by FK
--       (FK enforcement would require splitting these into team-vs-player
--       columns, which loses the polymorphic shape this data-model selects).
--   * NO seed inserts. score_records is append-only via SQL functions
--       (score_match owned by T013 / slot 0052, score_finals owned by T019 /
--       slot 0053).
--   * NO FK to score_calculation_runs. T004 (slot 0050) creates that table
--       and attaches the FK via ALTER TABLE. Migration ordering: 0049 must
--       run before 0050 so the column exists when the FK is attached.

BEGIN;

-- ---------------------------------------------------------------------------
-- public.score_target_kind enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 1: which kind of target this row scores. 'match'
-- rows score a single finished match (104 per tournament); 'final' rows
-- score one of the four final-tournament items (champion, runner_up,
-- top_scorer, best_player) via the final_item_kind discriminator below.
CREATE TYPE public.score_target_kind AS ENUM (
  'match',
  'final'
);

-- ---------------------------------------------------------------------------
-- public.final_item_kind enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 1: the four final-tournament items. Mirrors Slice
-- 004's public.final_prediction_item_kind enum (separate enum here so this
-- table can evolve independently of final_predictions; Slice 005's
-- score_finals SP (T019) translates between the two enums when scoring).
CREATE TYPE public.final_item_kind AS ENUM (
  'champion',
  'runner_up',
  'top_scorer',
  'best_player'
);

-- ---------------------------------------------------------------------------
-- public.score_reason_code enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 1: the reason this row received its points.
--   * 'exact'           -- match-kind: predicted score matches official score.
--                          Awards match_points.exact (default 10).
--   * 'outcome'         -- match-kind: predicted outcome matches official
--                          outcome (home win / draw / away win) but not the
--                          exact score. Awards match_points.outcome (default 5).
--   * 'incorrect'       -- match-kind: predicted outcome differs from
--                          official outcome. Awards match_points.incorrect
--                          (default 0).
--   * 'none'            -- match-kind OR final-kind: participant had no
--                          valid prediction at lock time (or was
--                          admin-invalidated). Awards 0 points.
--   * 'final_correct'   -- final-kind: predicted item matches confirmed
--                          tournament_award value. Awards
--                          final_points.each_item (default 20).
--   * 'final_incorrect' -- final-kind: predicted item differs from confirmed
--                          tournament_award value. Awards 0 points.
--   * 'final_pending'   -- final-kind: tournament_award.*_status is still
--                          'pending' so the row is provisionally 0; will be
--                          re-scored when the award confirms (R-008 best
--                          player delay edge case).
CREATE TYPE public.score_reason_code AS ENUM (
  'exact',
  'outcome',
  'incorrect',
  'none',
  'final_correct',
  'final_incorrect',
  'final_pending'
);

-- ---------------------------------------------------------------------------
-- public.score_source enum
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 1: which write path produced this row.
--   * 'auto'           -- the score-trigger Edge Function fired in response
--                         to a match_results insert or tournament_award
--                         confirmation (FR-007 auto-path).
--   * 'admin_override' -- Slice 006 admin manually set a points value,
--                         bypassing the normal score_match / score_finals
--                         truth table (audited via score_calculation_runs
--                         with trigger='admin_recalc').
--   * 'recalc'         -- a full re-score was triggered by a
--                         tournament_config change (FR-015) or a manual
--                         admin recalculation that re-runs the standard
--                         truth table (NOT an override).
CREATE TYPE public.score_source AS ENUM (
  'auto',
  'admin_override',
  'recalc'
);

-- ---------------------------------------------------------------------------
-- public.score_records
-- ---------------------------------------------------------------------------
CREATE TABLE public.score_records (
  -- data-model.md § Entity 1: stable identifier. Referenced by audit_log
  -- rows (T014 trigger) and by score_calculation_runs.affected_record_count
  -- bookkeeping. gen_random_uuid() is available via pgcrypto, enabled by
  -- migration 0001.
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- data-model.md § Entity 1: the participant whose points these are.
  -- ON DELETE RESTRICT to preserve the append-only audit history if a
  -- participant account is ever administratively removed.
  participant_id                  uuid NOT NULL
                                    REFERENCES public.participants (id) ON DELETE RESTRICT,

  -- data-model.md § Entity 1: which kind of target this row scores.
  -- Discriminator for the polymorphic target_id below.
  target_kind                     public.score_target_kind NOT NULL,

  -- data-model.md § Entity 1: the target's UUID. For target_kind='match'
  -- this is matches(id); for target_kind='final' this is a synthetic UUID
  -- for the (tournament_id, final_item_kind) pair (constructed by
  -- score_finals via deterministic UUIDv5 or similar -- T019's choice).
  -- NO FK declared here -- data-model.md § Indexes and access patterns
  -- explicitly states "reference by UUID only" because the FK would have to
  -- be polymorphic (matches vs synthetic) and Postgres does not support
  -- polymorphic FKs. The CHECK constraints below enforce match_id IS NOT
  -- NULL when target_kind='match'; that match_id column DOES have a real
  -- FK to matches(id).
  target_id                       uuid NOT NULL,

  -- data-model.md § Entity 1: the discriminator for which final-tournament
  -- item this row scores. NULL when target_kind='match'; NOT NULL when
  -- target_kind='final'. Enforced by CHECK below.
  final_item_kind                 public.final_item_kind NULL,

  -- data-model.md § Entity 1: the participant's predicted home score, for
  -- match-kind rows only. NULL for final-kind rows. Non-negative when set
  -- (enforced by CHECK below).
  predicted_home                  int NULL,

  -- data-model.md § Entity 1: the participant's predicted away score, for
  -- match-kind rows only. NULL for final-kind rows. Non-negative when set.
  predicted_away                  int NULL,

  -- data-model.md § Entity 1: the participant's predicted team or player
  -- for final-kind rows only. teams(id) for champion/runner_up;
  -- players(id) for top_scorer/best_player. NULL for match-kind rows. NO
  -- FK -- the polymorphic shape means the FK would have to dispatch on
  -- final_item_kind; integrity is enforced upstream by final_predictions
  -- FKs (Slice 004) and at score-time by score_finals (T019).
  predicted_team_or_player_id     uuid NULL,

  -- data-model.md § Entity 1: the official home score from
  -- match_results.home_score_for_scoring (R-006 / OD-002 -- regular time +
  -- extra time, excluding penalty shootouts per the configured knockout
  -- score basis). Populated for match-kind rows; NULL for final-kind rows.
  -- Non-negative when set.
  official_home                   int NULL,

  -- data-model.md § Entity 1: the official away score from
  -- match_results.away_score_for_scoring. Same terminology bridge as
  -- official_home (see data-model.md § Entity 1 column note).
  official_away                   int NULL,

  -- data-model.md § Entity 1: the official team or player for final-kind
  -- rows, populated from tournament_award.*. NULL for match-kind rows. NULL
  -- also allowed for final-kind rows when reason_code='final_pending' (the
  -- award has not yet confirmed). Same polymorphic / no-FK shape as
  -- predicted_team_or_player_id.
  official_team_or_player_id      uuid NULL,

  -- data-model.md § Entity 1: the points awarded. Per data-model § Entity
  -- 1: one of 0, 5, 10 (match) or 0, 20 (final). Validated at write time
  -- by score_match / score_finals against tournament_config (FR-001 /
  -- FR-002 / FR-015) -- this CHECK only enforces the lower bound to leave
  -- room for future tournament_config values (e.g., bonus tiers).
  points                          int NOT NULL,

  -- data-model.md § Entity 1: the reason this row received its points
  -- (see enum comments above).
  reason_code                     public.score_reason_code NOT NULL,

  -- data-model.md § Entity 1: bumped per scoring run. Readers filter
  -- WHERE calculation_version = tournament_config.current_calculation_version
  -- to see exactly one consistent snapshot. R-003 (research.md):
  -- flip-the-pointer pattern guarantees readers never see partial state.
  calculation_version             int NOT NULL,

  -- data-model.md § Entity 1: time this row was inserted. Append-only --
  -- no UPDATE path exists (the table has no UPDATE policy under T007 RLS,
  -- and no SQL function issues UPDATE against this table -- replacement is
  -- by INSERT of a higher calculation_version).
  calculated_at                   timestamptz NOT NULL DEFAULT now(),

  -- data-model.md § Entity 1: the score_calculation_runs row that
  -- produced this score_record. NOT NULL because every row MUST trace back
  -- to a run (Principle V auditability). FK to score_calculation_runs(id)
  -- is ATTACHED BY MIGRATION 0050 (T004) via ALTER TABLE -- this slot
  -- (0049) cannot reference a table that does not yet exist. Migration
  -- ordering: 0049 first (column declared, no FK), then 0050 (creates
  -- score_calculation_runs AND attaches the FK to score_records.run_id).
  run_id                          uuid NOT NULL,

  -- data-model.md § Entity 1: the write path that produced this row (see
  -- score_source enum comments).
  source                          public.score_source NOT NULL,

  -- data-model.md § Entity 1 (implementation detail): direct FK to
  -- matches(id) for match-kind rows. Redundant with target_id when
  -- target_kind='match' (they hold the same UUID), but the explicit FK
  -- column gives Postgres the integrity guarantee and the query planner
  -- the index hint. NULL for final-kind rows; NOT NULL for match-kind rows
  -- (enforced by CHECK below).
  match_id                        uuid NULL
                                    REFERENCES public.matches (id) ON DELETE RESTRICT,

  -- ---- CHECK constraints (data-model.md § Entity 1 validation rules) ----

  -- target_kind='match' rows MUST populate match_id, predicted_home,
  -- predicted_away (and may populate official_home / official_away when
  -- reason_code != 'none'). target_kind='final' rows MUST populate
  -- final_item_kind (and may populate predicted_team_or_player_id /
  -- official_team_or_player_id per the per-reason rules below). This is
  -- the structural shape guard.
  CONSTRAINT score_records_target_kind_shape
    CHECK (
      (target_kind = 'match'
         AND match_id IS NOT NULL
         AND match_id = target_id
         AND final_item_kind IS NULL
         AND predicted_team_or_player_id IS NULL
         AND official_team_or_player_id IS NULL)
      OR
      (target_kind = 'final'
         AND match_id IS NULL
         AND final_item_kind IS NOT NULL
         AND predicted_home IS NULL
         AND predicted_away IS NULL
         AND official_home IS NULL
         AND official_away IS NULL)
    ),

  -- data-model.md § Entity 1: predicted scores are non-negative integers
  -- when populated. NULL is allowed (final-kind rows or match-kind rows
  -- with reason_code='none').
  CONSTRAINT score_records_predicted_scores_nonneg
    CHECK (
      (predicted_home IS NULL OR predicted_home >= 0)
      AND
      (predicted_away IS NULL OR predicted_away >= 0)
    ),

  -- data-model.md § Entity 1: official scores are non-negative integers
  -- when populated. NULL is allowed (final-kind rows or match-kind rows
  -- before the match has finished -- though score_records SHOULD only
  -- exist for finished matches in practice).
  CONSTRAINT score_records_official_scores_nonneg
    CHECK (
      (official_home IS NULL OR official_home >= 0)
      AND
      (official_away IS NULL OR official_away >= 0)
    ),

  -- data-model.md § Entity 1: points are non-negative. Upper bound left
  -- unenforced here -- tournament_config drives the exact values (FR-015
  -- / Principle VIII) and a CHECK against tournament_config would be a
  -- cross-table CHECK, which Postgres does not support cleanly.
  -- score_match / score_finals (T013 / T019) validate against
  -- tournament_config at write time.
  CONSTRAINT score_records_points_nonneg
    CHECK (points >= 0),

  -- data-model.md § Entity 1: calculation_version is non-negative.
  -- tournament_config.current_calculation_version starts at 0 (R-003)
  -- and bumps monotonically.
  CONSTRAINT score_records_calculation_version_nonneg
    CHECK (calculation_version >= 0),

  -- data-model.md § Entity 1: when a match-kind row has reason_code != 'none',
  -- the official scores MUST be populated (the row exists because the match
  -- has finished and a result was recorded; reason_code captures whether
  -- the prediction was exact / outcome / incorrect / none -- the first three
  -- require known official scores to have been computed).
  CONSTRAINT score_records_match_official_required
    CHECK (
      target_kind <> 'match'
      OR reason_code = 'none'
      OR (official_home IS NOT NULL AND official_away IS NOT NULL)
    ),

  -- data-model.md § Entity 1: when a final-kind row has reason_code IN
  -- ('final_correct','final_incorrect'), the official team/player MUST be
  -- populated (the award confirmed). 'final_pending' leaves the official
  -- column NULL by design (R-008 best player delay).
  CONSTRAINT score_records_final_official_required
    CHECK (
      target_kind <> 'final'
      OR reason_code NOT IN ('final_correct', 'final_incorrect')
      OR official_team_or_player_id IS NOT NULL
    ),

  -- data-model.md § Entity 1: when a final-kind row has reason_code != 'none',
  -- the participant's prediction (predicted_team_or_player_id) MUST be
  -- populated. 'none' captures the no-valid-final-prediction case.
  CONSTRAINT score_records_final_predicted_required
    CHECK (
      target_kind <> 'final'
      OR reason_code = 'none'
      OR predicted_team_or_player_id IS NOT NULL
    )
);

-- ---------------------------------------------------------------------------
-- UNIQUE constraint -- the append-only-by-version invariant
-- ---------------------------------------------------------------------------
-- data-model.md § Entity 1 § Unique constraint: exactly one row per
-- (participant, target, calculation_version). This is the storage-layer
-- guarantee that score_match / score_finals re-runs (Principle VII
-- idempotency, SC-007) do not double-insert within the same calculation
-- version. Replacing a row means inserting under a HIGHER calculation
-- version -- the old row stays for audit (Principle V).
ALTER TABLE public.score_records
  ADD CONSTRAINT score_records_uk
    UNIQUE (participant_id, target_kind, target_id, calculation_version);

-- ---------------------------------------------------------------------------
-- Indexes (data-model.md § Indexes and access patterns)
-- ---------------------------------------------------------------------------

-- Leaderboard scans: SELECT ... FROM score_records WHERE calculation_version = ?
-- GROUP BY participant_id. Covers leaderboard_v (T029 / slot 0054)
-- recomputation in one B-tree scan; supports SC-003 (<1s leaderboard read
-- for 500 participants).
CREATE INDEX score_records_calculation_version_participant_idx
  ON public.score_records (calculation_version, participant_id);

-- Personal breakdown: SELECT ... FROM score_records WHERE participant_id = ?
-- AND calculation_version = ?. Covers personal_breakdown_v (T035 / slot
-- 0054b); supports SC-004 (<3s breakdown for a full tournament).
CREATE INDEX score_records_participant_calculation_version_target_kind_idx
  ON public.score_records (participant_id, calculation_version, target_kind);

-- Peer-pick / admin investigation: SELECT ... FROM score_records WHERE
-- target_kind = ? AND target_id = ? (optionally AND calculation_version = ?).
-- Used by Slice 006 admin forensics and by peer-pick views when surfacing
-- "what did other participants predict for match X".
CREATE INDEX score_records_target_kind_target_id_calculation_version_idx
  ON public.score_records (target_kind, target_id, calculation_version);

COMMIT;
