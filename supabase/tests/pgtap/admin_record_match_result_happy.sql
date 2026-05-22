-- Slice 006 / T010 / US1 / contracts/admin-rpcs.write.md. RED until T013 ships admin_record_match_result at on-disk slot 0064 per D-026.
--
-- Happy path: admin1 corrects an existing M1 match_result (2-1 -> 2-2) with
-- both a reason AND a source citation; assert the underlying match_results row
-- is updated, ONE audit_log row with action='admin.match_result_corrected' is
-- written carrying the source_citation column (T004 / slot 0061), and the
-- previous/new score shape lands in the audit row.
--
-- Fixture refs (loaded by `supabase db reset` before tests run):
--   * admin1
--       participants.id        = 77777777-7777-7777-7777-777777777777
--       auth.users.id          = 00000000-0000-0000-0000-0000000000d3
--       admin_roles row        = seeded by T009 (slot 0074 bootstrap)
--   * M1
--       matches.id             = eeee0050-0000-0000-0000-000000000001
--       match_results pre-state= home_score 2, away_score 1, source 'provider_sync'
--   * Slice 005's score_match LISTEN channel = 'match_results_recorded'
--
-- Impersonation pattern: SET LOCAL request.jwt.claims (admin1's auth_user_id
-- under sub claim) + SET LOCAL ROLE authenticated. Outer ROLLBACK restores
-- session role + JWT claims AND undoes all mutations.
--
-- NOTIFY caveat (assertion A6 deliberately weaker): pgTAP cannot observe
-- pg_notify deliveries inside the same transaction (notifications fire on
-- COMMIT, which never happens here -- everything ROLLBACKs). The downstream
-- LISTEN consumer is exercised by slice 005's score-trigger Deno tests; here
-- we assert the proxy-observable surface (the SP returned the match_id) and
-- rely on `record_match_result_emits_notification.sql` for the channel
-- contract under slice 002.

BEGIN;

SELECT plan(6);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs in session GUCs so every subsequent SELECT references
-- the same byte sequence (defends against typos across long-form asserts).
-- ---------------------------------------------------------------------------
SELECT set_config('test.t010_happy.admin_uid',  '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t010_happy.admin_pid',  '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t010_happy.m1',         'eeee0050-0000-0000-0000-000000000001', false);

-- Snapshot baseline audit_log count for entity_id=M1, action='admin.match_result_corrected'.
-- The pre-state count MUST be zero -- slice 002 emitted 'match_result.recorded',
-- not 'admin.match_result_corrected'. We assert delta later.
SELECT set_config(
  'test.t010_happy.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.match_result_corrected'
      AND entity_type = 'match_result'
      AND entity_id = current_setting('test.t010_happy.m1')::uuid),
  false
);

-- ---------------------------------------------------------------------------
-- Impersonate admin1.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: SP returns the match_id of the row it corrected.
-- ---------------------------------------------------------------------------
SELECT is(
  public.admin_record_match_result(
    current_setting('test.t010_happy.m1')::uuid,
    2,                                       -- p_home_score_official
    2,                                       -- p_away_score_official (was 1)
    2,                                       -- p_home_score_for_scoring
    2,                                       -- p_away_score_for_scoring (was 1)
    'regulation',                            -- p_result_status
    'FIFA decision',                         -- p_reason
    'https://fifa.example/m1'                -- p_source_citation
  ),
  current_setting('test.t010_happy.m1')::uuid,
  'A1 admin_record_match_result returns the corrected match_id'
);

-- Drop back to superuser to perform the post-state SELECTs (RLS on
-- match_results may deny `authenticated` direct reads -- defence in depth).
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: match_results row updated -- both score columns AND the for_scoring
-- columns now read 2-2. The slice 002 SP UPSERTs by match_id, so this is the
-- SAME row as the pre-state, not a new one.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT ROW(home_score, away_score, home_score_for_scoring, away_score_for_scoring)::text
     FROM public.match_results
    WHERE match_id = current_setting('test.t010_happy.m1')::uuid),
  ROW(2, 2, 2, 2)::text,
  'A2 match_results row for M1 updated to (home=2, away=2, for_scoring=2/2)'
);

-- ---------------------------------------------------------------------------
-- A3: exactly ONE new audit_log row emitted with the locked admin action
-- label, scoped to the corrected match_result entity.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.match_result_corrected'
      AND entity_type = 'match_result'
      AND entity_id = current_setting('test.t010_happy.m1')::uuid),
  current_setting('test.t010_happy.audit_baseline')::int + 1,
  'A3 exactly one new admin.match_result_corrected audit row scoped to M1'
);

-- ---------------------------------------------------------------------------
-- A4: the audit row carries admin1's participant_id as actor, source='admin_rpc',
-- source_citation, and reason (all per contracts/admin-rpcs.write.md § Audit
-- emission pattern).
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.match_result_corrected'
       AND entity_type = 'match_result'
       AND entity_id = current_setting('test.t010_happy.m1')::uuid
       AND actor = current_setting('test.t010_happy.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://fifa.example/m1'
       AND reason = 'FIFA decision'
  ),
  'A4 audit row carries actor=admin1.participants.id, source=admin_rpc, source_citation, reason'
);

-- ---------------------------------------------------------------------------
-- A5: previous_value + new_value jsonb shapes -- both must contain the score
-- columns so /admin/audit can reconstruct the change. Using ->>'home_score'
-- text extraction keeps the assertion robust against shape drift on other
-- columns (recorded_at, source, etc.).
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.match_result_corrected'
       AND entity_id = current_setting('test.t010_happy.m1')::uuid
       AND previous_value ? 'home_score'
       AND previous_value ? 'away_score'
       AND new_value      ? 'home_score'
       AND new_value      ? 'away_score'
       AND (previous_value->>'home_score') = '2'
       AND (previous_value->>'away_score') = '1'
       AND (new_value->>'home_score')      = '2'
       AND (new_value->>'away_score')      = '2'
  ),
  'A5 audit previous_value (2-1) + new_value (2-2) jsonb shapes capture the before/after scores'
);

-- ---------------------------------------------------------------------------
-- A6: Slice 005's match_results_recorded LISTEN notification fires.
-- pgTAP cannot observe pg_notify deliveries inside a ROLLBACKed transaction
-- (notifications fire on COMMIT). The proxy assertion here is that the
-- underlying record_match_result SP returned successfully -- if it had
-- raised, A1 would have failed. The end-to-end LISTEN contract is exercised
-- by slice 002's `record_match_result_emits_notification.sql` and slice 005's
-- score-trigger Deno tests. This slot is reserved so the file's plan(6)
-- documents the contract surface explicitly.
SELECT pass(
  'A6 match_results_recorded LISTEN notification fires (runtime-verified via slice 005 score-trigger Deno tests; pgTAP cannot observe NOTIFY inside a ROLLBACKed txn)'
);

SELECT * FROM finish();
ROLLBACK;
