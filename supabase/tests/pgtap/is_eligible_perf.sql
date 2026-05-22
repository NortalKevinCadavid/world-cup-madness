-- is_eligible_perf.sql
-- =============================================================================
-- Slice 001 (Eligibility & Login) — performance regression guard for the
-- cross-slice eligibility predicate `public.is_eligible_nortal_participant`.
--
-- Cross-slice contract reference:
--   `specs/001-eligibility-login/contracts/eligibility-predicate.sql.md`
--     § Performance — "p95 latency < 5 ms" (locked contract per Constitution
--     Principle XI).
--   `specs/001-eligibility-login/research.md` § R-012 — same 5 ms p95 budget.
--   `specs/001-eligibility-login/tasks.md` — T042.
--
-- Why this matters:
--   Every other slice's RLS (002 matches, 003 predictions, 004 finals,
--   005 leaderboard, 006 admin, 007 audit, 008 config) calls this predicate
--   inline via `is_eligible_nortal_participant(auth.uid())`. If it regresses,
--   every slice's per-request latency regresses. This file is the single
--   regression guard for that contract budget.
--
-- Test design (per tasks.md T042 agent prompt + contract § Test surface):
--   1. Setup: bulk-insert 500 `auth.users` rows + 500 `public.participants`
--      rows via `generate_series(1, 500)`, with deterministic UUIDs so reruns
--      are reproducible. The auth.users insert MUST come first because
--      `participants.auth_user_id` has a FOREIGN KEY ON DELETE RESTRICT to
--      `auth.users(id)`.
--   2. Sample: invoke the predicate 1,000 times against random participants
--      from the 500-row fixture (with replacement is fine — each row gets
--      hit ~2x on average). Each call's wall-clock latency is recorded in a
--      temp table via `clock_timestamp()` deltas.
--   3. Assert: a single `ok()` that `percentile_cont(0.95)` over the 1,000
--      samples is < 5.0 ms. The failure message reports the observed p95 so
--      a regression is actionable from CI logs alone.
--
-- Why `plan(1)`:
--   The contract budget is one assertion. Setup (bulk inserts, the temp table,
--   the sampling loop) is NOT an assertion surface. Adding p50/p99 checks
--   would dilute the focus on the locked p95 contract; downstream slices are
--   free to add their own perf tests against their own RLS query plans.
--
-- Determinism notes:
--   * Deterministic UUIDs:
--       auth.users:   11110000-0000-0000-0000-<lpad(i, 12, '0')>
--       participants: 22220000-0000-0000-0000-<lpad(i, 12, '0')>
--     so reruns inside the same transaction don't drift, and a developer can
--     `SELECT` these rows by ID if they want to debug a failure under \timing.
--   * The bcrypt `encrypted_password` literal is the same constant used by the
--     slice-001 seed fixture (`supabase/seed/slice-001-fixture.sql`, header
--     note 3 — bcrypt('test'), copied from the Supabase Auth test fixtures).
--     Using `crypt('test', gen_salt('bf'))` here would inflate fixture-setup
--     cost by ~500 bcrypt rounds and is non-deterministic; we want the
--     measured latency to be dominated by the predicate itself, not fixture
--     bcrypt work.
--   * The whole test is wrapped in `BEGIN; ... ROLLBACK;` so neither the
--     bulk-inserted rows nor the temp table persist. `ON COMMIT DROP` on the
--     temp table is belt-and-suspenders for the same reason.
--   * `ON CONFLICT (id) DO NOTHING` on both inserts makes the test re-runnable
--     against a partially-populated DB during local development.
--
-- Hardware caveat (status, not a deviation):
--   Local GREEN status depends on the developer's hardware. The contract
--   budget is "p95 < 5 ms on standard dev hardware" (tasks.md T042 acceptance
--   criteria). Authoring this file is the T042 deliverable; observed runtime
--   verification is deferred until the Docker daemon is up locally and the
--   developer can run `supabase test db --file supabase/tests/pgtap/is_eligible_perf.sql`.
--   If the threshold needs to be relaxed for slower CI runners in the future,
--   that requires updating the contract document — NOT this file in isolation
--   (Principle XI).
-- =============================================================================

BEGIN;

SELECT plan(1);

-- ---------------------------------------------------------------------------
-- Setup 1/3: bulk-insert 500 `auth.users` rows.
--
-- Required first because `participants.auth_user_id` has
--   FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT
-- (migration 0001).
--
-- `instance_id`, `aud`, `role`, `raw_app_meta_data`, `raw_user_meta_data`,
-- and the `email_confirmed_at = now()` pattern mirror the seed fixture so
-- the synthesised rows look indistinguishable from a real Supabase Auth
-- identity to the predicate (it only reads `auth.users.id` via the FK, but
-- staying byte-compatible avoids future surprises).
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
  ('11110000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000',
  format('perf-user-%s@nortal.com', i),
  '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S', -- constant bcrypt('test') from seed fixture; see header
  now(),
  'authenticated',
  'authenticated',
  '{"provider":"keycloak","providers":["keycloak"]}'::jsonb,
  jsonb_build_object('display_name', format('Perf User %s', i)),
  now(),
  now(),
  '',
  '',
  '',
  ''
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Setup 2/3: bulk-insert 500 `public.participants` rows.
--
-- `domain` is GENERATED ALWAYS AS (...) STORED — DO NOT set it (migration 0001).
-- `status = 'active'` so the predicate's status check passes; `email` uses the
-- approved `@nortal.com` domain so the `is_approved_domain` branch also passes
-- — i.e. every one of the 500 rows is a positive case (the predicate returns
-- `true`). That is intentional: we want to measure the predicate's "hot path"
-- because that is the path every slice's RLS exercises on every authenticated
-- request.
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
  ('22220000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  ('11110000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  format('perf-user-%s@nortal.com', i),
  format('Perf User %s', i),
  'EE-North',
  'active'
FROM generate_series(1, 500) AS gs(i)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Setup 3/3: temp table to hold per-invocation latencies, dropped on commit
-- (and on rollback, since the table only exists in this transaction).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE perf_samples (sample_ms double precision) ON COMMIT DROP;

-- ---------------------------------------------------------------------------
-- Sampling loop: 1,000 invocations against random participants.
--
-- `clock_timestamp()` (not `now()`) is REQUIRED here — `now()` returns the
-- transaction start time and would report 0 ms for every call. We compute the
-- delta in seconds and multiply by 1000 to express in milliseconds, matching
-- the contract's units ("p95 < 5 ms").
--
-- Sampling with replacement (`ORDER BY random() LIMIT 1` inside the loop) is
-- the natural mapping of "RLS is invoked once per request, against whichever
-- user happens to be logged in." 1000 samples over a 500-row table means each
-- row gets ~2 hits on average — enough to exercise plan caching effects of
-- the `STABLE` volatility marker on the predicate.
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
     WHERE email LIKE 'perf-user-%@nortal.com'
     ORDER BY random()
     LIMIT 1;

    v_start := clock_timestamp();
    SELECT public.is_eligible_nortal_participant(v_target) INTO v_result;
    v_end := clock_timestamp();

    INSERT INTO perf_samples (sample_ms)
    VALUES (EXTRACT(EPOCH FROM (v_end - v_start)) * 1000.0);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- THE assertion — single terminal `ok()` honoring `plan(1)`.
--
-- `percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms)` is the continuous
-- 95th-percentile estimator (interpolated between samples) — the same shape
-- the contract document uses when it says "p95". The threshold (5.0 ms) and
-- the units (ms) MUST stay aligned with
-- `contracts/eligibility-predicate.sql.md` § Performance; if that contract
-- ever changes, this file changes with it (Principle XI).
--
-- The failure message embeds the observed p95 (rounded to 2 decimals) so a
-- regression is actionable from CI output alone without re-running locally.
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms)
     FROM perf_samples) < 5.0,
  format(
    'is_eligible_nortal_participant p95 < 5 ms over 1000 samples (observed: %s ms)',
    (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms)::numeric, 2)
       FROM perf_samples)
  )
);

SELECT * FROM finish();

ROLLBACK;
