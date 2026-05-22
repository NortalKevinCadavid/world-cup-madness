-- Slice 003 / T024 / contracts/predictions.write.md § Test surface
--   (row: `submit_prediction_locked_status_in_progress.sql`). RED until T021's
--   supersede SP (slot 0037) is verified to fire the status-locked branch.
--
-- Status-locked path: submit_prediction MUST raise EXCEPTION ERRCODE='WCM02'
-- (match_status_locked) when matches.status <> 'scheduled' (per § Stored
-- procedure semantics step 6). is_prediction_locked() returns TRUE for any
-- non-scheduled status; the SP branches on the underlying reason to pick
-- WCM02 (status) vs WCM01 (window). This file exercises the WCM02 branch
-- via status='in_progress' with a far-future kickoff — proving the status
-- check takes precedence over the time check.
--
-- Fixture choice: synthesize M-IN-PROGRESS with id
-- 'dddd0000-0000-0000-0000-000000000101' (sibling of M-BOUNDARY at slot
-- '100'). Slice 002's M2 (bbbb...0002, CAN-POL in_progress) would also
-- work, but it has charlie's Row 8 seeded against it; using a synthesized
-- match keeps the test self-contained and unaffected by future fixture
-- churn. Kickoff is set far in the future (now() + 24h) to PROVE the
-- status branch fires regardless of time-window state.
--
-- Pattern: BEGIN / plan(2) / throws_ok + count-invariant / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- ---------------------------------------------------------------------------
-- Pre-state: synthesize M-IN-PROGRESS with status='in_progress' and kickoff
-- far in the future. The future kickoff is deliberate: it proves the SP's
-- step-6 branch selects WCM02 based on status alone, not lock-window time.
-- ---------------------------------------------------------------------------
INSERT INTO public.matches (
  id, home_team_id, away_team_id, stage, group_id, kickoff_utc, status
)
SELECT
  'dddd0000-0000-0000-0000-000000000101'::uuid,
  (SELECT id FROM public.teams ORDER BY short_code LIMIT 1),
  (SELECT id FROM public.teams ORDER BY short_code OFFSET 1 LIMIT 1),
  'group'::public.match_stage,
  'A',
  now() + INTERVAL '24 hours',
  'in_progress'::public.match_status
ON CONFLICT (id) DO UPDATE
  SET kickoff_utc = EXCLUDED.kickoff_utc,
      status      = EXCLUDED.status;

-- ---------------------------------------------------------------------------
-- A1: SP raises ERRCODE WCM02 (match_status_locked). The kickoff is +24h —
-- far outside the 60-min lock window — yet the SP rejects because status
-- is no longer 'scheduled'.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.submit_prediction(
       '11111111-1111-1111-1111-111111111111'::uuid,  -- alpha
       'dddd0000-0000-0000-0000-000000000101'::uuid,  -- M-IN-PROGRESS
       1,
       0,
       'ui'
     ) $$,
  'WCM02',
  NULL,
  'A1 submit_prediction raises ERRCODE=WCM02 (match_status_locked) when matches.status = in_progress regardless of kickoff'
);

-- ---------------------------------------------------------------------------
-- A2: no predictions row was created for (alpha, M-IN-PROGRESS).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.predictions
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND match_id       = 'dddd0000-0000-0000-0000-000000000101'::uuid),
  0,
  'A2 no predictions row exists for (alpha, M-IN-PROGRESS) after the rejected SP call'
);

SELECT * FROM finish();

ROLLBACK;
