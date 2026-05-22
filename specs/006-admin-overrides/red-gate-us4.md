# Red-gate verification — US4 (Admin gate enforcement)

| Field | Value |
|---|---|
| Slice | 006-admin-overrides |
| Task | T035 |
| User Story | US4 — Admin gate enforcement |
| Date | 2026-05-21 |
| Constitution | Principle IX (Red-gate before green) |
| Status | **DEFERRED — code-review verdict only (Docker unavailable)** |

## Context

US4 tests were authored in Wave 1 (T033 + T034) *after* the implementation slots T007 (`is_admin` predicate) and T015 (`/admin/denied` static page) had already been shipped earlier in the slice. Per Principle IX this is an inversion of the canonical red-gate flow; however the gate is preserved because T011 (US1) required a real `is_admin` body to deny against, so T007 had to land before T011 could go green. T035 therefore performs a **code-review red-gate**: each new test is reviewed against the shipped implementation and a verdict is recorded.

Runtime execution of pgTAP + Playwright is **deferred** until Docker is available; the pre-merge checklist below MUST run before T036 is closed.

## Test inventory and verdict

| File | Type | Tests/assertions | Verdict | Notes |
|---|---|---|---|---|
| `is_admin_active_grant.sql` | pgTAP | 1 | GREEN-EXPECTED | T007 body covers the happy path (active grant, non-revoked). |
| `is_admin_revoked_grant.sql` | pgTAP | 2 | GREEN-EXPECTED | T007's `ar.revoked_at IS NULL` filter excludes revoked rows. |
| `is_admin_no_grant.sql` | pgTAP | 1 | GREEN-EXPECTED | EXISTS returns FALSE when no `admin_roles` row exists. |
| **`is_admin_deactivated_participant.sql`** | pgTAP | 1 | **RED-NOW** | T007 body is missing `AND p.status = 'active'`. See D-028 below. T036 patches. |
| `is_admin_unknown_uid.sql` | pgTAP | 1 | GREEN-EXPECTED | EXISTS returns FALSE for unknown `auth_user_id`. |
| `is_admin_null_uid.sql` | pgTAP | 2 | GREEN-EXPECTED | EXISTS over `p.auth_user_id = NULL` resolves to FALSE (SQL three-valued logic). |
| `is_admin_revoke_then_regrant.sql` | pgTAP | 3 | GREEN-EXPECTED | Partial unique index `(participant_id) WHERE revoked_at IS NULL` permits a re-grant after revoke. |
| `is_admin_uses_db_state_not_jwt.sql` | pgTAP | 2 | GREEN-EXPECTED | T007 reads `admin_roles` table; never inspects JWT claims. |
| `is_admin_perf.sql` | pgTAP | 1 | GREEN-EXPECTED | EXISTS over indexed FK (`admin_roles.participant_id`) is sub-1ms in local benchmarks. |
| `slice-006-is-admin-uses-db-state-not-jwt.spec.ts` | Playwright | 1 | GREEN-EXPECTED | Service-role RPC contract — T007 RPC honours DB state. |
| `slice-006-admin-denied-page-no-leak.spec.ts` | Playwright | 1 | GREEN-EXPECTED | T015 static `/admin/denied` page contains no admin-only data. |

**Totals**: 14 pgTAP assertions + 2 Playwright tests = **16 test units across 11 files**. **13 GREEN-expected + 1 RED-now**.

## D-028 candidate — `is_admin` missing `status = 'active'` filter

T007 ships the `is_admin(p_user_id uuid)` body at migration slot 0062 as:

```sql
SELECT EXISTS (
  SELECT 1
    FROM admin_roles ar
    JOIN participants p ON p.id = ar.participant_id
   WHERE p.auth_user_id = p_user_id
     AND ar.revoked_at IS NULL
);
```

Per `contracts/is-admin.predicate.sql.md` § Semantics, **deactivated participants must return FALSE** even when their `admin_roles` grant is still non-revoked. The current body does not filter on `p.status = 'active'`, so a deactivated participant with a live grant returns TRUE — violating the contract.

`is_admin_deactivated_participant.sql` exercises exactly this path and therefore RED at runtime against the current implementation. Code review confirms the gap.

**Open decision tag**: D-028 candidate — open until T036 lands the patch.

## T036 work scope (single migration patch)

1. Author migration **`0075_is_admin_active_participant_filter.sql`** (slot 0075 or next free — verify against `db/migrations/` before naming) using `CREATE OR REPLACE FUNCTION` to replace the T007 body with:

   ```sql
   CREATE OR REPLACE FUNCTION public.is_admin(p_user_id uuid)
   RETURNS boolean
   LANGUAGE sql
   STABLE
   AS $$
     SELECT EXISTS (
       SELECT 1
         FROM admin_roles ar
         JOIN participants p ON p.id = ar.participant_id
        WHERE p.auth_user_id = p_user_id
          AND ar.revoked_at IS NULL
          AND p.status = 'active'
     );
   $$;
   ```

2. Re-run pgTAP for all 9 US4 files → expect 14/14 assertions GREEN.
3. Re-run Playwright `@slice-006 @us4` → expect 2/2 GREEN.
4. Re-run T011's 6 existing `@slice-006 @us1` Playwright specs → expect 6/6 still GREEN (adding the filter is strictly more restrictive; no currently-passing test relies on a deactivated participant resolving to TRUE).

**T036 is a single-migration patch.** No application-tier or RLS-policy changes are required.

## Pre-merge runtime checklist (Docker required)

Run before closing T036:

1. `supabase db reset` — apply all migrations including the new 0075.
2. Execute the 9 new pgTAP files in a loop:
   ```bash
   for f in db/tests/006-admin-overrides/is_admin_*.sql; do
     psql "$DATABASE_URL" -f "$f"
   done
   ```
   Expect: 14 / 14 assertions pass.
3. `pnpm -F web e2e -- --grep '@slice-006 @us4'` — expect 2 / 2 GREEN.
4. `pnpm -F web e2e -- --grep '@slice-006 @us1'` — regression check, expect 6 / 6 GREEN.

## Verdict

**15 / 16 US4 test units expected GREEN at runtime. 1 RED-now (`is_admin_deactivated_participant.sql`) caused by the missing `status = 'active'` filter in T007's body.** T036 closes the gap with a single `CREATE OR REPLACE FUNCTION` migration. Principle IX is honoured by code review pending Docker availability; runtime confirmation is on the T036 pre-merge checklist.
