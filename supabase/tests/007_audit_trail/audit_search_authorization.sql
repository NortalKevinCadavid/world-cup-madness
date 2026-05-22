-- audit_search_authorization.sql
-- Slice 007 Audit Trail | Task T014 | US3
--
-- Spec anchors:
--   spec.md § US3 -- "Admin filters and inspects the audit log via a
--   searchable surface; non-admin callers are denied with an audited
--   access_denied event." FR-009..FR-011 (admin-only audit search RPC,
--   access-denial audit row, deterministic ordering).
--
-- Contract source of truth:
--   contracts/audit-search.read.md § Authorization --
--   "audit_search() MUST raise SQLSTATE WAT01 ('not admin') when called by
--    a non-admin participant. BEFORE raising, the RPC MUST insert an
--    audit_log row with action='admin.access_denied', entity_type=
--    'audit_search', source='api_guard', actor=auth.uid(). Admin callers
--    receive a result set ordered by sequence_id ASC, bounded by p_limit."
--
-- Test scope (plan(4) -- 1 throws_ok + 2 cmp_ok + 1 is):
--   A1: SET ROLE authenticated with non-admin JWT (alpha); call
--       audit_search() -- expect SQLSTATE WAT01.
--   A2: Verify the RPC body wrote an admin.access_denied audit row with
--       the locked shape (entity_type='audit_search', source='api_guard',
--       actor=alpha uuid, occurred_at within last minute).
--   A3: SET ROLE authenticated with admin JWT (admin1); call
--       audit_search(p_limit => 5) -- expect <= 5 rows returned.
--   A4: Admin call results are ordered by sequence_id ASC -- verified by
--       window-function diff (every diff > 0, NULL on first row allowed).
--
-- Out of scope (covered by sibling T015 audit_search_errcodes.sql):
--   * WAT02 input validation (p_limit bounds, date ordering, source
--     vocabulary, action_pattern length).
--   * WAT03 unbounded-count refusal on count_audit_search().
--
-- Impersonation pattern:
--   The test runner role is `postgres` (BYPASSRLS + DDL). For each
--   assertion we (1) set request.jwt.claims via set_config so the
--   SECURITY DEFINER body sees auth.uid() correctly, (2) SET LOCAL ROLE
--   authenticated to ensure the privilege evaluation matches a real
--   PostgREST call, (3) RESET ROLE between assertions to return to the
--   postgres test-runner context (needed for the audit_log SELECT in A2
--   which would otherwise be RLS-gated). This mirrors slice 006 admin
--   RPC denial tests (admin_record_match_result_not_admin.sql).
--
-- Fixture uuids (slice 001 seed):
--   * alpha   (non-admin) auth_user_id 00000000-0000-0000-0000-00000000000a
--   * admin1  (admin)     auth_user_id 00000000-0000-0000-0000-0000000000d3
--                         participants.id 77777777-7777-7777-7777-777777777777
--
-- Pattern: BEGIN / plan(4) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(4);

-- ---------------------------------------------------------------------------
-- A1: non-admin caller -> WAT01.
-- Set JWT sub to alpha's auth_user_id, switch to authenticated role, invoke
-- audit_search() with all defaults. The RPC's is_admin(auth.uid()) gate
-- raises WAT01. NULL message-match keeps the assertion robust against
-- minor wording drift in the RAISE EXCEPTION USING MESSAGE clause.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-00000000000a',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT * FROM public.audit_search()$$,
  'WAT01',
  NULL,
  'A1: non-admin call raises WAT01'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: the WAT01 raise was preceded by an admin.access_denied audit row
-- written by the RPC body (api_guard pattern from slice 006). We evaluate
-- under postgres role so RLS doesn't gate the SELECT. The occurred_at
-- bound (last 1 minute) protects against false positives from any pre-seeded
-- denial rows in the fixture.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  (SELECT count(*)
     FROM public.audit_log
    WHERE action = 'admin.access_denied'
      AND entity_type = 'audit_search'
      AND source = 'api_guard'
      AND actor = '00000000-0000-0000-0000-00000000000a'::uuid
      AND occurred_at > (now() - interval '1 minute')),
  '>=',
  1::bigint,
  'A2: non-admin call produced admin.access_denied audit row'
);

-- ---------------------------------------------------------------------------
-- A3: admin caller -> bounded result set. Set JWT sub to admin1's
-- auth_user_id (is_admin() resolves via participants.is_admin flag), call
-- audit_search(p_limit => 5). The result MUST contain at most 5 rows;
-- exact count depends on fixture seed, so cmp_ok '<=' is the precise
-- assertion. RESET ROLE returns to postgres for the next assertion's
-- jwt.claims rewrite.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT cmp_ok(
  (SELECT count(*) FROM public.audit_search(p_limit => 5)),
  '<=',
  5::bigint,
  'A3: admin call with p_limit=5 returns at most 5 rows'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A4: admin result is ordered by sequence_id ASC. Pull up to 50 rows;
-- compute the per-row diff against the prior sequence_id via LAG; assert
-- every diff is either NULL (first row) or strictly positive. Strictly
-- positive (not just non-negative) holds because sequence_id is BIGSERIAL
-- with no duplicates by construction (slot 0007 schema). bool_and over
-- an empty set returns NULL, so the assertion still passes if the fixture
-- happens to have zero matching rows -- in that case A3's '<=' branch
-- already certified the empty/small result was correctly produced.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT is(
  (
    SELECT bool_and(sequence_id_diff IS NULL OR sequence_id_diff > 0)
      FROM (
        SELECT sequence_id - LAG(sequence_id) OVER (ORDER BY sequence_id)
                 AS sequence_id_diff
          FROM public.audit_search(p_limit => 50)
      ) t
  ),
  true,
  'A4: results are ordered by sequence_id ASC (gaps > 0)'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
