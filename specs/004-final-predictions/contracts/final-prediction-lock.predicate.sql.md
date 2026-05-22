# Contract: `is_final_prediction_locked()` predicate (locked cross-slice)

**Slice**: 004-final-predictions
**Date**: 2026-05-16
**Status**: Phase 1 (Plan) — **locked cross-slice contract**.

The global lock predicate for final tournament predictions. Single instant; all four item kinds become immutable for all participants simultaneously at `tournament_config.first_kickoff_utc`. Constitution Principle III is satisfied because the rule has exactly one home: this function.

It is a **locked cross-slice contract**. Signature changes require coordinated updates across:
- Slice 005's `peer_final_pick_v` view filter.
- Slice 006's admin "reopen finals" tooling.
- Slice 004's own `submit_final_prediction` SP and `/api/me/final-predictions` lock_state computation.

## Signature

```sql
CREATE OR REPLACE FUNCTION public.is_final_prediction_locked()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first_kickoff timestamptz;
BEGIN
  SELECT (value::text)::timestamptz INTO v_first_kickoff
  FROM public.tournament_config
  WHERE key = 'first_kickoff_utc';

  IF v_first_kickoff IS NULL THEN RETURN true; END IF;    -- fail-closed
  RETURN now() >= v_first_kickoff;                        -- BR-LOCK-005 strict boundary
END $$;
```

| Property | Value | Why locked |
|---|---|---|
| Name | `public.is_final_prediction_locked` | Referenced by every consumer by name |
| Arguments | _(none)_ | Lock is global — no per-item, per-participant, or per-match variation |
| Return | `boolean` (never NULL) | Branch decisions use it directly |
| Volatility | `STABLE` | Memoizes within a query; re-evaluates between transactions (config can change at runtime) |
| Security | `SECURITY INVOKER` | Honors caller's RLS on `tournament_config` |
| `search_path` | `public, pg_temp` | Injection defense |

## Semantics

Returns **`true`** (locked) when:
1. The `tournament_config` row for `first_kickoff_utc` does not exist (fail-closed against missing config).
2. `now() >= first_kickoff_utc` — BR-LOCK-005 strict boundary: at exactly first_kickoff_utc the lock IS fired.

Returns **`false`** (editable) when both:
- The config row exists AND
- `now() < first_kickoff_utc` (strictly before).

## Performance

| Metric | Target | Why |
|---|---|---|
| p95 latency | < 5 ms | Called by every write-time check + every `/api/me/final-predictions` response + every Slice 005 peer_final_pick_v row |
| Index footprint | 1 PK lookup on `tournament_config(key)` | |
| Plan caching | STABLE memoization within a query | |

## Test surface

| Test | Assertion |
|---|---|
| `is_final_prediction_locked_before.sql` | first_kickoff_utc = now() + 1 hour → returns `false` |
| `is_final_prediction_locked_at_boundary.sql` | first_kickoff_utc = now() → returns `true` (strict BR-LOCK-005) |
| `is_final_prediction_locked_just_before.sql` | first_kickoff_utc = now() + 1 second → returns `false` |
| `is_final_prediction_locked_just_after.sql` | first_kickoff_utc = now() - 1 second → returns `true` |
| `is_final_prediction_locked_far_after.sql` | first_kickoff_utc = now() - 1 day → returns `true` |
| `is_final_prediction_locked_config_missing.sql` | DELETE the row → returns `true` (fail-closed) |
| `is_final_prediction_locked_config_changes.sql` | Pre-state locked. UPDATE to push first_kickoff into the future. Re-call within 1 second. Asserts now returns `false` (SC-005 1-minute responsiveness) |
| `is_final_prediction_locked_uses_db_clock.sql` | Demonstrates `now()` is the DB clock (not session local) |
| `is_final_prediction_locked_perf.sql` | 1,000 invocations against the dev fixture; p95 < 5 ms |

All authored RED before T004 implements the function body (Constitution Principle IX).

## Consumers

| Slice | Surface | How it uses the predicate |
|---|---|---|
| 004 (this slice) | `submit_final_prediction` SP | First check before INSERT/UPDATE; raises EXCEPTION if `true` |
| 004 (this slice) | `/api/me/final-predictions` route | Computes `lock_state = is_final_prediction_locked() ? 'locked' : 'editable'` |
| 005 (Scoring) | `peer_final_pick_v` view | `WHERE public.is_final_prediction_locked() = true` — peer picks visible only after lock |
| 006 (Admin Overrides) | Admin "reopen finals" UI | Calls predicate to determine whether admin action is required |
| 008 (Configuration) | Admin `first_kickoff_utc` editor | Reads `tournament_config.first_kickoff_utc`; the predicate's reading of the same key validates the config change took effect |

## Versioning policy

- Body changes are allowed but MUST preserve: `true` when locked, `false` when editable; fail-closed on missing config; BR-LOCK-005 strict boundary semantics.
- Renaming the function or changing arguments / return type is **breaking** — coordinated update required across all consumers.
- Function deliberately not versioned (no `_v1` suffix).
