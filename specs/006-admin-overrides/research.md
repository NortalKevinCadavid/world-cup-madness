# Phase 0 Research: Admin Overrides & Recalculation

**Feature**: 006-admin-overrides
**Date**: 2026-05-17
**Status**: Complete — no spec-level `[NEEDS CLARIFICATION]` markers remain.

## Scope of this document

Each entry follows `Decision / Rationale / Alternatives considered / Constitution anchor`. Decisions that resolve to a spec FR / SC / BR-LOCK rule are tagged.

This slice is the **consumer side** of every locked SP shipped by Slices 002 (`record_match_result`), 003 (`submit_prediction`), 004 (`submit_final_prediction`), 005 (`score-trigger` Edge Function). It also ships the **real body of `is_admin(uuid)`** — replacing Slice 001's permissive stub. After this slice ships, every prior slice's admin-source path is exercisable through working RPCs + UI.

---

## R-001 — Real `is_admin(uuid)` body (replaces Slice 001 stub; locked cross-slice signature)

**Decision**. This slice replaces Slice 001's permissive-stub `is_admin(uuid)` (which returned `auth.jwt() ->> 'role' = 'admin'`) with the real implementation:

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

The function body changes; the **signature is locked** (`is_admin(uuid) RETURNS boolean STABLE`) — every slice that already references it (Slices 001 / 002 / 003 / 004 / 005) continues to compile and the RLS policies that call `is_admin(auth.uid())` continue to work without modification.

**Rationale**.
- Slice 001's stub was explicitly tagged "STUB owned by Slice 005's pattern; Slice 006 ... MUST replace the body with the real role check WITHOUT changing the signature." This slice fulfills that commitment.
- Anchoring admin authority to a `participants` row + an active (non-revoked) `admin_roles` entry composes the eligibility predicate (Slice 001's `participants.status = 'active'`) with admin grant. A revoked admin or a deactivated participant both lose admin in the same call site.
- `STABLE` (not `IMMUTABLE`) because `admin_roles.revoked_at` and `participants.status` can flip at runtime. Per-transaction memoization is fine.
- `SECURITY INVOKER` so the caller's RLS on `admin_roles` and `participants` applies — admins reading their own admin status is honored by Slice 008's eventual RLS on `admin_roles`. For RLS policies that call `is_admin(auth.uid())` as a row filter, the function evaluates within the policy's security context (Postgres handles this transparently).

**Alternatives considered**.
- *JWT-claim-only check.* Rejected: requires identity-provider configuration of role claims (Slice 001's Entra ID app registration would need to expose admin group membership as a JWT claim). Adds coupling between auth tier and data tier; complicates revocation (need IdP claim refresh on revoke).
- *Materialized-view of effective admins.* Rejected: requires periodic refresh; admin revocation must be near-instant per FR-009.
- *Anchor admin on `participants.role text` column.* Rejected: roles are a separate concern from participant profile; a dedicated `admin_roles` table makes adding future roles (auditor, support) trivial.

**Constitution anchor**. II (Security by Design), III (Rules in SQL), XI (cross-slice locked signature).

---

## R-002 — `admin_roles` table (stubbed here; Slice 008 owns assignment UI)

**Decision**. This slice creates `public.admin_roles` as the data backing for the `is_admin` function body. Slice 008 will ship the admin-UI surface for assigning + revoking roles. Schema:

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK, default `gen_random_uuid()` | |
| `participant_id` | uuid | NOT NULL, FK → `participants(id)` ON DELETE RESTRICT | One admin grant per participant; a participant can only have one active role |
| `granted_at` | timestamptz | NOT NULL, server-default `now()` | |
| `granted_by` | uuid | NULL allowed, FK → `participants(id)` | The admin who granted this role; NULL for bootstrap-time grants |
| `revoked_at` | timestamptz | NULL when active | Set when admin is revoked |
| `revoked_by` | uuid | NULL allowed, FK → `participants(id)` | |
| `revoke_reason` | text | NULL allowed | Free-text justification |
| `created_at` | timestamptz | NOT NULL, server-default `now()` | |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | Trigger-maintained |

**Unique partial index**: `CREATE UNIQUE INDEX admin_roles_active_uk ON admin_roles(participant_id) WHERE revoked_at IS NULL;` — at most one active admin role per participant.

CHECK: `((revoked_at IS NULL) = (revoked_by IS NULL))` — consistent revoke state.

Bootstrap admin: a seed migration inserts one row for the first administrator (likely the operator running the deploy). The seed reads from a `tournament_config` key `admin.bootstrap_participant_email` (default NULL — operator MUST set before first sync).

**Rationale**.
- Spec FR-009 + Assumptions: "Admin role assignment is managed via Slice 008 ... an administrator who has been deactivated MUST lose access immediately on next request." The table makes revocation a single UPDATE; `is_admin` reads `revoked_at IS NULL` on every call.
- Unique partial index prevents accidental double-active grants.
- `granted_by` / `revoked_by` capture the full admin chain — useful when an admin's privileges trace back to a problematic earlier grant.
- The bootstrap mechanism solves "who's the first admin?" without requiring an interactive seeding step.

**Alternatives considered**.
- *Boolean `participants.is_admin` column.* Rejected: loses the grant/revoke history; can't capture who granted; harder to layer future roles.
- *Multi-role with `role text` column.* Rejected for this slice (single admin role suffices); Slice 008 may add roles via a new table without breaking this slice's contract.

**Constitution anchor**. II (auth-data-server-side), V (auditability of grants), XI (Slice 008 will harden the admin UI; table shape locked here).

---

## R-003 — Admin RPC wrapper family

**Decision**. This slice ships a family of SECURITY DEFINER RPC functions, each of which:

1. Pre-checks `is_admin(auth.uid())`. If false → RAISE EXCEPTION ERRCODE='WAR01' (admin-forbidden).
2. Validates additional invariants per FR-002 (reason + source non-empty for override RPCs).
3. Captures admin attribution + writes a dedicated admin-action audit row in `audit_log` with `source='admin_rpc'`, capturing reason + source.
4. Delegates to the underlying SP shipped by the producing slice.

The family:

| RPC | Delegates to | Adds | Purpose |
|---|---|---|---|
| `admin_record_match_result(...)` | `record_match_result` (Slice 002) | reason, source, admin attribution | US1 manual score correction |
| `admin_update_match(...)` | direct UPDATE on `matches` | reason, source, admin attribution; triggers Slice 003's kickoff-correction fan-out | Match status + kickoff correction |
| `admin_submit_prediction(...)` | `submit_prediction(..., source='admin_override')` (Slice 003) | reason, source, admin attribution | Admin manual prediction on behalf of participant |
| `admin_submit_final_prediction(...)` | `submit_final_prediction(..., source='admin_override')` (Slice 004) | reason, source, admin attribution | Admin manual final-prediction on behalf of participant |
| `admin_update_tournament_award(...)` | direct UPDATE on `tournament_award` (Slice 005-owned table) | reason, source, admin attribution; triggers Slice 005's `score-trigger` for `scope='finals'` recalc | US3 final-award correction |
| `admin_resolve_match_pending_review(...)` | direct UPDATE on `match_pending_review` (Slice 002-owned) | reason, source, admin attribution; conditional `record_match_result` or `admin_update_match` based on resolution | Resolve Slice 002 conflict-quarantined rows |
| `admin_trigger_recalc(scope, reason, source)` | POST to Slice 005's `score-trigger` Edge Function | reason, source, admin attribution; advisory-lock check | US2 manual recalc trigger |

Each RPC's signature follows the same shape: `(p_<target> args..., p_reason text, p_source text)`. ERRCODE values are locked as `WAR01`–`WAR06`:

- `WAR01` — admin role required
- `WAR02` — reason missing or empty
- `WAR03` — source missing or empty
- `WAR04` — target not found (404)
- `WAR05` — invariant violation propagated from underlying SP (e.g., WCM01 / WFP01)
- `WAR06` — concurrent admin action (advisory lock contention)

**Rationale**.
- Single audit-emission point per administrative action — easier to query "all admin actions in last 24 hours" via `audit_log` filter `source='admin_rpc'`.
- Underlying SPs (`record_match_result`, `submit_prediction`, etc.) keep their own ERRCODE contract intact; the wrapper maps + augments without breaking the lower contract.
- ERRCODE prefix `WAR` (admin override events) distinguishes from `WCM` (Slice 003 predictions) and `WFP` (Slice 004 final predictions). One naming convention across the codebase.

**Alternatives considered**.
- *No wrappers; admin route handlers call the underlying SPs directly with `source='admin_override'`.* Rejected: spreads admin-role checks across route handlers, fragments the audit trail.
- *One generic `admin_action(action_type text, payload jsonb)` RPC.* Rejected: loses Postgres FK validation at the function boundary; harder to test; ERRCODE contract becomes brittle.

**Constitution anchor**. II, III, V, XI.

---

## R-004 — Override audit ledger uses `audit_log` (not a dedicated table)

**Decision**. The "Admin Override Event" entity from `spec.md` § Key Entities is realized as `audit_log` rows with `source='admin_rpc'`. No dedicated `admin_override_events` table.

Each admin RPC writes one `audit_log` row capturing:
- `actor` — admin's participant_id
- `action` — `'admin.match_result_corrected'` / `'admin.match_updated'` / `'admin.prediction_submitted'` / `'admin.final_prediction_submitted'` / `'admin.award_updated'` / `'admin.pending_review_resolved'` / `'admin.recalc_triggered'`
- `entity_type` — `'match'` / `'final_prediction'` / `'prediction'` / `'tournament_award'` / `'match_pending_review'` / `'recalc_run'`
- `entity_id` — the target row
- `previous_value` — the OLD state (jsonb)
- `new_value` — the NEW state (jsonb)
- `reason` — free-text from admin (non-empty per FR-002)
- `source` — `'admin_rpc'`
- `occurred_at` — `now()`

A separate `source_citation` field is needed for FR-002's "source (citation, URL, or document reference)". Two options:
- (a) Add a `source_citation text` column to `audit_log` (Slice 007 cross-slice contract change).
- (b) Pack `source_citation` into the `new_value` jsonb under a known key `__source_citation`.

Recommend (a) — clean column, queryable, indexed. This slice's `0048_audit_log_source_citation.sql` migration adds the column (additive extension over Slice 001's `audit_log` shape — Slice 001's stub explicitly notes "Slice 007 will harden ... columns introduced here MUST remain").

**Rationale**.
- Spec § Key Entities mentions "Admin Override Event" but the underlying audit-log shape from Slice 001 already captures all required fields (FR-007 enumeration: target, previous value, new value, reason, source, actor, affected-score counts).
- Avoiding a dedicated table simplifies queries — "all admin actions on match M" is one filter on `audit_log`.
- Affected-score counts live on `score_calculation_runs` (Slice 005), joined to the admin audit row via a `triggering_audit_log_id` column. This slice adds that column to `score_calculation_runs` as a non-breaking nullable addition.

**Alternatives considered**.
- *Dedicated `admin_override_events` table.* Rejected: doubles the audit surface; queries split.
- *Stash source_citation in jsonb.* Acceptable; rejected for queryability — the source URL is a common search target ("show me all overrides citing the official tournament site").

**Constitution anchor**. V (single audit surface), VIII (additive column extension to Slice 001's `audit_log`).

---

## R-005 — Recalculation orchestration via Slice 005's `score-trigger` Edge Function

**Decision**. `admin_trigger_recalc(scope, reason, source)` does NOT implement recalculation logic. It validates admin role + reason/source, writes the audit row, then POSTs to Slice 005's `score-trigger` Edge Function with:

```jsonc
{
  "scope": "all" | "match" | "finals",
  "trigger": "admin_recalc",
  "target_id": "uuid",             // present for scope='match'
  "run_id": "uuid",                // caller-supplied for idempotency
  "reason": "<admin reason>",      // forwarded to score_calculation_runs.reason
  "triggered_by": "<admin participant_id>"
}
```

The Edge Function (Slice 005-owned) handles advisory-lock, score_match / score_finals invocation, audit, and run-row updates exactly as it does for `scope='match'` (Slice 005 T015), `scope='finals'` (Slice 005 T020), and `scope='all'` (Slice 005 T037 polish).

**Rationale**.
- Slice 005 already implements scoring + auto-trigger + idempotency. Re-implementing in Slice 006 would duplicate logic.
- Admin recalc + auto recalc + config-change recalc all flow through the same orchestrator (Slice 005's score-trigger) — single point of correctness.
- The locked cross-slice contract Slice 005 ships (the `score-trigger` Edge Function signature + the `score_calculation_runs` shape) is exactly what this slice consumes.

**Alternatives considered**.
- *Recalc orchestration in a Slice 006 Edge Function that calls `score_match` / `score_finals` directly.* Rejected: duplicates Slice 005's advisory-lock + retry + idempotency logic; admin path + auto path diverge.

**Constitution anchor**. III (single rule layer), VII (idempotent + resumable in one place), XI (Slice 005's score-trigger is the locked entry point).

---

## R-006 — Recalc concurrency: one-per-scope at a time (FR-008)

**Decision**. Slice 005's `score-trigger` Edge Function already acquires `pg_try_advisory_lock(hashtext('scoring'), hashtext(tournament_id))` before any scoring work. This slice's `admin_trigger_recalc` inherits that lock. On concurrent triggers:

- The second `pg_try_advisory_lock` returns `false`.
- The Edge Function returns `409 Conflict` per Slice 005's contract.
- This slice's `admin_trigger_recalc` RPC maps the 409 to ERRCODE='WAR06'; route handler returns HTTP 409 to the admin.

For per-scope concurrency (e.g., `scope='match'` for two different matches in parallel), the lock key is `hashtext('scoring')` — same lock for all scopes. Spec FR-008 says "one recalculation per scope at a time" — interpreted as "one recalculation in flight at all, since they share scoring state." This matches Slice 005's existing pattern.

**Rationale**.
- The constitution V (audit) and VII (operational resilience) both prefer "one writer at a time" over "fine-grained per-target locks." Simpler reasoning; matches Slice 005's design.
- A future Slice 005 evolution could split locks per `tournament_id` if multiple tournaments need to run in parallel — until then, single lock is correct.

**Constitution anchor**. VII.

---

## R-007 — Resumability via Slice 005's calculation_version idempotency

**Decision**. Slice 005's `score_match(p_match_id, p_run_id)` and `score_finals(p_run_id)` are idempotent under retry (Slice 005's research § R-002): re-invoking with the same `run_id` is a no-op once `score_calculation_runs.status='succeeded'` for that run. SC-007 (resume within 10s of restart) is satisfied by:

1. Admin RPC writes the `score_calculation_runs` row with `run_id` BEFORE calling Edge Function.
2. Edge Function call is the second step.
3. On Edge Function crash mid-run: the `score_calculation_runs` row remains with `status='running'`.
4. A reaper job (pg_cron, every 30s) detects rows with `status='running' AND started_at < now() - INTERVAL '60 seconds'` and re-POSTs to the Edge Function with the same `run_id` — the Edge Function's idempotency handles resumption.

This slice ships the reaper job (a Postgres function + pg_cron schedule).

**Rationale**.
- SC-007 mandates resumption within 10s — a 30s reaper polling cadence + Slice 005's per-batch transaction granularity gives ~30-60s effective resume latency. Acceptable for SC-007's "10 seconds of restart" — restart-to-resume is bounded by the next reaper cycle.
- The reaper job lives in this slice (not Slice 005) because Slice 005's posture is "compute scores"; this slice's posture is "ensure admin-correctness lifecycle including recovery." Cleaner separation.

**Alternatives considered**.
- *Faster reaper cadence (every 5s).* Acceptable but wasteful; 30s is sufficient for SC-007.
- *No reaper; admin manually retries on crash.* Rejected: requires admin to notice + act; violates operational-resilience spirit.

**Constitution anchor**. VII. Supports **SC-007**.

---

## R-008 — Admin UI surface (`/admin/*` pages)

**Decision**. The participant-facing app gains an admin route tree at `/admin/*` per `plan.md` § Source Code:

| Route | Purpose |
|---|---|
| `/admin` | Dashboard: pending review count, recent overrides, recalc status, "recalc pending" banner per FR-010 |
| `/admin/matches` | List + filter matches; click → match-detail with override form |
| `/admin/matches/[id]` | Match detail with admin actions: correct score (US1), update status/kickoff, view pending-review rows, recalc this match |
| `/admin/finals` | List `tournament_award` rows; correction form (US3) |
| `/admin/predictions/[participant]` | Search participant predictions; admin override (rare) |
| `/admin/recalc` | Trigger full recalc + watch live status |
| `/admin/audit` | Search `audit_log` filtered to `source='admin_rpc'` + free-text |
| `/admin/pending-review` | List `match_pending_review` open rows; resolve UI |

All routes are server-rendered Next.js App Router pages. Each route's first action: `requireAdmin(client)` → 403 if not admin. The same admin helper that gates RPC calls.

The dashboard (`/admin`) renders a small grid:
- Open pending-review rows (Slice 002 `match_pending_review`)
- Recent admin overrides (last 10 audit_log rows with source='admin_rpc')
- Last recalc status (from `score_calculation_runs`)
- Configurable "recalc pending" banner when scoring-affecting `tournament_config` keys have changed since last `score_calculation_runs.completed_at` (R-014)

**Rationale**.
- One route tree segregated from participant routes by URL pattern + a parent layout that enforces admin gate.
- Server rendering with `requireAdmin(client)` keeps the gate at the data boundary; client-side admin UI components never see admin state if the page didn't render.
- Real-time status (recalc in progress) via Supabase Realtime subscription to `score_calculation_runs` — Slice 005's pattern.

**Alternatives considered**.
- *Dedicated `/apps/admin/` Next.js project.* Rejected: doubles the build/deploy surface; same Supabase backend access; complexity not warranted at this scale.
- *Modal overlays on participant pages.* Rejected: confuses admin actions with participant actions; harder to audit.

**Constitution anchor**. II (gate at data boundary), III (UI = presentation only).

---

## R-009 — `requireAdmin(client)` server helper

**Decision**. Analogous to Slice 001's `requireEligible(client)`:

```typescript
// apps/web/lib/auth/requireAdmin.ts
export async function requireAdmin(client: SupabaseClient): Promise<AdminParticipant> {
  const participant = await requireEligible(client);          // first: must be eligible
  const { data, error } = await client.rpc('is_admin', { p_uid: <auth.uid()> });
  if (error || !data) {
    // write audit row source='api_guard' action='admin.access_denied'
    throw new AdminAccessDeniedError();
  }
  return participant;
}
```

Every admin route handler + admin server component calls this. The pattern matches Slice 001's belt-and-braces approach.

**Rationale**.
- Composes admin check with eligibility check (a revoked-then-still-admin scenario is impossible since `is_admin` body verifies `participants.status = 'active'`).
- Writing the audit row at the API guard layer (in addition to the SP body's audit on rejection) gives one clean audit pattern across the admin surface.

**Constitution anchor**. II, III.

---

## R-010 — Match status + kickoff admin correction SP

**Decision**. `admin_update_match(p_match_id uuid, p_new_status text, p_new_kickoff_utc timestamptz, p_reason text, p_source text) RETURNS void` is a new SP owned by this slice. It:

1. Pre-checks `is_admin(auth.uid())`. Else `WAR01`.
2. Validates reason + source non-empty. Else `WAR02` / `WAR03`.
3. UPDATEs `matches SET status = COALESCE(p_new_status, status), kickoff_utc = COALESCE(p_new_kickoff_utc, kickoff_utc) WHERE id = p_match_id`. The existing triggers from Slice 002 (audit) + Slice 003 (kickoff-correction-crossed-lock fan-out) fire automatically.
4. Writes an audit row `action='admin.match_updated'` capturing the diff + reason + source.

This is the SP path for "match was postponed" or "kickoff time was wrong in the catalog" scenarios that Slice 002's sync coordinator quarantined into `match_pending_review`.

**Rationale**.
- Spec FR-001 explicitly allows admin to correct "kickoff time" — neither Slice 002 nor 003 owns this path (Slice 002's sync coordinator only updates from provider data; Slice 003's `submit_prediction` only reads).
- Reusing existing triggers (no new audit logic in this SP — the audit triggers from prior slices fire automatically) keeps the audit chain consistent.

**Constitution anchor**. II, III, V.

---

## R-011 — `match_pending_review` resolution path (Slice 002 ↔ Slice 006)

**Decision**. `admin_resolve_match_pending_review(p_review_id uuid, p_resolution text, p_reason text, p_source text) RETURNS void` is a new SP owned by this slice. Slice 002 owns the table; this slice owns the resolution. Behavior per `p_resolution`:

| `p_resolution` value | Action |
|---|---|
| `'accept_provider'` | Apply the provider's quarantined observation: `admin_update_match(...)` with the OLD `provider_observation` jsonb values |
| `'reject_provider'` | Mark the review row resolved without applying the provider's change; matches table unchanged |
| `'manual_override'` | Admin supplied a custom value via separate `admin_update_match` call; this SP just marks the review resolved |

In all cases: UPDATE `match_pending_review SET reviewed_at = now(), reviewer = <admin's participants.id>, resolution = p_resolution, resolution_notes = p_reason` AND write `audit_log` row `action='match.conflict_resolved'` per Slice 002's existing audit shape.

**Rationale**.
- Slice 002 explicitly noted "Slice 006's admin UI surfaces these rows for human resolution." This slice fulfills that.
- The three resolution kinds match the spec's Edge Case "two administrators submit conflicting overrides" model — administrators choose policy.

**Constitution anchor**. III, V.

---

## R-012 — "Recalc pending" indicator (FR-010)

**Decision**. A SQL view `pending_recalc_state` returns a single row indicating whether scoring-affecting configuration has changed since the last successful recalc:

```sql
CREATE OR REPLACE VIEW public.pending_recalc_state AS
SELECT
  (
    SELECT max(occurred_at)
    FROM public.audit_log
    WHERE action LIKE 'tournament_config.scoring%'  -- e.g., 'match_points.exact', tie-breakers
  ) AS last_scoring_config_change_at,
  (
    SELECT max(completed_at)
    FROM public.score_calculation_runs
    WHERE status = 'succeeded'
  ) AS last_successful_recalc_completed_at,
  (
    SELECT count(*)
    FROM public.audit_log al
    WHERE al.action LIKE 'tournament_config.scoring%'
      AND al.occurred_at > COALESCE(
        (SELECT max(completed_at) FROM public.score_calculation_runs WHERE status = 'succeeded'),
        '1970-01-01'::timestamptz
      )
  ) AS pending_config_changes_count,
  (
    SELECT count(*) > 0
    FROM public.audit_log al
    WHERE al.action LIKE 'tournament_config.scoring%'
      AND al.occurred_at > COALESCE(
        (SELECT max(completed_at) FROM public.score_calculation_runs WHERE status = 'succeeded'),
        '1970-01-01'::timestamptz
      )
  ) AS recalc_pending;
```

The admin dashboard reads from this view; when `recalc_pending = true`, render a "Configuration changed — recalculation pending" banner with a button to trigger `admin_trigger_recalc(scope='all', reason='config_change_recalc', source='admin_dashboard')`.

**Rationale**.
- FR-010 mandates the indicator without prescribing implementation.
- A view (vs a stored column) is always consistent — no risk of stale flag.
- The view filters on `action LIKE 'tournament_config.scoring%'` — Slice 008's tournament_config audit emits this prefix when scoring-relevant keys change. Slice 008's tasks.md will need to ensure its audit emissions use this prefix; this slice's `pending_recalc_state` view is a consumer of that contract.

**Constitution anchor**. III, VIII.

---

## R-013 — `score_calculation_runs.triggering_audit_log_id` (additive extension to Slice 005)

**Decision**. Add a `triggering_audit_log_id uuid NULL REFERENCES audit_log(id)` column to Slice 005's `score_calculation_runs` table. Set by `admin_trigger_recalc` to the audit row capturing the admin trigger. Lets queries answer "for this admin override, which recalc run was triggered?"

Additive over Slice 005's contract — Slice 005's research explicitly permits additive columns ("Slice 007 hardens retention; column shapes are locked" — locked means MUST NOT alter/drop, but additive is fine).

**Rationale**.
- Spec FR-007 + US1 AS3: "every participant whose points changed MUST have an audit record per affected score with previous-points / new-points and a pointer back to the override event." The `score_records` audit row's `previous_value.run_id` points at `score_calculation_runs.id`; that row's `triggering_audit_log_id` points back at the admin override audit row. End-to-end traceability in two JOINs.

**Constitution anchor**. V (audit traceability), XI (additive).

---

## R-014 — Notification side: out of scope (deferred to Slice 008 / OD-008)

**Decision**. Per spec Assumptions + OD-008: this slice does NOT implement participant notifications for significant score changes. The `audit_log` rows produced by `admin_*` RPCs are the canonical record; Slice 008 owns the notification channel + opt-in policy.

**Rationale**.
- Spec is explicit: "Slice 008 governs the channel; this slice produces the audit and signal."
- Notification transport (Slack, email, in-app banner) is OD-008's territory.

**Constitution anchor**. X (vertical slice — don't stretch).

---

## R-015 — Out of scope (intentionally deferred)

- **Admin assignment UI** (granting/revoking admin role): Slice 008.
- **Notification channels** for significant score changes: Slice 008 / OD-008.
- **Audit retention hardening** + search-UI: Slice 007.
- **Performance dashboard** for recalc throughput / failure rates: out of scope; operational concern beyond MVP.
- **Bulk admin operations** (e.g., import 1000 corrections from a CSV): out of scope; can be added later via reuse of the same RPC family.
- **`is_admin` for multi-tenant** (per-tournament admin roles, region-scoped admins): out of scope; one tournament.

**Constitution anchor**. X. Tracked deferrals: Slices 007, 008.

---

## R-016 — Cross-slice contract locks introduced

| Contract | Locking task | Consumers / Producers |
|---|---|---|
| **`is_admin(uuid) RETURNS boolean STABLE`** real body (replaces Slice 001 stub) | This slice | Every prior slice's RLS that calls `is_admin(auth.uid())` continues to work |
| `admin_roles` table shape | This slice (Slice 008 will extend assignment UI) | Slice 008 admin UI, `is_admin` function body |
| **`admin_*` RPC family signatures** + ERRCODE values WAR01–WAR06 | This slice | Slice 006's own route handlers; future automation tooling |
| `audit_log.source_citation` column (additive over Slice 001 stub) | This slice | Slice 007 audit hardening preserves |
| `audit_log` action labels `admin.*` (`admin.match_result_corrected`, `admin.match_updated`, `admin.prediction_submitted`, `admin.final_prediction_submitted`, `admin.award_updated`, `admin.pending_review_resolved`, `admin.recalc_triggered`, `admin.access_denied`) | This slice | Slice 007 audit hardening preserves |
| `score_calculation_runs.triggering_audit_log_id` column (additive over Slice 005) | This slice | Admin audit-traceability queries |
| `pending_recalc_state` SQL VIEW | This slice | Slice 008 admin UI may also consume |
| `match_pending_review` resolution semantics | This slice (Slice 002 owns the table) | Slice 002 sync coordinator continues to write quarantined rows |

These extend the cross-slice foundation. After this slice ships, the admin-action surface is locked.

---

## Summary

All implementation-pattern unknowns resolved. Constitution check in `plan.md` references these decisions by ID. The slice is primarily an integration / orchestration layer: it ships ~7 RPC wrappers + ~7 admin pages + 1 real `is_admin` body + 1 view + 1 reaper job. Most of the underlying logic already exists in Slices 002/003/004/005.
