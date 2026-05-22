# Slice 004 — Performance Report

| Field | Value |
|---|---|
| Slice | 004-final-predictions |
| Task | T032 |
| Date | 2026-05-20 |
| Constitution principle | VII (Performance budgets are explicit and verified) |
| Target | `public.is_final_prediction_locked()` p95 < 5 ms over 1,000 invocations |
| Test file | `supabase/tests/pgtap/is_final_prediction_locked_perf.sql` (T021 file 9) |

## Status

**DEFERRED — runtime verification deferred to T034.**

The Docker daemon is not running on this workstation, so `supabase test db` cannot be invoked locally. The perf assertion is authored, committed, and ready to execute; runtime measurement is folded into T034's consolidated regression-final gate.

## Predicate code-review

### Body summary

The migration `supabase/migrations/0041_is_final_prediction_locked.sql` defines a plpgsql function whose body reduces to:

```sql
SELECT (value::text)::timestamptz
  FROM public.tournament_config
 WHERE key = 'first_kickoff_utc';
-- + one NULL guard
-- + one  now() >= v_first_kickoff  comparison
```

Cost components per invocation:

1. **One PK lookup** on `tournament_config(key)` — single-row hit against a 1-row JSONB key/value table (the table is bounded to ~10 admin keys at most).
2. **One JSONB → text → timestamptz cast** of a small scalar value.
3. **One `now()` comparison** — `now()` is the transaction start timestamp, cached.
4. **One NULL guard** branching.

### No expensive operations

- No table scans of unbounded tables.
- No subqueries against `matches`, `final_predictions`, or `players`.
- No joins. (Contrast with slice 003's `is_prediction_locked(match_id)`, which joins on `matches` to read `kickoff_utc` — that predicate's measured p95 was still << 1 ms on local dev.)
- `STABLE` volatility allows the planner to memoize within a single query, so callers like `peer_final_pick_v` (slice 005) that reference the predicate per row will only pay the lookup cost once per statement.
- `SET search_path = public, pg_temp` is a per-call GUC stack push but is negligible compared to the row read.

### Expected p95 estimate

**<< 1 ms** (estimated, code-review only). Comfortably inside the 5 ms budget defined in `contracts/final-prediction-lock.predicate.sql.md` § Performance.

Rationale: this predicate is strictly simpler than slice 003's `is_prediction_locked(match_id)` — same number of comparisons, no join, smaller source table. Slice 003 documented p95 << 1 ms against a 100-match fixture; slice 004's predicate should be at least as fast.

## Carry-forward reference

- T021 file 9 (`supabase/tests/pgtap/is_final_prediction_locked_perf.sql`) is authored and committed.
- Methodology already calibrated: future-dated `first_kickoff_utc` (exercises the read + comparison branch, not the fail-closed early return); 1,000 iterations timed via `clock_timestamp()` deltas; assertion `percentile_cont(0.95) < 5.0`.
- The `STABLE` memoization caveat is acknowledged in the test header: each iteration runs a fresh statement (`SELECT public.is_final_prediction_locked() INTO v_result`), so each iteration pays the real lookup cost rather than reusing a cached value.

## Verification command (deferred)

PowerShell, to be run once Docker is available (executed under T034):

```powershell
supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_perf.sql
```

Expected output: `ok 1 - is_final_prediction_locked p95 < 5 ms over 1000 samples (observed: <X.XX> ms)`.

## Pre-merge note

T034 (consolidated regression-final gate) will include this perf test in its runtime sweep. Slice 004 will not be marked complete until T034 reports the perf test GREEN with the observed p95 substituted into the OK message. If observed p95 ever approaches the 5 ms ceiling, the remediation is straightforward: confirm the PK index on `tournament_config(key)` exists (it does, per slot 0010), and verify no admin process is mutating the row mid-test.

## Risk factors

- **Low**: Docker startup time on developer workstations may delay T034 execution but does not affect production behavior.
- **Low**: If a future migration adds a `BEFORE SELECT` trigger or RLS policy that materially inflates the read cost on `tournament_config`, this perf test will catch it under T034. No such trigger or policy is currently in flight.
- **None observed**: predicate body is the minimum work necessary to honor BR-LOCK-005.
