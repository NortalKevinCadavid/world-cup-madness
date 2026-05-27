-- ============================================================================
-- slice-010-status-fn.sql  — Slice 010 / T026 (pgTAP)
-- ============================================================================
-- Verifies public.bracket_status (migration 0087 / FR-014) is the single
-- progress source of truth: total_required=31, correct completed/missing for a
-- partial fixture, is_complete only at 31, and the submission_status precedence
-- draft → complete → submitted → locked.
--
-- Runs as superuser (RLS bypassed). bracket_status filters bracket_picks by its
-- p_participant_id parameter, so it is correct without impersonation. Uses bravo
-- (22222222-…) on a cleaned slate. Outer ROLLBACK undoes all mutations.
-- ============================================================================

BEGIN;
SELECT plan(7);

SELECT set_config('test.s010sf.bravo', '22222222-2222-2222-2222-222222222222', false);
SELECT set_config('test.s010sf.team',  'cccc0010-0000-0000-0000-000000000001', false);

-- Clean slate for bravo.
DELETE FROM public.bracket_submissions WHERE participant_id = current_setting('test.s010sf.bravo')::uuid;
DELETE FROM public.bracket_picks       WHERE participant_id = current_setting('test.s010sf.bravo')::uuid;

-- A1: total_required is the full tree size (31).
SELECT is(
  (SELECT total_required FROM public.bracket_status(current_setting('test.s010sf.bravo')::uuid)),
  31,
  'A1 total_required = 31'
);

-- A2: empty bracket → completed 0, not complete, draft.
SELECT is(
  (SELECT ROW(completed, is_complete, submission_status)::text
     FROM public.bracket_status(current_setting('test.s010sf.bravo')::uuid)),
  ROW(0, false, 'draft')::text,
  'A2 empty bracket → 0 / incomplete / draft'
);

-- Insert 30 of 31 picks (skip the Final).
INSERT INTO public.bracket_picks (participant_id, matchup_id, winner_team_id)
SELECT current_setting('test.s010sf.bravo')::uuid, m.id, current_setting('test.s010sf.team')::uuid
  FROM public.bracket_matchups m
 WHERE m.id <> 'dddd0001-0000-0000-0000-000000000001';

-- A3: 30/31 → still incomplete; exactly one matchup missing.
SELECT is(
  (SELECT ROW(completed, is_complete, array_length(missing_matchup_ids, 1))::text
     FROM public.bracket_status(current_setting('test.s010sf.bravo')::uuid)),
  ROW(30, false, 1)::text,
  'A3 30/31 → incomplete, one missing'
);

-- Add the 31st (the Final).
INSERT INTO public.bracket_picks (participant_id, matchup_id, winner_team_id)
VALUES (current_setting('test.s010sf.bravo')::uuid,
        'dddd0001-0000-0000-0000-000000000001',
        current_setting('test.s010sf.team')::uuid);

-- A4: 31/31 → complete; status 'complete' (no submission, lock in future).
SELECT is(
  (SELECT ROW(completed, is_complete, submission_status)::text
     FROM public.bracket_status(current_setting('test.s010sf.bravo')::uuid)),
  ROW(31, true, 'complete')::text,
  'A4 31/31 → complete'
);

-- Record a submission → status precedence makes it 'submitted'.
INSERT INTO public.bracket_submissions (participant_id, submission_status, submitted_at, version)
VALUES (current_setting('test.s010sf.bravo')::uuid, 'submitted', now(), 1);

SELECT is(
  (SELECT submission_status FROM public.bracket_status(current_setting('test.s010sf.bravo')::uuid)),
  'submitted',
  'A5 submission row → submitted'
);

-- Move the lock into the past → precedence locked > submitted.
UPDATE public.tournament_config SET value = to_jsonb('2020-01-01T00:00:00Z'::text)
 WHERE key = 'first_kickoff_utc';

SELECT is(
  (SELECT submission_status FROM public.bracket_status(current_setting('test.s010sf.bravo')::uuid)),
  'locked',
  'A6 past lock → locked (precedence over submitted)'
);

-- A7: is_complete stays true even when locked.
SELECT is(
  (SELECT is_complete FROM public.bracket_status(current_setting('test.s010sf.bravo')::uuid)),
  true,
  'A7 locked + 31 picks → still is_complete'
);

SELECT * FROM finish();
ROLLBACK;
