-- Slice 004 / T021 / US2 / contracts/final-prediction-lock.predicate.sql.md § Test surface.
--
-- Source-introspection assertion (BR-LOCK-001 / Constitution VI): the
-- predicate's body MUST reference the database clock (now() or
-- current_timestamp) and MUST take zero parameters. Any client-passed
-- "now" value or per-call argument would let a malicious caller forge the
-- lock verdict — the contract precludes this by mandating a zero-arg
-- function that reads only the DB clock + tournament_config.
--
-- This test does NOT exercise a live verdict; it inspects pg_proc + the
-- definition string returned by pg_get_functiondef. Belt-and-braces:
--   A1: pronargs = 0 (signature: zero arguments).
--   A2: function body contains `now()` or `current_timestamp` (case-
--       insensitive regex match against the CREATE FUNCTION text).
--
-- Pattern: BEGIN / plan(2) / asserts / finish / ROLLBACK.

BEGIN;

SELECT plan(2);

-- A1: zero arguments per the locked cross-slice signature.
SELECT is(
  (SELECT pronargs FROM pg_proc
    WHERE oid = 'public.is_final_prediction_locked'::regproc),
  0::int2,
  'A1 is_final_prediction_locked takes zero arguments (pg_proc.pronargs = 0)'
);

-- A2: function body invokes the DB clock (now() or current_timestamp).
SELECT ok(
  (SELECT pg_get_functiondef('public.is_final_prediction_locked'::regproc::oid))
    ~* '(\mnow\s*\(\s*\)|\mcurrent_timestamp\M)',
  'A2 is_final_prediction_locked body references now() or current_timestamp (DB clock, not a client-passed value)'
);

SELECT * FROM finish();

ROLLBACK;
