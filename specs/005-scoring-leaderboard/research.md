# Phase 0 Research: Scoring & Leaderboard

**Feature**: 005-scoring-leaderboard
**Date**: 2026-05-15
**Status**: Complete — no spec-level NEEDS CLARIFICATION markers remain (all five blocking ODs were closed during `/speckit-clarify` on 2026-05-15; see `spec.md` Clarifications). This document instead resolves the implementation-pattern unknowns introduced by the Supabase/Next.js stack so that Phase 1 (data-model.md + contracts/) can proceed deterministically.

## Scope of this document

Each entry below is a discrete decision the team made while designing this slice. Each entry follows the template `Decision / Rationale / Alternatives considered / Constitution anchor`. Decisions that resolve directly to a constitution principle or spec FR are tagged.

---

## R-001 — Where scoring math lives

**Decision**. Scoring math (10/5/0 for match predictions, 20 each for the four final items) is implemented as two PL/pgSQL functions in Supabase Postgres: `public.score_match(match_id uuid, run_id uuid)` and `public.score_finals(run_id uuid)`. Both are invoked by an Edge Function (or by an admin RPC via Slice 006); they MUST NOT be invoked from the participant client.

**Rationale**.
- Constitution Principle III ("Rules Outside the UI") requires the rule layer to be invoked identically by UI, API, and background jobs. A SQL function is the lowest common denominator: every consumer goes through the same code.
- Postgres is transactional — points and their `audit_log` rows are inserted in the same transaction (Principle V).
- The slice's reads (`leaderboard_v`, `personal_breakdown_v`) are pure SELECTs over the rows these functions produce; readers and writers can coexist without locking.

**Alternatives considered**.
- *Edge Function-only scoring (TypeScript)*. Rejected: it would re-implement the rules in the runtime, leaking math into the integration layer. Audit-log writes would also need a separate transaction (Principle V violation risk).
- *Materialized view + nightly refresh*. Rejected: refresh latency cannot meet SC-005 (≤ 60 s after correction).
- *Client-side aggregation on `/leaderboard` page*. Rejected outright — direct violation of Principles II and III; can be bypassed by anyone with a browser.

**Constitution anchor**. III (Rules Outside the UI), V (Auditability), VII (Operational Resilience).

---

## R-002 — Idempotent and order-independent scoring

**Decision**. `score_match(match_id, run_id)` performs:
1. `INSERT INTO score_calculation_runs(...) RETURNING id` (the caller passes the same `run_id` on retry).
2. `DELETE FROM score_records WHERE target_kind='match' AND target_id=match_id AND calculation_version = current_version`.
3. `INSERT INTO score_records (participant_id, target_kind, target_id, predicted, official, points, reason_code, calculation_version, calculated_at, source, run_id) SELECT ...` joining `participants × predictions × match_results` for the given match.
4. The `AFTER INSERT/UPDATE` trigger on `score_records` writes one `audit_log` row per change.

Retries with the same `run_id` are no-ops (an upsert on `score_calculation_runs.id` is a `INSERT ... ON CONFLICT DO NOTHING`); retries with a different `run_id` increment `calculation_version` and overwrite the rows — the prior records remain in `audit_log` and `score_calculation_runs`.

**Rationale**.
- SC-007 demands that applying the same scoring run twice produces the same final state with no double-counting.
- Out-of-order match-finish events (a later match scored before an earlier one) MUST NOT corrupt the leaderboard — each `score_match` call is scoped to one match and is commutative with other matches' calls (each match writes a disjoint slice of `score_records`).
- A failed Edge Function invocation can be retried by the scheduler without manual cleanup.

**Alternatives considered**.
- *Upsert per (participant, match)*. Equivalent semantically but requires composite primary key plumbing and complicates the audit trigger. The delete-then-insert pattern keeps the trigger simple and the audit log unambiguous (one row per change, with `previous_value` populated from the deleted row).
- *Insert-only with `is_active` flag*. Rejected: leaderboard reads would need an extra WHERE filter on every query, with no operational benefit since `calculation_version` already gives us history.

**Constitution anchor**. V (Auditability), VII (Operational Resilience). Supports **SC-006, SC-007**.

---

## R-003 — `calculation_version`: how readers see a consistent snapshot

**Decision**. A single row in `tournament_config` (`current_calculation_version int`) is the read pointer. `leaderboard_v` and `personal_breakdown_v` filter `WHERE calculation_version = current_calculation_version`. A scoring run writes new rows under `current_version + 1`, then in the *same* transaction bumps `current_calculation_version`. Readers always see one self-consistent version.

**Rationale**.
- FR-012 ("consistent ordering per calculation version, no partial-update flicker") and SC-008 (1,000 concurrent reads during update window with no inconsistent partial-update visibility) both require a flip-the-pointer pattern.
- Postgres's MVCC means readers in flight before the transaction commit will see the old pointer + old rows; readers after commit see the new pointer + new rows. No reader can ever observe a half-applied update.

**Alternatives considered**.
- *Per-participant version number*. Rejected: leaderboard cross-participant ordering would need MAX(version) across rows, which is not constant-time.
- *Supabase Realtime as the source of consistency*. Rejected: Realtime is a notification mechanism, not a consistency primitive. We use it ONLY to push "leaderboard updated" hints to the client (US3 freshness), with the SQL view as authority.
- *Snapshot table per version*. Rejected: storage cost for 100+ versions is acceptable in `score_records` but explicitly snapshotting `LeaderboardSnapshot` rows (as §9.1 suggests) is unnecessary complexity for ~500 participants; a view is fast enough.

**Constitution anchor**. VII (Operational Resilience). Supports **SC-008**.

---

## R-004 — Tie-breaker implementation in SQL

**Decision**. `leaderboard_v` uses a single `ORDER BY` clause with the §7.4 tie-breaker priority:

```sql
ORDER BY total_points DESC,
         exact_count DESC,
         outcome_count DESC,
         final_points DESC,
         -- tier 5 (earliest last-valid-prediction timestamp) is excluded by default;
         -- enable only if tournament_config.tier5_enabled = true (FR-005, §7.4 note)
         CASE WHEN cfg.tier5_enabled THEN last_valid_prediction_at END ASC NULLS LAST
```

Rank is computed with `RANK() OVER (ORDER BY ...)` so that participants who remain tied after all configured tiers share the same rank (§7.4 tier 6 + Acceptance Scenario 5 / "1, 2, 2, 4" pattern).

Tier 5's optional inclusion comes from `tournament_config.tier5_enabled` (default `false` per §7.4 "only if approved"). Slice 008 can flip it without code change.

**Rationale**.
- SQL window functions give us deterministic ordering in O(N log N) without app-tier work; this hits SC-003 (1,000 concurrent reads, deterministic across reads) trivially.
- Configuration-driven tier 5 satisfies FR-005 (reconfigurable) and Principle VIII.
- `RANK()` (not `DENSE_RANK()`) produces the conventional "1, 2, 2, 4" pattern — Scenario 5. If the team later wants dense ranking ("1, 2, 2, 3"), it becomes a Slice 008 config flag; the function is swappable in one line.

**Alternatives considered**.
- *App-tier sort in TypeScript*. Rejected — Principle III; also costlier under 1,000 concurrent reads.
- *Materialized view + REFRESH MATERIALIZED VIEW*. Rejected — refresh latency conflicts with SC-005, and `leaderboard_v` is already sub-second for ~500 rows.
- *`DENSE_RANK()`*. Considered; deferred to Slice 008 config — current §7.4 phrasing ("shared rank" with no comment on next-rank treatment) reads more naturally as standard `RANK()`.

**Constitution anchor**. III, VIII. Supports **SC-001, SC-003**.

---

## R-005 — Counting exact-score and correct-outcome hits

**Decision**. `score_records.reason_code` is one of `'exact' | 'outcome' | 'incorrect' | 'none' | 'final_correct' | 'final_incorrect'`. `leaderboard_v` derives:
- `exact_count = SUM(CASE WHEN reason_code='exact' THEN 1 ELSE 0 END)`
- `outcome_count = SUM(CASE WHEN reason_code='outcome' THEN 1 ELSE 0 END)`
- `final_points = SUM(CASE WHEN target_kind='final' THEN points ELSE 0 END)`

— all grouped by participant, restricted to `calculation_version = current_calculation_version`.

**Rationale**. Tie-breakers in §7.4 require *counts* of exact and outcome hits, not just totals. Storing the reason code per row is the cheapest representation and makes the personal breakdown row labels (Scenario US4.1: "reason code per match") fall out for free. It also makes the audit trail (Acceptance Scenario US1.5) directly inspectable — auditors see the reason at the row level.

**Alternatives considered**.
- *Two separate point fields (`exact_points`, `outcome_points`)*. Rejected — denormalized and confusing; same information is derivable from `points + reason_code`.
- *Computing reason at read time from `predicted` + `official` columns*. Rejected — adds work to every read and obscures the audit trail; the reason should be persisted alongside the awarded points.

**Constitution anchor**. V (Auditability).

---

## R-006 — Knockout score basis (OD-002 implementation surface)

**Decision**. `match_results` (owned by Slice 002) MUST expose the official-score-for-scoring fields directly: `home_score_for_scoring` and `away_score_for_scoring`. These are populated by Slice 002 using the rule resolved in OD-002 — *regular time + extra time, excluding penalty shootouts* — and are the ONLY columns this slice reads. Penalty-shootout-only fields (if any are stored) MUST NOT influence scoring.

`tournament_config.knockout_score_basis` is the configurable knob (default `'reg_plus_extra'`, only other allowed value reserved for future: `'reg_plus_extra_plus_pens'`). Slice 002 owns honoring this value when it computes the for-scoring columns.

**Rationale**. Keeping the "which numbers to score against" decision in the *data-producer* (Slice 002) rather than the *score consumer* (this slice) means we never need to embed knockout-format logic in `score_match()`. The scoring function reads two integers and compares them — that's it. The rule remains configurable per FR-008 / Principle VIII.

**Alternatives considered**.
- *`score_match` reads multiple score fields and chooses based on `match.stage` and config*. Rejected — couples the scoring function to the knockout format, harder to test, harder to swap providers.

**Constitution anchor**. III, IV (Provider Abstraction), VIII. Resolves spec **FR-008**.

---

## R-007 — Top-scorer ties / Golden Boot tiebreaker (OD-004 implementation surface)

**Decision**. The Golden Boot tiebreaker (most goals → fewest minutes played → most assists) is **out of scope** for this scoring slice. The `tournament_award.top_scorer_player_id` column is a single FK to `players`, populated by an authorized administrator (Slice 006) or by a Slice 002 sync that consumes the official FIFA Golden Boot announcement. `score_finals` simply compares `final_predictions.top_scorer_player_id` to `tournament_award.top_scorer_player_id`.

The audit trail for *who* the top scorer is — including any tiebreaker chain — lives in `audit_log` rows owned by the surface that decided (admin or sync), not in this slice.

**Rationale**.
- Pushing tiebreaker reasoning to the producer (admin or sync) keeps the scoring function trivially testable and idempotent.
- FR-009 ("recognizing exactly one official top scorer per tournament") combined with the resolved OD-004 means the system records a single canonical answer; participants who picked that player get 20 points, everyone else gets 0. No multi-player ambiguity is ever stored in `tournament_award`.

**Alternatives considered**.
- *Store all tied top scorers in `tournament_award.top_scorers (array)` and award if any match*. Rejected — directly contradicts the spec's Clarifications resolution (only the officially-named Golden Boot winner counts).

**Constitution anchor**. III, V, VIII. Resolves spec **FR-009**.

---

## R-008 — Best player source / Golden Ball delay (OD-005 implementation surface + edge case)

**Decision**. `tournament_award.best_player_player_id` and `tournament_award.best_player_status` (`'pending' | 'confirmed'`) cover both the steady-state and the "FIFA Golden Ball is delayed" edge case in `spec.md`. `score_finals` skips the best-player item when `best_player_status='pending'` (no rows written for that item) and emits a `'best_player_pending'` reason code in `score_calculation_runs.notes`. When the admin flips the status to `confirmed`, a new scoring run scores the best-player item under the new `calculation_version`.

The personal breakdown UI surfaces "best-player scoring pending" rather than implying 0 points (Acceptance Scenario US4.2 edge).

**Rationale**. Operational Resilience (Principle VII) — the system must not guess and must surface the pending state explicitly per the spec's Edge Cases.

**Alternatives considered**.
- *Insert `score_records` rows with `points=0` while pending*. Rejected — those would look like incorrect picks in `personal_breakdown_v` and would award 0 to participants who actually picked correctly until the admin re-scored. Confusing and audit-noisy.

**Constitution anchor**. V, VII. Resolves spec **FR-010**.

---

## R-009 — Leaderboard visibility (OD-006 implementation surface)

**Decision**. `leaderboard_v` exposes `participant_id, display_name, total_points, exact_count, outcome_count, final_points, rank, calculation_version`. RLS on `leaderboard_v` requires the requester to pass Slice 001's `is_eligible_nortal_participant(auth.uid())` check. The visibility policy is read from `tournament_config.leaderboard_visibility` (`'full_names' | 'anonymized' | 'team_scoped'`); default is `'full_names'` per the OD-006 resolution.

When `leaderboard_visibility='anonymized'`, the view returns `display_name = 'Participant ' || dense_rank_position`. When `'team_scoped'`, an additional RLS predicate scopes to participants sharing a (yet-to-be-defined) team attribute. Both alternative modes are documented but inactive until Slice 008 enables them.

**Rationale**. Spec FR-014 explicitly requires the policy to remain configurable in Slice 008 even though the default is `'full_names'`. Putting the switch in the view means no app code changes when policy flips.

**Alternatives considered**.
- *Hard-code `display_name` exposure*. Rejected — directly contradicts FR-014's "MUST remain a configurable value".

**Constitution anchor**. II, VIII. Resolves spec **FR-014**.

---

## R-010 — Peer-pick visibility at the database boundary (FR-016)

**Decision**. A new view `public.peer_pick_v` joins `predictions` and `matches` and exposes one row per (viewer_eligible, owner_participant, match_id) only when the match's lock has passed:

```sql
WHERE now() >= matches.kickoff_utc - (tournament_config.lock_window_minutes || ' minutes')::interval
```

RLS on `peer_pick_v` requires the viewer to be eligible. The `/api/peer-pick/[match_id]` Next.js route is a thin server-component wrapper that calls this view via the user's JWT — no service_role bypass. Direct API requests get the same answer because the gate is in the database (Principle III, SC-009).

Self-breakdowns continue to read `predictions` directly under the existing Slice 003 RLS policy ("participant can always read their own predictions").

**Rationale**.
- Acceptance Scenario for the lock-boundary edge case requires strict equality with BR-LOCK-003 ("greater than or equal at the boundary = locked"). The `>=` in the WHERE clause delivers that exactly.
- Putting the gate in a view (not in app code) makes the rule un-bypassable by anyone who hits Supabase REST directly.

**Alternatives considered**.
- *App-tier filter*. Rejected — directly violates Principle III; also fails SC-009 ("100% rejected at the server boundary").
- *Edge Function intermediary*. Considered for response-shape control; rejected because it adds latency and another auth check the database can do natively.

**Constitution anchor**. II, III, V, VI. Resolves spec **FR-016** and supports **SC-009**.

---

## R-011 — Trigger that runs scoring on match finish

**Decision**. A Supabase Edge Function `score-trigger` is invoked when:
1. `match_results` receives an INSERT or UPDATE where `match.status='finished'` AND `home_score_for_scoring IS NOT NULL` (DB trigger calls `pg_notify`; an Edge Function listens via Supabase Realtime / a webhook bridge).
2. `tournament_award` receives an UPDATE where any of `champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id` change AND `best_player_status='confirmed'` (or the relevant subset is now confirmed).
3. An admin (Slice 006) explicitly invokes `score-trigger` with `{ scope: 'match'|'finals'|'all', target_id?, reason }`.

The Edge Function bumps `current_calculation_version` and calls `score_match(...)` or `score_finals(...)` accordingly. Concurrency is governed by an advisory lock on `('scoring', tournament_id)` so two triggers cannot race.

**Rationale**.
- Bounded latency (FR-011: leaderboard updates within 1 minute) — the trigger fires within seconds of the row change; the SQL function runs in well under a minute even for a full re-score (SC-005).
- Admin recalculation (Slice 006) and live scoring use the same Edge Function entry point, so the behavior is identical (Principle III).
- Advisory lock prevents the "out-of-order arrivals" edge case from causing double-scored runs.

**Alternatives considered**.
- *Postgres trigger directly calls scoring function*. Considered. Rejected because Supabase recommends business orchestration in Edge Functions for visibility and retry semantics; also a long-running trigger blocks the writer of `match_results`.
- *Cron job polling for finished matches*. Rejected — wastes capacity and introduces unnecessary latency; doesn't help with admin-driven recalc.

**Constitution anchor**. III, VII. Supports **FR-011, FR-013 (Slice 005), FR-016 (architecture)**.

---

## R-012 — Audit trail integration (Slice 007 dependency)

**Decision**. Slice 007 owns `audit_log` (table + RLS + retention). This slice writes to it via:
- `AFTER INSERT/UPDATE/DELETE ON score_records` trigger emitting one row per change, with `actor = score_calculation_runs.triggered_by` (the admin user id if admin-initiated, or a system identity if auto).
- `AFTER INSERT/UPDATE ON score_calculation_runs` trigger emitting one row per run (started + completed).

If Slice 007 has not yet shipped when this slice starts, the migrations in this slice MUST stub the `audit_log` table contract (insert-only, columns: `actor, action, entity_type, entity_id, previous_value, new_value, reason, occurred_at`); Slice 007 will harden retention, search, and tamper-resistance later. Backfilling between the two slices is not required because no audit rows are deleted.

**Rationale**. Principle V mandates audit-in-the-same-transaction. Triggers achieve that. Coordinating with Slice 007 is necessary so we don't duplicate the table.

**Alternatives considered**.
- *App-tier audit writes in the Edge Function*. Rejected — separate transactions; one can succeed while the other fails (Principle V violation).

**Constitution anchor**. V. Coordinates with **Slice 007**.

---

## R-013 — Test framework selection (mandated by Principle IX)

**Decision**.
- **E2E**: Playwright (TypeScript) — explicitly named in Constitution Principle IX.
- **Postgres unit tests**: pgTAP — standard for Postgres, supports red-first writing, and lets us test RLS, triggers, and functions directly in SQL where the rules live.
- **Edge Function tests**: Deno's built-in test runner (since Supabase Edge Functions run on Deno). Each scenario boots a temporary Supabase project (via the supabase CLI) and asserts end-to-end.

Scenarios are committed FIRST and MUST be red before any production SQL or TS code lands.

**Rationale**. Constitution Principle IX mandates Playwright for E2E and BDD form throughout. pgTAP is the only widely-used Postgres test framework that fits a TDD red-green-refactor loop. Deno's test runner is the path of least resistance for Edge Functions because the Supabase CLI ships with it.

**Alternatives considered**.
- *Cypress instead of Playwright*. Rejected — constitution names Playwright explicitly.
- *Jest for everything*. Rejected — Jest can't test SQL rules or RLS policies natively; we'd have to mock the DB and lose the rule-layer test coverage that Principle III requires.

**Constitution anchor**. IX (NON-NEGOTIABLE). Supports **all SCs by virtue of being the test surface**.

---

## R-014 — Configuration coupling with Slice 008 (not-yet-shipped)

**Decision**. Migration `0058_score_config_defaults.sql` seeds the following into `tournament_config` with default values matching the architecture document, in case Slice 008 has not yet shipped when this slice lands:

| Key | Default | FR / §-anchor |
|---|---|---|
| `match_points.exact` | `10` | §7.2, FR-015 |
| `match_points.outcome` | `5` | §7.2, FR-015 |
| `match_points.incorrect` | `0` | §7.2, FR-015 |
| `final_points.each_item` | `20` | §7.3, FR-015 |
| `tiebreaker.order` | `['total','exact_count','outcome_count','final_points']` | §7.4, FR-004 |
| `tiebreaker.tier5_enabled` | `false` | §7.4, FR-005 |
| `knockout_score_basis` | `'reg_plus_extra'` | OD-002, FR-008 |
| `top_scorer_source` | `'fifa_golden_boot'` | OD-004, FR-009 |
| `best_player_source` | `'fifa_golden_ball'` | OD-005, FR-010 |
| `leaderboard_visibility` | `'full_names'` | OD-006, FR-014 |
| `lock_window_minutes` | `60` | BR-LOCK-002 |

When Slice 008 ships, it will own the admin UI and migration history for these keys; the seed migration in this slice will be a no-op then.

**Rationale**. Principle VIII forbids hard-coding rule values. Defaults must exist somewhere so the system runs end-to-end before Slice 008. Putting them in a migration with a forward path to Slice 008 keeps the dependency one-way.

**Alternatives considered**.
- *Hard-code defaults in SQL function bodies*. Rejected — constitutional violation (Principle VIII).
- *Wait for Slice 008 before starting this slice*. Rejected — both slices have independent value; Principle X (Vertical Slice Delivery) says ship slices completely, not block on horizontal infra.

**Constitution anchor**. VIII, X.

---

## Summary: open items deferred (NOT blockers)

| Item | Owner | When |
|---|---|---|
| Slice 007 hardening of `audit_log` (retention policy, tamper-resistance, search index) | Slice 007 | After this slice lands; this slice writes the audit rows in a contract-compatible shape. |
| Slice 008 admin UI for `tournament_config` values | Slice 008 | After this slice lands; defaults from R-014 ensure the system functions in the meantime. |
| Slice 006 admin "recalculate" UI on top of the `score-trigger` Edge Function | Slice 006 | After this slice lands; the Edge Function exposes `{ scope, target_id?, reason }` already. |
| `docs/architecture/open-decisions.md` status flip for OD-002, OD-003, OD-004, OD-005, OD-006 | Doc maintainer | One-line edit per OD; tracked in `checklists/requirements.md` follow-up bullet. |

All open spec-level questions for THIS slice are resolved; Phase 1 can begin.
