# Contract: Eligibility Predicate (`is_eligible_nortal_participant`)

**Slice**: 001-eligibility-login
**Date**: 2026-05-15
**Status**: Phase 1 (Plan) — locked cross-slice contract.

This contract defines the SQL function that every other slice's RLS policies reference. **It is a locked cross-slice contract.** Slices 002–008 build RLS on top of this function; changing its signature, return type, volatility, or semantics requires a coordinated change set across every consuming slice (Constitution Principle XI).

## Signature

```sql
CREATE OR REPLACE FUNCTION public.is_eligible_nortal_participant(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.participants p
    WHERE p.auth_user_id = p_uid
      AND p.status = 'active'
      AND public.is_approved_domain(p.email)
  );
$$;
```

| Property | Value | Why locked |
|---|---|---|
| Name | `public.is_eligible_nortal_participant` | Referenced by every slice's RLS by name |
| Argument | `p_uid uuid` (single, the `auth.uid()` of the caller) | Slice 002+ RLS uses `is_eligible_nortal_participant(auth.uid())` |
| Return | `boolean` (never NULL) | RLS `USING` expects boolean; NULL would be treated as false but is unsafe |
| Volatility | `STABLE` | Allows Postgres to cache within a query; re-evaluates between transactions (R-006) |
| Security | `SECURITY INVOKER` | Runs as the caller; honors caller's RLS on `participants` and `tournament_config` |
| `search_path` | `public, pg_temp` | Defense-in-depth against `search_path` injection |

## Semantics

`is_eligible_nortal_participant(p_uid) = true` **if and only if** all three hold:

1. There is a row in `public.participants` with `auth_user_id = p_uid` (the user has been provisioned at least once).
2. That row's `status = 'active'` (the user has not been deactivated by an admin per Slice 006).
3. `public.is_approved_domain(participants.email)` returns `true` (the user's stored email domain is currently in the approved list).

Returns `false` in all other cases, **including**:
- `p_uid IS NULL`.
- No matching participant row exists (user has authenticated via Supabase Auth but the auth-hook denied provisioning — should be impossible post-R-004, but defensive).
- The participant row exists but `status='deactivated'`.
- The participant's stored email's domain has been removed from `tournament_config.eligibility.approved_domains`.
- `tournament_config.eligibility.approved_domains` is missing or unreadable (fail-closed per R-007).

## Performance

| Metric | Target | Why |
|---|---|---|
| p95 latency | < 5 ms | Called inline by every other slice's RLS — must not dominate query plans |
| Index footprint | 1 lookup on `participants(auth_user_id)`, 1 lookup on `tournament_config(key)` | Both UNIQUE indexes |
| Plan caching | Stable across a single query | `STABLE` volatility allows Postgres plan-level memoization |

## Test surface

Authored as pgTAP tests in `supabase/tests/pgtap/`:

| Test | Assertion |
|---|---|
| `is_eligible_active_approved.sql` | Returns `true` for an active participant whose email domain is in the seed list |
| `is_eligible_deactivated.sql` | Returns `false` for a participant with `status='deactivated'` (same domain, same auth_user_id) |
| `is_eligible_unknown_uid.sql` | Returns `false` for a random UUID with no matching participant |
| `is_eligible_null_uid.sql` | Returns `false` (not NULL) for `is_eligible_nortal_participant(NULL)` |
| `is_eligible_domain_removed.sql` | Setup: provision participant; remove their domain from `tournament_config.eligibility.approved_domains`; assert returns `false` on the **next** call without bumping anything else |
| `is_eligible_config_missing.sql` | Delete the `eligibility.approved_domains` row from `tournament_config`; assert function returns `false` (fail-closed, R-007) |
| `is_eligible_rls_applied.sql` | Call the function under a JWT that should NOT see `tournament_config`; assert it returns `false` (RLS denies the underlying read; defense-in-depth) — note: the seed migration grants SELECT on the `eligibility.approved_domains` key unconditionally to avoid recursion, so this test specifically asserts the *fallback* path, not the happy path |
| `is_eligible_perf.sql` | Run 1,000 invocations against a 500-row `participants` table; assert p95 latency < 5 ms |

All seven tests MUST be authored BEFORE the function body is implemented (Constitution Principle IX, NON-NEGOTIABLE).

## Consumers (downstream contract dependents)

Each of the following will reference this function in its RLS as soon as it ships:

| Slice | Tables that will use `is_eligible_nortal_participant(auth.uid())` in `USING` |
|---|---|
| 002 (Match Catalog) | `matches`, `match_results` (read-side; admin writes via Slice 006) |
| 003 (Match Predictions) | `predictions` (self-read + self-write); FR-008 lock check is additional |
| 004 (Final Predictions) | `final_predictions` (self-read + self-write); FR-010 lock check is additional |
| 005 (Scoring & Leaderboard) | `score_records` (self-read); `leaderboard_v` view-level filter; `peer_pick_v` (with lock add-on) |
| 006 (Admin Overrides) | All admin writes are gated by `is_admin()` instead, but admin user must also pass eligibility (defense-in-depth) |
| 007 (Audit Trail) | `audit_log` reads gated by `is_admin()`; participant self-read NOT exposed |
| 008 (Configuration) | `tournament_config` reads — see § Data Model RLS posture for the recursion-avoidance carve-out |

## Versioning policy

The function name and signature MUST NOT change after this slice ships. Body changes (e.g., adding a "must be in a `roles` table" clause) are allowed but MUST:

1. Update every consuming slice's RLS regression suite (Principle XI).
2. Update the Slice 001 spec and this contract in the same change set.
3. Bump the slice's `regression-final.md` to reflect the new behavior.

The function is **deliberately not versioned** (no `_v1` / `_v2` suffix): the signature is part of the cross-slice public surface and version drift would require renaming references in every slice's RLS — exactly the lock-in this contract prevents.

## Related helpers (same slice)

`is_approved_domain(p_email text) RETURNS boolean STABLE` — internal helper used by this function and by the auth hook. Not a cross-slice contract (no other slice's RLS calls it directly).

`is_admin(p_uid uuid) RETURNS boolean STABLE` — stubbed permissively by this slice (`auth.jwt() ->> 'role' = 'admin'`), owned by Slice 006. **Also** a cross-slice contract; same locked-signature discipline applies.
