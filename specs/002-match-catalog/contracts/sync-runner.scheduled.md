# Contract: `sync-catalog` Edge Function (scheduled sync runner)

**Slice**: 002-match-catalog
**Date**: 2026-05-15
**Status**: Phase 1 (Plan).

The Edge Function that coordinates one match-catalog sync run against a single provider. Invoked by `pg_cron` on a configurable cadence (default every 5 minutes during live windows) via the `public.trigger_sync_catalog(provider text)` wrapper (R-002). Also invokable by Slice 006's admin "trigger sync now" surface with an admin JWT.

## Invocation

### Path 1 — Scheduled (`pg_cron` → `pg_net` → Edge Function)

```http
POST /functions/v1/sync-catalog
X-Internal-Auth: <SYNC_TRIGGER_SECRET from supabase.config.toml GUC>
Content-Type: application/json

{
  "provider": "footballdata",
  "trigger": "cron",
  "run_id": "<caller-supplied uuid for idempotency>"
}
```

`pg_cron` runs `SELECT cron.schedule('sync-catalog-footballdata', '*/5 * * * *', $$ SELECT public.trigger_sync_catalog('footballdata') $$);`. The wrapper computes `run_id = gen_random_uuid()` and posts to the Edge Function.

### Path 2 — Admin manual (Slice 006)

```http
POST /functions/v1/sync-catalog
Authorization: Bearer <admin-session-jwt>
Content-Type: application/json

{
  "provider": "footballdata",
  "trigger": "admin_manual",
  "run_id": "<caller-supplied uuid>",
  "reason": "Investigating reported missing fixture"
}
```

Admin path requires `public.is_admin(auth.uid()) = true`; otherwise 403.

### Path 3 — Recovery retry

Same as Path 1 but with `trigger: "recovery"` set by `pg_cron`'s recovery cron job that retries after sustained failure (R-008).

## Auth

| Path | Mechanism |
|---|---|
| Scheduled (`cron`, `recovery`) | `X-Internal-Auth` header equals `SYNC_TRIGGER_SECRET` env. No JWT required. The secret is set via `supabase secrets set SYNC_TRIGGER_SECRET=...` and is **only** known to the Postgres GUC and the Edge Function runtime — never to clients. |
| Admin (`admin_manual`) | Supabase JWT with `is_admin(auth.uid()) = true`. |

A request with neither valid header is rejected as `401 Unauthorized` with body `{ "error": { "code": "UNAUTHENTICATED" } }`. Auth mismatch (e.g., participant JWT) → `403 Forbidden`.

## Response

### 200 OK (sync completed)

```jsonc
{
  "run_id": "uuid",
  "provider": "footballdata",
  "outcome": "success",                       // see § Outcome enum below
  "counts": { "created": 2, "updated": 1, "unchanged": 101, "rejected": 0, "quarantined": 0 },
  "started_at":  "2026-06-12T19:55:00Z",
  "finished_at": "2026-06-12T19:55:03Z",
  "attempts": 1
}
```

### 200 OK (sync deliberately did nothing — idempotent retry on same `run_id`)

```jsonc
{
  "run_id": "uuid",
  "outcome": "success_no_changes",
  "counts": { "created": 0, "updated": 0, "unchanged": 104, "rejected": 0, "quarantined": 0 },
  "started_at":  "2026-06-12T19:55:00Z",
  "finished_at": "2026-06-12T19:55:01Z",
  "attempts": 1,
  "notes": "no-op idempotent retry"
}
```

### 409 Conflict (sync already in flight for this provider — R-006)

```jsonc
{ "error": { "code": "SYNC_IN_FLIGHT", "message": "another sync for this provider is currently running" } }
```

### 422 Unprocessable Entity (rejection per R-004 / R-005)

```jsonc
{
  "run_id": "uuid",
  "outcome": "rejected_empty",                 // or rejected_undersized / rejected_duplicate_in_payload
  "error": { "code": "PROVIDER_PAYLOAD_INVALID", "message": "..." },
  "attempts": 1
}
```

Note: the `provider_sync_runs` row is still written with the rejection outcome — 422 here is the Edge Function's view of "I declined to apply this", not a `provider_sync_runs` write failure.

### 500 Internal Server Error

Catastrophic coordinator failure (Postgres unreachable mid-transaction). The `provider_sync_runs` row may NOT have been written; the next scheduled run will catch up. Body: `{ "error": { "code": "INTERNAL" } }`. Logs to Edge Function stderr for ops.

## Outcome enum

Written to `provider_sync_runs.outcome`:

| Outcome | Triggered by | Coordinator action |
|---|---|---|
| `success` | Provider responded, at least one row created/updated. | Catalog mutated; audit row per change. |
| `success_no_changes` | Provider responded but nothing changed. | No catalog mutation; one audit row `provider.sync_no_changes`. |
| `partial` | Coordinator started applying changes, then encountered a per-row conflict (R-005). | The non-conflicting changes are applied; conflicting rows go to `match_pending_review`; one audit row per affected match. |
| `client_error` | Adapter threw `ProviderClientError` (4xx other than 429). | No mutation; alert fires (R-008). |
| `exhausted_retries` | Adapter threw transient errors `max_attempts` times. | No mutation; outage counter increments. |
| `rejected_empty` | R-004 empty-payload guard tripped. | No mutation; alert fires. |
| `rejected_undersized` | R-004 undersized-payload guard tripped. | No mutation; alert fires. |
| `rejected_duplicate_in_payload` | R-005 in-payload duplicate guard tripped. | No mutation; alert fires. |
| `conflict_quarantined` | One or more rows triggered R-005 cross-run conflict (and no non-conflicting rows were available to also apply). | Rows quarantined; alert fires. |

## Coordinator behavior (step by step)

1. **Parse & auth.** Reject 401/403 on bad credentials.
2. **Acquire advisory lock** `pg_try_advisory_lock(hashtext('sync_catalog'), hashtext(provider))`. On failure → 409, exit.
3. **Insert `provider_sync_runs` row** with `outcome=NULL`, `started_at=now()`. Capture the row's `id` (== `run_id` from request). If `run_id` already exists with `outcome=NULL` → another instance is still running for the same id; release lock, return 409. If exists with non-NULL outcome → idempotent retry; return the recorded outcome with `notes="idempotent retry"`.
4. **Resolve adapter** by `provider_name`. If unknown → `outcome='client_error'`, error=`unknown provider`, alert, exit.
5. **Retry loop** for `fetchFixtures` + `fetchResults` per R-007. On exhaustion → record outcome, increment outage state, alert if threshold crossed.
6. **Payload sanity checks** (R-004). On failure → record outcome (`rejected_*`), alert, exit.
7. **In-payload duplicate check** (R-005). On duplicate → record `rejected_duplicate_in_payload`, alert, exit.
8. **UPSERT teams** in a single transaction. Audit each created/updated team.
9. **UPSERT matches** per row. For each row:
   - Lookup mapping via `match_provider_external_ids`.
   - If no mapping → INSERT match + mapping; audit `match.created`.
   - If mapping exists → diff against current `matches` row. Apply R-005 conflict-vs-non-conflict logic. Apply or quarantine accordingly; audit per row.
10. **UPSERT match_results** for matches whose `status='finished'` per the provider. Apply CHECK `_for_scoring <= _official` invariant.
11. **Update `provider_sync_runs`**: set `finished_at`, `outcome`, `counts`, `attempts`.
12. **Update `provider_sync_state`**: clear outage fields on success; update outage start on failure.
13. **Emit alert** if R-008 says so.
14. **Release advisory lock** in `finally` block.
15. **Return** the response shape above.

The whole sequence is wrapped in a single Postgres transaction (`BEGIN; … COMMIT;`) — partial application is impossible. The advisory lock spans the transaction.

## Performance budget

| Metric | Target | Why |
|---|---|---|
| End-to-end run time | < 30s p95 (well under the 60s Edge Function ceiling) | SC-001 implies < 5 min total catalog-reflect time; sync itself is one slice of that. |
| Payload size | < 5 MB | Within Edge Function memory; ~104 matches × ~2KB each = 250 KB upper bound |
| Concurrent runs per provider | exactly 1 | Advisory lock enforces |
| Concurrent runs across providers | unbounded | Per-provider lock allows N providers in parallel |

## Test surface

Authored as Deno tests under `supabase/functions/sync-catalog/tests/`:

| File | Test |
|---|---|
| `single_sync_happy.test.ts` | Stub adapter returns 5 fixtures + 0 results; POST to function; assert 200 + counts.created=5; assert `matches` has 5 rows; assert `provider_sync_runs.outcome='success'`. |
| `idempotent_retry.test.ts` | POST same body twice with same `run_id`; second call returns 200 with `notes="idempotent retry"` and identical body. |
| `advisory_lock_returns_409.test.ts` | Hold `pg_advisory_lock` in a side connection; POST sync; assert 409 + `SYNC_IN_FLIGHT`. |
| `non_admin_returns_403.test.ts` | POST with participant JWT (not admin); assert 403. |
| `internal_auth_path.test.ts` | POST with valid `X-Internal-Auth` header + no JWT; assert 200. POST with wrong header; assert 401. |
| `empty_payload_rejected.test.ts` | Stub adapter returns []; assert 422 + outcome `rejected_empty`; assert `matches` unchanged; assert alert emitted. |
| `undersized_payload_rejected.test.ts` | Pre-seed 100 matches; stub returns 30 (< 50%); assert 422 + outcome `rejected_undersized`. |
| `duplicate_in_payload_rejected.test.ts` | Stub returns 2 rows with same `providerMatchId`; assert 422 + outcome `rejected_duplicate_in_payload`. |
| `cross_run_conflict_quarantined.test.ts` | Seed match with home_team=A, away_team=B; stub returns same provider id but home_team=A, away_team=C; assert `match_pending_review` has 1 row; assert `matches` unchanged; outcome `conflict_quarantined`. |
| `score_before_kickoff_quarantined.test.ts` | Seed scheduled match; stub returns result for it before kickoff; assert quarantined; assert `match_results` NOT inserted. |
| `outage_alert_dedup.test.ts` | Three consecutive failures past threshold; assert exactly one alert audit row. |
| `recovery_clears_outage_state.test.ts` | After outage, one successful run; assert `provider_sync_state.outage_alerted_at` cleared; assert `audit_log` has `provider.recovered`. |
| `provider_swap_test.ts` | Run with stub-provider-A; record `matches` state. Swap `tournament_config.provider.active` to stub-B (different internal schema, contract-compliant output of same fixtures). Run again; assert `matches` state byte-identical. **SC-005 invariant.** |

All tests RED-first per Constitution Principle IX before the coordinator's implementation.

## Implementation notes (for `/speckit-tasks` to expand)

- The `X-Internal-Auth` secret is set via `supabase secrets set SYNC_TRIGGER_SECRET=...`. The Postgres GUC `app.sync_trigger_secret` is set in `supabase/config.toml`'s `[db.settings]` so the SECURITY DEFINER wrapper can read it without round-tripping.
- The advisory-lock release in `finally` block MUST handle exceptions thrown by the audit-row write — otherwise a partial write could leave the lock held until session close. Use Deno's `try/finally` rather than relying on connection-close auto-release.
- The alert transport is a webhook to a URL configured via `tournament_config.notifications.outage_webhook_url`. If the URL is null, the alert is written to `audit_log` only (still meets SC-003's "alert emitted" requirement as long as ops can see audit). Slice 008 will harden the transport.
- The Edge Function imports `MatchDataProviderAdapter` from `_shared/providers/types.ts` and resolves the concrete adapter via a static map keyed by `provider_name` — no dynamic require, no eval.
