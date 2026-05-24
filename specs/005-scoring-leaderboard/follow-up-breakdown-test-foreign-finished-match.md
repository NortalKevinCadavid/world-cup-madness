# Slice 005 follow-up: `slice-005-breakdown.spec.ts` AS1 expects 3 match rows, view yields 4 (slice-002 bleed-through)

**Filed**: 2026-05-23
**Discovered by**: slice 001 OIDC fixture follow-up triage cascade (after fixing #5 above unblocked AS1's actual assertion).
**Severity**: low — the view's behavior is correct by design; only the test's assertion is wrong about its precondition. No production data shape implications.
**Surface**:
- `apps/web/tests/playwright/slice-005-breakdown.spec.ts` (AS1 assertion at line ~482, possibly others)
- `supabase/migrations/0078_personal_breakdown_view.sql` (the view that yields 4 rows by design)

## Problem

Slice 005's AS1 test expects exactly 3 match-target_kind rows in alpha's personal breakdown:

> Then exactly 3 rows MUST render with target_kind='match' AND each MUST report
> predicted/official scores + points=10 + reason_code='exact' per fixture truth table

```ts
expect(
  matchRows.length,
  "alpha's breakdown MUST contain exactly 3 rows with target_kind='match' (one per finished match in the slice-005 fixture: M1, M2, M3)",
).toBe(3);
```

Empirical observation today: alpha's breakdown has **4** match rows, not 3.

## Root cause

The slice-005 view `personal_breakdown_v` (migration 0078) renders one match-row **per finished match in the DB**, not per finished slice-005 match:

```sql
match_rows AS (
  SELECT ... 'match'::public.score_target_kind AS target_kind, m.id AS target_id, ...
    FROM caller c
    CROSS JOIN public.matches m                    -- ← every finished match
    JOIN public.match_results mr ON mr.match_id = m.id
    LEFT JOIN public.score_records sr
      ON sr.participant_id = c.participant_id
     AND sr.target_kind    = 'match'
     AND sr.target_id      = m.id
     AND sr.calculation_version = (SELECT current_version FROM cv)
   WHERE m.status = 'finished'                     -- ← any tournament/source
)
```

The DB state after `supabase db reset` (now that follow-up #3 made slice-005-fixture.sql actually load):

```sh
docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SELECT m.id, m.status FROM public.matches m
   WHERE m.status = 'finished' ORDER BY m.id"
#  bbbb0000-0000-0000-0000-000000000001 | finished   ← slice-002 fixture
#  eeee0050-0000-0000-0000-000000000001 | finished   ← slice-005 fixture (M1)
#  eeee0050-0000-0000-0000-000000000002 | finished   ← slice-005 fixture (M2)
#  eeee0050-0000-0000-0000-000000000003 | finished   ← slice-005 fixture (M3)
```

Alpha gets all 4 rows in her breakdown — including the slice-002 `bbbb0000-…001` match she never predicted. That row's `reason_code='none'` and `predicted_display=''` and `points=0` (no prediction → score_match wrote a 'none' row OR the LEFT JOIN yields the default 'none'). **This is the contract's documented behavior**, not a bug — the view's design comment at line 114 is explicit:

> One row per (caller, finished match). LEFT JOIN score_records so a missing
> score row (defensive: should not happen because score_match writes a 'none' row
> for every eligible participant, but the LEFT JOIN is the data-model contract)
> yields points=0 / reason_code='none' / official_display from match_results.

The test was written against an earlier DB state (when slice-005-fixture.sql wasn't auto-loaded AND/OR slice-002's bbbb0000-001 didn't yet have `status='finished'`). The slice-002 fixture indeed has `bbbb0000-001` marked finished — that's been the case for some time; the test only just got to run far enough today (after follow-ups #1–#5) to see it.

## Why this was hidden until 2026-05-23

Same masking story as #4 and #5: the slice 005 Playwright suite couldn't reach this assertion because the OIDC pre-flight (follow-up #2), seed loading (#3), and the SP's `triggered_by NULL` bug (#5) all blocked progress. With those four closed, AS1 finally executes its actual SQL queries — and surfaces the test's stale assumption.

## Fix options

### Option A — Filter the test's match-row set to slice-005's UUIDs (recommended)

```ts
// Was:
const matchRows = allRows.filter((r) => r.target_kind === "match");
expect(matchRows.length, "...").toBe(3);

// Becomes:
const slice005MatchIds = new Set([M1, M2, M3]);  // already declared as constants
const matchRows = allRows.filter(
  (r) => r.target_kind === "match" && slice005MatchIds.has(r.target_id),
);
expect(matchRows.length, "...").toBe(3);
```

Same change in AS3 / SC-002 (which sums breakdown rows against the leaderboard truth) — that assertion needs to account for slice-002's bbbb0000-…001 row contributing 0 points (so the sum stays consistent), OR filter the sum to slice-005 matches and compare against slice-005's expected subtotal.

**Pros**: smallest surface, no schema or view change, no impact on other slices. The view's behavior remains correct per its contract.

**Cons**: future fixture additions that finish another match in any prior slice will trigger the same kind of test fragility. A defensive comment in the test should explain the filter ("the breakdown view CROSS JOINs against EVERY finished match in the DB by design — the test filters to slice 005's match UUIDs so other slices' fixtures don't bleed into the count").

### Option B — Extend `personal_breakdown_v` with a tournament filter

If/when a multi-tournament data model lands, the view would add `WHERE m.tournament_id = current_tournament()`. Today `tournament_id` doesn't exist on `public.matches` — it's the same OD-? deferral that several other surfaces inherit. Out of scope for fixing this test.

### Option C — Remove the slice-002 `bbbb0000-001` finished status

Slice 002's own tests rely on bbbb0000-001 being finished (per its quickstart and acceptance criteria). Changing it would break slice 002. Don't.

### Option D — Add the bbbb0000-001 row to slice 005's truth table

Update the AS1 assertion to expect 4 match rows (3 slice-005 + 1 slice-002), and add a 4th expected row entry to the truth table with `predicted_display=''`, `points=0`, `reason_code='none'`.

**Pros**: aligns the test with the actual view contract.

**Cons**: makes the slice 005 test directly aware of slice 002's fixture (cross-slice coupling). If slice 002's fixture changes its finished-match set, slice 005's truth table breaks again.

### Recommendation

**Option A**. The filter-by-UUID approach is the smallest change that respects the view's contract and keeps the slice 005 test self-contained.

## Affected tests (likely; verify by running)

- `slice-005-breakdown.spec.ts` AS1 (`Expected: 3, Received: 4`) — confirmed today.
- `slice-005-breakdown.spec.ts` AS3 / SC-002 — likely affected; sums all breakdown rows against leaderboard total. The bbbb0000-…001 row contributes points=0, so the sum invariant *might* still hold, but the row count assertion definitely won't.
- `slice-005-leaderboard.spec.ts` — likely NOT affected (the leaderboard aggregates `score_records`, not the view; rows for matches alpha didn't predict shouldn't exist in `score_records` unless score_match wrote a 'none' row for her).

## Estimated effort

15-30 minutes. Update 1-3 specs with the filter, document the rationale inline, re-run to verify.

## Owner

Slice 005 owner.

## Status

**Open** — pending implementation.
