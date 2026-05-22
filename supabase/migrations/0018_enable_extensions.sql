-- Slice 002 / T002. Enable pg_cron + pg_net for the catalog sync schedule + webhook outage alerts.
--
-- Consumers:
--   * pg_cron  -> T043 (catalog sync schedule: three-tier cadence wrapper invoking sync-catalog Edge Function).
--   * pg_net   -> T041 (sustained-outage webhook delivery from Postgres; also implicitly used by
--                 Supabase Auth's HTTP hook chain established in Slice 001).
--
-- Both extensions are installed into the Supabase-managed `extensions` schema (already on the
-- `extra_search_path` per supabase/config.toml [api]). Using `IF NOT EXISTS` keeps re-runs and
-- `supabase db reset` safe.
--
-- Note: Supabase CLI v2.98.2's `config.toml` does not provide a stable `[db.extensions]` block
-- for pre-installation at `supabase start` time, so this migration is the AUTHORITATIVE place
-- where pg_cron and pg_net are turned on for both local dev and managed environments. A pointer
-- comment was added to `supabase/config.toml` referencing this file.
--
-- Verification (deferred — Docker daemon is down at the time of authoring):
--   psql "$SUPABASE_DB_URL" -c \
--     "SELECT extname FROM pg_extension WHERE extname IN ('pg_cron','pg_net') ORDER BY extname;"
-- Expected: two rows -> pg_cron, pg_net.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

COMMIT;
