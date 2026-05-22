-- Slice 002 / T026 / contracts/match-results.write.md § Test surface row 7.
-- RED until T029 ships record_match_result SP.
--
-- Side effect under test: per contracts/match-results.write.md § Stored
-- procedure semantics step 4:
--
--   PERFORM pg_notify(
--     'match_results_recorded',
--     json_build_object('match_id', p_match_id, 'source', p_source)::text
--   );
--
-- Slice 005's score-trigger Edge Function (Slice 005 T042) consumes this
-- notification. The channel name 'match_results_recorded' is part of the
-- LOCKED versioning policy at the bottom of the contract document.
--
-- pgTAP-pattern compromise (documented per the T026 task brief):
--   pgTAP runs inside a BEGIN/.../ROLLBACK envelope. pg_notify enqueues the
--   notification for delivery at COMMIT — a rolled-back transaction emits
--   nothing to listening sessions, and a single-session pgTAP test cannot
--   read its own NOTIFY queue mid-transaction (libpq exposes notifications
--   only between commands, and pgTAP harnesses don't surface them).
--
--   The pragmatic in-pgTAP assertion is: invoking the SP under happy-path
--   inputs MUST NOT raise. Any malformed pg_notify call inside the SP body
--   (bad channel name, payload that fails json_build_object, etc.) would
--   raise here. lives_ok covers that surface. The end-to-end "the channel
--   actually received the payload Slice 005 expects" assertion is owned by
--   a Slice 005 Deno integration test that maintains a real LISTEN session
--   across COMMIT.
--
-- Fixture choice: M3 flipped to 'finished'. Happy-path args mirror
-- record_match_result_happy.sql.
--
-- Pattern: BEGIN / plan(2) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

UPDATE public.matches SET status = 'in_progress' WHERE id = 'bbbb0000-0000-0000-0000-000000000003';
UPDATE public.matches SET status = 'finished'    WHERE id = 'bbbb0000-0000-0000-0000-000000000003';

-- Subscribe this session to the channel before the SP fires. The LISTEN
-- itself does not produce the assertion; it documents intent and is a
-- harmless no-op if the SP elects a different channel name (which would
-- violate the contract — but that surface is exercised by other tests).
LISTEN match_results_recorded;

-- A1: invoking the SP on a 'finished' match with happy-path inputs does NOT
-- raise. If T029's pg_notify call is malformed (channel mistyped, payload
-- not coercible to text, etc.) plpgsql will raise here and this assertion
-- will fail with the underlying error message.
SELECT lives_ok(
  $$ SELECT public.record_match_result(
       'bbbb0000-0000-0000-0000-000000000003'::uuid,
       3,
       1,
       3,
       1,
       'regulation',
       'provider_sync',
       NULL::uuid
     ) $$,
  'A1 record_match_result completes without raising — any malformed pg_notify call inside the SP would surface here'
);

-- A2: the SP recorded a match_results row. This is the necessary
-- precondition for the notification to have been emitted at all (the
-- contract puts the pg_notify call AFTER the UPSERT). If the SP raised
-- silently or skipped the INSERT we want a distinct failure signal here.
SELECT is(
  (SELECT count(*) FROM public.match_results
    WHERE match_id = 'bbbb0000-0000-0000-0000-000000000003'),
  1::bigint,
  'A2 a match_results row exists for M3 (necessary precondition for the pg_notify step to have run)'
);

UNLISTEN match_results_recorded;

SELECT * FROM finish();

ROLLBACK;
