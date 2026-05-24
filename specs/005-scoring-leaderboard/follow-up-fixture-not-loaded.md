# Slice 005 follow-up: `slice-005-fixture.sql` is never loaded by `supabase db reset`

**Filed**: 2026-05-23
**Discovered by**: slice 001 OIDC fixture follow-up work (downstream issue #4)
**Severity**: medium — blocks every slice 005 Playwright test that depends on the slice-005 fixture's seeded matches, predictions, or participants on a fresh local stack.
**Surface**:
- `supabase/config.toml` — `[db.seed]` block
- `supabase/seed/slice-005-fixture.sql` (on disk, never loaded)

## Problem

`pnpm supabase db reset` (and `supabase start` on a fresh project) reads `supabase/config.toml`'s `[db.seed]` block and loads exactly the SQL files listed in `sql_paths`. As of 2026-05-23 that block reads:

```toml
[db.seed]
enabled = true
sql_paths = [
  './seed/slice-001-fixture.sql',
  './seed/slice-002-fixture.sql',
  './seed/slice-003-fixture.sql',
  './seed/slice-004-fixture.sql'
]
```

Note: **no `./seed/slice-005-fixture.sql`**. The slice 005 fixture exists on disk but the CLI never loads it.

On-disk inventory (`ls supabase/seed/`):

```
slice-001-fixture.sql
slice-002-fixture.sql
slice-003-fixture.sql
slice-004-fixture.sql
slice-005-fixture.sql                 ← not in sql_paths
slice-005-full-tournament-fixture.sql ← deliberately NOT auto-loaded (perf run only)
slice-005-loadtest-fixture.sql        ← deliberately NOT auto-loaded (k6 only)
```

The "deliberately not loaded" framing for `-full-tournament-fixture.sql` and `-loadtest-fixture.sql` is confirmed by `specs/005-scoring-leaderboard/regression-final.md`:

> Load + perf fixtures are loaded SEPARATELY (not by `supabase db reset`) and ONLY for k6 + perf runs.

So the baseline `slice-005-fixture.sql` belongs in `sql_paths`; the other two stay out.

## Empirical confirmation

After a `pnpm supabase db reset` on the affected dev machine:

```sh
docker exec supabase_db_world-cup-madness psql -U postgres -t \
  -c "SELECT count(*) FROM public.matches WHERE status='finished'"
# 1

# But the slice 005 tests reference FINISHED_MATCHES = [
#   'eeee0050-0000-0000-0000-000000000001',
#   'eeee0050-0000-0000-0000-000000000002',
#   'eeee0050-0000-0000-0000-000000000003',
# ]
# which live in slice-005-fixture.sql.
docker exec supabase_db_world-cup-madness psql -U postgres -t \
  -c "SELECT id FROM public.matches WHERE id::text LIKE 'eeee0050%'"
# (no rows)
```

Result: tests that insert into `public.score_records` with `target_id` referencing those UUIDs fail the `score_records_target_kind_shape` CHECK constraint (which requires `match_id = target_id` and `match_id IS NOT NULL`) because no matching `matches.id` row exists for the FK.

## Impact

The slice 005 Playwright suite was authored against the slice-005-fixture truth table. Specs affected:

- `slice-005-leaderboard.spec.ts` — synthetic-tie tests insert score_records keyed to `FINISHED_MATCHES`.
- `slice-005-breakdown.spec.ts` — runs the full scoring sequence over `FINISHED_MATCHES`.
- `slice-005-match-scoring.spec.ts` — depends on M1/M2/M3 existing.
- `slice-005-final-scoring.spec.ts` — depends on tournament_award rows seeded by the fixture.
- `slice-005-peer-pick-visibility.spec.ts` — references seeded predictions/finals from the fixture.

The slice 005 `regression-final.md` documents the fixture's role in its truth-table block:

> Fixture truth table (slice-005-fixture.sql bottom, calculation_version=1):
>
> | rank | participant | total | exact | outcome | final |
> |------|-------------|-------|-------|---------|-------|
> | 1    | alpha       | 90    | 3     | 0       | 60    |
> | ...

That truth table is the canonical source for every numeric assertion in the slice 005 tests. Without the fixture loaded, the assertions cannot be true.

## Recommended fix

One-line `supabase/config.toml` edit:

```diff
 [db.seed]
 enabled = true
-sql_paths = ['./seed/slice-001-fixture.sql', './seed/slice-002-fixture.sql', './seed/slice-003-fixture.sql', './seed/slice-004-fixture.sql']
+sql_paths = ['./seed/slice-001-fixture.sql', './seed/slice-002-fixture.sql', './seed/slice-003-fixture.sql', './seed/slice-004-fixture.sql', './seed/slice-005-fixture.sql']
```

Then `pnpm supabase db reset` on every affected dev machine.

The `-full-tournament-fixture.sql` and `-loadtest-fixture.sql` stay out of `sql_paths` per the slice 005 design — those are explicitly perf-run-only.

## Verification

After applying the fix:

```sh
pnpm supabase db reset
docker exec supabase_db_world-cup-madness psql -U postgres -t \
  -c "SELECT id FROM public.matches WHERE id::text LIKE 'eeee0050%' ORDER BY id"
#  eeee0050-0000-0000-0000-000000000001
#  eeee0050-0000-0000-0000-000000000002
#  eeee0050-0000-0000-0000-000000000003

# Then re-run the slice 005 suite:
cd apps/web
pnpm exec playwright test tests/playwright/slice-005-*.spec.ts \
  --project=chromium --reporter=list
```

Expected: tests that previously failed at the FK / CHECK boundary now reach their actual assertions. Real test failures (if any) should surface as numeric mismatches against the fixture truth table — NOT as constraint violations.

## Cross-references

- `supabase/config.toml` § `[db.seed]`
- `supabase/seed/slice-005-fixture.sql` — the unloaded fixture
- `specs/005-scoring-leaderboard/regression-final.md` § "Cumulative slice 005 artifact inventory" (mentions the 3 seed fixtures)
- `specs/001-eligibility-login/follow-up-oidc-stub-keycloak-vs-mock-oauth2.md` § "NEW issues found" #4 (this issue's discovery point)
- `apps/web/tests/playwright/slice-005-leaderboard.spec.ts` (FINISHED_MATCHES constant)

## Why this was hidden until 2026-05-23

The slice 005 Playwright suite has been failing in its pre-flight (the OIDC fixture's `assertOidcStubReachable` 404'ing against Keycloak) for an extended period. Tests never ran far enough to expose this fixture-loading bug. Path A of the OIDC fixture follow-up (commits `261c5c9`, `ae57d86`) cleared the pre-flight, and this gap was the next thing to surface.

## Owner

Slice 005 owner, or whoever next runs a slice 005 regression sweep.

## Status

**Open** — pending the one-line config.toml edit.
