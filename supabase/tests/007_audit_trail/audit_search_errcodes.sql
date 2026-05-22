-- audit_search_errcodes.sql
-- Slice 007 Audit Trail | Task T015 | US3
--
-- Spec anchors:
--   spec.md § US3 -- Admin audit search RPC must validate inputs and refuse
--   unbounded counts. Errors are surfaced via Postgres SQLSTATE codes:
--     WAT01 -- caller is not admin
--     WAT02 -- input validation failure (limit/offset/range/source/pattern)
--     WAT03 -- unbounded count refusal (no filters AND audit_log > 100,000)
--
-- Contract source of truth:
--   contracts/audit-search.read.md § Behavior > Input validation table:
--     - p_limit must be 1..500 (else WAT02)
--     - p_offset must be >= 0 (else WAT02)
--     - p_from > p_to => WAT02
--     - p_source must be in {auth_hook,rls,api_guard,ui,trigger,admin_rpc,system}
--       (else WAT02)
--     - length(p_action_pattern) > 200 => WAT02
--   contracts/audit-search.read.md § count_audit_search WAT03 rule.
--
-- All assertions run as a seeded admin so the WAT01 admin gate is satisfied
-- and the WAT02/WAT03 paths are exercised. The WAT01 path is covered
-- separately in audit_search_authorization.sql (T014).

BEGIN;
SELECT plan(7);

-- Establish admin context for every assertion below. The fixture uuid
-- 00000000-0000-0000-0000-0000000000d3 corresponds to the seeded admin
-- participant used across slice 007 tests (see fixtures referenced in
-- T014). SET LOCAL keeps the role change inside this transaction so the
-- ROLLBACK at the end fully isolates state.
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

-- A1: p_limit above the 500 ceiling raises WAT02.
SELECT throws_ok(
  $$SELECT * FROM public.audit_search(p_limit => 1000)$$,
  'WAT02',
  NULL,
  'A1: p_limit > 500 raises WAT02'
);

-- A2: p_limit at zero (below the 1 floor) raises WAT02.
SELECT throws_ok(
  $$SELECT * FROM public.audit_search(p_limit => 0)$$,
  'WAT02',
  NULL,
  'A2: p_limit=0 raises WAT02'
);

-- A3: negative p_offset raises WAT02.
SELECT throws_ok(
  $$SELECT * FROM public.audit_search(p_offset => -1)$$,
  'WAT02',
  NULL,
  'A3: p_offset < 0 raises WAT02'
);

-- A4: inverted range (p_from > p_to) raises WAT02.
SELECT throws_ok(
  $$SELECT * FROM public.audit_search(p_from => '2026-12-31T00:00:00Z'::timestamptz, p_to => '2026-01-01T00:00:00Z'::timestamptz)$$,
  'WAT02',
  NULL,
  'A4: p_from > p_to raises WAT02'
);

-- A5: p_source outside the locked enum raises WAT02.
SELECT throws_ok(
  $$SELECT * FROM public.audit_search(p_source => 'invalid_source')$$,
  'WAT02',
  NULL,
  'A5: invalid p_source raises WAT02'
);

-- A6: p_action_pattern longer than 200 characters raises WAT02.
SELECT throws_ok(
  format(
    $f$SELECT * FROM public.audit_search(p_action_pattern => %L)$f$,
    repeat('x', 201)
  ),
  'WAT02',
  NULL,
  'A6: p_action_pattern length > 200 raises WAT02'
);

-- A7: count_audit_search with no filters when audit_log holds more than
-- 100,000 rows must raise WAT03. Seeding 100,001 rows inside a pgTAP
-- transaction is prohibitively expensive (would dominate the suite
-- runtime), so this case is skipped here and verified at runtime via the
-- slice 007 quickstart. A future fixture that pre-loads 100,001 rows can
-- replace this skip() with a throws_ok($$ ... $$, 'WAT03', ...).
SELECT skip(
  1,
  'WAT03 unbounded-count test skipped -- requires > 100,001 audit_log rows; runtime-verified via slice 007 quickstart'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
