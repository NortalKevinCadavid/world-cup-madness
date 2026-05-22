-- Slice 005 / T006 / research.md § R-014 / handoff to Slice 008.
-- Migration slot 0057 per D-023 (slice 005 renumber; spec slot 0058 collapsed to 0057).
-- Seeds tournament_config with default values for the scoring + leaderboard rules.
-- Slice 008 is the runtime owner of these keys; this migration is the placeholder
-- so the system functions end-to-end before Slice 008 ships an admin UI
-- (Constitution Principle X — Vertical Slice Delivery).
--
-- READ PATTERN (consumers MUST cast jsonb explicitly):
--   - Integer: SELECT (value)::int FROM tournament_config WHERE key='match_points.exact';
--   - Text:    SELECT value #>> '{}' FROM tournament_config WHERE key='knockout_score_basis';
--   - Timestamp: SELECT (value #>> '{}')::timestamptz FROM tournament_config WHERE key='first_kickoff_utc';
--   - Boolean: SELECT (value)::boolean FROM tournament_config WHERE key='predictions.allow_identical_champion_runner_up';
--   - JSON array: SELECT jsonb_array_elements_text(value) FROM tournament_config WHERE key='tiebreaker.order';
--
-- CONFIGURABLE ENUMS (slices that read these MUST accept any of the listed values):
--   - knockout_score_basis: 'reg_plus_extra' (default per OD-002) | 'reg_plus_extra_plus_pens' (reserved)
--   - top_scorer_source: 'fifa_golden_boot' (default per OD-004)
--   - best_player_source: 'fifa_golden_ball' (default per OD-005)
--   - leaderboard_visibility: 'full_names' (default per OD-006) | 'anonymized' | 'team_scoped'
--
-- Re-runnable: every INSERT uses ON CONFLICT (key) DO NOTHING. Keys already seeded by
-- prior slices (lock_window_minutes from slice 003 slot 0035, first_kickoff_utc from
-- slice 004 seed fixture) are repeated here for completeness — they will no-op.
--
-- Constitution: VIII (no hard-coded rule values), X (vertical slice delivery).

BEGIN;

-- --- Match scoring (FR-015, §7.2) ---------------------------------------------

INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('match_points.exact', '10'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('match_points.outcome', '5'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('match_points.incorrect', '0'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- --- Final-tournament scoring (FR-015, §7.3) ----------------------------------

INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('final_points.each_item', '20'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- --- Tie-breaker configuration (FR-004, FR-005, §7.4) -------------------------
-- Priority list applied left-to-right by leaderboard_v's ORDER BY. The "total"
-- entry is the participant's grand total; the remaining entries are SUM-derived
-- counts/sub-totals on score_records (see data-model.md § Leaderboard Entry).
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('tiebreaker.order', '["total","exact_count","outcome_count","final_points"]'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Tier 5 (earliest last-valid-prediction timestamp) is OFF by default per §7.4
-- "only if approved" note. Slice 008 may flip without code change.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('tiebreaker.tier5_enabled', 'false'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Rank function: 'rank' (1,2,2,4) is the default per §7.4 and R-004. Slice 008
-- may switch to 'dense_rank' (1,2,2,3).
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('tiebreaker.rank_function', '"rank"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- --- Calculation-version pointer (R-003) --------------------------------------
-- Single read pointer; leaderboard_v and personal_breakdown_v filter
-- WHERE calculation_version = current_calculation_version. Scoring runs bump
-- this in the same transaction as the new score_records rows so readers always
-- see a self-consistent snapshot.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('current_calculation_version', '1'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- --- Configurable enums (resolved ODs) ----------------------------------------

-- knockout_score_basis: 'reg_plus_extra' (default per OD-002) | 'reg_plus_extra_plus_pens' (reserved).
-- This slice MUST NOT branch on this value — Slice 002 honors it when populating
-- match_results.home_score_for_scoring / away_score_for_scoring (see R-006).
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('knockout_score_basis', '"reg_plus_extra"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- top_scorer_source: 'fifa_golden_boot' (default per OD-004). Slice 002 / Slice 006
-- populate tournament_award.top_scorer_player_id with the FIFA Golden Boot winner.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('top_scorer_source', '"fifa_golden_boot"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- best_player_source: 'fifa_golden_ball' (default per OD-005). Slice 002 / Slice 006
-- populate tournament_award.best_player_player_id with the FIFA Golden Ball winner.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('best_player_source', '"fifa_golden_ball"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- leaderboard_visibility: 'full_names' (default per OD-006) | 'anonymized' | 'team_scoped'.
-- leaderboard_v / peer_pick_v / peer_final_pick_v read this to mask display_name.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('leaderboard_visibility', '"full_names"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- --- Cross-slice keys repeated for idempotent re-runs -------------------------

-- lock_window_minutes: already seeded by slice 003 slot 0035 (BR-LOCK-002 default 60).
-- Repeated here so a fresh `supabase db reset` after slot 0035 is dropped still
-- yields a working slice 005. ON CONFLICT DO NOTHING preserves the slice 003 value.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('lock_window_minutes', '60'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- first_kickoff_utc: 2026 World Cup opening match kickoff (Mexico City, 16 Jun 2026
-- 20:00 UTC = 12:00 local). Used by peer_final_pick_v's lock predicate (FR-016) and
-- by FR-010 final-prediction lock. Slice 004 also writes this via seed fixture;
-- Slice 002 sync / Slice 008 admin UI may overwrite. Stored as a JSON string so
-- consumers must read `value #>> '{}'` and cast to timestamptz.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('first_kickoff_utc', '"2026-06-16T20:00:00Z"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- recalc_latency_target_minutes: FR-011 / SC-005 target. Informational — surfaced for
-- T044 perf gates and future operational SLOs. Slice 008 may tune.
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('recalc_latency_target_minutes', '1'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
