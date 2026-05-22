-- Slice 006 / T027 / US3 / contracts/admin-rpcs.write.md. RED until T030 ships admin_update_match (slot 0065) per D-026.
--
-- Kickoff-correction fan-out: admin1 updates M1's kickoff_utc (status left
-- unchanged) and BOTH slice 003's per-active-prediction kickoff fan-out
-- AND slice 004's per-active-final_prediction first_kickoff_correction
-- fan-out must fire as a consequence of the single UPDATE statement the
-- admin RPC issues.
--
-- The admin RPC body MUST (contracts/admin-rpcs.write.md § admin_update_match):
--   1. Pre-flight (admin + reason + source_citation).
--   2. Validate at least one of p_new_status / p_new_kickoff_utc is non-NULL.
--   3. Capture v_old_match.
--   4. Advisory lock per match.
--   5. UPDATE matches SET status = COALESCE(p_new_status, status),
--                         kickoff_utc = COALESCE(p_new_kickoff_utc, kickoff_utc).
--      All three of slice 002's audit trigger, slice 003's
--      log_kickoff_correction_crossed_lock (slot 0036), and slice 004's
--      log_first_kickoff_correction_update (slot 0046) fire automatically
--      from this single UPDATE.
--   6. Emit admin.match_updated audit row.
--
-- Cross-slice trigger behaviour for KICKOFF update (status unchanged):
--   * Slice 003 trigger fires (AFTER UPDATE OF kickoff_utc, WHEN
--       OLD.kickoff_utc IS DISTINCT FROM NEW.kickoff_utc). It emits one
--       audit_log row per ACTIVE prediction for the changed match
--       (predictions.superseded_at IS NULL AND match_id = NEW.id), with
--       action='prediction.kickoff_correction_crossed_lock' (locked label
--       per slot 0036).
--   * Slice 004 trigger fires (AFTER UPDATE OF kickoff_utc, status, WHEN
--       OLD.kickoff_utc IS DISTINCT FROM NEW.kickoff_utc OR
--       OLD.status      IS DISTINCT FROM NEW.status). The slot 0046 trigger
--       emits CONSERVATIVELY: one audit_log row per active final_prediction
--       in the system (NOT just final_predictions tied to this match),
--       because first_kickoff_utc is a tournament-wide derived value. The
--       action label is `final_prediction.first_kickoff_correction` per
--       slot 0046.
--
-- Contract signature (same as admin_update_match_happy.sql):
--   public.admin_update_match(p_match_id, p_new_status, p_new_kickoff_utc,
--                             p_reason, p_source_citation) RETURNS void
--
-- Fixture refs:
--   * admin1                = participants 77...77 / auth 00...d3
--   * M1                    = eeee0050-0000-0000-0000-000000000001
--                             pre-state kickoff_utc='2026-06-01T20:00:00Z',
--                             status='finished' (slice 005 fixture).
--   * Active predictions for M1 (slice 005 fixture): 6 rows for participants
--     alpha..zeta, all with superseded_at IS NULL.
--   * Active final_predictions (slice 004 + 005 fixtures combined): 12 rows
--     total (6 from slice 004, 6 from slice 005); all superseded_at IS NULL.
-- New kickoff: shift M1 forward by 1 day to 2026-06-02T20:00:00Z. This is
-- distinct from the slice 005 fixture's other matches (M2 is at exactly
-- 2026-06-02T20:00:00Z too — that's fine, kickoff_utc has no uniqueness
-- constraint and the fan-out only inspects OLD vs NEW for M1's row).

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs + the new kickoff string.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t027_kick.admin_uid',   '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t027_kick.admin_pid',   '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t027_kick.m1',          'eeee0050-0000-0000-0000-000000000001', false);
SELECT set_config('test.t027_kick.new_kickoff', '2026-06-02T20:00:00Z', false);

-- Pre-state kickoff (slice 005 fixture seeded this as '2026-06-01T20:00:00Z').
-- Stored as text via ::text so timestamptz string-comparison is stable.
SELECT set_config(
  'test.t027_kick.old_kickoff',
  (SELECT kickoff_utc::text FROM public.matches
    WHERE id = current_setting('test.t027_kick.m1')::uuid),
  false
);

-- Snapshot: count of ACTIVE predictions tied to M1 -- the slice 003 trigger
-- emits exactly one audit row per such prediction.
SELECT set_config(
  'test.t027_kick.active_pred_count',
  (SELECT count(*)::text FROM public.predictions
    WHERE match_id = current_setting('test.t027_kick.m1')::uuid
      AND superseded_at IS NULL),
  false
);

-- Snapshot: count of ACTIVE final_predictions tournament-wide -- the slice
-- 004 trigger emits one audit row per active final_prediction regardless
-- of which match changed (it's tournament-scoped: first_kickoff_utc is
-- min(kickoff_utc) across scheduled matches).
SELECT set_config(
  'test.t027_kick.active_final_count',
  (SELECT count(*)::text FROM public.final_predictions
    WHERE superseded_at IS NULL),
  false
);

-- Baseline audit counts BEFORE the admin RPC call, for both fan-out actions
-- and the admin.match_updated row.
SELECT set_config(
  'test.t027_kick.slice003_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'prediction.kickoff_correction_crossed_lock'
      AND entity_type = 'prediction'
      AND entity_id IN (
        SELECT id FROM public.predictions
         WHERE match_id = current_setting('test.t027_kick.m1')::uuid
           AND superseded_at IS NULL
      )),
  false
);

SELECT set_config(
  'test.t027_kick.slice004_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'final_prediction.first_kickoff_correction'
      AND entity_type = 'final_prediction'),
  false
);

SELECT set_config(
  'test.t027_kick.admin_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.match_updated'
      AND entity_type = 'match'
      AND entity_id = current_setting('test.t027_kick.m1')::uuid),
  false
);

-- ---------------------------------------------------------------------------
-- Impersonate admin1.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: admin_update_match returns successfully (kickoff-only update;
-- p_new_status=NULL preserves matches.status via COALESCE).
-- ---------------------------------------------------------------------------
SELECT lives_ok(
  $$ SELECT public.admin_update_match(
       'eeee0050-0000-0000-0000-000000000001'::uuid,
       NULL::text,
       '2026-06-02T20:00:00Z'::timestamptz,
       'fixture rescheduled by host city',
       'https://fifa.example/m1-reschedule'
     ) $$,
  'A1 admin_update_match returns successfully for kickoff-only update (status NULL)'
);

-- Drop back to superuser to perform the post-state SELECTs.
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: matches.kickoff_utc updated to the new value.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT kickoff_utc::text FROM public.matches
    WHERE id = current_setting('test.t027_kick.m1')::uuid),
  current_setting('test.t027_kick.new_kickoff')::timestamptz::text,
  'A2 matches.kickoff_utc updated to the new admin-supplied value'
);

-- ---------------------------------------------------------------------------
-- A3: slice 003's `log_kickoff_correction_crossed_lock` trigger fan-out
-- emitted exactly N rows, where N = active predictions for M1. The trigger
-- uses `WHERE p.match_id = NEW.id AND p.superseded_at IS NULL` (slot 0036
-- line ~30) so the delta MUST equal the active-prediction count.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'prediction.kickoff_correction_crossed_lock'
      AND entity_type = 'prediction'
      AND entity_id IN (
        SELECT id FROM public.predictions
         WHERE match_id = current_setting('test.t027_kick.m1')::uuid
           AND superseded_at IS NULL
      )),
  current_setting('test.t027_kick.slice003_baseline')::int
    + current_setting('test.t027_kick.active_pred_count')::int,
  'A3 slice 003 fan-out emitted one prediction.kickoff_correction_crossed_lock row per active prediction tied to M1'
);

-- ---------------------------------------------------------------------------
-- A4: slice 004's `log_first_kickoff_correction_update` trigger fan-out
-- emitted exactly M rows, where M = active final_predictions tournament-
-- wide. The slot 0046 function uses
-- `FROM public.final_predictions fp WHERE fp.superseded_at IS NULL` (no
-- match filter) because first_kickoff_utc is tournament-scoped.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'final_prediction.first_kickoff_correction'
      AND entity_type = 'final_prediction'),
  current_setting('test.t027_kick.slice004_baseline')::int
    + current_setting('test.t027_kick.active_final_count')::int,
  'A4 slice 004 fan-out emitted one final_prediction.first_kickoff_correction row per active final_prediction (tournament-scoped, not match-scoped)'
);

-- ---------------------------------------------------------------------------
-- A5: admin.match_updated audit row carries the kickoff change in
-- previous_value / new_value jsonb shapes, plus admin_rpc source + the
-- supplied reason + source_citation. Exactly ONE new row scoped to M1.
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.match_updated'
       AND entity_type = 'match'
       AND entity_id = current_setting('test.t027_kick.m1')::uuid
       AND actor = current_setting('test.t027_kick.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://fifa.example/m1-reschedule'
       AND reason = 'fixture rescheduled by host city'
       AND previous_value ? 'kickoff_utc'
       AND new_value      ? 'kickoff_utc'
       AND (previous_value->>'kickoff_utc')::timestamptz
             = current_setting('test.t027_kick.old_kickoff')::timestamptz
       AND (new_value->>'kickoff_utc')::timestamptz
             = current_setting('test.t027_kick.new_kickoff')::timestamptz
  )
  AND (SELECT count(*)::int FROM public.audit_log
        WHERE action = 'admin.match_updated'
          AND entity_type = 'match'
          AND entity_id = current_setting('test.t027_kick.m1')::uuid)
      = current_setting('test.t027_kick.admin_baseline')::int + 1,
  'A5 exactly one admin.match_updated row for M1 carrying old/new kickoff_utc in jsonb + admin1 actor + admin_rpc source + reason + source_citation'
);

SELECT * FROM finish();
ROLLBACK;
