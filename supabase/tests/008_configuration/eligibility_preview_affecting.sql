-- eligibility_preview_affecting.sql
-- Slice 008 Tournament Configuration | Task T029 | US1
--
-- Spec anchors:
--   spec.md  US1 -- "Admin updates a tournament configuration value." When
--   the value is eligibility.allowed_domains and the change REMOVES a
--   domain that currently has participants, admin_config_preview must
--   surface the impact and mint an acknowledge_token so the subsequent
--   admin_config_upsert can prove the operator was warned.
--
-- Contract source of truth:
--   contracts/admin-config-rpcs.write.md  Behavior -- admin_config_preview:
--   "Returns jsonb { affecting: bool, summary: text, sample: jsonb,
--    acknowledge_token: uuid|null }. For eligibility.allowed_domains the
--    body MUST count participants whose email domain is in the CURRENT
--    list but NOT in the proposed value (i.e., would be removed) and
--    populate sample with up to 5 example participants. When affecting=
--    true the body MUST issue an acknowledge_token (HMAC-signed, 5-min
--    TTL via public.issue_acknowledge_token). When affecting=false the
--    acknowledge_token MUST be NULL."
--
-- Implementation reference: supabase/migrations/0077_configuration.sql
--   T012 admin_config_preview (lines 732..944), specifically the
--   eligibility.allowed_domains branch at lines 781..820 (computes
--   v_removed_domains via EXCEPT, joins participants on the lowered
--   email domain, builds v_sample with jsonb_build_object('participant_
--   id', p.id, 'email', p.email::text)) and the token-issuance branch at
--   lines 928..930 (v_token := issue_acknowledge_token(...)).
--
-- Test scope (plan(6) -- 6 assertions across affecting + non-affecting):
--   A1: Removing every domain ("unrelated.com" replaces ["nortal.com"])
--       -> result.affecting = true. Slice 001 fixture seeds 3+ active
--       participants on @nortal.com (alpha, bravo, charlie), so the
--       removed-domain set EXCEPT new-domain set = {"nortal.com"} and the
--       participant-domain JOIN populates a non-zero v_count.
--   A2: result.summary text matches '\d+ participant' (the implementation
--       formats "...will deactivate %s existing participant(s)..." which
--       always contains the digit-count followed by " participant").
--   A3: result.sample is a jsonb array with at least one nortal.com
--       entry (the contract caps sample size at 5; we only assert >=1
--       so the test is robust regardless of how many nortal.com rows
--       exist at execution time).
--   A4: result.acknowledge_token is non-null when affecting=true
--       (issue_acknowledge_token returns a uuid; verifies the HMAC
--       token-mint path is exercised).
--   A5: Calling preview with the CURRENT value unchanged (no-op) yields
--       affecting=false. The EXCEPT subquery returns no rows, so
--       v_removed_domains IS NULL and the branch never sets v_affecting.
--   A6: result.acknowledge_token is NULL when affecting=false (no token
--       should be minted for a no-op change).
--
-- Out of scope (covered by sibling tasks):
--   * T024/T025/T026 -- upsert authorization / concurrency / validation.
--   * T028 (Playwright config-domains.spec.ts) -- end-to-end UI flow.
--   * T032 -- locking-window consumer behavior post-upsert.
--
-- Impersonation pattern:
--   admin_config_preview is SECURITY DEFINER and gates on is_admin(
--   auth.uid()) (slot 0077 lines 760..772). We set request.jwt.claims to
--   admin1's auth_user_id and SET LOCAL ROLE authenticated so the RPC
--   sees an admin caller. Slice 001 fixture seeds admin1 with
--   auth_user_id = 00000000-0000-0000-0000-0000000000d3.
--
-- Fixture choices:
--   Key: 'eligibility.allowed_domains' (seeded by slot 0077 line 282 to
--   '["nortal.com"]'). To exercise the "affecting=true" branch we propose
--   '["unrelated.com"]' which removes "nortal.com" entirely; slice 001's
--   alpha/bravo/charlie@nortal.com participants populate the sample. For
--   the no-op branch we re-submit the captured current value verbatim so
--   the EXCEPT yields zero removed domains.
--
-- Pattern: BEGIN / plan(6) / asserts / finish / ROLLBACK. The ROLLBACK
-- means none of the audit_log inserts (from any unexpected denial path)
-- or token-table inserts (issue_acknowledge_token writes to
-- _admin_acknowledge_tokens) persist beyond the test session.

BEGIN;

SELECT plan(6);

-- ---------------------------------------------------------------------------
-- Setup: switch into admin1 context so admin_config_preview's is_admin
-- gate (slot 0077 L760..772) accepts the call. Also capture the current
-- value of eligibility.allowed_domains so A5 can re-submit it verbatim
-- without hard-coding the seed JSON (defends against future seed drift).
-- ---------------------------------------------------------------------------
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d3',
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

-- Capture current seeded value as text under postgres (we are inside SET
-- LOCAL ROLE authenticated, but tournament_config SELECT is permitted by
-- the tournament_config_authenticated_read policy for admins -- and
-- admin1 is_admin=true via slice 006 seed). Using session-scoped
-- set_config (is_local=false) so it survives the RESET ROLE used between
-- assertion blocks.
SELECT set_config(
  'test.current_value',
  (SELECT value::text
     FROM public.tournament_config
    WHERE key = 'eligibility.allowed_domains'),
  false
);

-- ---------------------------------------------------------------------------
-- Drive the affecting=true preview ONCE and stash the result so A1..A4 can
-- inspect different facets of the same return value (cheaper than calling
-- the RPC four times and guarantees consistency across assertions).
-- Proposed value '["unrelated.com"]' removes "nortal.com" entirely, which
-- joins to alpha/bravo/charlie@nortal.com (slice 001 fixture) plus admin1
-- itself, so v_count >= 1 is guaranteed.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'test.preview_result',
  (SELECT public.admin_config_preview(
            'eligibility.allowed_domains'::text,
            '["unrelated.com"]'::jsonb
          )::text),
  false
);

-- ---------------------------------------------------------------------------
-- A1: removing the only seeded domain triggers affecting=true.
-- The implementation sets v_affecting:=true only when v_count > 0 (slot
-- 0077 L804..819). Slice 001 fixture guarantees at least 3 nortal.com
-- participants, so this assertion is deterministic.
-- ---------------------------------------------------------------------------
SELECT is(
  ((current_setting('test.preview_result')::jsonb) ->> 'affecting')::boolean,
  true,
  'A1: removing nortal.com (active participants exist) -> affecting=true'
);

-- ---------------------------------------------------------------------------
-- A2: summary contains a participant count. The format() call at slot
-- 0077 L806..809 produces "Removing domain(s) ... will deactivate N
-- existing participant(s) at next eligibility re-check." The regex
-- '\d+ participant' matches the "N participant" fragment regardless of
-- the exact count or any future wording tweaks that preserve the
-- count-then-noun pattern.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  (current_setting('test.preview_result')::jsonb) ->> 'summary',
  '~',
  '\d+ participant',
  'A2: summary contains participant count'
);

-- ---------------------------------------------------------------------------
-- A3: sample is a jsonb array with >= 1 affected participant. The
-- implementation builds v_sample via jsonb_agg(jsonb_build_object(
-- 'participant_id', p.id, 'email', p.email::text)) and caps it at 5
-- entries (slot 0077 L810..818). We only assert >=1 to keep the test
-- robust against future participant inserts.
-- ---------------------------------------------------------------------------
SELECT cmp_ok(
  jsonb_array_length(((current_setting('test.preview_result')::jsonb) -> 'sample')),
  '>=',
  1,
  'A3: sample has >= 1 affected participant'
);

-- ---------------------------------------------------------------------------
-- A4: acknowledge_token is non-null when affecting=true. The
-- implementation only calls issue_acknowledge_token(...) when
-- v_affecting is true (slot 0077 L928..930) and stores the returned uuid
-- in v_token. isnt() with an explicit ::text NULL forces the type-
-- inference for the comparison to text, matching the ->> extraction.
-- ---------------------------------------------------------------------------
SELECT isnt(
  ((current_setting('test.preview_result')::jsonb) ->> 'acknowledge_token'),
  NULL::text,
  'A4: acknowledge_token issued when affecting=true'
);

-- ---------------------------------------------------------------------------
-- A5: no-op preview (re-submit current value verbatim) -> affecting=false.
-- The EXCEPT in slot 0077 L786..792 returns zero rows when the current
-- and proposed arrays are identical, so v_removed_domains stays NULL and
-- v_affecting never flips. RESET ROLE briefly so set_config in the
-- enclosing SELECT picks up postgres-role privileges for any downstream
-- catalog read; then re-set the JWT and role for the RPC call. Both the
-- token-table INSERT and v_token assignment are skipped.
-- ---------------------------------------------------------------------------
SELECT set_config(
  'test.preview_noop',
  (SELECT public.admin_config_preview(
            'eligibility.allowed_domains'::text,
            current_setting('test.current_value')::jsonb
          )::text),
  false
);

SELECT is(
  ((current_setting('test.preview_noop')::jsonb) ->> 'affecting')::boolean,
  false,
  'A5: re-submitting current value (no removal) -> affecting=false'
);

-- ---------------------------------------------------------------------------
-- A6: no acknowledge_token when affecting=false. v_token defaults to
-- NULL (slot 0077 L749) and the issue_acknowledge_token branch (L928)
-- is gated on v_affecting, so the RETURN jsonb_build_object sets
-- 'acknowledge_token' to NULL. ->> 'acknowledge_token' extracts SQL NULL
-- from a JSON null, which is() compares with NULL::text successfully.
-- ---------------------------------------------------------------------------
SELECT is(
  ((current_setting('test.preview_noop')::jsonb) ->> 'acknowledge_token'),
  NULL::text,
  'A6: no acknowledge_token when affecting=false'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
