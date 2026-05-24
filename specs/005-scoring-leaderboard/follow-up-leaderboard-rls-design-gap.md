# Slice 005 follow-up: `leaderboard_v` security model didn't match its design intent

**Filed**: 2026-05-23
**Discovered by**: slice 005 leaderboard spec the off-by-one cascade unblocked.
**Severity**: high — every non-admin participant signed in via Supabase Auth sees a leaderboard with only their own row instead of the full ranking. The entire US3 acceptance set (AS1–AS6 + empty-state) is impossible to satisfy under the original security posture.
**Surface**:
- `supabase/migrations/0054_leaderboard_views.sql` (the view, `security_invoker = true`)
- `supabase/migrations/0056_score_rls.sql` (the score_records RLS posture)
- `apps/web/tests/playwright/slice-005-leaderboard.spec.ts` (the test that surfaced this)

## Problem

The `leaderboard_v` view (slot 0054) was authored with `WITH (security_invoker = true)`. Per the migration's leading comment:

> All three views use WITH (security_invoker = true) (PG 15+) so the caller's RLS on the
> underlying tables (participants, predictions, final_predictions, score_records, matches)
> is honored automatically.

That works for the peer views (`peer_pick_v`, `peer_final_pick_v`) where RLS does meaningful self-exclusion + lock-window gating, but **not** for `leaderboard_v`, whose entire purpose is to aggregate score_records across every eligible participant.

The `score_records` table's SELECT policies (`supabase/migrations/0056_score_rls.sql`) are:

| Policy | Predicate |
|--------|-----------|
| `score_records_self_read` | `participant_id IN (SELECT id FROM participants WHERE auth_user_id = auth.uid()) AND is_eligible_nortal_participant(auth.uid())` |
| `score_records_admin_read` | `is_admin(auth.uid())` |

A non-admin participant — signed in as e.g. `alpha@nortal.com` — gets `self_read`. The view's aggregation CTE sees only alpha's rows; the leaderboard collapses to a single row.

Empirical:

```sh
docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims TO '{\"sub\":\"00000000-0000-0000-0000-00000000000a\"}';
  SELECT count(*) FROM public.leaderboard_v"
#  1            ← (was 0 before the off-by-one fix; now 1, with alpha's row)
```

When the SAME view is queried as `postgres` (bypassing RLS), it returns 7 rows (the 7 active fixture participants). The view's behavior is correct; the access posture is wrong.

## Why this was hidden until 2026-05-23

The slice 005 leaderboard spec sits behind the same cascade as the rest of slice 005's tests:
1. OIDC fixture's pre-flight 404 (follow-up #2) — blocked sign-in.
2. seed-loading missing slice-005-fixture.sql (follow-up #3) — no FINISHED_MATCHES.
3. `triggered_by: null` NOT NULL violation (follow-up #5) — every scoring call 500'd.
4. SP/view off-by-one (follow-up #6) — even after scoring, views returned zero.
5. Sequential scope='match' loop bumping the version 4× (closed in follow-up #6 via scope='all').
6. **This issue.** With everything else cleared, the leaderboard test finally reaches its row-count assertion — and surfaces this RLS gap.

The slice 005 author's docstring about FR-014 display_name masking strongly suggests they *intended* the leaderboard to be visible to every participant (with non-self display_names masked per `tournament_config.leaderboard_visibility`). The RLS posture just never matched that intent.

## Fix options

### Option A — Flip `leaderboard_v` to `security_invoker = false` (recommended; landed)

```sql
ALTER VIEW public.leaderboard_v SET (security_invoker = false);
```

The view runs with the view owner's privileges (`postgres`), bypassing RLS on score_records. **Privacy is preserved by the view's column set**: the view exposes only aggregate columns (rank, totals, masked display_name) — never per-prediction details. Direct queries against `score_records` are still RLS-protected: a non-admin participant calling `SELECT * FROM score_records` still sees only their own rows.

**Pros**: minimal change, single migration. Aligns the view's actual behavior with its documented design intent. Peer views stay `security_invoker = true` (they correctly need per-caller RLS for self-exclusion + lock-window gating).

**Cons**: a future addition of a sensitive column to leaderboard_v would silently leak to every caller. Mitigation: document this in the migration's header (done) and in `docs/architecture/scoring-model.md` (recommended follow-up).

### Option B — Add a `score_records_leaderboard_read` RLS policy

```sql
CREATE POLICY score_records_leaderboard_read ON public.score_records
  FOR SELECT TO authenticated
  USING (is_eligible_nortal_participant(auth.uid()));
```

Lets every eligible participant query `score_records` directly. The view stays `security_invoker = true`.

**Pros**: preserves the "RLS is the authoritative gate" posture.

**Cons**: a privacy regression. Every eligible participant can now `SELECT * FROM score_records` via the REST API and read every other participant's predictions (predicted_home, predicted_away) and per-row points. That's a substantial new disclosure surface. Rejected.

### Option C — Move aggregation into a SECURITY DEFINER RPC

Wrap the leaderboard aggregation in a `public.get_leaderboard()` RPC function declared `SECURITY DEFINER`. The function bypasses RLS internally and returns aggregate rows; the view goes away.

**Pros**: explicit function boundary; easier to audit which columns escape RLS.

**Cons**: substantially more invasive (changes the read surface from a view to an RPC). The Next.js app at `apps/web/lib/scoring/leaderboard.ts` reads from `leaderboard_v` via PostgREST; switching to an RPC requires app-code changes. Deferred.

## Recommendation

**Option A** — landed in `supabase/migrations/0081_leaderboard_v_security_definer.sql`.

## Verification

After applying migration 0081:

```sh
docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims TO '{\"sub\":\"00000000-0000-0000-0000-00000000000a\"}';
  SELECT count(*) FROM public.leaderboard_v"
# 7   ← alpha now sees the full leaderboard (7 fixture participants)

docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims TO '{\"sub\":\"00000000-0000-0000-0000-00000000000a\"}';
  SELECT count(*) FROM public.score_records"
# 8   ← alpha STILL only sees her own score_records directly (RLS unchanged)
#       (8 is alpha's 3 match + 4 final + system-participant aggregation row, depending on state)
```

## Status

**Implemented (Option A)** — 2026-05-23. Migration `0081_leaderboard_v_security_definer.sql`.
