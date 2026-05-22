# Phase 1 Data Model: Eligibility & Login

**Feature**: 001-eligibility-login
**Date**: 2026-05-15
**Status**: Draft (Phase 1 output)
**Vendor-neutral**: This document describes capabilities and entities (Principle I). Concrete Supabase/Postgres details live in `plan.md` § Source Code and in `contracts/`.

## Cross-slice ownership map

This slice **owns** one new table (`participants`) and one new SQL function (`is_eligible_nortal_participant`). It also **reads** from one table owned by Slice 008 (`tournament_config`) and **writes** to one table owned by Slice 007 (`audit_log`). Until those owner slices ship, this slice creates minimal stubs of their tables; the stubs are designed to be a strict subset of the eventual shape so the owner slice's migration only **extends**, never **alters**, what this slice introduced.

| Artifact | Owner slice | This slice's responsibility |
|---|---|---|
| `public.participants` | **001 (this slice)** | Create, RLS, indexes |
| `public.is_eligible_nortal_participant(uuid)` | **001 (this slice)** | Define; cross-slice contract |
| `public.is_approved_domain(text)` | **001 (this slice)** | Define; internal helper |
| `public.tournament_config` | 008 | Stub create (key/value); seed `eligibility.approved_domains` |
| `public.audit_log` | 007 | Stub create; write `access.*` and `participant.*` rows |
| `auth.users` / `auth.identities` | Supabase Auth | Read-only consumer |

The `is_eligible_nortal_participant(auth.uid())` signature and semantics are **locked** by this slice as a cross-slice contract. Slices 002–008 reference it in their RLS policies; changing its body in a future slice MUST update every consuming RLS policy in the same change set (Constitution Principle XI).

## Entities introduced by this slice

### 1. Participant

**Purpose**. The application-side identity of a Nortal collaborator who has been verified eligible at least once. Stable across the tournament; decoupled from `auth.users.id` so the IdP can be replaced without rewriting downstream tables (see [research.md § R-003](./research.md#r-003--participant-identifier-strategy)).

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | Application-side identifier; referenced by every other slice's FKs |
| `auth_user_id` | UUID | UNIQUE NOT NULL, FK → `auth.users(id)` ON DELETE RESTRICT | The Supabase Auth user; `ON DELETE RESTRICT` so deleting an auth user can't silently drop tournament data |
| `email` | citext | NOT NULL | Stored normalized lowercase via the `citext` extension; the email at the time of provisioning. Refreshed only via admin intervention (see R-010) |
| `display_name` | text | NOT NULL | Refreshable on every login (R-010) |
| `domain` | citext | NOT NULL, GENERATED ALWAYS AS (lower(split_part(email, '@', 2))) STORED | Computed from `email`; lets RLS and analytics filter on domain without re-parsing |
| `region` | text | NULL allowed | Optional IdP claim; refreshable on every login (R-010) |
| `status` | enum | NOT NULL, one of `active`, `deactivated`, default `active` | Slice 001 only writes `active`; Slice 006 admin actions can flip to `deactivated` |
| `first_login_at` | timestamptz | NOT NULL, server-default `now()` | Set once at provisioning; never updated |
| `last_login_at` | timestamptz | NOT NULL, server-default `now()` | Updated by every `before_user_signed_in` auth-hook firing |
| `created_at` | timestamptz | NOT NULL, server-default `now()` | Row-create timestamp; identical to `first_login_at` for this slice but separated for symmetry with other tables |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | Trigger-maintained on every UPDATE |

**Unique constraints**.
- `auth_user_id` UNIQUE — one participant per Supabase Auth identity.
- `email` UNIQUE (case-insensitive via `citext`) — guards against double-provisioning if the same email somehow arrives under two `auth.users.id`s (FR-004 anti-duplication; spec Acceptance Scenario US1.2).

**Validation rules**.
- `email` MUST contain exactly one `@` (Postgres CHECK).
- `domain` is generated and is therefore always consistent with `email`; no separate validation.
- `display_name` MUST NOT be empty after trim (CHECK).
- `status='active'` is the only state this slice writes; transitioning to `deactivated` is Slice 006's contract.

**State transitions**.
- Created with `status='active'` by the `before_user_created` auth hook (R-004).
- `last_login_at` and refreshable fields (`display_name`, `region`) updated on every successful `before_user_signed_in` firing.
- `status='deactivated'` written only by Slice 006 admin overrides (out of scope here, contract anchor only).

**Relationships**.
- 1:1 → `auth.users` (via `auth_user_id`).
- 1:N → every other slice's participant-keyed table (predictions, score_records, etc. — they FK to `participants.id`, not `auth.users.id`).
- 1:N → `audit_log` (via `entity_id` when `entity_type='participant'` or `actor` for participant-initiated actions).

**Indexes and access patterns**.

| Index | Columns | Purpose |
|---|---|---|
| `participants_auth_user_id_uk` | `(auth_user_id)` UNIQUE | Auth hook lookup on every login (R-004); RLS predicate (R-006) |
| `participants_email_uk` | `(email)` UNIQUE | FR-004 anti-duplication |
| `participants_domain_status_idx` | `(domain, status)` | Admin queries "all active @nortal.com participants"; analytics |
| `participants_last_login_at_idx` | `(last_login_at DESC)` | Operations: identify dormant accounts |

**Audit posture**. Every INSERT/UPDATE on `participants` emits an `audit_log` row in the same transaction via an `AFTER INSERT OR UPDATE` trigger. Actions: `participant.created`, `participant.updated`, `participant.email_drift` (see R-010). The trigger captures `previous_value` (NULL on INSERT) and `new_value` (the row's JSON) so disputes can be resolved from history without joining other tables.

---

### 2. Approved Domain (configuration reference — owned by Slice 008)

**Purpose**. A single string in the `tournament_config.value` jsonb array under key `eligibility.approved_domains`. Not modeled as its own table — see [research.md § R-005](./research.md#r-005--approved-domain-configuration-source) for the rationale.

**Read pattern**. Always through `public.is_approved_domain(p_email text) RETURNS boolean LANGUAGE sql STABLE`:

```sql
CREATE OR REPLACE FUNCTION public.is_approved_domain(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT COALESCE(
    EXISTS (
      SELECT 1
      FROM public.tournament_config c,
           jsonb_array_elements_text(c.value) AS d
      WHERE c.key = 'eligibility.approved_domains'
        AND lower(d) = lower(split_part(p_email, '@', 2))
    ),
    false
  );
$$;
```

**Default value seeded by this slice**: `["nortal.com"]`. Slice 008's admin UI replaces it before production launch (OD-001).

**Validation rules** (applied by Slice 008's admin UI; this slice merely reads):
- Array elements MUST be lowercase domain strings (regex `^[a-z0-9.-]+\.[a-z]{2,}$`).
- Array MUST contain at least one element; an empty array is treated as "fail closed" by `is_approved_domain` (R-007).

**Cross-slice contract**. The `tournament_config` table shape is `(key text PK, value jsonb, updated_at timestamptz, updated_by uuid)` — same shape Slice 005 uses (research § R-014). If Slice 008 has not yet created the table when this slice's migrations run, this slice creates it with `INSERT … ON CONFLICT (key) DO NOTHING` semantics for the seed.

**RLS posture on `tournament_config`** (set by Slice 008 eventually; stubbed by this slice):
- Read: `is_eligible_nortal_participant(auth.uid()) OR is_admin(auth.uid())`.
  - Subtlety: the eligibility predicate itself reads `tournament_config` indirectly via `is_approved_domain`. This is **not** a circular policy because the function is `SECURITY INVOKER` and the policy is `USING` (a row-level filter). The policy only checks the *caller's* eligibility; it doesn't require it to read its own row. To avoid an infinite recursion regression, the seed migration grants `SELECT` on the `eligibility.approved_domains` row to the `authenticator` role unconditionally; only that specific key is exempt. (Test surface: pgTAP file in `/speckit-tasks`.)
- Write: `is_admin(auth.uid())` only — out of scope here; Slice 006 + Slice 008 jointly define `is_admin`.

---

### 3. Access Decision Event (audit reference — owned by Slice 007)

**Purpose**. One `audit_log` row per access decision (grant or deny), per profile mutation, and per session re-verification denial. Slice 007 owns retention, tamper-resistance, and search; this slice owns the write path for `action IN ('access.granted', 'access.denied', 'participant.created', 'participant.updated', 'participant.email_drift')`.

**Schema** (stubbed by this slice; hardened by Slice 007):

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `actor` | UUID | NULL allowed | `participants.id` when known; NULL for denied attempts where no participant exists yet |
| `action` | text | NOT NULL | This slice writes: `access.granted`, `access.denied`, `participant.created`, `participant.updated`, `participant.email_drift` |
| `entity_type` | text | NULL allowed | `participant` or `auth_attempt` |
| `entity_id` | UUID | NULL allowed | `participants.id` when applicable |
| `previous_value` | jsonb | NULL allowed | The participant row before the change (NULL on `access.denied` and on `participant.created`) |
| `new_value` | jsonb | NULL allowed | The participant row after the change (NULL on `access.denied`) |
| `reason` | text | NULL allowed | `domain_not_approved`, `config_unavailable`, `signature_mismatch`, `missing_claims`, `invalid_token`, `email_drift_detected`, etc. |
| `source` | text | NOT NULL | One of `auth_hook`, `rls`, `api_guard`, `ui` |
| `occurred_at` | timestamptz | NOT NULL, server-default `now()` | |

**Write paths owned by this slice**.

1. **Auth Hook** (R-004): writes `access.granted` + `participant.created` on first eligible login (two rows, same transaction). Writes `access.granted` + `participant.updated` on returning eligible login. Writes `access.denied` on rejection. Writes `participant.email_drift` when R-010's drift condition fires.
2. **API guard helper** `requireEligible()` (R-009): writes `access.denied` with `source='api_guard'` when an authenticated-but-no-longer-eligible request is rejected.
3. **`participants` row trigger**: writes `participant.created` / `participant.updated` automatically on row writes — this is a **defensive duplicate** of the auth-hook's audit row; it ensures the audit log can never lag behind the data, even if the hook's audit insert is somehow skipped. The trigger uses `pg_trigger_depth() = 1` to avoid recursive logging.

**Validation rules** (applied by Slice 007's hardening; this slice's writes already conform):
- `source` MUST be one of the enumerated values above.
- For `action='access.denied'`, `reason` MUST be non-NULL.
- For `action='participant.email_drift'`, `previous_value->>'email'` MUST differ from `new_value->>'email'`.

**Retention** (Slice 007's contract; documented here so the test surface knows what to expect): append-only; no UPDATE or DELETE allowed via application paths. This slice's RLS on `audit_log` therefore grants no UPDATE/DELETE to any role except the implicit `postgres` superuser.

---

## RLS posture summary

| Table | Policy name | Type | Predicate |
|---|---|---|---|
| `participants` | `participants_self_read` | SELECT | `id IN (SELECT id FROM public.participants WHERE auth_user_id = auth.uid())` |
| `participants` | `participants_admin_read` | SELECT | `is_admin(auth.uid())` — relies on Slice 006's stub during this slice (defined as `auth.jwt() ->> 'role' = 'admin'` until Slice 006 owns it) |
| `participants` | _(no INSERT/UPDATE/DELETE policies)_ | — | Writes happen via the auth-hook (running with elevated privilege) and the Slice 006 admin path; the participant client never writes |
| `audit_log` | `audit_log_admin_read` | SELECT | `is_admin(auth.uid())` |
| `audit_log` | _(no INSERT policy at the row-level)_ | — | Inserts go through the auth-hook (`SECURITY DEFINER`) and the `participants` trigger; no participant or admin client INSERTs directly |
| `tournament_config` | `tournament_config_self_read_eligibility` | SELECT | `key = 'eligibility.approved_domains'` (unrestricted SELECT on this one row; see § 2 above) |
| `tournament_config` | `tournament_config_admin_read` | SELECT | `is_admin(auth.uid())` |
| `tournament_config` | _(no INSERT/UPDATE/DELETE policies)_ | — | Slice 008 owns writes |

**Cross-slice stub note**: `is_admin(auth.uid())` is referenced but not owned here. This slice ships a permissive stub `CREATE OR REPLACE FUNCTION public.is_admin(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(auth.jwt() ->> 'role' = 'admin', false) $$` — Slice 006 will replace it with the real implementation. The cross-slice contract is the **signature** `is_admin(uuid) RETURNS boolean STABLE`. The stub MUST be replaced by Slice 006 with no signature change; any change requires updating every slice's RLS that references it (Constitution Principle XI). See also Slice 005 tasks.md T007 — same handling pattern.

---

## Capability contracts owned by this slice

1. `is_eligible_nortal_participant(uuid) RETURNS boolean STABLE` — every downstream slice's RLS references this. Locked signature, locked semantics; the function body is `EXISTS (active participant whose email's domain is in the approved list)`.
2. `is_approved_domain(text) RETURNS boolean STABLE` — internal helper for #1 and for the auth hook. Locked signature.
3. The `participants` table shape — every downstream slice FKs to `participants(id)`. Locked PK, locked `auth_user_id` link.
4. The `audit_log` shape (subset) — every downstream slice writes rows in this shape. Slice 007 will add columns; this slice's columns MUST remain.

These four contracts together form the **cross-slice foundation**. The Constitution Check in `plan.md` re-evaluates whether any of them violate Principles I, II, III, V, or VIII.

## Open questions for future slices

| Question | Owner slice | This slice's posture |
|---|---|---|
| Exact approved-domain list (OD-001) | 008 | Seeded as `["nortal.com"]`; admin UI replaces |
| Real `is_admin(uid)` body | 006 | Permissive stub `(auth.jwt() ->> 'role' = 'admin')`; Slice 006 owns the real definition |
| Email-drift admin reconciliation UI | 006 | This slice writes the audit row; reconciliation tooling is Slice 006 |
| Multi-tenant (multiple Nortal entities) | future | Out of scope; spec single-tenant |
| Notification on denied attempts (FR-019) | post-MVP | Out of scope; this slice writes only the audit row |
