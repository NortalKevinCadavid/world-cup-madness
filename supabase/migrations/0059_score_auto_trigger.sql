-- Slice 005 / T042 / FR-007 / research.md § R-011 / contracts/scoring-trigger.edge-fn.md § Invocation.
-- Migration slot 0059 (after T037's 0058 score_all SP).
--
-- DB-side auto-trigger: invokes the public/score-trigger Edge Function via
-- pg_net.http_post(...) whenever:
--   (a) a row is INSERTed or UPDATEd in public.match_results AND the parent
--       match.status = 'finished' AND the for-scoring columns are populated
--       (research.md § R-011 path 1)
--   (b) a row in public.tournament_award has its champion_status / runner_up_status /
--       top_scorer_status / best_player_status mutated (research.md § R-011 path 2)
--
-- Both triggers go through the SECURITY DEFINER helper public.invoke_score_trigger
-- which:
--   * reads two session GUCs (app.score_trigger_url, app.score_trigger_secret)
--     for the URL and the X-Internal-Auth header value — mirroring the
--     pg_cron sync wrapper established in slot 0027 (D-027 pattern).
--   * builds the JSON body per contracts/scoring-trigger.edge-fn.md § Request
--     (`scope`, `target_id`, `reason='auto'`, `run_id`).
--   * calls net.http_post(...) and returns the pg_net request id.
--
-- The Edge Function (T015 / T020 / T037) already accepts the X-Internal-Auth
-- header path: when the header value matches the SCORE_TRIGGER_INTERNAL_AUTH_SECRET
-- env var the call is admitted without a JWT (D-025 option B). T042 wires
-- this DB-side without modifying the Edge Function — the Edge Function's
-- existing internal-auth branch is the single entry point for both the
-- DB auto-path and the local test harness.
--
-- The per-scope SPs (score_match @ slot 0052, score_finals @ slot 0053) hard-code
-- the score_calculation_runs.trigger column to 'match_finish' and 'award_confirmed'
-- respectively. The Edge Function does NOT pass a trigger value through; the SPs
-- assign it. This means an auto-invoked POST whose body says `reason='auto'`
-- still lands in score_calculation_runs with the correct trigger enum value,
-- WITHOUT any Edge Function modification. (D-T042-A: no Edge Fn change needed.)
--
-- Idempotency: each trigger checks score_calculation_runs for an in-flight
-- 'running' row under the same scope/target_id before invoking. This is a
-- defence-in-depth check on top of the Edge Function's per-tournament advisory
-- lock (T015) and the score_match / score_finals run_id idempotency gate
-- (research.md § R-002). The in-flight check prevents a tight INSERT->UPDATE
-- pair on the same match_results row from firing two redundant Edge Function
-- calls within milliseconds; the lock + run_id gate would still serialize and
-- coalesce them, but this check avoids the wasted HTTP round-trip.
--
-- Required Postgres GUCs (set in supabase/config.toml or via ALTER DATABASE):
--   app.score_trigger_url    : full URL to /functions/v1/score-trigger
--                              (e.g. http://localhost:54321/functions/v1/score-trigger
--                              for local dev; the deployed URL in managed envs).
--   app.score_trigger_secret : matches SCORE_TRIGGER_INTERNAL_AUTH_SECRET env var.
--
-- Defensive behavior when GUCs are unset:
--   invoke_score_trigger() emits a RAISE NOTICE and RETURNs NULL without
--   making an HTTP call. This keeps `supabase db reset` working in CI / local
--   envs that have not yet provisioned the GUCs — the trigger fires, observes
--   the missing config, and silently no-ops. Operators MUST set both GUCs
--   before relying on the auto-recalc path in production.
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS changes (T007 owns the score_* RLS surface).
--   * NO modifications to the score_match / score_finals SPs (slots 0052 /
--     0053 are the SoT for trigger enum assignment).
--   * NO seed inserts. The GUCs are environment-level config, not table data.

BEGIN;

-- ---------------------------------------------------------------------------
-- pg_net guard. The extension is installed at slot 0018 (slice 002 / T002)
-- into the `extensions` schema; this CREATE EXTENSION IF NOT EXISTS is a
-- belt-and-braces re-declaration so this migration is self-contained for
-- forensic replay. SCHEMA-targeting matches slot 0018.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- public.invoke_score_trigger(p_scope text, p_target_id uuid) RETURNS bigint
-- ---------------------------------------------------------------------------
-- Centralized helper that BOTH triggers call. SECURITY DEFINER so the trigger
-- fan-out can issue HTTP calls regardless of the writer's role. Returns the
-- pg_net request id (NULL when the GUCs are unset / the call is skipped).
--
-- search_path includes `net` (where pg_net.http_post lives once the extension
-- is installed into `extensions`; pg_net exposes its functions in the `net`
-- schema). The slot 0027 wrapper (public.trigger_sync_catalog) uses the same
-- net.http_post(...) call shape, so this is a verified-by-prior-art pattern.
CREATE OR REPLACE FUNCTION public.invoke_score_trigger(
  p_scope     text,
  p_target_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp, net, extensions
AS $$
DECLARE
  v_url        text;
  v_secret     text;
  v_request_id bigint;
BEGIN
  v_url    := current_setting('app.score_trigger_url',    true);
  v_secret := current_setting('app.score_trigger_secret', true);

  -- Defensive: if either GUC is unset, no-op so `supabase db reset` and CI
  -- migrations without the env settings still succeed. Operators must set
  -- both GUCs before the auto-recalc path is operational.
  IF v_url IS NULL OR v_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE NOTICE
      'invoke_score_trigger: app.score_trigger_url / app.score_trigger_secret unset; '
      'skipping HTTP call (scope=%, target=%)',
      p_scope, p_target_id;
    RETURN NULL;
  END IF;

  -- pg_net is async — the request is enqueued and the function returns the
  -- request id immediately. Failures (5xx, network) surface in
  -- net._http_response asynchronously and do NOT roll back the triggering
  -- transaction. This is the correct posture: the Edge Function and its SP
  -- are independent of the match_results / tournament_award write.
  SELECT net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'X-Internal-Auth',  v_secret
    ),
    body    := jsonb_build_object(
      'scope',     p_scope,
      'target_id', p_target_id,
      'reason',    'auto',
      'run_id',    gen_random_uuid()
    )
  )
  INTO v_request_id;

  RETURN v_request_id;
END;
$$;

-- The helper is invoked only by the trigger functions below (also SECURITY
-- DEFINER); no participant-callable surface needs EXECUTE.
REVOKE EXECUTE ON FUNCTION public.invoke_score_trigger(text, uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.invoke_score_trigger(text, uuid) IS
  'Slice 005 / T042. SECURITY DEFINER. Invokes the score-trigger Edge Function '
  'via pg_net.http_post using the app.score_trigger_url + app.score_trigger_secret '
  'GUCs. Called by match_finished_trigger and award_confirmed_trigger. '
  'Returns the pg_net request id, or NULL when the GUCs are unset.';

-- ---------------------------------------------------------------------------
-- Trigger 1: AFTER INSERT OR UPDATE on public.match_results
-- ---------------------------------------------------------------------------
-- Fires the auto-recalc path for one match when:
--   (a) the for-scoring columns are populated (the SP rejects unpopulated rows)
--   (b) the parent match.status = 'finished'
--   (c) on UPDATE, at least one for-scoring column actually changed (avoid
--       re-firing for non-result column mutations like recorded_by housekeeping)
--
-- Idempotency: if a score_calculation_runs row with scope='match',
-- target_id=NEW.match_id, status='running' already exists, skip the HTTP call.
-- The Edge Function's advisory lock + run_id gate would coalesce concurrent
-- calls anyway; this check avoids the wasted HTTP round-trip.
CREATE OR REPLACE FUNCTION public.match_finished_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_match_status public.match_status;
BEGIN
  -- Guard A: for-scoring columns must be populated (the SP rejects NULLs
  -- with a P0001 anyway; we filter here to avoid the wasted Edge Fn call).
  IF NEW.home_score_for_scoring IS NULL OR NEW.away_score_for_scoring IS NULL THEN
    RETURN NEW;
  END IF;

  -- Guard B: only fire when a for-scoring value actually changed on UPDATE.
  -- INSERT always passes this check (TG_OP = 'INSERT' has NULL OLD).
  IF TG_OP = 'UPDATE'
     AND OLD.home_score_for_scoring IS NOT DISTINCT FROM NEW.home_score_for_scoring
     AND OLD.away_score_for_scoring IS NOT DISTINCT FROM NEW.away_score_for_scoring
  THEN
    RETURN NEW;
  END IF;

  -- Guard C: the parent match must be 'finished'. The SP would reject a non-
  -- finished match with P0001 and a 'failed' run row; we filter upstream so
  -- the failure surface (and the wasted HTTP call) does not happen at all.
  SELECT m.status INTO v_match_status
    FROM public.matches m
   WHERE m.id = NEW.match_id;

  IF v_match_status IS NULL OR v_match_status <> 'finished' THEN
    RETURN NEW;
  END IF;

  -- Idempotency: skip if an in-flight 'running' run already exists for this
  -- match. The Edge Function would still serialize via the advisory lock,
  -- but this check avoids the round-trip.
  IF EXISTS (
    SELECT 1
      FROM public.score_calculation_runs
     WHERE scope     = 'match'
       AND target_id = NEW.match_id
       AND status    = 'running'
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.invoke_score_trigger('match', NEW.match_id);

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.match_finished_trigger_fn() FROM PUBLIC;

COMMENT ON FUNCTION public.match_finished_trigger_fn() IS
  'Slice 005 / T042 / FR-007. AFTER INSERT/UPDATE trigger on match_results. '
  'Invokes invoke_score_trigger(scope=match, target=match_id) when the for-scoring '
  'columns change AND the parent match is finished. Idempotent against in-flight runs.';

DROP TRIGGER IF EXISTS match_finished_trigger ON public.match_results;
CREATE TRIGGER match_finished_trigger
  AFTER INSERT OR UPDATE ON public.match_results
  FOR EACH ROW
  EXECUTE FUNCTION public.match_finished_trigger_fn();

-- ---------------------------------------------------------------------------
-- Trigger 2: AFTER UPDATE on public.tournament_award
-- ---------------------------------------------------------------------------
-- Fires the auto-recalc path for the four final items when any of the four
-- (id, status) pairs change. score_finals reads only *_status='confirmed'
-- rows, so a transition from 'pending' to 'confirmed' is the dominant case.
--
-- AFTER UPDATE only — an INSERT carries no OLD row, and the typical flow is
-- INSERT-pending followed by UPDATE-confirmed; a freshly-inserted-as-confirmed
-- row is unusual but not handled here (the slice-005 fixture covers the path
-- explicitly). If a future slice needs INSERT semantics, add a parallel trigger.
CREATE OR REPLACE FUNCTION public.award_confirmed_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Guard: at least one of the four (id, status) pairs must have changed.
  -- This excludes set_by-only updates (admin attribution rotation) per the
  -- tournament_award_set_at_trigger semantic (slot 0051).
  IF NOT (
       OLD.champion_team_id      IS DISTINCT FROM NEW.champion_team_id
    OR OLD.champion_status        IS DISTINCT FROM NEW.champion_status
    OR OLD.runner_up_team_id     IS DISTINCT FROM NEW.runner_up_team_id
    OR OLD.runner_up_status      IS DISTINCT FROM NEW.runner_up_status
    OR OLD.top_scorer_player_id  IS DISTINCT FROM NEW.top_scorer_player_id
    OR OLD.top_scorer_status     IS DISTINCT FROM NEW.top_scorer_status
    OR OLD.best_player_player_id IS DISTINCT FROM NEW.best_player_player_id
    OR OLD.best_player_status    IS DISTINCT FROM NEW.best_player_status
  ) THEN
    RETURN NEW;
  END IF;

  -- Idempotency: skip if an in-flight 'running' finals/all run already exists.
  -- We check scope IN ('finals','all') because a slice-006 admin-triggered
  -- `scope='all'` re-score already covers the finals; firing another auto-
  -- recalc on top would be redundant (and would race against the in-flight
  -- run's advisory lock).
  IF EXISTS (
    SELECT 1
      FROM public.score_calculation_runs
     WHERE scope  IN ('finals', 'all')
       AND status = 'running'
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.invoke_score_trigger('finals', NULL);

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.award_confirmed_trigger_fn() FROM PUBLIC;

COMMENT ON FUNCTION public.award_confirmed_trigger_fn() IS
  'Slice 005 / T042 / FR-007. AFTER UPDATE trigger on tournament_award. '
  'Invokes invoke_score_trigger(scope=finals) when any of the four (id, status) '
  'pairs change. Idempotent against in-flight finals/all runs.';

DROP TRIGGER IF EXISTS award_confirmed_trigger ON public.tournament_award;
CREATE TRIGGER award_confirmed_trigger
  AFTER UPDATE ON public.tournament_award
  FOR EACH ROW
  EXECUTE FUNCTION public.award_confirmed_trigger_fn();

COMMIT;
