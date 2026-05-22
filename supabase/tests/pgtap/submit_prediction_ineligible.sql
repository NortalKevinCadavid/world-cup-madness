-- Slice 003 / T010 / contracts/predictions.write.md § Test surface. RED until T013 ships submit_prediction SP at slot 0034.
--
-- Ineligible path: submit_prediction MUST raise an EXCEPTION with
-- ERRCODE='WCM05' when the caller's participant row is not eligible per
-- public.is_eligible_nortal_participant(auth_user_id) -- i.e.
-- participation_status='deactivated' or the participant's domain has been
-- removed since onboarding. Per § Stored procedure semantics step 4 the SP
-- writes an audit row and raises WCM05.
--
-- Fixture choice: zulu (auth.users 00000000-0000-0000-0000-00000000000d /
-- participants 99999999-9999-9999-9999-999999999999) is seeded by the slice
-- 001 fixture with participation_status='deactivated' precisely for
-- defense-in-depth tests like this one. M4 (MEX-POL scheduled) is a valid
-- eligible-target match -- the SP MUST reject on eligibility BEFORE the
-- match-existence or lock-window checks (per the SP semantics ordering).
--
-- Pattern: BEGIN / plan(2) / throws_ok + count-invariant / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- Snapshot total predictions count BEFORE the SP call so we can assert no
-- row was inserted for zulu.
CREATE TEMP TABLE _before AS
SELECT count(*) AS pred_count FROM public.predictions;

-- A1: SP raises ERRCODE WCM05 when invoked on behalf of a deactivated
-- participant.
SELECT throws_ok(
  $$ SELECT public.submit_prediction(
       '99999999-9999-9999-9999-999999999999'::uuid,
       'bbbb0000-0000-0000-0000-000000000004'::uuid,
       1,
       0,
       'ui'
     ) $$,
  'WCM05',
  NULL,
  'A1 submit_prediction raises ERRCODE=WCM05 when p_participant_id is a deactivated participant (zulu)'
);

-- A2: predictions row count unchanged -- no row inserted for zulu on M4 or
-- anywhere. We also assert specifically that zulu has zero predictions
-- after the failed call (zulu has none in any fixture).
SELECT is(
  (SELECT count(*) FROM public.predictions),
  (SELECT pred_count FROM _before),
  'A2 predictions row count is unchanged after the rejected SP call'
);

SELECT * FROM finish();

ROLLBACK;
