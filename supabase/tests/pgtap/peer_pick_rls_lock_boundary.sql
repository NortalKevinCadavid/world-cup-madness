-- Slice 005 / T027 / US3 / contracts/peer-pick.read.md § Server-side gate +
--   § Lock-boundary behavior + § Final-tournament peer picks (Surface 2).
--
-- RED until T029 ships peer_pick_v + peer_final_pick_v at on-disk slot 0054
-- per D-023 (regression-baseline.md § D-023; tasks.md T029 names the file
-- `0055_leaderboard_view.sql` — exact on-disk slot to be confirmed by T029,
-- but in any case the views do not exist yet).
--
-- This pgTAP file proves the RLS predicates honor BR-LOCK-002 / BR-LOCK-003
-- (match-pick boundary: `now() >= kickoff_utc - lock_window`) and BR-LOCK-005
-- (final-pick boundary: `now() >= first_kickoff_utc`) at the SQL boundary —
-- the gate that Constitution Principle III demands lives in the database,
-- not in app code, and that SC-009 demands be un-bypassable by direct REST.
--
-- The 8 assertions cover BOTH views:
--   peer_pick_v       — A1 pre-lock empty / A2 boundary populated /
--                       A3 post-lock populated / A4 excludes-self
--   peer_final_pick_v — A5 pre-first-kickoff empty / A6 boundary populated /
--                       A7 excludes-self / A8 admin-invalidated masked
--
-- Uses SET LOCAL ROLE authenticated + SET LOCAL request.jwt.claims to simulate
-- a participant (the same JWT-impersonation pattern slice-001-api-me-rls.sql
-- established for this codebase). Outer ROLLBACK restores all tournament_config
-- and matches mutations made during setup. SET LOCAL is txn-scoped, so role
-- and JWT claims are restored automatically by the ROLLBACK.
--
-- Fixture personas (supabase/seed/slice-001-fixture.sql):
--   alpha   — auth.users.id      = 00000000-0000-0000-0000-00000000000a
--           — participants.id    = 11111111-1111-1111-1111-111111111111
--   bravo   — auth.users.id      = 00000000-0000-0000-0000-00000000000b
--           — participants.id    = 22222222-2222-2222-2222-222222222222
--   charlie — auth.users.id      = 00000000-0000-0000-0000-00000000000c
--           — participants.id    = 33333333-3333-3333-3333-333333333333
--
-- alpha plays the role of the calling participant. bravo + charlie play the
-- role of the peers whose picks alpha is trying to read through the lock gate.
--
-- A8 caveat (admin_invalidated): slice 003's public.predictions and slice 004's
-- public.final_predictions schemas (migrations 0030 + 0040) do NOT carry an
-- `admin_invalidated` column. The "admin override → NULL" masking pathway
-- described in contracts/peer-pick.read.md § Response is expected to be
-- introduced by slice 006's admin-override surface. A8 is therefore guarded by
-- pgTAP's skip(1, ...) and will be unblocked when slice 006 ships the
-- invalidation column. The skip carries the same `pass/fail` accounting as a
-- real assertion under plan(8), so the file stays RED at the right
-- granularity until the views exist.

BEGIN;

SELECT plan(8);

-- ---------------------------------------------------------------------------
-- Setup: insert a NEW test match owned by this txn (rolled back at finish).
-- Kickoff is initially placed far in the future so A1's pre-lock assertion
-- can run against a clean predicate state. Subsequent UPDATEs walk kickoff_utc
-- across the lock boundary for A2 / A3 / A4. Uses slice 002 fixture teams
-- (ARG home, MEX away) so the matches FK to public.teams resolves.
-- ---------------------------------------------------------------------------

INSERT INTO public.matches (
  id, home_team_id, away_team_id, stage, group_id,
  kickoff_utc, venue, status
) VALUES (
  -- Deterministic, recognizable: 't027' prefix encodes the test owning the row.
  't0270000-0000-0000-0000-000000000001'::uuid,
  'aaaa0000-0000-0000-0000-000000000001'::uuid,  -- ARG (slice 002)
  'aaaa0000-0000-0000-0000-000000000002'::uuid,  -- MEX (slice 002)
  'group', 'A',
  now() + INTERVAL '60 minutes 1 second',         -- pre-lock by 1 second
  'T027 venue', 'scheduled'
);

-- Peer predictions on the test match: bravo + charlie each submit one row.
-- These are the rows alpha's peer_pick_v query should be denied (A1) and
-- permitted (A2/A3) to see depending on the lock state.
INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, created_by
) VALUES
  (
    't0270000-0000-0000-0000-0000000000b1'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,  -- bravo
    't0270000-0000-0000-0000-000000000001'::uuid,
    1, 0, 'ui',
    '22222222-2222-2222-2222-222222222222'::uuid
  ),
  (
    't0270000-0000-0000-0000-0000000000c1'::uuid,
    '33333333-3333-3333-3333-333333333333'::uuid,  -- charlie
    't0270000-0000-0000-0000-000000000001'::uuid,
    2, 1, 'ui',
    '33333333-3333-3333-3333-333333333333'::uuid
  );

-- ---------------------------------------------------------------------------
-- Impersonation: alpha is the calling participant for ALL 8 assertions.
-- Stage the JWT claims FIRST (as the test-runner superuser), THEN downgrade
-- to the `authenticated` role so the view's RLS / WHERE clause engages.
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- ===========================================================================
-- peer_pick_v boundary assertions (A1..A4) — BR-LOCK-002 / BR-LOCK-003
-- ===========================================================================

-- A1: PRE-LOCK. kickoff = now() + 60min + 1s. The view's predicate
--   `now() >= kickoff_utc - lock_window` is FALSE by 1 second. alpha MUST see
--   zero peer rows for this match. This is the SC-009 "before lock, the
--   response is empty regardless of requester" gate.
SELECT is(
  (SELECT count(*) FROM public.peer_pick_v
     WHERE match_id = 't0270000-0000-0000-0000-000000000001'::uuid),
  0::bigint,
  'A1 peer_pick_v: pre-lock (kickoff = now()+60min+1s) returns 0 rows under participant JWT'
);

-- Drop back to superuser to perform the UPDATE; authenticated role typically
-- has no UPDATE privilege on public.matches.
RESET ROLE;

-- A2: AT BOUNDARY. kickoff = now() + 60min EXACTLY. now() is fixed at
--   transaction_timestamp() inside this txn, so the equality is exact.
--   BR-LOCK-003: strict-inclusive boundary — `>=` fires the lock, peer reads
--   become permitted at this instant.
UPDATE public.matches
   SET kickoff_utc = now() + INTERVAL '60 minutes'
 WHERE id = 't0270000-0000-0000-0000-000000000001'::uuid;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT cmp_ok(
  (SELECT count(*) FROM public.peer_pick_v
     WHERE match_id = 't0270000-0000-0000-0000-000000000001'::uuid),
  '>',
  0::bigint,
  'A2 peer_pick_v: at boundary (kickoff = now()+60min) returns non-zero rows (BR-LOCK-003 strict-inclusive)'
);

RESET ROLE;

-- A3: POST-LOCK. kickoff = now() + 30min. Well past the 60-min lock window.
--   Peer reads MUST be permitted — this is the FR-016 happy path.
UPDATE public.matches
   SET kickoff_utc = now() + INTERVAL '30 minutes'
 WHERE id = 't0270000-0000-0000-0000-000000000001'::uuid;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT cmp_ok(
  (SELECT count(*) FROM public.peer_pick_v
     WHERE match_id = 't0270000-0000-0000-0000-000000000001'::uuid),
  '>',
  0::bigint,
  'A3 peer_pick_v: post-lock (kickoff = now()+30min) returns non-zero rows (FR-016 match variant)'
);

-- A4: SELF-EXCLUSION. Insert alpha's own prediction on the test match. While
--   we are still in the post-lock state from A3, alpha's OWN row MUST NOT
--   appear in peer_pick_v (per contracts/peer-pick.read.md: "participant_id
--   ... never the caller" — self-reads belong to predictions RLS, not the
--   peer surface).
RESET ROLE;

INSERT INTO public.predictions (
  id, participant_id, match_id, predicted_home, predicted_away,
  source, created_by
) VALUES (
  't0270000-0000-0000-0000-0000000000a1'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,  -- alpha
  't0270000-0000-0000-0000-000000000001'::uuid,
  3, 3, 'ui',
  '11111111-1111-1111-1111-111111111111'::uuid
);

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*) FROM public.peer_pick_v
     WHERE match_id    = 't0270000-0000-0000-0000-000000000001'::uuid
       AND participant_id = '11111111-1111-1111-1111-111111111111'::uuid),
  0::bigint,
  'A4 peer_pick_v: excludes the calling participant (alpha) from its own peer view post-lock'
);

-- ===========================================================================
-- peer_final_pick_v boundary assertions (A5..A8) — BR-LOCK-005
-- ===========================================================================
--
-- These assertions reuse the slice 004 fixture's final_predictions rows
-- (alpha / bravo / charlie all have at least one active final pick seeded by
-- supabase/seed/slice-004-fixture.sql). We DO NOT insert new final picks here
-- — instead we walk tournament_config.first_kickoff_utc across the boundary
-- to flip the view's predicate verdict.

RESET ROLE;

-- A5: PRE-FIRST-KICKOFF. Push first_kickoff_utc 1 hour into the future.
--   peer_final_pick_v's predicate `now() >= first_kickoff_utc` is FALSE for
--   the entire result set; ZERO rows are returned regardless of which peer
--   alpha asks about. Same shape as A1 (the gate is in SQL).
UPDATE public.tournament_config
   SET value = to_jsonb((now() + INTERVAL '1 hour')::text)
 WHERE key = 'first_kickoff_utc';

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*) FROM public.peer_final_pick_v),
  0::bigint,
  'A5 peer_final_pick_v: pre-first-kickoff (config = now()+1h) returns 0 rows for ALL peers'
);

RESET ROLE;

-- A6: AT FIRST-KICKOFF BOUNDARY. Pin first_kickoff_utc to now() exactly.
--   Inside this txn now() = transaction_timestamp() (stable), so the
--   `now() >= first_kickoff_utc` predicate is TRUE at strict equality.
--   BR-LOCK-005's strict-inclusive boundary mirrors BR-LOCK-003 — peer
--   final-pick reads MUST be permitted at this instant.
UPDATE public.tournament_config
   SET value = to_jsonb(now()::text)
 WHERE key = 'first_kickoff_utc';

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT cmp_ok(
  (SELECT count(*) FROM public.peer_final_pick_v),
  '>',
  0::bigint,
  'A6 peer_final_pick_v: at boundary (now() = first_kickoff_utc) returns non-zero rows (BR-LOCK-005 strict-inclusive)'
);

RESET ROLE;

-- A7: SELF-EXCLUSION (FINAL VARIANT). Move first_kickoff_utc into the past
--   so the gate is fully open, then assert alpha's OWN participant_id never
--   appears in peer_final_pick_v. The contract specifies `participant_id <>
--   auth.uid()` at the view level — alpha's own final picks belong to
--   Slice 004's surface, not this peer view.
UPDATE public.tournament_config
   SET value = to_jsonb((now() - INTERVAL '1 hour')::text)
 WHERE key = 'first_kickoff_utc';

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*) FROM public.peer_final_pick_v
     WHERE participant_id = '11111111-1111-1111-1111-111111111111'::uuid),
  0::bigint,
  'A7 peer_final_pick_v: excludes the calling participant (alpha) post-first-kickoff'
);

-- A8: ADMIN-INVALIDATED MASKING. Contract: an admin-invalidated peer pick
--   appears as a row with all FK / target columns NULL (peer_final_pick_v)
--   or `predicted_home / predicted_away / submitted_at NULL` (peer_pick_v)
--   so non-admin peers cannot infer that an override occurred.
--
--   Slice 003's public.predictions and slice 004's public.final_predictions
--   do NOT currently carry an `admin_invalidated` column (verified against
--   migrations 0030 + 0040). The invalidation pathway is owned by slice 006's
--   admin-override surface (still pending). This assertion is therefore
--   skipped against plan(8) — the slot will be filled when slice 006 ships
--   the column and the view masking logic is in place. Until then, A8's
--   skip keeps the file at plan(8) accounting without a synthetic green.
SELECT skip(
  1,
  'A8 peer_pick_v / peer_final_pick_v admin-invalidated masking — slice 003/004 schemas (0030 / 0040) carry NO admin_invalidated column. Pathway is owned by slice 006; this slot fills when 006 ships invalidation. Until then, A8 deliberately under-asserts.'
);

-- Restore superuser role before finish() so plan/finish bookkeeping runs
-- without the authenticated-role privilege restrictions.
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
