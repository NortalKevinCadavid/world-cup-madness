-- Slice 006 / T027 / US3 / contracts/admin-rpcs.write.md. RED until T030 ships admin_update_tournament_award (slot 0068) + admin_update_match (slot 0065) per D-026.
--
-- Happy path: admin1 updates the tournament_award.top_scorer from Messi
-- (slice 005 fixture pre-state, status='confirmed') to Vinícius and keeps
-- status='confirmed'. The admin RPC body MUST:
--   1. Pre-flight (admin check + reason + source_citation present).
--   2. Capture v_old_award (row_to_json of the single tournament_award row).
--   3. UPDATE the appropriate *_player_id + *_status columns for p_item_kind
--      = 'top_scorer' and set set_by = admin1's participants.id.
--   4. Emit ONE audit_log row action='admin.award_updated', entity_type=
--      'tournament_award', entity_id = tournament_id, previous_value =
--      v_old_award (Messi present), new_value = post-state (Vinícius
--      present), reason + source_citation passed through, source='admin_rpc'.
--   5. Slice 005's BEFORE UPDATE trigger (slot 0051 — tournament_award_set_at
--      _before_update) fires automatically because top_scorer_player_id
--      IS DISTINCT FROM NEW.top_scorer_player_id, bumping set_at to now().
--   6. Slice 005's `award_confirmed_trigger` (the future T015 AFTER UPDATE
--      auto-recalc wiring referenced in slot 0051's header) MUST fire the
--      score-trigger Edge Function with scope='finals'. pgTAP cannot observe
--      the pg_net.http_post dispatch inside a ROLLBACKed transaction
--      (pg_net queues fire on COMMIT — same caveat as
--      admin_record_match_result_happy.sql § A6). The proxy assertion below
--      checks the slot 0051 BEFORE UPDATE trigger observably fired (set_at
--      was bumped to a fresh now()); the auto-recalc fan-out itself is
--      exercised by slice 005's score-trigger Deno tests
--      (auto_trigger_award_confirm.test.ts).
--
-- Contract signature (contracts/admin-rpcs.write.md § admin_update_tournament_award):
--   public.admin_update_tournament_award(
--     p_item_kind        text,        -- 'champion'|'runner_up'|'top_scorer'|'best_player'
--     p_new_team_id      uuid,        -- non-NULL for champion/runner_up; NULL here
--     p_new_player_id    uuid,        -- non-NULL for top_scorer/best_player
--     p_new_status       text,        -- 'pending'|'confirmed'
--     p_reason           text,
--     p_source_citation  text
--   ) RETURNS void
-- There is NO p_tournament_id parameter — the table is single-row-per-tournament
-- so the SP body locates the row implicitly (or asserts only one row exists).
--
-- Fixture refs (loaded by `supabase db reset` before tests run):
--   * admin1
--       participants.id        = 77777777-7777-7777-7777-777777777777
--       auth.users.id          = 00000000-0000-0000-0000-0000000000d3
--   * Tournament award (slice 005 fixture, slot 0051):
--       tournament_id          = 00000000-0000-0000-0000-000000000001
--       top_scorer_player_id   = dddd1000-0000-0000-0000-000000000001  (Messi)
--       top_scorer_status      = 'confirmed'
--   * Vinícius                 = dddd1000-0000-0000-0000-000000000011  (BRA FW)
--
-- Impersonation pattern: SET LOCAL request.jwt.claims (admin1's auth_user_id
-- under sub claim) + SET LOCAL ROLE authenticated. Outer ROLLBACK restores
-- session role + JWT claims AND undoes all mutations.

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Stash fixture UUIDs in session GUCs so every subsequent SELECT references
-- the same byte sequence.
-- ---------------------------------------------------------------------------
SELECT set_config('test.t027_award.admin_uid', '00000000-0000-0000-0000-0000000000d3', false);
SELECT set_config('test.t027_award.admin_pid', '77777777-7777-7777-7777-777777777777', false);
SELECT set_config('test.t027_award.tid',       '00000000-0000-0000-0000-000000000001', false);
SELECT set_config('test.t027_award.messi',     'dddd1000-0000-0000-0000-000000000001', false);
SELECT set_config('test.t027_award.vinicius',  'dddd1000-0000-0000-0000-000000000011', false);

-- Snapshot baseline audit count for action='admin.award_updated' scoped to
-- this tournament. Pre-state MUST be zero: slice 005 fixture (slot 0051)
-- does not emit any 'admin.award_updated' rows; the action label is owned by
-- this slice (contract § Audit action labels — LOCKED).
SELECT set_config(
  'test.t027_award.audit_baseline',
  (SELECT count(*)::text FROM public.audit_log
    WHERE action = 'admin.award_updated'
      AND entity_type = 'tournament_award'
      AND entity_id = current_setting('test.t027_award.tid')::uuid),
  false
);

-- Snapshot baseline set_at so A5 can prove the slot 0051 BEFORE UPDATE
-- trigger fired (i.e. the UPDATE statement reached the table and the
-- (id, status) IS DISTINCT FROM check inside tournament_award_set_at_trigger
-- detected a tracked-column change).
SELECT set_config(
  'test.t027_award.set_at_baseline',
  (SELECT set_at::text FROM public.tournament_award
    WHERE tournament_id = current_setting('test.t027_award.tid')::uuid),
  false
);

-- ---------------------------------------------------------------------------
-- Impersonate admin1.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d3","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- A1: admin_update_tournament_award completes without exception.
-- Returns void, so we wrap in lives_ok which passes iff no exception raised.
-- ---------------------------------------------------------------------------
SELECT lives_ok(
  $$ SELECT public.admin_update_tournament_award(
       'top_scorer',
       NULL::uuid,
       'dddd1000-0000-0000-0000-000000000011'::uuid,
       'confirmed',
       'Golden Boot reassigned per FIFA technical committee',
       'https://fifa.example/golden-boot-2026'
     ) $$,
  'A1 admin_update_tournament_award returns successfully for top_scorer kind'
);

-- Drop back to superuser to perform the post-state SELECTs (defence in depth
-- against any RLS that may deny `authenticated` direct tournament_award
-- reads).
RESET ROLE;

-- ---------------------------------------------------------------------------
-- A2: tournament_award.top_scorer_player_id updated to Vinícius; status
-- remains 'confirmed'. The four other items (champion, runner_up,
-- best_player) MUST NOT be touched by an update of kind='top_scorer'.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT ROW(top_scorer_player_id, top_scorer_status::text,
              champion_team_id, runner_up_team_id, best_player_player_id)::text
     FROM public.tournament_award
    WHERE tournament_id = current_setting('test.t027_award.tid')::uuid),
  ROW(
    current_setting('test.t027_award.vinicius')::uuid,
    'confirmed',
    'aaaa0000-0000-0000-0000-000000000001'::uuid,  -- champion ARG unchanged
    'aaaa0000-0000-0000-0000-000000000005'::uuid,  -- runner_up ESP unchanged
    NULL::uuid                                      -- best_player still pending/NULL
  )::text,
  'A2 top_scorer_player_id flipped Messi -> Vinícius, status stays confirmed, sibling items untouched'
);

-- ---------------------------------------------------------------------------
-- A3: exactly ONE new audit row with locked admin action label, scoped to
-- the tournament's tournament_award entity_id.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE action = 'admin.award_updated'
      AND entity_type = 'tournament_award'
      AND entity_id = current_setting('test.t027_award.tid')::uuid),
  current_setting('test.t027_award.audit_baseline')::int + 1,
  'A3 exactly one new admin.award_updated audit row scoped to the tournament'
);

-- ---------------------------------------------------------------------------
-- A4: audit row shape -- actor=admin1's participants.id, source='admin_rpc',
-- source_citation + reason passed through, AND previous_value carries Messi
-- while new_value carries Vinícius (so /admin/audit can reconstruct the
-- change).
-- ---------------------------------------------------------------------------
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_log
     WHERE action = 'admin.award_updated'
       AND entity_type = 'tournament_award'
       AND entity_id = current_setting('test.t027_award.tid')::uuid
       AND actor = current_setting('test.t027_award.admin_pid')::uuid
       AND source = 'admin_rpc'
       AND source_citation = 'https://fifa.example/golden-boot-2026'
       AND reason = 'Golden Boot reassigned per FIFA technical committee'
       AND previous_value ? 'top_scorer_player_id'
       AND new_value      ? 'top_scorer_player_id'
       AND (previous_value->>'top_scorer_player_id') = current_setting('test.t027_award.messi')
       AND (new_value->>'top_scorer_player_id')      = current_setting('test.t027_award.vinicius')
  ),
  'A4 audit row carries admin1 actor + admin_rpc source + reason + source_citation + Messi/Vinícius before/after jsonb'
);

-- ---------------------------------------------------------------------------
-- A5: slice 005's slot-0051 BEFORE UPDATE trigger fired -- set_at advanced
-- past baseline. This is the observable proxy for the broader auto-recalc
-- wiring (the AFTER UPDATE `score-trigger` invocation owned by future
-- migration T015 in slice 005's roadmap, referenced from slot 0051's
-- header). pgTAP cannot observe pg_net.http_post deliveries inside a
-- ROLLBACKed transaction; pg_net's queue fires on COMMIT, and this test
-- rolls back. The end-to-end auto-recalc fan-out is exercised by slice
-- 005's score-trigger Deno test `auto_trigger_award_confirm.test.ts`.
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT set_at FROM public.tournament_award
    WHERE tournament_id = current_setting('test.t027_award.tid')::uuid)
    > current_setting('test.t027_award.set_at_baseline')::timestamptz,
  'A5 slice 005 BEFORE UPDATE trigger fired (set_at bumped past baseline); score-trigger pg_net dispatch exercised by score-trigger Deno tests (cannot observe NOTIFY/pg_net inside ROLLBACKed txn)'
);

SELECT * FROM finish();
ROLLBACK;
