-- Slice 004 / T012 / contracts/final-predictions.write.md § Test surface. RED until T016 ships submit_final_prediction SP at slot 0044.
--
-- Happy-path exercise of the not-yet-implemented
-- public.submit_final_prediction SECURITY DEFINER stored procedure. Per the
-- contract the SP signature is:
--
--   submit_final_prediction(
--     p_participant_id   uuid,
--     p_item_kind        text,    -- 'champion' | 'runner_up' | 'top_scorer' | 'best_player'
--     p_target_team_id   uuid,    -- non-NULL iff p_item_kind IN ('champion','runner_up')
--     p_target_player_id uuid,    -- non-NULL iff p_item_kind IN ('top_scorer','best_player')
--     p_source           text     -- 'ui' | 'api' | 'admin_override'
--   ) RETURNS uuid
--
-- Fixture choice: charlie (33333333-...-3) has only ONE pre-seeded final
-- prediction (Row 6: best_player -> Pedri). No active 'champion' row exists
-- for charlie in slice-004-fixture.sql, so we can submit a champion pick
-- straight into a clean slot. Target team: POL
-- (aaaa0000-...-4) -- not referenced by any of charlie's fixture picks.
--
-- The audit trigger from migration 0042 will write a 'final_prediction.created'
-- row when the SP's INSERT fires; we assert that side-effect.
--
-- Pattern: BEGIN / plan(N) / asserts / finish / ROLLBACK. ROLLBACK guarantees
-- no residue in either final_predictions or audit_log.

BEGIN;

SELECT plan(6);

-- ---------------------------------------------------------------------------
-- Snapshot counts BEFORE the SP call so we can assert exactly-one-new for
-- both final_predictions and audit_log.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _before AS
SELECT
  (SELECT count(*) FROM public.final_predictions)                                  AS fp_count,
  (SELECT count(*) FROM public.audit_log WHERE action = 'final_prediction.created') AS audit_count;

-- ---------------------------------------------------------------------------
-- Invoke the SP with happy-path arguments. The returned UUID is pinned into
-- a temp table so subsequent assertions can read it without re-invoking.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE sp_result (new_fp_id uuid);

INSERT INTO sp_result (new_fp_id)
SELECT public.submit_final_prediction(
  '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
  'champion',
  'aaaa0000-0000-0000-0000-000000000004'::uuid,  -- POL
  NULL,
  'ui'
);

-- A1: SP returned a non-null uuid.
SELECT isnt(
  (SELECT new_fp_id FROM sp_result),
  NULL,
  'A1 submit_final_prediction returned a non-null uuid for charlie + champion=POL'
);

-- A2: exactly one NEW final_predictions row exists overall (count delta = 1).
SELECT is(
  (SELECT count(*) FROM public.final_predictions) - (SELECT fp_count FROM _before),
  1::bigint,
  'A2 exactly one new final_predictions row was inserted'
);

-- A3: exactly one ACTIVE row for (charlie, champion) with the submitted
-- target_team_id + NULL target_player_id + source + created_by.
SELECT is(
  (SELECT (item_kind::text, target_team_id, target_player_id, source::text, created_by, superseded_at IS NULL)
     FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'champion'
      AND superseded_at IS NULL),
  ('champion',
   'aaaa0000-0000-0000-0000-000000000004'::uuid,
   NULL::uuid,
   'ui',
   '33333333-3333-3333-3333-333333333333'::uuid,
   true),
  'A3 the active row for (charlie, champion) has item_kind=champion, target_team_id=POL, target_player_id NULL, source=ui, created_by=charlie, superseded_at IS NULL'
);

-- A4: the row's id matches the SP's return value.
SELECT is(
  (SELECT id FROM public.final_predictions
    WHERE participant_id = '33333333-3333-3333-3333-333333333333'::uuid
      AND item_kind      = 'champion'
      AND superseded_at IS NULL),
  (SELECT new_fp_id FROM sp_result),
  'A4 the active final_predictions.id equals the uuid returned by submit_final_prediction'
);

-- A5: exactly one NEW final_prediction.created audit row exists (count delta = 1).
SELECT is(
  (SELECT count(*) FROM public.audit_log WHERE action = 'final_prediction.created')
    - (SELECT audit_count FROM _before),
  1::bigint,
  'A5 exactly one new audit_log row with action=final_prediction.created was written'
);

-- A6: that audit row points at the new final_prediction with
-- entity_type='final_prediction' and source='trigger'.
SELECT is(
  (SELECT (entity_type, source)
     FROM public.audit_log
    WHERE action    = 'final_prediction.created'
      AND entity_id = (SELECT new_fp_id FROM sp_result)),
  ('final_prediction'::text, 'trigger'::text),
  'A6 the new audit row has entity_type=final_prediction, source=trigger, entity_id=new final_prediction uuid'
);

SELECT * FROM finish();

ROLLBACK;
