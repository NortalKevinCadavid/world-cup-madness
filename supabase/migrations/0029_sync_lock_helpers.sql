-- Slice 002 / T032 / R-006 — Per-provider advisory-lock helpers for the sync coordinator.
--
-- The `sync-catalog` Edge Function (supabase/functions/sync-catalog/index.ts) needs to
-- acquire a per-provider advisory lock so that two concurrent invocations against the
-- same provider serialize cleanly (FR-010 / R-006). PostgREST does not expose Postgres
-- built-ins by default, so we ship a pair of thin SECURITY INVOKER wrappers callable
-- via `.rpc('try_lock_sync', ...)` and `.rpc('unlock_sync', ...)`.
--
-- Lock identity:
--   pg_try_advisory_lock(hashtext('sync_catalog'), hashtext(p_provider))
--
-- The two-int key form pairs a stable namespace hash ('sync_catalog') with a per-provider
-- hash, isolating Slice 002's locks from any future advisory-lock consumers in other
-- slices. The same hash pair is used by the T024 contract test
-- (supabase/functions/sync-catalog/tests/advisory_lock_returns_409.test.ts) which holds
-- the lock from a side Postgres connection and asserts the coordinator returns 409.
--
-- Session vs transaction scope:
--   These helpers use the session-scoped variants (pg_try_advisory_lock /
--   pg_advisory_unlock, NOT the _xact_ family). The Edge Function's request-scoped
--   service-role client is a transient PostgREST session; calling try_lock_sync then
--   unlock_sync from within the same JS-level service client lands the unlock on the
--   same session via PostgREST's connection-pooling. The coordinator wraps the unlock
--   in `finally` so the lock is released even on an unhandled exception in the
--   adapter or UPSERT path.
--
-- Scope discipline (Constitution Principle X):
--   * NO RLS — these are coordination helpers, not data.
--   * NO audit trigger — the runs ledger (provider_sync_runs) IS the audit record
--       for sync invocations; the lock primitives are infrastructure beneath that.
--   * GRANT EXECUTE TO service_role only — the only role permitted to drive a sync
--       cycle. Wrapped in a pg_roles existence check so the migration applies on
--       bare Postgres images (mirrors slice 001 grant pattern).

BEGIN;

-- ---------------------------------------------------------------------------
-- public.try_lock_sync(p_provider text)
-- ---------------------------------------------------------------------------
-- Returns true if the per-provider advisory lock was acquired by THIS session;
-- false if another session holds it. Never blocks — the coordinator interprets
-- a `false` return as "another sync is in flight for this provider" and
-- returns 409 SYNC_IN_FLIGHT (per contracts/sync-runner.scheduled.md).
CREATE OR REPLACE FUNCTION public.try_lock_sync(p_provider text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT pg_try_advisory_lock(hashtext('sync_catalog'), hashtext(p_provider));
$$;

COMMENT ON FUNCTION public.try_lock_sync(text) IS
  'Slice 002 / T032 / R-006: per-provider advisory-lock acquire. Non-blocking. '
  'Returns true on acquire, false if another session holds the lock. The '
  'sync-catalog Edge Function maps false -> HTTP 409 SYNC_IN_FLIGHT.';

-- ---------------------------------------------------------------------------
-- public.unlock_sync(p_provider text)
-- ---------------------------------------------------------------------------
-- Releases the per-provider advisory lock previously acquired by THIS session.
-- Returns true if a matching lock was released; false if none was held (the
-- coordinator does not treat the boolean as load-bearing — the `finally` block
-- calls this defensively).
CREATE OR REPLACE FUNCTION public.unlock_sync(p_provider text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT pg_advisory_unlock(hashtext('sync_catalog'), hashtext(p_provider));
$$;

COMMENT ON FUNCTION public.unlock_sync(text) IS
  'Slice 002 / T032 / R-006: per-provider advisory-lock release. Returns true '
  'on release, false if no matching lock was held by this session. Called by '
  'the sync-catalog Edge Function in a finally block.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- service_role is the only role permitted to drive a sync cycle. The
-- pg_roles existence check keeps the migration portable across bare-Postgres
-- and Supabase-platform images (slice 001 T024 / 0024 grant pattern).
REVOKE EXECUTE ON FUNCTION public.try_lock_sync(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.unlock_sync(text)   FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.try_lock_sync(text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.unlock_sync(text)   TO service_role';
  END IF;
END;
$$;

COMMIT;
