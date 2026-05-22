-- Slice 004 / T006 / FR-009 / spec § Assumptions. Default policy: champion ≠ runner_up (a team CANNOT be the runner_up of itself; the runner_up by definition is the team that lost the final to the champion). Slice 008 admin UI may flip this for edge cases. Migration slot 0047 per D-016 (spec said 0044; slice 003 already filled 0030-0038, slice 004 0039-0046).
BEGIN;

INSERT INTO public.tournament_config (key, value)
VALUES ('predictions.allow_identical_champion_runner_up', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
