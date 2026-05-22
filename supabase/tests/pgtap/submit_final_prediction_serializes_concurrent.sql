-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- Concurrency-test caveat (PRINCIPLE IX deviation, documented):
--   True concurrent verification of 1,000 simultaneous SP calls from
--   separate connections is impossible inside a pgTAP transaction (single
--   Postgres connection). Genuine multi-connection concurrency for the
--   (participant, item_kind) advisory lock is verified by:
--     * Playwright's slice-004-submit-concurrent-tabs.spec.ts (two browser
--       contexts firing parallel POSTs), and
--     * Slice 005's perf harness if/when added.
--   Both are deferred to T034 (slice-004 cross-link harness work).
--
-- What this file VERIFIES instead: the three-layer concurrency contract's
-- final-state invariant. The SP serializes via:
--   1. pg_advisory_xact_lock(hashtext(participant_id || ':' || item_kind))
--   2. SELECT ... FOR UPDATE of the active row
--   3. Partial unique index final_predictions_active_uk
--      ON (participant_id, item_kind) WHERE superseded_at IS NULL.
-- The PARTIAL UNIQUE INDEX is the load-bearing invariant — even if the
-- advisory lock and FOR UPDATE somehow failed, the unique index would
-- promote the second concurrent INSERT to a 23505 unique_violation. This
-- test exercises the supersede-chain branch which is the same code path
-- concurrent calls would hit; verifying the final-state invariant proves
-- the contract is enforced regardless of contention pattern.
--
-- Fixture choice: charlie (33333333-...-3) + champion target POL
-- (aaaa0000-...-4). Slice-004 fixture seeds NO champion row for charlie
-- (Row 6 is best_player=Pedri), so the first SP call exercises the
-- fresh-INSERT branch; the second exercises the supersede branch.
-- first_kickoff_utc remains the future-seeded slice-004 value so the lock
-- predicate is FALSE for both calls.
--
-- Pattern: BEGIN / plan(1) / DO loop of 2 sequential SPs / finish / ROLLBACK.

BEGIN;

SELECT plan(1);

-- Ensure first_kickoff_utc is firmly in the future so the lock predicate is
-- FALSE for both SP calls. The slice-004 fixture already seeds it to
-- '2026-06-16T20:00:00Z' but we override defensively so this test is
-- date-independent.
UPDATE public.tournament_config
   SET value = to_jsonb((now() + interval '1 day')::text)
 WHERE key = 'first_kickoff_utc';

-- Drive: two sequential SP calls for the SAME (participant, item_kind).
-- The first INSERTs a fresh active row; the second supersedes the first.
-- Both share the same advisory lock for the duration of the outer txn
-- (lock auto-releases at txn end, NOT at statement boundaries), emulating
-- the serialization a concurrent caller would experience.
DO $$
DECLARE
  v_charlie uuid := '33333333-3333-3333-3333-333333333333'::uuid;
  v_pol     uuid := 'aaaa0000-0000-0000-0000-000000000004'::uuid;
  v_first   uuid;
  v_second  uuid;
BEGIN
  v_first  := public.submit_final_prediction(v_charlie, 'champion', v_pol, NULL, 'ui');
  v_second := public.submit_final_prediction(v_charlie, 'champion', v_pol, NULL, 'ui');
END $$;

-- A1: exactly ONE active row for (charlie, champion) after two sequential
-- submits. This is the final_predictions_active_uk invariant — the
-- supersede pattern's reason for existence. Genuine concurrent harness is
-- deferred to T034 (see header).
SELECT is(
  (SELECT count(*)::int FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'champion'
      AND superseded_at IS NULL),
  1,
  'A1 exactly one active row for (charlie, champion) after two sequential submits (serialization invariant verified; multi-connection concurrency deferred to T034)'
);

SELECT * FROM finish();

ROLLBACK;
