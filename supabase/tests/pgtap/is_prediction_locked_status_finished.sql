-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 6. Calibrated to now() so the test is location-independent.
--
-- BR-LOCK-004: status='finished' locks the match. Re-uses M1 from the
-- slice-002 fixture (ARG vs MEX, bbbb0000-...-1) which is seeded with
-- status='finished'. The match's kickoff is in the past relative to the
-- 2026 tournament window, but the status branch fires first.

BEGIN;

SELECT plan(1);

SELECT is(
  public.is_prediction_locked('bbbb0000-0000-0000-0000-000000000001'::uuid),
  true,
  'status_finished: fixture M1 (ARG-MEX) has status=finished -> predicate TRUE'
);

SELECT * FROM finish();

ROLLBACK;
