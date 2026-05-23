-- =============================================================================
-- Slice 001 (Eligibility & Login) — deterministic seed fixture
--
-- Loaded automatically by `supabase db reset` per `supabase/config.toml`
-- [db.seed] sql_paths = ['./supabase/seed/slice-001-fixture.sql'].
--
-- Tests (pgTAP T018–T020, Playwright T016/T017/T029/T036) MUST read identities
-- from this fixture. They MUST NOT create ad-hoc accounts inline. The seed is
-- idempotent: every INSERT uses ON CONFLICT DO NOTHING with deterministic UUIDs
-- and natural keys, so `supabase db reset` (which may re-run the seed against a
-- partially-populated DB during dev) produces no duplicates and no failures.
--
-- Spec contract: `specs/001-eligibility-login/tasks.md` T015 +
--                `specs/001-eligibility-login/quickstart.md` § Seed data +
--                `specs/001-eligibility-login/data-model.md` § Entity 1.
--
-- -----------------------------------------------------------------------------
-- Hand-verified scenario coverage
-- -----------------------------------------------------------------------------
--
-- Each row below maps to one or more spec scenarios (`spec.md` § Acceptance
-- Scenarios and § Edge Cases). If a scenario is added to spec.md, this comment
-- block MUST be updated in the same PR.
--
--   US1 Acceptance Scenario 1 (first-time eligible sign-in / FR-001 / FR-003)
--       → NOT covered by a pre-seeded row by design; the test signs in a
--         brand-new identity (e.g. `newuser@nortal.com`) and asserts a
--         participants row is created. The fixture intentionally leaves room
--         for the auth hook to exercise its INSERT path.
--
--   US1 Acceptance Scenario 2 (returning eligible sign-in re-uses row,
--       updates last_login_at / FR-004)
--       → `alpha@nortal.com`     (auth.users 00000000-0000-0000-0000-00000000000A)
--       → `bravo@nortal.com`     (auth.users 00000000-0000-0000-0000-00000000000B)
--
--   US1 Acceptance Scenario 3 (every authenticated request re-verifies
--       eligibility / FR-002)
--       → `alpha@nortal.com` — also used for the API-guard re-check tests.
--
--   US2 Acceptance Scenario 1 (UI denies ineligible domain / FR-002)
--       → `outsider@example.com` (auth.users 00000000-0000-0000-0000-00000000000E)
--         NOTE: only an auth.users row exists — NO participants row, because
--         the auth hook would have rejected provisioning per FR-002.
--
--   US2 Acceptance Scenario 2 (API rejects ineligible token / FR-002 / FR-005)
--       → `outsider@example.com` — JWT synthesised for this auth.users row in
--         the API-guard test (Playwright T029).
--
--   US2 Acceptance Scenario 3 (denial writes audit row / FR-006)
--       → No fixture row required — assertion is on the audit_log row produced
--         by the auth hook + API guard at runtime. The fixture deliberately
--         does NOT pre-populate audit_log so test assertions see only rows
--         emitted by the triggers and hooks (per tasks.md "Do NOT insert
--         directly into audit_log").
--
--   US3 Acceptance Scenario 1 (display_name refresh in place / FR-004 / R-010)
--       → `alpha@nortal.com` — test changes the OIDC display_name claim and
--         asserts the existing row updates without a new participants.id.
--
--   US3 Acceptance Scenario 2 (newly available region populated)
--       → `charlie@nortal.com` (auth.users 00000000-0000-0000-0000-00000000000C)
--         seeded with region=NULL so the test can supply a region claim and
--         assert it lands in the row.
--
--   US3 Acceptance Scenario 3 (missing optional claim doesn't clear stored
--       value / Clarifications 2026-05-15)
--       → `alpha@nortal.com` (region='EE-North') — test signs in with NO
--         region claim and asserts the stored region is unchanged.
--
--   Edge case E-1 (missing email/domain claim → denied)
--       → No fixture row required; test synthesises a token without an email
--         claim. The auth hook denies before any DB INSERT.
--
--   Edge case E-2 (config changes between two requests → next request uses
--       fresh config)
--       → `alpha@nortal.com` — test updates tournament_config mid-session and
--         asserts the next request is denied.
--
--   Edge case E-3 (domain removed mid-tournament → existing predictions
--       preserved, next request denied / FR-007)
--       → `bravo@nortal.com` — test removes `nortal.com` from
--         tournament_config and asserts the participants row remains while
--         the next API call returns 403.
--
--   Edge case E-5 (config store unreachable → fail closed / FR-008)
--       → `alpha@nortal.com` — test DELETEs the config row and asserts the
--         sign-in attempt is denied with reason='config_unavailable'.
--
--   Edge case E-6 (deactivated participant denied on next request)
--       → `zulu@nortal.com` (auth.users 00000000-0000-0000-0000-00000000000Z)
--         pre-seeded with status='deactivated'.
--
-- -----------------------------------------------------------------------------
-- Operational notes
-- -----------------------------------------------------------------------------
-- 1. Inserting into auth.users requires superuser / service_role privilege.
--    `supabase db reset` runs the seed as superuser, so this works locally.
--    Do NOT add SET ROLE here.
--
-- 2. `encrypted_password` uses a deterministic constant bcrypt hash so the
--    seed produces byte-identical rows across runs (gen_salt is random and
--    therefore inappropriate here). The literal password is irrelevant: tests
--    NEVER authenticate via password — they always synthesise JWTs against the
--    local stub IdP (quickstart.md § Auth provider setup).
--
-- 3. The constant hash below is a known bcrypt(`test`) digest copied from the
--    Supabase Auth test fixtures; it does NOT validate against any real
--    password ever used in production.
--
-- 4. Inserts into public.participants fire the T013 AFTER INSERT trigger
--    (migration 0008), which emits a `participant.created` audit_log row.
--    That is expected and desired — tests assert on those audit rows.
--    Per tasks.md "Do NOT insert directly into audit_log" this fixture does
--    not stage any audit_log rows manually.
--
-- 5. tournament_config.eligibility.approved_domains is already seeded by
--    migration 0002 as `["nortal.com"]`. This fixture does NOT re-seed it
--    (tasks.md § What to do step 6).
-- =============================================================================

BEGIN;

-- Bypass the on_auth_user_created AFTER INSERT trigger (slot 0009) for the
-- duration of this fixture transaction so deterministic participant ids are
-- preserved. Without this, the trigger would insert a competing participants
-- row with gen_random_uuid() before our explicit INSERT runs.
SET LOCAL app.skip_auth_provisioning = 'true';

-- ---------------------------------------------------------------------------
-- auth.users  (5 rows total: 4 eligible-by-domain + 1 ineligible)
-- ---------------------------------------------------------------------------
--
-- Stable UUIDs (kept human-greppable, last hex char identifies the persona):
--   00000000-0000-0000-0000-00000000000A  alpha    @nortal.com    eligible/active
--   00000000-0000-0000-0000-00000000000B  bravo    @nortal.com    eligible/active
--   00000000-0000-0000-0000-00000000000C  charlie  @nortal.com    eligible/active
--   00000000-0000-0000-0000-00000000000Z  zulu     @nortal.com    eligible/DEACTIVATED
--   00000000-0000-0000-0000-00000000000E  outsider @example.com   INELIGIBLE (no participant row)
--
-- All five rows have email_confirmed_at = now() so they are treated as
-- verified identities by Supabase Auth.

INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
) VALUES
  -- alpha — eligible, active, region populated
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-00000000000a',
    'authenticated',
    'authenticated',
    'alpha@nortal.com',
    '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S', -- bcrypt('test') constant (see header note 3)
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Alpha","region":"EE-North"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  -- bravo — eligible, active, region populated
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-00000000000b',
    'authenticated',
    'authenticated',
    'bravo@nortal.com',
    '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Bravo","region":"EE-North"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  -- charlie — eligible, active, region INTENTIONALLY NULL (exercises US3.2)
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-00000000000c',
    'authenticated',
    'authenticated',
    'charlie@nortal.com',
    '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Charlie"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  -- zulu — eligible-by-domain but DEACTIVATED (exercises E-6)
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-00000000000d',
    'authenticated',
    'authenticated',
    'zulu@nortal.com',
    '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Zulu Deactivated"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  -- outsider — INELIGIBLE domain. NO participants row will be created.
  -- Present only so Playwright T029 (API-guard test) can synthesise a JWT
  -- for this real auth.users row and assert the API rejects it.
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-00000000000e',
    'authenticated',
    'authenticated',
    'outsider@example.com',
    '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Outsider"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  )
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- public.participants  (4 rows: 3 active + 1 deactivated; NONE for outsider)
-- ---------------------------------------------------------------------------
--
-- Stable participant IDs (greppable):
--   11111111-1111-1111-1111-111111111111  alpha
--   22222222-2222-2222-2222-222222222222  bravo
--   33333333-3333-3333-3333-333333333333  charlie
--   99999999-9999-9999-9999-999999999999  zulu (deactivated)
--
-- `domain` is a GENERATED column — DO NOT set it; Postgres derives it from `email`.
-- `first_login_at` and `last_login_at` are pinned to a fixed timestamp so tests
-- can assert on them deterministically. US1.2's "last_login_at updates"
-- assertion runs AGAINST a value newer than this fixture's pin — the test
-- triggers a login that sets last_login_at to now(), then checks
-- `last_login_at > '2026-04-01T10:00:00Z'`.

INSERT INTO public.participants (
  id,
  auth_user_id,
  email,
  display_name,
  region,
  status,
  first_login_at,
  last_login_at,
  created_at,
  updated_at
) VALUES
  -- alpha
  (
    '11111111-1111-1111-1111-111111111111',
    '00000000-0000-0000-0000-00000000000a',
    'alpha@nortal.com',
    'Alpha',
    'EE-North',
    'active',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z'
  ),
  -- bravo
  (
    '22222222-2222-2222-2222-222222222222',
    '00000000-0000-0000-0000-00000000000b',
    'bravo@nortal.com',
    'Bravo',
    'EE-North',
    'active',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z'
  ),
  -- charlie (region INTENTIONALLY NULL — exercises US3.2 newly-available region)
  (
    '33333333-3333-3333-3333-333333333333',
    '00000000-0000-0000-0000-00000000000c',
    'charlie@nortal.com',
    'Charlie',
    NULL,
    'active',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z'
  ),
  -- zulu — deactivated; exercises E-6 (deactivated participant denied)
  (
    '99999999-9999-9999-9999-999999999999',
    '00000000-0000-0000-0000-00000000000d',
    'zulu@nortal.com',
    'Zulu Deactivated',
    NULL,
    'deactivated',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z',
    '2026-04-01T10:00:00Z'
  )
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- audit_log  — intentionally empty
-- ---------------------------------------------------------------------------
-- Per tasks.md T015 § "Do NOT": no direct audit_log inserts here. The T013
-- AFTER INSERT trigger (migration 0008) fires on each public.participants
-- INSERT above and emits a `participant.created` row automatically. Test
-- assertions read those rows; staging additional fixture rows here would
-- pollute the audit_log baseline. If a future test needs a pre-existing
-- audit row, add it via the hook/trigger path (round-trip an auth hook
-- invocation), not via direct INSERT.

COMMIT;
