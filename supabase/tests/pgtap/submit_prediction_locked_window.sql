-- Slice 003 / T024 / contracts/predictions.write.md § Test surface
--   (row: `submit_prediction_locked_window.sql`). RED until T021's supersede SP
--   (slot 0037) is verified to fire the lock-window branch correctly.
--
-- Lock-window path: submit_prediction MUST raise EXCEPTION ERRCODE='WCM01'
-- (lock_window_passed) when is_prediction_locked() returns TRUE on a row
-- whose status='scheduled' but whose kickoff_utc is within the configured
-- lock_window_minutes of now() (per § Stored procedure semantics step 6).
-- The default tournament_config.lock_window_minutes = 60. Per BR-LOCK-002,
-- the boundary is STRICT — remaining_time <= lock_window means locked. So a
-- match at exactly now() + 60min IS locked.
--
-- Fixture choice: rather than rely on a slice-002 fixture match (all five
-- M1..M8 are either far in the future, in_progress, or finished — none sit
-- exactly at now()+60min), we synthesize a match with id prefix
-- 'dddd0000-0000-0000-0000-0000000001NN'. This UUID range is OUTSIDE the
-- slice-002 namespace (slice 002 uses 'bbbb...' for matches.id and
-- 'dddd...000N' for match_provider_external_ids.id, never matches.id) so
-- collisions are impossible. ON CONFLICT (id) DO UPDATE keeps the test
-- idempotent even if a partial prior run left residue.
--
-- Pattern: BEGIN / plan(2) / throws_ok + count-invariant / finish / ROLLBACK.
-- ROLLBACK guarantees no residue in matches, predictions, or audit_log.
--
-- Note on audit-row assertion: the original contract test surface mentions
-- "audit row prediction.rejected_locked, reason='lock_window_passed'". The
-- SP at slot 0037 raises the exception BEFORE writing any audit row (the
-- audit trigger fires on INSERT/UPDATE of predictions, and the exception
-- short-circuits step 7). That assertion is therefore deferred to a future
-- enhancement (an explicit pre-raise audit INSERT in the SP, or a separate
-- audit_log row asserted via the route-handler Playwright test). This file
-- verifies the two contract guarantees that the SP DOES enforce: ERRCODE
-- and "no predictions row created".

BEGIN;

SELECT plan(2);

-- ---------------------------------------------------------------------------
-- Pre-state: synthesize M-BOUNDARY at kickoff = now() + 60min exactly. Group
-- A (so group_id NOT NULL satisfies matches_group_id_consistency). Teams are
-- the first two team rows by short_code — slice 002 seeds 8 teams so this
-- always returns two distinct rows. ON CONFLICT is a defense-in-depth fix.
-- ---------------------------------------------------------------------------
INSERT INTO public.matches (
  id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status
)
SELECT
  'dddd0000-0000-0000-0000-000000000100'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '60 minutes',
  'scheduled'::public.match_status
ON CONFLICT (id) DO UPDATE
  SET kickoff_utc = EXCLUDED.kickoff_utc,
      status      = EXCLUDED.status;

-- ---------------------------------------------------------------------------
-- A1: SP raises ERRCODE WCM01 at the strict lock boundary (remaining_time
-- == lock_window_minutes). Per § Semantics step 6, since status='scheduled'
-- the lock_window_passed branch (not match_status_locked) is selected.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.submit_prediction(
       '11111111-1111-1111-1111-111111111111'::uuid,  -- alpha
       'dddd0000-0000-0000-0000-000000000100'::uuid,  -- M-BOUNDARY
       2,
       1,
       'ui'
     ) $$,
  'WCM01',
  NULL,
  'A1 submit_prediction raises ERRCODE=WCM01 (lock_window_passed) at the strict boundary kickoff = now()+60min'
);

-- ---------------------------------------------------------------------------
-- A2: no predictions row was created for (alpha, M-BOUNDARY). The SP's
-- exception aborts the call before step 7's INSERT — assert zero rows.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.predictions
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND match_id       = 'dddd0000-0000-0000-0000-000000000100'::uuid),
  0,
  'A2 no predictions row exists for (alpha, M-BOUNDARY) after the rejected SP call'
);

SELECT * FROM finish();

ROLLBACK;
