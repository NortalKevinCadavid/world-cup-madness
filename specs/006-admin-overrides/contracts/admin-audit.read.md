# Contract: Admin Audit / Override History Read

**Slice**: 006-admin-overrides
**Date**: 2026-05-17
**Status**: Phase 1 (Plan).

Read surfaces for the admin-side audit trail. Per spec FR-011 + US1 § Acceptance Scenario 3 ("every participant whose points changed MUST have an audit record per affected score with previous-points / new-points and a pointer back to the override event").

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/audit` | Paginated search of `audit_log` filtered to admin actions |
| `GET /api/admin/audit/[id]` | Single audit row with derived linkage (e.g., affected score_records for a recalc trigger) |
| `GET /api/admin/audit/by-target/[entity_type]/[entity_id]` | Full override history for a specific target (match, prediction, award) |

All require `requireAdmin(client)`.

## `GET /api/admin/audit` — paginated search

### Request

```
GET /api/admin/audit?action=admin.match_result_corrected&actor=<participant_id>&from=2026-06-01T00:00:00Z&to=2026-06-15T00:00:00Z&q=postponed&page=1&page_size=50
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `action` | string | (any) | Filter by action label (LIKE pattern supported: `admin.%`) |
| `actor` | uuid | (any) | Filter by admin participant id |
| `entity_type` | string | (any) | `match` / `prediction` / etc. |
| `from`, `to` | ISO-8601 UTC | (none) | `occurred_at` window |
| `q` | string | (none) | Free-text search on `reason` + `source_citation` |
| `page` | int ≥ 1 | `1` | |
| `page_size` | int (1..200) | `50` | |

### Response — 200 OK

```jsonc
{
  "audit_log": [
    {
      "id": "uuid",
      "actor_participant_id": "uuid",
      "actor_display_name": "Admin Name",
      "action": "admin.match_result_corrected",
      "entity_type": "match_result",
      "entity_id": "uuid",
      "previous_value": { ... },
      "new_value": { ... },
      "reason": "Provider had wrong score; corrected per official announcement",
      "source_citation": "https://example.com/announcement",
      "source": "admin_rpc",
      "occurred_at": "2026-06-12T20:30:00Z"
    }
  ],
  "page": 1,
  "page_size": 50,
  "total": 142
}
```

Server JOINs `actor_participant_id` to `participants.display_name` for the response.

### Errors: 401 / 403 / 500 standard shapes.

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-audit-search-by-action.spec.ts` | Filter by `action='admin.match_result_corrected'`; assert only those rows |
| `slice-006-admin-audit-search-q-on-reason.spec.ts` | Free-text search on `reason` substring |
| `slice-006-admin-audit-pagination.spec.ts` | `?page_size=10`; next-page yields next 10 |
| `slice-006-admin-audit-403-non-admin.spec.ts` | Non-admin → 403 |

---

## `GET /api/admin/audit/[id]` — single row with linkage

### Response — 200 OK

```jsonc
{
  "audit_log": { ... single row as above ... },
  "linkage": {
    "triggered_recalc_run_id": "uuid",     // if action was admin.recalc_triggered
    "affected_score_records_count": 1052,  // if linked recalc completed
    "affected_participants_count": 487     // distinct participants whose score changed
  }
}
```

The `linkage` block is computed by JOINing `score_calculation_runs.triggering_audit_log_id = audit_log.id` and counting affected `score_records` rows.

### Errors: 401 / 403 / 404 / 500.

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-audit-detail-recalc-linkage.spec.ts` | Get audit row for an admin.recalc_triggered action; assert `linkage.triggered_recalc_run_id` is populated AND `affected_score_records_count` matches the run's `affected_record_count` |
| `slice-006-admin-audit-detail-404.spec.ts` | Unknown id → 404 |

---

## `GET /api/admin/audit/by-target/[entity_type]/[entity_id]` — target-scoped history

### Response — 200 OK

```jsonc
{
  "target": { "entity_type": "match", "entity_id": "uuid" },
  "audit_log": [
    // All audit_log rows ordered by occurred_at ASC where entity_type + entity_id match
  ],
  "current_state": {
    // The current state of the target (latest non-superseded row, current match_results, etc.)
  }
}
```

For `entity_type='match'`: includes both `admin.*` rows AND the sync coordinator's `match.created` / `match.updated` rows so the admin sees the full lifecycle.

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-audit-by-match-full-lifecycle.spec.ts` | Pre-state: match was synced, admin corrected score twice, admin updated status once. Assert all 5+ audit rows returned in time order |

---

## Cross-slice contract summary

| Surface | Locked? |
|---|---|
| `GET /api/admin/audit*` endpoint shapes | **Locked** |
| Response field names (`audit_log`, `linkage`, `current_state`) | **Locked** |
| Free-text search on `reason` + `source_citation` (case-insensitive substring) | **Locked** |
| Default `page_size=50`, max 200 | **Locked** |

This contract supports FR-011 (admin can view, search, and inspect full override history for any target) and US1.3 (pointer-back from affected-score audit to override event via `triggering_audit_log_id`).
