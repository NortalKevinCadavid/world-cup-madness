-- ============================================================================
-- slice-010-cascade.sql  — Slice 010 / T019 (pgTAP)
-- ============================================================================
-- Verifies bracket_clear_invalid_picks (migration 0089 / FR-006): changing an
-- upstream winner clears the now-impossible downstream pick, but leaves
-- still-reachable picks intact. Runs as superuser (RLS bypassed).
-- Pattern: BEGIN / plan / asserts / finish / ROLLBACK.
-- ============================================================================

BEGIN;
SELECT plan(4);

-- Fixture UUIDs from slice-010-fixture.sql.
-- alpha participant = 11111111-...; teams France=..01, Germany=..02, England=..03.
-- R32#1 = dddd0032-..01 (France/Germany) → R16#1 slot A
-- R32#2 = dddd0032-..02 (England/Portugal) → R16#1 slot B
-- R16#1 = dddd0016-..01

-- Clean any fixture picks for alpha, then build a valid chain:
DELETE FROM public.bracket_picks WHERE participant_id = '11111111-1111-1111-1111-111111111111';

INSERT INTO public.bracket_picks (participant_id, matchup_id, winner_team_id) VALUES
  ('11111111-1111-1111-1111-111111111111','dddd0032-0000-0000-0000-000000000001','cccc0010-0000-0000-0000-000000000001'), -- R32#1 France
  ('11111111-1111-1111-1111-111111111111','dddd0032-0000-0000-0000-000000000002','cccc0010-0000-0000-0000-000000000003'), -- R32#2 England
  ('11111111-1111-1111-1111-111111111111','dddd0016-0000-0000-0000-000000000001','cccc0010-0000-0000-0000-000000000001'); -- R16#1 France (valid: France vs England)

-- Sanity: nothing to clear yet (the chain is consistent).
SELECT is(
  public.bracket_clear_invalid_picks('11111111-1111-1111-1111-111111111111'),
  ARRAY[]::uuid[],
  'consistent bracket clears nothing'
);

-- Change R32#1 winner to Germany → R16#1 becomes {Germany, England}; the
-- R16#1 pick (France) is now impossible.
UPDATE public.bracket_picks
   SET winner_team_id = 'cccc0010-0000-0000-0000-000000000002'
 WHERE participant_id = '11111111-1111-1111-1111-111111111111'
   AND matchup_id = 'dddd0032-0000-0000-0000-000000000001';

SELECT ok(
  'dddd0016-0000-0000-0000-000000000001' = ANY (
    public.bracket_clear_invalid_picks('11111111-1111-1111-1111-111111111111')
  ),
  'changing R32#1 winner clears the impossible R16#1 pick'
);

-- The R16#1 pick row is gone.
SELECT is(
  (SELECT count(*)::int FROM public.bracket_picks
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'
      AND matchup_id = 'dddd0016-0000-0000-0000-000000000001'),
  0,
  'the impossible R16#1 pick row was deleted'
);

-- The two R32 picks (always valid — seeded competitors) survive.
SELECT is(
  (SELECT count(*)::int FROM public.bracket_picks
    WHERE participant_id = '11111111-1111-1111-1111-111111111111'
      AND matchup_id IN ('dddd0032-0000-0000-0000-000000000001','dddd0032-0000-0000-0000-000000000002')),
  2,
  'the upstream R32 picks remain intact'
);

SELECT * FROM finish();
ROLLBACK;
