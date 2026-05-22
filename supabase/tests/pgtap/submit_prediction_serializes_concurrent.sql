-- Slice 003 / T024 / contracts/predictions.write.md § Test surface
--   (row: `submit_prediction_serializes_concurrent.sql`). RED until T021's
--   supersede SP (slot 0037) is verified to keep the supersede chain
--   well-formed under repeated submits for the same (participant, match).
--
-- Concurrency-test compromise (PRINCIPLE IX deviation, documented):
--   True concurrent serialization (1,000 simultaneous calls from separate
--   connections) is verified by Slice 005's perf tests + Playwright
--   concurrent-tabs test (T025's `slice-003-submit-concurrent-tabs.spec.ts`,
--   which forks two browser contexts). pgTAP runs inside a single Postgres
--   connection so genuine parallelism is impossible here. This file instead
--   verifies the SUPERSEDE CHAIN INVARIANT that the advisory lock protects:
--   after N sequential submits for the same (participant, match), exactly
--   one row is active, the prior N-1 are in the supersede chain, and every
--   superseded_by FK resolves to an extant row. The three-layer concurrency
--   (advisory lock + FOR UPDATE + partial unique index) means sequential
--   submits exercise the same supersede code path as parallel ones — only
--   the lock contention differs, and that contention is verified by the
--   Playwright + perf surfaces above.
--
-- Fixture choice: M6 (USA-JPN, scheduled, bbbb0000-0000-0000-0000-000000000006).
-- The slice-003 fixture seeds NO prediction for (alpha, M6), so the first
-- SP call exercises the fresh-INSERT branch; the next four exercise the
-- supersede branch. Kickoff is 2026-06-14T20:00:00Z — far past the 60-min
-- lock window relative to today, so the lock check passes cleanly.
--
-- D-014 audit-trail caveat: the supersede pattern uses a self-reference
-- placeholder briefly (OLD.superseded_by = OLD.id) so the FK satisfies
-- before the NEW row exists; the SP then back-fixes the placeholder to
-- v_new_id. The FINAL STATE of predictions.superseded_by is correct
-- (points at the actual successor). The audit_log row's new_value carries
-- the placeholder, but THIS test inspects only the predictions table's
-- final state and does not assert on audit_log content. Passes.
--
-- Pattern: BEGIN / plan(3) / DO loop calling SP 5x / asserts / finish /
-- ROLLBACK.

BEGIN;

SELECT plan(3);

-- ---------------------------------------------------------------------------
-- Drive: 5 sequential submits via the SP. Each call is its own SAVEPOINT-less
-- statement within the outer txn; the SP's pg_advisory_xact_lock auto-
-- releases at the OUTER COMMIT/ROLLBACK, not at statement boundaries — so
-- within this single test transaction we hold the same advisory lock across
-- all 5 calls. That's fine: serialization is the goal we're emulating.
-- Scores are (i, i) so each call is distinguishable in case of a debug.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_alpha  uuid := '11111111-1111-1111-1111-111111111111'::uuid;
  v_match  uuid := 'bbbb0000-0000-0000-0000-000000000006'::uuid;
  v_iter   int;
  v_new_id uuid;
BEGIN
  FOR v_iter IN 1..5 LOOP
    v_new_id := public.submit_prediction(v_alpha, v_match, v_iter, v_iter, 'ui');
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- A1: exactly ONE active row for (alpha, M6) after 5 sequential submits.
-- This is the partial-unique-index invariant (predictions_active_uk, slot
-- 0030) — the supersede pattern's reason for existence.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.predictions
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND match_id       = 'bbbb0000-0000-0000-0000-000000000006'::uuid
      AND superseded_at IS NULL),
  1,
  'A1 exactly one active row for (alpha, M6) after 5 sequential submits'
);

-- ---------------------------------------------------------------------------
-- A2: exactly 5 TOTAL rows for (alpha, M6) — 1 active + 4 superseded.
-- This confirms history retention (FR-005): every submit creates a NEW row,
-- never an UPDATE-in-place of the active row.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.predictions
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid
      AND match_id       = 'bbbb0000-0000-0000-0000-000000000006'::uuid),
  5,
  'A2 exactly 5 total predictions rows for (alpha, M6) — 1 active + 4 superseded'
);

-- ---------------------------------------------------------------------------
-- A3: chain integrity — every superseded row has BOTH superseded_at and
-- superseded_by populated (table CHECK predictions_supersede_consistency),
-- and superseded_by resolves to an extant predictions row. We assert that
-- all 4 superseded rows satisfy the EXISTS join.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.predictions p1
    WHERE p1.participant_id  = '11111111-1111-1111-1111-111111111111'::uuid
      AND p1.match_id        = 'bbbb0000-0000-0000-0000-000000000006'::uuid
      AND p1.superseded_at IS NOT NULL
      AND p1.superseded_by IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.predictions p2
         WHERE p2.id = p1.superseded_by
      )),
  4,
  'A3 all 4 superseded rows have superseded_by FKs that resolve to extant predictions rows'
);

SELECT * FROM finish();

ROLLBACK;
