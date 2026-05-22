-- _harness_smoke.sql
-- Purpose: probe the pgTAP harness for `supabase test db` so subsequent SQL-test
-- tasks (T018, T019, T020, T030, T031, T037, T038, T039) have a known-good baseline.
--
-- This is NOT a slice-001 assertion — it only verifies that the pgTAP extension
-- loads and that `supabase test db --file <path>` can run a trivial plan against
-- the local Supabase stack.
--
-- Pattern: classic pgTAP transactional test wrapper (BEGIN / plan / asserts /
-- finish / ROLLBACK) so the harness leaves no residue in the database.

BEGIN;

SELECT plan(1);

SELECT ok(true, 'pgtap harness boots');

SELECT * FROM finish();

ROLLBACK;
