-- tamper_resistance.sql
-- Slice 007 Audit Trail | Task T010 | US2
--
-- Spec anchors:
--   spec.md § US2 Acceptance Scenario 3 -- "REVOKE UPDATE, DELETE at the
--   database layer such that any update or delete attempt from `authenticated`,
--   `anon`, or `service_role` is rejected with `insufficient_privilege`
--   (SQLSTATE 42501) -- including attempts made with a compromised service-role
--   key." FR-004 (append-only through application paths). Constitution
--   Principle V (NON-NEGOTIABLE append-only audit).
--
-- Contract source of truth:
--   contracts/audit-log.schema.md § Tamper-resistance posture (LOCKED) --
--   `REVOKE UPDATE, DELETE ON public.audit_log FROM authenticated;`
--   `REVOKE UPDATE, DELETE ON public.audit_log FROM anon;`
--   `REVOKE UPDATE, DELETE ON public.audit_log FROM service_role;`
--   These statements ship in slot 0076 (slice 007 T005) and MUST never be
--   re-granted. If a future requirement demands targeted modification (e.g.
--   GDPR redaction), it MUST be implemented as a NEW slice via a
--   SECURITY DEFINER `redact_audit_row(...)` RPC owned by postgres role; this
--   slice does NOT permit blanket re-grant.
--
-- Posture (per migrations 0007 + 0010 + 0073):
--   * audit_log has RLS ENABLED + FORCED (slot 0007).
--   * Two narrow INSERT policies exist for the `authenticated` role:
--       - slot 0010 audit_log_api_guard_self_insert (action='access.denied',
--         source='api_guard', reason in {not_eligible,domain_not_approved,
--         participant_not_provisioned}, actor = caller's participants.id).
--       - slot 0073 audit_log_admin_access_denied_insert (action=
--         'admin.access_denied', source='api_guard', actor = caller's
--         participants.id).
--   * No UPDATE / DELETE policy exists for any role. With slot 0076's REVOKE
--     in place, even service_role (which bypasses RLS) loses the underlying
--     DML privilege and Postgres raises 42501 before policy evaluation.
--   * service_role does NOT have its INSERT privilege revoked -- it bypasses
--     RLS for INSERT writes coming from SECURITY DEFINER triggers / admin
--     RPCs (slice 005 score triggers, slice 006 admin_record_match_result,
--     etc.). A7 below verifies this writer path is preserved.
--
-- Test scope (plan(8) -- 6 throws_ok + 1 lives_ok + 1 is()):
--   A1: SET ROLE authenticated; UPDATE audit_log raises SQLSTATE 42501.
--   A2: SET ROLE authenticated; DELETE FROM audit_log raises SQLSTATE 42501.
--   A3: SET ROLE service_role; UPDATE audit_log raises SQLSTATE 42501.
--   A4: SET ROLE service_role; DELETE FROM audit_log raises SQLSTATE 42501.
--   A5: SET ROLE anon; UPDATE audit_log raises SQLSTATE 42501.
--   A6: SET ROLE anon; DELETE FROM audit_log raises SQLSTATE 42501.
--   A7: SET ROLE service_role; INSERT into audit_log succeeds (writers' path
--       preserved -- service_role retains INSERT to support SECURITY DEFINER
--       trigger callers and admin RPC writes).
--   A8: After every above tamper attempt, the target row's `reason` field
--       remains exactly the original value -- no UPDATE actually landed.
--
-- Out of scope (per spec.md US2 wording -- "audit records are immutable
-- through application PATHS"):
--   * SELECT/read posture -- governed by slot 0007 audit_log_self_or_admin_read
--     policy, exercised in slice 001 RLS tests; US2 narrows to WRITE tamper.
--   * Direct database-level destructive operations (e.g. psql-as-postgres
--     drop_table) are explicitly out of scope per US2 first paragraph --
--     "governed by platform/operational controls, not application logic".
--   * Route-inventory check (no UI/API surface offering UPDATE/DELETE) ships
--     as T011, an isolated Playwright test under apps/web/tests/playwright/.
--
-- Impersonation pattern:
--   The test runner role is `postgres` (BYPASSRLS + DDL). `SET LOCAL ROLE
--   <role>` shifts to the specific Supabase app role for the duration of the
--   statement; the role inherits only the GRANTed privileges of that role,
--   so REVOKE UPDATE/DELETE on the table denies the operation with 42501
--   BEFORE policy evaluation. `RESET ROLE` returns to postgres for setup /
--   verification statements. This mirrors slice 006 admin RPC tests
--   (e.g. admin_record_match_result_not_admin.sql).
--
-- Target row strategy:
--   The setup INSERT runs under postgres role (test runner, BYPASSRLS), so
--   the narrow RLS INSERT policies don't gate it. We use a temp table to
--   stash the target row's id across the assertions; the outer ROLLBACK at
--   test end wipes both the temp table AND the target row (no residue).
--
-- Action label note:
--   'test.tamper_target' is NOT in the frozen catalog (T008 enforces). The
--   ROLLBACK at the end wipes the row entirely so T008 in CI sees zero
--   residue from this test.
--
-- Pattern: BEGIN / plan(8) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(8);

-- ---------------------------------------------------------------------------
-- Setup: insert one target audit_log row under postgres role (test runner,
-- BYPASSRLS). Stash its id in a temp table so all 8 assertions can reference
-- the same row. Original `reason` is recorded so A8 can confirm no
-- successful UPDATE landed.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE t010_target (id uuid PRIMARY KEY) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO public.audit_log (actor, action, entity_type, entity_id, reason, source)
  VALUES (
    '77777777-7777-7777-7777-777777777777'::uuid,  -- admin1 participant.id (slice 005 fixture)
    'test.tamper_target',                            -- NOT in frozen catalog; ROLLBACK wipes it
    'test',
    gen_random_uuid(),
    'tamper resistance test target',                 -- canonical pre-state for A8
    'trigger'                                        -- CHECK-permitted source (slot 0003)
  )
  RETURNING id
)
INSERT INTO t010_target (id) SELECT id FROM inserted;

-- ---------------------------------------------------------------------------
-- A1: authenticated role UPDATE -> SQLSTATE 42501 (insufficient_privilege).
-- The REVOKE in slot 0076 strips UPDATE from the role; Postgres raises before
-- any RLS policy evaluation. NULL message-match keeps the assertion robust
-- against minor server text drift across PG versions.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$UPDATE public.audit_log SET reason = 'tampered_by_authenticated' WHERE id IN (SELECT id FROM t010_target)$$,
  '42501',
  NULL,
  'A1: authenticated UPDATE on audit_log raises SQLSTATE 42501'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: authenticated role DELETE -> 42501.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$DELETE FROM public.audit_log WHERE id IN (SELECT id FROM t010_target)$$,
  '42501',
  NULL,
  'A2: authenticated DELETE on audit_log raises SQLSTATE 42501'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A3: service_role UPDATE -> 42501. service_role bypasses RLS but NOT the
-- table-level GRANT/REVOKE -- the REVOKE in slot 0076 closes the
-- compromised-service-key tamper vector explicitly called out in
-- spec.md US2 AS3.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$UPDATE public.audit_log SET reason = 'tampered_by_service_role' WHERE id IN (SELECT id FROM t010_target)$$,
  '42501',
  NULL,
  'A3: service_role UPDATE on audit_log raises SQLSTATE 42501'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A4: service_role DELETE -> 42501.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$DELETE FROM public.audit_log WHERE id IN (SELECT id FROM t010_target)$$,
  '42501',
  NULL,
  'A4: service_role DELETE on audit_log raises SQLSTATE 42501'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A5: anon role UPDATE -> 42501. anon has no policy admitting any DML on
-- audit_log AND its UPDATE privilege is REVOKEd in slot 0076 -- 42501 fires
-- from the GRANT layer, not the policy layer.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$UPDATE public.audit_log SET reason = 'tampered_by_anon' WHERE id IN (SELECT id FROM t010_target)$$,
  '42501',
  NULL,
  'A5: anon UPDATE on audit_log raises SQLSTATE 42501'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A6: anon role DELETE -> 42501.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$DELETE FROM public.audit_log WHERE id IN (SELECT id FROM t010_target)$$,
  '42501',
  NULL,
  'A6: anon DELETE on audit_log raises SQLSTATE 42501'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A7: service_role INSERT succeeds. The writer path is preserved -- audit
-- writers (slice 005 score triggers via SECURITY DEFINER, slice 006 admin
-- RPCs, slice 007's planned audit-search denial path) MUST keep their
-- ability to INSERT new audit rows. service_role's RLS bypass means narrow
-- INSERT policies don't have to match; the underlying GRANT INSERT (never
-- revoked) admits the row.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$INSERT INTO public.audit_log (actor, action, entity_type, entity_id, reason, source)
    VALUES (
      '77777777-7777-7777-7777-777777777777'::uuid,
      'test.service_role_insert',
      'test',
      gen_random_uuid(),
      'A7 service_role INSERT writer-path probe',
      'trigger'
    )$$,
  'A7: service_role INSERT on audit_log succeeds (writer path preserved)'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A8: target row's `reason` field is unchanged. Confirms no UPDATE from
-- A1/A3/A5 actually landed (defence in depth: even if throws_ok somehow
-- passed against a partial commit, A8 catches the residual mutation).
-- Evaluated under postgres role so RLS doesn't gate the SELECT.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT reason
     FROM public.audit_log
    WHERE id IN (SELECT id FROM t010_target)),
  'tamper resistance test target',
  'A8: target row reason field unchanged after all tamper attempts'
);

SELECT * FROM finish();

ROLLBACK;
