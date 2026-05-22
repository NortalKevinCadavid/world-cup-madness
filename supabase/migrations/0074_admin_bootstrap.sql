-- Slice 006 / T009 / FR-009 + FR-014 / data-model.md § Bootstrap.
-- Migration slot 0074 per D-026.
-- Bootstraps an admin role for the participant whose email matches config key
-- `admin.bootstrap_participant_email` (default 'admin1@nortal.com', set via INSERT ON CONFLICT DO NOTHING).
-- Idempotent: skips if no participant exists OR if the participant already has an active admin_role.
-- Production deploys without the fixture seed (e.g., fresh prod environment) silently no-op until
-- a human INSERTs the participants row + reruns this migration (or uses Slice 008's admin-assignment UI).
-- The INSERT runs as migration superuser, bypassing admin_roles RLS by design.
-- This is the ONLY admin_roles row seeded by migration; Slice 008 ships the assignment UI for all others.

BEGIN;

-- Step 1: ensure the config key exists with a default value
INSERT INTO public.tournament_config (key, value, updated_at)
VALUES ('admin.bootstrap_participant_email', '"admin1@nortal.com"'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Step 2: conditional bootstrap insert
-- Runs as migration superuser -> bypasses admin_roles RLS.
-- Lookup participant by configured email; if found and no active admin_role, INSERT.
DO $$
DECLARE
  v_email text;
  v_participant_id uuid;
BEGIN
  -- Read email from config (cast jsonb string)
  SELECT value #>> '{}' INTO v_email
    FROM public.tournament_config
   WHERE key = 'admin.bootstrap_participant_email';

  IF v_email IS NULL OR v_email = '' THEN
    RAISE NOTICE 'admin bootstrap: no email configured, skipping';
    RETURN;
  END IF;

  -- Lookup participant
  SELECT id INTO v_participant_id
    FROM public.participants
   WHERE email = v_email
     AND status = 'active'
   LIMIT 1;

  IF v_participant_id IS NULL THEN
    RAISE NOTICE 'admin bootstrap: no active participant for email %, skipping (production deploy without fixture is OK)', v_email;
    RETURN;
  END IF;

  -- Idempotency: skip if active admin_role already exists
  IF EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE participant_id = v_participant_id
       AND revoked_at IS NULL
  ) THEN
    RAISE NOTICE 'admin bootstrap: participant % already has an active admin_role, skipping', v_participant_id;
    RETURN;
  END IF;

  -- Bootstrap insert
  INSERT INTO public.admin_roles (participant_id, granted_at, granted_by, revoked_at, revoked_by, revoke_reason)
  VALUES (v_participant_id, now(), NULL, NULL, NULL, NULL);

  RAISE NOTICE 'admin bootstrap: granted admin role to participant % (email %)', v_participant_id, v_email;
END $$;

COMMIT;
