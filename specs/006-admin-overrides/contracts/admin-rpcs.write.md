# Contract: Admin RPC Family

**Slice**: 006-admin-overrides
**Date**: 2026-05-17
**Status**: Phase 1 (Plan).

Seven SECURITY DEFINER RPC functions that wrap underlying slice-owned SPs with admin-role check + reason/source validation + audit emission. Each RPC is the SINGLE admin-write path for its target — the participant client never calls the underlying SPs with `source='admin_*'` directly.

**Locked cross-slice contracts**: function signatures + ERRCODE values WAR01–WAR06 + audit action labels.

## Shared concerns

### Pre-flight steps (every RPC runs these in order)

1. `IF NOT public.is_admin(auth.uid()) THEN
     write audit_log row action='admin.access_denied', reason='not_admin', source='admin_rpc';
     RAISE EXCEPTION USING ERRCODE='WAR01', MESSAGE='admin role required';
   END IF;`
2. `IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE ERRCODE='WAR02'; END IF;`
3. `IF p_source_citation IS NULL OR length(trim(p_source_citation)) = 0 THEN RAISE ERRCODE='WAR03'; END IF;` (only for override RPCs; recalc + role grant skip)
4. Resolve `v_admin_participant_id := (SELECT id FROM public.participants WHERE auth_user_id = auth.uid())`.
5. Acquire `pg_advisory_xact_lock(hashtext('admin_' || p_target_kind || ':' || p_target_id::text))` to serialize concurrent admin actions on the same target. Skip for `admin_trigger_recalc` (Slice 005's scoring lock covers).

### ERRCODE values (locked)

| Code | Meaning | HTTP mapping |
|---|---|---|
| `WAR01` | admin role required | 403 |
| `WAR02` | reason missing or empty | 400 |
| `WAR03` | source citation missing or empty | 400 |
| `WAR04` | target not found | 404 |
| `WAR05` | invariant violation propagated from underlying SP | mapped per underlying SP's ERRCODE |
| `WAR06` | concurrent admin action (advisory lock contention or Slice 005 scoring lock) | 409 |

### Audit emission pattern

After successful delegation to the underlying SP, every admin RPC writes one `audit_log` row with:
- `actor = v_admin_participant_id`
- `action = '<per-RPC, see family table>'`
- `entity_type = '<target table>'`
- `entity_id = <target row id>`
- `previous_value` = the OLD state (jsonb)
- `new_value` = the NEW state (jsonb)
- `reason = p_reason`
- `source_citation = p_source_citation` (the new column added by this slice)
- `source = 'admin_rpc'`
- `occurred_at = now()`

## The seven RPCs

### `admin_record_match_result(...)` — US1 (manual score correction)

```sql
CREATE OR REPLACE FUNCTION public.admin_record_match_result(
  p_match_id              uuid,
  p_home_score_official   int,
  p_away_score_official   int,
  p_home_score_for_scoring int,
  p_away_score_for_scoring int,
  p_result_status         text,                 -- 'regulation' | 'extra_time' | 'penalties_shootout'
  p_reason                text,
  p_source_citation       text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

**Behavior**:
1. Pre-flight (WAR01/02/03).
2. Capture `v_old_result := (SELECT row_to_json(t) FROM match_results t WHERE match_id = p_match_id)` (may be NULL).
3. Acquire advisory lock per match.
4. Delegate to Slice 002's `record_match_result(p_match_id, p_home_score_official, p_away_score_official, p_home_score_for_scoring, p_away_score_for_scoring, p_result_status, 'admin_correction', v_admin_participant_id)`. The underlying SP enforces the `home_score_for_scoring <= home_score_official` invariant.
5. On underlying SP exception: propagate (map to WAR05 with the original ERRCODE preserved in MESSAGE).
6. Emit audit row `action='admin.match_result_corrected'`, `previous_value=v_old_result`, `new_value=<new match_results row jsonb>`.
7. Note: Slice 005's `match_results_recorded` LISTEN channel fires automatically; `score-trigger` will recompute affected scoring. No explicit recalc trigger needed — auto path covers it.

**Returns**: `match_id` of the affected row.

**Constitution anchor**. II, III, V.

---

### `admin_update_match(...)` — match status / kickoff correction

```sql
CREATE OR REPLACE FUNCTION public.admin_update_match(
  p_match_id          uuid,
  p_new_status        text,                     -- nullable; only update if non-null
  p_new_kickoff_utc   timestamptz,              -- nullable; only update if non-null
  p_reason            text,
  p_source_citation   text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

**Behavior**:
1. Pre-flight (WAR01/02/03).
2. Validate at least one of `p_new_status` / `p_new_kickoff_utc` is non-null — else WAR05 with reason `no_change_proposed`.
3. Validate `p_new_status` is a valid `matches.status` enum value if non-null.
4. Capture `v_old_match := (SELECT row_to_json(t) FROM matches t WHERE id = p_match_id)`. If NULL → WAR04.
5. Acquire advisory lock per match.
6. `UPDATE matches SET status = COALESCE(p_new_status, status), kickoff_utc = COALESCE(p_new_kickoff_utc, kickoff_utc) WHERE id = p_match_id`. Slice 002's audit trigger AND Slice 003's kickoff-correction fan-out trigger AND Slice 004's first-kickoff-correction trigger all fire automatically.
7. Emit audit row `action='admin.match_updated'`.

**Constitution anchor**. III, V, VI.

---

### `admin_submit_prediction(...)` — admin submits prediction on behalf of participant

```sql
CREATE OR REPLACE FUNCTION public.admin_submit_prediction(
  p_participant_id    uuid,
  p_match_id          uuid,
  p_home              int,
  p_away              int,
  p_reason            text,
  p_source_citation   text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

**Behavior**:
1. Pre-flight (WAR01/02/03).
2. Delegate to Slice 003's `submit_prediction(p_participant_id, p_match_id, p_home, p_away, 'admin_override')`.
3. Slice 003's SP enforces score-upper-bound + lock check; the lock check may pass even if normally locked because admin can override (per spec — admin overrides BR-LOCK-003).

   **Important**: spec Edge Case "Override applied to a match whose status is 'cancelled'" mentions admin overrides are allowed even on locked matches. The Slice 003 SP currently REJECTS locked matches. **Resolution**: this slice adds a per-call bypass flag to `submit_prediction` via an additional parameter, OR creates a sibling SP `admin_submit_prediction_bypass_lock`. To preserve Slice 003's locked contract (signature is locked), Option 2: this slice defines `admin_submit_prediction_bypass_lock(...)` as a sibling SP. Admin RPC chooses which to call based on lock state.

   **Decision**: the admin RPC body checks `is_prediction_locked(p_match_id)`. If locked → call `admin_submit_prediction_bypass_lock`. If unlocked → call Slice 003's `submit_prediction(..., source='admin_override')`. The bypass-lock variant performs the same INSERT + supersede logic but skips the lock check.

4. On underlying SP exception: propagate (WAR05).
5. Emit audit row `action='admin.prediction_submitted'`, `reason=p_reason`, `source_citation=p_source_citation`. Distinguish bypass-lock variant via `audit_log.previous_value` jsonb field `lock_bypass: true`.

**Returns**: `predictions.id`.

**Cross-slice notes**:
- Slice 003's `submit_prediction` signature is unchanged.
- This slice owns `admin_submit_prediction_bypass_lock` (a sibling, NOT a replacement). Slice 003's contract remains locked.

**Constitution anchor**. II, III, V.

---

### `admin_submit_final_prediction(...)` — admin submits final prediction on behalf of participant

```sql
CREATE OR REPLACE FUNCTION public.admin_submit_final_prediction(
  p_participant_id     uuid,
  p_item_kind          text,
  p_target_team_id     uuid,
  p_target_player_id   uuid,
  p_reason             text,
  p_source_citation    text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

**Behavior**:
1. Pre-flight (WAR01/02/03).
2. Lock-bypass split as above: if `is_final_prediction_locked() = true` → call `admin_submit_final_prediction_bypass_lock`. Else → `submit_final_prediction(..., source='admin_override')` (Slice 004's locked SP).
3. Emit audit row `action='admin.final_prediction_submitted'`.

**Returns**: `final_predictions.id`.

**Constitution anchor**. II, III, V.

---

### `admin_update_tournament_award(...)` — US3 (final award correction)

```sql
CREATE OR REPLACE FUNCTION public.admin_update_tournament_award(
  p_item_kind         text,                     -- 'champion' | 'runner_up' | 'top_scorer' | 'best_player'
  p_new_team_id       uuid,                     -- non-NULL for champion/runner_up
  p_new_player_id     uuid,                     -- non-NULL for top_scorer/best_player
  p_new_status        text,                     -- 'pending' | 'confirmed'
  p_reason            text,
  p_source_citation   text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

**Behavior**:
1. Pre-flight.
2. Validate kind/target shape (team kinds → team_id; player kinds → player_id).
3. Capture `v_old_award := (SELECT row_to_json(t) FROM tournament_award t)`.
4. `UPDATE tournament_award SET <p_item_kind>_team_or_player_id = p_new_*, <p_item_kind>_status = p_new_status, set_at = now(), set_by = v_admin_participant_id`. Slice 005's `award_confirmed_trigger` (or equivalent) fires the `score-trigger` Edge Function with `scope='finals'`.
5. Emit audit row `action='admin.award_updated'`, capturing OLD + NEW award row.

**Constitution anchor**. III, V.

---

### `admin_resolve_match_pending_review(...)` — Slice 002 quarantine resolution

```sql
CREATE OR REPLACE FUNCTION public.admin_resolve_match_pending_review(
  p_review_id         uuid,
  p_resolution        text,                     -- 'accept_provider' | 'reject_provider' | 'manual_override'
  p_reason            text,
  p_source_citation   text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

**Behavior**:
1. Pre-flight.
2. Validate `p_resolution` is in the enum.
3. Capture `v_review := (SELECT row_to_json(t) FROM match_pending_review t WHERE id = p_review_id)`. NULL → WAR04.
4. Depending on `p_resolution`:
   - `accept_provider`: apply the quarantined `provider_observation` jsonb values to the matches table via `admin_update_match` (same transaction).
   - `reject_provider`: do not modify matches table.
   - `manual_override`: do nothing (admin supplied their own values via a separate `admin_update_match` call beforehand).
5. UPDATE `match_pending_review SET reviewed_at = now(), reviewer = v_admin_participant_id, resolution = p_resolution, resolution_notes = p_reason`.
6. Emit audit row `action='admin.pending_review_resolved'`, capturing OLD + NEW review row + resolution.

**Constitution anchor**. III, V. Cross-slice: Slice 002's `match_pending_review` table; this slice's resolution path.

---

### `admin_trigger_recalc(...)` — US2 (manual recalc)

```sql
CREATE OR REPLACE FUNCTION public.admin_trigger_recalc(
  p_scope             text,                     -- 'all' | 'match' | 'finals'
  p_target_id         uuid,                     -- non-NULL for scope='match'
  p_reason            text,
  p_source_citation   text                      -- may be NULL for non-override-driven recalcs
) RETURNS uuid                                  -- the run_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
```

**Behavior**:
1. Pre-flight (`source_citation` is OPTIONAL for recalc; admin can trigger without a citation if the reason is e.g. "scheduled recalc after config change").
2. Validate `p_scope` in `('all', 'match', 'finals')`. For `match` scope, `p_target_id` MUST be non-NULL.
3. Generate `v_run_id := gen_random_uuid()`.
4. INSERT into `score_calculation_runs (id, scope, target_id, trigger, triggered_by, started_at, status, triggering_audit_log_id)` with `trigger='admin_recalc'`, `status='running'`, `triggering_audit_log_id = <the audit row's id, captured before this INSERT>`.
5. Emit audit row `action='admin.recalc_triggered'`, `entity_type='score_calculation_run'`, `entity_id=v_run_id`. **Note**: the audit row must be written FIRST so `score_calculation_runs.triggering_audit_log_id` can reference it; use deferred constraints or two-step INSERT.
6. POST to Slice 005's `score-trigger` Edge Function via `pg_net.http_post`:
   ```jsonc
   { "scope": p_scope, "target_id": p_target_id, "trigger": "admin_recalc", "run_id": v_run_id, "reason": p_reason, "triggered_by": v_admin_participant_id }
   ```
7. On Slice 005's 409 response (advisory lock contention) → WAR06.
8. Return `v_run_id`.

The Edge Function handles the rest asynchronously. Admin UI subscribes to `score_calculation_runs` via Supabase Realtime to watch progress.

**Constitution anchor**. III, V, VII.

---

## HTTP route handlers (for completeness)

Each admin RPC is invoked by a Next.js route handler under `/api/admin/*`. The route handlers:
- Parse Supabase session cookie → 401 if absent.
- `await requireAdmin(client)` — calls `is_admin` RPC; on denial 403 (with audit row).
- Zod-validate body.
- `client.rpc('<admin_rpc_name>', { ...args })`.
- Map ERRCODE → HTTP status per the table above.
- Return appropriate response shape.

Detailed route shapes per RPC are documented in `admin-ui.surface.md`.

## Test surface

Per-RPC pgTAP tests:

| File | Test |
|---|---|
| `admin_record_match_result_happy.sql` | Happy path: admin records match result; assert audit row + record + Slice 005 LISTEN fires |
| `admin_record_match_result_not_admin.sql` | Non-admin calls → WAR01 |
| `admin_record_match_result_missing_reason.sql` | reason='' → WAR02 |
| `admin_record_match_result_missing_source.sql` | source_citation='' → WAR03 |
| `admin_record_match_result_invariant_propagates.sql` | for_scoring > official → WAR05 (propagated from Slice 002 ERRCODE) |
| `admin_update_match_happy.sql` | Update status; assert Slice 002 audit + Slice 003 fan-out trigger fire |
| `admin_update_match_kickoff_fans_out.sql` | Update kickoff; assert Slice 004 first-kickoff-correction trigger fires for any active final_predictions |
| `admin_submit_prediction_bypass_locked.sql` | Locked match; admin submits → 200; predictions row inserted with `source='admin_override'`, audit `lock_bypass: true` |
| `admin_submit_prediction_unlocked.sql` | Unlocked match; admin submits → 200; goes through Slice 003's regular SP path |
| `admin_submit_final_prediction_bypass_locked.sql` | After first_kickoff_utc; admin submits → 200; bypass-lock path |
| `admin_update_tournament_award_happy.sql` | Update award; assert Slice 005 auto-trigger fires for scope='finals' |
| `admin_resolve_match_pending_review_accept_provider.sql` | Resolution applies provider observation to matches |
| `admin_resolve_match_pending_review_reject_provider.sql` | Resolution leaves matches unchanged |
| `admin_resolve_match_pending_review_manual_override.sql` | Resolution leaves matches unchanged (admin called admin_update_match separately) |
| `admin_trigger_recalc_scope_all.sql` | Returns run_id; INSERT into score_calculation_runs; pg_net POST captured |
| `admin_trigger_recalc_concurrent.sql` | Two concurrent triggers — second gets WAR06 |
| `admin_trigger_recalc_audit_links_run.sql` | Audit row's id matches `score_calculation_runs.triggering_audit_log_id` |

Plus Playwright route-handler tests (one happy + one auth-rejection per RPC, ~14 tests).

## Cross-slice contract summary

| Surface | Locked? |
|---|---|
| 7 RPC function signatures | **Locked** |
| ERRCODE values WAR01–WAR06 | **Locked** |
| Audit action labels `admin.*` | **Locked label set** |
| `admin_submit_prediction_bypass_lock` + `admin_submit_final_prediction_bypass_lock` sibling SPs | **Locked** — Slice 003/004 SPs themselves unchanged |
| Reason + source_citation required-non-empty contract | **Locked per FR-002** |
| Pre-flight ordering (admin → reason → source → lock → delegate) | **Locked** |
