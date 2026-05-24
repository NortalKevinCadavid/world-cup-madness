# Slice 005 follow-up: `current_calculation_version` is +1 ahead of the records the views need

**Filed**: 2026-05-23
**Discovered by**: slice 001 OIDC fixture follow-up triage cascade — after follow-ups #1–#6 closed, this is the next bug AS1 surfaces.
**Severity**: high — every reader view (`leaderboard_v`, `personal_breakdown_v`) returns zero score data after a scoring run completes. The aggregates and breakdown UI display empty/zero state even though `score_records` rows exist. No data corruption; pure visibility bug.
**Surface**:
- `supabase/migrations/0052_score_match_fn.sql` (and the sibling SPs at slots 0053 + 0058)
- `supabase/migrations/0054_leaderboard_views.sql` (leaderboard_v + peer views)
- `supabase/migrations/0078_personal_breakdown_view.sql`

## Problem

The SP at slot 0052 (`score_match`) implements the following sequence:

```sql
-- Step 4: read the current pointer into v_target_version.
SELECT (value)::int INTO v_target_version
  FROM public.tournament_config
 WHERE key = 'current_calculation_version';
-- v_target_version is now the CURRENT pointer (e.g., 1)

-- Step 6: INSERT score_records at v_target_version.
... calculation_version: v_target_version ...      -- writes at v=1

-- Step 7: bump the pointer to v_target_version + 1.
UPDATE public.tournament_config
   SET value = to_jsonb(v_target_version + 1), ...
 WHERE key = 'current_calculation_version';
-- pointer is now v=2; the SP's own writes are at v=1.
```

The view `leaderboard_v` (and the structurally-identical `personal_breakdown_v`) read at the current pointer:

```sql
WITH cv AS (
  SELECT (value)::int AS current_version
    FROM public.tournament_config
   WHERE key = 'current_calculation_version'
)
...
LEFT JOIN public.score_records sr
  ON ...
 AND sr.calculation_version = (SELECT current_version FROM cv)   -- reads at v=2
```

Net effect: after a scoring run completes, **`score_records` exist at v=1 but the views filter at v=2** — the records are invisible to every reader. The leaderboard shows 0/rank=1 for every participant; the breakdown shows points=0/reason_code='none' for every match row.

## Empirical confirmation

After `pnpm supabase db reset` + one `POST /functions/v1/score-trigger { scope: 'match', target_id: M1 }`:

```sh
docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SELECT key, value FROM public.tournament_config
   WHERE key = 'current_calculation_version'"
#  current_calculation_version | 30      ← bumped

docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SELECT DISTINCT calculation_version FROM public.score_records"
#  29                                    ← records still here, but one version lower

docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SELECT participant_id, total_points, rank FROM public.leaderboard_v"
#  ... all participants total_points=0, rank=1
```

The score_records have alpha at 10 points for M1 (`reason_code='exact'`), but every view returns 0.

## Inconsistency between code and design intent

Two comments in the SP/view migrations contradict each other:

In `0052_score_match_fn.sql` step 4 (around line 230):

> -- The CURRENT pointer is the version the SP writes at. After the INSERTs land
> -- we bump the pointer to v_target_version + 1 so the NEXT distinct-run_id call
> -- lands at the next version. Readers filtering on
> -- tournament_config.current_calculation_version always observe the latest
> -- committed snapshot (R-003).

In `0054_leaderboard_views.sql` (the `cv` CTE):

> R-003: leaderboard_v ONLY exposes rows at current_calculation_version. A
> partially-applied scoring run (v=N+1 rows in score_records, pointer not
> yet flipped) is invisible to readers — this is the FR-012 / SC-008
> [invariant].

The leaderboard comment imagines: SP writes new records at v=N+1, then bumps pointer from N to N+1 in the same transaction. Pre-commit readers see (pointer=N, no rows at N+1). Post-commit readers see (pointer=N+1, rows at N+1). The records are visible at the moment the pointer flips.

The SP code instead implements: SP writes at v=N (the current pointer), then bumps to N+1. Pre-commit readers see (pointer=N, rows at N visible). Post-commit readers see (pointer=N+1, rows still at N — invisible). The bump *hides* the data.

The SP and the view disagree about which side of the bump owns the new version.

## Why this was hidden until 2026-05-23

Same cascade as #3–#6. The OIDC fixture's pre-flight 404 (follow-up #2) prevented the entire slice 005 suite from running. Today: #1–#6 closed in sequence, AS1 finally executed against a real scored database, and this bug surfaced as `points=0` for rows the truth table says should be `points=10`.

## Fix options

### Option A — write at v_target_version + 1 in the SP (recommended)

Patch slots 0052/0053/0058 so the SP writes `score_records.calculation_version = v_target_version + 1`, then bumps the pointer to `v_target_version + 1`. The records are at the new pointer; views find them.

```diff
   -- Step 6: INSERT score_records ...
   INSERT INTO public.score_records (...)
   SELECT
     ...,
-    v_target_version AS calculation_version,
+    v_target_version + 1 AS calculation_version,
     ...
   FROM ...;

   -- Step 7: bump pointer.
   UPDATE public.tournament_config
      SET value = to_jsonb(v_target_version + 1), ...
    WHERE key = 'current_calculation_version';

   -- Step 8: mark run terminal-success.
   UPDATE public.score_calculation_runs
      SET status                       = 'succeeded',
          completed_at                 = now(),
          affected_record_count        = v_affected_count,
-         calculation_version_written  = v_target_version
+         calculation_version_written  = v_target_version + 1
    WHERE id = p_run_id;
```

**Pros**: matches the leaderboard_v comment's intended semantics. SP and views agree on the convention.

**Cons**: changes the `calculation_version_written` value returned to callers. The slice 005 Edge Function tests at `tests/playwright/slice-005-*.spec.ts` likely assert specific values — they need to be re-verified. The slot 0052 comment about T011 A3/A4 ("FIRST run writes at v_initial") would also flip semantics (first run writes at v_initial+1).

### Option B — don't bump the pointer (keep it equal to the latest write)

Drop the `+ 1` in step 7. After the SP, pointer equals v_target_version (the version it just wrote at). The NEXT scoring run reads pointer = v_target_version, increments it locally, writes at v_target_version + 1, sets pointer to v_target_version + 1.

**Pros**: minimal SP change (delete one `+ 1`). Pointer always equals "version of latest committed write."

**Cons**: requires changing the SP's internal logic: `v_target_version := pointer + 1` (not `v_target_version := pointer`) so each run still writes at a NEW higher version. Risk of off-by-one re-introduction.

### Option C — patch the view to read at `pointer - 1`

Single-line change in each of the three reader views (`leaderboard_v`, `peer_pick_v`, `peer_final_pick_v` — wait, no, the peer views don't filter by version; only leaderboard_v and personal_breakdown_v do).

```diff
 WITH cv AS (
-  SELECT (value)::int AS current_version
+  SELECT GREATEST((value)::int - 1, 0) AS current_version
     FROM public.tournament_config
    WHERE key = 'current_calculation_version'
 )
```

**Pros**: smallest patch. View change only; no SP change. Aligns with the SP's existing "pointer = next-slot-to-write" convention.

**Cons**: changes the semantics that the leaderboard_v comment promises ("partially-applied scoring run … is invisible to readers"). Under this fix, a partial run that writes v=N+1 but hasn't bumped the pointer yet would be visible (because the view would read at pointer-1=N, but the writes go to N+1, so actually still invisible — hmm, this works only because of MVCC, not by design).

Actually, on reflection, Option C breaks the SC-008 invariant the slice 005 author called out: readers shouldn't see in-flight writes. Option A is the cleanest.

### Recommendation

**Option A** — write at `v_target_version + 1` AND bump pointer to `v_target_version + 1`. The change-set:

1. `CREATE OR REPLACE FUNCTION` migrations for slots 0052, 0053, 0058 with the patched INSERTs and updated `calculation_version_written` field.
2. Slot 0070 (`admin_trigger_recalc`) — verify; it has its own bump logic that may or may not need the same patch.
3. Update slot 0052/0053/0058 leading comments to remove the contradictory text.
4. Verify against slice 005's `T011 A3/A4` tests (`slice-005-match-scoring.spec.ts`) — those test the version sequence and may need their expected-value assertions updated.

## Estimated effort

2–4 hours. The CREATE OR REPLACE work is mechanical (~3 SPs × ~100 lines each, with 2-3 lines changed per SP). Most of the time goes into re-running the slice 005 suite and updating any tests that assert on specific calculation_version values.

## Affected tests once the SP fix lands

- `slice-005-breakdown.spec.ts` AS1 — should turn green (points=10 instead of 0).
- `slice-005-breakdown.spec.ts` AS3 / SC-002 — same, leaderboard total should be 90 instead of 0.
- `slice-005-leaderboard.spec.ts` (most ASes) — should turn green.
- `slice-005-match-scoring.spec.ts` T011 A3/A4 — may need updated expected calculation_version values.
- `slice-005-final-scoring.spec.ts` — likely needs the same review.

## Cross-references

- `supabase/migrations/0052_score_match_fn.sql` (the bug, in step 4 + step 6 + step 7)
- `supabase/migrations/0053_score_finals_fn.sql` (likely same bug)
- `supabase/migrations/0058_score_all_fn.sql` (likely same bug)
- `supabase/migrations/0054_leaderboard_views.sql` (the reader)
- `supabase/migrations/0078_personal_breakdown_view.sql` (the reader)
- `specs/005-scoring-leaderboard/follow-up-breakdown-test-foreign-finished-match.md` (the follow-up that surfaced this one)

## Status

**Implemented (Option A)** — 2026-05-23.

### What shipped

- **`supabase/migrations/0080_score_fns_off_by_one_fix.sql`** — a single new migration that re-creates the three SPs (`score_match` at slot 0052, `score_finals` at slot 0053, `score_all` at slot 0058) via `CREATE OR REPLACE FUNCTION`. The bodies are extracted verbatim from the original migrations (via a sed/awk pipeline) with two targeted edits per SP:
  - `v_target_version := v_target_version + 1;` is inserted right after the NULL-check on `v_target_version`. The variable now represents the NEW version this run writes at (= current pointer + 1).
  - The pointer-bump `UPDATE` is changed from `value = to_jsonb(v_target_version + 1)` to `value = to_jsonb(v_target_version)`. The pointer now matches the version the records were just written at.

  Original migrations 0052/0053/0058 stay unchanged per the immutability convention for already-applied migrations. The new migration sits at slot 0080 (slot 0079 is `score_runs_triggered_by_fallback.sql`).

- **`apps/web/tests/playwright/slice-005-breakdown.spec.ts`** — `runFullScoringSequence` collapsed from 4 sequential SP calls (scope='match' × 3 + scope='finals') to a single `scope='all'` call. Reason: each scope='match' call bumps the version pointer, so the sequential loop wrote M1@v=2, M2@v=3, M3@v=4, finals@v=5 — and the view filtering at the latest pointer only saw the finals records. The slice 005 author's own docstring noted this collapse was intended "When T037 lands" — and T037 (slot 0058 `score_all`) HAS shipped.

- **Serial mode for slice-005-breakdown + slice-005-final-scoring describe blocks** (`test.describe.configure({ mode: "serial" })`). With `fullyParallel: true` at the Playwright config level, tests in these files would otherwise spawn one worker per test, racing on `tournament_config.current_calculation_version` and tripping `score_records_uk` on the concurrent INSERTs. Serial mode within each file keeps the database-mutating tests linear without slowing down other test files.

- **`apps/web/tests/playwright/slice-005-final-scoring.spec.ts` `callScoreTriggerFinals`** — adds `Authorization: Bearer <anon-key>` to satisfy the Supabase Edge Runtime gateway, mirroring the slice-005-breakdown fix from follow-up-oidc-stub-keycloak-vs-mock-oauth2.md downstream issue #2. The X-Internal-Auth bypass header remains authoritative inside the function for skipping the is_admin check.

### Empirical verification

After `pnpm supabase db reset` to apply migration 0080:

```sh
# Single scope='all' run.
docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SELECT 'pointer' AS what, (value)::int AS v FROM public.tournament_config
   WHERE key='current_calculation_version'
  UNION ALL
  SELECT 'records.versions' AS what, calculation_version FROM public.score_records
  GROUP BY 1, 2"
#  pointer          | 2
#  records.versions | 2    ← pointer now matches the records' version

docker exec supabase_db_world-cup-madness psql -U postgres -c "
  SELECT display_name, total_points, rank FROM public.leaderboard_v ORDER BY rank"
#  Alpha     | 90 | 1     ← all participants now show real scores
#  Bravo     | 50 | 2
#  Charlie   | 40 | 3
#  Delta     | 30 | 4
#  Epsilon   | 10 | 5
#  Admin One |  0 | 6
#  Zeta      |  0 | 6
```

### Test runs

```sh
pnpm exec playwright test tests/playwright/slice-005-breakdown.spec.ts \
  --project=chromium --reporter=list
#  4 passed (13.3s)
#  AS1 (3 match rows, points=10), AS2 (4 final rows), AS3/SC-002 (sum=90), RLS

pnpm exec playwright test tests/playwright/slice-005-final-scoring.spec.ts \
  --project=chromium --reporter=list
#  6 passed (1.6s)
#  AS1, AS2, AS3, AS4, Best-Player-Pending, Flip-pending→confirmed
```

### What remains open after this fix

`slice-005-match-scoring.spec.ts` uses a **different auth model** (admin JWT via cookie, NOT X-Internal-Auth bypass). Its `callScoreTrigger` builds a `Cookie:` header from the signed-in admin's browser context, but does NOT send an `Authorization: Bearer …` header. The Supabase Edge Runtime gateway rejects with `Missing authorization header` before the function code ever sees the cookie.

This is a different fix path than what worked for breakdown + final-scoring. Either:
- The match-scoring helper extracts the admin's JWT from the cookie and forwards it as `Authorization: Bearer <admin-jwt>`, OR
- The test is restructured to use the X-Internal-Auth bypass (consistent with the other slice 005 specs), at the cost of no longer exercising the admin-JWT path.

Not in scope for the off-by-one fix; recommended to file as a separate follow-up if the admin-JWT path is to be preserved.

### Tests confirmed unaffected by the version-semantics shift

The slice 005 author's docstring warned that `T011 A3/A4` in `slice-005-match-scoring.spec.ts` might depend on specific calculation_version values. Inspection (line 727-743) confirms the assertions are RELATIVE (`versionAfterR1 + 1`), not absolute — they encode the "each new run bumps by +1" invariant which my fix PRESERVES. So once the match-scoring gateway-auth issue is resolved, those assertions should pass unchanged.

## Owner

Slice 005 owner.
