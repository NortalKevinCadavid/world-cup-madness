-- Slice 003 defaults / spec § Assumptions / FR-012 / Slice 008 admin UI may overwrite via admin_config_upsert. Values are jsonb; downstream reads cast via (value::text)::int (or jsonb_extract_path_text). The strict-greater-than rule (BR-LOCK-003) is preserved regardless of the configured lock_window value. Migration slot 0035 per D-012 (T013's submit_prediction_sp occupies 0034).

BEGIN;

INSERT INTO public.tournament_config (key, value)
VALUES ('lock_window_minutes', '60'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value)
VALUES ('score_upper_bound', '20'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
