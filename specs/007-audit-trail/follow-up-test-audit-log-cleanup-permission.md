# Slice 007 follow-up: test fixtures cannot DELETE audit_log rows; cross-test pollution masks slice-006 wins

**Filed**: 2026-05-23
**Discovered by**: full Playwright suite run after the cookie-forwarding sweep (commits 92ad387 / 6451aaa / 28219ba / 85f825e). With auth unblocked, ~10 slice-006 specs now pass individually but cascade-fail when run together because audit rows from earlier tests poison later assertions and the per-test cleanup helper can't remove them.
**Severity**: medium-high — blocks ~10 otherwise-passing slice-006 tests from contributing to the green-gate when run as part of the full suite. Not a production-correctness issue; the tamper-resistance it surfaces is *correct* posture for prod.
**Surface**:
- `supabase/migrations/0076_audit_trail.sql` (lines 38–48 — the LOCKED tamper-resistance REVOKE)
- `apps/web/tests/playwright/slice-006-admin-audit-search.spec.ts:71-78` (deleteAuditRows helper)
- `apps/web/tests/playwright/slice-006-admin-audit-by-target.spec.ts` (same helper, copy-paste)
- `apps/web/tests/playwright/slice-006-recalc-pending-banner.spec.ts` (same)

## Symptom

```text
deleteAuditRows: permission denied for table audit_log
```

Logged from the `afterEach`/`beforeEach` test cleanup hook. The helper is:

```ts
async function deleteAuditRows(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const client = getServiceClient();
  const { error } = await client.from("audit_log").delete().in("id", ids);
  if (error) {
    console.error(`deleteAuditRows: ${error.message}`);
  }
}
```

It uses the service-role client, which normally bypasses RLS for everything. But the REVOKE on the DML grant means **even service_role can't DELETE audit_log rows** — the GRANT-level lock fires before RLS is consulted.

The cleanup silently logs the error (no throw), so individual tests still pass: the seeded audit rows exist *during* the test, the assertions hit them, the test asserts and passes. Then `afterEach` "deletes" them — except it can't, the rows stay. The next test starts with the prior test's audit rows still in the table, breaking any `body.total >= 1` or row-count assertion that expected a clean slate.

## Root cause (intentional)

`supabase/migrations/0076_audit_trail.sql`, lines 38–48:

```sql
-- T005: REVOKE UPDATE + DELETE from authenticated, anon, service_role
-- This is the LOCKED tamper-resistance posture per R-001 + Principle II.
-- Reference: contracts/audit-log.schema.md § Tamper-resistance posture (LOCKED).
-- Note: service_role typically bypasses RLS but NOT GRANT-revoked DML.

REVOKE UPDATE, DELETE ON public.audit_log FROM authenticated;
REVOKE UPDATE, DELETE ON public.audit_log FROM anon;
REVOKE UPDATE, DELETE ON public.audit_log FROM service_role;
```

**This posture is correct for production.** The audit log is required to be append-only for compliance (Principle II — security by design, V — auditability). The bug is that the test environment shares the same posture and has no escape hatch for fixture cleanup.

## Affected tests (visible from the latest full-suite run)

Tests that pass in isolation but fail when run together due to audit pollution:

- `slice-006-admin-audit-search.spec.ts` — body.audit_log assertions break when prior tests' rows shadow the seed.
- `slice-006-admin-audit-by-target.spec.ts` — `audit_log` array contains entries that aren't the two seeded match-history rows.
- `slice-006-recalc-pending-banner.spec.ts` — depends on banner toggle reflecting only the test's own audit row.
- `slice-006-admin-recalc-*.spec.ts` (3 specs) — recalc-triggered audit-row assertions count rows leaked from prior tests.
- `slice-006-admin-finals-*.spec.ts` (2 specs) — finals-corrected audit rows likewise.
- `slice-006-admin-match-correct-score-*.spec.ts` (2 specs) — match.updated audit rows.
- `slice-006-admin-pending-review-resolve.spec.ts` — pending_review_resolved audit rows.

Net: roughly **10 slice-006 specs** that the cookie-forwarding sweep should have left green-when-run-together.

## Why this only shows up now

Before the cookie-forwarding sweep, these tests were failing at the auth gate (401) — they never reached the audit-row-assertion stage, so the cleanup permission error was masked. After the sweep, auth passes, the seeded rows are written, the assertions run against an over-populated table, and the cascade surfaces.

## Resolution options

### Option A — SECURITY DEFINER test-only RPC for cleanup (recommended)

Add a SECURITY DEFINER function that runs as `postgres` (which retains DELETE rights — the REVOKE only touched authenticated / anon / service_role). Gate by requiring a sentinel argument or a tournament_config flag that's only set in local dev / CI. Test fixtures call this function instead of bare DELETE.

```sql
CREATE OR REPLACE FUNCTION public.__test_delete_audit_rows(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Refuse to run unless local-dev sentinel is present.
  IF current_setting('app.env', true) <> 'local-dev' THEN
    RAISE EXCEPTION '__test_delete_audit_rows is local-dev-only';
  END IF;
  DELETE FROM public.audit_log WHERE id = ANY (p_ids);
END;
$$;
GRANT EXECUTE ON FUNCTION public.__test_delete_audit_rows(uuid[]) TO service_role;
```

Set `app.env=local-dev` GUC in `postgresql.conf` for local Supabase only. Production never sets it; the function is a no-op there.

Pros:
- Preserves the tamper-resistance posture as the documented invariant.
- Single source of truth — every test that needs cleanup calls this one function.
- Easy to delete on prod by checking the GUC.

Cons:
- Requires a GUC convention to be set in local dev + CI.
- Slightly opaque "why is this function here" — needs a clear migration comment.

### Option B — TRUNCATE via raw psql in test global teardown

Use `docker exec supabase_db_world-cup-madness psql -U postgres -c "TRUNCATE public.audit_log"` from a Playwright `globalSetup` / `globalTeardown` script. Bypasses the application layer entirely; uses the postgres superuser role which is unaffected by REVOKE.

Pros:
- Zero migration change.
- Truly bypasses tamper-resistance only at the OS layer where the test runner controls execution.

Cons:
- Couples tests to docker exec — fragile in CI matrices that aren't local docker.
- TRUNCATE is brutal — drops every row, including ones a *concurrent* test depends on. Forces serial mode globally (already required for slice-005 follow-ups, so this is OK in practice).

### Option C — Per-test entity_id namespacing + filter-on-read

Mutate `seedAuditAndRun` helpers to insert audit rows with `entity_id = '<test-run-uuid>'` or similar. Assertions filter on that prefix. No cleanup needed.

Pros:
- Pure test-side change; zero migration / config touch.
- Aligns with how slice-005-leaderboard works around fixture drift (filter to slice-005 UUIDs).

Cons:
- Requires every audit assertion across the slice-006 suite to be re-anchored — significantly larger sweep than option A.
- Adds noise to audit_log over time (rows accumulate; only resetting via `supabase db reset` clears them, which prod doesn't have).

### Option D — Add a DELETE GRANT back for service_role + add a CHECK-like gate

Argue that the production tamper-resistance can rely on `app.env != local-dev` as a runtime check inside a trigger:

```sql
CREATE FUNCTION audit_log_block_tamper() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.env', true) IS DISTINCT FROM 'local-dev' THEN
    RAISE EXCEPTION 'audit_log is append-only';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_tamper();
GRANT DELETE ON public.audit_log TO service_role;
```

Pros:
- Simpler than option A — no function plumbing.

Cons:
- Trades a GRANT-level lock (Postgres' strongest tamper-resistance primitive) for a trigger that runs Postgres procedure code. Triggers can be disabled by superusers. The original migration's note `"service_role typically bypasses RLS but NOT GRANT-revoked DML"` is exactly the property the trigger gives up.
- Auditors will not love the change. The original posture is the better posture for prod.

## Recommendation

**Option A** — `__test_delete_audit_rows(p_ids uuid[])` SECURITY DEFINER + GUC gate. It preserves the prod tamper-resistance invariant intact, is one mechanical migration to ship, and the test-side change is a one-liner per helper (`client.rpc('__test_delete_audit_rows', { p_ids: ids })` instead of `client.from('audit_log').delete().in('id', ids)`).

The same RPC can also be used by other slice-007 fixture cleanup paths that this follow-up exposes once they're swept (e.g., the slice-006 `seedAuditAndRun` helpers in `admin-audit-detail-with-linkage` once that's unblocked from the separate `score_calculation_runs.id` follow-up).

## Status

**Open** — not yet implemented. Tests that depend on this remain `passing-individually-failing-together`. Recommended to land before the next full-suite run that aims for a single-digit failure count.

## Sibling follow-ups

This is one of several distinct classes surfaced by the post-Keycloak full-suite run. The siblings (all enumerated in [follow-up-test-cookie-forwarding-after-keycloak.md](../001-eligibility-login/follow-up-test-cookie-forwarding-after-keycloak.md) § Related follow-ups):

- `/admin/*` infinite-redirect loop (slice 006, 5 specs)
- Keycloak fixture user list incomplete (slice 001 + slice 003-004 newcomer tests, ~7 specs)
- Mid-session domain-removal eligibility caching (slices 001-004, ~5 specs)
- Slice-005 fixture drift (slice 002-003 catalog assertions, ~7 specs)
- Slice-009 DOM selector breakage (slice 003 + slice 008 config-*, ~6 specs)
- `score_calculation_runs.id` NOT NULL in `seedAuditAndRun` helper (slice 006 audit-detail, 1 spec)
- es-ES locale display (slice 002, 1 spec)
- slice-005-final-scoring AS1 state pollution in full-suite mode (1 spec)
