# Slice 005 follow-up: `peer_pick_v` / `peer_final_pick_v` security model didn't match design intent

**Filed**: 2026-05-23
**Discovered by**: slice 005 peer-pick suite after the leaderboard cascade was unblocked.
**Severity**: high — every non-admin participant signed in via Supabase Auth saw an empty `peer_pick_v` / `peer_final_pick_v` regardless of lock state. The entire FR-016 contract (US3 acceptance set Tests 2/3/7/8/9) was impossible to satisfy under the original security posture.
**Surface**:
- `supabase/migrations/0054_leaderboard_views.sql` (both peer views, `security_invoker = true`)
- `supabase/migrations/0032_predictions_rls.sql` + `0042_final_predictions_rls.sql` (self-only RLS on the underlying tables)
- `apps/web/tests/playwright/slice-005-peer-pick-visibility.spec.ts` (the suite that surfaced this)

This is the **same class of failure as 0081's `leaderboard_v` fix** — a view whose entire purpose is cross-participant aggregation was shipped with `security_invoker = true`, which made the underlying tables' self-only RLS shadow the view's own visibility predicates.

## Problem

`peer_pick_v` and `peer_final_pick_v` were authored at slot 0054 with `WITH (security_invoker = true)` because the leading comment in 0054 said:

> All three views use WITH (security_invoker = true) (PG 15+) so the caller's RLS on the
> underlying tables (participants, predictions, final_predictions, score_records, matches)
> is honored automatically.

That posture is **wrong** for any view whose semantics are "show me OTHER participants' data once a gate has fired" — the underlying tables' self-only RLS hides everyone except the caller, *before* the view's lock predicate or self-exclusion clause ever gets a chance to run. The view then dutifully excludes the caller from a set that already contains only the caller, yielding an empty result for every non-admin reader.

The relevant policies:

| Table | SELECT policy | Effect under security_invoker |
|-------|---------------|-------------------------------|
| `predictions` | `participant_id IN (caller)` (self) OR `is_admin` | Non-admins see only their own predictions inside `peer_pick_v` |
| `final_predictions` | `participant_id IN (caller)` (self) OR `is_admin` | Non-admins see only their own picks inside `peer_final_pick_v` |
| `participants` | `auth_user_id = auth.uid()` (self) OR `is_admin` | Non-admins can't resolve other participants' display_name JOINs |

Net result for alpha (a non-admin participant) GETting `/api/peer-pick/<post-lock-match-id>`:

1. The view's defining query runs under alpha's RLS.
2. `predictions` RLS scopes the source set to alpha's row only.
3. The view's `pr.participant_id NOT IN (caller)` clause excludes alpha.
4. The view's lock predicate would have been TRUE (lock window has fired), but it never gets a chance to gate anything because the result set is already empty.
5. Route returns `{ "picks": [] }`.

Alpha then sees "no peers submitted yet" indefinitely, which is the exact opposite of FR-016's intent.

Empirical (pre-fix, post-lock state):

```sh
docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims TO '{\"sub\":\"00000000-0000-0000-0000-00000000000a\"}';
  SELECT count(*) FROM public.peer_pick_v WHERE match_id='eeee0053-0000-0000-0000-000000000023'"
#  0           ← post-lock, with 3 alpha/bravo/charlie predictions present
```

## Sibling — JWT extraction was also wrong

The same suite carried over a `extractParticipantJwt` helper from the pre-Keycloak era that read from `window.localStorage`. After slice 001's Keycloak migration, Supabase stores the JWT in `sb-*-auth-token` *cookies* (not localStorage), so Tests 4 and 5 were failing pre-flight with "JWT MUST be extractable" before ever reaching the view. The slice-005-match-scoring follow-up had already shipped a cookie-based extractor (`extractAccessTokenFromBrowserContext`); the peer-pick spec now uses the same pattern.

This is independent of the RLS gap but landed in the same commit because both failure modes blocked the same tests.

## Sibling — pre-lock buffer was too tight

Tests 1, 4, 5 created M_TEST with `kickoff = now + 60min + 1s` to assert "1 s outside the lock window → pre-lock". Under the original (broken) posture, the RLS bug was the *de facto* gate, so the 1-second margin always succeeded.

After migration 0082, the view's lock predicate is the real gate, and `now()` advances by several seconds during test setup (Keycloak sign-in + cookies + PostgREST round-trip). The 1-second pre-lock buffer was getting consumed before the query ran, leaving the predicate marginally TRUE and the suite seeing post-lock data when it expected pre-lock.

The fix is mechanical: bump the buffer to 5 min (`now + 65min`), well outside any realistic test latency. The strict-equality boundary assertion still lives in Test 2 (kickoff = now + 60min − 50ms, INSIDE the window) so the precise boundary semantics are still covered.

## Solution

Migration `0082_peer_views_security_definer.sql`:

```sql
ALTER VIEW public.peer_pick_v       SET (security_invoker = false);
ALTER VIEW public.peer_final_pick_v SET (security_invoker = false);
GRANT SELECT ON public.peer_pick_v       TO authenticated;
GRANT SELECT ON public.peer_final_pick_v TO authenticated;
```

Under DEFINER posture:
- The view's defining query runs as its owner (postgres) and bypasses the underlying tables' RLS.
- The view's own `WHERE` clause becomes the actual gate: lock predicate (`now() >= kickoff_utc - lock_window` or `now() >= first_kickoff_utc`) AND self-exclusion (`participant_id NOT IN (caller)`).
- `auth.uid()` still resolves to the caller's identity (PostgREST sets `request.jwt.claims` at the session level, not at view-execution scope).
- Underlying tables' RLS is untouched — direct `/rest/v1/predictions` calls still deny non-self / non-admin reads, preserving SC-009.

## Verification

After applying migration 0082 + JWT helper fix + pre-lock buffer widening:

```
✓ Test 1  — pre-lock kickoff=now+65min            — picks=[]            (1.8s)
✓ Test 2  — at-boundary kickoff=now+60min−50ms    — picks=[bravo,charlie] (1.8s)
✓ Test 3  — post-lock kickoff=now+30min           — picks=[bravo,charlie] (1.7s)
✓ Test 4  — direct REST pre-lock (alpha)           — body=[]              (1.6s)
✓ Test 5  — direct REST pre-lock (admin1)          — body=[]              (2.0s)
- Test 6  — admin_invalidated mask (fixme — slice 006)
✓ Test 7  — final pre-first-kickoff                — pick=null            (1.8s)
✓ Test 8  — final at-first-kickoff boundary        — pick.champion=BRA   (1.7s)
✓ Test 9  — final post-first-kickoff               — pick=full           (1.8s)
✓ Test 10 — final self-exclusion                   — pick=null            (1.6s)
```

9 passing, 1 skipped (Test 6 awaits slice 006).

## Status

**Implemented (DEFINER + helper fixes)** — 2026-05-23. Migration `0082_peer_views_security_definer.sql` + spec updates.

## Related

- [follow-up-leaderboard-rls-design-gap.md](./follow-up-leaderboard-rls-design-gap.md) — same root cause, fixed in migration 0081.
- The pre-Keycloak `extractParticipantJwt` helper was carried over from slice-001's mock-oauth2-server era; the cookie-based replacement matches the slice-005-match-scoring fix.
- D-T023-2 (Test 6 / admin_invalidated mask) is unchanged by this follow-up — it still awaits slice 006's admin_invalidations surface to ship.
