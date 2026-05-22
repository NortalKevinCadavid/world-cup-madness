-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- Fail-CLOSED on missing config (D-017 / contract § Semantics rule 1). If the
-- tournament_config row for first_kickoff_utc is absent, the predicate MUST
-- return TRUE (locked) so no participant can mutate final predictions while
-- the tournament anchor is unset. This is the safety posture: misconfigured
-- → locked, never editable.
--
-- The outer ROLLBACK restores the slice-004 fixture's seeded row.
--
-- Pattern: BEGIN / plan(1) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(1);

-- Remove the first_kickoff_utc config row entirely.
DELETE FROM public.tournament_config WHERE key = 'first_kickoff_utc';

-- A1: missing config → predicate returns TRUE (fail-CLOSED).
SELECT is(
  public.is_final_prediction_locked(),
  true,
  'A1 is_final_prediction_locked() returns TRUE when first_kickoff_utc row is missing (fail-CLOSED per D-017)'
);

SELECT * FROM finish();

ROLLBACK;
