# Slice 005 follow-up: `score-trigger` Edge Function writes `triggered_by: null` on the X-Internal-Auth bypass path

**Filed**: 2026-05-23
**Discovered by**: slice 001 OIDC fixture follow-up work (downstream issue #5)
**Severity**: medium — fully blocks the X-Internal-Auth bypass path on the local dev stack; the same logic ships to production where the bypass is OFF, but the issue is latent for any future production scenario that calls the SPs without a real `auth.uid()` context (e.g. a DB-trigger callsite or admin migration script).
**Surface**:
- `supabase/functions/score-trigger/index.ts` (calls the SP)
- `supabase/migrations/0052_score_match_fn.sql` (the SP)
- `supabase/migrations/0050_score_calculation_runs.sql` (the schema)

## Problem

The `score-trigger` Edge Function exposes an `X-Internal-Auth` bypass header (D-025 option B) that the slice 005 test harness uses to drive the scoring pipeline. When the bypass fires, the function calls the SP at slot 0052 (`score_match`) using a **service-role** Supabase client.

The SP at slot 0052 (line 117 of `0052_score_match_fn.sql`) writes `auth.uid()` directly into `score_calculation_runs.triggered_by`:

```sql
INSERT INTO public.score_calculation_runs (
  id, scope, target_id, "trigger", triggered_by, started_at, status, reason
)
VALUES (
  p_run_id,
  'match',
  p_match_id,
  'match_finish',
  auth.uid(),     -- ← always NULL on the service-role path
  now(),
  'running',
  NULL
);
```

`triggered_by` is `uuid NOT NULL` per slot 0050 (line 11 of `0050_score_calculation_runs.sql`). When the SP is invoked through a service-role client, `auth.uid()` returns NULL → the INSERT violates the NOT NULL constraint → the SP raises → the Edge Function returns:

```json
{
  "error": {
    "code": "SCORING_FAILED",
    "message": "null value in column \"triggered_by\" of relation \"score_calculation_runs\" violates not-null constraint",
    "reason": "sp_error"
  }
}
```

## The SP author already knew

The slot 0052 migration's leading comment (lines 104-107) explicitly acknowledges this:

> triggered_by uses auth.uid(); in pgTAP / direct-SQL contexts this may be NULL, which the score_calculation_runs.triggered_by NOT NULL constraint would reject — runtime verification (T016) covers that path with a real JWT or an admin-seeded system participant fallback.

…but the "admin-seeded system participant fallback" never landed. T016 only ran against tests that had a real JWT (the auth hook seeded one) — the service-role / Edge Function path slipped through.

## Empirical confirmation

After wiring `SCORE_TRIGGER_INTERNAL_AUTH_SECRET` end-to-end and matching it in the test (so the bypass actually engages — see `specs/001-eligibility-login/follow-up-oidc-stub-keycloak-vs-mock-oauth2.md`), the failing call looks like:

```
POST /functions/v1/score-trigger {scope: 'match', match_id: 'bbbb...0001'}
  Authorization: Bearer <anon-key>            ← satisfies the gateway
  X-Internal-Auth: <SCORE_TRIGGER_INTERNAL_AUTH_SECRET>  ← engages the bypass

→ HTTP 500
{
  "error": {
    "code": "SCORING_FAILED",
    "message": "null value in column \"triggered_by\" of relation \"score_calculation_runs\" violates not-null constraint",
    "details": "Failing row contains (..., match, ..., match_finish, null, null, ...)"
  }
}
```

The `null, null` in `details` are `triggered_by` and `reason` — the SP wrote NULL for both because `auth.uid()` is NULL inside a service-role context.

## Fix options

### Option A — SP-side COALESCE to a system participant id (recommended)

Add a `coalesce(auth.uid(), <SYSTEM_PARTICIPANT_ID>)` fallback in the SP. The SYSTEM_PARTICIPANT_ID would be a reserved UUID (e.g., `00000000-0000-0000-0000-000000000000`) that lives in `participants` as a permanent "system / auto" actor seeded by a migration. Audit log readers learn to recognize this UUID as "automated scoring trigger, no human actor."

**Pros**: changes are localized to one migration + one seed insert. The function and tests do not need updating. The fix also unblocks any future DB-trigger callsite (T042's `pg_net` wrapper, currently disabled) that would otherwise hit the same problem.

**Cons**: introduces a reserved-UUID convention. Audit queries that filter by `triggered_by IS NOT NULL` for "human actions only" need updating to also exclude SYSTEM_PARTICIPANT_ID.

### Option B — function passes `p_triggered_by` parameter to the SP

Extend the SP signature to accept `p_triggered_by uuid`. The Edge Function passes the admin1 id (or a request-payload-supplied id) when bypassing. The SP COALESCEs `p_triggered_by` with `auth.uid()`.

**Pros**: no reserved UUID; the source of the trigger is always a real participant.

**Cons**: requires coordinating Edge Function + SP changes (cross-slice contract). The function would need to choose a sensible default participant when the caller is the DB-trigger path (which has no obvious human actor).

### Option C — bypass writes its identity into request.jwt.claims

Before calling the SP, the Edge Function does:

```ts
await serviceClient.rpc('set_config', {
  setting_name: 'request.jwt.claims',
  setting_value: JSON.stringify({ sub: ADMIN1_UUID }),
  is_local: true,
});
```

Then `auth.uid()` inside the SP picks up `ADMIN1_UUID`.

**Pros**: no schema or SP signature change.

**Cons**: subtle, relies on Postgres session-level GUC handling. Brittle under connection pooling. The set_config has to be set in the SAME connection as the SP call; PostgREST or PG connection pooling can drop the GUC between calls.

### Recommendation

**Option A**. The change-set is small, local, and fixes the latent class of bugs (every service-role caller of any scoring SP gets the same fallback). Audit-log queriers can be updated in the same migration's comment block.

## Recommended change-set (Option A)

1. New migration (slot 0078 is just taken by the personal_breakdown rename; pick the next free slot, e.g. **0079**) named e.g. `0079_score_runs_system_participant.sql`:
   ```sql
   -- Seed the reserved system participant.
   INSERT INTO public.participants (id, auth_user_id, email, display_name, domain, status, ...)
   VALUES (
     '00000000-0000-0000-0000-000000000000',
     '00000000-0000-0000-0000-000000000000',
     'system@wcm.internal',
     'WCM Scoring System',
     'wcm.internal',
     'active',
     ...
   )
   ON CONFLICT (id) DO NOTHING;
   ```

2. Patch the SPs at slot 0052 (`score_match`), slot 0053 (`score_finals`), and slot 0058 (`score_all`) to use `coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)` instead of bare `auth.uid()` for `triggered_by`.

   Per the immutability convention for already-applied migrations, the SPs should be replaced via a NEW migration (slot 0080?) with `CREATE OR REPLACE FUNCTION` rather than editing the prior migration files.

3. Update `docs/architecture/scoring-model.md` (or the slice 005 plan.md) with a one-line note explaining the system-participant convention.

4. Update audit-log consumers (slice 007) to recognize and label the system UUID in any human-facing audit display.

5. Verification: re-run `pnpm exec playwright test tests/playwright/slice-005-breakdown.spec.ts -g "AS1" --project=chromium`. The score-trigger call should now return 200 with a populated `calculation_version_written`.

## Production posture

The X-Internal-Auth bypass is OFF in production (per the slice 005 author's notes: "production deployments should leave it unset once slice 006's admin_roles + production is_admin function ship"). So this bug doesn't affect production today.

But it DOES leave a footgun: any future production scenario that calls the scoring SPs through a service-role path (e.g. a periodic `pg_net` DB trigger, a cron-driven recalc, an admin migration backfill) would hit the same NOT NULL violation. Fixing it via Option A future-proofs the codebase.

## Why this was hidden until 2026-05-23

Same masking story as follow-up #4: the slice 005 Playwright suite was failing in its OIDC pre-flight. Tests never ran far enough to exercise the bypass path through to the SP. After the slice 001 OIDC fixture follow-up (commit `261c5c9`) and the X-Internal-Auth env wiring (commit `ae57d86` + the env-file writes) cleared the path, the function finally reached the SP and the SP raised this constraint.

## Cross-references

- `supabase/functions/score-trigger/index.ts` lines 11-46 (auth contract + D-T013-B comment)
- `supabase/migrations/0050_score_calculation_runs.sql` (the NOT NULL constraint)
- `supabase/migrations/0052_score_match_fn.sql` lines 100-122 (the SP)
- `supabase/migrations/0053_score_finals_fn.sql` (likely has the same issue)
- `supabase/migrations/0058_score_all_fn.sql` (likely has the same issue)
- `specs/001-eligibility-login/follow-up-oidc-stub-keycloak-vs-mock-oauth2.md` § "NEW issues found" #5

## Owner

Slice 005 owner.

## Status

**Implemented** — 2026-05-23.

### What shipped

The fix is a single new migration: `supabase/migrations/0079_score_runs_triggered_by_fallback.sql` (~140 lines). It implements **Option A** as recommended in this doc but with a refinement: rather than `CREATE OR REPLACE` on the three SP migrations (1,338 lines of code, high transcription risk), it uses a **BEFORE INSERT trigger** on `score_calculation_runs` that canonicalizes `triggered_by` for every writer — past, present, and future.

The migration does three things:

1. **Seeds the system identity** — `auth.users` + `public.participants` rows at the reserved zero UUID `00000000-0000-0000-0000-000000000000`. `status='deactivated'` so the eligibility predicate filters it from leaderboards and API surfaces. `email='system@wcm.internal'` on a non-approved domain ensures no eligibility predicate ever returns TRUE for this identity. Both INSERTs use `ON CONFLICT (id) DO NOTHING` for idempotency.

2. **Adds a resolver helper** `public.resolve_score_run_triggered_by(uuid)` that:
   - Returns the input unchanged if it's already a valid `participants.id` (slot 0070 admin-recalc path).
   - Returns the matching `participants.id` if the input is an `auth.users.id` with a participant row (slot 0052/0053/0058 user-JWT path — `auth.uid()` is the `auth_user_id`).
   - Returns the system participant ID otherwise (slot 0052/0053/0058 X-Internal-Auth bypass path where `auth.uid()` is NULL).

3. **Wires a BEFORE INSERT trigger** on `score_calculation_runs` that calls the resolver on every row. Idempotent for callers that already pass valid participant IDs.

### Why the trigger approach instead of `CREATE OR REPLACE` on the SPs

The three SP migrations total 1,338 lines (`0052_score_match_fn.sql`: 397, `0053_score_finals_fn.sql`: 463, `0058_score_all_fn.sql`: 478). Re-creating them verbatim with a one-line patch each carries significant transcription risk. The trigger approach is small (one helper + one trigger function + one CREATE TRIGGER), covers every writer to `score_calculation_runs` uniformly, AND fixes the latent user-JWT bug (slot 0052/0053/0058 wrote `auth.uid()` = `auth_user_id`, which would FK-violate against `participants.id` — never runtime-verified per slot 0052's own comment).

### Empirical verification

After `pnpm supabase db reset` to apply the new migration:

```sh
docker exec supabase_db_world-cup-madness psql -U postgres -t \
  -c "SELECT id, email, status FROM public.participants WHERE id::text LIKE '00000000-%'"
#  00000000-0000-0000-0000-000000000000 | system@wcm.internal | deactivated

docker exec supabase_db_world-cup-madness psql -U postgres -t \
  -c "SELECT trigger_name FROM information_schema.triggers
       WHERE event_object_table='score_calculation_runs'"
#  score_calc_runs_canonicalize_triggered_by
```

End-to-end test (with `pnpm exec playwright test slice-005-breakdown -g "AS1"`):

- **Before fix**: HTTP 500 with `SCORING_FAILED: null value in column "triggered_by"`.
- **After fix**: HTTP 200 from the score-trigger Edge Function. SPs at slots 0052/0053/0058 successfully insert into `score_calculation_runs`. score_records are written. `/me/breakdown` renders the breakdown table for alpha.

The test now fails on a downstream assertion (`Expected: 3, Received: 4` — slice 005 expected exactly 3 finished-match breakdown rows, but the fixture's M4 row is showing up). That's a separate slice 005 truth-table vs fixture-shape question — unrelated to the `triggered_by` bug this follow-up tracked.

### Production posture

- The X-Internal-Auth bypass remains OFF in production (per the slice 005 plan: "production deployments should leave it unset once slice 006's admin_roles + production is_admin function ship"). So the immediate bug doesn't affect production today.
- The trigger fix DOES change behavior on the user-JWT path: previously the SP wrote `auth.uid()` (an `auth.users.id`) into `triggered_by`, which would FK-violate against `participants.id`. The trigger now correctly maps to `participants.id`. This is a bug fix — any existing production data with `triggered_by` containing an `auth.users.id` would have been broken (un-FK-resolvable). If such data exists, it needs a one-shot data migration, but the working theory is that no user-JWT call ever reached the SP in production (the public path goes through the admin recalc SP at slot 0070 which already does the lookup correctly).
- The system participant is locked to `status='deactivated'` and an unverifiable domain — never appears on any participant-facing surface.

### Local dev-env note

`pnpm supabase stop && start` will blank Supabase Auth's Keycloak provider config UNLESS `SUPABASE_AUTH_OIDC_*` env vars are exported in the shell when start runs. `apps/web/.env.local` has them but they don't auto-export. Run:

```sh
set -a && source apps/web/.env.local && set +a
pnpm supabase start
```

…or wrap that into a `scripts/supabase-start.sh`. This was discovered during today's fix verification.

### Cross-references

- `supabase/migrations/0079_score_runs_triggered_by_fallback.sql` — the fix
- `specs/001-eligibility-login/follow-up-oidc-stub-keycloak-vs-mock-oauth2.md` § "NEW issues found" #5 (this issue's filing point)
