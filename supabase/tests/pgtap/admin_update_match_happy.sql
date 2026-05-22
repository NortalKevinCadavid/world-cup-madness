-- Slice 006 / T027 / US3 / contracts/admin-rpcs.write.md. RED until T030 ships admin_update_match (slot 0065) per D-026.
--
-- Happy path: admin1 updates M1 (slice 005 fixture pre-state status='finished')
-- to status='postponed' WITHOUT changing kickoff_utc. The admin RPC body MUST:
--   1. Pre-flight (admin check + reason + source_citation present).
--   2. Validate at least one of p_new_status / p_new_kickoff_utc is non-NULL.
--   3. Capture v_old_match (row_to_json of matches row).
--   4. Acquire advisory lock per match.
--   5. UPDATE matches SET status = COALESCE(p_new_status, status),
--                         kickoff_utc = COALESCE(p_new_kickoff_utc, kickoff_utc)
--      WHERE id = p_match_id. Slice 002's audit trigger + Slice 003's
--      kickoff-correction-crossed-lock trigger + Slice 004's first-kickoff-
--      correction trigger ALL evaluate their WHEN clauses against the UPDATE.
--   6. Emit ONE audit_log row action='admin.match_updated', entity_type=
--      'match', entity_id=match_id, previous_value/new_value showing the
--      status flip, reason + source_citation passed through, source='admin_rpc'.
--
-- Cross-slice trigger behaviour for STATUS-ONLY update (kickoff unchanged):
--   * Slice 003's `log_kickoff_correction_crossed_lock` trigger (slot 0036):
--     fires AFTER UPDATE OF kickoff_utc WHEN OLD.kickoff_utc IS DISTINCT FROM
--     NEW.kickoff_utc. kickoff is unchanged here, so the trigger MUST NOT
--     fire and no `prediction.kickoff_correction_crossed_lock` audit rows
--     are emitted for M1's predictions. Assert A4 below.
--   * Slice 004's `log_first_kickoff_correction_update` trigger (slot 0046):
--     fires AFTER UPDATE OF kickoff_utc, status WHEN kickoff OR status changed.
--     status DID change ('finished' -> 'postponed'), so this trigger fires
--     conservatively for every active final_prediction. NOT a goal assertion
--     for this file (covered by admin_update_match_kickoff_fans_out.sql);
--     left untested here to keep this file focused on the "kickoff
--     unchanged -> slice 003 does NOT fire" nuance documented in tasks.md
--     T027's body.
--
-- Contract signature (contracts/admin-rpcs.write.md § admin_update_match):
--   public.admin_update_match(
--     p_match_id        uuid,
--     p_new_status      text,         -- nullable; only update if non-null
--     p_new_kickoff_utc timestamptz,  -- nullable; only update if non-null
--     p_reason          text,
--     p_source_citation text
--   ) RETURNS void
--
-- Fixture refs:
--   * admin1                participants.id = 77777777-...-777
--                           auth.users.id   = 00000000-...-d3
--   * M1                    matches.id      = eeee0050-0000-0000-0000-000000000001
--                           pre-state status='finished', kickoff_utc='2026-06-01T20:00:00Z'
--                           (slice 005 fixture).
--   * Active predictions for M1: alpha/bravo/charlie/delta/epsilon/zeta
--     (6 rows, all with superseded_at IS NULL — slice 005 fixture rows
--      eeee0051-000{a..f}-0001-0000-000000000000).

BEGIN;

SELECT plan(4);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t027_match.admin_uid', '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t027_match.admin_pid', '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t027_match.m1',        'eeee0050-0000-0000-0000-000000000001', false);

-- Snapshot baseline admin.match_updated audit count for M1.
SELECT set_config(
  'test.t027_match.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.match_updated'
      AND entity_type = 'match'
      AND entity_id = current_setting('test.t027_match.m1')::uuid),
  false
);

-- Snapshot baseline slice 003 kickoff-correction-crossed-lock audit count
-- across ALL predictions for M1 (we will assert NO new rows after the
-- status-only update).
SELECT set_config(
  'test.t027_match.slice003_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'prediction.kickoff_correction_crossed_lock'
      AND entity_type = 'prediction'
      AND entity_id IN (
        SELECT id FROM public.predictions
         WHERE match_id = current_setting('test.t027_match.m1')::uuid
      )),
  false
);

-- Snapshot the original kickoff_utc so A2 can prove it stayed put.
SELECT set_config(
  'test.t027_match.kickoff_baseline',
  (SELECT kickoff_utc::text FROM public.matches
    WHERE id = current_setting('test.t027_match.m1')::uuid),
  false
);

-- ---------------------------------------------------------------------------
-- Impersonate admin1.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: admin_update_match returns successfully (void; lives_ok passes iff no
-- exception). p_new_kickoff_utc=NULL means kickoff is not changed.
-- ---------------------------------------------------------------------------
SELECT lives_ok(
  $$ SELECT public.admin_update_match(
       'eeee0050-0000-0000-0000-000000000001'::uuid,
       'postponed',
       NULL::timestamptz,
       'severe weather event after match concluded',
       'https://fifa.example/m1-postponed'
     ) $$,
  'A1 admin_update_match returns successfully for status-only update (kickoff NULL)'
);

-- Drop back to superuser to perform the post-state SELECTs.
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: matches.status flipped to 'postponed' AND kickoff_utc unchanged
-- (COALESCE pattern in the contract step 6).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT ROW(status::text, kickoff_utc::text)::text
     FROM public.matches
    WHERE id = current_setting('test.t027_match.m1')::uuid),
  ROW(
    'postponed',
    current_setting('test.t027_match.kickoff_baseline')
  )::text,
  'A2 matches.status flipped to postponed; kickoff_utc unchanged (NULL p_new_kickoff_utc preserved via COALESCE)'
);

-- ---------------------------------------------------------------------------
-- A3: exactly ONE new admin.match_updated audit row for M1 with the locked
-- shape (actor, source, source_citation, reason, previous/new value shapes
-- carrying the status flip).
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.match_updated'
       AND entity_type = 'match'
       AND entity_id = current_setting('test.t027_match.m1')::uuid
       AND actor = current_setting('test.t027_match.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://fifa.example/m1-postponed'
       AND reason = 'severe weather event after match concluded'
       AND previous_value ? 'status'
       AND new_value      ? 'status'
       AND (previous_value->>'status') = 'finished'
       AND (new_value->>'status')      = 'postponed'
  )
  AND (SELECT count(*)::int FROM public.audit_log
        WHERE action = 'admin.match_updated'
          AND entity_type = 'match'
          AND entity_id = current_setting('test.t027_match.m1')::uuid)
      = current_setting('test.t027_match.audit_baseline')::int + 1,
  'A3 exactly one admin.match_updated audit row scoped to M1 with admin1 actor, admin_rpc source, source_citation, reason, and finished->postponed before/after jsonb'
);

-- ---------------------------------------------------------------------------
-- A4: slice 003's `log_kickoff_correction_crossed_lock` trigger (slot 0036)
-- did NOT fire. The trigger is gated on `OLD.kickoff_utc IS DISTINCT FROM
-- NEW.kickoff_utc`; kickoff is unchanged in this call so the WHEN clause is
-- false. No new `prediction.kickoff_correction_crossed_lock` audit rows for
-- M1's predictions. This is the locked cross-slice behaviour the contract
-- relies on (status changes never trip slice 003's fan-out — only kickoff
-- shifts do).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'prediction.kickoff_correction_crossed_lock'
      AND entity_type = 'prediction'
      AND entity_id IN (
        SELECT id FROM public.predictions
         WHERE match_id = current_setting('test.t027_match.m1')::uuid
      )),
  current_setting('test.t027_match.slice003_baseline')::int,
  'A4 slice 003 kickoff-correction-crossed-lock trigger did NOT fire (kickoff unchanged, status-only update)'
);

SELECT * FROM finish();
ROLLBACK;
