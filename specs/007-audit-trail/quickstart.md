# Quickstart: Audit Trail (Slice 007)

**Feature**: 007-audit-trail
**Date**: 2026-05-17
**Audience**: Developer or admin verifying the slice's behavior end-to-end.

This quickstart assumes Slices 001 (auth + audit table base) and 006 (admin role + admin RPCs) are deployed.

## 0. Preconditions

- Local supabase started: `supabase start`
- Migrations applied through Slice 006.
- At least one admin participant exists (`is_admin(<your_uuid>)` returns `true`).
- At least one non-admin participant exists for negative tests.
- Some audit history exists (run a few admin RPCs from Slice 006, submit a few predictions, etc.).

## 1. Apply Slice 007 migration

```bash
supabase db push  # or `supabase migration up`
```

Verify:

```sql
-- 1a. sequence_id column exists, NOT NULL, UNIQUE
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'audit_log' AND column_name = 'sequence_id';
-- Expect: bigint, NO

-- 1b. New indexes
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'audit_log'
ORDER BY indexname;
-- Expect to include: audit_log_actor_occurred_idx, audit_log_target_idx,
--                    audit_log_source_occurred_idx, audit_log_sequence_id_uk

-- 1c. REVOKE took effect
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'audit_log'
  AND privilege_type IN ('UPDATE', 'DELETE')
  AND grantee IN ('authenticated', 'anon', 'service_role');
-- Expect: 0 rows.
```

## 2. Verify tamper-resistance directly against DB

Connect as `service_role` (most privileged app role):

```sql
SET role service_role;
UPDATE public.audit_log SET reason = 'tampered' WHERE id = (SELECT id FROM audit_log LIMIT 1);
-- Expect: ERROR: permission denied for table audit_log

DELETE FROM public.audit_log WHERE id = (SELECT id FROM audit_log LIMIT 1);
-- Expect: ERROR: permission denied for table audit_log

INSERT INTO public.audit_log (action, source) VALUES ('test.row', 'system');
-- Expect: success (INSERT remains permitted)

RESET role;
```

## 3. Verify monotonic ordering (sequence_id)

```sql
-- Capture current max
SELECT max(sequence_id) AS before_id FROM public.audit_log;

-- Trigger a few state changes that produce audit rows (e.g., via admin UI or RPC):
SELECT public.admin_recalc_triggered_now('Quickstart test');  -- Slice 006

-- Verify new rows have strictly greater sequence_id than before_id:
SELECT sequence_id, action, occurred_at
FROM public.audit_log
WHERE sequence_id > <before_id>
ORDER BY sequence_id ASC;
-- Expect: all rows in ascending sequence_id, regardless of occurred_at clock skew.
```

## 4. Verify `audit_search` RPC

### 4a. Happy path (admin caller)

```sql
SET request.jwt.claims = '{"sub": "<your_admin_uuid>"}';
SELECT * FROM public.audit_search(p_action_pattern => 'admin.%', p_limit => 10);
-- Expect: up to 10 rows of admin audit actions, ordered by sequence_id ASC.
```

### 4b. Denial path (non-admin caller)

```sql
SET request.jwt.claims = '{"sub": "<non_admin_uuid>"}';
SELECT * FROM public.audit_search();
-- Expect: ERROR with SQLSTATE 'WAT01' and message about admin required.
```

Then verify the access-denied row landed:

```sql
SET request.jwt.claims = '{"sub": "<your_admin_uuid>"}';
SELECT actor, action, source, new_value
FROM public.audit_log
WHERE action = 'admin.access_denied' AND entity_type = 'audit_search'
ORDER BY sequence_id DESC LIMIT 1;
-- Expect: a row authored by the non-admin uuid, source='api_guard'.
```

### 4c. Validation failures

```sql
SELECT * FROM public.audit_search(p_limit => 1000);
-- Expect: ERROR WAT02 (limit > 500)

SELECT * FROM public.audit_search(p_from => '2026-12-31', p_to => '2026-01-01');
-- Expect: ERROR WAT02 (invalid range)

SELECT public.count_audit_search();  -- no filters
-- If audit_log has > 100k rows: Expect ERROR WAT03
-- Otherwise: returns the count.
```

## 5. Verify `count_audit_search` RPC

```sql
SET request.jwt.claims = '{"sub": "<your_admin_uuid>"}';
SELECT public.count_audit_search(p_from => now() - interval '1 day');
-- Expect: bigint count of audit rows in the past 24h.
```

## 6. Verify CSV export endpoint

### 6a. Admin export — small range

In a browser logged in as admin:

```
http://localhost:3000/api/admin/audit/export?action_pattern=admin.%25&from=2026-05-01T00:00:00Z
```

Expected:
- `200 OK`
- Content-Type: `text/csv; charset=utf-8`
- Content-Disposition: `attachment; filename="audit-export-...csv"`
- CSV header: `sequence_id,occurred_at,actor,action,entity_type,entity_id,source,reason,source_citation,previous_value,new_value,id`
- Body: one row per audit event in `sequence_id ASC` order.
- After download completes, query:
  ```sql
  SELECT new_value FROM public.audit_log
  WHERE action = 'admin.audit_export' AND actor = '<your_admin_uuid>'
  ORDER BY sequence_id DESC LIMIT 1;
  -- Expect: { "filters": {...}, "rows_exported": N, "truncated": false }
  ```

### 6b. Non-admin export — 403

Open same URL in a non-admin browser session:
- `403 Forbidden`
- Query audit_log: a `admin.access_denied` row with `entity_type='audit_export'`.

### 6c. Unbounded export — 422

```
http://localhost:3000/api/admin/audit/export
```

(no filters at all) → `422 { "error": "At least one filter required" }`.

## 7. Verify admin UI search surface

In a browser logged in as admin, visit `/admin/audit/search`:
- Page renders filter form: actor (uuid), action pattern, entity_type, entity_id, source dropdown, date-range pickers.
- Submitting filters runs `audit_search` and renders results table with `sequence_id`, `occurred_at` (in tournament timezone display), `actor` (resolved to participant name where possible), `action`, `entity_type`, `entity_id`, `source`, `reason`, `source_citation`.
- "Export CSV" button calls `/api/admin/audit/export` with current filter state.

## 8. Verify retention config seeded (defaults only)

```sql
SELECT key, value FROM public.tournament_config
WHERE key LIKE 'audit.retention.%' OR key = 'notifications.audit_failure_webhook_url'
ORDER BY key;
-- Expect:
--   audit.retention.policy_kind          -> "keep"
--   audit.retention.tournament_end_buffer_months -> 12
--   notifications.audit_failure_webhook_url -> null
```

This slice does NOT yet activate retention enforcement — that's a Slice 008+/operations concern. Just verify defaults exist.

## 9. Constitutional checks

- **Principle II (Security)**: Audit-table tamper privileges revoked at DB layer; admin gating via SECURITY DEFINER body using `is_admin`.
- **Principle V (Auditability)**: Every state-changing slice writes audit rows; this slice freezes that surface and provides admin read access.
- **Principle VI (Time-Zone Correctness)**: `occurred_at` is `timestamptz`; UI displays in tournament timezone.
- **Principle VII (Operational Resilience)**: Tamper-resistance is enforced at the DB layer, not just application layer — even compromised service_role keys cannot rewrite history.
- **Principle XI (Regression-Gated)**: Action label catalog frozen; renaming labels breaks downstream queries.

## 10. Smoke regression checks for prior slices

The new `sequence_id` column and REVOKE statements must not regress prior slices:

```sql
-- Slice 001: auth-hook still writes audit rows
-- Verify by signing in once and checking access.granted appears with a new sequence_id.

-- Slice 002: sync coordinator still writes audit rows
-- Verify by running a manual sync (admin UI from Slice 002) and checking match.updated appears.

-- Slice 003 / 004: prediction submission still writes audit rows
-- Submit a prediction (Slice 003 UI) and check prediction.created appears.

-- Slice 005: score trigger still writes score_record.* rows
-- Recalc via admin_recalc_triggered_now and check score_record.update rows appear.

-- Slice 006: admin RPCs still write admin.* rows with source_citation populated where required.
```

If any of the above fails, the REVOKE step is too aggressive — investigate which writer was using UPDATE/DELETE (should be none; INSERT-only is the locked pattern).

## 11. Cleanup

This slice does not introduce any new persistent test fixtures. After verification, no cleanup is required.

---

## Quickstart deltas (Slice 007)

**Runtime execution DEFERRED** — Docker daemon is currently unavailable on the authoring workstation, so the 12 steps above cannot be executed end-to-end at T028 authoring time. Per slice 005 T040 + slice 006 T040/T041 precedent, T028 ships a code-review verification matrix in lieu of runtime evidence.

See `specs/007-audit-trail/quickstart-verification.md` for the per-step verdict matrix (11/12 GREEN-EXPECTED, 1/12 NEEDS-RUNTIME — step 0 environmental preconditions; 0/12 ARTIFACT-GAP). Runtime confirmation will run in the first Docker-available environment.

No recipe deltas detected at code-review time. If runtime execution surfaces deviations between this recipe and observed behavior, those deltas will be appended below this line by the runtime operator.
