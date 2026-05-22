# Contract: Supabase Auth Hook (primary eligibility gate)

**Slice**: 001-eligibility-login
**Date**: 2026-05-15
**Status**: Phase 1 (Plan).

This contract defines the **primary** server-side eligibility gate (R-002, R-004). Supabase Auth invokes the hook synchronously during sign-in; the hook either admits the user (and provisions / refreshes their `participants` row) or rejects the sign-in (and audits the rejection). The hook runs **inside the auth transaction** — there is no race window between authentication and provisioning.

## Hook bindings

| Supabase Auth event | Hook function | When |
|---|---|---|
| `before_user_created` | `public.handle_auth_user_created` | First-time sign-in (no `auth.users` row yet) |
| `before_user_signed_in` | `public.handle_auth_user_signed_in` | Returning sign-in (existing `auth.users` row) |

Both hooks are `LANGUAGE plpgsql SECURITY DEFINER` and run with elevated privilege so they can write `participants` and `audit_log` regardless of RLS. They are the **only** path through which `participants` is created in this slice (no application-level INSERT, no client INSERT).

## Function shapes

### `handle_auth_user_created(event jsonb) RETURNS jsonb`

**Input** (Supabase-Auth-provided `event` jsonb):

```jsonc
{
  "user_id": "uuid",                           // the to-be-created auth.users.id
  "user_metadata": {
    "email": "kevin.cadavid@nortal.com",       // verified by the IdP
    "display_name": "Kevin Cadavid",           // from IdP claim
    "region": "EE-North"                       // optional
  },
  "claims": { /* full IdP token claims */ }
}
```

**Steps** (all in a single Postgres transaction; failure rolls back everything):

1. Extract `email`, `display_name`, `region` from `event->user_metadata`. If `email` or `display_name` is missing → write audit row `action='access.denied', reason='missing_claims', source='auth_hook'`, return `{ "decision": "reject", "message": "Required identity claims are missing." }`. Supabase Auth aborts the sign-up.
2. Call `public.is_approved_domain(email)`. If `false`:
   - Write audit row `action='access.denied', reason='domain_not_approved', source='auth_hook'`, with `new_value` capturing the attempted email + domain.
   - Return `{ "decision": "reject", "message": "This application is restricted to approved Nortal corporate identities. Contact the tournament administrator if you believe this is a mistake." }`.
   - Supabase Auth aborts; no `auth.users` row is created.
3. `INSERT INTO public.participants (auth_user_id, email, display_name, region, status, first_login_at, last_login_at) VALUES (event->>'user_id', ..., 'active', now(), now())`. The `participants` row trigger emits `participant.created` audit row automatically; the hook does NOT duplicate that audit row.
4. Write audit row `action='access.granted', reason=NULL, source='auth_hook', actor=<new participant.id>, entity_type='participant', entity_id=<new participant.id>, new_value=<row jsonb>`.
5. Return `{ "decision": "continue" }`. Supabase Auth completes sign-up, issues the session JWT.

**Failure modes**:
- Config unreachable (R-007): `is_approved_domain` returns `false` via COALESCE; same path as "domain not approved" — denial, audit, message tagged `reason='config_unavailable'`.
- Unique-violation on `participants_email_uk` (concurrent first-login race): Postgres serializable isolation forces one to fail; the failed one rolls back, the audit row for it is also rolled back. SC-005 ("zero duplicate profiles") satisfied.

### `handle_auth_user_signed_in(event jsonb) RETURNS jsonb`

**Input**: same shape as `handle_auth_user_created` plus an existing `auth.users.id`.

**Steps**:

1. Lookup the `participants` row by `auth_user_id`. **Should** exist; if not, treat as a fresh provisioning and delegate to `handle_auth_user_created` (defensive — handles the case where the user was provisioned by a previous Supabase Auth version that didn't fire `before_user_created`).
2. Call `is_approved_domain(participants.email)`. If `false`:
   - Write `action='access.denied', reason='domain_not_approved', source='auth_hook'`, with `actor=participants.id`.
   - Return `{ "decision": "reject", "message": "<same as above>" }`. Supabase Auth blocks the session issuance.
3. **Refresh whitelist** (R-010): UPDATE `participants` SET `display_name = event->>'display_name'`, `region = event->>'region'`, `last_login_at = now()`. **Do NOT** update `email`. The trigger emits `participant.updated`.
4. **Email-drift detection** (R-010): if `event->user_metadata->>'email' != participants.email`, write a separate audit row `action='participant.email_drift', reason='email_drift_detected', previous_value={email: stored}, new_value={email: idp_payload}`. The participant's stored email is **not** changed.
5. Write `action='access.granted'` audit row.
6. Return `{ "decision": "continue" }`.

## Decision matrix

| Scenario | Email/domain match? | participant exists? | participants.status | Returned decision | Audit action(s) |
|---|---|---|---|---|---|
| Approved + first login | ✅ | No | — | `continue` | `participant.created` (trigger), `access.granted` |
| Approved + returning | ✅ | Yes | `active` | `continue` | `participant.updated` (trigger if anything changed), `access.granted` |
| Approved + returning + email drift | ✅ on stored | Yes | `active` | `continue` | `participant.email_drift`, `access.granted` |
| Approved + returning + deactivated | ✅ | Yes | `deactivated` | `reject` | `access.denied` (reason: `deactivated`) |
| Denied domain + first | ❌ | No | — | `reject` | `access.denied` (reason: `domain_not_approved`) |
| Denied domain + returning (domain removed mid-tournament) | ❌ | Yes | `active` | `reject` | `access.denied` (reason: `domain_not_approved`) |
| Missing claim | — | — | — | `reject` | `access.denied` (reason: `missing_claims`) |
| Config unreachable | — fails closed | — | — | `reject` | `access.denied` (reason: `config_unavailable`) |
| Forged/expired token | (never reaches hook) | — | — | — | Supabase Auth rejects upstream; API guard catches the residual case (R-009) |

## Audit invariants

- **Exactly one** `access.granted` or `access.denied` row per hook invocation. Reviewers MUST reject changes that emit zero or two.
- The audit row's `occurred_at` is in the same transaction as the participant write — never lagging.
- `previous_value` is NULL for `access.denied` (no participant state to capture); the *attempted* identity goes into `new_value` for forensics.

## Performance

| Metric | Target | Why |
|---|---|---|
| p95 latency | < 200 ms | SC-002 (returning user reaches dashboard within 10 s); hook is one slice of that budget |
| Per-hook DB writes | ≤ 2 (participants UPSERT + audit_log INSERT; trigger adds 1 more audit row) | Bounded so the auth pipeline can't be DoS'd by hook complexity |
| Lock contention | Index lookup on `participants(auth_user_id)` only | UNIQUE index; no table-level lock |

## Test surface

Playwright + Deno + pgTAP, authored RED before the hook body is implemented (Principle IX):

| File | Test |
|---|---|
| `slice-001-login-approved.spec.ts` (Playwright) | Sign in via OIDC stub with email `alpha@nortal.com`; assert dashboard renders + `participants` row created with all FR-003 fields + `audit_log` has `access.granted` row |
| `slice-001-login-denied-domain.spec.ts` (Playwright) | Sign in via OIDC stub with email `outsider@example.com`; assert denial UI + zero `participants` rows for that auth_user_id + `audit_log` has `access.denied` with `reason='domain_not_approved'` |
| `slice-001-login-missing-claims.spec.ts` (Playwright) | Sign in via OIDC stub with payload missing `email`; assert denial + audit with `reason='missing_claims'` |
| `slice-001-returning-login-refresh.spec.ts` (Playwright) | First-login as `alpha@nortal.com`; change display_name in stub; sign in again; assert single `participants` row + `display_name` updated + `last_login_at` advanced + zero duplicates |
| `slice-001-email-drift.spec.ts` (Playwright) | Returning login where IdP email differs from stored; assert `participant.email_drift` audit row + stored email unchanged |
| `slice-001-domain-removed-mid-session.spec.ts` (Playwright) | Sign in eligible; admin removes domain from `tournament_config`; sign in again; assert denial + existing predictions preserved (verified via a peek into a Slice 003 spec fixture, NOT by this slice's tables) |
| `auth_hook_first_login.sql` (pgTAP) | Direct invocation of `handle_auth_user_created` with a built event jsonb; assert participants row + 2 audit rows (granted + created) |
| `auth_hook_returning_login.sql` (pgTAP) | Direct invocation of `handle_auth_user_signed_in`; assert UPDATE only, no INSERT, `last_login_at` advanced |
| `auth_hook_fails_closed_on_missing_config.sql` (pgTAP) | Delete `eligibility.approved_domains` row; invoke hook; assert denial |

## Implementation notes (for `/speckit-tasks` to expand)

- The hook is wired via the Supabase dashboard or the `supabase/config.toml` `[auth.hook.*]` block. The migration that creates the function MUST NOT also configure the binding — config goes through CI/CD env, not through migrations.
- The hook's `SECURITY DEFINER` privilege is the **only** elevated path in this slice; the Next.js callback page and `/api/me` both run with the user's JWT (no service-role).
- The hook MUST NOT call any Edge Function (would introduce a network hop and break the same-transaction audit guarantee). All work happens in-Postgres.
- If Supabase Auth's hook contract evolves (e.g., a new event added), this contract is the locked surface — adding a new event handler is permitted, changing the existing ones' decision semantics is not without a constitutional review (Principle II).
