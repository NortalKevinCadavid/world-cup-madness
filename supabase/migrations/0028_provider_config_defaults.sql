-- Slice 002 / T010 / Clarifications 2026-05-15 Q1/Q2/Q3 + research.md § R-013. Default values; admin overrides via Slice 008's admin_config_upsert RPC. ON CONFLICT DO NOTHING preserves any prior writes.
--
-- Seeds the `public.tournament_config` keys that Slice 002 reads at runtime.
-- The table shape is owned by slice 001 (0002_tournament_config_stub.sql):
-- a minimal (key text PK, value jsonb, updated_at timestamptz) triple.
-- Slice 008 will ALTER this table to add value_type / updated_by / version_id
-- columns; every INSERT below is forward-compatible because it lists only
-- those three columns explicitly.
--
-- Values are jsonb. The literal JSON `null` is written as `'null'::jsonb`
-- (NOT the SQL keyword NULL, which the NOT NULL constraint on `value`
-- would reject, and NOT the string `"null"`). This matters most for
-- `notifications.outage_webhook_url` whose null default is the
-- audit-log-only safe fallback per Clarifications 2026-05-15 Q3.
--
-- Slice 001's `eligibility.approved_domains` row is intentionally NOT
-- touched here — it is already seeded in 0002_tournament_config_stub.sql.
--
-- Every INSERT uses `ON CONFLICT (key) DO NOTHING` so re-running this
-- migration (or running it after an admin override) preserves the
-- administrator's value.

BEGIN;

-- ============================================================================
-- Cadence (Clarifications 2026-05-15 Q1 — three-tier sync schedule)
-- ============================================================================
-- Pre-tournament (before any match enters its live window): once per day.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.cadence.pre_tournament_seconds', to_jsonb(86400), now())
ON CONFLICT (key) DO NOTHING;

-- Tournament-day non-live: once per hour.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.cadence.tournament_day_seconds', to_jsonb(3600), now())
ON CONFLICT (key) DO NOTHING;

-- Live window (any match within pre-/post-kickoff envelope): every 5 minutes.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.cadence.live_window_seconds', to_jsonb(300), now())
ON CONFLICT (key) DO NOTHING;

-- Live window opens 90 minutes before each match kickoff.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.cadence.live_window_pre_kickoff_minutes', to_jsonb(90), now())
ON CONFLICT (key) DO NOTHING;

-- Live window closes 240 minutes (4 hours) after each match kickoff.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.cadence.live_window_post_kickoff_minutes', to_jsonb(240), now())
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Payload sanity (Clarifications 2026-05-15 Q2 — structural anomalies)
-- ============================================================================
-- Reject as undersized if payload count < 50% of the last known catalog count
-- for the same scope. Stored as the literal JSON number 0.50.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.payload.min_count_ratio', to_jsonb(0.50::numeric), now())
ON CONFLICT (key) DO NOTHING;

-- Empty payload MUST NOT replace populated data — abort the whole sync.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.payload.reject_on_empty_replacement', to_jsonb(true), now())
ON CONFLICT (key) DO NOTHING;

-- In-payload duplicate external IDs MUST abort the whole sync.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.payload.reject_on_duplicate_external_ids', to_jsonb(true), now())
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Outage alerts (Clarifications 2026-05-15 Q3 — webhook + dedup)
-- ============================================================================
-- Webhook URL: literal JSON null by default. Audit-log-only path applies
-- until Slice 008's admin UI sets a real URL. MUST NOT be the string "null".
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('notifications.outage_webhook_url', 'null'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Sustained-outage dedup threshold (R-008): minutes without success before
-- one outage alert is emitted. 15 minutes per the task spec.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('notifications.outage_threshold_minutes', to_jsonb(15), now())
ON CONFLICT (key) DO NOTHING;

-- Recovery alert: when provider recovers after a sustained outage, emit a
-- symmetric `provider.recovered` event (and webhook if URL configured).
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('notifications.outage_recovery_alert_enabled', to_jsonb(true), now())
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Provider selection
-- ============================================================================
-- Default to the stub provider for local development; Slice 008's admin UI
-- flips this to "football-data" (or another contract-compliant adapter)
-- after the corresponding API key is provisioned.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('providers.active', to_jsonb('stub'::text), now())
ON CONFLICT (key) DO NOTHING;

-- Per-active-provider config slot. Slice 008 populates this with whatever
-- adapter-specific (non-secret) settings the active provider needs.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('providers.<active>.config', '{}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Per-row conflict policies (Clarifications 2026-05-15 Q2 — per-row anomalies)
-- ============================================================================
-- Allowed values: "quarantine" (default), "abort", "auto_accept".
-- Slice 002 implements only "quarantine"; Slice 006's admin UI may extend
-- the runtime to honour the others.

-- Team-assignment change for an existing match -> quarantine the row.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.conflicts.team_assignment_change', to_jsonb('quarantine'::text), now())
ON CONFLICT (key) DO NOTHING;

-- Status backward transition (e.g., finished -> scheduled) -> quarantine.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.conflicts.status_backward_transition', to_jsonb('quarantine'::text), now())
ON CONFLICT (key) DO NOTHING;

-- Score reported for a match whose status != 'finished' -> quarantine.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.conflicts.score_before_finished', to_jsonb('quarantine'::text), now())
ON CONFLICT (key) DO NOTHING;

-- Kickoff time change after the affected match has already locked -> quarantine.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.conflicts.kickoff_change_after_lock', to_jsonb('quarantine'::text), now())
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Misc sync runner controls
-- ============================================================================
-- pg_advisory_xact_lock namespace integer for the "one sync at a time per
-- provider" guarantee (FR-010). Arbitrary but stable across runs.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.advisory_lock_namespace', to_jsonb(42), now())
ON CONFLICT (key) DO NOTHING;

-- Maximum retries within a single scheduled run before yielding to the next
-- cadence tick (R-007).
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.max_retries_per_run', to_jsonb(2), now())
ON CONFLICT (key) DO NOTHING;

-- Initial retry backoff in milliseconds; exponential backoff multiplier is
-- implementation-defined per R-007.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('provider_sync.retry_backoff_ms', to_jsonb(1000), now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
