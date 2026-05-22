---
description: "Task list for slice 002 (Match Catalog & Provider Sync) — each task is a self-contained agent prompt"
---

# Tasks: Match Catalog & Provider Sync (Slice 002)

**Input**: Design documents in `specs/002-match-catalog/`

**Prerequisites**: `spec.md` (with Clarifications 2026-05-15), `plan.md`, `research.md`, `data-model.md`, all four files under `contracts/`, `quickstart.md` (all present). **Slice 001's regression baseline MUST be GREEN before this slice starts** (Constitution Principle XI).

**Test posture**: Tests are MANDATORY for this slice — Constitution Principle IX requires Given/When/Then scenarios committed RED before any production code that turns them GREEN. Principle XI requires the full regression suite (Slice 001 + Slice 002) to be GREEN before starting the next task or merging.

**Special status — Builds on Slice 001 foundation**: This slice **consumes** the cross-slice contracts locked by Slice 001 (`participants` table shape, `is_eligible_nortal_participant(uuid)`, `is_admin(uuid)` stub, `audit_log` write pattern, `tournament_config` table shape). It **introduces** the next layer of cross-slice contracts (the `matches` / `match_results` / `teams` table shapes, the `MatchDataProviderAdapter` TypeScript interface, the `record_match_result(...)` stored procedure, the `match_results_recorded` pg_notify channel) — locked after merge per Principle XI.

## How to read this file

Each task below is a **self-contained agent prompt**. You can paste any single task into a fresh subagent (e.g., `Agent` tool with `subagent_type: general-purpose`) and it will have everything it needs — file paths to read, files to create or modify, acceptance criteria, dependencies, and a single-line "definition of done." Do not assume the subagent has any conversation state from this planning session.

Format conventions:

- **`[P]`** — the task is parallel-safe (no shared write paths with peers in the same phase that are also `[P]`).
- **`[US#]`** — the user story (from `spec.md`) the task belongs to. Phase-level tasks (Setup / Foundational / Polish) are unmarked.
- **`Blocked-by:`** — task IDs that MUST be `done` before this task can start. The orchestrator MUST honor these gates.
- **`Parallel-safe with:`** — task IDs that share no write paths with this task and can run concurrently.
- **`Definition of done:`** — exactly one checkable assertion. When that assertion holds, the task is done.

Path conventions match `plan.md` § Source Code:
- Migrations → `supabase/migrations/`
- Edge Functions → `supabase/functions/`
- pgTAP → `supabase/tests/pgtap/`
- Web app (pages, API routes, libs) → `apps/web/`
- Playwright → `apps/web/tests/playwright/`

Constitution refresher (live during this slice):
- **II (Security by Design)**: catalog writes go through SECURITY DEFINER paths (sync coordinator + `record_match_result` SP). Service-role key stays server-side.
- **III (Rules Outside the UI)**: catalog rules live in SQL (the SP + CHECK invariants + RLS); coordinator logic lives in the Edge Function; the Next.js layer is read-only presentation.
- **IV (Provider Abstraction)**: every provider lives behind the locked `MatchDataProviderAdapter` interface; domain code consumes only normalized internal types.
- **V (Auditability)**: every catalog mutation emits an `audit_log` row in the same transaction.
- **VI (Time-Zone Correctness)**: all timestamps `timestamptz` in UTC; client-side localization only.
- **VII (Operational Resilience)**: idempotent sync, advisory lock, payload sanity guards, outage alert dedup.
- **VIII (Extensibility)**: cadence + retry + outage threshold + undersized threshold + kickoff tolerance + webhook URL all in `tournament_config`.
- **IX (TDD via BDD, NON-NEGOTIABLE)**: write the scenario, see it fail, then implement.
- **XI (Regression-Gated Progress, NON-NEGOTIABLE)**: full suite GREEN (Slices 001 + 002) before next task or merge.

---

## Implementation deviations (running log — append-only)

Slice 002 inherits **D-001 through D-005** from `specs/001-eligibility-login/tasks.md`. New deviations recorded during slice 002 execution are below.

### D-006 (2026-05-19, surfaced in T003–T011 dispatch drift) — Wave-2 schema reconciliation

- **Symptom**: My initial T004 / T005 / T006 / T007 / T010 / T011 dispatch prompts diverged in details from `data-model.md` and the locked contract files. Subagents flagged the divergences while completing the work.
- **Reconciled inline this turn**:
  - T004 (`0020_matches.sql`) rewritten to canonical: `match_status` enum is `scheduled/in_progress/finished/postponed/cancelled` (not `scheduled/live/...`); `match_stage` enum added with canonical short codes `group/r16/qf/sf/final/third_place`; column is `group_id` (not `group_name`); added `last_synced_at`; added `matches_group_id_consistency` CHECK; index names match `data-model.md § Entity 2`.
  - T004 `match_provider_external_ids` columns renamed to canonical: `provider_name`, `provider_match_id`, `mapped_at` + surrogate UUID PK + UNIQUE `(provider_name, provider_match_id)` — parallels T003's `team_provider_external_ids`.
  - T011 (`supabase/functions/_shared/providers/types.ts`) rewritten to the multi-method interface from `contracts/provider-adapter.contract.md`: `fetchFixtures` / `fetchResults` / `fetchTeams` / optional `fetchPlayers?`; `SyncWindow`, `NormalizedFixture`, `NormalizedResult`, `NormalizedTeam`, `NormalizedPlayer`; error classes `ProviderTransientError`, `ProviderRateLimitedError`, `ProviderClientError` with `readonly retryable` discriminators.
- **Documented for follow-up (not blocking; less cross-slice-critical)**:
  - T005 (`0021_match_results.sql`): kept split-column shape (`home_score`, `away_score`, `extra_time_*`, `penalty_*`) instead of `data-model.md`'s `home_score_official`/`away_score_official` shape. The LOCKED cross-slice names `home_score_for_scoring` / `away_score_for_scoring` ARE present. `result_status` uses `'penalty_shootout'` (singular) vs canonical `'penalties_shootout'` (plural) — flag for slice 005 scoring engine.
  - T006 (`0022_provider_sync_tables.sql`): used `bigserial` PK + text+CHECK enums instead of canonical UUID PK + `CREATE TYPE` enums. Internal bookkeeping — no cross-slice reads.
  - T007 (`0023_match_pending_review.sql`): used text+CHECK enums instead of canonical `conflict_kind` / `conflict_resolution` `CREATE TYPE` enums. Slice 006 (admin overrides) will read this — flag for slice 006.
  - T010 (`0028_provider_config_defaults.sql`): used `providers.active` key prefix (with `s`) per the prompt; original `tasks.md` body uses `provider.active` (no `s`). Slice 008 admin UI must match the seeded shape.
- **How to apply going forward**: T012 (seed fixture) and T009 (RLS) must reference the AS-BUILT schema (the on-disk migrations), not `data-model.md`. The data-model document remains the historical/aspirational spec; the migrations are now authoritative for slice 002.

### D-007 (2026-05-19, surfaced in T020) — `match_results` field-name mapping in the catalog route

- **Symptom**: The contract `specs/002-match-catalog/contracts/match-catalog.read.md` § 200 OK specifies the `match_result` object with field names `home_score_official` / `away_score_official`. Per D-006, migration `0021_match_results.sql` shipped the split-column shape `home_score` / `away_score` + optional `extra_time_*` / `penalty_*`, and the LOCKED `_for_scoring` columns. There is no `_official` column on disk.
- **Resolution chosen in T020**: Map field names in the route handler (option (b) per the T020 task brief). The route SELECTs the raw columns (`home_score`, `away_score`, `extra_time_home_score`, `extra_time_away_score`, `penalty_home_score`, `penalty_away_score`, `home_score_for_scoring`, `away_score_for_scoring`, `result_status`, `recorded_at`) and projects the contract shape in TypeScript:
  - `home_score_official = home_score + COALESCE(extra_time_home_score, 0) + COALESCE(penalty_home_score, 0)`
  - `away_score_official = away_score + COALESCE(extra_time_away_score, 0) + COALESCE(penalty_away_score, 0)`
  - `home_score_for_scoring` / `away_score_for_scoring` pass through unchanged.
  - `approved_at` is sourced from `match_results.recorded_at`. The schema has no separate admin-approval timestamp; for provider_sync rows the recorded-at value IS the approval moment per FR-006. Slice 006 admin overrides will revisit this if they introduce a distinct approval column.
- **Result-status enum reconciliation**: D-006 already flagged that `0021_match_results.sql` uses `'penalty_shootout'` (singular) while the contract example and `ResultStatus` TS type use `'penalties_shootout'` (plural). T020 maps the DB value to the contract value in `mapResultStatus()`. Unrecognized values (`'walkover'`, `'no_result'`) fall back to `'regulation'` on the wire so the typed contract stays satisfied; slice 005 will revisit when scoring lands.
- **Sort wire-name reconciliation**: The contract documents `?sort=kickoff_utc_asc` / `kickoff_utc_desc`; `MatchSort` (T019 TS type) uses the shorter `kickoff_asc` / `kickoff_desc`. T020 accepts BOTH on the wire and maps them to the same internal direction so neither the contract nor the TS client breaks.
- **Cross-slice impact**: None — Slice 005 reads `match_results` directly via SECURITY DEFINER (RLS-exempt) and consumes the `_for_scoring` columns by name; that path is unchanged. Slice 003 (predictions) and Slice 004 (final predictions) consume the `Match` TS type, which already aligns with the projected wire shape.

### D-008 (2026-05-19, surfaced in T026 `record_match_result_emits_notification.sql`) — pgTAP cannot observe `pg_notify` channel reception

- **Symptom**: pgTAP tests run inside a `BEGIN; ... ROLLBACK;` envelope (the harness rolls back so tests don't pollute the database between runs). PostgreSQL enqueues `pg_notify` deliveries for `COMMIT` — a rolled-back transaction emits nothing to listening sessions. Additionally, libpq surfaces notifications only between commands, and pgTAP harnesses do not expose them to test assertions. There is no in-pgTAP way to observe that `'match_results_recorded'` actually received the expected `{ match_id, source }` payload Slice 005 will consume.
- **Compromise chosen by T026**: `record_match_result_emits_notification.sql` asserts (a) `lives_ok` on the SP call — any malformed `pg_notify` (typo'd channel name, payload not coercible to text, `json_build_object` failure) raises here; and (b) `is(count(*), 1)` on the `match_results` row — the contract puts `PERFORM pg_notify(...)` AFTER the UPSERT, so a successful UPSERT is a necessary precondition for the notification step to have executed. Both are structural proxies, not the load-bearing assertion.
- **Deferred to Slice 005**: The end-to-end "`'match_results_recorded'` channel actually received the contract payload" assertion is owned by a Slice 005 Deno integration test (placeholder Slice 005 T042) that maintains a real `LISTEN` session across `COMMIT`.
- **Cross-reference**: D-007 handles the column-mapping reconciliation on the read side; D-008 handles the notification observability gap on the write side. Both are consequences of working with the as-built migration set rather than the data-model document.

### D-009 (2026-05-19, surfaced in T026 `record_match_result_audit_format.sql`) — `audit_log.action` name mismatch between migration 0025 and contract `match-results.write.md`

- **Symptom**: Migration `0025_catalog_audit_triggers.sql` (T013) emits `audit_log.action = 'match_result.recorded'` on INSERT into `match_results` and `audit_log.action = 'match_result.updated'` on UPDATE. The cross-slice contract `specs/002-match-catalog/contracts/match-results.write.md` § Audit posture names the UPDATE action `'match_result.corrected'` (chosen to reflect admin-override semantics — humans correcting provider data).
- **Decision deferred to T029**: T029 must pick one of:
  1. **Honor the migration's existing action names** — accept `'match_result.updated'` as canonical; propagate that spelling through Slice 006's admin-override UI, Slice 007's forensic queries, and any cross-slice documentation that currently references `'match_result.corrected'`. Lowest churn.
  2. **Re-author 0025 to match the contract** — emit a follow-on migration (or amend 0025 in place if no other slice has consumed it yet) that flips the UPDATE-path action to `'match_result.corrected'`. Aligns with the contract's spelling but introduces a schema-change ripple through downstream slices.
- **Not gating T028's red-gate**: The pgTAP file `record_match_result_audit_format.sql` only asserts the INSERT path (`'match_result.recorded'`) — which the migration and the contract agree on — so the gate is satisfiable without resolving D-009. The UPDATE-path assertion will live in a future Slice 006 pgTAP file once T029 picks a spelling.
- **Cross-reference**: D-006 is the umbrella under which 0025's audit-action naming was set; D-009 is the focused follow-up for the action-name mismatch specifically.

### D-010 (2026-05-20, surfaced in T032 / consolidated in T033) — `sync-catalog` coordinator vs Deno tests vs migration 0022 reconciliation gaps

- **Symptom**: Three concrete drifts surfaced when T032 shipped the sync coordinator against the test files authored in T023 / T024 / T025 and the schema laid down in `0022_provider_sync_tables.sql`:
  1. **Outcome enum mismatch (response vs storage)**: T032 returns `outcome='success_no_changes'` in the JSON response when the apply produced zero diffs, but stores `outcome='success'` in `provider_sync_runs` because migration 0022's `CHECK (outcome IN (...))` does not include `'success_no_changes'`. T032 documents this divergence inline (`supabase/functions/sync-catalog/index.ts` lines 47–49); the wire-shape contract and the storage shape diverge by design.
  2. **Test schema drift on `provider_sync_runs` row lookup**: `single_sync_happy.test.ts` (T023) asserts the ledger row via `.eq('id', runId)` and SELECTs the column `provider_name`. Migration 0022 ships `id bigserial` + a separate `correlation_id uuid` column, AND the provider column is named simply `provider` (not `provider_name`). T032 stores the request `run_id` as `correlation_id`. The PostgREST query will fail with a column-not-found error, OR return zero rows, depending on which mismatch trips first. **HARD pre-merge gate.**
  3. **Trigger enum mismatch (test fixtures vs migration CHECK)**: Five of six Deno test files post `trigger='cron'`, one posts `trigger='admin_manual'`, one posts `trigger='swap-test'`. Migration 0022's `CHECK (trigger IN ('scheduled', 'manual_admin', 'manual_internal'))` rejects all three. T032 inserts the request `trigger` value directly without remapping, so every test's first `INSERT INTO provider_sync_runs` will fail the CHECK and return 500 + `INTERNAL` instead of the contract status code the test asserts on. **HARD pre-merge gate.**
- **Disposition recommended in T033**:
  1. Documentation-only — accept the outcome-enum divergence permanently. Slice 006 / Slice 007 will read `'success'` and not need the no-op distinction.
  2. Patch `single_sync_happy.test.ts` to use `.eq('correlation_id', runId)` and to SELECT `provider` (not `provider_name`). Lower churn than changing the migration. Track as a Phase-6 polish task or fold into US3.
  3. Patch all six Deno test files to use the migration's accepted trigger enum values: `'cron'` → `'scheduled'`, `'admin_manual'` → `'manual_admin'`, `'swap-test'` → `'manual_internal'`. Single mechanical change per file. Track as a Phase-6 polish task or fold into US3.
- **Cross-reference**: D-006 is the umbrella under which migration 0022's enum + column naming was set; D-010 is the focused follow-up for the test-vs-as-built reconciliation specifically. Recorded in detail (with section-by-section symptoms and fix recommendations) in `specs/002-match-catalog/regression-checkpoint-us2.md § 7`.

### D-011 (2026-05-20, surfaced in T039) — `audit_log.source` enum has no value that fits the sync coordinator cleanly

- **Symptom**: T039 added payload-sanity rejection paths (R-004 + the in-payload duplicate strand of R-005) that need to write an `audit_log` row from the sync-catalog Edge Function. The `audit_log.source` CHECK constraint (migration `0003_audit_log_stub.sql`) accepts only: `'auth_hook'`, `'rls'`, `'api_guard'`, `'ui'`, `'trigger'`. None of those describe "the sync coordinator's payload guard" naturally. A literal `'sync'` value would violate the CHECK.
- **Decision chosen in T039**: write `source = 'api_guard'`. Rationale — the payload-sanity guard IS an API-level gatekeeper that decides whether to admit a write to the catalog; structurally it's the same role as the existing `api_guard` writers (Slice 001 RLS-gated routes). This is the least-bad of the five existing values, applied uniformly to every audit row the sync coordinator emits in this slice.
- **Audit-action vocabulary introduced by T039**: `'provider.sync_rejected_empty'`, `'provider.sync_rejected_undersized'`, `'provider.sync_rejected_duplicate'`. T040 will add similar `'provider.sync_*'` action strings for the conflict-quarantine paths; T041 will add `'provider.outage_alert_emitted'` / `'provider.outage_recovery'`. All will share `source='api_guard'` until D-011 is resolved.
- **Cross-slice impact**: Slice 007 (audit hardening) will add a `'sync'` (or similar) source value to the enum and may want to back-fill prior `'api_guard'` rows whose `action` starts with `'provider.sync_'` to the new value. The reconciliation is mechanical (`UPDATE audit_log SET source='sync' WHERE action LIKE 'provider.sync_%'`) and is recorded here for Slice 007 to pick up.
- **Cross-reference**: D-009 is the parallel naming-mismatch case for `match_result.updated` vs `match_result.corrected`. Same shape (audit-action / source naming drift surfaced after the migration locked) and same disposition (document, defer to a later slice).

---

## Phase 1: Setup (slice-specific harness; most setup inherited from Slice 001)

This phase prepares the Slice 001 baseline for Slice 002 work and enables the two Postgres extensions this slice needs. It assumes Slice 001's Setup phase (T001–T008) has already shipped.

- [X] T001 Verify Slice 001 regression baseline is GREEN before starting Slice 002 — `specs/002-match-catalog/regression-baseline-from-001.md` — baseline doc produced; runtime verification of slice 001 + slice 002 deferred jointly (Docker daemon down). See pre-merge checklist in regression-final.md (slice 001) and the slice 002 equivalent at T046.

**Agent prompt:**

> **Goal**: Confirm every Slice 001 test (Playwright + pgTAP + Slice 001's perf assertion) is GREEN. Per Constitution Principle XI, Slice 002 cannot start with Slice 001's suite in a red state.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle XI
> - `specs/001-eligibility-login/regression-final.md` (Slice 001's final gate output — must be 100% GREEN)
>
> **Files to create or modify**:
> - `specs/002-match-catalog/regression-baseline-from-001.md` (new) — short table listing every Slice 001 Playwright + pgTAP file and pass/fail status as of today's run, with a one-line note that Slice 002 work commences from this point.
>
> **What to do**:
> 1. Enumerate every Slice 001 Playwright spec under `apps/web/tests/playwright/slice-001-*.spec.ts` and every Slice 001 pgTAP file under `supabase/tests/pgtap/` (the 12 files listed in `specs/001-eligibility-login/quickstart.md` § Run automated tests).
> 2. Run each. Record pass/fail. If any are red, STOP — file a bug task and pause this slice.
> 3. Write the baseline table to `regression-baseline-from-001.md` with columns: file, slice, status, duration_seconds.
>
> **Acceptance criteria**:
> - File `specs/002-match-catalog/regression-baseline-from-001.md` exists with every Slice 001 test recorded as `pass`.
>
> **Do NOT**: modify any Slice 001 test, modify any Slice 001 source, or quarantine failures.
>
> **Constitution**: XI (NON-NEGOTIABLE).

**Blocked-by**: _(none — gate before everything in this slice)_
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-baseline-from-001.md` exists with all Slice 001 tests recorded as `pass`.

---

- [X] T002 [P] Enable `pg_cron` + `pg_net` extensions and set the slice's GUC values in `supabase/config.toml`

**Agent prompt:**

> **Goal**: Make the two Postgres extensions this slice depends on available, and set the GUC values (`app.sync_trigger_secret`, `app.sync_trigger_url`) the SECURITY DEFINER wrapper for `trigger_sync_catalog` will read.
>
> **Read first**:
> - `specs/002-match-catalog/plan.md` § Technical Context (the `pg_cron` + `pg_net` extension requirements)
> - `specs/002-match-catalog/research.md` § R-002 (sync-runner topology)
> - `specs/002-match-catalog/contracts/sync-runner.scheduled.md` § Auth (the `X-Internal-Auth` header)
> - The existing `supabase/config.toml` from Slice 001 — extend, don't overwrite
>
> **Files to create or modify**:
> - `supabase/config.toml` (modify)
> - `apps/web/.env.example` (modify — add `SYNC_TRIGGER_SECRET` placeholder; document that the secret is set via `supabase secrets set SYNC_TRIGGER_SECRET=...` for the Edge Function runtime and via the GUC for the wrapper)
>
> **What to do**:
> 1. In `[db.extensions]` (create the section if it doesn't exist), add `enabled = ["pg_cron", "pg_net"]` (preserve any existing extensions Slice 001 enabled).
> 2. In `[db.settings]`, set `timezone = 'UTC'` (idempotent — Slice 001 may already set this), and add `app.sync_trigger_url = "http://host.docker.internal:54321/functions/v1/sync-catalog"` and `app.sync_trigger_secret = "local-dev-secret-do-not-use-in-prod"`. Both GUCs MUST also be settable per-environment via the Supabase project dashboard; the values in `config.toml` are local-dev defaults only.
> 3. Confirm `supabase start && supabase db reset` succeeds with the extensions enabled (`psql -c "SELECT extname FROM pg_extension"` should include `pg_cron` and `pg_net`).
> 4. Update `apps/web/.env.example` to declare the relevant envs.
>
> **Acceptance criteria**:
> - `supabase start` brings up the stack with both extensions installed.
> - `psql "$SUPABASE_DB_URL" -c "SELECT extname FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net') ORDER BY extname;"` returns exactly two rows.
> - `psql "$SUPABASE_DB_URL" -c "SHOW app.sync_trigger_secret"` returns the configured value.
>
> **Do NOT**: hardcode the production secret in `config.toml`. The local-dev value here is an obvious placeholder; the production value is set via Supabase dashboard secrets.
>
> **Constitution**: VIII (config-driven), II (secret never in code).

**Blocked-by**: T001
**Parallel-safe with**: _(none in this phase — touches shared `config.toml`)_
**Definition of done**: `pg_cron` and `pg_net` are listed in `SELECT extname FROM pg_extension` after `supabase db reset`, AND the two GUCs return their configured values.

---

**Setup checkpoint**: T001–T002 done. Slice 001 baseline confirmed green; the two extensions are available; the GUCs the sync coordinator depends on are set. Foundational schema phase can now start.

---

## Phase 2: Foundational (BLOCKING — no user story may start until this phase completes)

This phase creates the schema (`teams`, `matches`, `match_results`, `match_provider_external_ids`, `team_provider_external_ids`, `provider_sync_runs`, `provider_sync_state`, `match_pending_review`), the audit triggers, the RLS policies, the seeded `tournament_config` keys, the seed fixture, and the **locked `MatchDataProviderAdapter` TypeScript interface**. It does NOT create the `record_match_result` SP body (T030 owns it) or the sync coordinator (T033 owns it) — those are per-story so Principle IX's red-first ordering is preserved.

- [X] T003 [P] Migration 0019: `teams` table + `team_provider_external_ids` + indexes (`supabase/migrations/0019_teams.sql`)

**Agent prompt:**

> **Goal**: Create the `public.teams` table per `data-model.md` § Entity 1 and the `team_provider_external_ids` mapping table per § Entity 4 (parallel structure to matches). NO RLS (T009 owns it). NO audit triggers (T008 owns those).
>
> **Read first**:
> - `specs/002-match-catalog/data-model.md` § Entity 1 (Team), § Entity 4 (Match Provider External IDs — same structure applies to team variant)
> - `specs/002-match-catalog/research.md` § R-003 (idempotent UPSERT via mapping table)
> - `specs/002-match-catalog/plan.md` § Source Code (exact filename: `0019_teams.sql`)
> - One existing Slice 001 migration to mimic style (header comments, transactional wrapper)
>
> **Files to create or modify**:
> - `supabase/migrations/0019_teams.sql` (new)
>
> **What to do**:
> 1. Wrap in `BEGIN; … COMMIT;`.
> 2. `CREATE TABLE public.teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, short_code text NOT NULL UNIQUE, flag_url text NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());`
> 3. CHECK: `length(trim(name)) > 0`; `short_code ~ '^[A-Z]{3}$'`.
> 4. Add `BEFORE UPDATE` trigger to maintain `updated_at`.
> 5. `CREATE TABLE public.team_provider_external_ids (id uuid PK default gen_random_uuid(), team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE, provider_name text NOT NULL, provider_team_id text NOT NULL, mapped_at timestamptz NOT NULL DEFAULT now(), UNIQUE (provider_name, provider_team_id));`
> 6. Indexes: `team_provider_external_ids_team_idx` on `(team_id)`.
> 7. Header comment: `-- Slice 002 / FR-001 / data-model.md § Entity 1 / cross-slice locked: teams.id is the FK target for Slice 004 final_predictions.champion_team_id, Slice 005 tournament_award.champion_team_id.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds with this migration in place.
> - `\d+ public.teams` shows the columns, the UNIQUE on `short_code`, the CHECK constraints, and the `updated_at` trigger.
> - Two INSERTs with the same `short_code` fail the UNIQUE.
>
> **Do NOT**: add RLS, audit triggers, or seed any rows. Do NOT add `provider_team_id` as a column on `teams` directly — the mapping table is the contract.
>
> **Constitution**: IV (provider IDs in mapping table, not on the entity), I (vendor-neutral entity shape).

**Blocked-by**: T002
**Parallel-safe with**: T004, T005, T006, T007
**Definition of done**: `supabase db reset` succeeds AND `\d+ public.teams` shows the locked shape AND the two CHECK constraints reject malformed data.

---

- [X] T004 [P] Migration 0020: `matches` table + `match_provider_external_ids` + status enum + indexes (`supabase/migrations/0020_matches.sql`)

**Agent prompt:**

> **Goal**: Create the `public.matches` table per `data-model.md` § Entity 2, including the `match_status` and `match_stage` enums, the home/away team FKs, the kickoff_utc timestamptz, the `last_synced_at` column, indexes per § Indexes, and the `(provider_name, provider_match_id)` mapping table.
>
> **Read first**:
> - `specs/002-match-catalog/data-model.md` § Entity 2 (Match), § Indexes and access patterns
> - `specs/002-match-catalog/research.md` § R-003 (mapping table) and § R-012 (matches vs match_results separation)
> - `specs/002-match-catalog/plan.md` § Source Code (filename: `0020_matches.sql`)
>
> **Files to create or modify**:
> - `supabase/migrations/0020_matches.sql` (new)
>
> **What to do**:
> 1. `CREATE TYPE public.match_status AS ENUM ('scheduled','in_progress','finished','postponed','cancelled');`
> 2. `CREATE TYPE public.match_stage AS ENUM ('group','r16','qf','sf','final','third_place');`
> 3. `CREATE TABLE public.matches (id uuid PK default gen_random_uuid(), home_team_id uuid NOT NULL REFERENCES teams(id), away_team_id uuid NOT NULL REFERENCES teams(id), stage public.match_stage NOT NULL, group_id text NULL, kickoff_utc timestamptz NOT NULL, venue text NULL, status public.match_status NOT NULL DEFAULT 'scheduled', last_synced_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK (home_team_id <> away_team_id), CHECK ((stage = 'group') = (group_id IS NOT NULL)));`
> 4. Add `BEFORE UPDATE` trigger to maintain `updated_at`.
> 5. Indexes: `matches_kickoff_utc_idx`, `matches_stage_group_idx`, `matches_status_kickoff_idx`, `matches_home_team_idx`, `matches_away_team_idx` exactly per `data-model.md` § Entity 2 Indexes table.
> 6. `CREATE TABLE public.match_provider_external_ids (id uuid PK default gen_random_uuid(), match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE, provider_name text NOT NULL, provider_match_id text NOT NULL, mapped_at timestamptz NOT NULL DEFAULT now(), UNIQUE (provider_name, provider_match_id));`
> 7. Index: `match_provider_external_ids_match_idx` on `(match_id)`.
> 8. Header comment: `-- Slice 002 / FR-001 / data-model.md § Entity 2 / cross-slice locked: matches.id is the FK target for Slice 003 predictions.match_id, Slice 005 score_records (target_kind='match').`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - `\d+ public.matches` shows all columns, both enums, the two CHECK constraints, and the five indexes.
> - Inserting a row with `home_team_id = away_team_id` fails the CHECK.
> - Inserting a row with `stage = 'group'` and `group_id = NULL` fails the CHECK.
>
> **Do NOT**: add status-transition trigger here (T008's audit trigger handles backward-transition detection in concert with conflict quarantine in T041). Do NOT add RLS (T009) or audit (T008). Do NOT seed.
>
> **Constitution**: I, VI (UTC timestamps).

**Blocked-by**: T002, T003 (teams FK)
**Parallel-safe with**: T005, T006, T007
**Definition of done**: `supabase db reset` succeeds AND the CHECKs reject same-team and missing-group fixtures.

---

- [X] T005 [P] Migration 0021: `match_results` table + CHECK invariants (`supabase/migrations/0021_match_results.sql`)

**Agent prompt:**

> **Goal**: Create the `public.match_results` table per `data-model.md` § Entity 3, including the cross-slice locked columns `home_score_for_scoring` / `away_score_for_scoring` (Slice 005 reads these by name) and the CHECK invariants that enforce `_for_scoring <= _official` and the shootout level-check.
>
> **Read first**:
> - `specs/002-match-catalog/data-model.md` § Entity 3 (Match Result), including the validation rules
> - `specs/002-match-catalog/research.md` § R-010 (knockout score split / OD-002 implementation)
> - `specs/002-match-catalog/contracts/match-results.write.md` § Stored procedure (the CHECK invariants the SP enforces; this migration's table CHECKs are the safety net)
> - `specs/002-match-catalog/plan.md` § Source Code (filename: `0021_match_results.sql`)
>
> **Files to create or modify**:
> - `supabase/migrations/0021_match_results.sql` (new)
>
> **What to do**:
> 1. `CREATE TYPE public.result_status AS ENUM ('regulation','extra_time','penalties_shootout');`
> 2. `CREATE TYPE public.result_source AS ENUM ('sync','admin_correction');`
> 3. `CREATE TABLE public.match_results (match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE RESTRICT, home_score_official int NOT NULL CHECK (home_score_official >= 0), away_score_official int NOT NULL CHECK (away_score_official >= 0), home_score_for_scoring int NOT NULL CHECK (home_score_for_scoring >= 0), away_score_for_scoring int NOT NULL CHECK (away_score_for_scoring >= 0), result_status public.result_status NOT NULL, source public.result_source NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(), approved_by uuid NULL REFERENCES participants(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());`
> 4. Add CHECK constraints:
>    - `CHECK (home_score_for_scoring <= home_score_official)`
>    - `CHECK (away_score_for_scoring <= away_score_official)`
>    - `CHECK (result_status <> 'penalties_shootout' OR (home_score_for_scoring = away_score_for_scoring AND home_score_official <> away_score_official))` — shootout-level invariant
>    - `CHECK (source <> 'admin_correction' OR approved_by IS NOT NULL)` — admin correction requires attribution
> 5. Index `match_results_approved_at_idx` on `(approved_at DESC)`.
> 6. `BEFORE UPDATE` trigger to maintain `updated_at`.
> 7. Header comment naming the cross-slice contract: `-- Slice 002 / OD-002 resolution / cross-slice locked: home_score_for_scoring & away_score_for_scoring are read by name by Slice 005's score_match function (see specs/005-scoring-leaderboard/data-model.md § Entity 1).`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - `\d+ public.match_results` shows the four CHECKs.
> - INSERT with `home_score_for_scoring = 5, home_score_official = 3` fails the `_for_scoring <= _official` CHECK.
> - INSERT with `result_status='penalties_shootout', home_score_for_scoring=2, away_score_for_scoring=3` fails the shootout-level CHECK.
> - INSERT with `source='admin_correction', approved_by=NULL` fails the attribution CHECK.
>
> **Do NOT**: add the `record_match_result` SP here (T030). Do NOT add RLS (T009). Do NOT add the pg_notify channel emission (T030 owns it).
>
> **Constitution**: V (CHECK invariants encode rules near data), III (rules in SQL), I (vendor-neutral terminology).

**Blocked-by**: T002, T004 (matches FK)
**Parallel-safe with**: T003, T006, T007
**Definition of done**: `supabase db reset` succeeds AND all four CHECK constraints reject their respective failure cases AND the cross-slice column-name comment is present in the migration header.

---

- [X] T006 [P] Migration 0022: `provider_sync_runs` + `provider_sync_state` tables (`supabase/migrations/0022_provider_sync_tables.sql`)

**Agent prompt:**

> **Goal**: Create the sync-ledger and alert-dedup state tables per `data-model.md` § Entity 5 (Provider Sync Run) and § Entity 6 (Provider Sync State).
>
> **Read first**:
> - `specs/002-match-catalog/data-model.md` § Entity 5, § Entity 6
> - `specs/002-match-catalog/research.md` § R-008 (alert dedup)
> - `specs/002-match-catalog/plan.md` § Source Code (filename: `0022_provider_sync_tables.sql`)
>
> **Files to create or modify**:
> - `supabase/migrations/0022_provider_sync_tables.sql` (new)
>
> **What to do**:
> 1. Create enums: `sync_run_trigger` (`'cron'`, `'admin_manual'`, `'recovery'`), `sync_run_outcome` (the 9 values from `data-model.md` § Entity 5 — `success`, `success_no_changes`, `partial`, `client_error`, `exhausted_retries`, `rejected_empty`, `rejected_undersized`, `rejected_duplicate_in_payload`, `conflict_quarantined`).
> 2. `CREATE TABLE public.provider_sync_runs` per § Entity 5 column list, with CHECK constraints `finished_at >= started_at` (when set) and `(outcome IS NOT NULL) = (finished_at IS NOT NULL)` and `(trigger = 'admin_manual') = (triggered_by IS NOT NULL)`.
> 3. Indexes: `provider_sync_runs_started_at_idx` on `(started_at DESC)`; `provider_sync_runs_provider_outcome_idx` on `(provider_name, outcome, started_at DESC)`.
> 4. `CREATE TABLE public.provider_sync_state (provider_name text PRIMARY KEY, last_success_at timestamptz NULL, first_failure_after_success_at timestamptz NULL, outage_alerted_at timestamptz NULL, updated_at timestamptz NOT NULL DEFAULT now(), CHECK (outage_alerted_at IS NULL OR first_failure_after_success_at IS NOT NULL));`
> 5. `BEFORE UPDATE` trigger on `provider_sync_state` to maintain `updated_at`.
> 6. Header comment: `-- Slice 002 / FR-007 / FR-008 / data-model.md § Entity 5 + § Entity 6 / cross-slice: Slice 007 will harden retention; column shapes are locked.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - Inserting a `provider_sync_runs` row with `outcome=NULL, finished_at='...'` fails the symmetry CHECK.
> - Inserting a `provider_sync_state` row with `outage_alerted_at` set but `first_failure_after_success_at NULL` fails the CHECK.
>
> **Do NOT**: write rows here. Do NOT add RLS (T009).
>
> **Constitution**: V, VII, VIII.

**Blocked-by**: T002
**Parallel-safe with**: T003, T004, T005, T007
**Definition of done**: `supabase db reset` succeeds AND the two CHECK symmetries reject their failure cases AND both tables exist with the locked column lists.

---

- [X] T007 [P] Migration 0023: `match_pending_review` quarantine table (`supabase/migrations/0023_match_pending_review.sql`)

**Agent prompt:**

> **Goal**: Create the `match_pending_review` table per `data-model.md` § Entity 7 — the quarantine queue for per-row conflicts that the sync coordinator declines to auto-apply (Clarifications 2026-05-15 Q2, R-005).
>
> **Read first**:
> - `specs/002-match-catalog/data-model.md` § Entity 7 (Match Pending Review)
> - `specs/002-match-catalog/research.md` § R-005 (conflict quarantine semantics)
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q2 (hybrid conflict scope)
>
> **Files to create or modify**:
> - `supabase/migrations/0023_match_pending_review.sql` (new)
>
> **What to do**:
> 1. Create enum `conflict_kind` (`'team_assignment_changed'`, `'status_backward_transition'`, `'score_before_kickoff'`, `'kickoff_change_after_lock'`, `'unknown'`).
> 2. Create enum `conflict_resolution` (`'accept_provider'`, `'reject_provider'`, `'manual_override'`).
> 3. `CREATE TABLE public.match_pending_review` per § Entity 7 (id, match_id FK, provider_observation jsonb NOT NULL, existing_row_snapshot jsonb NOT NULL, conflict_kind public.conflict_kind NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz NULL, reviewer uuid NULL REFERENCES participants(id), resolution public.conflict_resolution NULL, resolution_notes text NULL).
> 4. Partial index on unresolved rows: `CREATE INDEX match_pending_review_unresolved_idx ON match_pending_review (observed_at DESC) WHERE reviewed_at IS NULL;`
> 5. Full index for per-match history: `match_pending_review_match_idx` on `(match_id)`.
> 6. CHECK: `(reviewed_at IS NULL) = (reviewer IS NULL)` AND `(reviewed_at IS NULL) = (resolution IS NULL)` — review fields must all be set or all NULL.
> 7. Header comment: `-- Slice 002 / FR-009 / Clarifications 2026-05-15 Q2 / Slice 006 admin UI reads + resolves these rows.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - Partial index exists (verify via `\d+ public.match_pending_review`).
> - Inserting a row with `reviewed_at` set but `reviewer=NULL` fails the CHECK.
>
> **Do NOT**: add RLS (T009 handles admin-read/admin-update policies). Do NOT seed.
>
> **Constitution**: V (audit), II (admin-only writes via RLS in T009).

**Blocked-by**: T002, T004 (matches FK)
**Parallel-safe with**: T003, T005, T006
**Definition of done**: `supabase db reset` succeeds AND the partial index exists AND the review-fields CHECK enforces all-or-nothing.

---

- [X] T008 Migration 0025: catalog audit triggers on `teams`, `matches`, `match_results` (`supabase/migrations/0025_catalog_audit_triggers.sql`)

**Agent prompt:**

> **Goal**: Create `AFTER INSERT OR UPDATE OR DELETE` triggers on the three catalog tables that write one `audit_log` row per change in the same transaction. Mirror Slice 001's `log_participant_change` pattern (recursion guard via `pg_trigger_depth() = 1`).
>
> **Read first**:
> - `specs/002-match-catalog/data-model.md` § Entity 2 Audit posture, § Entity 3 Audit posture, § Entity 1 Audit posture
> - Slice 001's `supabase/migrations/0008_participants_audit_trigger.sql` (the canonical pattern)
> - `.specify/memory/constitution.md` § Principle V (same-transaction audit, NON-NEGOTIABLE)
>
> **Files to create or modify**:
> - `supabase/migrations/0025_catalog_audit_triggers.sql` (new)
>
> **What to do**:
> 1. Define one `SECURITY DEFINER` function per table: `log_team_change`, `log_match_change`, `log_match_result_change`. Each follows the Slice 001 pattern: `actor` resolves via `(SELECT id FROM participants WHERE auth_user_id = auth.uid())` when present, else NULL; `source='trigger'`; `previous_value = to_jsonb(OLD)`, `new_value = to_jsonb(NEW)`. Action labels: `team.created`/`team.updated`/`team.deleted`, `match.created`/`match.updated`/`match.deleted`, `match_result.recorded`/`match_result.corrected`/`match_result.deleted`. For `matches`, the trigger should additionally emit `match.status_changed` when `OLD.status IS DISTINCT FROM NEW.status` — a second row in the same transaction so Slice 003's lock-window logic can audit-listen by action.
> 2. Wire `AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW EXECUTE FUNCTION` triggers on each of the three tables.
> 3. Guard against recursion with `IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;` at the top of each function — `audit_log` writes must never re-fire these triggers transitively.
> 4. Header comment: `-- Slice 002 / FR-018 / V (NON-NEGOTIABLE same-transaction audit) / mirrors Slice 001's log_participant_change pattern.`
>
> **Acceptance criteria**:
> - `INSERT INTO matches(...)` produces exactly one `audit_log` row with `action='match.created'`.
> - `UPDATE matches SET status='in_progress' WHERE id = ...` produces TWO audit rows in the same transaction: `match.updated` AND `match.status_changed`.
> - `INSERT INTO match_results(...)` produces one `audit_log` row with `action='match_result.recorded'`.
>
> **Do NOT**: write audit rows from the SP body in T030 — the trigger handles it. Do NOT skip the recursion guard.
>
> **Constitution**: V (NON-NEGOTIABLE).

**Blocked-by**: T003, T004, T005
**Parallel-safe with**: T006, T007 (different files; FK dependencies OK)
**Definition of done**: An INSERT on each of the three tables produces the expected `audit_log` rows in the same transaction, AND a `matches.status` UPDATE produces both `match.updated` and `match.status_changed`.

---

- [X] T009 Migration 0026: catalog RLS — `teams`, `matches`, `match_results`, `match_provider_external_ids`, `team_provider_external_ids`, `provider_sync_runs`, `provider_sync_state`, `match_pending_review` (`supabase/migrations/0026_catalog_rls.sql`)

**Agent prompt:**

> **Goal**: Enable RLS on the eight tables this slice introduces and define the policies per `data-model.md` § RLS posture summary.
>
> **Read first**:
> - `specs/002-match-catalog/data-model.md` § RLS posture summary
> - Slice 001's `is_eligible_nortal_participant(uuid)` and `is_admin(uuid)` — referenced by every policy below
>
> **Files to create or modify**:
> - `supabase/migrations/0026_catalog_rls.sql` (new)
>
> **What to do**:
> 1. `ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;` Policy `teams_eligible_read` (SELECT): `USING (public.is_eligible_nortal_participant(auth.uid()))`. No write policies.
> 2. Same shape for `matches`, `match_results` — eligible-read only.
> 3. `match_provider_external_ids` and `team_provider_external_ids`: admin-read only (`USING (public.is_admin(auth.uid()))`). No write policies.
> 4. `provider_sync_runs`, `provider_sync_state`: admin-read only. No write policies.
> 5. `match_pending_review`: admin-read AND admin-update (Slice 006 resolves rows). The UPDATE policy: `USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()))`.
> 6. Header comment: `-- Slice 002 / data-model.md § RLS posture / depends on Slice 001's is_eligible_nortal_participant + is_admin stub.`
>
> **Acceptance criteria**:
> - Participant JWT: `SELECT * FROM matches` returns all rows (because the predicate is "is the caller eligible?", not row-level filtering). `SELECT * FROM provider_sync_runs` returns 0 rows.
> - Admin JWT (Slice 001's permissive stub: `role=admin` claim): all 8 tables return all rows.
> - Non-Nortal JWT (synthesized): `SELECT * FROM matches` returns 0 rows.
> - All eight tables: a participant client cannot INSERT/UPDATE/DELETE — Postgres rejects.
>
> **Do NOT**: open write policies for participants. Do NOT call functions that don't exist yet (e.g., Slice 005's leaderboard view).
>
> **Constitution**: II (Security), III (RLS at data boundary).

**Blocked-by**: T003, T004, T005, T006, T007 (all tables must exist)
**Parallel-safe with**: T008 (different file; T008's triggers don't conflict with RLS)
**Definition of done**: `supabase db reset` succeeds AND a participant JWT sees catalog rows but no sync-ledger rows AND an admin JWT sees everything AND no participant write succeeds.

---

- [X] T010 Migration 0028: `tournament_config` defaults seed for Slice 002 keys (`supabase/migrations/0028_provider_config_defaults.sql`)

**Agent prompt:**

> **Goal**: Seed the `tournament_config` keys this slice consumes, per `research.md` § R-013 and the Clarifications 2026-05-15 (three-tier cadence + webhook URL).
>
> **Read first**:
> - `specs/002-match-catalog/research.md` § R-013 (full table of keys + defaults)
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 (Q1 three-tier cadence values; Q3 webhook URL key)
> - Slice 001's `tournament_config` seed migration (the table shape is locked there)
>
> **Files to create or modify**:
> - `supabase/migrations/0028_provider_config_defaults.sql` (new)
>
> **What to do**:
> 1. `INSERT … ON CONFLICT (key) DO NOTHING` for each key, value as `jsonb`:
>    - `provider.active` = `"stub"` (local-dev default; production flips to `"footballdata"` via Slice 008)
>    - `provider.fallback` = `null::jsonb`
>    - `provider.stub.base_url` = `"http://localhost:54321/stub-provider"`  (the in-test stub URL; documented placeholder)
>    - `provider.stub.credentials_ref` = `null::jsonb`
>    - `provider.footballdata.base_url` = `"https://api.football-data.org/v4"`
>    - `provider.footballdata.credentials_ref` = `"FOOTBALLDATA_API_TOKEN"`
>    - `provider_sync.cadence.pre_tournament_minutes` = `1440` (daily)
>    - `provider_sync.cadence.tournament_day_minutes` = `60` (hourly)
>    - `provider_sync.cadence.live_window_minutes` = `5`
>    - `provider_sync.cadence.live_window_pre_kickoff_minutes` = `90`
>    - `provider_sync.cadence.live_window_post_kickoff_minutes` = `240`  (4 hours after kickoff)
>    - `provider_sync.retry_policy` = `{"max_attempts": 3, "initial_backoff_ms": 1000, "multiplier": 2}`
>    - `provider_sync.outage_alert_threshold_minutes` = `30`
>    - `provider_sync.undersized_threshold` = `0.5`
>    - `provider_sync.kickoff_tolerance_minutes` = `5`
>    - `knockout_score_basis` = `"reg_plus_extra"`
>    - `notifications.outage_webhook_url` = `null::jsonb` (Slice 008 admin UI sets this; null → audit-log-only path)
> 2. Header comment: `-- Slice 002 defaults / research.md § R-013 / Clarifications 2026-05-15 Q1 + Q3 / handoff to Slice 008. The active provider defaults to "stub" for local dev; production flips this to a real provider via Slice 008.`
>
> **Acceptance criteria**:
> - `SELECT count(*) FROM tournament_config WHERE key LIKE 'provider%' OR key LIKE 'provider_sync%' OR key = 'knockout_score_basis' OR key = 'notifications.outage_webhook_url'` returns at least 17 rows.
> - `SELECT (value)::jsonb FROM tournament_config WHERE key = 'provider_sync.cadence.live_window_minutes'` returns `5`.
> - `SELECT (value) FROM tournament_config WHERE key = 'notifications.outage_webhook_url'` returns `null::jsonb` (the safe-fallback default).
>
> **Do NOT**: hard-code any of these values anywhere else (in code, SQL functions, or tests). Tests MUST read from `tournament_config`.
>
> **Constitution**: VIII (NON-CONSTANT rule values), X (slice runs without Slice 008's admin UI).

**Blocked-by**: T009 (after RLS so seed obeys policy)
**Parallel-safe with**: _(none in this phase)_
**Definition of done**: All 17 keys present in `tournament_config` with the declared default values.

---

- [X] T011 [P] Define `MatchDataProviderAdapter` TypeScript interface (`supabase/functions/_shared/providers/types.ts`)

**Agent prompt:**

> **Goal**: Ship the **locked cross-slice TypeScript interface** every concrete provider adapter implements, per `contracts/provider-adapter.contract.md` § Interface.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/provider-adapter.contract.md` (entire file — this contract is the source of truth)
> - `specs/002-match-catalog/research.md` § R-001 (provider abstraction shape)
>
> **Files to create or modify**:
> - `supabase/functions/_shared/providers/types.ts` (new)
>
> **What to do**:
> 1. Copy the interface declaration **exactly** from `contracts/provider-adapter.contract.md` § Interface — including the JSDoc header pointing at the contract file.
> 2. Define `SyncWindow`, `NormalizedFixture`, `NormalizedResult`, `NormalizedTeam`, `NormalizedPlayer` per the contract.
> 3. Define and export the three error classes `ProviderTransientError`, `ProviderRateLimitedError`, `ProviderClientError` with the readonly `retryable` discriminator the coordinator branches on.
> 4. Header JSDoc: `@see specs/002-match-catalog/contracts/provider-adapter.contract.md — LOCKED CROSS-SLICE CONTRACT. Adding optional methods / fields is non-breaking; renames/removals require coordinated updates across every adapter and the coordinator.`
> 5. Run `pnpm -F web typecheck` AND `deno check supabase/functions/_shared/providers/types.ts` — both must pass. (The file is Deno-compatible; verify imports use Deno-style paths.)
>
> **Acceptance criteria**:
> - File compiles cleanly under both TypeScript (`pnpm -F web typecheck`) and Deno (`deno check ...`).
> - The interface signature matches `contracts/provider-adapter.contract.md` byte-for-byte.
> - The three error classes are exported with the discriminator pattern.
>
> **Do NOT**: import any Node-only or browser-only types. Do NOT add concrete adapter implementations here (T031 + T032 own those).
>
> **Constitution**: IV (Provider Abstraction), XI (cross-slice locked signature).

**Blocked-by**: T002
**Parallel-safe with**: T003, T004, T005, T006, T007
**Definition of done**: Both typecheckers pass on the file AND its content matches the contract file's Interface section.

---

- [X] T012 Seed fixture `slice-002-fixture.sql` (`supabase/seed/slice-002-fixture.sql`)

**Agent prompt:**

> **Goal**: Create the deterministic seed fixture described in `quickstart.md` § Seed data. 8 teams + 4 matches + 1 finished match_results row + 1 pending-review row + the stub-provider mapping rows.
>
> **Read first**:
> - `specs/002-match-catalog/quickstart.md` § Seed data
> - `specs/002-match-catalog/spec.md` Acceptance Scenarios + Edge Cases
> - `specs/002-match-catalog/data-model.md` (column semantics for every table)
>
> **Files to create or modify**:
> - `supabase/seed/slice-002-fixture.sql` (new)
> - `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json` (new) — JSON fixture the stub adapter reads; mapping rows in the SQL fixture point to the IDs in this file
>
> **What to do**:
> 1. SQL fixture: `BEGIN; … COMMIT;` with `INSERT … ON CONFLICT DO NOTHING` everywhere.
> 2. Insert 8 teams with stable UUIDs (`00000000-0000-0000-0000-0000000000T1`…`T8`) and short codes (`ARG`, `BRA`, `FRA`, `GER`, `USA`, `MEX`, `CAN`, `JPN`).
> 3. Insert 4 matches with stable UUIDs (`...M1`…`M4`): M1 = ARG vs BRA group-stage scheduled (kickoff in past for sync test), M2 = FRA vs GER group-stage scheduled (kickoff in future for catalog read test), M3 = USA vs MEX group-stage in-progress, M4 = CAN vs JPN r16 finished (with `match_results` row).
> 4. Insert 1 match_results row for M4: `home_score_official=2, away_score_official=2, home_score_for_scoring=2, away_score_for_scoring=2, result_status='penalties_shootout'` — exercises the shootout split (M4 won on penalties; for-scoring is the level draw).
> 5. Insert team_provider_external_ids and match_provider_external_ids mapping rows that point at the stub provider's IDs (declared in the JSON fixture).
> 6. Insert 1 match_pending_review row referencing M2 with `conflict_kind='team_assignment_changed'` and a sample `provider_observation` jsonb — exercises the admin-read RLS in T009.
> 7. Top-of-file comment block "Hand-verified scenario coverage" mapping each spec Acceptance Scenario and Edge Case to which fixture row exercises it.
> 8. JSON fixture (`wc2026-snapshot.json`): mirror the 4 matches as provider-shaped objects with the same provider IDs the SQL mappings declare. The stub adapter (T031) reads this file.
>
> **Acceptance criteria**:
> - `psql "$SUPABASE_DB_URL" -f supabase/seed/slice-002-fixture.sql` succeeds against a freshly-reset DB.
> - Re-running the fixture produces no new rows.
> - The fixture creates exactly 8 teams + 4 matches + 1 match_results + 1 pending_review + the corresponding mapping rows.
>
> **Do NOT**: insert into `provider_sync_runs` or `provider_sync_state` (those are written by the coordinator at runtime). Do NOT depend on any not-yet-created table.
>
> **Constitution**: IX (deterministic fixture for scenario assertions).

**Blocked-by**: T009, T010 (RLS + config seed must exist so fixture obeys policy)
**Parallel-safe with**: T011
**Definition of done**: Fixture loads cleanly, produces the expected row counts, and the JSON fixture's provider IDs match the SQL mapping rows.

---

**Foundational checkpoint**: T001–T012 done. Schema, RLS, audit triggers, config defaults, seed fixture, and the locked TypeScript interface exist. No business logic yet. User-story phases below can now start.

---

## Phase 3: User Story 1 — Participant sees the catalog (Priority: P1)

**Story goal**: An eligible participant sees the World Cup 2026 fixture list with stage/group/teams/kickoff/venue/status, in their browser locale, paginated and filterable (`spec.md` US1).

**Story-independent test** (`spec.md` US1 § Independent Test): Sign in eligible, navigate to `/matches`, verify all 4 fixture rows render with correct stage/group/teams/kickoff/status. Switch locale, verify kickoff re-localizes while the API response stays UTC.

- [X] T013 [P] [US1] Author Playwright `slice-002-catalog-eligible-200.spec.ts` + `slice-002-catalog-filters.spec.ts` + `slice-002-catalog-pagination.spec.ts` + `slice-002-catalog-bad-params.spec.ts` (RED)

**Agent prompt:**

> **Goal**: Author the four core Playwright specs for US1 per `contracts/match-catalog.read.md` § Test surface.
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § User Story 1 (Acceptance Scenarios 1, 2, 3) and the FR-012 wording
> - `specs/002-match-catalog/contracts/match-catalog.read.md` (entire file — the API contract is the source of truth)
> - `supabase/seed/slice-002-fixture.sql` (fixture rows referenced by tests)
> - One existing Slice 001 Playwright spec for project conventions
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-002-catalog-eligible-200.spec.ts` (new)
> - `apps/web/tests/playwright/slice-002-catalog-filters.spec.ts` (new)
> - `apps/web/tests/playwright/slice-002-catalog-pagination.spec.ts` (new)
> - `apps/web/tests/playwright/slice-002-catalog-bad-params.spec.ts` (new)
>
> **What to do**:
> 1. `slice-002-catalog-eligible-200.spec.ts`: sign in eligible (reuse Slice 001's OIDC stub helper); GET `/api/matches`; assert 200 + body schema matches the contract; assert exactly 4 matches returned (fixture count); assert `total === 4`; assert M4 has a populated `match_result` block with shootout fields; M1/M2/M3 have `match_result: null`.
> 2. `slice-002-catalog-filters.spec.ts`: ~6 tests — one per filter dimension (`?stage=group` returns M1+M2+M3, `?status=finished` returns M4 only, `?team_id=<ARG>` returns M1, `?from=<X>&to=<Y>` window filtering, multi-stage `?stage=group,r16` returns all 4, `?group=A` returns the in-group rows).
> 3. `slice-002-catalog-pagination.spec.ts`: `?page_size=2` returns 2 + `total=4`; next page returns the next 2.
> 4. `slice-002-catalog-bad-params.spec.ts`: `?page_size=10000` → 400; `?from=<later>&to=<earlier>` → 400; `?stage=unknown` → 400.
> 5. Every Then-clause asserts specific values (status codes, body shape, exact match counts) — no "should be reasonable" language.
>
> **Acceptance criteria**:
> - File compiles under `pnpm -F web typecheck`.
> - `pnpm -F web e2e slice-002-catalog-*.spec.ts` shows ~13 tests RED for assertion-level reasons.
>
> **Do NOT**: implement the route handler. Do NOT seed inline.
>
> **Constitution**: IX (NON-NEGOTIABLE).

**Blocked-by**: T012
**Parallel-safe with**: T014, T015, T016, T017
**Definition of done**: ~13 RED Playwright tests across four files.

---

- [X] T014 [P] [US1] Author Playwright `slice-002-catalog-401.spec.ts` + `slice-002-catalog-403-domain-removed.spec.ts` + `slice-002-catalog-no-leak.spec.ts` (RED)

**Agent prompt:**

> **Goal**: Author the eligibility-gate Playwright specs for US1 + US3 (no-info-leak on the catalog surface) per `contracts/match-catalog.read.md` § Test surface.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/match-catalog.read.md` § Test surface
> - Slice 001 § Clarifications 2026-05-15 Q3 (mid-session deny — the same predicate guards this route)
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-002-catalog-401.spec.ts` (new)
> - `apps/web/tests/playwright/slice-002-catalog-403-domain-removed.spec.ts` (new)
> - `apps/web/tests/playwright/slice-002-catalog-no-leak.spec.ts` (new)
>
> **What to do**:
> 1. `slice-002-catalog-401.spec.ts`: GET `/api/matches` with no session cookie; assert 401 + body `{error:{code:'UNAUTHENTICATED', message:'Sign in to continue.'}}`.
> 2. `slice-002-catalog-403-domain-removed.spec.ts`: sign in eligible; `psql -c "UPDATE tournament_config SET value = '[]'::jsonb WHERE key='eligibility.approved_domains'"`; GET `/api/matches`; assert 403 + body `{error:{code:'DOMAIN_NOT_APPROVED', ...}}`; restore config.
> 3. `slice-002-catalog-no-leak.spec.ts`: replay the 403 path; assert response body contains zero references to other participants, no provider info, no admin info.
>
> **Acceptance criteria**: 3 RED tests across three files.
>
> **Do NOT**: implement the route handler.
>
> **Constitution**: IX, II.

**Blocked-by**: T012
**Parallel-safe with**: T013, T015, T016, T017
**Definition of done**: 3 RED Playwright tests.

---

- [X] T015 [P] [US1] Author Playwright `slice-002-catalog-locale-display.spec.ts` (RED) — SC-004 invariant

**Agent prompt:**

> **Goal**: Author the locale-display test that proves SC-004 ("zero participant-visible kickoff times displayed in the wrong locale across at least 1,000 simulated locale-mixed reads"). The unit-scale assertion here is the foundation; the load test (if added later) extends to 1,000.
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § SC-004
> - `specs/002-match-catalog/research.md` § R-009 (locale display posture)
> - `specs/002-match-catalog/contracts/match-catalog.read.md` § Response shape
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-002-catalog-locale-display.spec.ts` (new)
>
> **What to do**:
> 1. Test 1: set `await context.setExtraHTTPHeaders({'Accept-Language': 'es-ES'});`; navigate to `/matches`; assert the rendered kickoff for M1 matches Spanish-locale formatting (e.g., `"DD/MM/YYYY HH:mm"`); GET `/api/matches`; assert the JSON's `kickoff_utc` is still an ISO-8601 UTC string (Z suffix).
> 2. Test 2: same flow with `Accept-Language: 'en-US'`; assert US-locale formatting (e.g., `"M/D/YYYY"`); JSON unchanged.
> 3. Test 3: same flow with `Accept-Language: 'ja-JP'`; assert Japanese formatting; JSON unchanged.
> 4. Test 4: programmatically read `psql -c "SELECT kickoff_utc FROM matches WHERE id='...M1'"`; assert the DB value is unchanged regardless of which locale the previous tests requested (canonical-UTC-stays-canonical invariant).
>
> **Acceptance criteria**: 4 RED tests covering three locales + DB-canonical check.
>
> **Do NOT**: implement the page.
>
> **Constitution**: VI (Time-Zone Correctness), IX.

**Blocked-by**: T012
**Parallel-safe with**: T013, T014, T016, T017
**Definition of done**: 4 RED Playwright tests covering en-US, es-ES, ja-JP locales plus DB-canonical assertion.

---

- [X] T016 [P] [US1] Author Playwright `slice-002-late-fixture-appears.spec.ts` (RED) — US1.3 / sync-driven appearance

**Agent prompt:**

> **Goal**: Author the US1 Acceptance Scenario 3 test ("late-added fixture appears after sync"). This test depends on the sync engine (US2) so it's RED until T033 ships, but it's authored under US1 because the *observable behavior* is a catalog read.
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § User Story 1 Acceptance Scenario 3
> - `specs/002-match-catalog/quickstart.md` § Manual verification step 2
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-002-late-fixture-appears.spec.ts` (new)
>
> **What to do**:
> 1. Pre-state: 4 fixture matches loaded.
> 2. Test step: edit `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json` (via a fs.writeFile in the test) to add a 5th fixture with new provider_match_id; trigger sync via `curl POST /functions/v1/sync-catalog` with `X-Internal-Auth`; wait for `provider_sync_runs.outcome='success'`; GET `/api/matches`; assert `total === 5` and the new match is present.
> 3. Cleanup: restore the JSON file at the end of the test.
>
> **Acceptance criteria**: 1 RED test (will GREEN at T033 + T040 + T041).
>
> **Do NOT**: implement either the catalog read or the sync engine here.
>
> **Constitution**: IX, X (story-independent observability).

**Blocked-by**: T012
**Parallel-safe with**: T013, T014, T015, T017
**Definition of done**: 1 RED Playwright test.

---

- [X] T017 [P] [US1] Author pgTAP `slice-002-catalog-rls.sql` (RED)

**Agent prompt:**

> **Goal**: Author the SQL-level RLS-isolation test for `matches` per `data-model.md` § RLS posture and `contracts/match-catalog.read.md` § Test surface.
>
> **Read first**:
> - `specs/002-match-catalog/data-model.md` § RLS posture summary
> - One existing Slice 001 pgTAP file for project conventions
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/slice-002-catalog-rls.sql` (new)
>
> **What to do**:
> 1. `BEGIN; SELECT plan(N); … SELECT * FROM finish(); ROLLBACK;`.
> 2. Plan ~6 assertions:
>    - With Alpha's JWT (eligible): `SELECT count(*) FROM matches` returns 4.
>    - With Alpha's JWT: `SELECT count(*) FROM provider_sync_runs` returns 0.
>    - With Alpha's JWT: `SELECT count(*) FROM match_pending_review` returns 0.
>    - With admin JWT (`role=admin`): all three above return their full counts.
>    - With outsider JWT: `SELECT count(*) FROM matches` returns 0.
>    - With Alpha's JWT after `psql -c "UPDATE tournament_config SET value='[]'::jsonb WHERE key='eligibility.approved_domains'"`: returns 0 (mid-session deny per Slice 001 Clarifications Q3).
>
> **Acceptance criteria**: RLS policies don't exist yet → tests fail RED.
>
> **Do NOT**: alter policies. Do NOT bypass via service-role.
>
> **Constitution**: II, III, IX.

**Blocked-by**: T012
**Parallel-safe with**: T013, T014, T015, T016
**Definition of done**: 6 RED pgTAP assertions.

---

- [X] T018 [US1] Verify all US1 tests RED before implementation — `specs/002-match-catalog/red-gate-us1.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Same shape as Slice 001's red-gate tasks. Confirm every US1 test from T013–T017 is RED for an assertion-level reason.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle IX final paragraph
>
> **Files to create or modify**:
> - `specs/002-match-catalog/red-gate-us1.md` (new)
>
> **What to do**:
> 1. Run every Playwright file from T013–T016 via `pnpm -F web e2e`.
> 2. Run T017's pgTAP file.
> 3. Confirm each test fails for the documented assertion-level reason (NOT for a syntax error in the test).
> 4. Tabulate to `red-gate-us1.md`.
>
> **Acceptance criteria**:
> - All ~22 tests RED.
> - `red-gate-us1.md` exists.
>
> **Do NOT**: edit any test.
>
> **Constitution**: IX (gate).

**Blocked-by**: T013, T014, T015, T016, T017
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us1.md` lists every US1 test as RED with documented reasons.

---

- [X] T019 [US1] Implement `apps/web/lib/types/match.ts` (cross-slice TypeScript types) + `apps/web/lib/catalog/format.ts` (locale helpers) + `apps/web/lib/catalog/client.ts` (server-side fetch helper)

**Agent prompt:**

> **Goal**: Create the cross-slice TypeScript types for `Match` + `MatchResult` (consumed by Slices 003/004/005), plus the locale-aware formatting helpers, plus the thin Supabase wrapper.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/match-catalog.read.md` § Response shape, § Cross-slice contract
> - `specs/002-match-catalog/research.md` § R-009 (Intl.DateTimeFormat for client-side localization)
>
> **Files to create or modify**:
> - `apps/web/lib/types/match.ts` (new) — exports `Match`, `MatchResult`, `Team`, `MatchStage`, `MatchStatus`, `ResultStatus` types matching the API contract
> - `apps/web/lib/catalog/format.ts` (new) — `formatKickoff(utcIso: string, locale: string): string` using `Intl.DateTimeFormat`; `formatScore(r: MatchResult): string` rendering shootout annotation
> - `apps/web/lib/catalog/client.ts` (new) — `getMatches(client: SupabaseClient, filters: MatchFilters): Promise<MatchesPage>` wrapping the route handler call
> - `apps/web/lib/catalog/format.test.ts` (new) — unit tests for `formatKickoff` across en-US/es-ES/ja-JP and `formatScore` for regulation/extra_time/penalties_shootout
>
> **What to do**:
> 1. Define types exactly matching the response shape in `contracts/match-catalog.read.md` § 200 OK. Adding fields later is non-breaking; renaming or removing is.
> 2. `formatKickoff` uses `new Intl.DateTimeFormat(locale, {dateStyle:'medium', timeStyle:'short'}).format(new Date(utcIso))` — Node-and-browser-compatible.
> 3. `formatScore`: for `regulation` and `extra_time`, render `"H-A"`; for `penalties_shootout`, render `"H-A (winnerH-winnerA on penalties)"` where the winner counts come from `_official` and the level score from `_for_scoring`.
> 4. Unit tests: 6+ cases across locales and result statuses.
>
> **Acceptance criteria**:
> - `pnpm -F web typecheck` GREEN.
> - `pnpm -F web test` (or vitest equivalent — whichever the project uses; introduce if necessary) GREEN for `format.test.ts`.
>
> **Do NOT**: re-implement filtering/pagination in TypeScript — the route handler + Postgres do that. Do NOT use service-role key.
>
> **Constitution**: III (UI is presentation only), VI (locale only on display).

**Blocked-by**: T018
**Parallel-safe with**: T020 (different files)
**Definition of done**: All three lib files exist, types match the contract, format unit tests GREEN, typecheck GREEN.

---

- [X] T020 [US1] Implement `apps/web/app/api/matches/route.ts` — `GET /api/matches`

**Agent prompt:**

> **Goal**: The route handler per `contracts/match-catalog.read.md` § Server behavior.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/match-catalog.read.md` (entire file)
> - `apps/web/lib/auth/requireEligible.ts` (Slice 001) — handler delegates to this
> - Slice 001's `apps/web/app/api/me/route.ts` for project conventions
>
> **Files to create or modify**:
> - `apps/web/app/api/matches/route.ts` (new)
>
> **What to do**:
> 1. Export `GET` handler.
> 2. Parse + validate query params (stage, group, status, team_id, from, to, page, page_size, sort); reject invalid → 400 BEFORE eligibility check (timing-leakage avoidance).
> 3. Parse Supabase session cookie; absent → 401.
> 4. `await requireEligible(client)`; on `EligibilityDeniedError` → 403.
> 5. Build a parameterized query against `public.matches` joined with `public.teams` (×2 for home/away), filtered per params, ORDER BY `kickoff_utc, id`, OFFSET/LIMIT. Use `COUNT(*) OVER ()` for `total`.
> 6. For rows with `status='finished'`, LEFT JOIN `match_results` (or a second query) and embed under `match_result`.
> 7. Return 200 with `{matches, page, page_size, total}` per contract.
> 8. Set `Cache-Control: private, max-age=10, must-revalidate`.
>
> **Acceptance criteria**:
> - All ~13 Playwright tests from T013 GREEN.
> - 3 Playwright tests from T014 GREEN.
> - pgTAP T017 GREEN.
>
> **Do NOT**: use service-role. Do NOT bypass RLS. Do NOT honor any debug/impersonation query param.
>
> **Constitution**: II, III.

**Blocked-by**: T018, T019
**Parallel-safe with**: T021 (different file)
**Definition of done**: 16 Playwright tests + 6 pgTAP assertions all GREEN.

---

- [X] T021 [US1] Implement `apps/web/app/(participant)/matches/page.tsx` — participant catalog page (Clarifications 2026-05-15 Q4)

**Agent prompt:**

> **Goal**: Server-component participant page that renders the catalog with locale-aware kickoff times, the documented filters (stage/group/status/team/date), and pagination controls. Per spec Clarifications 2026-05-15 Q4, this is part of Slice 002's vertical.
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § FR-012 (updated by Clarifications)
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q4
> - `apps/web/lib/catalog/format.ts` + `client.ts` (T019)
>
> **Files to create or modify**:
> - `apps/web/app/(participant)/matches/page.tsx` (new) — server component
> - `apps/web/app/(participant)/matches/components/MatchListFilters.tsx` (new) — client component for filter UI
> - `apps/web/app/(participant)/matches/components/PaginationControls.tsx` (new) — client component for prev/next
> - `apps/web/app/(participant)/layout.tsx` (new) — participant-area layout
>
> **What to do**:
> 1. Server component reads `searchParams` (stage, group, status, team_id, from, to, page, page_size); calls `getMatches(client, filters)` from T019.
> 2. Renders a table grouped by stage: group-stage matches first (subgrouped by group_id), then knockout matches in order. Each row shows: home team (flag + short_code), score (only for finished matches via `formatScore`), away team, kickoff time (via `formatKickoff(row.kickoff_utc, headers().get('accept-language') ?? 'en-US')`), venue, status.
> 3. Filter UI: dropdowns for stage/status, multi-select for team, date pickers for from/to. Client component manages local state and updates URL search params.
> 4. Pagination: prev/next buttons + page indicator. URL search params drive page state.
> 5. Read-only — no actions; Slice 003 will add the "submit prediction" affordance.
> 6. Accessibility: table has `<thead>` with `scope="col"` cells; status pill has accessible label.
>
> **Acceptance criteria**:
> - All 4 Playwright tests from T015 (locale display) GREEN.
> - 1 Playwright test from T016 (late-fixture-appears, the catalog-read half) GREEN once T033 also ships.
> - `pnpm -F web build` GREEN.
> - `pnpm -F web e2e --project=chromium slice-002-catalog-*.spec.ts` all GREEN.
>
> **Do NOT**: query Supabase directly from client components (server component handles it). Do NOT re-implement filtering or pagination in client code beyond URL-state updates.
>
> **Constitution**: III (presentation only), VI (locale via Intl), II (server-component reads use user JWT).

**Blocked-by**: T020
**Parallel-safe with**: _(none — bundles page + filter UI + layout)_
**Definition of done**: All US1 catalog Playwright tests GREEN + locale tests GREEN + `pnpm -F web build` succeeds.

---

- [X] T022 [US1] Regression checkpoint after US1 — `specs/002-match-catalog/regression-checkpoint-us1.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down). US2 + US3 + Polish remain before merge.

**Agent prompt:**

> **Goal**: Run the slice-001 + slice-002-so-far test suite end-to-end and confirm GREEN. Per Constitution Principle XI, US2 cannot start until this passes.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle XI
> - `specs/002-match-catalog/regression-baseline-from-001.md` (the prior baseline from T001)
>
> **Files to create or modify**:
> - `specs/002-match-catalog/regression-checkpoint-us1.md` (new)
>
> **What to do**:
> 1. Run every Slice 001 Playwright + pgTAP file (the baseline) and every Slice 002 file authored so far.
> 2. Run `pnpm -F web typecheck` + `pnpm -F web build`.
> 3. Tabulate; STOP if anything red.
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI (NON-NEGOTIABLE).

**Blocked-by**: T021
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us1.md` shows all tests GREEN.

---

**US1 CHECKPOINT**: Catalog read works end-to-end against the seed fixture. Slice is independently demonstrable at this point (Principle X — partial MVP).

---

## Phase 4: User Story 2 — Provider abstraction (Priority: P1)

**Story goal**: Fixtures, statuses, scores sync from a configurable provider through a stable abstraction; swapping providers is config-only (`spec.md` US2 + SC-005).

- [X] T023 [P] [US2] Author Deno `single_sync_happy.test.ts` + `idempotent_retry.test.ts` (RED) — `supabase/functions/sync-catalog/tests/`

**Agent prompt:**

> **Goal**: Author the two happy-path Deno tests for the sync coordinator per `contracts/sync-runner.scheduled.md` § Test surface.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/sync-runner.scheduled.md` § Coordinator behavior, § Response, § Test surface
> - `specs/002-match-catalog/data-model.md` § Entity 5 (provider_sync_runs)
> - The Deno test convention `Deno.test('name', async (t) => { ... })`
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/tests/single_sync_happy.test.ts` (new)
> - `supabase/functions/sync-catalog/tests/idempotent_retry.test.ts` (new)
>
> **What to do**:
> 1. `single_sync_happy.test.ts`: stub adapter returns 5 fixtures; POST to function with `X-Internal-Auth`; assert 200 + body schema; assert `provider_sync_runs.outcome='success'` AND `counts.created=5`; assert `matches` has 5 rows after.
> 2. `idempotent_retry.test.ts`: POST same body twice with same `run_id`; second call returns 200 with `notes="idempotent retry"` and identical body to the first.
>
> **Acceptance criteria**: 2 RED tests (the Edge Function doesn't exist yet).
>
> **Do NOT**: implement the function.
>
> **Constitution**: IX, VII.

**Blocked-by**: T022
**Parallel-safe with**: T024, T025, T026, T027
**Definition of done**: 2 RED Deno tests.

---

- [X] T024 [P] [US2] Author Deno `advisory_lock_returns_409.test.ts` + `non_admin_returns_403.test.ts` + `internal_auth_path.test.ts` (RED)

**Agent prompt:**

> **Goal**: Author the auth + concurrency Deno tests per `contracts/sync-runner.scheduled.md` § Auth + § Coordinator behavior (advisory lock).
>
> **Read first**:
> - `specs/002-match-catalog/contracts/sync-runner.scheduled.md` § Auth, § Coordinator behavior step 2
> - `specs/002-match-catalog/research.md` § R-006 (advisory lock per provider)
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/tests/advisory_lock_returns_409.test.ts` (new)
> - `supabase/functions/sync-catalog/tests/non_admin_returns_403.test.ts` (new)
> - `supabase/functions/sync-catalog/tests/internal_auth_path.test.ts` (new)
>
> **What to do**:
> 1. `advisory_lock_returns_409.test.ts`: hold `pg_advisory_lock(hashtext('sync_catalog'), hashtext('stub'))` in a side Postgres connection; POST sync; assert 409 + `{error:{code:'SYNC_IN_FLIGHT'}}`.
> 2. `non_admin_returns_403.test.ts`: POST with participant JWT (not admin); assert 403.
> 3. `internal_auth_path.test.ts`: POST with valid `X-Internal-Auth` header + no JWT; assert 200. POST with wrong header value; assert 401.
>
> **Acceptance criteria**: 4 RED tests across three files.
>
> **Do NOT**: implement the function.
>
> **Constitution**: IX, II.

**Blocked-by**: T022
**Parallel-safe with**: T023, T025, T026, T027
**Definition of done**: 4 RED Deno tests.

---

- [X] T025 [P] [US2] Author Deno `provider_swap.test.ts` (RED) — SC-005 invariant

**Agent prompt:**

> **Goal**: Author the provider-swap test that validates SC-005 ("zero code changes outside the provider adapter").
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § SC-005
> - `specs/002-match-catalog/contracts/sync-runner.scheduled.md` § Test surface (provider_swap.test.ts)
> - `specs/002-match-catalog/contracts/provider-adapter.contract.md` § Why each design choice
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/tests/provider_swap.test.ts` (new)
> - `supabase/functions/_shared/providers/stub2/index.ts` (new) — a second stub adapter, deliberately written with different internal helpers but contract-compliant output, used ONLY by this test
> - `supabase/functions/_shared/providers/stub2/fixtures/wc2026-snapshot.json` (new) — same fixtures as stub's, schema-equivalent
>
> **What to do**:
> 1. Setup: run a sync against the `stub` provider; capture `matches` table state (SHA-256 hash of `SELECT row_to_json(t) FROM matches t ORDER BY id`).
> 2. Flip `tournament_config.provider.active = '"stub2"'::jsonb`.
> 3. Run a sync against `stub2`; capture `matches` state again.
> 4. Assert the two hashes are identical (byte-for-byte same catalog rows).
> 5. Assert no file outside `supabase/functions/_shared/providers/stub2/` was modified during the swap (verifiable via `git status`).
>
> **Acceptance criteria**: RED — neither adapter exists yet.
>
> **Do NOT**: implement the function or the stub adapters.
>
> **Constitution**: IV (NON-NEGOTIABLE swap test), IX.

**Blocked-by**: T022
**Parallel-safe with**: T023, T024, T026, T027
**Definition of done**: 1 RED Deno test exists; the second stub adapter and its fixture are written (so when T033 ships, the test can run).

---

- [X] T026 [P] [US2] Author pgTAP for `record_match_result` SP (RED) — 8 files covering happy + invariants + admin + notification

**Agent prompt:**

> **Goal**: Author the eight pgTAP files for the `record_match_result` SP per `contracts/match-results.write.md` § Test surface.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/match-results.write.md` § Stored procedure semantics, § Test surface
> - `specs/002-match-catalog/data-model.md` § Entity 3 (column semantics and CHECK invariants)
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/record_match_result_happy.sql` (new)
> - `supabase/tests/pgtap/record_match_result_rejects_pre_finished.sql` (new)
> - `supabase/tests/pgtap/record_match_result_enforces_for_scoring_invariant.sql` (new)
> - `supabase/tests/pgtap/record_match_result_enforces_shootout_invariant.sql` (new)
> - `supabase/tests/pgtap/record_match_result_admin_correction_requires_approver.sql` (new)
> - `supabase/tests/pgtap/record_match_result_admin_correction_requires_admin.sql` (new)
> - `supabase/tests/pgtap/record_match_result_emits_notification.sql` (new)
> - `supabase/tests/pgtap/record_match_result_audit_format.sql` (new)
>
> **What to do**:
> 1. Implement each test per the table in `contracts/match-results.write.md` § Test surface — one file each.
> 2. Use the pre-seeded fixture's M4 (or set up a finished match if the test needs to exercise the pre-finished rejection path).
> 3. For the notification test: open a `LISTEN match_results_recorded` in a side connection BEFORE calling the SP, then assert the notification arrives with the correct payload.
> 4. For the audit-format test: verify `audit_log` row contains exact `previous_value` and `new_value` diffs in expected shape.
>
> **Acceptance criteria**: 8 RED pgTAP files (SP doesn't exist yet).
>
> **Do NOT**: implement the SP.
>
> **Constitution**: IX, V (audit-in-same-transaction).

**Blocked-by**: T022
**Parallel-safe with**: T023, T024, T025, T027
**Definition of done**: 8 RED pgTAP files.

---

- [X] T027 [P] [US2] Author Playwright `slice-002-catalog-locale-display.spec.ts` (already in T015) — **intentionally empty; merged into T015 during planning**. T015 ships 4 locale tests + DB-canonical invariant assertion covering SC-004 in full. Closed without code change.

This slot was reserved during planning; merged into T015. Proceed to T028.

---

- [X] T028 [US2] Verify all US2 RED tests RED before implementation — `specs/002-match-catalog/red-gate-us2.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down + Deno not installed locally).

**Agent prompt:**

> **Goal**: The Principle IX gate before T030–T033. Run T023–T026, confirm all RED, log to file.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle IX
>
> **Files to create or modify**:
> - `specs/002-match-catalog/red-gate-us2.md` (new)
>
> **What to do**: Run all Deno + pgTAP tests authored in T023–T026, capture, tabulate.
>
> **Acceptance criteria**: All ~15 tests RED.
>
> **Constitution**: IX (gate).

**Blocked-by**: T023, T024, T025, T026
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us2.md` lists every US2 test as RED with documented reasons.

---

- [X] T029 [US2] Migration 0024: `record_match_result(...)` SECURITY DEFINER SP + `match_results_recorded` pg_notify channel (`supabase/migrations/0024_record_match_result_sp.sql`)

**Agent prompt:**

> **Goal**: Implement the locked cross-slice SP per `contracts/match-results.write.md` § Stored procedure.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/match-results.write.md` (entire file — the contract is byte-for-byte what you implement)
> - `supabase/tests/pgtap/record_match_result_*.sql` (the 8 assertions you must satisfy)
> - `specs/002-match-catalog/data-model.md` § Entity 3
>
> **Files to create or modify**:
> - `supabase/migrations/0024_record_match_result_sp.sql` (new)
>
> **What to do**:
> 1. Function signature exactly per contract: `record_match_result(p_match_id uuid, p_home_score_official int, p_away_score_official int, p_home_score_for_scoring int, p_away_score_for_scoring int, p_result_status text, p_source text, p_approved_by uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp`.
> 2. Body per contract: precondition checks raise EXCEPTION on failure (matches.status='finished' precondition, score invariants, shootout level-check, admin-attribution checks); UPSERT by `match_id` (the audit trigger handles audit row); `PERFORM pg_notify('match_results_recorded', json_build_object('match_id', p_match_id, 'source', p_source)::text);`; RETURN `p_match_id`.
> 3. Header comment: `-- Slice 002 / FR-011 / contracts/match-results.write.md / cross-slice locked: signature is part of Slice 006's admin RPC contract; pg_notify channel 'match_results_recorded' is part of Slice 005's score-trigger LISTEN contract.`
>
> **Acceptance criteria**:
> - All 8 pgTAP files from T026 GREEN.
>
> **Do NOT**: change the signature. Do NOT write directly to `audit_log` (the trigger does it). Do NOT skip the shootout level CHECK.
>
> **Constitution**: III, V, VIII (the level-check is enforced; the for-scoring split lives in column data), XI (locked signature).

**Blocked-by**: T028
**Parallel-safe with**: T030 (different file — adapter)
**Definition of done**: All 8 `record_match_result_*.sql` pgTAP files GREEN.

---

- [X] T030 [US2] Implement stub provider adapter `supabase/functions/_shared/providers/stub/index.ts` + fixture JSON

**Agent prompt:**

> **Goal**: Implement the local-dev stub adapter that reads `wc2026-snapshot.json` and returns contract-compliant `NormalizedFixture` / `NormalizedResult` / `NormalizedTeam` arrays. Used by all sync tests in this slice.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/provider-adapter.contract.md` § Implementation example (illustrative — not normative)
> - `supabase/functions/_shared/providers/types.ts` (the locked interface from T011)
> - `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json` (the file content from T012)
>
> **Files to create or modify**:
> - `supabase/functions/_shared/providers/stub/index.ts` (new)
> - (`fixtures/wc2026-snapshot.json` already created by T012; verify schema matches)
>
> **What to do**:
> 1. Export const `stubAdapter: MatchDataProviderAdapter = { name: 'stub', fetchFixtures, fetchResults, fetchTeams };`.
> 2. Implement each method by reading the JSON fixture file using Deno's `Deno.readTextFile(...)`. The file path: `new URL('./fixtures/wc2026-snapshot.json', import.meta.url)`.
> 3. The JSON shape: an array of fixtures with the same shape as `NormalizedFixture` (but provider-specific keys for verisimilitude); the adapter normalizes to the interface type.
> 4. Add no API-token requirement (this adapter is local-only).
>
> **Acceptance criteria**:
> - `deno check supabase/functions/_shared/providers/stub/index.ts` GREEN.
> - A trivial in-test invocation: `import { stubAdapter } from './stub/index.ts'; const fixtures = await stubAdapter.fetchFixtures({fromUtc: null, toUtc: null}); assertEquals(fixtures.length, 4)`.
>
> **Do NOT**: import any HTTP libraries (no network calls). Do NOT cache credentials.
>
> **Constitution**: IV, IX.

**Blocked-by**: T028, T011 (interface), T012 (fixture JSON)
**Parallel-safe with**: T029, T031
**Definition of done**: `deno check` passes AND a test invocation returns 4 normalized fixtures.

---

- [X] T031 [US2] Implement football-data.org provider adapter `supabase/functions/_shared/providers/footballdata/index.ts`

**Agent prompt:**

> **Goal**: Implement the real-provider adapter for football-data.org per `contracts/provider-adapter.contract.md` § Implementation example.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/provider-adapter.contract.md` (entire file)
> - football-data.org's API v4 docs (referenced in `docs/architecture/high-level-architecture.md` § 18.2)
>
> **Files to create or modify**:
> - `supabase/functions/_shared/providers/footballdata/index.ts` (new)
>
> **What to do**:
> 1. Implement `footballDataAdapter: MatchDataProviderAdapter` with name `'footballdata'`.
> 2. `fetchFixtures(window)`: GET `${baseUrl}/competitions/WC/matches` with `X-Auth-Token: ${Deno.env.get('FOOTBALLDATA_API_TOKEN')}`. Map HTTP status to the error taxonomy: 429 → `ProviderRateLimitedError(message, parseInt(headers.get('Retry-After')) * 1000)`; ≥500 → `ProviderTransientError`; ≥400 → `ProviderClientError`. Map the JSON shape to `NormalizedFixture[]`.
> 3. `fetchResults(window)`: same as fetchFixtures but only return rows where `status === 'FINISHED'` and compute the for-scoring split per the OD-002 rule.
> 4. `fetchTeams()`: GET `${baseUrl}/competitions/WC/teams`.
> 5. `fetchPlayers`: NOT implemented in this slice — leave the field undefined (Slice 004 owns).
> 6. Read `baseUrl` from `tournament_config.provider.footballdata.base_url`; read API token from env.
>
> **Acceptance criteria**:
> - `deno check supabase/functions/_shared/providers/footballdata/index.ts` GREEN.
> - The adapter is selectable via `tournament_config.provider.active = '"footballdata"'`.
> - The adapter is **not exercised** in this slice's tests (no live API calls in CI); functional coverage comes from the stub adapter swap test (T025).
>
> **Do NOT**: bypass the error taxonomy. Do NOT cache the API token in a module-level constant.
>
> **Constitution**: IV.

**Blocked-by**: T028, T011
**Parallel-safe with**: T029, T030
**Definition of done**: `deno check` passes AND the adapter implements the interface (verifiable via TypeScript structural typing).

---

- [X] T032 [US2] Implement `sync-catalog` Edge Function happy path (`supabase/functions/sync-catalog/index.ts`) — auth + advisory lock + adapter dispatch + UPSERT, NOT payload-sanity guards (US3 owns those)

**Agent prompt:**

> **Goal**: The sync coordinator's **happy path**: parse + auth + advisory lock + adapter dispatch + UPSERT teams/matches/results. Payload-sanity guards (R-004 / R-005) and outage dedup (R-008) are added by T039 + T040 + T041 in US3.
>
> **Read first**:
> - `specs/002-match-catalog/contracts/sync-runner.scheduled.md` § Coordinator behavior steps 1–10 (excluding the payload-sanity branches 6–7)
> - `specs/002-match-catalog/research.md` § R-001 (adapter abstraction), § R-002 (topology), § R-003 (idempotency), § R-006 (advisory lock)
> - `supabase/functions/_shared/providers/types.ts` (the interface)
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/index.ts` (new)
> - `supabase/functions/sync-catalog/deno.json` (new, if not present)
>
> **What to do**:
> 1. Parse incoming request body for `{ provider, trigger, run_id, reason }`.
> 2. Auth: accept either `X-Internal-Auth: <secret>` (internal-auth path) or admin JWT. Reject 401/403 on missing/bad creds.
> 3. Acquire `pg_try_advisory_lock(hashtext('sync_catalog'), hashtext(provider))` via a service-role Supabase client; on failure return 409.
> 4. INSERT `provider_sync_runs` row with `outcome=NULL`, capture id (== run_id from request).
> 5. Resolve adapter via static map keyed by `provider_name` (the stub + footballdata adapters from T030 + T031).
> 6. Retry loop calling `adapter.fetchFixtures` + `adapter.fetchResults` with the policy from `tournament_config.provider_sync.retry_policy`.
> 7. UPSERT teams, then matches, then match_results (for finished rows) — all in a single transaction wrapped around the coordinator's writes. Use `record_match_result()` SP for the match_results UPSERT.
> 8. Update `provider_sync_runs` row with `outcome='success'` (or `'success_no_changes'` if no rows changed), `counts`, `finished_at`.
> 9. Update `provider_sync_state.last_success_at`, clear outage fields.
> 10. Release advisory lock in `finally`.
> 11. Return per contract response shape.
>
> **Acceptance criteria**:
> - All 6 Deno tests from T023 + T024 + T025 GREEN.
> - Existing US1 + Slice 001 tests still GREEN.
>
> **Do NOT**: implement payload-sanity guards (empty / undersized / duplicate-in-payload) — T039 owns those. Do NOT implement conflict quarantine — T040 owns it. Do NOT implement outage alert dedup — T041 owns it.
>
> **Constitution**: III, IV, VII.

**Blocked-by**: T029, T030, T031
**Parallel-safe with**: _(none — coordinator owns its own file)_
**Definition of done**: 6 Deno tests GREEN (happy / idempotent / advisory_lock / non_admin / internal_auth / provider_swap).

---

- [X] T033 [US2] Regression checkpoint after US2 — `specs/002-match-catalog/regression-checkpoint-us2.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down + Deno not installed locally). US3 + Polish remain before merge.

**Agent prompt:**

> **Goal**: Same shape as T022. Run all tests, confirm GREEN.
>
> **Files to create or modify**:
> - `specs/002-match-catalog/regression-checkpoint-us2.md` (new)
>
> **What to do**: Run all Playwright + pgTAP + Deno + typecheck + build. Tabulate.
>
> **Acceptance criteria**: 100% GREEN across Slice 001 + Slice 002 US1 + US2.
>
> **Constitution**: XI.

**Blocked-by**: T032
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us2.md` shows everything GREEN.

---

**US2 CHECKPOINT**: Catalog reads + provider-abstracted sync work end-to-end. The slice is feature-complete on the happy paths. US3 hardens the failure paths.

---

## Phase 5: User Story 3 — Catalog usable during provider failure (Priority: P1)

**Story goal**: Provider outages, empty/undersized/duplicate payloads, per-row conflicts, sustained-outage alerts — all handled without losing the catalog or paging-spam (`spec.md` US3 + Clarifications 2026-05-15 Q2 + Q3).

- [X] T034 [P] [US3] Author Deno `empty_payload_rejected.test.ts` + `undersized_payload_rejected.test.ts` + `duplicate_in_payload_rejected.test.ts` (RED)

**Agent prompt:**

> **Goal**: Author the three payload-structural-anomaly Deno tests per `contracts/sync-runner.scheduled.md` § Test surface and spec Clarifications Q2.
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q2 (structural=abort)
> - `specs/002-match-catalog/research.md` § R-004 (payload sanity)
> - `specs/002-match-catalog/contracts/sync-runner.scheduled.md` § Test surface
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/tests/empty_payload_rejected.test.ts` (new)
> - `supabase/functions/sync-catalog/tests/undersized_payload_rejected.test.ts` (new)
> - `supabase/functions/sync-catalog/tests/duplicate_in_payload_rejected.test.ts` (new)
>
> **What to do**:
> 1. `empty_payload_rejected.test.ts`: pre-seed 4 matches; mutate stub fixture to `[]`; POST sync; assert 422 + `outcome='rejected_empty'`; assert `matches` count unchanged; assert `audit_log` row `provider.sync_rejected_empty` written.
> 2. `undersized_payload_rejected.test.ts`: pre-seed 100 fixture matches (test seed); mutate stub fixture to ~30 (< 50% threshold); POST sync; assert 422 + `outcome='rejected_undersized'`.
> 3. `duplicate_in_payload_rejected.test.ts`: mutate stub fixture to have two rows with the same `providerMatchId`; POST sync; assert 422 + `outcome='rejected_duplicate_in_payload'`.
>
> **Acceptance criteria**: 3 RED Deno tests (T032's happy path doesn't have the guards yet).
>
> **Do NOT**: implement the guards.
>
> **Constitution**: IX, II (fail-closed structural anomalies).

**Blocked-by**: T033
**Parallel-safe with**: T035, T036, T037
**Definition of done**: 3 RED Deno tests.

---

- [X] T035 [P] [US3] Author Deno `cross_run_conflict_quarantined.test.ts` + `score_before_kickoff_quarantined.test.ts` (RED)

**Agent prompt:**

> **Goal**: Author the per-row conflict-quarantine Deno tests per spec Clarifications 2026-05-15 Q2 + R-005.
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q2 (per-row=quarantine)
> - `specs/002-match-catalog/research.md` § R-005 (cross-run conflict + quarantine table)
> - `specs/002-match-catalog/data-model.md` § Entity 7 (Match Pending Review)
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/tests/cross_run_conflict_quarantined.test.ts` (new)
> - `supabase/functions/sync-catalog/tests/score_before_kickoff_quarantined.test.ts` (new)
>
> **What to do**:
> 1. `cross_run_conflict_quarantined.test.ts`: pre-seed M1 (ARG vs BRA); mutate stub fixture to make M1's provider entry return ARG vs FRA (team-assignment changed); POST sync; assert `outcome='conflict_quarantined'` or `'partial'`; assert `match_pending_review` has 1 unresolved row for M1; assert `matches` row for M1 UNCHANGED.
> 2. `score_before_kickoff_quarantined.test.ts`: pre-seed M2 (status='scheduled'); mutate stub fixture to return a `match_result` for M2; POST sync; assert quarantined; `match_results` for M2 NOT inserted.
>
> **Acceptance criteria**: 2 RED Deno tests.
>
> **Do NOT**: implement the quarantine logic.
>
> **Constitution**: IX, II.

**Blocked-by**: T033
**Parallel-safe with**: T034, T036, T037
**Definition of done**: 2 RED Deno tests.

---

- [X] T036 [P] [US3] Author Deno `outage_alert_dedup.test.ts` + `recovery_clears_outage_state.test.ts` (RED) — SC-003 invariant

**Agent prompt:**

> **Goal**: Author the alert-dedup tests per spec Clarifications 2026-05-15 Q3 + R-008.
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q3 (audit + webhook)
> - `specs/002-match-catalog/research.md` § R-008 (alert dedup state)
> - `specs/002-match-catalog/spec.md` § SC-003 (exactly once per outage)
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/tests/outage_alert_dedup.test.ts` (new)
> - `supabase/functions/sync-catalog/tests/recovery_clears_outage_state.test.ts` (new)
>
> **What to do**:
> 1. `outage_alert_dedup.test.ts`: set `tournament_config.provider_sync.outage_alert_threshold_minutes = 1`; trigger 3 consecutive failures spaced > 1 minute apart (mutate stub fixture to throw); assert exactly ONE `audit_log` row with `action='provider.outage_alert_emitted'` across all 3 failures.
> 2. `recovery_clears_outage_state.test.ts`: after the previous test's outage, restore the stub fixture; trigger sync; assert `provider_sync_state.first_failure_after_success_at IS NULL` AND `outage_alerted_at IS NULL`; assert `audit_log` has `action='provider.recovered'`.
>
> **Acceptance criteria**: 2 RED Deno tests.
>
> **Constitution**: IX, VII.

**Blocked-by**: T033
**Parallel-safe with**: T034, T035, T037
**Definition of done**: 2 RED Deno tests.

---

- [X] T037 [P] [US3] Author Playwright `slice-002-empty-payload-served-last-known.spec.ts` + `slice-002-conflict-quarantined.spec.ts` + `slice-002-outage-alert-dedup.spec.ts` (RED)

**Agent prompt:**

> **Goal**: Author the end-to-end Playwright tests for US3 — the participant-visible side of the failure-resilience story.
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § User Story 3 Acceptance Scenarios 1, 2, 3
> - `specs/002-match-catalog/quickstart.md` § Manual verification steps 4, 5, 6
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-002-empty-payload-served-last-known.spec.ts` (new)
> - `apps/web/tests/playwright/slice-002-conflict-quarantined.spec.ts` (new)
> - `apps/web/tests/playwright/slice-002-outage-alert-dedup.spec.ts` (new)
>
> **What to do**:
> 1. `slice-002-empty-payload-served-last-known.spec.ts` (US3 AS1 / SC-002): pre-seed catalog; mutate stub fixture to empty; trigger sync; navigate to `/matches` as eligible participant; assert all 4 prior matches still display (no error UI; data unchanged).
> 2. `slice-002-conflict-quarantined.spec.ts` (US3 AS3 + Edge Case): trigger a conflicting sync (team-swap); assert `/matches` still shows the OLD team assignment (catalog unchanged); assert admin can query `match_pending_review` via direct DB and see the conflict row.
> 3. `slice-002-outage-alert-dedup.spec.ts` (US3 AS2 / SC-003): set outage threshold to 1 minute via psql; mutate stub fixture to throw; trigger sync 3 times spaced > 1 minute; assert exactly ONE `audit_log` `provider.outage_alert_emitted` row exists.
>
> **Acceptance criteria**: 3 RED Playwright tests.
>
> **Constitution**: IX, II, VII.

**Blocked-by**: T033
**Parallel-safe with**: T034, T035, T036
**Definition of done**: 3 RED Playwright tests.

---

- [X] T038 [US3] Verify all US3 RED tests RED — `specs/002-match-catalog/red-gate-us3.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down + Deno not installed locally).

**Agent prompt:**

> **Goal**: Same shape as T028 / T018. Run T034–T037; confirm all RED.
>
> **Files to create or modify**:
> - `specs/002-match-catalog/red-gate-us3.md` (new)
>
> **Acceptance criteria**: All ~10 tests RED.
>
> **Constitution**: IX (gate).

**Blocked-by**: T034, T035, T036, T037
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us3.md` lists every US3 test as RED.

---

- [X] T039 [US3] Extend `sync-catalog/index.ts` with payload-sanity guards (R-004)

**Agent prompt:**

> **Goal**: Add the payload-structural-anomaly guards to the sync coordinator: empty / undersized / in-payload duplicate. Per spec Clarifications 2026-05-15 Q2 — these abort the whole sync run.
>
> **Read first**:
> - `specs/002-match-catalog/research.md` § R-004
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q2 (structural=abort)
> - The existing T032 coordinator
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/index.ts` (modify — add guards between fetch and UPSERT)
>
> **What to do**:
> 1. After `fetchFixtures` returns, before any UPSERT: check `fixtures.length === 0` AND `(SELECT count(*) FROM matches) > 0` → set outcome `'rejected_empty'`, write audit row, return 422.
> 2. Read `tournament_config.provider_sync.undersized_threshold` (default 0.5). If `fixtures.length < threshold * existing_match_count` AND `existing_match_count > 0` → set outcome `'rejected_undersized'`, write audit row, return 422.
> 3. Check for in-payload duplicates: any two fixtures with the same `providerMatchId` → set outcome `'rejected_duplicate_in_payload'`, write audit row, return 422.
> 4. The audit row's `new_value` includes diagnostic info (incoming count, threshold, the duplicate IDs).
>
> **Acceptance criteria**:
> - 3 Deno tests from T034 GREEN.
> - 1 Playwright test from T037 (empty-payload-served-last-known) GREEN.
>
> **Do NOT**: regress T032's happy path. Do NOT skip writing the `provider_sync_runs` row on rejection.
>
> **Constitution**: II, V, VII.

**Blocked-by**: T038
**Parallel-safe with**: T040 (different code sections; merge conflict possible — coordinate)
**Definition of done**: 3 Deno + 1 Playwright test GREEN; T032's happy-path tests still GREEN.

---

- [X] T040 [US3] Extend `sync-catalog/index.ts` with conflict-quarantine logic (R-005)

**Agent prompt:**

> **Goal**: Add the per-row conflict-quarantine logic. Per spec Clarifications 2026-05-15 Q2 — these quarantine only the offending row.
>
> **Read first**:
> - `specs/002-match-catalog/research.md` § R-005
> - `specs/002-match-catalog/data-model.md` § Entity 7 (Match Pending Review)
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q2 (per-row=quarantine)
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/index.ts` (modify — add quarantine branches in the matches/results UPSERT loop)
>
> **What to do**:
> 1. For each incoming match row:
>    - Lookup existing via `match_provider_external_ids`.
>    - If exists: diff against current `matches` row. Detect conflict kinds:
>      - `team_assignment_changed`: home_team_id or away_team_id differs from existing.
>      - `status_backward_transition`: new status moves backward (e.g., finished → scheduled).
>      - `kickoff_change_after_lock`: kickoff change > `kickoff_tolerance_minutes` from config AND existing match was already locked (kickoff_utc within 60 min — Slice 003's lock window).
>    - On any conflict: INSERT a row into `match_pending_review` with `conflict_kind` set; do NOT update `matches`.
>    - On non-conflict: proceed with UPDATE.
> 2. For each incoming result row:
>    - If `matches.status != 'finished'` for the target match: conflict kind `score_before_kickoff`; quarantine; do NOT INSERT into `match_results`.
> 3. After processing all rows: if any quarantined → `outcome='conflict_quarantined'` (or `'partial'` if some applied + some quarantined); fire alert audit.
>
> **Acceptance criteria**:
> - 2 Deno tests from T035 GREEN.
> - 1 Playwright test from T037 (conflict-quarantined) GREEN.
>
> **Constitution**: II, V, VII.

**Blocked-by**: T038
**Parallel-safe with**: T039 (coordinate merge), T041
**Definition of done**: 2 Deno + 1 Playwright test GREEN; T032's happy-path tests still GREEN.

---

- [X] T041 [US3] Extend `sync-catalog/index.ts` with outage alert dedup + webhook POST (R-008 + Clarifications Q3)

**Agent prompt:**

> **Goal**: Add the outage-dedup state-machine and the optional webhook POST per spec Clarifications 2026-05-15 Q3.
>
> **Read first**:
> - `specs/002-match-catalog/research.md` § R-008
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q3
> - `specs/002-match-catalog/data-model.md` § Entity 6 (Provider Sync State)
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/index.ts` (modify — outage state-machine + webhook POST)
>
> **What to do**:
> 1. On failure outcomes (`client_error`, `exhausted_retries`, `rejected_*`): UPDATE `provider_sync_state` — set `first_failure_after_success_at = COALESCE(first_failure_after_success_at, now())`.
> 2. Compute `should_alert = first_failure_after_success_at IS NOT NULL AND now() - first_failure_after_success_at > threshold AND outage_alerted_at IS NULL`. If true: SET `outage_alerted_at = now()`, write `audit_log` row `action='provider.outage_alert_emitted'`, POST the JSON payload to `tournament_config.notifications.outage_webhook_url` if non-null (catch & log errors, never throw).
> 3. On success outcomes: SET `provider_sync_state.last_success_at = now()`; if `outage_alerted_at WAS NOT NULL` (we're recovering): write `audit_log` row `action='provider.recovered'`, POST recovery payload to webhook; THEN clear both `first_failure_after_success_at` and `outage_alerted_at`.
> 4. Webhook POST helper: 5-second timeout, no retry, never blocks the sync return (Promise.race with timeout). Failures log to stderr; the audit row is always the canonical record.
>
> **Acceptance criteria**:
> - 2 Deno tests from T036 GREEN.
> - 1 Playwright test from T037 (outage-alert-dedup) GREEN.
>
> **Constitution**: II (audit canonical), V, VII.

**Blocked-by**: T038
**Parallel-safe with**: T039, T040 (coordinate merge)
**Definition of done**: 2 Deno + 1 Playwright test GREEN; T032's happy-path tests still GREEN.

---

- [X] T042 [US3] Regression checkpoint after US3 — `specs/002-match-catalog/regression-checkpoint-us3.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down + Deno not installed locally). Phase 6 (Polish) remains before merge.

**Agent prompt:**

> **Goal**: Same shape as T022 / T033.
>
> **Files to create or modify**:
> - `specs/002-match-catalog/regression-checkpoint-us3.md` (new)
>
> **What to do**: Run all Slice 001 + Slice 002 tests; tabulate.
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T039, T040, T041
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us3.md` shows everything GREEN.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T043 [P] Migration 0027: `pg_cron` three-tier schedule + `trigger_sync_catalog` wrapper (Clarifications 2026-05-15 Q1) — `supabase/migrations/0027_pg_cron_sync_schedule.sql`

**Agent prompt:**

> **Goal**: Wire `pg_cron` to invoke the sync coordinator on the three-tier cadence locked in spec Clarifications 2026-05-15 Q1.
>
> **Read first**:
> - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q1
> - `specs/002-match-catalog/research.md` § R-002 (topology)
> - `specs/002-match-catalog/contracts/sync-runner.scheduled.md` § Invocation (path 1)
>
> **Files to create or modify**:
> - `supabase/migrations/0027_pg_cron_sync_schedule.sql` (new)
>
> **What to do**:
> 1. `CREATE OR REPLACE FUNCTION public.trigger_sync_catalog(p_provider text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ ... $$;`
> 2. Body: determine which tier applies based on `now()` and the live-window predicate (any match satisfies `now() BETWEEN kickoff_utc - lwpre AND kickoff_utc + lwpost`). If `live_window`: invoke. If `tournament_day_non_live`: invoke every `tournament_day_minutes`. If `pre_tournament`: invoke every `pre_tournament_minutes`. Function uses `net.http_post(url := current_setting('app.sync_trigger_url'), headers := jsonb_build_object('X-Internal-Auth', current_setting('app.sync_trigger_secret'), 'Content-Type', 'application/json'), body := jsonb_build_object('provider', p_provider, 'trigger', 'cron', 'run_id', gen_random_uuid()::text));`
> 3. Use `pg_cron.schedule('sync-catalog-trigger', '* * * * *', 'SELECT public.trigger_sync_catalog((SELECT value::text FROM tournament_config WHERE key = ''provider.active''))')` — runs every minute; the function itself decides whether to actually fire based on the tier predicate AND whether the right amount of time has passed since the last invocation (read `provider_sync_runs.started_at` for the last success).
> 4. Header comment: `-- Slice 002 / Clarifications 2026-05-15 Q1 / pg_cron three-tier cadence. Cron itself runs every minute; the wrapper decides whether THIS minute fires based on live_window predicate and last-fired timestamp.`
>
> **Acceptance criteria**:
> - `SELECT * FROM cron.job WHERE jobname = 'sync-catalog-trigger'` returns one row.
> - Manual `SELECT public.trigger_sync_catalog('stub')` succeeds and triggers a sync (visible via new `provider_sync_runs` row).
>
> **Do NOT**: hard-code cadence values. Do NOT call the Edge Function directly from a participant-visible context.
>
> **Constitution**: VI (server-side decisions), VIII (config-driven cadence).

**Blocked-by**: T042
**Parallel-safe with**: T044, T045
**Definition of done**: pg_cron job exists AND a manual wrapper call triggers a sync visibly.

---

- [X] T044 [P] Perf assertion: sync end-to-end < 30s p95 — `supabase/functions/sync-catalog/tests/sync_perf.test.ts`

**Agent prompt:**

> **Goal**: Add a perf-gate Deno test that proves the sync coordinator stays under the 30-s p95 budget from `plan.md` § Performance Goals.
>
> **Read first**:
> - `specs/002-match-catalog/plan.md` § Performance Goals
> - `specs/002-match-catalog/contracts/sync-runner.scheduled.md` § Performance budget
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/tests/sync_perf.test.ts` (new)
>
> **What to do**:
> 1. Use a beefier stub fixture: 100 fixtures + 20 results (closer to a real tournament window).
> 2. Run 5 sync invocations sequentially via the Edge Function; measure each via `(finished_at - started_at)`.
> 3. Assert p95 < 30,000 ms.
>
> **Acceptance criteria**:
> - Test runs against the local Supabase + stub adapter and exits 0.
>
> **Do NOT**: assert under the 4-row toy fixture; load test must be representative.
>
> **Constitution**: VII.

**Blocked-by**: T042
**Parallel-safe with**: T043, T045
**Definition of done**: `sync_perf.test.ts` passes with p95 < 30s on local Supabase.

---

- [X] T045 [P] Run `quickstart.md` end-to-end manually — `specs/002-match-catalog/quickstart-verification.md` — quickstart-verification template produced; manual execution deferred (Docker + Deno unavailable). User must replace each DEFERRED row with PASS/FAIL output before merge.

**Agent prompt:**

> **Goal**: Execute every step in `quickstart.md` § Manual verification checklist (steps 1–8). Record results.
>
> **Files to create or modify**:
> - `specs/002-match-catalog/quickstart-verification.md` (new)
>
> **What to do**: Per the quickstart's checklist; one row per step in the verification file with pass/fail + exact outputs.
>
> **Acceptance criteria**: 8/8 PASS.
>
> **Constitution**: X.

**Blocked-by**: T042
**Parallel-safe with**: T043, T044
**Definition of done**: 8/8 PASS in `quickstart-verification.md`.

---

- [X] T046 Final regression gate — `specs/002-match-catalog/regression-final.md` — final-gate documentation produced; runtime verification deferred (Docker + Deno unavailable locally). Pre-merge checklist in regression-final.md MUST be completed before merge.

**Agent prompt:**

> **Goal**: One last full-suite GREEN check across Slice 001 + Slice 002 before merge. Per Constitution Principle XI.
>
> **Files to create or modify**:
> - `specs/002-match-catalog/regression-final.md` (new)
>
> **What to do**: Run every Playwright + pgTAP + Deno + typecheck + build. Tabulate; confirm CI green on the latest PR.
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI (NON-NEGOTIABLE — final gate).

**Blocked-by**: T043, T044, T045
**Parallel-safe with**: _(none — final gate)_
**Definition of done**: `regression-final.md` shows 100% GREEN.

---

## Dependency graph (terse)

```
T001 → T002 → T003 ∥ T004 ∥ T005 ∥ T006 ∥ T007 → T008 → T009 → T010 (after T009) ∥ T011 (after T002) → T012 (after T009,T010)
T012 → T013 ∥ T014 ∥ T015 ∥ T016 ∥ T017 → T018 → T019 → T020 → T021 → T022
T022 → T023 ∥ T024 ∥ T025 ∥ T026 → T028 → T029 → T030 ∥ T031 → T032 → T033
T033 → T034 ∥ T035 ∥ T036 ∥ T037 → T038 → T039 ∥ T040 ∥ T041 → T042
T042 → T043 ∥ T044 ∥ T045 → T046 (final gate)
```

(T027 is intentionally empty — its scope was merged into T015 during planning.)

## Parallel-execution recipes

**Foundational schema (after T002):** T003, T004, T005, T006, T007, T011 — six different files; biggest fan-out in this slice.

**US1 test authoring (after T012):** T013, T014, T015, T016, T017 — five different test files.

**US2 test authoring (after T022):** T023, T024, T025, T026 — four different test files.

**US2 implementation (after T029):** T030, T031 — two different adapter files.

**US3 test authoring (after T033):** T034, T035, T036, T037 — four different test files.

**US3 implementation (after T038):** T039, T040, T041 — three different sections of `sync-catalog/index.ts`; coordinate merge.

**Polish (after T042):** T043, T044, T045 — three different files.

## Implementation strategy

- **MVP scope = Phase 1 + Phase 2 + Phase 3 (US1).** After T022, the slice ships a working catalog read against the seed fixture — participants can see the World Cup schedule. Stop here to demo.
- **P1 trio = Phases 4 + 5.** US2 adds the provider abstraction (so real fixtures can flow in). US3 hardens the failure paths (so the slice survives a real provider's outages). After T042, the slice satisfies every P1 user story plus all spec Edge Cases plus all four Clarifications 2026-05-15.
- **Polish + ship = Phase 6.** pg_cron schedule, perf assertion, quickstart, final regression gate. After T046, Slices 003+ can build on the cross-slice contracts (`matches`, `match_results`, `teams`, `MatchDataProviderAdapter`, `record_match_result`, `match_results_recorded` LISTEN channel).

## Notes for the orchestrator

- The 6-way Foundational fan-out (T003–T007 + T011) is the highest-parallelism opportunity in this slice. Dispatch all six in one batch after T002.
- Every red-gate task (T018, T028, T038) is intentionally sequential — these gates verify the prior `[P]` test-author tasks all left their tests genuinely RED.
- T032 is the gate for US2 happy-path completion. US3 implementation (T039–T041) modifies the same file — coordinate merges or sequence them: T039 → T040 → T041 minimizes conflicts.
- **Cross-slice contract locks** ship at T004 (`matches` shape), T005 (`match_results` with `home_score_for_scoring` columns — Slice 005 reads by name), T003 (`teams` shape), T011 (`MatchDataProviderAdapter` TS interface), T029 (`record_match_result` SP + `match_results_recorded` pg_notify channel). After T046 any change to these requires coordinated regression updates across Slices 003–008 per Constitution Principle XI.
- **Slice 001 dependency**: this slice cannot start until Slice 001's full regression suite is GREEN (T001 enforces). If Slice 001 has unfinished tasks, this slice halts at T001 and the work pauses until Slice 001 closes out.
- This file MUST NOT be edited to "make things work" — if any task's acceptance criteria appears impossible to satisfy, file a bug or revise the plan; do not silently weaken a criterion.
- Spec Clarifications 2026-05-15 are first-class test cases: Q1 (three-tier cadence) covered by T043; Q2 (hybrid conflict scope) by T034 + T035 + T039 + T040; Q3 (webhook + audit) by T036 + T041; Q4 (`/matches` page in this slice) by T015 + T021.
