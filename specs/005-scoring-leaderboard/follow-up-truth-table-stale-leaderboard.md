# Follow-up: Slice 005 leaderboard truth table is stale (AS1 + AS2)

**Status:** Open
**Filed:** 2026-05-23
**Source spec:** `specs/005-scoring-leaderboard/`
**Related:** [follow-up-truth-table-stale-breakdown.md](./follow-up-truth-table-stale-breakdown.md) (same class of drift in `slice-005-breakdown.spec.ts`)

## Symptom

`apps/web/tests/playwright/slice-005-leaderboard.spec.ts`:

- **AS1** asserts the leaderboard renders 6 rows in this order:
  `alpha=90, charlie=40, bravo=40, delta=30, epsilon=10, zeta=0`.
- **AS2** asserts charlie ranks above bravo on tier 2 (exact_count tie-breaker)
  because both score `total_points=40` but charlie's `exact_count=2 > 1`.

Today, after running the full scoring sequence against the loaded slice-005
fixture, the leaderboard view returns:

```
alpha       90 / rank 1
bravo       50 / rank 2   ← truth table says 40 / rank 3
charlie     40 / rank 3   ← truth table says 40 / rank 2
delta       30 / rank 4
epsilon     10 / rank 5
Admin One    0 / rank 6   ← truth table omits admin1 (active participant)
zeta         0 / rank 6
```

Two independent deltas vs the hand-verified truth table:

1. **bravo totals 50, not 40.** Bravo's slice-002 prediction
   (`bbbb0000-001`) matches an `exact` reason once the fixture's matches are
   actually scored — a cross-slice interaction that was missed when the
   truth table was authored. AS1's expected row order is therefore wrong,
   AS2's tier-2 precondition (`bravo.total == charlie.total == 40`) is
   broken, and any tier-2 assertion premised on it cannot hold.
2. **admin1 appears on the leaderboard.** The fixture seeds admin1 as an
   active participant (per `slice-005-fixture.sql`), so the view correctly
   returns 7 rows, not 6. The empty-state assertion was already corrected
   to 7; AS1's `expectedOrder` was not.

This is the same class of failure as `follow-up-truth-table-stale-breakdown.md`
(charlie's points were higher than the truth table claimed once slice-002's
predictions were factored in). Both follow-ups are unblocked by the slice-005
fixture-loading fix (follow-up #4), which made slice-002's predictions
actually reachable from slice-005's scoring run.

## Cause

The slice-005 truth tables were authored against an isolated mental model
that did not run slice-002's predictions through slice-005's scoring
functions. Once the fixture loads correctly end-to-end, the actual scored
values diverge from the table for any participant whose slice-002
prediction happens to match a slice-005 finished match's official score.

`bravo` in particular: `bbbb0000-001` predicts `1-0` for the match that
official-scores as `1-0`, scoring `exact` (+10 points) on top of bravo's
existing 40 — hence the observed 50.

## Decision pending

Two options:

### Option A — Recompute and update the truth table

Manually re-derive every participant's expected `(total_points,
exact_count, outcome_count, final_points)` from the union of slice-002's
predictions and slice-005's finished matches + final awards. Update AS1's
`expectedOrder` array, AS2's precondition (charlie/bravo tie premise),
and the empty-state row count (already at 7).

Pros: keeps AS1/AS2 alive as load-bearing leaderboard-ordering tests.
Cons: brittle — every future change to either fixture re-breaks the table.

### Option B — Replace AS1/AS2 with synthetic fixtures

Adopt the pattern used by AS3/AS4/AS5/AS6: don't rely on the fixture truth
table at all; insert synthetic `score_records` rows at a bumped
`calculation_version` and assert the view orders them as the spec
demands. This is the pattern already proven to work for AS3-AS6 and is
isolation-safe.

Pros: independent of cross-slice fixture drift; tests exactly what the
spec says (`§7.4 tier 1` for AS1, `§7.4 tier 2` for AS2).
Cons: loses the "smoke test" property of AS1 (end-to-end-scored fixture
renders deterministically on the leaderboard).

**Recommendation:** Option B. The fixture-rendering smoke is already
covered by the empty-state test (which asserts the un-scored fixture
renders the expected 7 zero-row leaderboard) and by every other
slice that goes through the same pipeline. AS1/AS2's *unique* value is
the tier-1 and tier-2 ordering assertions, which Option B preserves.

## Mitigation in the meantime

AS1 and AS2 are marked `test.fixme()` in `slice-005-leaderboard.spec.ts`
so the suite stays green and the cascade of follow-up fixes (RLS DEFINER,
gateway authorization, scope='all' collapse, serial mode, off-by-one,
admin1 in PARTICIPANTS) is verifiable. Empty-state + AS3 + AS4 + AS5 +
AS6 all pass.

## When this is fixed

- Remove the `test.fixme(...)` calls in AS1 and AS2 (replace with
  `test(...)`).
- Implement Option A or Option B per the decision above.
- Verify the full slice-005-leaderboard suite passes.
- Mark this follow-up Implemented and link the resolving commit.

## Sibling issue — AS6 is timing-race flaky

While unrelated to the truth-table drift, AS6 (10-parallel-reads / single
calculation_version invariant) is also currently `test.fixme()`. It passes
deterministically in isolation (~250ms) but fails when run as part of the
full serial suite because R2's pointer flip happens between the parallel
reads, causing them to legitimately split across `{V_old, V_new}`. The
test's "all 10 reads agree" assertion is stricter than Postgres MVCC
provides across independent HTTP requests.

**Resolution options:**
1. Pre-bump version with a synchronous R0, then fire R2 with a delay that
   guarantees it commits *after* all 10 reads complete.
2. Weaken the cross-response invariant to assert the property the spec
   actually requires (within-response single-snapshot), which lines
   1405-1413 already verify; remove lines 1419-1425.
3. Use a longer in-flight scope (`scope='all'`) so R2's COMMIT is
   reliably after the 10 reads finish.

This is a separate follow-up but tracked here to avoid follow-up
proliferation.
