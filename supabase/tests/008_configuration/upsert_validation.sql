-- upsert_validation.sql
-- Slice 008 Tournament Configuration | Task T026 | Foundation regression
--
-- Spec anchors:
--   spec.md § US1/US2 -- `admin_config_upsert` performs per-key validation
--   (shape + type + value range) before persisting. Errors are surfaced via
--   Postgres SQLSTATE codes:
--     WCG01 -- optimistic concurrency conflict (covered in upsert_concurrency.sql)
--     WCG02 -- input validation failure (shape/type/range/empty reason)
--     WCG03 -- unknown configuration key
--
-- Contract source of truth:
--   contracts/admin-config-upsert.write.md § Input validation table:
--     - locking.match_prediction_window_minutes: positive integer (else WCG02)
--     - eligibility.allowed_domains: JSONB array of strings (else WCG02)
--     - scoring.match_points.exact: integer (else WCG02)
--     - p_reason: non-empty trimmed string (else WCG02)
--     - p_key: must exist in tournament_config catalog (else WCG03)
--
-- All assertions run as the seeded admin (fixture uuid d3, mirroring slice
-- 007 conventions) so the WCG00 admin gate is satisfied and the WCG02/WCG03
-- paths are exercised. Concurrency (WCG01) is covered in T025
-- (upsert_concurrency.sql).

BEGIN;
SELECT plan(5);

-- Establish admin context for every assertion below. SET LOCAL keeps the
-- role change inside this transaction so the ROLLBACK at the end fully
-- isolates state.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

-- Capture current version_id for each catalog key under test so the
-- optimistic-lock check passes and we exercise the validator (not WCG01).
SELECT set_config(
  'test.v_locking',
  (SELECT version_id::text FROM public.tournament_config WHERE key = 'locking.match_prediction_window_minutes'),
  false
);
SELECT set_config(
  'test.v_domains',
  (SELECT version_id::text FROM public.tournament_config WHERE key = 'eligibility.allowed_domains'),
  false
);
SELECT set_config(
  'test.v_scoring',
  (SELECT version_id::text FROM public.tournament_config WHERE key = 'scoring.match_points.exact'),
  false
);

-- A1: negative integer for window_minutes violates the positive-int rule.
SELECT throws_ok(
  format(
    $f$SELECT public.admin_config_upsert('locking.match_prediction_window_minutes'::text, '-5'::jsonb, %L::bigint, 'negative test'::text)$f$,
    current_setting('test.v_locking')
  ),
  'WCG02',
  NULL,
  'A1: negative int for window_minutes raises WCG02'
);

-- A2: string instead of JSON array for allowed_domains violates the shape rule.
SELECT throws_ok(
  format(
    $f$SELECT public.admin_config_upsert('eligibility.allowed_domains'::text, '"not-an-array"'::jsonb, %L::bigint, 'wrong shape test'::text)$f$,
    current_setting('test.v_domains')
  ),
  'WCG02',
  NULL,
  'A2: string instead of array for allowed_domains raises WCG02'
);

-- A3: string for an integer-typed scoring key violates the type rule.
SELECT throws_ok(
  format(
    $f$SELECT public.admin_config_upsert('scoring.match_points.exact'::text, '"abc"'::jsonb, %L::bigint, 'wrong type test'::text)$f$,
    current_setting('test.v_scoring')
  ),
  'WCG02',
  NULL,
  'A3: string for integer key raises WCG02'
);

-- A4: unknown configuration key bypasses the catalog and must raise WCG03.
SELECT throws_ok(
  $$SELECT public.admin_config_upsert('foo.bar'::text, '42'::jsonb, 0::bigint, 'unknown key test'::text)$$,
  'WCG03',
  NULL,
  'A4: unknown key raises WCG03'
);

-- A5: empty reason (audit requirement) raises WCG02 even when value is valid.
SELECT throws_ok(
  format(
    $f$SELECT public.admin_config_upsert('locking.match_prediction_window_minutes'::text, '60'::jsonb, %L::bigint, ''::text)$f$,
    current_setting('test.v_locking')
  ),
  'WCG02',
  NULL,
  'A5: empty reason raises WCG02'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
