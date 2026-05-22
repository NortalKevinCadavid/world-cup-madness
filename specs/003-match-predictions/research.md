# Phase 0 Research: Match Predictions with Locking

**Feature**: 003-match-predictions
**Date**: 2026-05-16
**Status**: Complete — no spec-level `[NEEDS CLARIFICATION]` markers remain. All locks and visibility decisions are anchored to trusted server time per Constitution Principle VI; no client clock participates anywhere.

## Scope of this document

Each entry follows `Decision / Rationale / Alternatives considered / Constitution anchor`. Decisions that resolve to a spec FR / SC / BR-LOCK rule are tagged.

This slice depends on **Slice 001** (eligibility predicate, `participants`, `audit_log`, `tournament_config`) and **Slice 002** (`matches.kickoff_utc`, `matches.status`, the catalog-read endpoint). It ships the next cross-slice contract layer: the `predictions` table shape, the **`is_prediction_locked(uuid)` locked predicate** (referenced by Slice 005's peer-pick view), and the `submit_prediction(...)` SECURITY DEFINER SP (referenced by Slice 006's admin manual-entry path and Slice 005's auto-trigger considerations).

---

## R-001 — Lock decision lives in SQL (`is_prediction_locked(uuid)` — locked cross-slice predicate)

**Decision**. Define one PL/pgSQL function `public.is_prediction_locked(p_match_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER`. Returns `true` iff *(a)* `matches.status != 'scheduled'` (BR-LOCK-004: started, finished, postponed, or cancelled matches are locked) OR *(b)* `now() >= matches.kickoff_utc - INTERVAL '<lock_window> minutes'` (BR-LOCK-002 + BR-LOCK-003 strict boundary). The lock-window minutes value is read from `tournament_config.lock_window_minutes` (default 60). Returns `true` (locked) for a non-existent match — fail-closed.

Slice 003's write paths reject when this returns `true`; Slice 005's `peer_pick_v` view filters `WHERE public.is_prediction_locked(m.id)` to expose peer picks **only after lock**. This is the locked cross-slice contract from this slice.

**Rationale**.
- Constitution Principle III (Rules Outside the UI) requires lock enforcement to be invoked identically by every surface (UI, API, peer-pick view, future admin tools). A single named SQL function is the lowest common denominator.
- BR-LOCK-001 mandates trusted server time. `now()` inside the function evaluates against the Postgres clock; no caller-supplied timestamp participates.
- BR-LOCK-003 mandates the strict boundary (`>=`, not `>`). The condition `now() >= kickoff_utc - lock_window` is `true` when remaining time `<= lock_window` — exactly the locked side of the strict boundary.
- BR-LOCK-004 mandates locking on started/cancelled/postponed/finished matches regardless of remaining time. The status check is the first half of the OR.
- `STABLE` (not `IMMUTABLE`) so Postgres can memoize within a query but re-evaluates between transactions — necessary because `matches.status`, `matches.kickoff_utc`, and `tournament_config.lock_window_minutes` can change at runtime.
- `SECURITY INVOKER` — function honors the caller's RLS on `matches` and `tournament_config`. Both have eligible-read policies from Slices 001/002, so an ineligible caller would get a function result of `true` (locked) by virtue of seeing zero matching rows in the underlying SELECT — fail-closed.

**Alternatives considered**.
- *Inline the lock check in every write path and view.* Rejected: duplicates the rule, violates Principle III, makes the FR-012 1-minute config-change window a multi-call-site edit.
- *Compute lock state in TypeScript at the route handler.* Rejected: bypasses the database-clock guarantee (Principle VI), and Slice 005's `peer_pick_v` view can't call into TypeScript.
- *Store an `is_locked` column on `matches` and update via trigger.* Rejected: requires a periodic background update; introduces a staleness window violating SC-005's 1-min config responsiveness; the function approach is always fresh.

**Constitution anchor**. III (Rules Outside the UI), VI (Time-Zone Correctness). Cross-slice locked contract — Slice 005's peer-pick view references this function by name.

---

## R-002 — Append-only predictions table with `superseded_at` chain

**Decision**. Single `public.predictions` table:

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `participant_id` | uuid | NOT NULL, FK → `participants(id)` |
| `match_id` | uuid | NOT NULL, FK → `matches(id)` |
| `predicted_home` | int | NOT NULL, CHECK ≥ 0 |
| `predicted_away` | int | NOT NULL, CHECK ≥ 0 |
| `submitted_at` | timestamptz | NOT NULL, server-default `now()` |
| `source` | enum (`ui`, `api`, `admin_override`) | NOT NULL |
| `superseded_at` | timestamptz | NULL when active |
| `superseded_by` | uuid | NULL; FK → `predictions(id)` when set |
| `created_by` | uuid | NULL allowed; FK → `participants(id)`; differs from `participant_id` only for `source='admin_override'` |

**Unique partial index**: `CREATE UNIQUE INDEX predictions_active_uk ON predictions(participant_id, match_id) WHERE superseded_at IS NULL;` — enforces exactly one active row per `(participant, match)` (FR-002 / SC-003 invariant).

Updates do not modify any prior row beyond setting `superseded_at` + `superseded_by`. Score values, submission timestamps, and source are immutable per row. The history of a participant's predictions for a match is `SELECT * FROM predictions WHERE participant_id = X AND match_id = M ORDER BY submitted_at` (oldest first); the active row is `WHERE superseded_at IS NULL`.

**Rationale**.
- Spec § Key Entities explicitly lists "Match Prediction (active)" AND "Match Prediction Version (history)" as two entities — the append-only-with-supersede shape models both inside one table without an extra history table.
- Spec FR-002 + SC-003: "exactly one active prediction per (participant, match)". The unique partial index is the hard constraint Postgres enforces; SC-003's 1,000-concurrent test passes trivially.
- Spec FR-011 audit ordering: the row trigger captures `previous_value` (the now-superseded row) and `new_value` (the new active row) in the same transaction.
- An `is_active boolean GENERATED` column is unnecessary because the index predicate already filters on `superseded_at IS NULL`.

**Alternatives considered**.
- *Two tables (`predictions_active` + `predictions_history`).* Rejected: doubles the schema surface, makes the supersede transition a two-table operation (DELETE FROM active + INSERT INTO history + INSERT INTO active) instead of an UPDATE + INSERT.
- *In-place UPDATE of the active row + audit_log as the only history.* Rejected: spec § Key Entities calls out "Match Prediction Version (history)" as a first-class entity. Audit log alone makes history queries (e.g., "show me my prediction history for this match") cross-table joins; the in-table chain is faster and clearer.
- *Append-only with a monotonic `version int` column.* Acceptable — equivalent semantically — but `superseded_at` + `superseded_by` is more explicit and useful for the audit narrative ("at what time was version N replaced and by which row?"). Plus the supersede UPDATE doesn't need to know the new version number to set the link.

**Constitution anchor**. V (Auditability via append-only structure), VII (single hard constraint replaces lossy app-tier coordination).

---

## R-003 — `submit_prediction(...)` SECURITY DEFINER SP (locked cross-slice signature)

**Decision**. All writes to `predictions` flow through one PL/pgSQL function:

```sql
CREATE FUNCTION public.submit_prediction(
  p_participant_id uuid,
  p_match_id       uuid,
  p_home           int,
  p_away           int,
  p_source         text                  -- 'ui' | 'api' | 'admin_override'
) RETURNS uuid                            -- the newly-inserted predictions.id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

Body steps:

1. `PERFORM pg_advisory_xact_lock(hashtext(p_participant_id::text || ':' || p_match_id::text));` — per-(participant, match) lock so concurrent submissions serialize at the row level without blocking unrelated submissions.
2. Validate `p_source` is in the allowed enum; validate scores are non-negative integers within `tournament_config.score_upper_bound` (default 20).
3. Check `public.is_prediction_locked(p_match_id) = false`. If `true`: write `audit_log` row `action='prediction.rejected_locked'` with `reason='lock_window_passed'` or `'match_status_locked'` (distinguished by the BR-LOCK-004 vs BR-LOCK-002/003 branches); RAISE EXCEPTION with a stable error code so the route handler returns 409.
4. Verify the participant is eligible: `IF NOT public.is_eligible_nortal_participant((SELECT auth_user_id FROM participants WHERE id = p_participant_id)) THEN RAISE; END IF;` — defense in depth; the route handler will have already checked via `requireEligible`, but the SP is also callable from Slice 006 admin paths.
5. Look up existing active prediction: `SELECT id INTO v_existing FROM predictions WHERE participant_id = p_participant_id AND match_id = p_match_id AND superseded_at IS NULL FOR UPDATE;` — `FOR UPDATE` holds the row lock until commit.
6. INSERT new row with the submitted scores, `superseded_at = NULL`, `source = p_source`. Capture `v_new_id`.
7. If `v_existing IS NOT NULL`: `UPDATE predictions SET superseded_at = now(), superseded_by = v_new_id WHERE id = v_existing;` — atomic with the INSERT in the same transaction.
8. Return `v_new_id`. The audit trigger on `predictions` (R-009) emits `prediction.created` / `prediction.updated` / `prediction.superseded` rows automatically.

**Rationale**.
- Centralizing writes in one SP means every surface (Slice 003 route handler, Slice 006 admin manual entry, Slice 002 sync if it ever needs to admin-correct, future bulk-import tools) goes through the same validation + lock check + audit emission. Principle III.
- Advisory lock per (participant, match) means concurrent submissions for the same pair serialize, but concurrent submissions for different participants or different matches run in parallel. Maximally lossless concurrency.
- `SECURITY DEFINER` lets the SP write to `predictions` regardless of caller's RLS — necessary because the participant client's user-JWT RLS allows only SELECT, not INSERT/UPDATE. The function gates correctness; RLS gates direct access.
- The locked signature `(uuid, uuid, int, int, text) RETURNS uuid` is a **cross-slice contract**. Slice 006's admin manual-entry RPC will call `submit_prediction(..., source='admin_override')` to record an admin-driven prediction. Changes to the signature require coordinated regression updates across Slices 003 + 006.

**Alternatives considered**.
- *Route-handler-only validation, no SP.* Rejected: bypasses Principle III if another surface ever writes predictions; admin manual-entry would re-implement the validation.
- *Trigger-only enforcement* (e.g., a `BEFORE INSERT` trigger that rejects locked-match inserts). Rejected: trigger raises EXCEPTION at INSERT time, but the route handler still needs to format the error response and write the rejection audit; the SP body does both atomically.
- *No advisory lock, rely on `UNIQUE` index alone.* Rejected: under serializable isolation the index would still serialize, but the failure path on conflict requires the loser to either retry (with `RETRY` loop in the SP) or fail with a confusing UNIQUE violation. The advisory lock makes the loser block-then-proceed correctly.

**Constitution anchor**. II (server-side enforcement), III (rules in SQL), V (audit emission in same transaction), VII (idempotent serialization), VIII (score bound from config). Locked cross-slice contract.

---

## R-004 — Concurrency model under 1,000 simultaneous submissions

**Decision**. Three layers, defense-in-depth:

1. **Postgres advisory lock per (participant, match)** (R-003). Serializes within the dimension of contention.
2. **Unique partial index** `WHERE superseded_at IS NULL` (R-002). The hard constraint — Postgres rejects a second active row at the storage layer, regardless of any application bug.
3. **Serializable isolation** for the route handler's transaction (Supabase default is READ COMMITTED — the SP's `FOR UPDATE` + advisory lock provide the serialization guarantee without needing to bump the isolation level globally).

Under 1,000 concurrent submissions for the same `(participant, match)` (SC-003):
- All 1,000 connections enter the SP simultaneously.
- The advisory lock serializes them.
- Each takes the lock, runs the lock-state check + insert + supersede chain, commits, releases the lock.
- The total wall time is bounded by the per-transaction latency (~few ms) × 1,000 — slow for the simulated test but functionally correct.
- At the end: exactly one row has `superseded_at IS NULL` (the last one to commit); the other 999 are in the superseded chain with consistent `superseded_by` links.

**Rationale**.
- SC-003's "exactly one active prediction at end" invariant is non-negotiable. The unique partial index makes it impossible to violate at the storage layer.
- SC-006's "zero prediction records lost across 10,000 cycles" invariant follows from the append-only design: nothing is ever DELETEd, only chained.

**Alternatives considered**.
- *Single-row UPDATE with optimistic concurrency token.* Rejected: introduces a "your prediction was overwritten by another tab" UX path that's confusing in a participant context.
- *Queue submissions and process serially via a single worker.* Rejected: introduces latency between submission and confirmation (worse than SC-004's 30-second budget), adds queue infrastructure.

**Constitution anchor**. VII (Operational Resilience). Supports **SC-003, SC-006, FR-009**.

---

## R-005 — Trusted server time only (Postgres `now()`)

**Decision**. Every lock decision reads `now()` from inside a Postgres function, view, or query. No path consumes a client-supplied timestamp. The Next.js route handler does NOT include any timestamp in its request body or query string for lock-related decisions — the body is `{ match_id, home, away }` only.

The catalog-read endpoint (`/api/matches`) extension that returns `lock_state` per row computes it via `public.is_prediction_locked(m.id)` evaluated at query time — `now()` is the database's wall clock at SELECT execution.

For UI display of "minutes until lock," the page reads `matches.kickoff_utc` (an ISO-8601 UTC string from the API) and computes `(kickoff_utc - lock_window) - clientNow()` in JavaScript for **display only**. The display is informational; the API's `lock_state` field is the authoritative gate.

**Rationale**.
- BR-LOCK-001 mandates trusted server time. Postgres `now()` returns the database server's wall clock at transaction start; that's the canonical reference.
- BR-LOCK-006 mandates UTC normalization. `matches.kickoff_utc` is `timestamptz` stored in UTC by Slice 002.
- Across multiple Vercel function instances or admin tools, the *database* clock is the shared reference — even if individual app servers drift, lock decisions converge.
- Spec FR-007 + Acceptance Scenario US3.4 explicitly require this. SC-001's boundary tests at -lock:00, -lock:01, +0:01 only function correctly with database-clock authority.

**Alternatives considered**.
- *Application server's `Date.now()` in the route handler.* Rejected: each instance has its own clock; minor NTP drift can flip a 1-second boundary decision. BR-LOCK-001 forbids.
- *Client-supplied `submitted_at` for ordering.* Rejected: trivially manipulated to bypass lock; spec Edge Case "client clock manipulation" forbids.

**Constitution anchor**. VI (NON-NEGOTIABLE). Supports **FR-007, BR-LOCK-001, SC-001**.

---

## R-006 — Score validation and upper-bound enforcement

**Decision**. Three enforcement layers:

1. **Table CHECK constraints**: `predicted_home >= 0`, `predicted_away >= 0`. These catch any direct INSERT (admin paths, future tools).
2. **SP-body validation**: `submit_prediction` reads `tournament_config.score_upper_bound` (default `20`); raises EXCEPTION if `p_home > upper_bound` OR `p_away > upper_bound`. Centralizes the rule.
3. **Route-handler validation**: the Next.js POST `/api/predictions` parses the body with a Zod (or equivalent) schema enforcing `predicted_home: z.number().int().min(0).max(20)` so invalid inputs get a 400 response with field-specific error messages before the SP is called. Belt + braces against malformed input.

The `tournament_config.score_upper_bound` key is seeded by **this slice** (the SP and route handler both read it; one place to seed). Default value chosen to comfortably cover plausible football outcomes (highest competitive international scoreline in modern history is ~14 goals — 20 is a generous safety margin).

**Rationale**.
- Spec FR-008 explicitly: "validate score values as non-negative integers within the configured upper bound; invalid values MUST be rejected before any persistence side-effect."
- Configurable upper bound supports future non-football tournaments (basketball, etc.) without code change (Principle VIII).
- Belt + braces guards against the participant client somehow stripping its own client-side validation (e.g., a hostile browser extension); the SP body is the hard gate.

**Alternatives considered**.
- *Hard-coded `MAX_SCORE = 20`.* Rejected: violates Principle VIII; future tournaments needing higher bounds (basketball-style pools) would require a deploy.
- *No upper bound at all.* Rejected: surface area for abuse / accidental denial-of-service via huge integer payloads.

**Constitution anchor**. VIII, II (validation server-side). Supports **FR-008**.

---

## R-007 — BR-LOCK-004 handling (started / postponed / finished / cancelled match)

**Decision**. `is_prediction_locked(p_match_id)` returns `true` when `matches.status IN ('in_progress', 'finished', 'postponed', 'cancelled')` regardless of remaining time. The submit path's denial reason for these branches is `reason='match_status_locked'`, distinct from `reason='lock_window_passed'` for the BR-LOCK-002/003 path. The audit row's `reason` field carries the distinction.

For the spec Edge Case "scheduled match is cancelled or postponed indefinitely → existing predictions MUST be preserved for audit but MUST NOT be scored": this slice does NOT modify or supersede existing predictions on status change. Predictions for cancelled matches simply remain in their last-active state forever; Slice 005's scoring engine reads `matches.status` and skips scoring for non-finished statuses.

**Rationale**.
- BR-LOCK-004 explicitly: "No prediction can be created or modified after the match has started, even if an incorrect kickoff time was displayed."
- Distinguishing reason codes lets the UI render a clearer error message ("This match is already underway — predictions are closed" vs. "Predictions for this match locked 60 minutes ago").
- Spec § Edge Case "cancelled or postponed" — preservation is implicit in append-only design; no special-case logic needed.

**Alternatives considered**.
- *Auto-supersede predictions for cancelled matches.* Rejected: prediction history must remain truthful (FR-011); cancelling a match shouldn't rewrite participants' submitted intent.

**Constitution anchor**. III, V. Supports **FR-005, BR-LOCK-004**, spec Edge Cases "started match", "cancelled/postponed".

---

## R-008 — Kickoff-correction-crossed-lock audit (FR-013 / BR-LOCK-004 coordination with Slice 002)

**Decision**. Slice 002's sync coordinator already quarantines `kickoff_change_after_lock` conflicts (Slice 002 research R-005). For changes that *do* apply (e.g., kickoff moved earlier so a match that wasn't locked is now locked, OR moved later so a match that was locked is now unlocked), this slice emits an audit_log row `action='prediction.kickoff_correction_crossed_lock'` for every active `predictions` row on the affected match.

The trigger that emits this:
1. Lives on `matches` (`AFTER UPDATE WHEN OLD.kickoff_utc IS DISTINCT FROM NEW.kickoff_utc`).
2. Identifies whether the kickoff change crossed a lock boundary: `was_locked := (OLD.kickoff_utc - lock_window) <= now() OLD;`. If `was_locked != is_now_locked`, emit one audit_log row per affected active prediction.
3. The audit row's `entity_type='match'`, `entity_id=match_id`, `previous_value={kickoff_utc: OLD}`, `new_value={kickoff_utc: NEW}`, `reason='kickoff_correction_crossed_lock'`.

The predictions themselves are NOT modified — Slice 006 admin policy decides whether to manually reopen via a separate admin action.

**Rationale**.
- Spec FR-013: "MUST emit an audit event identifying participants affected when the correction crosses a lock boundary."
- Spec Edge Case "kickoff corrected after lock": "the system MUST emit an audit event ... administrators may need to manually reopen or close predictions according to policy."
- Slice 005's scoring engine will read this audit row when computing post-tournament dispute history.

**Alternatives considered**.
- *Auto-reopen predictions if a kickoff change un-locks them.* Rejected: requires admin policy decision (per spec); this slice records the boundary crossing, Slice 006 decides.
- *Emit only one audit row per match (not per affected prediction).* Acceptable for compactness, but per-participant rows are easier to query for dispute resolution.

**Constitution anchor**. V, VI. Supports **FR-013, BR-LOCK-004**.

---

## R-009 — Audit pattern (`prediction.*` actions)

**Decision**. `AFTER INSERT OR UPDATE ON predictions` trigger emits one `audit_log` row per change with the actions:

| Trigger event | Action label | previous_value | new_value | reason |
|---|---|---|---|---|
| INSERT with `superseded_at IS NULL` (new active prediction) | `prediction.created` | NULL | the new row | NULL |
| UPDATE setting `superseded_at` (supersession) | `prediction.superseded` | the OLD row | the NEW row | NULL |

The route handler additionally emits — outside the trigger, in the same transaction — `prediction.rejected_locked` rows when `submit_prediction()` raises the lock-rejected exception. The SP catches the exception, writes the audit row, then re-raises (handler turns it into 409). Reason field on rejection rows: `'lock_window_passed'` (BR-LOCK-002/003) or `'match_status_locked'` (BR-LOCK-004) or `'invalid_score'` (FR-008) or `'invalid_match'` (US1 AS3) or `'ineligible'` (defense-in-depth).

Recursion guard: same `pg_trigger_depth() = 1` check as Slice 001's participant trigger.

**Rationale**.
- Spec FR-011: "every prediction create, update, and rejected attempt to the audit trail."
- Centralizing action labels matches the cross-slice audit shape (Slice 001 emits `participant.*`, Slice 002 emits `match.*`, this slice emits `prediction.*`, Slice 005 emits `score_record.*`).
- The trigger fires on the data change; the SP-body audit on rejected attempts handles the case where no data change occurred — both write to `audit_log` in the same transaction (Principle V).

**Alternatives considered**.
- *Write `prediction.created` and `prediction.updated` (instead of `prediction.superseded`).* Rejected: ambiguous — was a prediction *updated* (mutated in place) or *superseded* (new row)? `superseded` is the truer description and matches the data model.

**Constitution anchor**. V (NON-NEGOTIABLE).

---

## R-010 — RLS posture on `predictions`

**Decision**. Two policies:

1. `predictions_self_read` (SELECT): `USING (participant_id IN (SELECT id FROM participants WHERE auth_user_id = auth.uid()))` — caller sees only their own rows.
2. `predictions_admin_read` (SELECT): `USING (public.is_admin(auth.uid()))` — Slice 006 admin read.

No INSERT/UPDATE/DELETE policies. All writes go through `submit_prediction()` (SECURITY DEFINER) — the route handler invokes it with the user JWT; the SP runs as the function-definer role and bypasses RLS to write. The route handler's `requireEligible()` check ensures the caller is the right participant before invoking the SP.

Slice 005's `peer_pick_v` view: needs to read `predictions` rows for *other* participants (the peer-pick feature). The view uses `SECURITY INVOKER` but bakes in the `is_prediction_locked(match_id)` filter. Slice 005 owns the policy on the view; this slice's RLS on `predictions` continues to be self-only — Slice 005 reads via the view's `SECURITY DEFINER` semantics (a function-level grant to the view's owner role) rather than relaxing this slice's policy.

**Rationale**.
- Spec FR-011 + Principle II — participants must not be able to read each other's predictions before lock (privacy + competition integrity).
- Spec FR-016 (Slice 005's territory) — post-lock, peers can see each other's picks via Slice 005's view. The view is the *only* path to other participants' predictions; this slice's RLS is unforgiving.

**Alternatives considered**.
- *Open `predictions_peer_read` policy at the table level with a `WHERE is_prediction_locked(...)` predicate.* Rejected: Slice 005's view is the right surface; baking the filter at the view level keeps this slice's RLS simple and lets Slice 005 control its own access pattern.

**Constitution anchor**. II (NON-NEGOTIABLE).

---

## R-011 — Submit endpoint shape (`POST /api/predictions`)

**Decision**. The Next.js route handler at `apps/web/app/api/predictions/route.ts`:

| Aspect | Value |
|---|---|
| Method | `POST` |
| Auth | Supabase session cookie + `requireEligible(client)` (Slice 001) |
| Body | `{ match_id: uuid, home: int, away: int }` |
| Validation | Zod schema (or equivalent); reject invalid → 400 BEFORE eligibility check (timing-leakage avoidance) |
| Server action | After validation + auth: invoke `client.rpc('submit_prediction', { p_participant_id: <self>, p_match_id, p_home, p_away, p_source: 'ui' })` (user-JWT-bound client; SP runs as definer) |
| Success | 200 with `{ prediction: { id, predicted_home, predicted_away, submitted_at, source } }` |
| Errors | 400 (bad body) / 401 (no session) / 403 (not eligible) / 404 (match not found) / 409 (locked or invalid match status) / 422 (score out of range) |

The route is the **only** participant-facing write path. There is no PUT/PATCH — submits and updates both go through POST (the SP detects the existing-active case and chains supersession).

For direct-API attackers: the route enforces eligibility via `requireEligible`, and the SP additionally calls `is_eligible_nortal_participant` on the participant — defense in depth.

**Rationale**.
- Single endpoint simplifies the cross-slice consumer surface (Slice 003's UI, Slice 006's admin tooling). One contract to lock.
- Distinct status codes per failure class let the UI render clear error messages (FR-006: UI and API agree).
- The "source=`ui`" tag in the SP call distinguishes from Slice 006's eventual `source=admin_override`.

**Alternatives considered**.
- *Separate POST `/api/predictions` (create) + PUT `/api/predictions/<id>` (update).* Rejected: the participant doesn't know the prediction ID; "create vs update" is a server-side detail.
- *PUT `/api/predictions/<match_id>` with the match ID in the URL.* Acceptable REST style; chose POST + body because submit/update conceptually create a new version (append-only model).

**Constitution anchor**. III (one server-side enforcement path).

---

## R-012 — `/api/matches` extension: additive `lock_state` field

**Decision**. Slice 002's `Match` response type adds one new optional field: `lock_state: 'editable' | 'locked'`. The catalog route handler computes this via `public.is_prediction_locked(m.id)` in the SELECT — exact same data path as the write-time check.

The `Match` TypeScript type in `apps/web/lib/types/match.ts` is extended (Slice 002 contract `match-catalog.read.md` § Cross-slice contract: "Adding a field is permitted"). Existing Slice 002 consumers ignore the new field; Slice 003's `/matches` page reads it to render the inline-edit affordance.

**Rationale**.
- Spec FR-010 + US4: participants see per-match lock state on the catalog view.
- Computing in the SELECT means a single query returns matches + lock state without an extra round trip per row.
- Additive change preserves Slice 002's contract.

**Alternatives considered**.
- *Separate endpoint `GET /api/predictions/<match_id>/lock-state`.* Acceptable but produces N extra round trips for the matches page; the additive field is cheaper.
- *Compute lock state client-side from `kickoff_utc`.* Rejected: client clock differs from server clock; FR-010 + BR-LOCK-001 forbid.

**Constitution anchor**. III (server-authoritative), VI. Supports **FR-010, US4**.

---

## R-013 — Personal-predictions read (`GET /api/me/predictions`)

**Decision**. New Next.js route handler `apps/web/app/api/me/predictions/route.ts`:

| Aspect | Value |
|---|---|
| Method | `GET` |
| Auth | session cookie + `requireEligible(client)` |
| Query params | `?match_id=<uuid>` (optional — single-match lookup) |
| Server action | `SELECT id, match_id, predicted_home, predicted_away, submitted_at, source FROM predictions WHERE participant_id = <self> AND superseded_at IS NULL [AND match_id = ?]` (RLS-bound) |
| Response | `{ predictions: [...] }` |

The route returns ONLY the active predictions per (participant, match). To retrieve history, Slice 005's personal-breakdown endpoint surfaces a richer view (matched and audit-attributed); this slice's endpoint is the participant's immediate operational view.

**Rationale**.
- The participant page (extended `/matches` from Slice 002) needs to render the participant's current prediction inline with each match row. This endpoint is the data source.
- Limiting to active rows (superseded_at IS NULL) keeps the response small and aligned with the typical UI use case.
- `?match_id=` filter supports a single-match inline-edit dialog if the UI needs one.

**Alternatives considered**.
- *Hydrate predictions inline in `/api/matches`.* Considered; rejected because predictions are per-participant and matches are public — embedding would make matches caching per-participant.
- *No endpoint; SSR fetch directly from server component.* Acceptable for the SSR path, but a client-side fetch is useful for after-submit refresh without a full reload. Ship the endpoint.

**Constitution anchor**. II (RLS-bound), III.

---

## R-014 — UI extension to `/matches` page (Clarifications-aligned UI scope)

**Decision**. Slice 002's `/matches` participant page is **extended** by this slice:

- Each match row, when `lock_state === 'editable'`, renders an inline form: two number inputs (home / away) + a "Submit" button. The form is a client component that posts to `/api/predictions` and updates local state on success.
- Each match row, regardless of lock state, shows the participant's active prediction (from `getMyPredictions()` SSR fetch) — e.g., "Your pick: 2-1".
- Each match row shows a countdown to lock when editable: `formatRemainingUntilLock(kickoff_utc, lock_window_minutes, clientNow)` — for display only.
- Locked rows show "Locked" with the participant's submitted prediction (if any).

A separate `/me/predictions` page is **not** created in this slice — the `/matches` page is the participant's primary surface. (Slice 005's personal-breakdown surface adds a `/me/breakdown` page later.)

**Rationale**.
- Constitution Principle X — vertical slice ships UI + API + data + tests.
- Spec US4 (per-match lock state display) and US1/US2 (submit/edit) both live on the same surface — natural to bundle.
- Reuses Slice 002's locale-aware kickoff display via `formatKickoff()` from `apps/web/lib/catalog/format.ts`.

**Alternatives considered**.
- *Dedicated `/predictions` page separate from `/matches`.* Rejected: forces the participant to navigate between two pages for the same workflow.
- *Modal dialog for prediction entry, opened from `/matches`.* Acceptable but adds an interaction step; inline form is faster.

**Constitution anchor**. X.

---

## R-015 — Out of scope (intentionally deferred)

- **Final tournament predictions** (champion, runner-up, top scorer, best player): Slice 004. This slice handles per-match scores only.
- **Admin manual prediction entry** (e.g., admin submits on behalf of a participant after dispute resolution): Slice 006 — will call `submit_prediction(..., source='admin_override')`.
- **Prediction history surface** for participants (UI page showing their full submission history per match): Slice 005's `/me/breakdown` page surfaces the relevant data.
- **Bulk import** (e.g., importing predictions from a previous tournament for analytics): out of scope; would be a future ETL slice if needed.
- **Real-time prediction count display** ("47 predictions submitted for this match"): out of scope; if added later, would be a Slice 005 leaderboard-adjacent surface.

**Rationale**. Constitution Principle X — vertical slice ships one capability. Stretching this slice to include admin tools, final predictions, or analytics would over-couple it.

**Constitution anchor**. X. Tracked deferrals: Slice 004 (final predictions), Slice 005 (history surface), Slice 006 (admin manual entry).

---

## Summary

All implementation-pattern unknowns are resolved. The slice can proceed to Phase 1 (data-model.md + contracts/ + quickstart.md). The constitution check in `plan.md` references these decisions by ID.

### Cross-slice contracts locked here

| Contract | Producer task | Consumers |
|---|---|---|
| `predictions` table shape | Slice 003 (this slice's migration) | Slice 005 (`score_match` reads scores; `peer_pick_v` reads picks) |
| `public.is_prediction_locked(uuid) RETURNS boolean STABLE` | Slice 003 | Slice 005 (`peer_pick_v` filter), Slice 006 (admin's "is this still editable?" checks) |
| `public.submit_prediction(uuid, uuid, int, int, text) RETURNS uuid` SP | Slice 003 | Slice 006 (admin manual entry calls with `source='admin_override'`) |
| `audit_log` actions `prediction.*` | Slice 003 | Slice 007 (audit reads) |
| `Match.lock_state` field on `/api/matches` | Slice 003 (additive over Slice 002) | Slice 003's own `/matches` UI; future admin tooling |
