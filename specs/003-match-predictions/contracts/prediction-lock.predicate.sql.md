# Contract: `is_prediction_locked(uuid)` predicate (locked cross-slice)

**Slice**: 003-match-predictions
**Date**: 2026-05-16
**Status**: Phase 1 (Plan) — **locked cross-slice contract**.

The canonical lock-state predicate. **Every** lock decision in the codebase — write-time rejection in `submit_prediction`, view-time filter in Slice 005's `peer_pick_v`, admin "is this still editable?" check in Slice 006 — calls this function. Constitution Principle III (Rules Outside the UI) is satisfied because the rule has exactly one home.

It is a **locked cross-slice contract**. Signature changes after this slice ships require coordinated regression updates across:
- Slice 005's `peer_pick_v` view.
- Slice 006's admin UI lock checks.
- Slice 003's own `submit_prediction` SP and `/api/matches` extension.

Body changes are allowed but MUST preserve the semantics documented below.

## Signature

```sql
CREATE OR REPLACE FUNCTION public.is_prediction_locked(p_match_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status          text;
  v_kickoff_utc     timestamptz;
  v_lock_window_min int;
BEGIN
  SELECT status::text, kickoff_utc INTO v_status, v_kickoff_utc
  FROM public.matches
  WHERE id = p_match_id;

  -- Fail-closed: unknown match → locked.
  IF v_status IS NULL THEN RETURN true; END IF;

  -- BR-LOCK-004: any non-scheduled status locks the match.
  IF v_status <> 'scheduled' THEN RETURN true; END IF;

  -- BR-LOCK-002 / BR-LOCK-003: strict boundary on >= (NOT >). At exactly
  -- kickoff − lock_window the match is locked.
  SELECT COALESCE((value::text)::int, 60) INTO v_lock_window_min
  FROM public.tournament_config
  WHERE key = 'lock_window_minutes';

  RETURN now() >= v_kickoff_utc - (v_lock_window_min * INTERVAL '1 minute');
END $$;
```

| Property | Value | Why locked |
|---|---|---|
| Name | `public.is_prediction_locked` | Referenced by every consumer by name |
| Argument | `p_match_id uuid` (single) | Slice 005 view calls `is_prediction_locked(m.id)`; SP calls `is_prediction_locked(p_match_id)` |
| Return | `boolean` (never NULL) | Branch decisions use it directly; NULL would be ambiguous |
| Volatility | `STABLE` | Allows Postgres to cache within a query; re-evaluates between transactions (necessary because `matches.status` / `matches.kickoff_utc` / `tournament_config.lock_window_minutes` can change at runtime) |
| Security | `SECURITY INVOKER` | Honors caller's RLS on `matches` and `tournament_config`. Ineligible callers see no matching matches row → `v_status IS NULL` → returns `true` (locked). Fail-closed by construction. |
| `search_path` | `public, pg_temp` | Defense-in-depth against `search_path` injection |

## Semantics

`is_prediction_locked(p_match_id)` returns **`true`** (locked) if **any** of these hold:

1. The match does not exist (no row in `public.matches` with `id = p_match_id`). Fail-closed against invalid match IDs.
2. The match's `status` is anything other than `'scheduled'` — `'in_progress'`, `'finished'`, `'postponed'`, `'cancelled'` (BR-LOCK-004).
3. Trusted server time has reached or passed `kickoff_utc - lock_window_minutes` (BR-LOCK-002 / BR-LOCK-003). The boundary uses `>=` per BR-LOCK-003's strict rule: at exactly `kickoff_utc - lock_window` the match IS locked, NOT just-still-editable.

Returns **`false`** (editable) only when ALL of:
- The match exists AND
- `matches.status = 'scheduled'` AND
- `now() < kickoff_utc - lock_window_minutes` (i.e., remaining time strictly greater than `lock_window`).

The function is **STABLE within a transaction**: `now()` evaluates to the transaction start time; calling the function twice in the same SELECT returns the same value. Across transactions, the function re-evaluates against the live state.

## Performance

| Metric | Target | Why |
|---|---|---|
| p95 latency | < 5 ms | Called inline by `submit_prediction`, by every catalog row's `lock_state` computation, and by every row in Slice 005's `peer_pick_v` filter — cannot dominate query plans |
| Index footprint | 1 lookup on `matches(id)` (PK), 1 lookup on `tournament_config(key)` (PK) | Both PK lookups |
| Plan caching | Stable within a query plan; Postgres memoizes the function call for repeated invocations against the same args | `STABLE` volatility |

## Test surface

Authored as pgTAP tests:

| Test | Assertion |
|---|---|
| `is_prediction_locked_far_before.sql` | Match with `kickoff_utc = now() + INTERVAL '1 day'`, status='scheduled', lock_window=60 → returns `false` |
| `is_prediction_locked_strict_boundary_at.sql` | `kickoff_utc = now() + INTERVAL '60 minutes'`, status='scheduled' → returns `true` (strict boundary at `>=`) |
| `is_prediction_locked_strict_boundary_just_outside.sql` | `kickoff_utc = now() + INTERVAL '60 minutes 1 second'` → returns `false` |
| `is_prediction_locked_strict_boundary_just_inside.sql` | `kickoff_utc = now() + INTERVAL '59 minutes 59 seconds'` → returns `true` |
| `is_prediction_locked_status_in_progress.sql` | `kickoff_utc = now() + INTERVAL '1 day'`, status='in_progress' → returns `true` (BR-LOCK-004 overrides remaining time) |
| `is_prediction_locked_status_finished.sql` | status='finished' → returns `true` |
| `is_prediction_locked_status_postponed.sql` | status='postponed' → returns `true` |
| `is_prediction_locked_status_cancelled.sql` | status='cancelled' → returns `true` |
| `is_prediction_locked_unknown_match.sql` | `is_prediction_locked(gen_random_uuid())` → returns `true` (fail-closed) |
| `is_prediction_locked_config_changes.sql` | Setup matches with kickoff far enough out that lock_window=60 → editable. UPDATE tournament_config to set `lock_window_minutes=180`. Same match → locked. Demonstrates SC-005 (1-minute config responsiveness; the function always reads fresh config) |
| `is_prediction_locked_uses_db_clock.sql` | Demonstrates that `now()` is the DB clock; test runs `SELECT now()` and confirms returned value matches expected boundary computation |
| `is_prediction_locked_perf.sql` | 1,000 invocations against a 100-match dataset; assert p95 < 5 ms |

All twelve tests authored RED before the function is implemented (Constitution Principle IX, NON-NEGOTIABLE).

## Consumers (downstream contract dependents)

Each of these references this function by name. Renaming or signature changes are a coordinated cross-slice change set per Constitution Principle XI.

| Slice | Surface | How it uses the predicate |
|---|---|---|
| 003 (this slice) | `submit_prediction()` SP | First check before INSERT; raises EXCEPTION if `true` |
| 003 (this slice) | `/api/matches` route handler | Computes `lock_state = is_prediction_locked(m.id) ? 'locked' : 'editable'` in the SELECT |
| 003 (this slice) | `/api/me/predictions` route handler | Read-only — doesn't gate, but uses the same predicate in surface-side computed fields |
| 005 (Scoring & Leaderboard) | `peer_pick_v` view | `WHERE public.is_prediction_locked(p.match_id) = true` — peer picks visible only after lock |
| 006 (Admin Overrides) | Admin "reopen prediction" UI | Calls the predicate to determine whether admin action is required (only matches where the predicate would currently return `true` need explicit reopen) |
| 008 (Configuration) | Admin `lock_window_minutes` editor | Reads `tournament_config.lock_window_minutes`; the predicate's reading of the same key validates the configuration change took effect |

## Versioning policy

- Adding a new optional dimension to the rule (e.g., a future "blackout window" config key that locks all matches during a maintenance window) is **non-breaking** as long as the function still returns `true` when locked and `false` when editable.
- Renaming the function, changing the parameter type, changing the return type, or weakening the fail-closed semantics is **breaking** and requires updating every consumer in the same change set (Principle XI).
- The function is **deliberately not versioned** (no `_v1` / `_v2` suffix) — consumers reference the name directly; version drift would require renaming references everywhere.

## Related contracts

- `submit_prediction(...)` SP — `predictions.write.md` — the write path that calls this predicate.
- `Match.lock_state` field — `predictions.read.md` — the read-side surface of this predicate's output.
