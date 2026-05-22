-- participants_rls_mid_session_deny.sql
-- Slice 001-eligibility-login | Task T030
--
-- Spec anchors:
--   FR-002 (server-side re-verification on every authenticated request) and
--   spec.md Clarifications 2026-05-15 ("Block every next authenticated request"
--   when a participant's domain is removed mid-session). Edge case E-3
--   ("previously-eligible participant's domain is removed from the approved
--   list mid-tournament → existing predictions and audit history MUST be
--   preserved, but new sessions MUST be denied. Their currently active
--   session MUST be denied on its next authenticated request — the predicate
--   re-evaluation produces a 403 and the next navigation renders the denial
--   screen; the JWT itself is not server-side revoked.").
--
--   This file exercises layer 4 of the four defense-in-depth layers
--   documented in `supabase/migrations/0007_participants_rls.sql` (the RLS
--   layer). The expectation is that even if the API guard (layer 2) and the
--   predicate function (layer 3) were somehow skipped, RLS alone MUST drop
--   the row from the participant's view the instant their domain leaves the
--   approved list.
--
-- Migration under test:
--   `supabase/migrations/0007_participants_rls.sql` policy
--   `participants_self_or_admin_read` already embeds the eligibility
--   predicate in its USING clause:
--     (auth_user_id = auth.uid()
--        AND public.is_eligible_nortal_participant(auth.uid()))
--     OR public.is_admin(auth.uid())
--   When `eligibility.approved_domains` no longer contains the participant's
--   email domain, `is_approved_domain(email)` returns false, the predicate
--   returns false, and the policy's USING evaluates to false — the row
--   disappears from the participant's SELECT.
--
-- RED / GREEN expectation against the current migration set:
--   GREEN. Migration 0007 (shipped under T012) ALREADY embeds the predicate
--   in the USING clause, and migration 0005 (T023) provides the predicate
--   body. The mid-session-deny behavior is live in the database today.
--
--   The task body in tasks.md (line 1170) anticipated a RED state because
--   the original T012 USING clause was scoped to be `auth_user_id =
--   auth.uid()` only, with the eligibility predicate added later by T034.
--   In the current tree T012's USING already includes the predicate, so
--   T034 is effectively a no-op for the predicate path. Final RED-vs-GREEN
--   status is reconciled by T031's red-gate document and T035's regression
--   checkpoint.
--
-- Fixture persona (supabase/seed/slice-001-fixture.sql):
--   alpha — auth.users.id = 00000000-0000-0000-0000-00000000000a
--         — participants.id = 11111111-1111-1111-1111-111111111111
--         — email alpha@nortal.com, status='active'
--
-- JWT-switching convention used here:
--   Identical to slice-001-api-me-rls.sql. `auth.uid()` resolves to
--     (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
--   so we set `request.jwt.claims` via `SET LOCAL` and `SET LOCAL role
--   authenticated;` to engage the policy. Because migration 0007 REVOKEs
--   UPDATE on `tournament_config` from `authenticated`, we MUST flip back to
--   the test runner's superuser role (RESET role) before the config UPDATE,
--   then return to `authenticated` for the post-update measurement.
--
-- Pattern: BEGIN / plan / asserts / finish / ROLLBACK. The ROLLBACK
-- automatically reverts the tournament_config UPDATE so the seed fixture is
-- restored for any subsequent test file.

BEGIN;

SELECT plan(3);

-- ---------------------------------------------------------------------------
-- Baseline: alpha can read her own row under RLS while her domain is still
-- on the approved list (the seeded state).
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
SET LOCAL role authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.participants),
  1,
  'T1 baseline: alpha JWT + approved domain in config → 1 row visible under RLS'
);

SELECT is(
  (SELECT id FROM public.participants),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'T2 baseline: the one visible row is alpha''s participants.id'
);

-- ---------------------------------------------------------------------------
-- Mid-session domain removal: admin empties the approved-domains list. The
-- UPDATE must run as the test runner's superuser because migration 0007
-- REVOKEs UPDATE on tournament_config from `authenticated`. We RESET role,
-- mutate the config row, then re-engage the authenticated role for the
-- post-mutation measurement. The session JWT claims remain set from above —
-- alpha's JWT is "still valid" in the spec's sense; only the config under it
-- has changed.
-- ---------------------------------------------------------------------------
RESET role;

UPDATE public.tournament_config
   SET value = '[]'::jsonb
 WHERE key = 'eligibility.approved_domains';

SET LOCAL role authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.participants),
  0,
  'T3 mid-session deny: with the same alpha JWT but an empty approved-domains '
  'list, RLS denies the read — 0 rows visible (Clarifications 2026-05-15 / E-3)'
);

-- Restore superuser role before finish() so plan/finish bookkeeping queries
-- run with full privilege. ROLLBACK below reverts the tournament_config
-- UPDATE so the seed fixture is intact for the next test file.
RESET role;

SELECT * FROM finish();

ROLLBACK;
