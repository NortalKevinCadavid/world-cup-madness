-- Slice 002 / T043 / Clarifications 2026-05-15 Q1.
-- pg_cron schedule for sync coordinator invocation. The cron job itself runs every
-- minute; the wrapper function reads tournament_config.provider_sync.cadence.* and
-- decides whether THIS minute should fire based on:
--   * live_window predicate: any matches.kickoff_utc is in [now - pre_offset, now + post_offset]
--   * tier cadence: pre_tournament (default 86400s), tournament_day (3600s), live_window (300s)
--   * last-fired timestamp: provider_sync_runs.started_at for the active provider's most recent run
--
-- Cron-driven calls use trigger='scheduled' (per migration 0022 CHECK and D-010).
-- The wrapper uses pg_net.http_post to invoke ${app.sync_trigger_url} (a Postgres GUC)
-- with X-Internal-Auth: ${app.sync_trigger_secret} (another GUC).
-- Operators must set these GUCs once at deploy time:
--   ALTER DATABASE postgres SET app.sync_trigger_url = 'https://<project>.supabase.co/functions/v1/sync-catalog';
--   ALTER DATABASE postgres SET app.sync_trigger_secret = '<the SYNC_TRIGGER_SECRET value>';

BEGIN;

-- ---------------------------------------------------------------------------
-- public.trigger_sync_catalog(p_provider text)
-- ---------------------------------------------------------------------------
-- Tier decision + http_post invocation. Idempotent at the minute granularity:
-- if a sync is already in progress OR the tier's cadence interval has not yet
-- elapsed since the last started_at, returns without firing.
CREATE OR REPLACE FUNCTION public.trigger_sync_catalog(p_provider text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp, extensions
AS $$
DECLARE
  v_cadence_pre_tournament_s int;
  v_cadence_tournament_day_s int;
  v_cadence_live_s int;
  v_lw_pre_minutes int;
  v_lw_post_minutes int;
  v_tier text;
  v_required_interval_s int;
  v_last_started timestamptz;
  v_seconds_since_last numeric;
  v_url text;
  v_secret text;
  v_run_id text;
  v_request_id bigint;
BEGIN
  -- 1. Read cadence config
  SELECT (value)::int INTO v_cadence_pre_tournament_s
    FROM public.tournament_config WHERE key = 'provider_sync.cadence.pre_tournament_seconds';
  SELECT (value)::int INTO v_cadence_tournament_day_s
    FROM public.tournament_config WHERE key = 'provider_sync.cadence.tournament_day_seconds';
  SELECT (value)::int INTO v_cadence_live_s
    FROM public.tournament_config WHERE key = 'provider_sync.cadence.live_window_seconds';
  SELECT (value)::int INTO v_lw_pre_minutes
    FROM public.tournament_config WHERE key = 'provider_sync.cadence.live_window_pre_kickoff_minutes';
  SELECT (value)::int INTO v_lw_post_minutes
    FROM public.tournament_config WHERE key = 'provider_sync.cadence.live_window_post_kickoff_minutes';

  -- Defaults if config missing
  v_cadence_pre_tournament_s := COALESCE(v_cadence_pre_tournament_s, 86400);
  v_cadence_tournament_day_s := COALESCE(v_cadence_tournament_day_s, 3600);
  v_cadence_live_s := COALESCE(v_cadence_live_s, 300);
  v_lw_pre_minutes := COALESCE(v_lw_pre_minutes, 90);
  v_lw_post_minutes := COALESCE(v_lw_post_minutes, 240);

  -- 2. Determine tier
  -- Live window: any match satisfies now() BETWEEN kickoff_utc - pre AND kickoff_utc + post
  IF EXISTS (
    SELECT 1 FROM public.matches
    WHERE now() BETWEEN kickoff_utc - (v_lw_pre_minutes || ' minutes')::interval
                    AND kickoff_utc + (v_lw_post_minutes || ' minutes')::interval
  ) THEN
    v_tier := 'live_window';
    v_required_interval_s := v_cadence_live_s;
  ELSIF EXISTS (
    SELECT 1 FROM public.matches
    WHERE date_trunc('day', kickoff_utc) = date_trunc('day', now())
  ) THEN
    v_tier := 'tournament_day';
    v_required_interval_s := v_cadence_tournament_day_s;
  ELSE
    v_tier := 'pre_tournament';
    v_required_interval_s := v_cadence_pre_tournament_s;
  END IF;

  -- 3. Check last-fired
  SELECT MAX(started_at) INTO v_last_started
    FROM public.provider_sync_runs
   WHERE provider = p_provider;

  IF v_last_started IS NOT NULL THEN
    v_seconds_since_last := EXTRACT(EPOCH FROM (now() - v_last_started));
    IF v_seconds_since_last < v_required_interval_s THEN
      RETURN jsonb_build_object(
        'fired', false,
        'tier', v_tier,
        'reason', 'cadence_not_elapsed',
        'seconds_since_last', v_seconds_since_last,
        'required_interval_s', v_required_interval_s
      );
    END IF;
  END IF;

  -- 4. Check for in-flight sync (no concurrent run)
  IF EXISTS (
    SELECT 1 FROM public.provider_sync_runs
    WHERE provider = p_provider AND outcome = 'in_progress'
  ) THEN
    RETURN jsonb_build_object('fired', false, 'tier', v_tier, 'reason', 'in_flight');
  END IF;

  -- 5. Read URL + secret from session GUCs (operator sets via ALTER DATABASE)
  v_url := current_setting('app.sync_trigger_url', true);
  v_secret := current_setting('app.sync_trigger_secret', true);

  IF v_url IS NULL OR v_url = '' THEN
    RETURN jsonb_build_object('fired', false, 'tier', v_tier, 'reason', 'sync_trigger_url_not_set');
  END IF;

  -- 6. Fire via pg_net.http_post
  v_run_id := gen_random_uuid()::text;
  v_request_id := net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'X-Internal-Auth', COALESCE(v_secret, ''),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'provider', p_provider,
      'trigger', 'scheduled',
      'run_id', v_run_id,
      'reason', concat('cron:', v_tier)
    )
  );

  RETURN jsonb_build_object(
    'fired', true,
    'tier', v_tier,
    'run_id', v_run_id,
    'http_request_id', v_request_id,
    'required_interval_s', v_required_interval_s
  );
END;
$$;

-- Restrict + grant
REVOKE EXECUTE ON FUNCTION public.trigger_sync_catalog(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.trigger_sync_catalog(text) TO service_role';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- pg_cron job -- runs every minute; wrapper decides whether to actually fire
-- ---------------------------------------------------------------------------
-- Idempotent: unschedule any prior job with this name before (re-)scheduling.
-- The cron job-name is stable so re-runs of supabase db reset don't duplicate.
-- We read providers.active at fire time so admin-flipped provider takes effect
-- on the next minute without rescheduling.
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('sync-catalog-trigger');
  EXCEPTION WHEN OTHERS THEN
    -- First-run case: no job exists yet. Swallow.
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'sync-catalog-trigger',
  '* * * * *',
  $cron$
  SELECT public.trigger_sync_catalog(
    COALESCE(
      (SELECT trim('"' from (value)::text) FROM public.tournament_config WHERE key = 'providers.active'),
      'stub'
    )
  );
  $cron$
);

COMMIT;
