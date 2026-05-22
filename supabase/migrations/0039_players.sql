-- Slice 004 / T003 / FR-009 / data-model.md § Entity 1 (players). Mirror of slice 002
-- team_provider_external_ids parallel-symmetry pattern. NO RLS (T007 owns), NO audit
-- (T008), NO seed (T011). Migration slot 0039 per D-016 (spec said 0036; slice 003
-- already filled 0030-0038).
--
-- Cross-slice locked: players.id is the FK target for slice 004's
-- final_predictions.target_player_id (player-kind item picks) and slice 005's scoring
-- pipeline (which checks players.removed_at IS NULL before crediting a final
-- prediction). The locked column set on players is (id, full_name, display_name,
-- team_id, country_code, position, removed_at, created_at, updated_at). Adding
-- columns is forward-compatible; renaming or removing them requires coordinated
-- regression updates across slices 005-008 (Constitution Principle XI).
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS, NO RLS policies, NO GRANT/REVOKE beyond default ownership.
--       T007 in this slice owns the full Slice 004 RLS surface for players +
--       player_provider_external_ids + final_predictions.
--   * NO audit trigger. T008 in this slice owns the players_after_remove trigger
--       (per contracts/players-ingest.md) that fans out per-affected-final-prediction
--       audit_log rows when removed_at transitions NULL -> non-NULL.
--   * NO seed inserts. The players table is populated by Slice 002's sync coordinator
--       extension (T031 in Polish) via the previously-reserved
--       MatchDataProviderAdapter.fetchPlayers?() optional method.
--   * The provider_player_id mapping lives in player_provider_external_ids, NOT as
--       a column on players (Principle IV: provider IDs in mapping tables, not on
--       the entity). This parallels Slice 002's team_provider_external_ids.
--
-- updated_at maintenance reuses Slice 001's public.set_updated_at() function
-- established in migration 0001_participants.sql. No new function created here.
--
-- Soft-delete semantics: removed_at is the cross-slice soft-delete signal
-- (Clarifications 2026-05-17 Q1). Slice 005 scoring checks players.removed_at IS
-- NULL when validating final_predictions; a removed player's existing prediction
-- rows survive (audit-preservation) but no longer accrue points.

BEGIN;

-- ---------------------------------------------------------------------------
-- public.players
-- ---------------------------------------------------------------------------
CREATE TABLE public.players (
  -- data-model.md § Entity 1: internal stable identifier. Cross-slice FK target
  -- for final_predictions.target_player_id (top_scorer, best_player item kinds).
  -- gen_random_uuid() via pgcrypto enabled by migration 0001.
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- data-model.md § Entity 1: canonical full name as supplied by the provider,
  -- e.g. "Lionel Andrés Messi Cuccittini". NOT NULL.
  full_name       text NOT NULL,

  -- Optional short form used by the picker UI when the full_name is awkwardly
  -- long, e.g. "Messi". NULL when the provider does not supply a short form.
  display_name    text NULL,

  -- data-model.md § Entity 1: optional FK to teams(id). ON DELETE SET NULL is
  -- soft-delete-aware: if the team row is removed, the player's affiliation
  -- drops to NULL but the player row survives so prior final_predictions
  -- referencing the player remain auditable.
  team_id         uuid NULL
                    REFERENCES public.teams (id) ON DELETE SET NULL,

  -- ISO alpha-2 country code (e.g. 'AR', 'FR'). NULL allowed when the provider
  -- does not supply nationality data. Kept text rather than enum for vendor
  -- neutrality (Principle I).
  country_code    text NULL,

  -- Playing position: GK / DF / MF / FW. NULL allowed when the provider does
  -- not supply position metadata. Soft constraint via CHECK below.
  position        text NULL,

  -- Soft-delete signal (Clarifications 2026-05-17 Q1). When the sync coordinator
  -- observes that the provider no longer returns this player, it sets removed_at
  -- = now(). Slice 005 scoring treats removed_at IS NOT NULL as "no longer on
  -- roster" and stops crediting any final_predictions targeting this player.
  -- T008 in this slice attaches a trigger on the NULL -> non-NULL transition to
  -- emit per-affected-final-prediction audit rows (R-013).
  removed_at      timestamptz NULL,

  -- Row-create timestamp. Set once by the sync coordinator on first observation.
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Trigger-maintained on every UPDATE (see trigger below). Never set by
  -- application code directly.
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- ---- CHECK constraints (data-model.md § Entity 1 validation rules) ----

  -- full_name MUST NOT be empty after trim.
  CONSTRAINT players_full_name_not_blank
    CHECK (length(trim(full_name)) > 0),

  -- position, when supplied, MUST be one of the four FIFA-standard position
  -- buckets. NULL remains allowed for providers that don't supply position data.
  CONSTRAINT players_position_enum
    CHECK (position IS NULL OR position IN ('GK', 'DF', 'MF', 'FW'))
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger (reuses Slice 001's public.set_updated_at())
-- ---------------------------------------------------------------------------
CREATE TRIGGER players_set_updated_at
  BEFORE UPDATE ON public.players
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes on public.players
-- ---------------------------------------------------------------------------

-- "Active roster of team X" queries — picker UI filtering by team plus Slice
-- 005's score_finals consumption. Partial on removed_at IS NULL so the index
-- stays small and only covers the active-roster subset.
CREATE INDEX players_team_idx
  ON public.players (team_id)
  WHERE removed_at IS NULL;

-- Typeahead search support — slice 004's picker UI uses cmdk (per T002) and
-- performs case-insensitive prefix/substring matching on the player's full
-- name. Partial on removed_at IS NULL because the picker never surfaces
-- removed players. lower(full_name) for case-insensitive matching.
CREATE INDEX players_full_name_idx
  ON public.players (lower(full_name))
  WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- public.player_provider_external_ids
-- ---------------------------------------------------------------------------
-- Parallels Slice 002's team_provider_external_ids (migration 0019). Same
-- shape: surrogate UUID PK, FK to players with ON DELETE CASCADE, UNIQUE on
-- (provider_name, provider_player_id) as the sync coordinator's idempotency
-- key per contracts/players-ingest.md.
CREATE TABLE public.player_provider_external_ids (
  -- Surrogate PK; parallels team_provider_external_ids.id.
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: deleting a player row is rare (admin path; never
  -- sync — sync uses removed_at soft-delete), but when it happens the mapping
  -- rows are internal plumbing and have no independent meaning.
  player_id          uuid NOT NULL
                       REFERENCES public.players (id) ON DELETE CASCADE,

  -- Provider identifier, e.g. 'footballdata' or 'stub'. Free-form text rather
  -- than an enum so future providers can be added without a schema migration
  -- (Principle I vendor neutrality, mirrors Slice 002).
  provider_name      text NOT NULL,

  -- The provider's native player identifier (often a numeric string in
  -- football-data's API; kept as text for vendor neutrality per Principle I).
  provider_player_id text NOT NULL,

  -- Set on first INSERT and refreshed on every sync that re-confirms the
  -- mapping. Mirrors team_provider_external_ids.mapped_at.
  mapped_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- UNIQUE constraint — the sync coordinator's idempotency key
-- ---------------------------------------------------------------------------
-- A given (provider, external_id) maps to at most one internal player. The
-- UNIQUE index is what makes the player ingest UPSERT deterministic and
-- replay-safe (contracts/players-ingest.md producer side).
ALTER TABLE public.player_provider_external_ids
  ADD CONSTRAINT player_provider_external_ids_provider_uk
    UNIQUE (provider_name, provider_player_id);

-- ---------------------------------------------------------------------------
-- Non-unique index — reverse lookup (admin debug, conflict-quarantine forensics)
-- ---------------------------------------------------------------------------
CREATE INDEX player_provider_external_ids_player_idx
  ON public.player_provider_external_ids (player_id);

-- ---------------------------------------------------------------------------
-- Table + column documentation (visible via \d+ and pg_description).
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.players IS
  'Slice 004 / FR-009 / data-model.md § Entity 1: player eligible to be picked as '
  'top_scorer or best_player in final_predictions. Locked cross-slice contract — '
  'Slices 005-008 FK to players(id) and read removed_at as the soft-delete signal. '
  'Sync coordinator writes via service role; no direct client writes.';

COMMENT ON COLUMN public.players.id           IS 'data-model.md § Entity 1: internal stable identifier (PK). Cross-slice FK target for final_predictions.target_player_id.';
COMMENT ON COLUMN public.players.full_name    IS 'data-model.md § Entity 1: canonical full name as supplied by the provider; NOT NULL and non-blank.';
COMMENT ON COLUMN public.players.display_name IS 'Optional short form for picker UI display when full_name is awkwardly long; NULL allowed.';
COMMENT ON COLUMN public.players.team_id      IS 'Optional FK to teams(id) ON DELETE SET NULL — soft-delete-aware so the player row survives if the team is removed.';
COMMENT ON COLUMN public.players.country_code IS 'Optional ISO alpha-2 country code (e.g. ''AR'', ''FR''); NULL allowed.';
COMMENT ON COLUMN public.players.position     IS 'Playing position: GK / DF / MF / FW or NULL. Constrained by players_position_enum CHECK.';
COMMENT ON COLUMN public.players.removed_at   IS 'Soft-delete signal (Clarifications 2026-05-17 Q1). Set by sync coordinator when the provider stops returning the player. Slice 005 treats non-NULL as off-roster.';
COMMENT ON COLUMN public.players.created_at   IS 'Row-create timestamp; set once by the sync coordinator on first observation.';
COMMENT ON COLUMN public.players.updated_at   IS 'Trigger-maintained on every UPDATE via public.set_updated_at(); never set by application code.';

COMMENT ON TABLE public.player_provider_external_ids IS
  'Slice 004 / data-model.md § Entity 1 (provider mapping): internal mapping of '
  'player_id to provider-specific identifiers. Parallels Slice 002''s '
  'team_provider_external_ids shape. Internal-only — never exposed to participant '
  'clients. Sync coordinator writes via service role.';

COMMENT ON COLUMN public.player_provider_external_ids.id                 IS 'Surrogate PK; parallels team_provider_external_ids.id.';
COMMENT ON COLUMN public.player_provider_external_ids.player_id          IS 'FK to players(id) ON DELETE CASCADE — mapping rows are internal plumbing without independent meaning.';
COMMENT ON COLUMN public.player_provider_external_ids.provider_name      IS 'Provider identifier (e.g. ''footballdata'', ''stub''). Free-form text for vendor-neutral extensibility (Principle I).';
COMMENT ON COLUMN public.player_provider_external_ids.provider_player_id IS 'Provider''s native player identifier; text for vendor neutrality.';
COMMENT ON COLUMN public.player_provider_external_ids.mapped_at          IS 'Set on first INSERT and refreshed on every confirming sync (staleness detection mirror of Slice 002).';

COMMIT;
