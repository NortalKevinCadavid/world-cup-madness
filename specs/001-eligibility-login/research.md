# Phase 0 Research: Eligibility & Login

**Feature**: 001-eligibility-login
**Date**: 2026-05-15
**Status**: Complete — no spec-level `[NEEDS CLARIFICATION]` markers remain. OD-001 (exact approved domain list) is owned by Slice 008 and is intentionally **not** resolved here; this slice picks the *mechanism* by which the eventual list is consumed. The decisions below resolve the Supabase/Next.js implementation-pattern unknowns so that Phase 1 (data-model.md + contracts/) can proceed deterministically.

## Scope of this document

Each entry follows the template `Decision / Rationale / Alternatives considered / Constitution anchor`. Decisions that resolve directly to a spec FR, an architecture §, or a constitution principle are tagged.

This slice is the **foundation** for slices 002–008: every subsequent slice's RLS, profile lookup, and "who is the caller" decision flows through the primitives introduced here. Cross-slice contracts (the `participants` table shape, the `is_eligible_nortal_participant(uid)` SQL function, the `audit_log` write pattern) MUST stay stable after this slice ships.

---

## R-001 — Identity-provider integration

**Decision**. Authentication is delegated to **Supabase Auth** configured with an external OAuth/OIDC provider for Nortal corporate identity. The expected production provider is **Microsoft Entra ID (Azure AD)** since Nortal collaborators authenticate against a Microsoft tenant; the integration treats it as one OIDC provider among many — Slice 008 can swap providers without touching this slice's code.

Supabase Auth handles the OAuth dance (redirect, callback, state, PKCE, token exchange, refresh) and writes the verified identity into the managed `auth.users` and `auth.identities` tables. This slice consumes those tables read-only and writes its own `public.participants` row keyed by `auth_user_id`.

**Rationale**.
- Spec §1 (User Story 1) and FR-001 require corporate-IdP authentication; the spec is explicit that this slice does **not** build authentication primitives from scratch (§Assumptions).
- Constitution *Implementation Platform* ratifies Supabase as the backend; Supabase Auth ships the OAuth provider plumbing, refresh, JWT signing, and the `auth.uid()` helper that every other slice's RLS uses.
- Treating the IdP as one OIDC provider behind Supabase Auth's adapter satisfies Principle I (Technology Neutrality at the architectural layer) and Principle IV-style provider abstraction for identity: replacing Entra ID with Okta/Google Workspace later is a Supabase Auth config change, not a code change.

**Alternatives considered**.
- *Custom Next.js auth (e.g., NextAuth.js) on top of Postgres*. Rejected: reinvents Supabase Auth's session/refresh/JWT plumbing, duplicates the `auth.users` table the rest of the project's RLS already targets, and breaks the constitution's *Implementation Platform* assumption.
- *Pure client-side SAML/OIDC SDK without Supabase Auth*. Rejected: cannot drive Postgres RLS without a Supabase-issued JWT.
- *Username/password stored in the application database*. Rejected: violates spec §Assumptions ("does not build authentication primitives") and Eligibility/Privacy constraint *Authentication* (no local passwords).

**Constitution anchor**. II (Security by Design), *Implementation Platform*.

---

## R-002 — Multi-layer domain restriction

**Decision**. Domain eligibility is enforced at **four** server-side layers per architecture §11.2:

1. **Identity-policy layer** (Supabase Auth provider config): the OIDC provider is restricted to the Nortal tenant where the IdP supports it (Entra ID app registration locked to the Nortal directory). This is a soft outer ring; it MUST NOT be the sole gate because guest accounts and B2B invites can still authenticate against a tenant.
2. **Auth Hook** (`before_user_created` / `before_user_signed_in` Supabase Auth hook): runs server-side after the IdP confirms the user but before Supabase Auth issues its session JWT. Reads the verified email's domain, checks it against `tournament_config.eligibility.approved_domains`, and either allows the sign-in (and triggers provisioning per R-004) or rejects with a domain-denied error and writes the audit row (R-008). **This is the gate that turns "authenticated" into "eligible".**
3. **Row-Level Security** (Postgres RLS): every participant-data table has a `USING is_eligible_nortal_participant(auth.uid())` predicate. Even if a session JWT somehow exists for a non-eligible user (e.g., the auth-hook bypass was misconfigured), Postgres returns zero rows on read and rejects writes. This is the *hard* gate — bypassing it requires Postgres credentials, not a session.
4. **Edge Function / API route guard**: every state-changing handler calls `is_eligible_nortal_participant(auth.uid())` as the first check and returns `403 Forbidden` (with the same body shape as the UI denial) if it returns false. Required for FR-002's "deny direct API access regardless of route" and architecture §11.2 control 30.

**Rationale**.
- FR-002 explicitly forbids UI-only gating; architecture §11.2 enumerates four bypass scenarios that exactly require these four layers.
- Constitution Principle II ("Security by Design") and Principle III ("Rules Outside the UI") both require server-side enforcement; the auth hook + RLS pattern places the check in the database and the auth pipeline, not the frontend.
- The auth hook is the *only* layer that can deny the session itself (i.e., prevent the user from ever obtaining a Supabase JWT). RLS and route guards prevent damage when an eligible-when-issued session is later revoked (mid-tournament domain removal — spec Edge Cases).

**Alternatives considered**.
- *RLS-only enforcement*. Rejected: a non-eligible user could still obtain a Supabase JWT and see "you have no data" instead of a clean denial, leaking the existence of the application's surface area and producing no audit trail at the *attempt* level.
- *Auth Hook only*. Rejected: a JWT issued before a domain is removed from the allow-list would continue to grant reads until token expiry; RLS is the safety net that re-checks on every query.
- *Application-tier middleware only* (Next.js middleware that checks the domain on every request). Rejected: violates Principle III; the rule lives in the application layer instead of at the data boundary, and any new surface (admin tools, exports, mobile) would need to re-implement it.

**Constitution anchor**. II (Security by Design), III (Rules Outside the UI). Supports **FR-001, FR-002, SC-001**.

---

## R-003 — Participant identifier strategy

**Decision**. `participants.id` is an application-generated **UUID v4** (PK), independent of Supabase Auth's `auth.users.id`. A separate `participants.auth_user_id uuid UNIQUE NOT NULL FK → auth.users(id) ON DELETE RESTRICT` carries the link. Every other slice that needs to identify a participant uses `participants.id`, not `auth.users.id`.

**Rationale**.
- Spec §Assumptions: "Participant identifiers are stable across the tournament and are independent of the identity provider's internal user identifier (so the IdP can be replaced without breaking historical predictions)." Decoupling from `auth.users.id` is the literal implementation.
- A future IdP migration (Entra ID → Okta) would otherwise rewrite every foreign key in slices 003–007.
- `ON DELETE RESTRICT` (instead of `CASCADE`) prevents the deletion of a Supabase Auth user from silently destroying tournament data; participation deactivation is handled by the `status` field, not by row deletion.

**Alternatives considered**.
- *Use `auth.users.id` directly as the participant PK*. Rejected: forecloses IdP replacement, and Supabase upgrades have historically changed `auth.users` row semantics.
- *Email as the natural key*. Rejected: emails can change at the IdP (display-name flips, marriage, transfers); a stable internal UUID survives those changes.

**Constitution anchor**. I (Technology Neutrality — at the data-model layer), IV (Provider Abstraction — applied to identity, not just football data).

---

## R-004 — Profile provisioning trigger

**Decision**. Profile creation runs inside a Supabase **Auth Hook** (Postgres function) wired to the `before_user_created` event. The hook:

1. Extracts the verified email and domain from the IdP payload.
2. Checks the domain against `tournament_config.eligibility.approved_domains` (R-005). If not eligible: writes an `audit_log` row with `action='access.denied'` and returns `error_message` to Supabase Auth, which aborts user creation. No `auth.users` row is created; no `participants` row is created.
3. If eligible: creates the `participants` row with display_name, email, domain, region (if present), `status='active'`, `first_login_at=now()`, `last_login_at=now()`. Writes an `audit_log` row with `action='access.granted'`. Returns success.

A separate hook on `before_user_signed_in` re-checks eligibility on every login (handles the mid-tournament domain-removal edge case from spec Edge Cases) and updates `last_login_at` plus refreshable profile fields (R-010).

**Rationale**.
- The hook runs **server-side, with elevated privilege, in the auth transaction** — exactly where the spec wants the gate (FR-002, FR-003, architecture §11.2 control 29).
- Provisioning inside the auth transaction guarantees atomicity: either the user is created AND the profile is provisioned AND the audit row is written, or none of them are. No client-side race window.
- Auth Hooks are the documented Supabase mechanism for this pattern (`supabase/auth-hooks`).

**Alternatives considered**.
- *Client-side provisioning after login* (Next.js callback page reads session, calls `INSERT INTO participants`). Rejected: a hostile client could skip the call, and the gap between IdP success and participant insert leaks "session without profile" state.
- *Server-side Next.js route handler invoked from the auth callback page*. Acceptable as a secondary path (e.g., to refresh display name on every login — see R-010), but not the primary gate; an attacker could complete the IdP flow and skip the callback page.
- *Postgres trigger on `auth.users` INSERT*. Rejected as the *gate* (the trigger fires after `auth.users.id` already exists; rolling back requires `DELETE FROM auth.users` from within a trigger, which is fragile). Acceptable as a *belt-and-braces* secondary trigger that refreshes `last_login_at` if the Auth Hook's transactional update was somehow skipped.

**Constitution anchor**. II (Security by Design), V (Auditability — atomic audit with the action), VII (Operational Resilience — no orphan profiles).

---

## R-005 — Approved-domain configuration source

**Decision**. The approved-domain list lives in `tournament_config` (Slice 008's table) under key `eligibility.approved_domains`. Value type: `jsonb` array of lowercase domain strings, e.g. `["nortal.com", "nortal.us"]`. This slice **does not** create the `tournament_config` table (Slice 008 owns it); if the table does not yet exist when this slice's migrations run, this slice creates the minimal `(key text PK, value jsonb, updated_at timestamptz, updated_by uuid)` shape — same pattern Slice 005 uses (research § R-014). A seed migration inserts `eligibility.approved_domains = ["nortal.com"]` as a working default; Slice 008's admin UI changes it.

A read helper `public.is_approved_domain(p_email text) RETURNS boolean LANGUAGE sql STABLE` encapsulates the lookup (case-insensitive match on the email's domain part against the jsonb array). The auth hook, the RLS predicate (R-006), and the API guards all call this helper; none reads the config table directly.

**Rationale**.
- FR-007 ("approved-domain list as live configuration sourced from Slice 008, changes effective within 1 minute") rules out hardcoding.
- Architecture §11.2 control 27 ("Identity policy: restrict eligible sign-in where the corporate identity platform supports it") and §13.1 *Allowed domains* both place the list in admin tooling.
- Centralizing the lookup in one SQL function means future changes (regex domains, sub-domain wildcards, tenant claims) modify one body, not four callers.
- Bumping `tournament_config.eligibility.approved_domains` invalidates **no caches** because every check reads the table fresh; SC-004 (config change effective in ≤ 1 minute) is satisfied without any cache plumbing.

**Alternatives considered**.
- *Environment variable*. Rejected: requires a deploy to change, violates FR-007 and Principle VIII (Extensibility & Configuration).
- *Dedicated `approved_domains` table*. Acceptable but doubles the admin-tool surface area; Slice 008 already standardizes on `tournament_config(key, value)` for every other config-shaped value.
- *Identity-provider-only allow-list* (no DB-side list at all). Rejected: cannot honor mid-tournament removals fast enough; IdP changes can take >1 minute to propagate and require IdP admin rights, which is broader than tournament-admin scope.

**Constitution anchor**. VIII (Extensibility & Configuration). Supports **FR-007, SC-004**.

---

## R-006 — Cross-slice eligibility predicate

**Decision**. Define one SQL function used by every slice from 002 onward:

```sql
CREATE OR REPLACE FUNCTION public.is_eligible_nortal_participant(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER  -- runs as the caller; RLS on tournament_config applies
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

Every slice's RLS policy references this function as `USING is_eligible_nortal_participant(auth.uid())`. The function MUST stay backward-compatible across slices — its signature, return type, and semantics are a **cross-slice contract** locked in by this slice. Changes to the function body require coordinating regression tests in every consuming slice (Constitution Principle XI).

The function is `STABLE` (not `IMMUTABLE`) so Postgres can cache it within a query but will re-evaluate it between transactions — necessary because `tournament_config.eligibility.approved_domains` and `participants.status` can change.

**Rationale**.
- A single named predicate is the *one place* the eligibility rule lives (Principle III). RLS policies in slices 002–007 all delegate to it; if FR-001's semantics ever evolve (e.g., "must also be in `participants.role IN (...)`"), the change is one function body.
- `SECURITY INVOKER` (not `DEFINER`) means the function honors the caller's RLS on `participants` and `tournament_config`. The function is deliberately **not** a privilege-escalation hop.
- Naming: `is_eligible_nortal_participant` over `is_participant` because the latter elides the **eligibility** dimension (which can flip at runtime); the former forces every reader to think about the runtime check, not just the membership check.

**Alternatives considered**.
- *Embed the EXISTS clause inline in every RLS policy*. Rejected: duplicates the rule, defeats Principle III, makes the FR-007 mid-tournament change a multi-policy edit.
- *Cache the result in a session variable*. Rejected: stale-data risk on the FR-007 1-minute window; the EXISTS query is cheap (single index lookup) and Postgres's plan cache reuses it across rows in the same query.

**Constitution anchor**. III (Rules Outside the UI), VIII (Configuration). Cross-slice locked contract for slices 002–008.

---

## R-007 — Fail-closed when eligibility data is unavailable

**Decision**. Every layer in R-002 fails closed when its eligibility input is unreachable:

| Layer | Failure mode | Behavior |
|---|---|---|
| Auth Hook | `tournament_config` row missing or unreadable | Return error to Supabase Auth, abort sign-in, write `audit_log` row with `action='access.denied'` and `reason='config_unavailable'` |
| RLS predicate | `is_approved_domain()` raises an exception | Postgres aborts the query (which the application surfaces as 500/403 to the user); RLS returns zero rows — never *all* rows |
| API guard | `is_eligible_nortal_participant()` returns NULL (e.g., Postgres unreachable mid-request) | Treat NULL as false; return 403 |

The `is_approved_domain()` function uses `COALESCE(... ,false)` so a missing config row evaluates to "no domains approved" → all checks fail, no one is admitted.

**Rationale**.
- FR-008 explicitly mandates fail-closed.
- Spec Edge Case: "user attempts to sign in while the application's domain configuration store is temporarily unreachable → access MUST be denied by default (fail-closed), not granted."
- Constitution Principle II (Security by Design) forbids deny-bypass defaults.

**Alternatives considered**.
- *Cache the last-known-good config and serve from it on outage*. Rejected: the cache itself becomes a stale-data hazard during the FR-007 1-minute change window, and a stale-allow is the worst-case failure for FR-002.
- *Return 503 instead of 403 on config unavailability*. Acceptable as the HTTP status (signals operations); the **eligibility decision** is still denial — the user/agent does not get through.

**Constitution anchor**. II. Supports **FR-008** and the spec Edge Case "config store unreachable".

---

## R-008 — Audit integration with Slice 007

**Decision**. This slice writes access-decision audit rows to the `audit_log` table whose canonical shape is owned by Slice 007. Until Slice 007 ships, this slice creates a **stub** with the same shape Slice 005 uses (research § R-012):

```sql
CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor uuid,                                -- may be NULL for denied-access (no participant exists yet)
  action text NOT NULL,                      -- 'access.granted' | 'access.denied' | 'participant.created' | 'participant.updated'
  entity_type text,                          -- 'participant' | 'auth_attempt'
  entity_id uuid,                            -- participants.id when known; NULL on denied-pre-create
  previous_value jsonb,
  new_value jsonb,
  reason text,                               -- 'domain_not_approved' | 'config_unavailable' | 'signature_mismatch' | 'missing_claims' | etc.
  source text,                               -- 'auth_hook' | 'rls' | 'api_guard' | 'ui'
  occurred_at timestamptz NOT NULL DEFAULT now()
);
```

Slice 007 will harden retention, tamper-resistance, and search; the contract this slice is responsible for is **always write through this table**, never out-of-band. The audit write happens in the same transaction as the auth-hook decision (Principle V atomicity).

**Rationale**.
- FR-006 mandates an audit row per denied attempt with the exact field set above.
- FR-018 / Constitution Principle V mandate same-transaction audit writes.
- Spec Acceptance Scenario US2.3 requires the audit row to carry `timestamp, source (UI/API), attempted identity, attempted domain, reason`.
- The cross-slice contract (`audit_log` table shape) MUST stay compatible with what Slice 005's `score_record.insert` trigger writes and what Slice 007 eventually owns.

**Alternatives considered**.
- *Defer all audit writes until Slice 007 ships*. Rejected: this slice's spec requires the audit rows (FR-006); we cannot leave US2.3 untestable.
- *Separate `access_decisions` table just for this slice*. Rejected: bifurcates the audit surface, defeats "single auditable trail" goal in §11.1.

**Constitution anchor**. V (NON-NEGOTIABLE: audit in same transaction). Cross-slice: Slice 007 hardens the table; Slices 005, 006, 008 write to it too.

---

## R-009 — Session re-verification on every state-changing request

**Decision**. Every Next.js route handler and Supabase Edge Function that mutates state MUST, as the **first** check after JWT parse, call `is_eligible_nortal_participant(auth.uid())` and reject (403) if it returns false. RLS is the safety net; the explicit re-check produces a deterministic 403 response shape and an audit row at the API surface (not buried in a Postgres-level deny).

A small TypeScript helper `lib/auth/requireEligible(client: SupabaseClient): Promise<Participant>` centralizes the check — every handler calls it; PR review rejects handlers that don't.

**Rationale**.
- FR-002 ("validate eligibility at the server boundary … on every authenticated session and every state-changing request").
- Architecture §11.2 control 28 ("Application authorization: validate the authenticated user's normalized email domain or tenant claim on every session and sensitive operation").
- Acceptance Scenario US1.3: "any subsequent state-changing request … MUST re-verify domain eligibility from the current session identity (not from a cached client claim) before honoring the request."
- RLS alone produces "no rows" / "permission denied" responses without the audit-at-API-surface; the explicit check makes the denial first-class.

**Alternatives considered**.
- *Rely on RLS only*. Rejected (per above).
- *Middleware-level check in Next.js*. Acceptable as a *belt* (broad coverage), but the per-handler check is the **braces** that survives middleware misconfiguration; both are present in this slice.

**Constitution anchor**. II, III. Supports **FR-002, SC-001**.

---

## R-010 — Profile refresh strategy on returning login

**Decision**. The `before_user_signed_in` Auth Hook runs an UPSERT on `participants` keyed by `auth_user_id`. Only a whitelist of fields is refreshed from the IdP payload: `display_name`, `region` (if present in the payload). `email`, `domain`, `participant_id`, `first_login_at`, and `status` are **not** overwritten by the hook — if the IdP-side email changes, that's a flag for admin review, not a silent rewrite. `last_login_at` is always set to `now()` in the same transaction.

If the IdP payload contains an email *different* from the stored `participants.email` for the same `auth_user_id`, the hook writes an `audit_log` row with `action='participant.email_drift'` and proceeds with the *stored* email for the eligibility decision — never with the IdP's new email — until an admin (Slice 006) reconciles. This protects against an IdP-side account-takeover that swaps the linked email under a still-valid `auth.users.id`.

**Rationale**.
- FR-004 ("refresh existing participant's mutable profile attributes on subsequent eligible sign-ins without creating duplicates and without altering the participant identifier").
- Acceptance Scenario US3 ("returning user with changed attributes"): explicit on display_name and region; silent on email.
- Spec §Assumptions: participant identifier is stable across the tournament — implies email isn't load-bearing for identification once provisioned.
- Constitution Principle V (Auditability) — silent email rewrites are exactly the kind of change disputes blame on the system.

**Alternatives considered**.
- *Refresh every field including email on every login*. Rejected: account-takeover risk described above; spec doesn't require it.
- *Never refresh anything after provisioning*. Rejected: spec US3 explicitly wants display_name and region to refresh.

**Constitution anchor**. V, II. Supports **FR-004, US3**.

---

## R-011 — Edge-case handling matrix

**Decision**. Map each spec Edge Case to a specific layer + behavior so contracts and tests can reference them by ID:

| ID | Edge case (from spec) | Resolution layer | Behavior |
|---|---|---|---|
| E-1 | IdP payload missing email or domain claim | Auth Hook | Deny; audit `reason='missing_claims'`; no `auth.users` row created |
| E-2 | Approved-domain config changed mid-session | RLS + API guard | Next request re-evaluates `is_eligible_nortal_participant()`; previously-eligible session is silently denied on next state-changing op |
| E-3 | Previously-eligible participant's domain removed mid-tournament | Same as E-2 + `participants.status` left untouched | Existing predictions/audit preserved; admin (Slice 006) decides whether to mark `status='deactivated'` — this slice never auto-deactivates |
| E-4 | IdP returns a session that fails server-side signature verification | Supabase Auth | Supabase Auth rejects before this slice's hook fires; nothing further is needed here. Document this in the contract so reviewers know it's covered upstream. |
| E-5 | Config store unreachable | Auth Hook + API guard | Fail closed per R-007 |
| E-6 | One human, two corporate identities under different approved domains | Auth Hook | Two `auth.users` rows → two `participants` rows (FR-004 says no silent merge); admin Slice 006 can manually link them later if business chooses |
| E-7 | Forged or expired token presented to direct API | Supabase Auth (token validation) + API guard | Supabase Auth rejects at JWT parse; if somehow accepted, the API guard's `auth.uid() IS NULL → 403` check denies before any participant lookup. Audit `reason='invalid_token', source='api_guard'` |

Each row above maps 1:1 to a Playwright/pgTAP scenario that `/speckit-tasks` will generate.

**Constitution anchor**. II, V, VI, IX. Supports **all spec Edge Cases**.

---

## R-012 — Performance and SLA posture

**Decision**.

- **Auth Hook latency budget**: < 200 ms p95 (well under SC-002's 10 s end-to-end target). The hook does one config read + one upsert + one audit insert; all indexed.
- **Eligibility predicate latency**: < 5 ms p95 (single-row exists, single jsonb membership check; both indexable).
- **Returning-login dashboard**: end-to-end < 10 s p95 (SC-002), with the auth hook + redirect dominating the bottom-half of the budget.
- **Concurrent returning logins** (SC-005): no duplicate-row risk because `participants.auth_user_id` is `UNIQUE`; upsert on conflict do nothing for the row + always-update `last_login_at` produces exactly-one row per identity under any race.

**Rationale**. Foundational slice — every other slice's request latency starts with this slice's check. Keeping the per-request eligibility decision sub-5-ms keeps the Slice 005 leaderboard SLA (1s p95) achievable.

**Constitution anchor**. VII (Operational Resilience). Supports **SC-002, SC-005**.

---

## R-013 — Out of scope (intentionally deferred)

The following are **not** resolved by this slice and remain for downstream work:

- **Admin role / role-based access**: spec §Assumptions explicitly defers this to Slice 006 (Admin Overrides) and Slice 008 (Configuration). The `is_admin(uid)` predicate is **not** introduced here — Slice 006 owns it.
- **OD-001 (exact approved-domain list)**: tracked to Slice 008. This slice's seed default `["nortal.com"]` is a placeholder for local dev; production launch is gated on Slice 008's admin UI.
- **OD-008 (notification channels)**: unrelated to eligibility; this slice does not send notifications.
- **Multi-tenant participation** (different tournaments, leagues, regions): this slice models one tournament; multi-tenant is a constitutional-level future amendment per Principle X (Vertical Slice Delivery — ship one before generalizing).

**Rationale**. Constitution Principle X — vertical slices ship one complete capability at a time. Pulling admin or multi-tenant into this slice would block the foundation and is a constitution violation.

**Constitution anchor**. X. Tracked deferrals: OD-001, OD-008.

---

## Summary

All implementation-pattern unknowns are resolved. The slice can proceed to Phase 1 (data-model.md + contracts/ + quickstart.md). The constitution check below (in `plan.md` § Constitution Check) will reference these decisions by ID.
