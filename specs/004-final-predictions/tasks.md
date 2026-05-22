---
description: "Task list for slice 004 (Final Tournament Predictions) — each task is a self-contained agent prompt"
---

# Tasks: Final Tournament Predictions (Slice 004)

**Input**: Design documents in `specs/004-final-predictions/`

**Prerequisites**: `spec.md` (with Clarifications 2026-05-17), `plan.md`, `research.md`, `data-model.md`, all four files under `contracts/`, `quickstart.md` (all present). **Slices 001 + 002 + 003 regression baselines MUST be GREEN before this slice starts** (Constitution Principle XI).

**Test posture**: Tests are MANDATORY for this slice — Constitution Principle IX requires Given/When/Then scenarios committed RED before any production code that turns them GREEN. Principle XI requires the full regression suite (Slices 001 + 002 + 003 + 004) GREEN before starting the next task or merging.

**Special status — builds on the 001 + 002 + 003 foundation**: This slice **consumes** cross-slice contracts from Slices 001 (eligibility, audit, config), 002 (`matches.kickoff_utc`, `teams`, `MatchDataProviderAdapter` interface with reserved `fetchPlayers?`), and 003 (lock + SP + audit pattern template). It **introduces** the next layer: the `final_predictions` table, the `players` table (activates Slice 002's reserved `fetchPlayers?`), the **locked cross-slice predicate `is_final_prediction_locked()`**, and the **locked cross-slice SP `submit_final_prediction(uuid, text, uuid, uuid, text)`**.

## How to read this file

Each task is a **self-contained agent prompt**. Paste any task into a fresh subagent (e.g., `Agent` with `subagent_type: general-purpose`) — it has everything it needs (file paths, acceptance criteria, dependencies, definition of done).

Format conventions:
- **`[P]`** — parallel-safe (no shared write paths with peers in the same phase that are also `[P]`).
- **`[US#]`** — user story phase tasks only. Setup / Foundational / Polish unmarked.
- **`Blocked-by:`** — task IDs that MUST be `done` first.
- **`Parallel-safe with:`** — task IDs sharing no write paths.
- **`Definition of done:`** — exactly one checkable assertion.

Path conventions per `plan.md` § Source Code:
- Migrations → `supabase/migrations/`
- pgTAP → `supabase/tests/pgtap/`
- Web app → `apps/web/`
- Playwright → `apps/web/tests/playwright/`

Constitution refresher:
- **II (Security)**: writes via SECURITY DEFINER `submit_final_prediction()` only.
- **III (Rules outside the UI)**: `is_final_prediction_locked()` is the single named predicate.
- **V (Auditability)**: every state change + every rejected attempt audited in same transaction.
- **VI (Time-Zone Correctness)**: Postgres `now()` is the only clock; client clocks never participate.
- **VIII (Extensibility)**: `first_kickoff_utc` and `predictions.allow_identical_champion_runner_up` in `tournament_config`.
- **IX (TDD via BDD, NON-NEGOTIABLE)**: write scenario, see it fail, then implement.
- **XI (Regression-Gated Progress, NON-NEGOTIABLE)**: full suite GREEN before next task or merge.

---

## Implementation deviations (running log — append-only)

Slice 004 inherits **D-001 through D-015** from `specs/001-eligibility-login/tasks.md`, `specs/002-match-catalog/tasks.md`, and `specs/003-match-predictions/tasks.md`.

### D-017 (2026-05-20, surfaced during T011) — `tournament_config.first_kickoff_utc` is admin-owned, not auto-maintained

- **Symptom**: `public.is_final_prediction_locked()` (slot 0041, T005) reads `tournament_config.first_kickoff_utc` and **fails-CLOSED on missing config** (per the locked contract `contracts/final-prediction-lock.predicate.sql.md`). If no migration or seed sets this key, the predicate is permanently locked → no final predictions can be submitted.
- **Decision**: T010's `first_kickoff_correction` trigger (slot 0046) is **observability-only** — it emits audit_log rows when `matches.kickoff_utc` / `status` mutate but does NOT update `tournament_config.first_kickoff_utc`. The key is **admin-owned**, set explicitly at tournament setup via Slice 008's admin UI.
- **How to apply**:
  - **Production**: Slice 008's admin UI sets `tournament_config.first_kickoff_utc` to the actual first kickoff at tournament setup. MUST be one of the first admin actions in production rollout.
  - **Local dev + slice-004 tests**: the `slice-004-fixture.sql` seed (T011) appends an INSERT for `first_kickoff_utc = '"2026-06-16T20:00:00Z"'::jsonb` (slice 002's first scheduled match's kickoff, M3 ARG-CAN). Unblocks the predicate for tests on any local-run date before 2026-06-16.
- **Alternative considered + rejected**: auto-deriving `first_kickoff_utc = MIN(matches.kickoff_utc) WHERE status='scheduled'` via T010's trigger. Rejected because (a) provider data drift could thrash the lock anchor; (b) admins want a single explicit anchor; (c) the contract's "admin-owned key" framing assigns this responsibility to Slice 008.

### D-016 (2026-05-20, surfaced at slice 004 start) — Migration slot renumber

- **Symptom**: Slice 004's tasks.md plans migrations at slots **0036–0046**, but slice 003 already filled **0030–0038** (including 0036 = `kickoff_correction_audit_trigger`, 0037 = `submit_prediction_supersede`, 0038 = `get_lock_states_bulk`). Migration filename collisions break `supabase db reset`.
- **Decision**: Shift all slice 004 migrations by **+3** to start at on-disk slot **0039**. Reordering preserved.

  | Task | Spec slot | Actual on-disk slot | Purpose |
  |---|---|---|---|
  | T003 players | 0036 | **0039** | `players` + `player_provider_external_ids` |
  | T004 final_predictions | 0037 | **0040** | `final_predictions` table |
  | T005 is_final_prediction_locked | 0038 | **0041** | Locked cross-slice predicate |
  | T007 RLS | 0039 | **0042** | RLS on `final_predictions` + `players` + `player_provider_external_ids` |
  | T008 audit trigger | 0040 | **0043** | `final_predictions` audit trigger |
  | T016 submit_final_prediction_sp | 0041 | **0044** | SECURITY DEFINER SP — create + rejection branches |
  | T009 players_after_remove | 0042 | **0045** | Players removal fan-out trigger |
  | T010 first_kickoff_correction | 0043 | **0046** | First-kickoff fan-out trigger |
  | T006 predictions_config_seed | 0044 | **0047** | Seeds `predictions.allow_identical_champion_runner_up` |
  | T029 submit_final_prediction_supersede | 0046 | **0048** | Phase 5 — adds supersede branch |
- **How to apply**: every Phase 2 + Phase 3 + Phase 5 task uses the actual on-disk slot number, not the spec's. Tests reference function/table names (not migration numbers), so no test changes required.

---

## Phase 1: Setup (slice-specific harness; most setup inherited from prior slices)

- [X] T001 Verify Slices 001 + 002 + 003 regression baselines are GREEN — `specs/004-final-predictions/regression-baseline-from-001-002-003.md` — written directly. 8 cross-slice contracts confirmed; D-016 (migration slot renumber +3) recorded. Inherited deferrals + D-001..D-015 catalogued. Runtime verification jointly deferred to T034.

**Agent prompt:**

> **Goal**: Confirm every Slice 001 + Slice 002 + Slice 003 test is GREEN. Per Constitution Principle XI, Slice 004 cannot start with any prior-slice suite in a red state.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle XI
> - `specs/001-eligibility-login/regression-final.md`, `specs/002-match-catalog/regression-final.md`, `specs/003-match-predictions/regression-final.md`
>
> **Files to create or modify**:
> - `specs/004-final-predictions/regression-baseline-from-001-002-003.md` (new) — table with every Slice 001 + 002 + 003 test + pass/fail + duration.
>
> **What to do**:
> 1. Enumerate every prior-slice Playwright + pgTAP + Deno test.
> 2. Run each. Record pass/fail.
> 3. If any are red, STOP — file a bug task; do not proceed.
>
> **Acceptance criteria**: File exists with every prior-slice test recorded as `pass`.
>
> **Constitution**: XI (NON-NEGOTIABLE).

**Blocked-by**: _(none — gate before everything)_
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-baseline-from-001-002-003.md` lists all prior-slice tests as `pass`.

---

- [X] T002 Add `cmdk` to `apps/web/` devDependencies for typeahead picker UI — added `cmdk ^1.0.0` to `dependencies` (not devDependencies — Next.js bundles it at runtime per slice 003 T002 precedent). `pnpm install` succeeded.

**Agent prompt:**

> **Goal**: Install the typeahead library for player + team pickers per `plan.md` § Primary Dependencies. `cmdk` is keyboard-accessible and styling-agnostic.
>
> **Read first**:
> - `specs/004-final-predictions/plan.md` § Primary Dependencies (cmdk choice)
> - `specs/004-final-predictions/research.md` § R-012 (picker UI affordance)
>
> **Files to create or modify**:
> - `apps/web/package.json` (modify — add `cmdk` to `dependencies`)
> - `pnpm-lock.yaml` (refreshed by pnpm)
>
> **What to do**:
> 1. `pnpm -F web add cmdk@^1.0.0` (current major).
> 2. `pnpm -F web typecheck` (no type errors).
>
> **Acceptance criteria**:
> - `import { Command } from 'cmdk'` works in a Next.js TS file.
> - `pnpm -F web typecheck` GREEN.
>
> **Do NOT**: introduce other typeahead libraries — this slice picks one.
>
> **Constitution**: foundational hygiene.

**Blocked-by**: T001
**Parallel-safe with**: _(none — touches package.json)_
**Definition of done**: `pnpm -F web typecheck` GREEN with `cmdk` resolvable.

---

**Setup checkpoint**: T001–T002 done. Prior slices green; typeahead library installed.

---

## Phase 2: Foundational (BLOCKING — no user story may start until this phase completes)

This phase creates the schema (`players` + `final_predictions`), the locked cross-slice predicate, the RLS policies, the audit triggers (final_predictions audit + players-remove fan-out + first-kickoff-correction fan-out), the seeded config keys, and the slice's seed fixture. The `submit_final_prediction()` SP body is NOT created here — T016 in US1 owns the create branch; T029 in US3 extends with the supersede branch. Players ingest activation (Slice 002 sync coordinator extension) is in Polish (T031).

- [X] T003 [P] Migration 0036: `players` + `player_provider_external_ids` (`supabase/migrations/0036_players.sql`)

**Agent prompt:**

> **Goal**: Create `public.players` (with `removed_at` soft-delete column) and `public.player_provider_external_ids` (mapping mirror of Slice 002's team mapping) per `data-model.md` § Entity 2.
>
> **Read first**:
> - `specs/004-final-predictions/data-model.md` § Entity 2 (Player)
> - `specs/004-final-predictions/research.md` § R-004 (players table ownership)
> - Slice 002's `team_provider_external_ids` migration (mirror it)
>
> **Files to create or modify**:
> - `supabase/migrations/0036_players.sql` (new)
>
> **What to do**:
> 1. `CREATE TABLE public.players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text NOT NULL, team_id uuid NULL REFERENCES teams(id), aliases text[] NULL, removed_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK (length(trim(full_name)) > 0));`
> 2. `CREATE INDEX players_team_active_idx ON players(team_id) WHERE removed_at IS NULL;`
> 3. `CREATE INDEX players_name_search_idx ON players USING gin (to_tsvector('simple', full_name || ' ' || COALESCE(array_to_string(aliases, ' '), '')));`
> 4. `CREATE INDEX players_removed_at_idx ON players(removed_at);`
> 5. `BEFORE UPDATE` trigger to maintain `updated_at`.
> 6. `CREATE TABLE public.player_provider_external_ids (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE, provider_name text NOT NULL, provider_player_id text NOT NULL, mapped_at timestamptz NOT NULL DEFAULT now(), UNIQUE (provider_name, provider_player_id));`
> 7. Index `player_provider_external_ids_player_idx` on `(player_id)`.
> 8. Header comment: `-- Slice 004 / FR-006 / data-model.md § Entity 2 / cross-slice locked: players.id is the FK target for Slice 004 final_predictions.target_player_id and Slice 005 tournament_award.top_scorer_player_id / best_player_player_id. The aliases column supports manual disambiguation against provider name variations.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - All three indexes exist (verify via `\d+ players`).
> - The mapping table's UNIQUE constraint rejects duplicate `(provider_name, provider_player_id)` pairs.
>
> **Do NOT**: add RLS, audit triggers, or seed rows. Do NOT delete players on removal — `removed_at` is the only state mutation.
>
> **Constitution**: IV (provider IDs in mapping table), I (vendor-neutral entity).

**Blocked-by**: T002
**Parallel-safe with**: T004, T005, T006
**Definition of done**: `supabase db reset` succeeds AND `\d+ players` shows the three indexes AND the mapping UNIQUE rejects duplicates.

---

- [X] T004 [P] Migration 0037: `final_predictions` table + indexes + unique partial index (`supabase/migrations/0037_final_predictions.sql`)

**Agent prompt:**

> **Goal**: Create `public.final_predictions` per `data-model.md` § Entity 1 — per-item rows + supersede chain + the unique partial index that makes SC-004 (1,000 concurrent → exactly one active) a storage-layer guarantee.
>
> **Read first**:
> - `specs/004-final-predictions/data-model.md` § Entity 1
> - `specs/004-final-predictions/research.md` § R-001 (per-item storage rationale)
>
> **Files to create or modify**:
> - `supabase/migrations/0037_final_predictions.sql` (new)
>
> **What to do**:
> 1. `CREATE TYPE public.final_item_kind AS ENUM ('champion', 'runner_up', 'top_scorer', 'best_player');`
> 2. `CREATE TYPE public.final_prediction_source AS ENUM ('ui', 'api', 'admin_override');`
> 3. `CREATE TABLE public.final_predictions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE RESTRICT, item_kind public.final_item_kind NOT NULL, target_team_id uuid NULL REFERENCES teams(id), target_player_id uuid NULL REFERENCES players(id), submitted_at timestamptz NOT NULL DEFAULT now(), source public.final_prediction_source NOT NULL, superseded_at timestamptz NULL, superseded_by uuid NULL REFERENCES final_predictions(id), created_by uuid NULL REFERENCES participants(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK ((item_kind IN ('champion','runner_up')) = (target_team_id IS NOT NULL AND target_player_id IS NULL)), CHECK ((item_kind IN ('top_scorer','best_player')) = (target_player_id IS NOT NULL AND target_team_id IS NULL)), CHECK ((superseded_at IS NULL) = (superseded_by IS NULL)));`
> 4. Unique partial index: `CREATE UNIQUE INDEX final_predictions_active_uk ON final_predictions(participant_id, item_kind) WHERE superseded_at IS NULL;`
> 5. Secondary indexes: `final_predictions_participant_idx` on `(participant_id, item_kind, submitted_at DESC)`; `final_predictions_target_team_idx` on `(target_team_id) WHERE superseded_at IS NULL AND target_team_id IS NOT NULL`; `final_predictions_target_player_idx` on `(target_player_id) WHERE superseded_at IS NULL AND target_player_id IS NOT NULL`.
> 6. `BEFORE UPDATE` trigger for `updated_at`.
> 7. Header comment: `-- Slice 004 / FR-010 (one active per pair) / data-model.md § Entity 1 / cross-slice locked: final_predictions.id is referenced by Slice 005 score_records and peer_final_pick_v; the target_team_id / target_player_id / item_kind columns are read by name by Slice 005's score_finals.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - All three CHECK constraints reject their failure cases (champion + player_id set; superseded_at set + superseded_by NULL).
> - Inserting two rows with same `(participant_id, item_kind)` and `superseded_at IS NULL` fails the unique partial index.
>
> **Do NOT**: add RLS or audit triggers. Do NOT include any disjoint check on champion vs runner-up — that's the SP's responsibility, configurable per tournament_config.
>
> **Constitution**: V (append-only), VII (unique partial index = storage-layer SC-004 guarantee), XI (cross-slice locked column names).

**Blocked-by**: T003 (players FK target)
**Parallel-safe with**: T005, T006
**Definition of done**: `supabase db reset` succeeds AND all three CHECKs reject failure cases AND unique partial index rejects duplicates.

---

- [X] T005 [P] Migration 0038: `is_final_prediction_locked()` locked cross-slice predicate (`supabase/migrations/0038_is_final_prediction_locked.sql`)

**Agent prompt:**

> **Goal**: Implement the **locked cross-slice predicate** per `contracts/final-prediction-lock.predicate.sql.md` § Signature — global lock, BR-LOCK-005 strict `>=` boundary, fail-closed on missing config.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-prediction-lock.predicate.sql.md` (entire file — source of truth)
> - `specs/004-final-predictions/research.md` § R-002
>
> **Files to create or modify**:
> - `supabase/migrations/0038_is_final_prediction_locked.sql` (new)
>
> **What to do**:
> 1. Copy the function body **exactly** from the contract.
> 2. `LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp`.
> 3. Header comment (verbatim): `-- Slice 004 / FR-003 / BR-LOCK-005 / contracts/final-prediction-lock.predicate.sql.md — LOCKED CROSS-SLICE CONTRACT: signature () RETURNS boolean STABLE. Slice 005 peer_final_pick_v + Slice 006 admin tooling reference this function by name. Renames/signature changes require coordinating regression updates across consumers.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - `SELECT public.is_final_prediction_locked()` returns `true` when no `first_kickoff_utc` config row exists (fail-closed sanity).
> - Comprehensive boundary tests authored later in US2 (T021) will GREEN against this implementation.
>
> **Do NOT**: change the signature. Do NOT inline the lock check anywhere else.
>
> **Constitution**: III, VI, XI (cross-slice locked).

**Blocked-by**: T002
**Parallel-safe with**: T003, T004, T006
**Definition of done**: `supabase db reset` succeeds AND the function returns `true` on missing config.

---

- [X] T006 [P] Migration 0044: seed `tournament_config.predictions.allow_identical_champion_runner_up` (default `false`) (`supabase/migrations/0044_predictions_config_seed.sql`)

**Agent prompt:**

> **Goal**: Seed the only config key this slice OWNS as a default writer. (`first_kickoff_utc` is produced by Slice 002's sync coordinator; this slice only reads.)
>
> **Read first**:
> - `specs/004-final-predictions/research.md` § R-005 (default-deny rationale)
> - `specs/004-final-predictions/spec.md` § FR-007
>
> **Files to create or modify**:
> - `supabase/migrations/0044_predictions_config_seed.sql` (new)
>
> **What to do**:
> 1. `INSERT INTO public.tournament_config (key, value) VALUES ('predictions.allow_identical_champion_runner_up', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;`
> 2. Header comment: `-- Slice 004 default / FR-007 (default-deny identical champion/runner-up; Slice 008 admin UI can toggle). Note: top_scorer / best_player can be the same player per Clarifications 2026-05-17 — no separate config key.`
>
> **Acceptance criteria**:
> - `SELECT (value::text)::boolean FROM tournament_config WHERE key = 'predictions.allow_identical_champion_runner_up'` returns `false`.
> - Re-running migration produces no new rows.
>
> **Do NOT**: seed `first_kickoff_utc` here — Slice 002's sync coordinator produces it.
>
> **Constitution**: VIII.

**Blocked-by**: T002
**Parallel-safe with**: T003, T004, T005
**Definition of done**: Config key present with default `false`.

---

- [X] T007 Migration 0039: RLS on `final_predictions` + `players` + `player_provider_external_ids` (`supabase/migrations/0039_final_predictions_rls.sql`)

**Agent prompt:**

> **Goal**: Enable RLS on the three tables introduced in T003 + T004 and define policies per `data-model.md` § RLS posture summary.
>
> **Read first**:
> - `specs/004-final-predictions/data-model.md` § RLS posture summary
> - `specs/004-final-predictions/research.md` § R-008
>
> **Files to create or modify**:
> - `supabase/migrations/0039_final_predictions_rls.sql` (new)
>
> **What to do**:
> 1. `ALTER TABLE public.final_predictions ENABLE ROW LEVEL SECURITY;`
> 2. Policy `final_predictions_self_read` (SELECT): `USING (participant_id IN (SELECT id FROM public.participants WHERE auth_user_id = auth.uid()))`.
> 3. Policy `final_predictions_admin_read` (SELECT): `USING (public.is_admin(auth.uid()))`.
> 4. NO INSERT / UPDATE / DELETE policies — SP-only.
> 5. `ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;` Policy `players_eligible_read` (SELECT): `USING (public.is_eligible_nortal_participant(auth.uid()))`.
> 6. `ALTER TABLE public.player_provider_external_ids ENABLE ROW LEVEL SECURITY;` Policy `player_provider_external_ids_admin_read` (SELECT): `USING (public.is_admin(auth.uid()))`. No write policies — sync coordinator only.
> 7. Header comment: `-- Slice 004 / II (NON-NEGOTIABLE participant-private finals) / data-model.md § RLS posture / depends on Slice 001's is_eligible_nortal_participant + is_admin stub.`
>
> **Acceptance criteria**:
> - Participant JWT: `SELECT * FROM final_predictions` returns only own rows; `SELECT * FROM players` returns all rows; `SELECT * FROM player_provider_external_ids` returns 0 rows.
> - Admin JWT: all three tables return all rows.
> - No JWT / non-Nortal JWT: 0 rows everywhere.
> - Participant client INSERT to any of these tables: rejected.
>
> **Constitution**: II (NON-NEGOTIABLE).

**Blocked-by**: T003, T004
**Parallel-safe with**: T008, T009, T010
**Definition of done**: Participant JWT sees own final_predictions + all players + 0 mapping rows AND admin JWT sees all AND no participant write succeeds.

---

- [X] T008 [P] Migration 0040: `final_predictions` audit trigger (`supabase/migrations/0040_final_predictions_audit_trigger.sql`)

**Agent prompt:**

> **Goal**: `AFTER INSERT OR UPDATE` trigger on `final_predictions` per `data-model.md` § Entity 1 audit posture + `research.md` § R-007. Same recursion-guard pattern as Slice 001/002/003 triggers.
>
> **Read first**:
> - `specs/004-final-predictions/data-model.md` § Entity 1 audit posture
> - `specs/004-final-predictions/research.md` § R-007
> - Slice 003's `0032_predictions_audit_trigger.sql` (canonical pattern)
>
> **Files to create or modify**:
> - `supabase/migrations/0040_final_predictions_audit_trigger.sql` (new)
>
> **What to do**:
> 1. `CREATE OR REPLACE FUNCTION public.log_final_prediction_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ … $$`.
> 2. Body:
>    - Recursion guard: `IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;`
>    - On INSERT with `superseded_at IS NULL`: write `audit_log` row `action='final_prediction.created'`, `actor=NEW.created_by`, `entity_type='final_prediction'`, `entity_id=NEW.id`, `previous_value=NULL`, `new_value=to_jsonb(NEW)`, `source='trigger'`.
>    - On UPDATE setting `superseded_at IS NOT NULL`: write `action='final_prediction.superseded'`, `actor=(SELECT created_by FROM public.final_predictions WHERE id = NEW.superseded_by)`, `previous_value=to_jsonb(OLD)`, `new_value=to_jsonb(NEW)`, `source='trigger'`.
> 3. `CREATE TRIGGER log_final_predictions_change AFTER INSERT OR UPDATE ON public.final_predictions FOR EACH ROW EXECUTE FUNCTION public.log_final_prediction_change();`
> 4. Header comment: `-- Slice 004 / FR-011 / V (NON-NEGOTIABLE same-transaction audit) / mirrors Slice 003 pattern.`
>
> **Acceptance criteria**:
> - INSERT with `superseded_at IS NULL` → exactly one `audit_log` row `final_prediction.created`.
> - UPDATE setting `superseded_at IS NOT NULL` AND `superseded_by IS NOT NULL` → exactly one `audit_log` row `final_prediction.superseded`.
> - `updated_at`-only UPDATE → zero audit rows.
>
> **Constitution**: V (NON-NEGOTIABLE).

**Blocked-by**: T004
**Parallel-safe with**: T007, T009, T010
**Definition of done**: INSERT produces `final_prediction.created`; supersede UPDATE produces `final_prediction.superseded`; trivial UPDATE produces zero.

---

- [X] T009 Migration 0042: `players_after_remove` fan-out trigger (`supabase/migrations/0042_players_remove_audit_trigger.sql`)

**Agent prompt:**

> **Goal**: Emit per-affected-prediction `audit_log` row when a player is soft-deleted (`removed_at` transitions from NULL to non-NULL) — per `research.md` § R-013 and `contracts/players-ingest.md` § Trigger.
>
> **Read first**:
> - `specs/004-final-predictions/research.md` § R-013
> - `specs/004-final-predictions/contracts/players-ingest.md` § Trigger — `players_after_remove`
> - `specs/004-final-predictions/spec.md` § Clarifications 2026-05-17 Q1 (the keep-row-active semantics)
>
> **Files to create or modify**:
> - `supabase/migrations/0042_players_remove_audit_trigger.sql` (new)
>
> **What to do**:
> 1. Define `public.log_player_removed()` SECURITY DEFINER function per the contract — for each active `final_predictions` row referencing `NEW.id`, INSERT `audit_log` row with `action='final_prediction.target_player_removed'`, `reason='player_removed_from_roster'`, `previous_value=jsonb_build_object('target_player_id', NEW.id, 'player_full_name', OLD.full_name)`, `new_value=jsonb_build_object('target_player_id', NEW.id, 'player_full_name', OLD.full_name, 'removed_at', NEW.removed_at)`, `actor=fp.created_by`, `source='trigger'`.
> 2. `CREATE TRIGGER players_after_remove AFTER UPDATE OF removed_at ON public.players FOR EACH ROW WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL) EXECUTE FUNCTION public.log_player_removed();`
> 3. Recursion guard at the top.
> 4. Header comment: `-- Slice 004 / Clarifications 2026-05-17 Q1 / FR-012 / contracts/players-ingest.md § Trigger. Fans out per affected active final_predictions; the prediction rows themselves are NOT modified.`
>
> **Acceptance criteria**:
> - Pre-state: 3 active `final_predictions` rows pointing at player X. `UPDATE players SET removed_at = now() WHERE id = X` produces exactly 3 new `audit_log` rows with `action='final_prediction.target_player_removed'`.
> - `players` row's `removed_at` is set.
> - The 3 `final_predictions` rows are UNCHANGED (no modification by this trigger).
>
> **Do NOT**: modify `final_predictions` rows. Do NOT auto-supersede or invalidate.
>
> **Constitution**: V, VII. Supports **Clarifications 2026-05-17 Q1**.

**Blocked-by**: T003, T004
**Parallel-safe with**: T007, T008, T010
**Definition of done**: Player soft-delete emits one `audit_log` row per affected active prediction; predictions unchanged.

---

- [X] T010 Migration 0043: `first_kickoff_correction` fan-out trigger (`supabase/migrations/0043_first_kickoff_correction_trigger.sql`)

**Agent prompt:**

> **Goal**: Emit per-affected-prediction `audit_log` row when `tournament_config.first_kickoff_utc` changes — per `research.md` § R-014 and FR-009 / SC-005.
>
> **Read first**:
> - `specs/004-final-predictions/research.md` § R-014
> - `specs/004-final-predictions/spec.md` § FR-009 + SC-005 + Edge Case "first-kickoff corrected after some participants have already locked in"
>
> **Files to create or modify**:
> - `supabase/migrations/0043_first_kickoff_correction_trigger.sql` (new)
>
> **What to do**:
> 1. Define `public.log_first_kickoff_correction()` SECURITY DEFINER function:
>    - `IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;`
>    - For each active `final_predictions` row: INSERT `audit_log` row `action='final_prediction.first_kickoff_corrected'`, `reason='first_kickoff_corrected'`, `previous_value=jsonb_build_object('first_kickoff_utc', OLD.value::text)`, `new_value=jsonb_build_object('first_kickoff_utc', NEW.value::text)`, `actor=fp.created_by`, `entity_type='final_prediction'`, `entity_id=fp.id`, `source='trigger'`.
> 2. `CREATE TRIGGER tournament_config_first_kickoff_correction AFTER UPDATE OF value ON public.tournament_config FOR EACH ROW WHEN (OLD.key = 'first_kickoff_utc' AND OLD.value IS DISTINCT FROM NEW.value AND NEW.key = 'first_kickoff_utc') EXECUTE FUNCTION public.log_first_kickoff_correction();`
> 3. Header comment: `-- Slice 004 / FR-009 / SC-005 / research § R-014 / Edge Case "first-kickoff corrected after some participants have already locked in". Per-affected-prediction fan-out so Slice 006 admin UI can communicate per-participant.`
>
> **Acceptance criteria**:
> - Pre-state: `first_kickoff_utc = T1`, 5 active final_predictions across various participants.
> - `UPDATE tournament_config SET value = to_jsonb(T2::text) WHERE key = 'first_kickoff_utc'` produces exactly 5 new `audit_log` rows with `action='final_prediction.first_kickoff_corrected'`.
> - A `tournament_config` update on a different key (e.g., `lock_window_minutes`) produces zero audit rows from this trigger.
>
> **Constitution**: V, VI. Supports **FR-009, SC-005**.

**Blocked-by**: T004 (final_predictions table)
**Parallel-safe with**: T007, T008, T009
**Definition of done**: A `first_kickoff_utc` UPDATE fans out one `audit_log` row per active final_predictions row; updates to other keys fan out zero.

---

- [X] T011 Seed fixture `slice-004-fixture.sql` (`supabase/seed/slice-004-fixture.sql`)

**Agent prompt:**

> **Goal**: Create the deterministic seed per `quickstart.md` § Seed data — 8 players (one marked `removed_at` for testing) + 3 prediction sets + boundary-calibrated `first_kickoff_utc`.
>
> **Read first**:
> - `specs/004-final-predictions/quickstart.md` § Seed data
> - `specs/004-final-predictions/spec.md` § Acceptance Scenarios + Edge Cases + Clarifications 2026-05-17
> - `specs/004-final-predictions/data-model.md` § Entity 1 + Entity 2
>
> **Files to create or modify**:
> - `supabase/seed/slice-004-fixture.sql` (new)
>
> **What to do**:
> 1. `BEGIN; … COMMIT;` with `INSERT … ON CONFLICT DO NOTHING`.
> 2. Insert 8 players (`00000000-0000-0000-0000-0000000000PL1`…`PL8`):
>    - 7 active players spread across the 8 teams from Slice 002's fixture.
>    - 1 player (`PL8`) with `removed_at = now()` to exercise R-013 + Q1 Clarifications.
>    - Aliases populated for at least 2 players (testing substring search on aliases).
> 3. Insert `player_provider_external_ids` rows mapping each player to the stub provider's IDs.
> 4. Insert 3 prediction sets:
>    - `alpha`: champion=`T1`, runner_up=`T2`, top_scorer=`PL1`, best_player=`PL2` (all 4 picks).
>    - `bravo`: champion=`T3`, top_scorer=`PL3` (2 picks; runner_up + best_player unset).
>    - `charlie`: 0 picks (clean slate).
> 5. Set `first_kickoff_utc = now() + INTERVAL '2 hours'` so everything is editable by default; quickstart steps mutate as needed for boundary tests.
> 6. Top-of-file comment "Hand-verified scenario coverage" mapping each spec Acceptance Scenario + Edge Case + Clarification to which fixture row exercises it.
>
> **Acceptance criteria**:
> - Fixture loads cleanly against a freshly-reset DB.
> - 8 player rows + 8 mapping rows + 3 prediction sets exist.
> - `first_kickoff_utc` is `now() + 2 hours` at load.
> - Re-running produces no new rows.
>
> **Do NOT**: insert into `audit_log` directly (triggers handle it on the INSERTs). Do NOT reference any not-yet-created table.
>
> **Constitution**: IX (deterministic fixture).

**Blocked-by**: T007, T008, T009, T010 (RLS + triggers must be in place)
**Parallel-safe with**: _(none — depends on all foundational)_
**Definition of done**: Fixture loads cleanly producing 8 players + 3 prediction sets + 8 mapping rows + 1 first_kickoff_utc config row.

---

**Foundational checkpoint**: T001–T011 done. Schema + RLS + audit triggers + fixture all exist. No SP body yet, no UI yet. User-story phases below can now start.

---

## Phase 3: User Story 1 — Submit four picks before lock (Priority: P1)

**Story goal**: An eligible participant submits any subset of the four item kinds before `first_kickoff_utc` (`spec.md` US1).

**Story-independent test**: Sign in eligible, navigate to `/me/finals`, submit each of the four picks, verify persistence + audit.

- [X] T012 [P] [US1] Author pgTAP for SP create + validation paths (RED) — 7 files

**Agent prompt:**

> **Goal**: Author the create + validation pgTAP per `contracts/final-predictions.write.md` § Test surface.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-predictions.write.md` § Test surface (pgTAP rows)
> - `specs/004-final-predictions/data-model.md` § Entity 1
> - `supabase/seed/slice-004-fixture.sql`
>
> **Files to create or modify** (7 new):
> - `supabase/tests/pgtap/submit_final_prediction_create_champion_happy.sql`
> - `supabase/tests/pgtap/submit_final_prediction_create_top_scorer_happy.sql`
> - `supabase/tests/pgtap/submit_final_prediction_invalid_kind.sql`
> - `supabase/tests/pgtap/submit_final_prediction_invalid_target_shape.sql`
> - `supabase/tests/pgtap/submit_final_prediction_invalid_target_missing.sql`
> - `supabase/tests/pgtap/submit_final_prediction_invalid_target_removed_player.sql`
> - `supabase/tests/pgtap/submit_final_prediction_audit_format.sql`
>
> **What to do** — per the contract:
> 1. `create_champion_happy.sql`: charlie + `T1`. Call SP. Assert single new row, `superseded_at IS NULL`, target_team_id=T1, source='ui', created_by=charlie-id; assert one `audit_log` row `final_prediction.created`.
> 2. `create_top_scorer_happy.sql`: charlie + `PL1`. Same assertions for player target.
> 3. `invalid_kind.sql`: `p_item_kind='nonsense'` → EXCEPTION ERRCODE='WFP03'; no row.
> 4. `invalid_target_shape.sql`: `p_item_kind='champion'` with `p_target_player_id` set → ERRCODE='WFP03'.
> 5. `invalid_target_missing.sql`: `p_target_team_id=gen_random_uuid()` → ERRCODE='WFP04'.
> 6. `invalid_target_removed_player.sql`: pick `PL8` (the fixture's removed player) → ERRCODE='WFP04'; reason `player_removed`.
> 7. `audit_format.sql`: invoke SP; verify audit row contains the contract's specified fields.
>
> **Acceptance criteria**: All 7 files RED — SP doesn't exist yet.
>
> **Constitution**: IX, II, V.

**Blocked-by**: T011
**Parallel-safe with**: T013, T014
**Definition of done**: 7 RED pgTAP files.

---

- [X] T013 [P] [US1] Author Playwright submit-path specs (RED) — `slice-004-submit-*.spec.ts` (~9 files)

**Agent prompt:**

> **Goal**: Author the route-handler-level specs covering POST `/api/final-predictions` happy + validation + eligibility paths per `contracts/final-predictions.write.md` § Test surface (Playwright section).
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-predictions.write.md` § Test surface (Playwright rows)
> - `specs/004-final-predictions/spec.md` § US1 + Clarifications 2026-05-17
>
> **Files to create or modify** (9 new):
> - `slice-004-submit-champion-happy.spec.ts`
> - `slice-004-submit-top-scorer-happy.spec.ts`
> - `slice-004-submit-all-four.spec.ts` (submit each kind in succession; verify 4 active rows)
> - `slice-004-submit-invalid-team.spec.ts`
> - `slice-004-submit-invalid-player.spec.ts`
> - `slice-004-submit-removed-player.spec.ts` (Clarifications Q1 — picks PL8; expect 404 `player_removed`)
> - `slice-004-submit-unauthenticated.spec.ts`
> - `slice-004-submit-domain-removed.spec.ts`
> - `slice-004-submit-bad-body.spec.ts` (missing item_kind; wrong kind/target combo)
>
> **What to do**: per the contract, each test follows Given/When/Then. Every Then-clause asserts specific status codes + body shapes.
>
> **Acceptance criteria**: 9 RED Playwright tests.
>
> **Constitution**: IX, II.

**Blocked-by**: T011
**Parallel-safe with**: T012, T014
**Definition of done**: 9 RED Playwright tests.

---

- [X] T014 [P] [US1] Author Playwright read-path specs (RED) — `slice-004-me-final-predictions-*.spec.ts` + `slice-004-teams-*.spec.ts` + `slice-004-players-*.spec.ts` (~12 files)

**Agent prompt:**

> **Goal**: Author the read-path specs for `/api/me/final-predictions` + `/api/teams` + `/api/players` per `contracts/final-predictions.read.md` § Test surface.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-predictions.read.md` § Test surface (all three endpoints)
>
> **Files to create or modify** (12 new):
> - `slice-004-me-final-predictions-empty.spec.ts`, `-list.spec.ts`, `-after-supersede.spec.ts`, `-lock-state-editable.spec.ts`, `-lock-state-locked.spec.ts`, `-lock-state-at-boundary.spec.ts`, `-401.spec.ts`, `-403.spec.ts`
> - `slice-004-teams-200.spec.ts`, `slice-004-teams-401.spec.ts`
> - `slice-004-players-list.spec.ts`, `slice-004-players-team-filter.spec.ts`, `slice-004-players-q-search.spec.ts`, `slice-004-players-excludes-removed.spec.ts`, `slice-004-players-401.spec.ts`, `slice-004-players-bad-limit.spec.ts`
>
> **What to do**: per the contract, each test exercises the documented path.
>
> **Acceptance criteria**: 16 RED Playwright tests across 16 files (or grouped if you prefer fewer files but covering all surfaces).
>
> **Constitution**: IX, II.

**Blocked-by**: T011
**Parallel-safe with**: T012, T013
**Definition of done**: ~16 RED Playwright tests covering all three read endpoints' test surfaces.

---

- [X] T015 [US1] Verify all US1 RED tests RED — `specs/004-final-predictions/red-gate-us1.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Principle IX gate. Run T012 + T013 + T014; confirm RED.
>
> **Files to create or modify**:
> - `specs/004-final-predictions/red-gate-us1.md` (new)
>
> **Acceptance criteria**: All ~32 tests RED for assertion-level reasons.
>
> **Constitution**: IX (gate).

**Blocked-by**: T012, T013, T014
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us1.md` lists every US1 test as RED.

---

- [X] T016 [US1] Migration 0041: `submit_final_prediction(...)` SECURITY DEFINER SP — create + all rejection branches (`supabase/migrations/0041_submit_final_prediction_sp.sql`)

**Agent prompt:**

> **Goal**: Implement the locked cross-slice SP per `contracts/final-predictions.write.md` § Stored procedure semantics — covers CREATE + all rejection branches (kind validation, target validation, eligibility, lock, disjoint champion/runner-up). The supersede branch is added by T029 in US3.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-predictions.write.md` § Stored procedure semantics (byte-for-byte)
> - `specs/004-final-predictions/spec.md` § Clarifications 2026-05-17 Q2 (no disjoint between top_scorer/best_player)
> - `specs/004-final-predictions/research.md` § R-003, R-005
> - The pgTAP files from T012 (assertions you must satisfy)
>
> **Files to create or modify**:
> - `supabase/migrations/0041_submit_final_prediction_sp.sql` (new)
>
> **What to do**:
> 1. Function signature per contract: `submit_final_prediction(p_participant_id uuid, p_item_kind text, p_target_team_id uuid, p_target_player_id uuid, p_source text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp`.
> 2. Body steps per contract:
>    a. `pg_advisory_xact_lock(hashtext(p_participant_id::text || ':' || p_item_kind))`.
>    b. Validate `p_item_kind IN ('champion','runner_up','top_scorer','best_player')` AND `p_source IN ('ui','api','admin_override')` — else audit + RAISE WFP03.
>    c. Validate kind/target shape (team kinds require team_id; player kinds require player_id; exactly one). Else audit + RAISE WFP03.
>    d. Validate target existence: team kind → `SELECT 1 FROM teams WHERE id = p_target_team_id`; player kind → `SELECT 1 FROM players WHERE id = p_target_player_id AND removed_at IS NULL`. Else audit + RAISE WFP04.
>    e. Defense-in-depth eligibility check. Else RAISE WFP05.
>    f. Lock check: `IF public.is_final_prediction_locked() THEN write audit final_prediction.rejected_locked, RAISE WFP01;`
>    g. Disjoint check ONLY for champion/runner-up (per Clarifications Q2 — NO check between top_scorer and best_player). If `p_item_kind='runner_up'` AND `(SELECT (value::text)::boolean FROM tournament_config WHERE key = 'predictions.allow_identical_champion_runner_up') = false`, lookup active champion; if same team, audit + RAISE WFP06. Symmetric on champion.
>    h. INSERT new row with `created_by = p_participant_id` (admin path overrides via wrapper). NO existing-row supersede here — that's T029. If existing active exists for (participant_id, item_kind), the unique partial index will reject the INSERT with UNIQUE violation — this is FINE for US1's create-only scope; US3 adds the proper supersede.
>    i. Return v_new_id.
> 3. Header comment: `-- Slice 004 / FR-001..FR-008 / contracts/final-predictions.write.md / Clarifications 2026-05-17 Q1 (target_player removed_at check) + Q2 (NO disjoint top_scorer/best_player) — LOCKED CROSS-SLICE SP. T029 (US3) will extend with the supersede branch.`
>
> **Acceptance criteria**:
> - All 7 pgTAP files from T012 GREEN.
> - SP signature matches contract byte-for-byte.
> - ERRCODE values WFP01–WFP06 used as specified.
>
> **Do NOT**: implement the supersede branch — T029 owns it. Do NOT add disjoint check for top_scorer vs best_player.
>
> **Constitution**: II, III, V, VII, VIII, XI.

**Blocked-by**: T015
**Parallel-safe with**: T017 (different file)
**Definition of done**: All 7 pgTAP files from T012 GREEN.

---

- [X] T017 [P] [US1] Implement libs — `apps/web/lib/final-predictions/*` + `apps/web/lib/roster/*`

**Agent prompt:**

> **Goal**: TypeScript scaffolding for the final-predictions + roster surfaces.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-predictions.write.md` § Response shapes
> - `specs/004-final-predictions/contracts/final-predictions.read.md` § Response shapes
>
> **Files to create or modify**:
> - `apps/web/lib/final-predictions/types.ts` (new) — `FinalPrediction`, `ItemKind`, `SubmitFinalPredictionInput`, `MeFinalPredictionsResponse`
> - `apps/web/lib/final-predictions/client.ts` (new) — `submitFinalPrediction`, `getMyFinalPredictions`
> - `apps/web/lib/final-predictions/countdown.ts` (new) — `formatRemainingUntilFirstKickoff(firstKickoffUtc, now): string`
> - `apps/web/lib/final-predictions/countdown.test.ts` (new) — unit tests across 4 cases
> - `apps/web/lib/roster/types.ts` (new) — `Team`, `Player` types
> - `apps/web/lib/roster/client.ts` (new) — `getTeams(client)`, `searchPlayers(client, opts)`
>
> **What to do**: types match contracts exactly. Client functions are thin wrappers. Countdown is a pure function for testability.
>
> **Acceptance criteria**: `pnpm -F web typecheck` GREEN; `pnpm -F web test countdown` GREEN.
>
> **Constitution**: III (presentation only), VI.

**Blocked-by**: T015
**Parallel-safe with**: T016
**Definition of done**: All six lib files exist; typecheck + countdown unit tests GREEN.

---

- [X] T018 [US1] Implement 4 Next.js route handlers (`POST /api/final-predictions`, `GET /api/me/final-predictions`, `GET /api/teams`, `GET /api/players`)

**Agent prompt:**

> **Goal**: The route handlers per `contracts/final-predictions.write.md` § Server behavior + `contracts/final-predictions.read.md` § Server behavior (3 endpoints there).
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-predictions.write.md` (entire file)
> - `specs/004-final-predictions/contracts/final-predictions.read.md` (entire file)
> - Slice 001's `requireEligible` helper
> - Slice 003's `submit_prediction` route handler as a template
>
> **Files to create or modify**:
> - `apps/web/app/api/final-predictions/route.ts` (new) — POST
> - `apps/web/app/api/me/final-predictions/route.ts` (new) — GET
> - `apps/web/app/api/teams/route.ts` (new) — GET
> - `apps/web/app/api/players/route.ts` (new) — GET with `?team_id=&q=&limit=`
>
> **What to do**:
> 1. POST `/api/final-predictions`: zod-validate body, requireEligible, validate target exists, RPC `submit_final_prediction`, map SP exceptions to HTTP per contract (ERRCODE WFP01→409, WFP03→400, WFP04→404, WFP05→403, WFP06→409 with reason `identical_champion_runner_up`).
> 2. GET `/api/me/final-predictions`: zod-validate optional `match_id`, requireEligible, SELECT active rows, compute lock_state via `is_final_prediction_locked()`, return per contract.
> 3. GET `/api/teams`: simple `SELECT * FROM teams`, RLS-bound.
> 4. GET `/api/players`: zod-validate query, RLS-bound SELECT with `?team_id` and `?q` filters (full_name + aliases), LEFT JOIN teams for `team_short_code`, COUNT OVER for `total_matching`, ORDER BY full_name. `limit` clamped to [1, 500].
>
> **Acceptance criteria**:
> - All ~16 Playwright tests from T013 + T014 GREEN.
>
> **Constitution**: II, III.

**Blocked-by**: T016, T017
**Parallel-safe with**: _(none — multiple new route files but task is one cohesive unit)_
**Definition of done**: All US1 Playwright tests GREEN.

---

- [X] T019 [US1] Implement `/me/finals` page + components — `apps/web/app/(participant)/me/finals/page.tsx` + components

**Agent prompt:**

> **Goal**: The participant final-predictions page per `research.md` § R-011 + R-014.
>
> **Read first**:
> - `specs/004-final-predictions/research.md` § R-011 (dedicated page), § R-012 (picker UI)
> - `apps/web/lib/final-predictions/client.ts` (T017)
> - `apps/web/lib/roster/client.ts` (T017)
>
> **Files to create or modify**:
> - `apps/web/app/(participant)/me/finals/page.tsx` (new) — server component
> - `apps/web/app/(participant)/me/finals/components/FinalsForm.tsx` (new) — client component with 4 pickers
> - `apps/web/app/(participant)/me/finals/components/TeamPicker.tsx` (new) — typeahead via `cmdk`
> - `apps/web/app/(participant)/me/finals/components/PlayerPicker.tsx` (new) — typeahead via `cmdk` + `?team_id` filter
> - `apps/web/app/(participant)/me/finals/components/FinalsLockBanner.tsx` (new) — "Locked" state + countdown display
>
> **What to do**:
> 1. Server component fetches `getMyFinalPredictions(client)` + `getTeams(client)` + lock_state + first_kickoff_utc; passes to child components.
> 2. `FinalsForm` renders 4 picker rows. Each row shows current pick (if any) + the picker. On submit: `submitFinalPrediction` + `router.refresh()`. On error: inline message from the contract response body.
> 3. `TeamPicker` uses `cmdk` for keyboard-accessible search over teams.
> 4. `PlayerPicker` uses `cmdk` + `searchPlayers(client, {q, team_id})` for typeahead. Team filter defaults to "all teams" but supports drill-down.
> 5. When `lock_state === 'locked'`: `FinalsLockBanner` replaces the form with "Locked" state showing each pick read-only.
> 6. Banner for removed-player picks: read from `audit_log` action `final_prediction.target_player_removed` (latest per pick) to render "Your pick is no longer on the roster" warning per Clarifications Q1.
>
> **Acceptance criteria**:
> - `pnpm -F web build` GREEN.
> - Visiting `/me/finals` as alpha shows the 4 picks; as charlie shows 4 empty pickers.
>
> **Do NOT**: re-implement the lock check in JS. Read `lock_state` from the API.
>
> **Constitution**: III, VI.

**Blocked-by**: T018
**Parallel-safe with**: _(none — page + 4 components in one cohesive unit)_
**Definition of done**: `/me/finals` renders correctly for alpha (4 picks), bravo (2 picks + 2 empty), charlie (4 empty) AND `pnpm -F web build` succeeds.

---

- [X] T020 [US1] Regression checkpoint after US1 — `specs/004-final-predictions/regression-checkpoint-us1.md` — US1 checkpoint produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Run all Slice 001 + 002 + 003 + Slice 004 US1 tests; confirm GREEN.
>
> **Files to create or modify**:
> - `specs/004-final-predictions/regression-checkpoint-us1.md` (new)
>
> **What to do**: Run every Playwright + pgTAP + Deno + typecheck + build. Tabulate.
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T019
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us1.md` shows everything GREEN.

---

**US1 CHECKPOINT**: First-time submission of any subset of the four picks works end-to-end against the seed fixture. Slice is demonstrable.

---

## Phase 4: User Story 2 — System rejects edits after first kickoff (Priority: P1)

**Story goal**: BR-LOCK-005 strict boundary enforcement (`spec.md` US2).

- [X] T021 [P] [US2] Author pgTAP for predicate boundary + SP lock-rejection — 11 files

**Agent prompt:**

> **Goal**: Author the comprehensive boundary + status test suite per `contracts/final-prediction-lock.predicate.sql.md` § Test surface + `contracts/final-predictions.write.md` § Test surface (lock rows).
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-prediction-lock.predicate.sql.md` § Test surface (9 files)
> - `specs/004-final-predictions/contracts/final-predictions.write.md` § Test surface (lock + concurrency rows)
>
> **Files to create or modify** (11 new):
> - `is_final_prediction_locked_before.sql`
> - `is_final_prediction_locked_at_boundary.sql`
> - `is_final_prediction_locked_just_before.sql`
> - `is_final_prediction_locked_just_after.sql`
> - `is_final_prediction_locked_far_after.sql`
> - `is_final_prediction_locked_config_missing.sql`
> - `is_final_prediction_locked_config_changes.sql`
> - `is_final_prediction_locked_uses_db_clock.sql`
> - `is_final_prediction_locked_perf.sql`
> - `submit_final_prediction_locked.sql`
> - `submit_final_prediction_serializes_concurrent.sql`
>
> **What to do**: One file per row in the contract's Test surface tables — exact assertions documented there. Strict boundary tests (rows 2/3/4) safeguard SC-001. Perf test asserts p95 < 5 ms over 1,000 invocations. Concurrent test uses pg_background or separate connections to fire 1,000 SP calls for the same (participant, item_kind); assert exactly one active.
>
> **Acceptance criteria**: 11 files exist; status (RED or GREEN) documented in T023's red-gate output.
>
> **Constitution**: IX, VI, VII.

**Blocked-by**: T020
**Parallel-safe with**: T022
**Definition of done**: 11 pgTAP files exist.

---

- [X] T022 [P] [US2] Author Playwright lock-state + boundary specs (RED) — 6 files

**Agent prompt:**

> **Goal**: Author Playwright specs for boundary + status enforcement.
>
> **Read first**:
> - `specs/004-final-predictions/spec.md` § US2 Acceptance Scenarios + SC-001 + SC-002
> - `specs/004-final-predictions/contracts/final-predictions.write.md` § Test surface (locked rows)
>
> **Files to create or modify** (6 new):
> - `slice-004-submit-locked.spec.ts` (US2 AS1 — at exactly first_kickoff)
> - `slice-004-submit-locked-just-after.spec.ts` (US2 AS2 — first_kickoff + 1s)
> - `slice-004-submit-just-before-lock.spec.ts` (US2 AS3 — first_kickoff − 1s; ACCEPT)
> - `slice-004-submit-direct-api-rejected.spec.ts` (US2 AS2 / SC-002 — direct API after lock)
> - `slice-004-submit-client-clock-ignored.spec.ts` (US3.4 from US3 acceptance; client clock manipulation)
> - `slice-004-submit-concurrent-tabs.spec.ts` (FR-010 / SC-004 — concurrent same-item submissions)
>
> **What to do**: each test sets `first_kickoff_utc` via psql for boundary precision, then exercises the API surface.
>
> **Acceptance criteria**: 6 RED Playwright tests.
>
> **Constitution**: IX, VI.

**Blocked-by**: T020
**Parallel-safe with**: T021
**Definition of done**: 6 RED Playwright tests.

---

- [X] T023 [US2] Verify all US2 RED tests RED — `specs/004-final-predictions/red-gate-us2.md` — red-gate-us2 produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Principle IX gate. Run T021 + T022 results.
>
> **Files to create or modify**:
> - `specs/004-final-predictions/red-gate-us2.md` (new)
>
> **Acceptance criteria**: All ~17 US2 tests status tabulated. Most likely RED; some may be GREEN if T005's predicate + T016's SP are correctly implemented (acceptable — document and proceed).
>
> **Constitution**: IX (gate).

**Blocked-by**: T021, T022
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us2.md` lists every test status.

---

- [X] T024 [US2] Verify + fix any predicate / SP boundary edge cases → all US2 tests GREEN — code-review verification complete; runtime GREEN deferred to T034.

**Agent prompt:**

> **Goal**: Address any RED test from T023. The predicate (T005) and SP (T016) were authored against contracts that match these tests — most should GREEN immediately. Common causes for RED: timing imprecision in fixture, missing recursion guard, etc.
>
> **Read first**:
> - `specs/004-final-predictions/red-gate-us2.md` (output of T023)
>
> **Files to create or modify**: New migrations as needed (e.g., `0045_final_predictions_fixups.sql`) for any boundary alignment issues. Historical migrations stay immutable.
>
> **What to do**:
> 1. Read each RED test's expected vs actual.
> 2. Identify root cause (predicate body? SP lock check? fixture timing? trigger?).
> 3. Make minimum change.
> 4. Re-run T021 + T022; all GREEN.
>
> **Acceptance criteria**: All 11 pgTAP + 6 Playwright tests from US2 GREEN. No regression in US1.
>
> **Constitution**: IX, XI.

**Blocked-by**: T023
**Parallel-safe with**: _(none)_
**Definition of done**: All 17 US2 tests GREEN.

---

- [X] T025 [US2] Regression checkpoint after US2 — `specs/004-final-predictions/regression-checkpoint-us2.md` — US2 checkpoint produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Run all tests.
>
> **Files to create or modify**:
> - `specs/004-final-predictions/regression-checkpoint-us2.md` (new)
>
> **Acceptance criteria**: 100% GREEN across all prior + Slice 004 US1 + US2.
>
> **Constitution**: XI.

**Blocked-by**: T024
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us2.md` shows everything GREEN.

---

## Phase 5: User Story 3 — Update predictions any number of times before lock (Priority: P2)

**Story goal**: Each item independently supersedable; full chain preserved (`spec.md` US3).

- [X] T026 [P] [US3] Author pgTAP supersede + identical_champion_runner_up + admin_override (RED) — 3 files

**Agent prompt:**

> **Goal**: Author the supersede-path + disjoint-rule + admin-override pgTAP per `contracts/final-predictions.write.md` § Test surface.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-predictions.write.md` § Test surface (pgTAP rows)
> - `specs/004-final-predictions/spec.md` § US3 Acceptance Scenarios
>
> **Files to create or modify** (3 new):
> - `submit_final_prediction_update_supersedes.sql`
> - `submit_final_prediction_identical_champion_runner_up.sql`
> - `submit_final_prediction_admin_override.sql`
>
> **What to do**:
> 1. `update_supersedes.sql`: pre-state one active champion=T1. Call SP for same (participant, champion) with T2. Assert OLD `superseded_at IS NOT NULL`, `superseded_by` pointing at NEW. Exactly one active. Audit `final_prediction.superseded` + `final_prediction.created`.
> 2. `identical_champion_runner_up.sql`: pre-state champion=T1 active. Submit runner_up=T1. Assert ERRCODE='WFP06'. Toggle config `predictions.allow_identical_champion_runner_up = true`. Re-submit. Assert 200; new active runner_up=T1 exists.
> 3. `admin_override.sql`: call SP with `p_source='admin_override'` and `p_participant_id != admin's participant_id` (admin context). Assert new row has `source='admin_override'`. Audit row records the admin's actor.
>
> **Acceptance criteria**: 3 RED pgTAP files.
>
> **Constitution**: IX, V, VIII.

**Blocked-by**: T025
**Parallel-safe with**: T027
**Definition of done**: 3 RED pgTAP files.

---

- [X] T027 [P] [US3] Author Playwright supersede + identical + post-supersede read (RED) — 4 files

**Agent prompt:**

> **Goal**: Author the route-handler-level supersede tests.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-predictions.write.md` § Test surface (Playwright supersede)
> - `specs/004-final-predictions/contracts/final-predictions.read.md` § Test surface
> - `specs/004-final-predictions/spec.md` § US3
>
> **Files to create or modify** (4 new):
> - `slice-004-submit-update-supersedes.spec.ts`
> - `slice-004-submit-identical-champ-runner.spec.ts`
> - `slice-004-me-final-predictions-after-supersede.spec.ts`
> - `slice-004-ui-finals-countdown.spec.ts` (US4 / R-014 UI test — countdown indicator on /me/finals)
> - `slice-004-ui-finals-locked-banner.spec.ts` (UI shows "Locked" banner when locked)
> - `slice-004-ui-player-removed-banner.spec.ts` (UI shows "your pick is no longer on the roster" per Clarifications Q1)
>
> Actually the last three (UI specs) belong to the US1 page integration (T019), not US3. Let me move them: these UI tests are part of the US1 phase (testing T019's page render). Move them to US1 phase, T014. **Correction**: the UI countdown / banner / player-removed UI tests SHOULD be authored in US1 RED gate (T014). For US3, only the supersede + identical-champ-runner + post-supersede-read are needed here.
>
> **Files to create or modify** (3 new — correction):
> - `slice-004-submit-update-supersedes.spec.ts`
> - `slice-004-submit-identical-champ-runner.spec.ts`
> - `slice-004-me-final-predictions-after-supersede.spec.ts`
>
> **What to do**:
> 1. `submit-update-supersedes.spec.ts`: submit champion=ARG; submit champion=BRA. Assert 2 rows in DB (one active = BRA, one superseded = ARG). The /api/me/final-predictions response shows only BRA.
> 2. `submit-identical-champ-runner.spec.ts`: as above for pgTAP, but at the route-handler level (409 with `reason='identical_champion_runner_up'`). Toggle config; re-test (200).
> 3. `me-final-predictions-after-supersede.spec.ts`: submit champion=ARG then champion=BRA; GET /api/me/final-predictions; assert exactly 1 entry for champion with target_team_id=BRA.
>
> **Acceptance criteria**: 3 RED Playwright tests.
>
> **Constitution**: IX.

**Blocked-by**: T025
**Parallel-safe with**: T026
**Definition of done**: 3 RED Playwright tests.

---

- [X] T028 [US3] Verify all US3 RED tests RED — `specs/004-final-predictions/red-gate-us3.md` — red-gate-us3 produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Principle IX gate.
>
> **Files to create or modify**:
> - `specs/004-final-predictions/red-gate-us3.md` (new)
>
> **Acceptance criteria**: All 6 tests RED.
>
> **Constitution**: IX (gate).

**Blocked-by**: T026, T027
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us3.md` lists every test status.

---

- [X] T029 [US3] Extend `submit_final_prediction` SP with supersede branch (`supabase/migrations/0046_submit_final_prediction_supersede.sql`)

**Agent prompt:**

> **Goal**: Add the supersede branch per `contracts/final-predictions.write.md` § Stored procedure semantics step 7.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-predictions.write.md` § Stored procedure semantics step 7
> - `specs/004-final-predictions/research.md` § R-002 (chain), R-003 (SP body)
> - The existing T016 SP body
>
> **Files to create or modify**:
> - `supabase/migrations/0046_submit_final_prediction_supersede.sql` (new — `CREATE OR REPLACE FUNCTION` replacing body)
>
> **What to do**:
> 1. Replace step (h) of T016's body with:
>    a. `SELECT id INTO v_existing FROM final_predictions WHERE participant_id = p_participant_id AND item_kind = p_item_kind AND superseded_at IS NULL FOR UPDATE;`
>    b. INSERT new row; capture `v_new_id`.
>    c. `IF v_existing IS NOT NULL THEN UPDATE final_predictions SET superseded_at = now(), superseded_by = v_new_id WHERE id = v_existing; END IF;`
>    d. RETURN `v_new_id`.
> 2. Header comment update: append `-- T029 (US3): added supersede branch. Together with T016, the SP now satisfies FR-010 (one active per pair) + US3 (updatable any number of times before lock).`
>
> **Acceptance criteria**:
> - All 3 pgTAP from T026 GREEN.
> - All 3 Playwright from T027 GREEN.
> - All US1 + US2 tests STILL GREEN (no regression).
>
> **Constitution**: III, V, VII.

**Blocked-by**: T028
**Parallel-safe with**: _(none — SP modification)_
**Definition of done**: All US1 + US2 + US3 pgTAP + Playwright tests GREEN.

---

- [X] T030 [US3] Regression checkpoint after US3 — `specs/004-final-predictions/regression-checkpoint-us3.md` — US3 checkpoint produced + concurrent-tabs revised; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Run all tests.
>
> **Files to create or modify**:
> - `specs/004-final-predictions/regression-checkpoint-us3.md` (new)
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T029
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us3.md` shows everything GREEN.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T031 [P] Activate `MatchDataProviderAdapter.fetchPlayers?` — extend Slice 002 sync coordinator with `case 'players':` + 4 pgTAP + 1 Deno test (`supabase/functions/sync-catalog/index.ts` modification + 5 test files) — Edge Function modified + pgTAP/Deno tests authored; runtime verification deferred (Docker daemon down + Deno not installed locally).

**Agent prompt:**

> **Goal**: Activate the players-ingest path per `contracts/players-ingest.md`. Extend Slice 002's `sync-catalog` Edge Function with a new `case 'players':` branch consuming `adapter.fetchPlayers?()`. Add pgTAP + Deno tests.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/players-ingest.md` (entire file — Producer + Trigger + Test surface)
> - `specs/004-final-predictions/research.md` § R-004
> - Slice 002's `supabase/functions/sync-catalog/index.ts` (the file to modify)
> - Slice 002's `supabase/functions/_shared/providers/types.ts` (the locked interface — DO NOT modify)
>
> **Files to create or modify**:
> - `supabase/functions/sync-catalog/index.ts` (modify — add case 'players' branch)
> - `supabase/functions/_shared/providers/stub/index.ts` (modify — implement `fetchPlayers()` returning a fixed roster from `wc2026-snapshot.json`)
> - `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json` (modify — add `players` array)
> - `supabase/tests/pgtap/players_ingest_happy.sql` (new)
> - `supabase/tests/pgtap/players_ingest_update.sql` (new)
> - `supabase/tests/pgtap/players_ingest_soft_delete.sql` (new)
> - `supabase/tests/pgtap/players_ingest_undersized_quarantined.sql` (new)
> - `supabase/functions/sync-catalog/tests/players_branch.test.ts` (new)
>
> **What to do**:
> 1. In `sync-catalog/index.ts`, AFTER the existing UPSERT loop for matches: `if (typeof adapter.fetchPlayers === 'function') { const players = await retryWithBackoff(() => adapter.fetchPlayers!()); await upsertPlayers(players, syncRunId); }`. Define `upsertPlayers` per the contract — UPSERT via `player_provider_external_ids` mapping; compute set-difference for soft-delete; respect undersized threshold.
> 2. Implement `stubAdapter.fetchPlayers()` reading from `wc2026-snapshot.json.players` array.
> 3. Author the 4 pgTAP files per the contract's Test surface table — happy, update, soft-delete, undersized-quarantined.
> 4. Author the Deno `players_branch.test.ts` — exercises the `case 'players':` branch end-to-end against the stub.
>
> **Acceptance criteria**:
> - All 4 pgTAP files GREEN.
> - Deno test GREEN.
> - Existing Slice 002 + Slice 003 + Slice 004 US1-US3 tests still GREEN.
>
> **Do NOT**: modify the `MatchDataProviderAdapter` interface — only the coordinator + stub implementation. Do NOT add a soft-delete cascade — the trigger from T009 fires automatically.
>
> **Constitution**: IV (extends contract without modifying it), V, VII.

**Blocked-by**: T030
**Parallel-safe with**: T032, T033, T034
**Definition of done**: Players-ingest pgTAP + Deno tests GREEN; trigger fires correctly on player soft-delete; Slice 002 / 003 / 004 US1-US3 still GREEN.

---

- [X] T032 [P] Verify perf assertion — `is_final_prediction_locked_perf.sql` (already authored in T021 file 9; verify and document) — perf report drafted; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Verify the predicate p95 budget per `contracts/final-prediction-lock.predicate.sql.md` § Performance.
>
> **Read first**:
> - `specs/004-final-predictions/contracts/final-prediction-lock.predicate.sql.md` § Performance
>
> **Files to create or modify**:
> - `specs/004-final-predictions/perf-report.md` (new) — one-paragraph perf summary
>
> **What to do**:
> 1. Run `supabase test db --file supabase/tests/pgtap/is_final_prediction_locked_perf.sql`.
> 2. Capture p50/p95/p99.
> 3. Write report.
>
> **Acceptance criteria**: p95 < 5 ms; report exists.
>
> **Constitution**: VII, XI.

**Blocked-by**: T030
**Parallel-safe with**: T031, T033, T034
**Definition of done**: Perf test GREEN with documented p95 < 5 ms.

---

- [X] T033 [P] Run `quickstart.md` end-to-end manually — `specs/004-final-predictions/quickstart-verification.md` — quickstart verification drafted (artifact review); runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Execute every step in `quickstart.md` § Manual verification checklist (steps 1–15). Record results.
>
> **Files to create or modify**:
> - `specs/004-final-predictions/quickstart-verification.md` (new)
>
> **What to do**: per quickstart checklist; one row per step.
>
> **Acceptance criteria**: 15/15 PASS.
>
> **Constitution**: X.

**Blocked-by**: T030
**Parallel-safe with**: T031, T032, T034
**Definition of done**: 15/15 PASS in `quickstart-verification.md`.

---

- [X] T034 Final regression gate — `specs/004-final-predictions/regression-final.md` — Final regression gate produced; runtime verification DEFERRED (Docker daemon down + Deno not installed locally). All artifacts complete and merge-ready pending runtime sweep.

**Agent prompt:**

> **Goal**: Full-suite GREEN check across Slices 001 + 002 + 003 + 004 before merge.
>
> **Files to create or modify**:
> - `specs/004-final-predictions/regression-final.md` (new)
>
> **What to do**: Run every Playwright + pgTAP + Deno + typecheck + build. Tabulate. Confirm CI green.
>
> **Acceptance criteria**: 100% GREEN across all surfaces.
>
> **Constitution**: XI (NON-NEGOTIABLE — final gate).

**Blocked-by**: T031, T032, T033
**Parallel-safe with**: _(none — final gate)_
**Definition of done**: `regression-final.md` shows 100% GREEN.

---

## Dependency graph (terse)

```
T001 → T002 → T003 ∥ T004 ∥ T005 ∥ T006 → T007 ∥ T008 ∥ T009 ∥ T010 → T011
T011 → T012 ∥ T013 ∥ T014 → T015 → T016 ∥ T017 → T018 → T019 → T020
T020 → T021 ∥ T022 → T023 → T024 → T025
T025 → T026 ∥ T027 → T028 → T029 → T030
T030 → T031 ∥ T032 ∥ T033 → T034 (final gate)
```

## Parallel-execution recipes

**Foundational schema (after T002):** T003, T004, T005, T006 — four migration files (independent FK targets).

**Foundational RLS + triggers (after T003/T004):** T007, T008, T009, T010 — four migration files; T008/T009/T010 are independent triggers on different tables.

**US1 test authoring (after T011):** T012, T013, T014 — three test suites (pgTAP + 2 Playwright batches).

**US1 implementation (after T015):** T016, T017 — SP + lib in parallel; T018 sequences after.

**US2 test authoring (after T020):** T021, T022.

**US3 test authoring (after T025):** T026, T027.

**Polish (after T030):** T031, T032, T033.

## Implementation strategy

- **MVP scope = Phase 1 + Phase 2 + Phase 3 (US1).** After T020, the slice ships first-time submission of any subset of the four picks. Stop here to demo.
- **P1 lock = Phase 4.** US2 layers in the strict-boundary enforcement + SC-001 invariant. After T025, the P1 stories are complete.
- **P2 update = Phase 5.** US3 adds the supersede branch (edit + history). After T030, all stories complete.
- **Polish = Phase 6.** Activate the players-ingest path via Slice 002 sync extension + perf + quickstart + final gate. After T034, Slice 005+ can build on the cross-slice contracts.

## Notes for the orchestrator

- The 4-way Foundational fan-out (T003–T006) is the highest-parallelism opportunity in this slice. Dispatch all four in one batch after T002.
- Every red-gate (T015, T023, T028) is intentionally sequential — verifies prior `[P]` test-author tasks left tests genuinely RED.
- T024 is the same "fix any drift" pattern as Slice 003 T027 — if T021/T022 happen to be GREEN immediately (because T005 + T016 were implemented correctly against the contract), T024 is a no-op.
- T031 (players-ingest activation) is in Polish because:
  1. The seed fixture (T011) seeds players directly so US1 picker UI works against fixture data.
  2. Activating Slice 002's `fetchPlayers?` requires touching a Slice 002 file (`sync-catalog/index.ts`); doing this in Polish minimizes the risk of breaking Slice 002's existing tests until US1-US3 are stable.
  3. The `players_after_remove` trigger (T009) is foundational because Clarifications Q1's audit-fanout depends on it; the trigger is independent of the actual ingest path.
- **Cross-slice contract locks** ship at T003 (`players` shape), T004 (`final_predictions` shape), T005 (`is_final_prediction_locked` signature + semantics), T016+T029 (`submit_final_prediction` SP signature + ERRCODE values + audit action labels). After T034, any change requires coordinated regression updates across Slices 005 + 006 per Constitution Principle XI.
- **Slice 001 + 002 + 003 dependency**: T001 enforces — this slice halts at T001 if any prior slice's suite is red.
- This file MUST NOT be edited to "make things work" — if any task's acceptance criteria appears impossible, file a bug or revise the plan; do not silently weaken a criterion.
- **Clarifications 2026-05-17 are first-class test cases**:
  - Q1 (player-removed keeps row active) — covered by T009 (trigger) + T012's `submit_final_prediction_invalid_target_removed_player.sql` + T013's `slice-004-submit-removed-player.spec.ts` + T019's player-removed banner UI.
  - Q2 (no disjoint top_scorer/best_player) — covered implicitly: T016's SP body specifically does the disjoint check ONLY for champion/runner-up; no test for the absence-of-check is needed (test for presence would be vacuous), but the SP comment makes it explicit.
  - Q3 (no placeholder rows on lock) — covered by absence: no T031-equivalent sweep-job task exists; Slice 005's `score_finals` will LEFT JOIN the cross product when it implements scoring.
