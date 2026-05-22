# Contract: Match Results write path

**Slice**: 002-match-catalog
**Date**: 2026-05-15
**Status**: Phase 1 (Plan).

How `match_results` rows are produced (and corrected). The write path is the single source of truth for Slice 005's scoring engine — Slice 005's `score_match` SQL function reads `match_results.home_score_for_scoring` / `away_score_for_scoring` by name, so the column semantics defined here are a **locked cross-slice contract**.

## Producers of `match_results` rows

Three paths exist for writing into `match_results`. All three flow through the same SECURITY DEFINER stored procedure `public.record_match_result(...)` so the invariants (CHECK `_for_scoring <= _official`, `status='finished'` precondition, audit row in same transaction) are enforced uniformly.

| Producer | Caller | Trigger | `source` value |
|---|---|---|---|
| **Sync coordinator** | `sync-catalog` Edge Function | A provider returns confirmed results for a match whose `status` transitions to `finished` | `sync` |
| **Admin manual entry** | Slice 006 admin UI / RPC | Admin invokes manual-result form (used when provider is unavailable or wrong) | `admin_correction` |
| **Admin re-entry (correction)** | Slice 006 admin UI / RPC | Admin updates an existing result (e.g., provider initially reported 2-1, then corrected to 2-2) | `admin_correction` (separate row written via the same SP) |

This slice **owns** the SP and the sync-coordinator path. Slice 006 will add the admin UI; the admin RPC simply calls the same SP with `source='admin_correction'` and an authenticated `participants.id` in `approved_by`.

## Stored procedure: `public.record_match_result(...)`

```sql
CREATE OR REPLACE FUNCTION public.record_match_result(
  p_match_id              uuid,
  p_home_score_official   int,
  p_away_score_official   int,
  p_home_score_for_scoring int,
  p_away_score_for_scoring int,
  p_result_status         text,                  -- 'regulation' | 'extra_time' | 'penalties_shootout'
  p_source                text,                  -- 'sync' | 'admin_correction'
  p_approved_by           uuid                   -- NULL for sync; NOT NULL for admin_correction
)
RETURNS uuid                                     -- the match_results.match_id PK
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
...
$$;
```

Semantics:

1. **Precondition checks** (raise `EXCEPTION` on failure — the caller's transaction rolls back):
   - `p_match_id` exists in `matches`.
   - `(SELECT status FROM matches WHERE id = p_match_id) = 'finished'` — results can only be recorded for finished matches. The sync coordinator updates `matches.status` immediately before this call in the same transaction.
   - `p_home_score_official >= 0 AND p_away_score_official >= 0`.
   - `p_home_score_for_scoring >= 0 AND p_home_score_for_scoring <= p_home_score_official`.
   - `p_away_score_for_scoring >= 0 AND p_away_score_for_scoring <= p_away_score_official`.
   - `p_result_status IN ('regulation', 'extra_time', 'penalties_shootout')`.
   - If `p_result_status = 'penalties_shootout'`: `p_home_score_for_scoring = p_away_score_for_scoring` (level after ET) AND `(p_home_score_official > p_away_score_official) <> (p_away_score_official > p_home_score_official)` (shootout produces a single winner).
   - `p_source IN ('sync', 'admin_correction')`.
   - If `p_source = 'admin_correction'`: `p_approved_by IS NOT NULL` AND `public.is_admin(p_approved_by) = true` (defense in depth — both the admin RPC and the SP verify).

2. **UPSERT into `match_results`**: insert or update keyed by `match_id`. The audit trigger on `match_results` (T-equivalent of Slice 001's participant trigger) captures `previous_value` (the old row, NULL on first insert) and `new_value`.

3. **Return** `p_match_id`.

4. **Side effect — emit `match_results_recorded` notification**: `PERFORM pg_notify('match_results_recorded', json_build_object('match_id', p_match_id, 'source', p_source)::text);`. Slice 005's `score-trigger` Edge Function (per Slice 005 tasks.md T042) listens for this and runs `score_match(p_match_id, gen_random_uuid())`.

## Audit posture

Every successful `record_match_result` invocation produces:

1. One `audit_log` row with `action='match_result.recorded'` (first insert) or `'match_result.corrected'` (subsequent), `actor = p_approved_by` (or NULL for sync), `entity_type='match_result'`, `entity_id = p_match_id`, `previous_value = OLD row jsonb`, `new_value = NEW row jsonb`, `source = 'trigger'` (from the audit trigger).
2. Plus, for sync calls only, the encompassing `provider_sync_runs` row's `counts.updated` or `counts.created` increments (the coordinator handles that bookkeeping).
3. Plus, the `pg_notify` event for Slice 005.

Constitution Principle V (same-transaction audit) is satisfied because the audit trigger fires within the SP's transaction.

## Concurrency guarantees

- The advisory lock held by the sync coordinator (R-006) serializes sync writes per provider — only one `record_match_result` from `source='sync'` can be in flight for any given match.
- Admin-side calls (Slice 006) MUST acquire `pg_try_advisory_xact_lock(hashtext('match_result_' || p_match_id::text))` before calling the SP. The SP itself does NOT acquire a lock — that's the caller's responsibility. The caller's docstring (Slice 006) will reflect this. This split lets the sync coordinator hold one big lock for the whole run while admin calls only lock the specific match they're correcting.

## Slice 006 admin RPC (preview, not in this slice's scope)

For traceability — Slice 006 will ship something like:

```typescript
// Slice 006 (preview)
async function submitManualResult(adminClient: SupabaseClient, params: ManualResultParams) {
  const lockKey = computeAdvisoryLockKey(`match_result_${params.matchId}`);
  return adminClient.rpc('record_match_result_with_admin_lock', {
    p_match_id: params.matchId,
    // ... pass-through
    p_source: 'admin_correction',
    p_approved_by: adminClient.auth.user()?.id,
  });
}
```

The Slice 006 admin RPC wraps `record_match_result` in a transaction-scoped advisory lock and an `is_admin` check at the route handler level. That wrapping is **NOT** in this slice; only the SP is.

## Test surface

| File | Test |
|---|---|
| `record_match_result_happy.sql` (pgTAP) | Pre-seed match with `status='finished'`; call SP with valid inputs; assert single `match_results` row; assert `audit_log` row written in same transaction; assert `pg_notify` event captured via `pg_notification_queue_usage` check. |
| `record_match_result_rejects_pre_finished.sql` (pgTAP) | Match with `status='scheduled'`; call SP; assert EXCEPTION raised; assert no row in `match_results`. |
| `record_match_result_enforces_for_scoring_invariant.sql` (pgTAP) | Call SP with `home_score_for_scoring=5, home_score_official=3`; assert EXCEPTION; assert no row. |
| `record_match_result_enforces_shootout_invariant.sql` (pgTAP) | Call SP with `result_status='penalties_shootout'` and `home_score_for_scoring=2, away_score_for_scoring=3`; assert EXCEPTION (shootout requires level for-scoring). |
| `record_match_result_admin_correction_requires_approver.sql` (pgTAP) | Call SP with `source='admin_correction'` and `approved_by=NULL`; assert EXCEPTION. |
| `record_match_result_admin_correction_requires_admin.sql` (pgTAP) | Call SP with `source='admin_correction'` and `approved_by = <non-admin participant uuid>`; assert EXCEPTION. |
| `record_match_result_emits_notification.sql` (pgTAP) | Call SP; in a parallel session, `LISTEN match_results_recorded` first; assert notification received with correct payload. |
| `record_match_result_audit_format.sql` (pgTAP) | Call SP; verify audit_log row contains exact previous/new value diffs in expected shape. |

All tests RED-first per Constitution Principle IX.

## Cross-slice contract

The column names `home_score_for_scoring` / `away_score_for_scoring` and the SP signature `record_match_result(match_id, home_score_official, away_score_official, home_score_for_scoring, away_score_for_scoring, result_status, source, approved_by)` are **locked**.

| Consumer | What it depends on |
|---|---|
| Slice 005 | Reads `home_score_for_scoring` / `away_score_for_scoring` in `score_match`; listens to `match_results_recorded` notification for auto-trigger |
| Slice 006 | Calls `record_match_result` from its admin manual-result UI |
| Slice 007 | Reads the `audit_log` rows this SP emits |

Adding optional parameters is non-breaking (default arguments). Removing or reordering parameters, or changing return types, is a breaking change requiring coordinated regression updates across all consumers (Constitution Principle XI).

## Versioning policy

The SP name `public.record_match_result` MUST NOT change. Body changes are allowed but MUST preserve:
- The 8-argument signature in the order shown.
- The CHECK invariants documented above.
- The `pg_notify` channel name `'match_results_recorded'`.
- The audit-row shape (action + actor + entity_id semantics).
- The `match_results.match_id`-as-PK constraint.

Slice 008 may later introduce a config flag for the `pg_notify` channel name; until then, the channel name is the contract.
