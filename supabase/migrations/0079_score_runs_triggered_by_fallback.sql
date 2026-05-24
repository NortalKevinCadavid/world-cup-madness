-- Slice 005 follow-up #5 (2026-05-23) — fix the `triggered_by` write in the
-- score-trigger Edge Function's SP call chain. Source of truth for this fix:
-- specs/005-scoring-leaderboard/follow-up-edge-fn-triggered-by-null.md.
--
-- Background
-- ----------
-- score_calculation_runs.triggered_by is `uuid NOT NULL REFERENCES participants(id)`.
-- The SPs at slots 0052 (score_match), 0053 (score_finals), and 0058 (score_all)
-- write `auth.uid()` directly into that column. Two latent bugs result:
--
--   1. When the SP is invoked via the X-Internal-Auth bypass (service-role
--      client), `auth.uid()` is NULL → the INSERT raises a NOT NULL violation,
--      surfacing as SCORING_FAILED at the Edge Function.
--   2. When the SP is invoked via a real user JWT, `auth.uid()` returns the
--      `auth.users.id`, NOT the participants.id. The FK would reject it
--      unless coincidentally `auth_user_id == participants.id`, which is
--      never the convention. (The admin path at slot 0070 already does the
--      correct lookup — `SELECT id FROM participants WHERE auth_user_id =
--      v_auth_user_id` — so this fix only affects the slot 0052/0053/0058
--      flows; slot 0070's behavior is unchanged.)
--
-- The slot 0052 SP's leading comment acknowledged bug #1 ("triggered_by uses
-- auth.uid(); in pgTAP / direct-SQL contexts this may be NULL, which the
-- score_calculation_runs.triggered_by NOT NULL constraint would reject —
-- runtime verification (T016) covers that path with a real JWT or an
-- admin-seeded system participant fallback.") but the system-participant
-- fallback never shipped.
--
-- Fix
-- ---
-- This migration:
--   (a) Seeds a reserved "WCM Scoring System" participant + matching
--       auth.users row. The IDs are the all-zero UUID, chosen so audit
--       readers can recognize it on sight. status='deactivated' so it does
--       NOT appear on leaderboards (slice 005's leaderboard_v filters to
--       status='active' per its security_invoker predicate).
--   (b) Adds a BEFORE INSERT trigger on score_calculation_runs that
--       canonicalizes `triggered_by`:
--         - if it already references a participants.id → keep as-is (slot
--           0070 admin SP path).
--         - else if it matches a participants.auth_user_id → swap to that
--           participant's id (slot 0052/0053/0058 user-JWT path).
--         - else (NULL or unknown UUID) → fall back to the system
--           participant id (slot 0052/0053/0058 service-role bypass path).
--
-- Why a trigger and not CREATE OR REPLACE on each SP?
-- ---------------------------------------------------
-- Slots 0052/0053/0058 are 397+463+478 = 1,338 lines of SP code total.
-- Re-creating those functions verbatim with a one-line patch each carries
-- significant transcription risk. The trigger approach is small (one helper
-- + one trigger function + one CREATE TRIGGER) and covers every current AND
-- future writer to score_calculation_runs uniformly — including any
-- pg_net / DB-trigger paths that slice 005 deferred (T042).
--
-- Production posture
-- ------------------
-- The system participant is `status='deactivated'` so the eligibility
-- predicate from slice 001 (`is_eligible_nortal_participant`) returns FALSE
-- for it — no leaderboard exposure, no API surface. Its email
-- `system@wcm.internal` uses a domain that will never be on the approved
-- domain list (slice 001's eligibility check would reject any sign-in
-- attempt for this identity). Audit-log readers that filter to a specific
-- actor can recognize the all-zero UUID as "automated scoring trigger;
-- no human actor."
--
-- @see specs/005-scoring-leaderboard/follow-up-edge-fn-triggered-by-null.md
-- @see supabase/migrations/0050_score_calculation_runs.sql (the schema)
-- @see supabase/migrations/0052_score_match_fn.sql line 117 (the latent bug site)
-- @see supabase/migrations/0070_admin_trigger_recalc.sql line 158 (correct lookup pattern)

BEGIN;

-- Skip the on_auth_user_created trigger's auto-provisioning of a participants
-- row for this system identity. We provision it explicitly below with the
-- reserved zero-UUID id; the trigger would race ahead with a freshly-generated
-- uuid and cause a participants_auth_user_id_uk conflict against our INSERT.
-- (Same bypass pattern used by slice-001-fixture.sql.)
SET LOCAL app.skip_auth_provisioning = 'true';

-- ---------------------------------------------------------------------------
-- 1. Seed the system identity in auth.users + participants.
-- ---------------------------------------------------------------------------

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
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'system@wcm.internal',
  -- Same dummy bcrypt as the seed fixtures. Never used for login.
  '$2a$10$abcdefghijklmnopqrstuO5L0p9YqV4xX5o9N4w8H9X6E0P8Q9R1S',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"WCM Scoring System"}'::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
)
ON CONFLICT (id) DO NOTHING;

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
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000000',
  'system@wcm.internal',
  'WCM Scoring System',
  NULL,
  -- 'deactivated' so the eligibility predicate returns FALSE and the
  -- system participant never appears on participant-facing surfaces.
  'deactivated',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Helper: resolve a triggered_by input to a valid participants.id.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_score_run_triggered_by(p_input uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_input IS NOT NULL THEN
    -- (a) Is p_input already a valid participants.id? (slot 0070 path)
    SELECT id INTO v_id
      FROM public.participants
     WHERE id = p_input;
    IF FOUND THEN
      RETURN v_id;
    END IF;

    -- (b) Is p_input an auth.users.id with a matching participant?
    --     (slot 0052/0053/0058 user-JWT path — auth.uid() is the auth_user_id)
    SELECT id INTO v_id
      FROM public.participants
     WHERE auth_user_id = p_input;
    IF FOUND THEN
      RETURN v_id;
    END IF;
  END IF;

  -- (c) NULL or unknown UUID — fall back to the system participant.
  --     (slot 0052/0053/0058 service-role / X-Internal-Auth bypass path)
  RETURN '00000000-0000-0000-0000-000000000000'::uuid;
END;
$$;

COMMENT ON FUNCTION public.resolve_score_run_triggered_by(uuid) IS
  'Slice 005 follow-up #5. Canonicalizes a triggered_by input (auth.uid() or '
  'participants.id) to a valid participants.id, falling back to the reserved '
  'system participant 00000000-0000-0000-0000-000000000000 when no mapping exists.';

-- ---------------------------------------------------------------------------
-- 3. BEFORE INSERT trigger on score_calculation_runs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.score_calc_runs_canonicalize_triggered_by()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.triggered_by := public.resolve_score_run_triggered_by(NEW.triggered_by);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.score_calc_runs_canonicalize_triggered_by() IS
  'Slice 005 follow-up #5. BEFORE INSERT trigger function. Resolves '
  'NEW.triggered_by to a valid participants.id via resolve_score_run_triggered_by, '
  'with system-participant fallback for NULL or unknown UUIDs. Idempotent for '
  'callers (slot 0070 admin recalc) that already pass a valid participants.id.';

DROP TRIGGER IF EXISTS score_calc_runs_canonicalize_triggered_by
  ON public.score_calculation_runs;

CREATE TRIGGER score_calc_runs_canonicalize_triggered_by
  BEFORE INSERT ON public.score_calculation_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.score_calc_runs_canonicalize_triggered_by();

COMMIT;
