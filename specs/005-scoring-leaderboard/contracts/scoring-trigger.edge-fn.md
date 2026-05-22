# Contract: Scoring Trigger Edge Function

**Feature**: 005-scoring-leaderboard
**Direction**: System → Server (write/orchestration)
**Anchor**: spec FR-007, FR-011, FR-013, FR-015, FR-016; architecture FR-016 (recalculation); §7.2, §7.3

## Capability

A Supabase Edge Function that orchestrates scoring. It is the single entry point for:
1. Live scoring when a match finishes (auto, triggered by `match_results` change).
2. Final scoring when a `tournament_award.*_status` flips to `confirmed`.
3. Admin recalculation (Slice 006) of one match, all finals, or the whole tournament.
4. Config-change recalculation when `tournament_config.match_points.*` / `final_points.each_item` / `tiebreaker.*` change (FR-015).

It is **never** invoked by participant clients.

## Invocation

| Mechanism | When | Auth |
|---|---|---|
| DB trigger on `match_results` INSERT/UPDATE → calls `net.http_post(...)` via `pg_net` (wired by T042) | match finishes | `X-Internal-Auth: <secret>` header read from a Postgres GUC and matched against `SCORE_TRIGGER_SECRET` env in the Edge Function |
| DB trigger on `tournament_award` UPDATE → same `net.http_post(...)` path | any status flips to `'confirmed'` | same `X-Internal-Auth` header |
| (Future) DB trigger on `tournament_config` UPDATE (selected keys only) | rule-shaped config change | same |
| Supabase HTTP invocation from admin UI (Slice 006) — `POST /functions/v1/score-trigger` | admin recalc | `Authorization: Bearer <admin JWT>`; function verifies `is_admin(auth.uid())` |

All four paths land in the same Edge Function and serialize through the same advisory lock (see § Behavior). The auto-invoked paths (DB triggers) are NOT bypassable by participant clients because the `X-Internal-Auth` secret never leaves the server.

## Request (admin path)

`POST /functions/v1/score-trigger` — Authorization: Bearer `<admin JWT>` — JSON body:

```jsonc
{
  "scope": "match" | "finals" | "all",
  "target_id": "<uuid>",        // required when scope = "match", forbidden otherwise
  "reason": "string",            // required; goes to score_calculation_runs.reason
  "run_id": "<uuid>"             // optional; if provided, the call is idempotent
}
```

`Authorization` MUST belong to a participant with the admin role. The function verifies this server-side before doing any work and rejects non-admin callers with 403.

## Behavior

For every invocation, the function:

1. Acquires a Postgres advisory lock on `('scoring', tournament_id)`. If unable to acquire within a small timeout, returns 409 (a scoring run is in flight; the caller may retry).
2. INSERTs a row into `score_calculation_runs` with `status='running'`. Uses the caller-provided `run_id` if supplied; otherwise generates one. If a row with that `run_id` already exists and is `succeeded`, returns 200 with that prior result (idempotent retry).
3. Bumps `tournament_config.current_calculation_version` by 1 within the same transaction.
4. Calls `public.score_match(target_id, run_id)` OR `public.score_finals(run_id)` OR both (`scope='all'`), depending on `scope`.
5. UPDATEs the run row to `status='succeeded'`, sets `completed_at`, `affected_record_count`, `calculation_version_written`.
6. COMMITs. The advisory lock is released by commit.
7. Returns the run summary.

On any failure, step 5 sets `status='failed'` with `notes`; the version bump in step 3 is rolled back; readers continue to see the previous `current_calculation_version`.

## Response

| Field | Type | Notes |
|---|---|---|
| `run_id` | UUID | echoes input or new |
| `scope` | enum | echoes input |
| `target_id` | UUID \| null | |
| `calculation_version_written` | int | the new version readers will see |
| `affected_record_count` | int | inserted+updated `score_records` rows |
| `started_at` | timestamptz | |
| `completed_at` | timestamptz | |
| `notes` | string \| null | e.g. `best_player_pending` |
| `status` | enum | `succeeded` (always — failures return non-2xx status codes) |

## Error responses

| Cause | HTTP | Detail |
|---|---|---|
| Caller is not admin (for admin path) | 403 | |
| Auto path is invoked but the row that triggered it is invalid (e.g., `match.status` is not `finished`) | 422 | logged but does NOT bump version |
| Scoring run already in flight (advisory lock not acquired) | 409 | safe to retry |
| Idempotent retry of a previously-succeeded `run_id` | 200 | returns the prior run summary unchanged |
| SQL function raises | 500 + `notes` | row remains in `failed` state for diagnosis |

## Performance

- A single-match `score_match` for ~500 participants writes ~500 rows; expected duration well under 1 s.
- A full-tournament `scope='all'` rescores ~52,500 rows; expected duration under 60 s (SC-005). The transaction is sized such that lock-contention with participant reads (which use `leaderboard_v` / `personal_breakdown_v`) is bounded because readers see the previous version until COMMIT.

## Constitution alignment

- **Principle II**: callers must authenticate; admin path also checks role.
- **Principle III**: the function's role is *orchestration only* — the rules (10/5/0, 20-each, tie-breakers) live in SQL.
- **Principle V**: every invocation writes to `score_calculation_runs` and `audit_log`.
- **Principle VII**: idempotent on `run_id`; advisory lock prevents races; failures leave readers on a consistent prior state.
- **Principle VIII**: rule values are read from `tournament_config` at run time; no constants in the Edge Function body.

## Test surface

| Test | Lives in | Validates |
|---|---|---|
| Deno test — *Single-match auto-trigger* | `supabase/functions/score-trigger/tests/` | US1 + R-011 |
| Deno test — *Idempotent retry by `run_id`* | same | R-002 + SC-007 |
| Deno test — *Concurrent invocation returns 409* | same | advisory-lock semantics |
| Deno test — *Non-admin POST returns 403* | same | Principle II |
| Deno test — *Failed SQL leaves prior version visible* | same | Principle VII |
| Playwright — *Admin recalc end-to-end* | `apps/web/tests/playwright/` (Slice 006 owns this UI; this slice provides the Edge Function it calls) | FR-007 + SC-005 |
| pgTAP `score_match_idempotent.sql` | `supabase/tests/pgtap/` | SQL function idempotency under same `run_id` |
| pgTAP `score_match_award_table.sql` | same | 10/5/0 truth table |
| pgTAP `score_finals_golden_boot_tie.sql` | same | top-scorer tiebreaker behavior (single official winner only) |
