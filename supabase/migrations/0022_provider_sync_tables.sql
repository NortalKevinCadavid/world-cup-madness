-- Slice 002 / T006 / R-008 / data-model.md § provider_sync_runs + provider_sync_state. Bookkeeping for outage dedup + sync run history. NO RLS (T009), NO audit (T008), NO seed (T012).
--
-- Two tables land here:
--   1. public.provider_sync_runs    -- one row per sync invocation (high-volume
--                                      ledger; bigserial PK for index density).
--   2. public.provider_sync_state   -- keyed singleton-per-provider state machine
--                                      backing R-008's exactly-once outage-alert
--                                      dedup (see specs/002-match-catalog/research.md
--                                      § R-008 and spec.md § Clarifications Q3).
--
-- Together these tables let the sync coordinator (R-002) durably record what
-- it attempted, what changed, and whether it already alerted for the current
-- outage. The state machine survives Edge Function cold-starts; the run ledger
-- survives across the tournament's lifetime (Slice 007 hardens retention).
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS / no policies / no GRANT/REVOKE -- T009 owns the Slice 002 RLS surface.
--   * NO audit trigger -- T008 owns the AFTER INSERT/UPDATE audit_log triggers.
--   * NO seed inserts -- T012 owns fixture data; provider_sync_state rows are
--       lazily created by the sync runner on first invocation per provider.
--
-- updated_at maintenance reuses public.set_updated_at() established in
-- migration 0001_participants.sql (single source of truth across slices).

BEGIN;

-- ---------------------------------------------------------------------------
-- public.provider_sync_runs
-- ---------------------------------------------------------------------------
-- High-volume audit ledger: one row per sync invocation. The sync coordinator
-- INSERTs with outcome='in_progress' at the start of a run, then UPDATEs the
-- row to set finished_at + outcome + counts on completion. bigserial PK over
-- uuid is intentional: this table grows monotonically with every cron tick
-- (every 5 minutes during live windows -- thousands of rows per tournament),
-- and bigint indexes are denser + cheaper than uuid indexes at that volume.
CREATE TABLE public.provider_sync_runs (
  -- High-volume monotonic PK -- bigint over uuid for index density.
  id                     bigserial PRIMARY KEY,

  -- Provider short name, e.g. 'football-data', 'stub'. Free-form text rather
  -- than an enum so Slice 008's OD-007 resolution can add providers without a
  -- schema migration (Principle IV vendor neutrality).
  provider               text NOT NULL,

  -- Set on INSERT by the sync runner at the start of the cycle.
  started_at             timestamptz NOT NULL DEFAULT now(),

  -- NULL while outcome='in_progress'; populated when the runner commits the
  -- terminal UPDATE. Asymmetry with outcome is intentional: 'in_progress'
  -- rows have finished_at NULL, every terminal outcome populates it.
  finished_at            timestamptz NULL,

  -- Terminal outcome categories. 'in_progress' is the default at INSERT and
  -- the only non-terminal value. The other six (success / failure / partial /
  -- conflict_quarantined / aborted) describe how the run ended. See the
  -- outcome CHECK below for the enforced enum.
  outcome                text NOT NULL DEFAULT 'in_progress',

  -- Count the provider claimed to return in its payload (pre-validation).
  -- NULL when the runner never got far enough to read a payload (e.g. auth
  -- failure during fetch). Compared against applied_match_count to detect
  -- partial / undersized scenarios (R-004).
  payload_match_count    int NULL,

  -- How many UPSERTs actually committed to public.matches during this run.
  -- NULL until the runner finishes its transactional commit phase.
  applied_match_count    int NULL,

  -- How many rows were diverted into match_pending_review (T007's table) by
  -- the conflict-quarantine path (R-005). 0 on a clean run.
  quarantined_count      int NOT NULL DEFAULT 0,

  -- Error category for triage. NULL on success / in_progress. Free-form text
  -- (e.g. 'network', 'auth', 'rate_limit', 'malformed', 'validation',
  -- 'conflict') rather than an enum so the runner can introduce new classes
  -- without coordinated schema changes.
  error_class            text NULL,

  -- Human-readable error context. Max 4096 chars by convention; the runner
  -- truncates before insert to bound storage on chatty stack traces.
  error_message          text NULL,

  -- What kicked off this run. Enforced enum via CHECK below.
  --   'scheduled'       -- pg_cron tick (the dominant case).
  --   'manual_admin'    -- a Slice 006 admin-initiated recalc.
  --   'manual_internal' -- a developer or internal tooling invocation.
  trigger                text NOT NULL,

  -- Cadence tier (Clarifications Q1). NULL when the runner is operating
  -- outside the tournament window (e.g. pre-launch testing) and no tier
  -- applies. Enforced enum via CHECK below.
  tier                   text NULL,

  -- Correlation handle passed through to structured logs + the outage-alert
  -- webhook payload, so operators can grep a single id across the run row,
  -- the Edge Function log lines, and the downstream alert delivery.
  correlation_id         uuid NOT NULL DEFAULT gen_random_uuid(),

  -- ---- CHECK constraints (data-model.md § Entity 5 validation rules) ----

  -- Enforced outcome enum. 'in_progress' is the default; the other six are
  -- terminal. Stored as text (not a CREATE TYPE enum) so adding new outcome
  -- categories later is an ALTER on the CHECK, not a coordinated enum dance.
  CONSTRAINT provider_sync_runs_outcome_enum
    CHECK (outcome IN (
      'success',
      'failure',
      'partial',
      'conflict_quarantined',
      'aborted',
      'in_progress'
    )),

  -- Enforced trigger enum.
  CONSTRAINT provider_sync_runs_trigger_enum
    CHECK (trigger IN (
      'scheduled',
      'manual_admin',
      'manual_internal'
    )),

  -- Enforced tier enum; NULL permitted because tier is optional context, not
  -- load-bearing for run correctness.
  CONSTRAINT provider_sync_runs_tier_enum
    CHECK (tier IS NULL OR tier IN (
      'pre_tournament',
      'tournament_day',
      'live_window'
    ))
);

-- ---------------------------------------------------------------------------
-- Indexes on public.provider_sync_runs
-- ---------------------------------------------------------------------------
-- R-008 outage-dedup lookback: "for provider X, what were the most recent
-- runs?" -- the sync coordinator reads this on every cycle to compute outage
-- duration. Composite descending so the planner can take the leading rows.
CREATE INDEX provider_sync_runs_provider_started_at_idx
  ON public.provider_sync_runs (provider, started_at DESC);

-- Operator dashboards: "show me the most recent failures / partials /
-- quarantines across all providers." Slice 006's admin UI consumes this.
CREATE INDEX provider_sync_runs_outcome_finished_at_idx
  ON public.provider_sync_runs (outcome, finished_at DESC);

-- Log correlation: grep a correlation_id across runs + logs + alert payloads.
-- B-tree on a uuid is fine because the lookups are equality-only.
CREATE INDEX provider_sync_runs_correlation_id_idx
  ON public.provider_sync_runs (correlation_id);

-- ---------------------------------------------------------------------------
-- public.provider_sync_state
-- ---------------------------------------------------------------------------
-- Keyed singleton-per-provider state. One row per provider value -- the table
-- holds at most a handful of rows for the lifetime of the system. This is the
-- source of truth for "have we already alerted for the current outage?" The
-- sync runner reads + writes it in the same transaction as the matching
-- provider_sync_runs row, so a crash between updating one and the other is
-- impossible (R-008).
CREATE TABLE public.provider_sync_state (
  -- Natural PK: one state row per provider. Same vendor-neutral text shape
  -- as provider_sync_runs.provider, no FK between them by design (the runs
  -- ledger keeps history even if a provider name is retired from state).
  provider                          text PRIMARY KEY,

  -- When the most recent successful sync finished. NULL on a never-succeeded
  -- provider (first deployment). Cleared / advanced by every success.
  last_success_at                   timestamptz NULL,

  -- Counter of consecutive failures since the last success. Reset to 0 by
  -- the next success. Combined with the threshold in tournament_config.
  -- provider_sync.outage_alert_threshold_minutes this drives the R-008 alert
  -- gate.
  consecutive_failures              int NOT NULL DEFAULT 0,

  -- When the current outage started: set on the first failure after a
  -- success, NULL while the last sync was a success. Together with
  -- outage_alert_emitted_at this is the R-008 "exactly once per outage"
  -- ledger.
  first_failure_after_success_at    timestamptz NULL,

  -- When the sustained-outage alert was POSTed to the configured webhook
  -- (Slice 008 wires the transport). NULL while no alert is pending or no
  -- outage is active. Cleared by the next success.
  outage_alert_emitted_at           timestamptz NULL,

  -- Set true when an outage alert was emitted; flipped back to false after
  -- the corresponding recovery alert is POSTed on the next success. Lets the
  -- runner answer "do I owe a recovery notification?" without re-reading
  -- the runs ledger.
  recovery_alert_pending            boolean NOT NULL DEFAULT false,

  -- Trigger-maintained on every UPDATE (see trigger below).
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger
-- ---------------------------------------------------------------------------
-- Reuses public.set_updated_at() established in Slice 001 (migration
-- 0001_participants.sql). Provider_sync_runs uses started_at / finished_at
-- for its temporal columns and does not need updated_at; only the state
-- row needs the trigger.
CREATE TRIGGER provider_sync_state_set_updated_at
  BEFORE UPDATE ON public.provider_sync_state
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Table + column documentation (visible via \d+ and pg_description).
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.provider_sync_runs IS
  'Slice 002 / T006 / data-model.md § provider_sync_runs: one row per sync invocation. '
  'High-volume ledger (bigserial PK for index density). NO RLS here (T009); NO audit '
  'trigger here (T008); the runs row IS the audit record for the sync invocation itself.';

COMMENT ON COLUMN public.provider_sync_runs.id                  IS 'High-volume monotonic PK (bigserial over uuid for index density).';
COMMENT ON COLUMN public.provider_sync_runs.provider            IS 'Provider short name, e.g. ''football-data'', ''stub'' (Principle IV vendor neutrality).';
COMMENT ON COLUMN public.provider_sync_runs.started_at          IS 'Set on INSERT at the start of the sync cycle.';
COMMENT ON COLUMN public.provider_sync_runs.finished_at         IS 'NULL while outcome=''in_progress''; populated on terminal UPDATE.';
COMMENT ON COLUMN public.provider_sync_runs.outcome             IS 'in_progress | success | failure | partial | conflict_quarantined | aborted (CHECK-enforced).';
COMMENT ON COLUMN public.provider_sync_runs.payload_match_count IS 'Count the provider claimed to return; NULL if the runner never read a payload.';
COMMENT ON COLUMN public.provider_sync_runs.applied_match_count IS 'How many UPSERTs actually committed; NULL until terminal UPDATE.';
COMMENT ON COLUMN public.provider_sync_runs.quarantined_count   IS 'How many rows were diverted into match_pending_review (R-005). 0 on clean runs.';
COMMENT ON COLUMN public.provider_sync_runs.error_class         IS 'Error category for triage (e.g. ''network'', ''auth'', ''rate_limit'', ''malformed'', ''validation'', ''conflict''). NULL on success.';
COMMENT ON COLUMN public.provider_sync_runs.error_message       IS 'Human-readable error context, truncated to 4096 chars before insert.';
COMMENT ON COLUMN public.provider_sync_runs.trigger             IS 'scheduled | manual_admin | manual_internal (CHECK-enforced).';
COMMENT ON COLUMN public.provider_sync_runs.tier                IS 'Cadence tier (Clarifications Q1): pre_tournament | tournament_day | live_window. NULL outside tournament context.';
COMMENT ON COLUMN public.provider_sync_runs.correlation_id      IS 'Pass-through correlation handle for structured logs + outage webhook payloads.';

COMMENT ON TABLE public.provider_sync_state IS
  'Slice 002 / T006 / R-008 / data-model.md § provider_sync_state: keyed singleton-per-provider '
  'state machine backing the "exactly once per sustained outage" alert dedup. Read + written by '
  'the sync coordinator in the same transaction as the matching provider_sync_runs row.';

COMMENT ON COLUMN public.provider_sync_state.provider                       IS 'Natural PK: one state row per provider value.';
COMMENT ON COLUMN public.provider_sync_state.last_success_at                IS 'When the most recent successful sync finished; NULL on never-succeeded providers.';
COMMENT ON COLUMN public.provider_sync_state.consecutive_failures           IS 'Counter of consecutive failures since the last success; reset to 0 by the next success.';
COMMENT ON COLUMN public.provider_sync_state.first_failure_after_success_at IS 'When the current outage started; NULL while the last sync was a success.';
COMMENT ON COLUMN public.provider_sync_state.outage_alert_emitted_at        IS 'When the sustained-outage alert was POSTed; NULL while no alert pending.';
COMMENT ON COLUMN public.provider_sync_state.recovery_alert_pending         IS 'true when an outage alert was emitted and the recovery alert is still owed.';
COMMENT ON COLUMN public.provider_sync_state.updated_at                     IS 'Trigger-maintained on every UPDATE via public.set_updated_at().';

COMMIT;
