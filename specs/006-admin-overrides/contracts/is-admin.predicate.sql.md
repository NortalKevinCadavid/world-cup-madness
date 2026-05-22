# Contract: `is_admin(uuid)` real body (replaces Slice 001 stub; locked cross-slice)

**Slice**: 006-admin-overrides
**Date**: 2026-05-17
**Status**: Phase 1 (Plan) — **locked cross-slice contract; signature unchanged from Slice 001 stub**.

This contract describes the real implementation of `is_admin(uuid)` that replaces Slice 001's permissive stub. Every slice from 001 onward references this function by name in RLS policies and admin path checks. Signature changes after this slice ships are coordinated cross-slice change sets per Constitution Principle XI.

## Signature (locked from Slice 001)

```sql
CREATE OR REPLACE FUNCTION public.is_admin(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_roles ar
    JOIN public.participants p ON p.id = ar.participant_id
    WHERE p.auth_user_id = p_uid
      AND ar.revoked_at IS NULL
      AND p.status = 'active'
  );
$$;
```

| Property | Value | Why locked |
|---|---|---|
| Name | `public.is_admin` | Every slice from 001+ references by name |
| Argument | `p_uid uuid` (the `auth.uid()` of the caller) | Slice 002–005 RLS uses `is_admin(auth.uid())` |
| Return | `boolean` (never NULL) | RLS `USING` expects boolean |
| Volatility | `STABLE` | Memoizes within a query; re-evaluates between transactions |
| Security | `SECURITY INVOKER` | Honors caller's RLS on `admin_roles` + `participants` |
| `search_path` | `public, pg_temp` | Injection defense |

## Semantics

Returns `true` when **all** of:
1. The caller has a `participants` row with `auth_user_id = p_uid`.
2. The participant's `status = 'active'` (Slice 001's eligibility precondition — composes with admin grant).
3. There exists at least one row in `admin_roles` for that participant where `revoked_at IS NULL`.

Returns `false` in all other cases, including:
- `p_uid IS NULL`.
- No matching `participants` row.
- Participant is deactivated.
- All admin_roles rows for the participant are revoked.
- No admin_roles row exists for the participant.

## Difference from Slice 001 stub

| Aspect | Slice 001 stub | This slice (real) |
|---|---|---|
| Signature | `(uuid) RETURNS boolean STABLE` | **same** |
| Body | `SELECT COALESCE(auth.jwt() ->> 'role' = 'admin', false)` | EXISTS query against `admin_roles` |
| Source of truth | JWT claim | Database row |
| Revocation latency | requires JWT refresh (up to token TTL) | next call after revoke |
| Bootstrap | claim configured at IdP | seed migration inserts first admin |

**Cross-slice impact**: every Slice 002–005 RLS policy that calls `is_admin(auth.uid())` continues to work unmodified — function signature is unchanged. Tests that synthesize JWTs with `{"role": "admin"}` claims (used by Slice 002–005 to satisfy the stub) MUST be updated to instead insert an `admin_roles` row for the test admin participant. This is the only cross-slice test surface change.

## Performance

| Metric | Target | Why |
|---|---|---|
| p95 latency | < 5 ms | Called by every admin-route guard + every RLS policy evaluating admin access |
| Index footprint | 2 PK lookups (`admin_roles_active_uk` + `participants` PK) | UNIQUE PARTIAL on admin_roles + PK on participants |
| Plan caching | STABLE memoization within a query | |

## Test surface

Authored as pgTAP files:

| File | Assertion |
|---|---|
| `is_admin_active_grant.sql` | Pre-state: participant + active admin_roles row. `is_admin(<auth_user_id>)` returns `true` |
| `is_admin_revoked_grant.sql` | Pre-state: participant + admin_roles row with `revoked_at IS NOT NULL`. Returns `false` |
| `is_admin_no_grant.sql` | Participant exists but no admin_roles row. Returns `false` |
| `is_admin_deactivated_participant.sql` | Participant `status='deactivated'` + active admin_roles row. Returns `false` (participant eligibility composes) |
| `is_admin_unknown_uid.sql` | `is_admin(gen_random_uuid())` returns `false` |
| `is_admin_null_uid.sql` | `is_admin(NULL)` returns `false` (not NULL) |
| `is_admin_revoke_then_regrant.sql` | Revoke + insert new row → returns `true` again (multiple historic rows handled correctly via the active partial index) |
| `is_admin_perf.sql` | 1,000 invocations on a 500-participant dataset; p95 < 5 ms |
| `is_admin_uses_db_state_not_jwt.sql` | Set JWT with `"role": "admin"` claim but NO admin_roles row → returns `false` (proves the new body uses DB state, not JWT) |

All authored RED before the function body is replaced (Constitution Principle IX).

## Consumers (downstream contract dependents)

Every slice from 001 onward references this function. They all continue to work unchanged:

| Slice | Surface | Continues to work via |
|---|---|---|
| 001 (stub-replaced) | RLS on `participants` (admin-read policy) | Body change is transparent — same signature |
| 002 | RLS on `match_provider_external_ids`, `provider_sync_runs`, `provider_sync_state`, `match_pending_review` | Same |
| 003 | RLS `predictions_admin_read`; admin path for `submit_prediction(..., source='admin_override')` | Same |
| 004 | RLS `final_predictions_admin_read`, `player_provider_external_ids_admin_read`; admin path for `submit_final_prediction(..., source='admin_override')` | Same |
| 005 | RLS `score_records_admin_read`, `tournament_award` write | Same |
| 006 (this slice) | Every `admin_*` RPC pre-check; `/admin/*` route guards | New consumer added by this slice |

**Cross-slice test surface migration**: any Slice 002–005 pgTAP / Playwright test that previously set `request.jwt.claims = '{"role":"admin"}'` to satisfy the stub MUST be updated to also `INSERT INTO admin_roles (participant_id, ...) VALUES (<test admin id>, ...)`. This is enforced by T002 of this slice's `tasks.md` (the regression-baseline-from-001-005 task identifies + migrates these tests).

## Versioning policy

- Body changes are allowed but MUST preserve: returns `true` exactly when an active, non-revoked admin role exists for an active participant; STABLE volatility; SECURITY INVOKER.
- Signature changes (parameter, return type) are **breaking** and require coordinated update across every consumer slice.
- Function name MUST NOT change.

## Related contracts

- `admin-rpcs.write.md` — the family of RPC wrappers that pre-check this predicate.
- Slice 001's data-model.md § cross-slice ownership map originally tagged this stub for replacement; this slice fulfills that.
