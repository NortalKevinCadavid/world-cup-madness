-- ============================================================================
-- local-dev-enable-test-cleanup.sql
-- ============================================================================
-- Slice 007 follow-up gate — enables the `__test_delete_audit_rows(uuid[])`
-- RPC (shipped by migration 0083) for local-dev / CI test runs.
--
-- This seed file is ONLY loaded by `supabase db reset` (local), wired into
-- supabase/config.toml § [db.seed].sql_paths. Production deployments use
-- `supabase db push --linked` which applies migrations but NEVER applies
-- seeds, so the flag stays absent in prod and the RPC fails-closed there.
--
-- The flag's only purpose is to gate the test-only audit-cleanup RPC.
-- Setting it manually in production would re-enable an audit_log DELETE path
-- — that's a deliberate "you must take this dangerous action consciously"
-- posture, not an oversight.
-- ============================================================================

INSERT INTO public.tournament_config (key, value, updated_at)
VALUES (
  'dev.test_audit_cleanup_enabled',
  'true'::jsonb,
  now()
)
ON CONFLICT (key) DO UPDATE
   SET value = 'true'::jsonb,
       updated_at = now();
