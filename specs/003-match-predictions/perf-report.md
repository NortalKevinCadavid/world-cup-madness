# Slice 003 — `is_prediction_locked` perf report

**Slice**: 003 — Match Predictions with Locking
**Date**: 2026-05-20
**Reference**: `contracts/prediction-lock.predicate.sql.md` § Performance — p95 < 5 ms

## Status: DEFERRED (Docker daemon down)

The perf test file `supabase/tests/pgtap/is_prediction_locked_perf.sql` was authored in T023 (Phase 5). T036's job is to RUN it and capture the latency distribution. That run is deferred until Docker Desktop is started.

## Test design (authored in T023)

- Bulk-insert 100 synthetic matches via `generate_series(1, 100)` (UUID prefix `eeee0000-...`), all `status='scheduled'` with kickoffs spaced 1 hour apart.
- `DO $$ ... $$;` block iterates 1,000 times: picks a random match via `ORDER BY random() LIMIT 1`, brackets the predicate call with `clock_timestamp()`, records per-call latency in a `TEMP TABLE perf_samples(sample_ms double precision)`.
- Single assertion via pgTAP: `percentile_cont(0.95) WITHIN GROUP (ORDER BY sample_ms) < 5.0` ms.
- `BEGIN; ... ROLLBACK;` envelope so the bulk inserts don't persist.

## Expected outcome

Predicate body (slot 0031) does at most 2 PK lookups per call:
- `matches WHERE id = p_match_id` (PK seek on `matches_pkey`).
- `tournament_config WHERE key = 'lock_window_minutes'` (PK seek on `tournament_config_pkey`).

On warm local Postgres with the predicate's `STABLE` volatility allowing within-query plan caching, p95 < 5 ms is the expected steady state. First iteration may spike (cold catalog cache); the `percentile_cont(0.95)` smooths that out.

## Run command (when Docker is up)

```powershell
supabase test db supabase/tests/pgtap/is_prediction_locked_perf.sql
```

Capture the test's own `format(...)` message: it prints the observed p95 ms value, e.g. `is_prediction_locked p95 < 5 ms over 1000 samples (observed: 0.42 ms)`.

## Latency distribution placeholder

| Percentile | Observed (ms) |
|---|---|
| p50 | DEFERRED |
| p95 | DEFERRED |
| p99 | DEFERRED |
| max | DEFERRED |

Replace `DEFERRED` rows with the actual observed values after running the test post-Docker. The p95 cell is the load-bearing one — if it exceeds 5 ms on local Postgres, the predicate body or the schema may have regressed (most likely a missing PK index — but both targets ARE PKs by definition, so investigate `EXPLAIN ANALYZE` of the SELECT instead).

## Cross-slice contract dependency

Every slice from 002+ relies on `is_prediction_locked()` being cheap because:
- Slice 002 `/api/matches` calls `get_lock_states(uuid[])` (D-015) which fans out via `unnest()` — N invocations per page.
- Slice 003 `submit_prediction` SP calls it once per submit.
- Slice 005 `peer_pick_v` view (planned) filters by lock state.
- Slice 006 admin overrides call it as a defense-in-depth gate.

A p95 regression at 5 ms cascades to every consumer. T036's sign-off is the cross-slice contract guard.
