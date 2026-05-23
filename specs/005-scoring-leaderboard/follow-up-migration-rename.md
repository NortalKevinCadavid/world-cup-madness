# Slice 005 follow-up: rename `0054b_personal_breakdown_view.sql`

**Filed**: 2026-05-23
**Discovered by**: slice 009 (UI beautification) local-dev session
**Severity**: low (dev-environment paper cut; no production impact)
**Surface**: `supabase/migrations/0054b_personal_breakdown_view.sql`

## Problem

The Supabase CLI's migration runner extracts the migration *version* by matching the **leading run of digits** of the filename. For `0054b_personal_breakdown_view.sql`, the version is `0054` — the `b` is silently dropped.

Slice 005 already has `supabase/migrations/0054_leaderboard_views.sql` claiming version `0054`. When the CLI processes the migrations directory:

1. It enumerates files, extracting the leading-digits version for each.
2. It deduplicates by version, **picking one file per version**. The picked one in practice is `0054_leaderboard_views.sql` (alphabetic precedence: `0054_` sorts before `0054b_`).
3. `0054b_personal_breakdown_view.sql` is **silently skipped**.

Result: `supabase db reset` on a fresh local environment populates `supabase_migrations.schema_migrations` with version `0054` (from `0054_leaderboard_views.sql`) and never applies `0054b_personal_breakdown_view.sql`. The view `public.personal_breakdown_v` therefore does NOT exist after a clean local install, and the page `apps/web/app/(participant)/me/breakdown/page.tsx` returns HTTP 500 with:

> `Error: getPersonalBreakdown failed: Could not find the table 'public.personal_breakdown_v' in the schema cache`

The slice 005 author intentionally used the `0054b` "sub-slot" name (per the file's leading comment: *"on-disk slot 0054b is a sub-slot of T029's 0054_leaderboard_views.sql, reserved for the personal-breakdown view alone so the T029 multi-view migration is not rewritten in-place"*). That intent is honored at the documentation level but **the CLI does not recognize the convention**.

## Empirical confirmation

```sh
# Before manual fix:
docker exec supabase_db_world-cup-madness psql -U postgres -t \
  -c "SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname='personal_breakdown_v'"
# (no rows)

docker exec supabase_db_world-cup-madness psql -U postgres -t \
  -c "SELECT version FROM supabase_migrations.schema_migrations WHERE version='0054' OR version LIKE '%personal_breakdown%'"
#  0054

# After manual `docker exec ... psql -f 0054b_personal_breakdown_view.sql`:
# The view exists; PostgREST schema cache reloaded via NOTIFY pgrst, 'reload schema';
# /me/breakdown returns 200 in the browser.
```

The manual workaround does NOT insert a row into `supabase_migrations.schema_migrations` — so a future `supabase db reset` will lose the view again until this issue is fixed.

## Recommended fix

Two-step rename + defensive SQL:

1. **Rename the file** to fit the numeric version pattern. Slice 005's slot range (0049-0059) is fully consumed; slots 0060-0077 belong to slices 006-008. The cleanest target is **`0078_personal_breakdown_view.sql`** — appended at the end of the migration chain. The chronological semantics are unchanged (the view is created *after* the leaderboard views regardless of slot number), and it leaves a clear breadcrumb that this is a late-applied artifact.

   ```sh
   git mv supabase/migrations/0054b_personal_breakdown_view.sql \
          supabase/migrations/0078_personal_breakdown_view.sql
   ```

2. **Make the migration idempotent** so it can be re-applied on databases that already have the view from the manual workaround. Replace `CREATE VIEW public.personal_breakdown_v` with `CREATE OR REPLACE VIEW public.personal_breakdown_v` (and any associated `COMMENT`/`GRANT` are already idempotent).

3. **Update the migration header comment** to drop the "0054b sub-slot" framing and explain the new slot:

   > Originally drafted at slot 0054b as a sub-slot of T029's `0054_leaderboard_views.sql`. Renamed to 0078 (post-slice 005 follow-up) because the Supabase CLI migration runner does not parse non-numeric sub-slot suffixes; the original filename caused the migration to be silently skipped on fresh local installs. See `specs/005-scoring-leaderboard/follow-up-migration-rename.md`.

4. **Backfill the migrations table on the dev machine** that has the manual-applied view but no row, so `supabase migration up` doesn't try to re-apply:

   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
   VALUES ('0078', 'personal_breakdown_view', ARRAY['-- backfilled after manual apply on 2026-05-23'])
   ON CONFLICT DO NOTHING;
   ```

   (Or just `supabase db reset` if the local data is disposable.)

5. **Test the fix**:
   - Run `supabase db reset` on a separate clean local environment.
   - Confirm the migration table has a row for version `0078`.
   - Confirm `public.personal_breakdown_v` exists.
   - Navigate to `/me/breakdown` as a participant with at least one scored prediction and verify the breakdown table renders.

## Alternatives considered

- **Rename to `0054_5_personal_breakdown_view.sql`** — rejected. Leading-digits parse to `0054`, same collision.
- **Rename to `0054a_personal_breakdown_view.sql`** — rejected. Same problem (`a` is ignored).
- **Merge the SQL into `0054_leaderboard_views.sql`** — rejected. Would rewrite a migration that has already been applied to staging/CI/dev environments, violating the immutability convention for already-applied migrations.
- **Insert a small bridging migration at slot 0078 that loads the file at runtime** — rejected. Adds complexity for no benefit over a direct rename.

## Cross-slice impact

None. The migration's content is unchanged; its semantic position in the slice 005 narrative is preserved. The only difference is its on-disk filename and its execution slot in the CLI's chain.

The slice 005 `regression-final.md` mentions "12 files on disk occupying 11 distinct slot numbers" — that observation is **the symptom** of this bug, not an intentional design. The rename will change that count to "12 files / 12 distinct slot numbers".

## Owner

Suggested: whoever next opens slice 005 follow-up work. This fix is a 5-minute change-set (file rename + 2-line SQL diff + 1-paragraph comment update). It can also be handled as a one-off chore commit outside any slice.

## Status

**Implemented** — 2026-05-23.

Action log:
- ✅ `git mv supabase/migrations/0054b_personal_breakdown_view.sql supabase/migrations/0078_personal_breakdown_view.sql`
- ✅ Header comment rewritten with the slot-history section (replaces the original "Migration slot 0054b per D-023" paragraph).
- ✅ Idempotency was already in the original SQL — the `CREATE VIEW` statement at line 82 (post-rename) reads `CREATE OR REPLACE VIEW public.personal_breakdown_v`. No SQL diff required for this point of the recommended fix.
- ✅ Verified end-to-end on 2026-05-23 via `pnpm supabase db reset` on the affected dev machine: the CLI logs `Applying migration 0078_personal_breakdown_view.sql`; the `schema_migrations` table receives a row `(version='0078', name='personal_breakdown_view')`; `public.personal_breakdown_v` exists; the dev server's `/me/breakdown` route returns HTTP 200 (was 500 before the rename) for an authenticated participant.
- ✅ Regression test landed at `apps/web/tests/playwright/slice-005-breakdown-after-rename.spec.ts`. The spec drives a real Keycloak sign-in as the seeded `alpha@nortal.com` dev user, lands on `/dashboard`, navigates to `/me/breakdown`, and asserts both HTTP 200 and the absence of the schema-cache error string in the response body. Verified green (passed in 6.5 s) after the reset. Run via:

  ```sh
  pnpm exec playwright test \
    tests/playwright/slice-005-breakdown-after-rename.spec.ts \
    --project=chromium --reporter=list
  ```
