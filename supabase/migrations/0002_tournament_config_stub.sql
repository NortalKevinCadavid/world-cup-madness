-- Slice 001 stub. Slice 008 will ALTER this table to add value_type/updated_by/version_id columns, RLS, and the config_read() helper.
--
-- Minimal key/value config table. Slice 001 only writes the
-- eligibility.approved_domains key, which `public.is_approved_domain(text)`
-- reads via `jsonb_array_elements_text(value)` (see
-- specs/001-eligibility-login/contracts/eligibility-predicate.sql.md).
--
-- Forward-compatible: Slice 008 owns the full schema (value_type,
-- updated_by, version_id, RLS, config_read() helper, version history) and
-- will extend this table with `ADD COLUMN IF NOT EXISTS` / `CREATE POLICY`
-- statements. Do NOT add those here.
--
-- RLS is intentionally NOT enabled here. T012 owns the RLS carve-out that
-- lets the eligibility predicate read the approved-domains row without
-- recursing through `is_eligible_nortal_participant`.

CREATE TABLE IF NOT EXISTS public.tournament_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the eligibility.approved_domains key per OD-001's default
-- (docs/architecture/open-decisions.md). Slice 008's admin UI will
-- replace this value before production launch.
--
-- `value` is jsonb (a JSON array of lowercase domain strings).
-- Downstream readers MUST cast it explicitly, e.g.
--   SELECT d FROM jsonb_array_elements_text(value) AS d
-- as `public.is_approved_domain(text)` does.
INSERT INTO public.tournament_config (key, value)
VALUES ('eligibility.approved_domains', '["nortal.com"]'::jsonb)
ON CONFLICT (key) DO NOTHING;
