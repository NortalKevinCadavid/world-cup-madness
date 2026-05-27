-- ============================================================================
-- slice-010-peer-view-rls.sql  — Slice 010 / T033 (pgTAP)
-- ============================================================================
-- Verifies public.bracket_peer_v (migration 0091 / FR-017,FR-018,FR-019, R-002):
--   A1  pre-lock → zero rows for ANY target (non-leak; the lock gate hides all)
--   A2  post-lock → the peer's full 31-matchup tree is visible
--   A3  self-exclusion: the caller never sees their own participant_id
--   A4  DEFINER posture (security_invoker NOT true) — required so the cross-
--       participant read does not collapse under bracket_picks self-RLS
--   A5  post-lock, no returned row carries the caller's participant_id
--
-- Impersonates alpha (auth uid …000a, participant 1111…). bravo (2222…) has a
-- seeded pick so it surfaces as a peer post-lock. Config (first_kickoff_utc) is
-- mutated as superuser between phases. Outer ROLLBACK restores everything.
-- ============================================================================

BEGIN;
SELECT plan(5);

SELECT set_config('test.s010pv.alpha_uid', '00000000-0000-0000-0000-00000000000a', false);
SELECT set_config('test.s010pv.alpha_pid', '11111111-1111-1111-1111-111111111111', false);
SELECT set_config('test.s010pv.bravo_pid', '22222222-2222-2222-2222-222222222222', false);

-- A4: DEFINER posture (checked as superuser; independent of lock phase).
SELECT ok(
  NOT ('security_invoker=true' = ANY (COALESCE(
    (SELECT c.reloptions FROM pg_class c WHERE c.relname = 'bracket_peer_v'),
    ARRAY[]::text[]))),
  'A4 bracket_peer_v is DEFINER (security_invoker is not true)'
);

-- ---- Phase 1: PRE-LOCK (first kickoff in the future) ----------------------
UPDATE public.tournament_config SET value = to_jsonb((now() + interval '1 hour')::text)
 WHERE key = 'first_kickoff_utc';

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.bracket_peer_v),
  0,
  'A1 pre-lock → zero rows for any target (non-leak)'
);

-- ---- Phase 2: POST-LOCK (first kickoff in the past) -----------------------
RESET ROLE;
UPDATE public.tournament_config SET value = to_jsonb('2020-01-01T00:00:00Z'::text)
 WHERE key = 'first_kickoff_utc';

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.bracket_peer_v
    WHERE participant_id = current_setting('test.s010pv.bravo_pid')::uuid),
  31,
  'A2 post-lock → peer bravo''s full 31-matchup tree visible (proves DEFINER read)'
);

SELECT is(
  (SELECT count(*)::int FROM public.bracket_peer_v
    WHERE participant_id = current_setting('test.s010pv.alpha_pid')::uuid),
  0,
  'A3 self-exclusion: caller never sees their own bracket'
);

-- Only bravo has seeded picks besides alpha; alpha is self-excluded, so the
-- caller sees exactly one distinct peer post-lock.
SELECT is(
  (SELECT count(DISTINCT participant_id)::int FROM public.bracket_peer_v),
  1,
  'A5 exactly one distinct peer (bravo) visible to alpha post-lock'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
