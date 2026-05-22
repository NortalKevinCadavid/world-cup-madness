-- Slice 002 / T026 / contracts/match-results.write.md § Test surface row 8.
-- RED until T029 ships record_match_result SP.
--
-- Constitution Principle V (audit-in-same-transaction) verification. Per
-- contracts/match-results.write.md § Audit posture, every successful
-- record_match_result invocation produces ONE audit_log row keyed by:
--
--   action         = 'match_result.recorded' (first insert)
--                    OR 'match_result.corrected' (subsequent UPDATE)
--   actor          = p_approved_by  (NULL for sync, participant uuid for admin)
--   entity_type    = 'match_result'
--   entity_id      = p_match_id
--   previous_value = OLD row jsonb (NULL on INSERT)
--   new_value      = NEW row jsonb (includes _for_scoring columns)
--   source         = 'trigger'
--
-- The audit row is emitted by the match_results_audit_trigger (migration
-- 0025, T013), which fires AFTER INSERT in the SP's same transaction —
-- satisfying Principle V structurally. The trigger as-built (per migration
-- 0025) uses action='match_result.recorded' (INSERT) / 'match_result.updated'
-- (UPDATE). The contract spelling 'match_result.corrected' (for UPDATEs) is
-- not enforced by the trigger; T029 may either reconcile via a re-INSERT
-- pattern or accept the as-built 'updated' spelling. This test only
-- exercises the first-insert path, so action MUST equal
-- 'match_result.recorded'.
--
-- new_value->>'home_score_for_scoring' is the load-bearing assertion that
-- proves the LOCKED cross-slice column made it into the audit envelope —
-- Slice 007 forensic queries will read this exact path.
--
-- Fixture choice: M3 flipped to 'finished'. Happy-path args: 3-1 regulation,
-- provider_sync, no approver (actor IS NULL).
--
-- Pattern: BEGIN / plan(3) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(3);

UPDATE public.matches SET status = 'in_progress' WHERE id = 'bbbb0000-0000-0000-0000-000000000003';
UPDATE public.matches SET status = 'finished'    WHERE id = 'bbbb0000-0000-0000-0000-000000000003';

-- Snapshot the audit_log count for action='match_result.recorded' targeting
-- M3 BEFORE the SP call so the post-call assertion captures only the row
-- the SP emitted (not seed-fixture residue).
CREATE TEMP TABLE pre_count (n bigint);
INSERT INTO pre_count (n)
SELECT count(*) FROM public.audit_log
 WHERE action = 'match_result.recorded'
   AND entity_id = 'bbbb0000-0000-0000-0000-000000000003';

-- Invoke the SP.
SELECT public.record_match_result(
  'bbbb0000-0000-0000-0000-000000000003'::uuid,
  3,
  1,
  3,
  1,
  'regulation',
  'provider_sync',
  NULL::uuid
);

-- A1: exactly one NEW match_result.recorded audit row exists for M3 with
-- source='trigger' (per the migration 0025 trigger function).
SELECT is(
  (SELECT count(*) FROM public.audit_log
    WHERE action = 'match_result.recorded'
      AND entity_id = 'bbbb0000-0000-0000-0000-000000000003'
      AND source = 'trigger')
    - (SELECT n FROM pre_count),
  1::bigint,
  'A1 exactly one new audit_log row written with action=''match_result.recorded'' / source=''trigger'' / entity_id=M3'
);

-- A2: the audit envelope's new_value carries the LOCKED cross-slice
-- _for_scoring column. Slice 007 forensic queries read this exact path.
SELECT is(
  (SELECT new_value->>'home_score_for_scoring'
     FROM public.audit_log
    WHERE action = 'match_result.recorded'
      AND entity_id = 'bbbb0000-0000-0000-0000-000000000003'
      AND source = 'trigger'
    ORDER BY occurred_at DESC
    LIMIT 1),
  '3',
  'A2 audit_log.new_value->>''home_score_for_scoring'' = ''3'' (locked cross-slice column made it into the audit envelope)'
);

-- A3: actor IS NULL for source='provider_sync' (no human actor; the sync
-- coordinator runs under SECURITY DEFINER without JWT context). The trigger
-- reads NEW.recorded_by, which is NULL on the SP's INSERT when
-- p_approved_by IS NULL.
SELECT is(
  (SELECT actor
     FROM public.audit_log
    WHERE action = 'match_result.recorded'
      AND entity_id = 'bbbb0000-0000-0000-0000-000000000003'
      AND source = 'trigger'
    ORDER BY occurred_at DESC
    LIMIT 1),
  NULL::uuid,
  'A3 audit_log.actor IS NULL for provider_sync invocations (no JWT context, p_approved_by passed NULL)'
);

SELECT * FROM finish();

ROLLBACK;
