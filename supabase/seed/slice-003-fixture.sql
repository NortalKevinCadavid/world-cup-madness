-- Slice 003 fixture: 8 predictions across alpha/bravo/charlie covering active + superseded + API-source + pre-lock states. Loaded after slice 001 + 002 fixtures during supabase db reset. Idempotent (ON CONFLICT DO NOTHING with deterministic UUIDs).
--
-- Tables touched (by INSERT, with ON CONFLICT DO NOTHING on each PK):
--   public.predictions  -- 8 rows
--
-- Tables NOT touched: audit_log (the audit trigger from T006 will write rows
-- automatically as the predictions inserts fire); matches / match_results
-- (slice 002 territory); participants (slice 001 territory).
--
-- Deterministic UUID conventions (to avoid collisions with slice 001/002):
--   Predictions : cccc0000-0000-0000-0000-00000000000N  (N = 1..8)
--
-- Cross-slice UUID references (verified against the prior fixtures):
--   Participants (slice 001):
--     alpha    = 11111111-1111-1111-1111-111111111111  (ACTIVE)
--     bravo    = 22222222-2222-2222-2222-222222222222  (ACTIVE)
--     charlie  = 33333333-3333-3333-3333-333333333333  (ACTIVE)
--   Matches (slice 002):
--     M1 ARG-MEX finished     = bbbb0000-0000-0000-0000-000000000001
--     M2 CAN-POL in_progress  = bbbb0000-0000-0000-0000-000000000002
--     M3 ARG-CAN scheduled    = bbbb0000-0000-0000-0000-000000000003
--     M4 MEX-POL scheduled    = bbbb0000-0000-0000-0000-000000000004
--     M5 ESP-BRA scheduled    = bbbb0000-0000-0000-0000-000000000005
--
-- Coverage map (each row exercises one or more scenarios):
--   Row 1 — alpha active pick for M3 (ARG-CAN, scheduled), 2-1, source='ui'
--           supersedes Row 2. Exercises: active-pick-per-(participant,match)
--           uniqueness via partial index; UI source.
--   Row 2 — alpha superseded earlier pick for M3, 1-0, source='ui'.
--           superseded_at set, superseded_by -> Row 1. Exercises the supersede
--           chain (history retained, only latest is active).
--   Row 3 — bravo active pick for M3, 0-0, source='ui'. Multi-participant
--           coverage of the same match for leaderboard/scoring fan-out tests.
--   Row 4 — charlie active pick for M3, 3-2, source='ui'. Third participant
--           coverage of the same match (3 active predictions on M3 total).
--   Row 5 — alpha active pick for M4 (MEX-POL, scheduled), 1-1, source='ui'.
--           Same participant, different match — independent uniqueness slot.
--   Row 6 — bravo active pick for M1 (ARG-MEX, FINISHED 2-0), 2-0, source='ui'.
--           Submitted 1 hour pre-kickoff (before the 60-min lock). Exercises
--           the locked-after-finish state and a future scoring=exact-match.
--   Row 7 — alpha API-submitted pick for M5 (ESP-BRA, scheduled), source='api'.
--           Exercises the 'api' enum branch of predictions.source.
--   Row 8 — charlie pick for M2 (CAN-POL, in_progress), 1-1, source='ui',
--           submitted 1.5h pre-kickoff (before lock). Exercises retention of
--           pre-lock predictions once the match transitions to in_progress.
--
-- Insertion order constraint: Row 1 (the supersede target) MUST be inserted
-- before Row 2 (which has superseded_by referencing Row 1). The FK
-- predictions.superseded_by -> predictions.id requires the target row exist
-- at commit time; since both are in the same transaction, strictly the order
-- only matters if the constraint is NOT DEFERRABLE. We insert Row 1 first to
-- be safe under either deferral mode.

BEGIN;

-- ---------------------------------------------------------------------------
-- Row 1: alpha's CURRENT active pick for M3 (ARG-CAN scheduled) — 2-1, UI
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES (
  'cccc0000-0000-0000-0000-000000000001'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'bbbb0000-0000-0000-0000-000000000003'::uuid,
  2, 1, 'ui', NULL, NULL,
  '11111111-1111-1111-1111-111111111111'::uuid,
  '2026-06-15T10:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 2: alpha's EARLIER (now superseded) pick for M3 — 1-0, UI
--   superseded_by points at Row 1.
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES (
  'cccc0000-0000-0000-0000-000000000002'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'bbbb0000-0000-0000-0000-000000000003'::uuid,
  1, 0, 'ui',
  '2026-06-15T10:00:00Z',
  'cccc0000-0000-0000-0000-000000000001'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  '2026-06-14T10:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 3: bravo's active pick for M3 — 0-0, UI
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES (
  'cccc0000-0000-0000-0000-000000000003'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid,
  'bbbb0000-0000-0000-0000-000000000003'::uuid,
  0, 0, 'ui', NULL, NULL,
  '22222222-2222-2222-2222-222222222222'::uuid,
  '2026-06-15T11:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 4: charlie's active pick for M3 — 3-2, UI
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES (
  'cccc0000-0000-0000-0000-000000000004'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,
  'bbbb0000-0000-0000-0000-000000000003'::uuid,
  3, 2, 'ui', NULL, NULL,
  '33333333-3333-3333-3333-333333333333'::uuid,
  '2026-06-15T12:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 5: alpha's active pick for M4 (MEX-POL scheduled) — 1-1, UI
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES (
  'cccc0000-0000-0000-0000-000000000005'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'bbbb0000-0000-0000-0000-000000000004'::uuid,
  1, 1, 'ui', NULL, NULL,
  '11111111-1111-1111-1111-111111111111'::uuid,
  '2026-06-16T09:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 6: bravo's active pick for M1 (ARG-MEX FINISHED 2-0) — 2-0, UI
--   Submitted 1h pre-kickoff (2026-06-11T19:00:00Z; kickoff 20:00Z; lock at
--   19:00Z). This is now LOCKED post-match and would score as an exact match.
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES (
  'cccc0000-0000-0000-0000-000000000006'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid,
  'bbbb0000-0000-0000-0000-000000000001'::uuid,
  2, 0, 'ui', NULL, NULL,
  '22222222-2222-2222-2222-222222222222'::uuid,
  '2026-06-11T19:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 7: alpha's API-submitted pick for M5 (ESP-BRA scheduled) — 2-2, API
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES (
  'cccc0000-0000-0000-0000-000000000007'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'bbbb0000-0000-0000-0000-000000000005'::uuid,
  2, 2, 'api', NULL, NULL,
  '11111111-1111-1111-1111-111111111111'::uuid,
  '2026-06-13T09:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row 8: charlie's pick for M2 (CAN-POL in_progress) — 1-1, UI
--   Submitted 1.5h pre-kickoff (2026-06-12T18:30:00Z; kickoff 20:00Z).
--   Exercises retention of pre-lock predictions across the
--   scheduled -> in_progress transition.
-- ---------------------------------------------------------------------------
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, superseded_at, superseded_by, created_by, submitted_at
) VALUES (
  'cccc0000-0000-0000-0000-000000000008'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,
  'bbbb0000-0000-0000-0000-000000000002'::uuid,
  1, 1, 'ui', NULL, NULL,
  '33333333-3333-3333-3333-333333333333'::uuid,
  '2026-06-12T18:30:00Z'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
