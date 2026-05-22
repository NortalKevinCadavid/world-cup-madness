-- is_admin_perf.sql
-- =============================================================================
-- Slice 006 / T033 / US4 / contracts/is-admin.predicate.sql.md § Performance.
-- Performance regression guard for the cross-slice admin predicate
-- `public.is_admin(uuid)`.
--
-- Cross-slice contract reference:
--   contracts/is-admin.predicate.sql.md § Performance — "p95 latency < 5 ms"
--   (locked cross-slice per Constitution Principle XI).
--
-- Why this matters:
--   Every admin-route guard and every slice 001-006 RLS policy that gates
--   admin access calls is_admin(auth.uid()) inline. A regression here
--   regresses every admin path's per-request latency.
--
-- Test design (mirrors slice 001's is_eligible_perf.sql pattern):
--   1. Setup A: bulk-insert 500 auth.users + 500 participants rows
--      (deterministic UUIDs 33330000-... and 44440000-...) so the test is
--      independent of any prior fixture state.
--   2. Setup B: grant admin_roles rows to a fraction (every 5th -> 100 admins,
--      400 non-admins). This gives a mixed positive/negative call pattern.
--   3. Sample: 1,000 invocations of is_admin against random auth_user_ids
--      from the 500-row fixture. Per-call wall-clock latency captured in a
--      temp table via clock_timestamp() deltas.
--   4. Assert: percentile_cont(0.95) over the 1,000 samples is < 5.0 ms.
--      Failure message embeds the observed p95.
--
-- Determinism notes:
--   * Deterministic UUIDs:
--       auth.users:   33330000-0000-0000-0000-<lpad(i, 12, '0')>
--       participants: 44440000-0000-0000-0000-<lpad(i, 12, '0')>
--     Distinct from slice 001's perf fixture (11110000-/22220000-) so the two
--     perf tests can run back-to-back without UUID collisions if a downstream
--     harness ever bundles them.
--   * Mixed positive/negative case: 100 active admins + 400 non-admins. Each
--     of the 1000 samples hits a random participant (with replacement); ~20%
--     resolve TRUE, ~80% resolve FALSE. Exercises both index branches of the
--     admin_roles_active_uk partial unique index lookup.
--   * Wrapped in BEGIN; ... ROLLBACK; -- no rows persist.
--   * ON CONFLICT (id) DO NOTHING on all inserts -> re-runnable.
--
-- Hardware caveat:
--   Local GREEN status depends on the developer's hardware. The contract
--   budget is "p95 < 5 ms" -- relaxing it for slower CI runners requires
--   updating contracts/is-admin.predicate.sql.md, not this file in isolation
--   (Principle XI). Docker is currently down; authoring this file is the
--   T033 deliverable. Runtime verification is deferred to T035's red-gate.
-- =============================================================================

BEGIN;

SELECT plan(1);

-- ---------------------------------------------------------------------------
-- Setup 1/4: bulk-insert 500 auth.users rows.
-- Required first because participants.auth_user_id FK -> auth.users(id).
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (
  id,
  instance_id,
  email,
  encrypted_password,
  email_confirmed_at,
  aud,
  role,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
)
SELECT
  ('33330000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000',
  format('admin-perf-user-%s@nortal.com', i),
  '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S', -- constant bcrypt('test') from seed fixture
  now(),
  'authenticated',
  'authenticated',
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('display_name', format('Admin Perf User %s', i)),
  now(),
  now(),
  '',
  '',
  '',
  ''
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Setup 2/4: bulk-insert 500 participants rows (all status='active').
-- ---------------------------------------------------------------------------
INSERT INTO public.participants (
  id,
  auth_user_id,
  email,
  display_name,
  region,
  status
)
SELECT
  ('44440000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  ('33330000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  format('admin-perf-user-%s@nortal.com', i),
  format('Admin Perf User %s', i),
  'EE-North',
  'active'
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Setup 3/4: grant admin_roles to every 5th participant (100 admins / 400
-- non-admins). Mixed-result calls exercise both the EXISTS=TRUE and
-- EXISTS=FALSE branches of T007's body so the p95 reflects realistic load.
-- ---------------------------------------------------------------------------
INSERT INTO public.admin_roles (
  participant_id, granted_at, granted_by, revoked_at, revoked_by, revoke_reason
)
SELECT
  ('44440000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  now(),
  NULL, -- system-granted for the perf fixture
  NULL, NULL, NULL
FROM generate_series(1, 500, 5) AS gs(i)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Setup 4/4: temp table for per-invocation latency samples.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE perf_samples (sample_ms double precision) ON COMMIT DROP;

-- ---------------------------------------------------------------------------
-- Sampling loop: 1,000 invocations against random participants.
-- clock_timestamp() (NOT now()) -- now() returns transaction start time and
-- would report 0 ms for every call.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_target   uuid;
  v_start    timestamptz;
  v_end      timestamptz;
  v_result   boolean;
  v_iter     int;
BEGIN
  FOR v_iter IN 1..1000 LOOP
    SELECT auth_user_id
      INTO v_target
      FROM public.participants
     WHERE email LIKE 'admin-perf-user-%@nortal.com'
     ORDER BY random()
     LIMIT 1;

    v_start := clock_timestamp();
    SELECT public.is_admin(v_target) INTO v_result;
    v_end := clock_timestamp();

    INSERT INTO perf_samples (sample_ms)
    VALUES (EXTRACT(EPOCH FROM (v_end - v_start)) * 1000.0);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- THE assertion -- single terminal ok() honoring plan(1).
-- percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms) is the continuous
-- p95 estimator -- same shape the contract uses. Threshold (5.0 ms) and units
-- (ms) MUST stay aligned with contracts/is-admin.predicate.sql.md § Performance.
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms)
     FROM perf_samples) < 5.0,
  format(
    'is_admin p95 < 5 ms over 1000 samples (observed: %s ms)',
    (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms)::numeric, 2)
       FROM perf_samples)
  )
);

SELECT * FROM finish();

ROLLBACK;
