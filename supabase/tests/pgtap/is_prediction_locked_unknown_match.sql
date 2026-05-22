-- Slice 003 / T023 / contracts/prediction-lock.predicate.sql.md § Test surface row 9. Calibrated to now() so the test is location-independent.
--
-- Fail-closed: an unknown match_id (no row in public.matches) must lock.
-- Uses an all-Fs uuid that cannot collide with any seeded fixture (slice
-- 002 uses bbbb-prefixed UUIDs, slice 003 fixture uses other prefixes).

BEGIN;

SELECT plan(1);

SELECT is(
  public.is_prediction_locked('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid),
  true,
  'unknown_match: no row in public.matches for given uuid -> predicate TRUE (fail-closed)'
);

SELECT * FROM finish();

ROLLBACK;
