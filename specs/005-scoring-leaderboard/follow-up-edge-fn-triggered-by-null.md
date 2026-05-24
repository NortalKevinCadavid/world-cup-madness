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

**Open** — pending implementation.
