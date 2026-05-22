# Phase 0 Research: Audit Trail

**Feature**: 007-audit-trail
**Date**: 2026-05-17
**Status**: Complete — no spec-level `[NEEDS CLARIFICATION]` markers remain.

## Scope of this document

Each entry follows `Decision / Rationale / Alternatives considered / Constitution anchor`. Decisions that resolve to a spec FR / SC are tagged.

This slice is the **cross-cutting hardening** slice. By the time it ships, every prior slice (001–006) has already written `audit_log` rows per its own contracts. The `audit_log` table has been progressively built up:

- **Slice 001** (stub): created the base table with `(id, actor, action, entity_type, entity_id, previous_value, new_value, reason, source, occurred_at)` columns + narrow per-slice INSERT policies.
- **Slice 006** (additive): added `source_citation text` column for admin override URLs.
- **Slices 002–006** (writers): each contributed action-label namespaces (`participant.*`, `match.*`, `prediction.*`, `final_prediction.*`, `score_record.*`, `admin.*`, etc.) and INSERT policies.

This slice's responsibilities:

1. **Lock the final schema** — declare it frozen; Slice 008 may add columns but cannot alter/drop existing ones.
2. **DB-level tamper-resistance** — REVOKE UPDATE / DELETE from application roles so no app path can mutate audit rows.
3. **Monotonic ordering invariant** — add `sequence_id bigserial` so SC-006's per-target monotonic-order requirement is a storage-layer guarantee under any concurrency.
4. **Admin search + export** — `audit_search` RPC, `GET /api/admin/audit*` endpoints (Slice 006 stubbed; this slice's contract finalizes the search shape), CSV streaming export.
5. **Retention configuration** — seed `tournament_config.audit.retention_policy` keys; the actual archival/purge is deferred to operations.
6. **Operational alerting on write failure** — partially deferred (in-app code is impractical for INSERT-rollback failures since the row never commits); document operational runbook + the Slice 008 webhook integration point.

The slice introduces no new tables of its own (every audit producer / consumer already exists). It hardens what's there + ships the admin surfaces.

---

## R-001 — DB-level tamper-resistance via `REVOKE UPDATE, DELETE`

**Decision**. The `audit_log` table's UPDATE and DELETE privileges are revoked from every application role (`authenticated`, `anon`, `service_role`). Only `postgres` (the Supabase platform owner) retains UPDATE/DELETE — and that's an operational-tier concern outside application logic per spec § US2.

The migration:

```sql
REVOKE UPDATE, DELETE ON public.audit_log FROM authenticated, anon, service_role;
GRANT SELECT, INSERT ON public.audit_log TO authenticated, anon, service_role;
-- (Subset-INSERT policies remain — Slices 001 / 003 / 006 each shipped narrow row-level policies.)
```

Combined with the existing RLS policies, this means:
- No admin RPC, no Edge Function, no route handler, no participant client can UPDATE or DELETE audit rows.
- INSERT remains permitted via the narrowly-scoped policies plus `SECURITY DEFINER` audit triggers (which run as the function-owner role — typically `postgres` — but that role doesn't have a DELETE/UPDATE need either; it INSERTs).
- A pgTAP test verifies: under every application JWT (participant, admin, service_role), attempting `UPDATE audit_log SET ...` or `DELETE FROM audit_log WHERE ...` raises `insufficient_privilege`.

**Rationale**.
- Spec § US2 + FR-004: "no UI route or API endpoint MUST modify or delete an existing audit record."
- DB-level grant revocation is the strongest enforcement; RLS-only could be bypassed by a future poorly-scoped policy or a misconfigured SECURITY DEFINER function. REVOKE is a hard wall.
- Spec § US2 § Independent Test: "attempt to delete or modify via every available UI route and API endpoint" — the REVOKE makes this impossible by construction, not by route audit.

**Alternatives considered**.
- *RLS-only enforcement (no REVOKE)*. Rejected: any future migration that adds a permissive policy could open the surface. REVOKE is the belt; RLS is the braces.
- *Triggers that RAISE EXCEPTION on UPDATE/DELETE*. Rejected: REVOKE is simpler, more performant, and standard.
- *Move audit_log to a separate Postgres role that the application can't even SELECT*. Rejected: defeats the admin search use case; admin needs SELECT via RLS predicate.

**Constitution anchor**. V (NON-NEGOTIABLE append-only invariant).

---

## R-002 — Monotonic per-target ordering via `sequence_id bigserial`

**Decision**. Add a `sequence_id bigserial NOT NULL UNIQUE` column to `audit_log` (additive over Slice 001 stub + Slice 006 `source_citation` extension). Postgres SEQUENCE guarantees monotonic increment per INSERT. Per-target ordering becomes: `SELECT * FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY sequence_id ASC`.

The sequence is global (not per-target). Per-target ordering follows the global sequence since rows within the same target are still inserted in temporal order; sequence_id within a target is monotonically increasing.

**Rationale**.
- SC-006: "audit ordering is strictly monotonic per (target kind, target id) under 1,000 concurrent simulated writers." A `clock_timestamp()` tiebreaker isn't reliable under exactly-simultaneous writes; UUID-based tiebreakers are random.
- `bigserial` (backed by Postgres `SEQUENCE`) is increment-only across the entire database, fully ordered. INSERT in one transaction always gets a higher `sequence_id` than INSERT in an earlier-committing transaction.
- Per-target query plans use an index on `(entity_type, entity_id, sequence_id)` for fast scan in order.
- The additional `bigint` column adds 8 bytes per row — trivial at the slice's expected volume (~50k rows/day peak).

**Alternatives considered**.
- *Use `occurred_at` + UUID tiebreaker*. Rejected: under sub-microsecond concurrency, `occurred_at` ties happen; UUID order is random.
- *Per-target sequence (separate sequence per `(entity_type, entity_id)` pair)*. Rejected: would require a dynamic sequence-per-pair which Postgres doesn't natively support; advisory-lock-based emulation adds write contention without benefit (global sequence already gives the invariant we need).
- *Use `xmin` / transaction id*. Rejected: transaction ids wrap; not safe for long-lived ordering.

**Constitution anchor**. V, VII. Supports **SC-006**.

---

## R-003 — Retention policy configuration (no archival mechanism in this slice)

**Decision**. Seed two `tournament_config` keys:

| Key | Default | Purpose |
|---|---|---|
| `audit.retention.tournament_end_buffer_months` | `12` | How many months past tournament end to retain |
| `audit.retention.policy_kind` | `"keep"` (vs `"archive"` or `"purge"`) | Active policy — defaults to "keep forever" until ops decides |

The actual archival / purge mechanism is **out of scope** for this slice. Spec § Edge Cases explicitly hedges: "events older than the configured retention period MAY be archived or purged per Slice 008 policy" (MAY, not MUST).

When Slice 008 ships, it can implement:
- A pg_cron-driven archive/purge job.
- An `audit_log_archived` table for cold storage.
- A union view `audit_log_all` for queries that need historical data.

This slice ships the configuration surface + retention metadata; the operations team interprets it.

**Rationale**.
- FR-007 mandates configurable retention; spec defers the mechanism.
- Default `"keep"` is the safest posture — never silently delete audit history.
- Tournament-duration product: total volume is bounded (~50k rows/day × ~30 days × 2 years buffer ≈ 30M rows). Postgres handles this without archival; archival becomes relevant if the project is re-used for multiple tournaments.

**Alternatives considered**.
- *Implement archival job in this slice*. Rejected: spec hedges + Constitution Principle X (vertical slice scope). Adds complexity without short-term value.
- *Default to `"purge"`*. Rejected: silent deletion of audit data violates Principle V's spirit even if technically configured. Default-keep is safer.

**Constitution anchor**. VIII. Supports **FR-007**.

---

## R-004 — `audit_search(...)` SECURITY DEFINER RPC

**Decision**. Create a single SECURITY DEFINER RPC for admin search:

```sql
CREATE OR REPLACE FUNCTION public.audit_search(
  p_actor          uuid    DEFAULT NULL,
  p_entity_type    text    DEFAULT NULL,
  p_entity_id      uuid    DEFAULT NULL,
  p_action_pattern text    DEFAULT NULL,      -- e.g., 'admin.%' or 'prediction.created'
  p_source         text    DEFAULT NULL,
  p_from           timestamptz DEFAULT NULL,
  p_to             timestamptz DEFAULT NULL,
  p_limit          int     DEFAULT 50,
  p_offset         int     DEFAULT 0
) RETURNS TABLE (
  id uuid, sequence_id bigint, actor uuid, action text, entity_type text, entity_id uuid,
  previous_value jsonb, new_value jsonb, reason text, source_citation text, source text, occurred_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    PERFORM 1;  -- Slice 006's INSERT policy on audit_log handles the access-denied audit row
    RAISE EXCEPTION 'admin role required' USING ERRCODE = 'WAT01';
  END IF;
  RETURN QUERY
  SELECT al.id, al.sequence_id, al.actor, al.action, al.entity_type, al.entity_id,
         al.previous_value, al.new_value, al.reason, al.source_citation, al.source, al.occurred_at
  FROM   public.audit_log al
  WHERE  ($1 IS NULL OR al.actor = $1)
    AND  ($2 IS NULL OR al.entity_type = $2)
    AND  ($3 IS NULL OR al.entity_id = $3)
    AND  ($4 IS NULL OR al.action LIKE $4)
    AND  ($5 IS NULL OR al.source = $5)
    AND  ($6 IS NULL OR al.occurred_at >= $6)
    AND  ($7 IS NULL OR al.occurred_at <  $7)
  ORDER  BY al.sequence_id ASC
  OFFSET $9 LIMIT $8;
END $$;
```

Plus a `count_audit_search(...)` companion RPC (same signature minus limit/offset) for pagination totals.

ERRCODE values are locked as `WAT01`–`WAT03`:
- `WAT01` — admin role required.
- `WAT02` — query too broad (e.g., no time-range + no entity_id + limit > 5000).
- `WAT03` — query parameter validation error.

**Rationale**.
- Single named SP is the locked entry point for admin search (Principle III); UI route handlers delegate.
- `SECURITY DEFINER` so the RPC's SELECT can read the full audit table regardless of the caller's RLS — but the admin-role check at the top is the gate.
- `STABLE` so Postgres can plan-cache the query body across invocations with similar parameters.
- The 9-parameter shape covers FR-005's required filters: date range, actor, target kind, target id, event type, source.

**Alternatives considered**.
- *Open a SELECT policy `audit_log_admin_read` and let admin clients query directly via PostgREST*. Rejected: bypasses the centralized search ERRCODE / over-broad-query check; the RPC is the single funnel.
- *Separate RPC per filter dimension (audit_search_by_actor, audit_search_by_target, etc.)*. Rejected: over-specifies; the single RPC handles all dimensions.

**Constitution anchor**. III, II.

---

## R-005 — CSV streaming export endpoint

**Decision**. `GET /api/admin/audit/export?<same filters as audit_search>` streams a CSV using a Next.js route handler that:

1. Calls `requireAdmin(client)`.
2. Validates query params (same Zod schema as the search endpoint).
3. Opens a Supabase SSE / cursor-based connection: `SELECT ... FROM audit_log WHERE ...` ordered by `sequence_id ASC` with `LIMIT NULL` (i.e., no inherent limit; the **route handler** chunks).
4. Sets `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="audit-export-<timestamp>.csv"`.
5. Streams CSV rows via Next.js's `ReadableStream` Response — each Postgres row is converted to a CSV line and yielded.
6. Embedded jsonb fields (`previous_value`, `new_value`) are flattened: the export contains them as JSON-encoded strings within their CSV cells (escaped per RFC 4180). The intent is "human-readable for dispute resolution"; opening in Excel works for the simple fields; jq is recommended for jsonb cells.
7. A header row is emitted first: `id,sequence_id,actor,actor_display_name,action,entity_type,entity_id,previous_value,new_value,reason,source_citation,source,occurred_at`. The `actor_display_name` column is joined from `participants.display_name` for human readability — it's a display convenience; the canonical identifier is `actor` (uuid).
8. The route's RUNNING TOTAL is updated via an `X-Audit-Export-Rows: <N>` header on the final chunk so the admin UI can show "exported N rows."

The endpoint MUST handle SC-004's "30 seconds for full participant history under normal load" — for a ~10k-row export, Postgres cursor + streaming CSV is ample.

**Rationale**.
- FR-006: human-readable, structured format. CSV is the standard for tabular data + opens in Excel/sheets + parses cleanly with `pandas` / `awk` / etc.
- Streaming avoids memory pressure for very large exports (spec Edge Case).
- The Next.js handler is server-side; the CSV stream goes directly from Postgres → CSV → client via a single chunked response.

**Alternatives considered**.
- *NDJSON*. Acceptable for machine readers but not as human-readable as CSV.
- *Excel binary (.xlsx)*. Rejected: requires a server-side library; CSV is sufficient.
- *Background job + download link*. Rejected: SC-004 says 30 seconds; immediate streaming hits this without a job queue.

**Constitution anchor**. III. Supports **FR-006, SC-004**.

---

## R-006 — Operational alert on audit-write failure (deferred to operations + Slice 008)

**Decision**. **In-application code** for SC-007's "operational alerts within 5 minutes of first failure" is **deferred** to operational tooling + Slice 008's notification webhook. Reasoning:

- An audit-write failure happens inside a Postgres transaction that ALSO aborts the underlying action. The user gets an HTTP error; the route handler / SP body can capture the failure on the client side of the transaction.
- The platform (Supabase / Vercel / OpenTelemetry) is the right place to detect database-error rates and alert. In-app code that tries to alert about its own failed database write would itself be unreliable.

This slice ships:

1. `tournament_config.notifications.audit_failure_webhook_url` config key (default NULL). Slice 008's admin UI sets it.
2. A short admin runbook document `specs/007-audit-trail/operational-runbook.md` that describes:
   - Supabase log alert configuration for `audit_log` insert errors.
   - How to verify alerts reach the configured webhook within 5 minutes.
   - The fallback: every Edge Function / route handler that catches an audit-related error MUST emit a structured log event with `level=ERROR, component=audit, error_code=<code>` so operations dashboards can surface it.

The runbook is **documentation, not code**. SC-007's measurable outcome is verified by the operational team's setup, not by an in-app pgTAP.

**Rationale**.
- Spec § Assumptions: "operational reasons (storage full, etc.) ... the user-facing error alone does not reach operators." The fix is operational tooling, not in-app retry logic.
- Trying to in-app a failure path that's itself a database failure is the classic "who watches the watchers" anti-pattern.
- Slice 008's webhook URL key is the application's commitment — Slice 008 admin sets it, ops layer fires through it.

**Alternatives considered**.
- *Try/catch in every audit-writing function with a POST to the webhook*. Rejected: complicates every audit-writing path; the webhook POST itself can fail with the same root cause.
- *pg_cron job that polls Supabase logs*. Rejected: requires Supabase log API integration; out of scope.

**Constitution anchor**. VII (Operational Resilience — but acknowledges this is a platform concern). Document SC-007 as operationally-met via Supabase log alerts + Slice 008 webhook.

---

## R-007 — Stable participant identifier preservation (FR-011)

**Decision**. Already satisfied by existing design — no new work in this slice:

- Slice 001's `participants.id` is UUID + stable + FK with `ON DELETE RESTRICT` (cannot be deleted while audit rows reference it).
- Deactivation flips `participants.status='deactivated'` but doesn't remove the row.
- Audit rows reference `actor uuid` which IS `participants.id`.

Therefore: audit references remain valid forever, even after participant deactivation. Display-name joins (for `audit_search` / export) join to `participants.display_name` — which also stays readable post-deactivation.

This slice documents the existing design as the FR-011 mechanism in `data-model.md` § Cross-slice ownership map; no code change needed.

**Constitution anchor**. V. Supports **FR-011**.

---

## R-008 — Admin search indexes

**Decision**. Indexes already exist from prior slices:

- `audit_log_occurred_at_idx` on `(occurred_at DESC)` — Slice 001 stub.
- `audit_log_action_occurred_idx` on `(action, occurred_at DESC)` — Slice 001 stub.

This slice adds three more for FR-005's full filter set:

| Index | Columns | Purpose |
|---|---|---|
| `audit_log_actor_occurred_idx` | `(actor, occurred_at DESC)` | Search "events by actor X" |
| `audit_log_target_idx` | `(entity_type, entity_id, sequence_id ASC)` | Target history + monotonic ordering (composite with R-002 sequence_id) |
| `audit_log_source_occurred_idx` | `(source, occurred_at DESC)` | Search by source (`admin_rpc`, `trigger`, `api_guard`, `auth_hook`, etc.) |

`audit_log_sequence_id_uk` on `sequence_id` is implicit via the bigserial's UNIQUE constraint.

**Rationale**.
- FR-005's filter dimensions all need indexed lookups for SC-003's "5 minute reconstruction" requirement.
- The composite `(entity_type, entity_id, sequence_id)` index gives both per-target filtering AND monotonic ordering in one index scan.

**Constitution anchor**. VII (perf at admin-investigation scale).

---

## R-009 — Cross-slice action label catalog

**Decision**. The action label namespace is **frozen at the end of this slice**. No new actions added by future slices except via additive extensions documented in this slice's `contracts/audit-log.schema.md`.

Consolidated catalog (across slices 001–006):

| Prefix | Producer slice | Actions |
|---|---|---|
| `access.*` | Slice 001 | `access.granted`, `access.denied` |
| `participant.*` | Slice 001 | `participant.created`, `participant.updated`, `participant.email_drift` |
| `match.*` | Slice 002 | `match.created`, `match.updated`, `match.deleted`, `match.status_changed`, `match.conflict_quarantined` |
| `match_result.*` | Slice 002 | `match_result.recorded`, `match_result.corrected` |
| `team.*` | Slice 002 | `team.created`, `team.updated`, `team.deleted` |
| `provider.*` | Slice 002 | `provider.sync_no_changes`, `provider.outage_alert_emitted`, `provider.recovered` |
| `prediction.*` | Slice 003 | `prediction.created`, `prediction.superseded`, `prediction.rejected_locked`, `prediction.rejected_invalid_score`, `prediction.rejected_invalid_match`, `prediction.rejected_ineligible`, `prediction.kickoff_correction_crossed_lock` |
| `final_prediction.*` | Slice 004 | `final_prediction.created`, `final_prediction.superseded`, `final_prediction.rejected_locked`, `final_prediction.rejected_invalid_target`, `final_prediction.rejected_invalid_input`, `final_prediction.rejected_ineligible`, `final_prediction.rejected_identical_champion_runner_up`, `final_prediction.target_player_removed`, `final_prediction.first_kickoff_corrected` |
| `tournament.*` | Slice 002 (via Slice 004 trigger) | `tournament.first_kickoff_corrected` |
| `player.*` | Slice 004 | `player.created`, `player.updated`, `player.removed` |
| `score_record.*` | Slice 005 | `score_record.insert`, `score_record.update`, `score_record.delete` |
| `score_calculation_run.*` | Slice 005 | (audit at run-level; specific actions emerge during 005 implementation) |
| `tournament_award.*` | Slice 005 | `tournament_award.set`, `tournament_award.confirmed`, `tournament_award.changed` |
| `admin.*` | Slice 006 | `admin.match_result_corrected`, `admin.match_updated`, `admin.prediction_submitted`, `admin.final_prediction_submitted`, `admin.award_updated`, `admin.pending_review_resolved`, `admin.recalc_triggered`, `admin.role_granted`, `admin.role_revoked`, `admin.access_denied` |
| `score_trigger.*` | Slice 006 (via Slice 005 extension) | `score_trigger.self_scan_resumed_runs` |
| `tournament_config.*` | Slice 008 (future) | `tournament_config.<key>` (one action per config key change) |

**Rationale**.
- A consolidated catalog is necessary for FR-005's "event type filter" — the admin UI offers a dropdown of known action labels.
- Freezing the namespace at this slice prevents action-label drift; Slice 008's `tournament_config.*` is the only documented extension point.
- The `contracts/audit-log.schema.md` will list this catalog; consumers reference by name.

**Alternatives considered**.
- *Free-text action column with no catalog*. Rejected: violates discoverability; admin UI can't render a useful filter.
- *Enum type for `action`*. Rejected: too rigid; Slice 008 + future slices need to add new actions without a coordinated migration.

**Constitution anchor**. V, XI. Cross-slice locked catalog at slice close.

---

## R-010 — Admin UI: extend Slice 006's `/admin/audit*` pages

**Decision**. Slice 006 already shipped `/admin/audit*` pages (search, detail, by-target). This slice **extends** those pages with:

1. **Filter UI completion**: action-pattern picker (dropdown built from R-009 catalog), source filter, "over-broad query" warning.
2. **Export button**: triggers `GET /api/admin/audit/export?<same filters>` and downloads CSV.
3. **Sequence_id column**: shown in the search results table for transparency.
4. **Target history view**: `/admin/audit/by-target/[entity_type]/[entity_id]` now orders by `sequence_id ASC` (per R-002), not `occurred_at`.

No new pages — extension of Slice 006's stubs.

**Rationale**.
- Slice 006 acknowledged the admin audit surface in `contracts/admin-audit.read.md` but only stubbed the implementation. This slice completes it.
- Reusing Slice 006's pages avoids parallel admin route tree.

**Constitution anchor**. III, X.

---

## R-011 — Out of scope (intentionally deferred)

- **Personal-data deletion** (GDPR-style requests): per spec § Edge Cases + § Assumptions, distinct from audit retention; lives in broader privacy policy.
- **Archival mechanism** (moving expired rows to a cold-storage table): deferred per R-003.
- **Operational alert in-app code** for audit-write failures (FR-010 / SC-007): deferred per R-006 to operations + Slice 008 webhook.
- **Audit-log encryption at rest**: handled by Supabase platform (encryption at rest is default); not application code.
- **Real-time audit stream / subscription**: out of scope; admin search is paginated reads only. Future slice could add Supabase Realtime if needed.
- **Cross-tournament audit aggregation**: out of scope; one tournament.

**Constitution anchor**. X. Tracked deferrals: operations, Slice 008.

---

## R-012 — Cross-slice contract locks introduced

| Contract | Locking task | Notes |
|---|---|---|
| `audit_log` table shape (final, consolidated across Slices 001 + 006 + this slice's additive `sequence_id`) | This slice | Slice 008 may add columns; cannot alter/drop existing |
| `audit_log` `sequence_id bigserial NOT NULL UNIQUE` column | This slice | Additive over prior shape; locked once added |
| `REVOKE UPDATE, DELETE ON audit_log FROM authenticated/anon/service_role` | This slice | DB-level tamper-resistance; no application path can violate |
| `audit_search(...)` RPC signature + ERRCODE WAT01–WAT03 | This slice | Single search funnel |
| `GET /api/admin/audit/export?...` CSV endpoint contract | This slice | Locked CSV column order + Content-Disposition |
| Action label catalog (R-009 consolidated) | This slice (catalog frozen here) | Future slices may add new labels via documented extension; cannot rename existing |
| `tournament_config.audit.retention.*` config keys | This slice (seeds defaults) | Slice 008 may extend with archival keys |
| `tournament_config.notifications.audit_failure_webhook_url` key | This slice (seeds NULL default) | Slice 008 admin UI sets the URL |

These eight extend the cross-slice foundation. After this slice ships, audit posture is final.

---

## Summary

All implementation-pattern unknowns resolved. The slice is primarily a hardening + admin-surface layer over the audit infrastructure already built up across slices 001–006. Constitution check in `plan.md` references these decisions by ID.
