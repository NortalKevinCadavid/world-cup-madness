# Phase 1 Data Model: Admin Overrides & Recalculation

**Feature**: 006-admin-overrides
**Date**: 2026-05-17
**Status**: Draft (Phase 1 output)
**Vendor-neutral**: Capability terms (Principle I).

## Cross-slice ownership map

| Artifact | Owner slice | This slice's responsibility |
|---|---|---|
| `public.admin_roles` | **006 (this slice creates)**; Slice 008 ships assignment UI | Create table, RLS, seed bootstrap admin |
| `public.is_admin(uuid)` real body | **006 (this slice replaces Slice 001 stub)** | Replace function body; signature unchanged |
| `public.admin_*` RPC family (7 functions) | **006 (this slice)** | Create, register ERRCODE values, audit emission |
| `public.pending_recalc_state` VIEW | **006 (this slice)** | Create |
| `audit_log.source_citation` column | **006 (this slice adds; Slice 001 stubbed audit_log)** | Additive column |
| `audit_log` action labels `admin.*` | **006 (this slice writes)** | New action label namespace |
| `score_calculation_runs.triggering_audit_log_id` | Slice 005 (this slice adds additive column) | Additive column |
| `participants`, `is_eligible_nortal_participant` | Slice 001 | Read-only consumer |
| `audit_log` | Slice 007 (Slice 001 stubs) | Write target |
| `tournament_config` | Slice 008 (Slice 001 stubs) | Read-only consumer + read for `pending_recalc_state` view |
| `matches`, `match_results`, `match_pending_review` | Slice 002 | Read + admin write via SP |
| `predictions`, `submit_prediction` SP | Slice 003 | Admin-source SP path consumer |
| `final_predictions`, `players`, `submit_final_prediction` SP | Slice 004 | Admin-source SP path consumer |
| `tournament_award`, `score_calculation_runs`, `score-trigger` Edge Function | Slice 005 | Read + admin-trigger consumer |

After this slice ships, the real `is_admin(uuid)` body + the `admin_*` RPC family + ERRCODE values + audit action labels are **locked cross-slice contracts**.

## Entities introduced by this slice

### 1. Admin Role

**Purpose**. The data backing for `is_admin(uuid)`. A single active row per participant grants admin authority; setting `revoked_at` revokes it.

| Attribute | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` | |
| `participant_id` | UUID | NOT NULL, FK → `participants(id)` ON DELETE RESTRICT | |
| `granted_at` | timestamptz | NOT NULL, server-default `now()` | |
| `granted_by` | UUID | NULL allowed, FK → `participants(id)` | Admin who granted; NULL for bootstrap |
| `revoked_at` | timestamptz | NULL when active | |
| `revoked_by` | UUID | NULL allowed, FK → `participants(id)` | |
| `revoke_reason` | text | NULL allowed | |
| `created_at` | timestamptz | NOT NULL, server-default `now()` | |
| `updated_at` | timestamptz | NOT NULL, server-default `now()` | Trigger-maintained |

**Unique partial index**: `CREATE UNIQUE INDEX admin_roles_active_uk ON admin_roles(participant_id) WHERE revoked_at IS NULL;` — at most one active row per participant.

**CHECK constraints**:
- `((revoked_at IS NULL) = (revoked_by IS NULL))` — consistent revoke state.

**State transitions**.
- **Granted → Revoked**: `revoked_at`, `revoked_by`, optional `revoke_reason` set. Terminal — revoked rows stay; new grants insert a new row.

**Relationships**.
- N:1 → `participants` (via `participant_id`).
- 1:N → `audit_log` (`admin.role_granted` and `admin.role_revoked` action labels — Slice 008 will own the admin UI for this; this slice's bootstrap seed emits the initial `admin.role_granted` row).

**Indexes**.

| Index | Columns | Purpose |
|---|---|---|
| `admin_roles_pkey` | `(id)` PK | |
| `admin_roles_active_uk` | `(participant_id) WHERE revoked_at IS NULL` UNIQUE PARTIAL | One active grant per participant |
| `admin_roles_participant_idx` | `(participant_id, granted_at DESC)` | History queries |

**Audit posture**. `AFTER INSERT OR UPDATE` trigger on `admin_roles` emits `audit_log` rows: INSERT → `admin.role_granted`; UPDATE setting `revoked_at` → `admin.role_revoked`. Recursion guard pattern.

---

### 2. Admin Override Event (audit-log subset; no dedicated table)

**Purpose**. Per spec § Key Entities. Realized as `audit_log` rows with `source='admin_rpc'` rather than a dedicated table (R-004).

**Schema** (extended from Slice 001's `audit_log` by this slice's additive `source_citation` column):

| Attribute | Source | Notes |
|---|---|---|
| `id` | Slice 001 | |
| `actor` | this slice writes | admin's `participants.id` |
| `action` | this slice writes | One of: `admin.match_result_corrected`, `admin.match_updated`, `admin.prediction_submitted`, `admin.final_prediction_submitted`, `admin.award_updated`, `admin.pending_review_resolved`, `admin.recalc_triggered`, `admin.role_granted`, `admin.role_revoked`, `admin.access_denied` |
| `entity_type` | this slice writes | `match` / `match_result` / `prediction` / `final_prediction` / `tournament_award` / `match_pending_review` / `score_calculation_run` / `admin_role` |
| `entity_id` | this slice writes | The target row |
| `previous_value` / `new_value` | this slice writes | Full row diffs |
| `reason` | this slice writes | NOT NULL (FR-002); free text |
| **`source_citation`** | this slice **adds** as a new column | NOT NULL for all override RPCs; URL or document reference |
| `source` | this slice writes | `'admin_rpc'` (or `'api_guard'` for access-denied rows) |
| `occurred_at` | Slice 001 | |

**Cross-slice contract** (`source_citation` column): additive over Slice 001's `audit_log` stub. Slice 007's hardening preserves the column.

**Validation rules** (enforced at the SP body):
- `reason` not empty (FR-002).
- `source_citation` not empty for override actions (`admin.*_corrected`, `admin.*_updated`, etc.); MAY be NULL only for `admin.access_denied`, `admin.role_granted`, `admin.role_revoked`.

**Retention**. Append-only; Slice 007's hardening enforces no UPDATE/DELETE via app paths.

---

### 3. Recalculation Run (audit reference via Slice 005)

**Purpose**. Per spec § Key Entities. Already owned by Slice 005 as `score_calculation_runs`. This slice adds one column (R-013):

| Attribute | Source | Notes |
|---|---|---|
| existing columns | Slice 005 | unchanged |
| `triggering_audit_log_id` | **this slice adds** | NULL allowed; FK → `audit_log(id)` |

The `admin_trigger_recalc` RPC sets this when it INSERTs the run row. Lets queries answer "which admin override triggered this recalc?" in one JOIN.

**Cross-slice contract**: additive over Slice 005's `score_calculation_runs` shape. Slice 005's research § R-014 permits "Slice 007 hardens retention; column shapes are locked" — additive interpretation.

**Audit posture**: Slice 005 already audits run state transitions. This slice's audit is via the `audit_log` `admin.recalc_triggered` row, which `triggering_audit_log_id` points at.

---

### 4. Pending Recalc State (VIEW; not a table)

**Purpose**. Per FR-010. A SQL view computes whether scoring-affecting configuration has changed since the last successful recalc.

```sql
CREATE OR REPLACE VIEW public.pending_recalc_state AS
SELECT
  (SELECT max(occurred_at) FROM public.audit_log WHERE action LIKE 'tournament_config.scoring%') AS last_scoring_config_change_at,
  (SELECT max(completed_at) FROM public.score_calculation_runs WHERE status = 'succeeded') AS last_successful_recalc_completed_at,
  (SELECT count(*) FROM public.audit_log al WHERE al.action LIKE 'tournament_config.scoring%' AND al.occurred_at > COALESCE((SELECT max(completed_at) FROM public.score_calculation_runs WHERE status = 'succeeded'), '1970-01-01'::timestamptz)) AS pending_config_changes_count,
  (SELECT count(*) > 0 FROM public.audit_log al WHERE al.action LIKE 'tournament_config.scoring%' AND al.occurred_at > COALESCE((SELECT max(completed_at) FROM public.score_calculation_runs WHERE status = 'succeeded'), '1970-01-01'::timestamptz)) AS recalc_pending;
```

**Cross-slice contract**: Slice 008's tournament_config audit MUST emit `action='tournament_config.scoring.<key>'` (e.g., `tournament_config.scoring.match_points.exact`) for scoring-relevant keys so this view's filter matches. This is a Slice 008 commitment.

**RLS posture**: view inherits underlying `audit_log` + `score_calculation_runs` policies (admin-only read).

---

## Helper functions owned by this slice

### `is_admin(uuid)` — real body (replaces Slice 001 stub; locked signature)

See `contracts/is-admin.predicate.sql.md`.

### Admin RPC family (locked signatures + ERRCODE values WAR01–WAR06)

See `contracts/admin-rpcs.write.md` for each:
- `admin_record_match_result(...)`
- `admin_update_match(...)`
- `admin_submit_prediction(...)`
- `admin_submit_final_prediction(...)`
- `admin_update_tournament_award(...)`
- `admin_resolve_match_pending_review(...)`
- `admin_trigger_recalc(...)`

### Reaper function `reap_stale_recalc_runs()` (per R-007)

```sql
CREATE OR REPLACE FUNCTION public.reap_stale_recalc_runs() RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reaped int := 0;
  v_run record;
BEGIN
  FOR v_run IN
    SELECT * FROM public.score_calculation_runs
    WHERE status = 'running' AND started_at < now() - INTERVAL '60 seconds'
  LOOP
    -- Re-POST to score-trigger Edge Function with the same run_id; Slice 005's idempotency handles resumption
    PERFORM net.http_post(
      url := current_setting('app.score_trigger_url'),
      headers := jsonb_build_object('X-Internal-Auth', current_setting('app.score_trigger_secret')),
      body := jsonb_build_object('scope', v_run.scope, 'target_id', v_run.target_id, 'trigger', 'recovery', 'run_id', v_run.id)
    );
    v_reaped := v_reaped + 1;
  END LOOP;
  RETURN v_reaped;
END $$;

-- Scheduled every 30 seconds via pg_cron
SELECT cron.schedule('reap-stale-recalcs', '*/30 * * * * *', 'SELECT public.reap_stale_recalc_runs();');
```

**Constitution anchor**. VII (Operational Resilience).

---

## RLS posture summary

| Table / View | Policy | Type | Predicate |
|---|---|---|---|
| `admin_roles` | `admin_roles_admin_read` | SELECT | `public.is_admin(auth.uid())` |
| `admin_roles` | `admin_roles_admin_write` | INSERT/UPDATE | `WITH CHECK (public.is_admin(auth.uid()))` — admin can grant/revoke other admins. **However**, in practice all writes go through Slice 008's admin RPC; the WITH CHECK is the safety net |
| `pending_recalc_state` (view) | inherits | inherits from underlying tables | |

**Note**: Every `admin_*` RPC is `SECURITY DEFINER` so RLS write policies are not load-bearing — the RPC itself enforces `is_admin` before writing. The RLS write policy on `admin_roles` exists for defense-in-depth (if some hypothetical future path lets a participant client INSERT into `admin_roles`, RLS blocks it).

---

## Capability contracts owned by this slice

1. **`is_admin(uuid)` real body** (locked cross-slice — signature unchanged from Slice 001 stub; body replaced).
2. **`admin_roles` table shape** (locked; Slice 008 extends assignment UI but cannot alter shape).
3. **Admin RPC family signatures + ERRCODE values WAR01–WAR06** (locked).
4. **`audit_log.source_citation` column** (additive over Slice 001 stub; locked once added).
5. **`audit_log` action labels `admin.*`** (locked label set; Slice 007 may add columns but cannot rename).
6. **`score_calculation_runs.triggering_audit_log_id` column** (additive over Slice 005 shape; locked once added).
7. **`pending_recalc_state` VIEW** (Slice 008 admin UI may consume).

These seven extend the cross-slice foundation. After this slice ships, admin-side workflows are locked.

## Open questions deferred

| Question | Owner slice | This slice's posture |
|---|---|---|
| Admin assignment / revocation UI | 008 | Table stub here; UI in Slice 008 |
| Notification of significant score changes | 008 + OD-008 | Audit emission only |
| Multi-tenant admin scoping | future | Out of scope; single tournament |
| Bulk import (CSV of corrections) | future | RPC family supports it; UI not built |
| Audit retention + search hardening | 007 | This slice writes via current shape; Slice 007 hardens |
