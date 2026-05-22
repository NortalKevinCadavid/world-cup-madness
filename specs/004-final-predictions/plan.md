# Implementation Plan: Final Tournament Predictions

**Branch**: `004-final-predictions` | **Date**: 2026-05-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-final-predictions/spec.md`

## Summary

Implement the vertical slice that lets participants submit four tournament-level picks (champion
team, runner-up team, top scorer player, best player player) before the first match's UTC
kickoff and prevents all edits at that instant (FR-009 / FR-010 / BR-LOCK-005). The slice ships
the cross-slice contracts: the `final_predictions` table (one row per participant×item with
supersede chain), the `players` table (populated by activating Slice 002's reserved
`MatchDataProviderAdapter.fetchPlayers?` method), the locked predicate
`is_final_prediction_locked()`, and the locked SP `submit_final_prediction(...)`. The lock is
**global** (single instant for all participants, all four items) — distinct from Slice 003's
per-match lock. Trusted server time only (Principle VI). Every write + every rejected attempt
audited in the same transaction (Principle V). A dedicated `/me/finals` participant page surfaces
the four pickers + global lock countdown.

## Technical Context

**Language/Version**: TypeScript 5.x (Next.js App Router); SQL (PostgreSQL 15+, Supabase-managed) for the lock predicate, the `submit_final_prediction` SP, RLS, audit triggers, and the players ingest branch added to Slice 002's sync coordinator.

**Primary Dependencies** (additive over Slices 001 + 002 + 003):
- **Backend / data**: Supabase (Postgres, RLS, advisory locks, audit triggers, Edge Functions) — already in place.
- **Frontend**: Next.js 14+ App Router with React + TypeScript + Tailwind — already in place.
- **Form validation**: `zod` (already added in Slice 003).
- **Typeahead UI**: `cmdk` or `@headlessui/react` Combobox for the player picker. Pick one — recommend `cmdk` for keyboard accessibility + no styling lock-in. New apps/web devDep.

**Storage**: Supabase Postgres. New artifacts:
- Tables: `final_predictions` (append-only chain), `players` (active + soft-deletable), `player_provider_external_ids` (mirror of Slice 002's teams mapping).
- Functions: `is_final_prediction_locked() RETURNS boolean STABLE` (locked cross-slice); `submit_final_prediction(uuid, text, uuid, uuid, text) RETURNS uuid` SECURITY DEFINER (locked cross-slice).
- Triggers: audit-row trigger on `final_predictions`; soft-delete audit-fanout trigger on `players` (R-013); first-kickoff-correction trigger on `tournament_config` for the `first_kickoff_utc` key.
- Seed: extends `tournament_config` with `predictions.allow_identical_champion_runner_up` (default `false`).

Sync coordinator extension (Slice 002 owns the file; this slice extends):
- `supabase/functions/sync-catalog/index.ts` gains a `case 'players':` branch that consumes `adapter.fetchPlayers?()` and UPSERTs into `players` + `player_provider_external_ids`.

Existing artifacts consumed (from Slices 001 / 002 / 003):
- From Slice 001: `public.participants`, `public.is_eligible_nortal_participant(uuid)`, `public.is_admin(uuid)` (stub), `public.audit_log`, `public.tournament_config`.
- From Slice 002: `public.teams`, `public.matches.kickoff_utc` (for the `first_kickoff_utc` derivation in the sync coordinator), the `MatchDataProviderAdapter` TypeScript interface (the `fetchPlayers?` optional method).
- From Slice 003: the lock-predicate + SP + audit pattern (template this slice mirrors).

**Testing**:
- **E2E (Constitution Principle IX)**: Playwright. Scenarios authored Given/When/Then against `spec.md` US1/US2/US3 acceptance scenarios plus the 9 spec Edge Cases. Boundary tests at `first_kickoff_utc`, `first_kickoff_utc - 1s`, `first_kickoff_utc + 1s` are non-negotiable (SC-001).
- **DB / unit**: pgTAP for the lock predicate (9 files), the `submit_final_prediction` SP (12 files including 1,000-concurrent serialization), the RLS isolation, and the players-ingest path (4 files).
- **Deno**: 1 test extending Slice 002's sync-catalog tests with the `players` branch.

**Target Platform**:
- Frontend: Vercel-hosted Next.js (web; mobile-friendly responsive).
- Backend: Supabase managed Postgres + Edge Functions.
- Browsers: evergreen (last two majors of Chrome, Edge, Firefox, Safari).

**Project Type**: Web application — extends Slices 001 + 002 + 003 layout.

**Performance Goals** (anchored to spec SCs + `research.md`):
- `is_final_prediction_locked()` p95 < 5 ms — called by every write check + every `/api/me/final-predictions` response + every Slice 005 `peer_final_pick_v` row.
- `submit_final_prediction(...)` p95 < 100 ms end-to-end.
- POST `/api/final-predictions` p95 < 30 s under normal load (SC-003 generous 90s budget).
- 1,000 concurrent submissions for the same (participant, item_kind) all complete with exactly-one-active (SC-004).
- First-kickoff correction takes effect within 1 minute for new lock evaluations (SC-005) — guaranteed by reading `tournament_config` fresh on every predicate call.
- Player roster ingest scales to ~700+ players via Slice 002's sync coordinator without exceeding the 60-s Edge Function ceiling — bounded by the player count + the network round-trip per provider call.

**Constraints**:
- Trusted server time only — Postgres `now()` everywhere; client clocks NEVER feed any lock decision (Principle VI, BR-LOCK-001).
- All writes go through `submit_final_prediction()` SECURITY DEFINER — no direct INSERT/UPDATE/DELETE on `final_predictions` from any client (Principle II).
- All state changes + rejected attempts emit `audit_log` rows in the same transaction (Principle V).
- The `is_final_prediction_locked()` and `submit_final_prediction(...)` signatures are **locked cross-slice contracts**.
- The `players` table shape is locked cross-slice (Slice 005 + Slice 006 consume).
- `MatchDataProviderAdapter.fetchPlayers?` activation is **additive over Slice 002's contract** — Slice 002 reserved it; this slice flips it. No Slice 002 contract change.
- `first_kickoff_utc` and `predictions.allow_identical_champion_runner_up` live in `tournament_config` — Principle VIII.

**Scale/Scope**:
- ~500 participants × 4 items = ~2,000 potential active final-predictions. Plus history (~1-5 versions per item per participant on average) = ~10,000-50,000 total prediction rows. Trivial for Postgres.
- Player roster: ~700-800 players for the World Cup (~32 teams × ~26 squad each). Single sync cycle.
- Write spike: just before first kickoff. Per-(participant, item) advisory lock parallelizes across (participant, item) pairs.

## Constitution Check

*GATE: MUST pass before Phase 0 research. Re-evaluated at the end of Phase 1.*

The constitution under review is v1.1.0 (`.specify/memory/constitution.md`). Each principle is evaluated against this slice's design.

| # | Principle | Evaluation | Status |
|---|-----------|------------|--------|
| I | Technology Neutrality | `spec.md` is vendor-neutral. This plan keeps Supabase / Next.js / cmdk details in the implementation layer. The data model uses capability language ("lock state predicate", "soft-deletable player roster"); product names appear only in plan/research/contracts/quickstart. | ✅ |
| II | Security by Design | All final-prediction writes go through `submit_final_prediction()` SECURITY DEFINER — no direct table writes from any client. Eligibility checked at four layers (Slice 001 auth hook → route handler's `requireEligible` → RLS → SP-body defense-in-depth). The route handler's `participant_id` is set from server-side context; body params NEVER override. Service-role key never on client bundles. | ✅ |
| III | Rules Outside the UI | `is_final_prediction_locked()` is the single named predicate every consumer calls — SP write path, `/api/me/final-predictions` response, Slice 005's peer view, future admin tooling. Score-upper-bound type checks and disjoint champion/runner-up rule live in SQL. The participant UI is presentation-only. | ✅ |
| IV | Provider Abstraction | This slice activates Slice 002's reserved `MatchDataProviderAdapter.fetchPlayers?` method without breaking the contract. The `players` table is provider-agnostic (Slice 002's `MatchDataProviderAdapter` contract is the only ingest path). Provider-specific player IDs live in `player_provider_external_ids` mapping table — never in the `players` row itself. | ✅ |
| V | Auditability | Every final-prediction state change (INSERT, supersede UPDATE) emits an `audit_log` row in the same transaction via the row trigger. Every rejected attempt emits a row from the SP body. Player soft-delete (`removed_at` transition) emits a fan-out row per active `final_predictions` referencing the player (R-013). First-kickoff correction emits a fan-out row per active `final_predictions` (R-014). | ✅ |
| VI | Time-Zone Correctness | `is_final_prediction_locked()` uses Postgres `now()`. The strict boundary (BR-LOCK-005) uses `>=` so at exactly `first_kickoff_utc` the lock fires. UI countdown is informational only; the API's `lock_state` field is authoritative. `submit_final_prediction()` re-checks `is_final_prediction_locked()` inside its own transaction. `first_kickoff_utc` is `timestamptz` stored UTC. No client clock participates anywhere. | ✅ |
| VII | Operational Resilience | Concurrency: advisory lock per `(participant_id, item_kind)` serializes within the contention dimension; unique partial index is the hard backstop. SC-004 (1,000 concurrent → exactly one active) is a storage-layer guarantee. Players ingest extends Slice 002's idempotent sync pattern (UPSERT via mapping table) so re-syncs are safe; player soft-delete preserves FK integrity for `final_predictions.target_player_id`. | ✅ |
| VIII | Extensibility & Configuration | `first_kickoff_utc` (Slice 002 produces, this slice consumes) and `predictions.allow_identical_champion_runner_up` (default `false`, this slice seeds) live in `tournament_config`. Slice 008 admin UI replaces. SC-005 (1-minute config-change responsiveness) guaranteed by reading config fresh on every predicate call. | ✅ |
| IX | TDD via BDD (NON-NEGOTIABLE) | Playwright scenarios committed FIRST (RED) covering every Acceptance Scenario in `spec.md` (US1 × 3, US2 × 4, US3 × 2) plus the 9 spec Edge Cases. Boundary tests at `first_kickoff_utc ± 1s` explicit (SC-001 invariant). pgTAP covers the lock predicate (9 files) + the SP (12 files including 1,000-concurrent serialization) + the players ingest (4 files). | ✅ |
| X | Vertical Slice Delivery | Each user story is its own complete vertical: US1 (submit) → SP + route handler + `/me/finals` page; US2 (lock enforcement) → predicate + SP rejection paths + UI lock banner; US3 (update) → SP supersede branch + UI re-submit affordance. US1 + US2 are shippable independently of US3 (the SP enforces all the rules regardless of UI iteration count). Player ingest is bundled with US1 because the picker UI needs roster data. Scoring + admin manual entry deliberately deferred to Slices 005 and 006. | ✅ |
| XI | Regression-Gated Progress (NON-NEGOTIABLE) | Slices 001 + 002 + 003 regression suites MUST stay GREEN throughout. The `tasks.md` produced by `/speckit-tasks` will place red-gate verification before any implementation task. The five locked cross-slice contracts (`final_predictions` + `players` table shapes; `is_final_prediction_locked` + `submit_final_prediction` signatures; `audit_log` action labels) become Slice 005+'s regression baseline. | ✅ |

**Eligibility / Privacy / Compliance constraints**:
- **Domain-restricted access** ✅ — every write checks `requireEligible(client)` + `is_eligible_nortal_participant()` inside SP.
- **No gambling** ✅ — no monetary fields anywhere.
- **Data minimization** ✅ — `players` columns are exactly what FR-006 + R-004 require: `full_name`, `team_id`, `aliases`, no DOB / nationality / personal data.
- **Public API restriction** ✅ — every endpoint requires authenticated Nortal session.

**Verdict**: ✅ No violations. Proceed to Phase 0.

### Post-Phase-1 re-check

| Principle | Post-design | Notes |
|---|---|---|
| I | ✅ | data-model.md vendor-neutral; product names contained to plan/research/contracts/quickstart. |
| II | ✅ | `contracts/final-predictions.write.md` enforces SECURITY DEFINER SP as single write path. `contracts/final-predictions.read.md` enforces RLS-bound reads. No service-role on any client surface. |
| III | ✅ | `contracts/final-prediction-lock.predicate.sql.md` is single home for the global lock rule. |
| IV | ✅ | `contracts/players-ingest.md` activates Slice 002's reserved method; no contract change. |
| V | ✅ | Audit trigger + SP-body rejection audit + player-soft-delete trigger + first-kickoff trigger all written. |
| VI | ✅ | Predicate uses `now()`; UI countdown is display-only. Strict `>=` boundary documented + tested. |
| VII | ✅ | Advisory lock + unique partial index + serializable isolation; explicit 1,000-concurrent SP test. |
| VIII | ✅ | `first_kickoff_utc` + `predictions.allow_identical_champion_runner_up` config-driven; defaults seeded. |
| IX | ✅ | Test files catalogued in each contract's "Test surface" section; SC-001 boundary tests explicit. |
| X | ✅ | US1 → US2 → US3 each independently demonstrable; quickstart Definition of Done confirms slice-level completeness. |
| XI | ✅ | quickstart Definition of Done requires Slices 001 + 002 + 003 regression GREEN before Slice 005 starts. Five locked contracts form Slice 005+'s regression baseline. |

**Verdict (post-design)**: ✅ No new violations. Ready for `/speckit-tasks`.

(Complexity Tracking section omitted — no violations to justify.)

## Project Structure

### Documentation (this feature)

```text
specs/004-final-predictions/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── final-prediction-lock.predicate.sql.md   # locked predicate
│   ├── final-predictions.write.md               # POST + submit_final_prediction SP
│   ├── final-predictions.read.md                # GET /api/me/final-predictions + /api/teams + /api/players
│   └── players-ingest.md                        # Slice 002 sync coordinator extension
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

Extends Slices 001 + 002 + 003 layout. **(new)** = introduced here; **(modify)** = extends existing.

```text
apps/
└── web/                                  # (existing)
    ├── app/
    │   ├── (participant)/
    │   │   └── me/
    │   │       └── finals/
    │   │           ├── page.tsx           # (new) participant final-predictions page
    │   │           └── components/
    │   │               ├── FinalsForm.tsx       # (new) 4-picker form
    │   │               ├── TeamPicker.tsx       # (new) typeahead for champion + runner_up
    │   │               ├── PlayerPicker.tsx     # (new) typeahead for top_scorer + best_player
    │   │               └── FinalsLockBanner.tsx # (new) renders "locked" state with countdown
    │   └── api/
    │       ├── final-predictions/route.ts       # (new) POST /api/final-predictions
    │       ├── me/
    │       │   └── final-predictions/route.ts   # (new) GET /api/me/final-predictions
    │       ├── teams/route.ts                   # (new) GET /api/teams
    │       └── players/route.ts                 # (new) GET /api/players?team_id=&q=&limit=
    ├── lib/
    │   ├── final-predictions/
    │   │   ├── client.ts                  # (new) submitFinalPrediction + getMyFinalPredictions
    │   │   ├── types.ts                   # (new) FinalPrediction + ItemKind types
    │   │   └── countdown.ts               # (new) formatRemainingUntilFirstKickoff
    │   └── roster/
    │       ├── client.ts                  # (new) getTeams + searchPlayers helpers
    │       └── types.ts                   # (new) Team + Player TypeScript types
    └── tests/
        └── playwright/
            ├── slice-004-submit-champion-happy.spec.ts
            ├── slice-004-submit-top-scorer-happy.spec.ts
            ├── slice-004-submit-all-four.spec.ts
            ├── slice-004-submit-update-supersedes.spec.ts
            ├── slice-004-submit-locked.spec.ts
            ├── slice-004-submit-locked-just-after.spec.ts
            ├── slice-004-submit-just-before-lock.spec.ts
            ├── slice-004-submit-invalid-team.spec.ts
            ├── slice-004-submit-invalid-player.spec.ts
            ├── slice-004-submit-removed-player.spec.ts
            ├── slice-004-submit-identical-champ-runner.spec.ts
            ├── slice-004-submit-unauthenticated.spec.ts
            ├── slice-004-submit-domain-removed.spec.ts
            ├── slice-004-submit-concurrent-tabs.spec.ts
            ├── slice-004-submit-bad-body.spec.ts
            ├── slice-004-me-final-predictions-empty.spec.ts
            ├── slice-004-me-final-predictions-list.spec.ts
            ├── slice-004-me-final-predictions-after-supersede.spec.ts
            ├── slice-004-me-final-predictions-lock-state-editable.spec.ts
            ├── slice-004-me-final-predictions-lock-state-locked.spec.ts
            ├── slice-004-me-final-predictions-lock-state-at-boundary.spec.ts
            ├── slice-004-me-final-predictions-401.spec.ts
            ├── slice-004-me-final-predictions-403.spec.ts
            ├── slice-004-teams-200.spec.ts
            ├── slice-004-teams-401.spec.ts
            ├── slice-004-players-list.spec.ts
            ├── slice-004-players-team-filter.spec.ts
            ├── slice-004-players-q-search.spec.ts
            ├── slice-004-players-excludes-removed.spec.ts
            ├── slice-004-players-401.spec.ts
            ├── slice-004-players-bad-limit.spec.ts
            ├── slice-004-ui-finals-countdown.spec.ts
            ├── slice-004-ui-finals-locked-banner.spec.ts
            └── slice-004-ui-player-removed-banner.spec.ts

supabase/
├── migrations/                            # (existing)
│   ├── 0036_players.sql                          # (new) players + player_provider_external_ids
│   ├── 0037_final_predictions.sql                # (new) final_predictions table + indexes
│   ├── 0038_is_final_prediction_locked.sql       # (new) locked cross-slice predicate
│   ├── 0039_final_predictions_rls.sql            # (new) RLS on final_predictions + players
│   ├── 0040_final_predictions_audit_trigger.sql  # (new) AFTER INSERT/UPDATE
│   ├── 0041_submit_final_prediction_sp.sql       # (new) locked cross-slice SP
│   ├── 0042_players_remove_audit_trigger.sql     # (new) R-013 fan-out
│   ├── 0043_first_kickoff_correction_trigger.sql # (new) R-014 fan-out
│   └── 0044_predictions_config_seed.sql          # (new) seed predictions.allow_identical_champion_runner_up
├── functions/
│   └── sync-catalog/index.ts              # (modify) extend with case 'players':
├── seed/
│   └── slice-004-fixture.sql              # (new) 8 players + 3 prediction sets + boundary-calibrated first_kickoff_utc
└── tests/
    └── pgtap/
        ├── is_final_prediction_locked_before.sql
        ├── is_final_prediction_locked_at_boundary.sql
        ├── is_final_prediction_locked_just_before.sql
        ├── is_final_prediction_locked_just_after.sql
        ├── is_final_prediction_locked_far_after.sql
        ├── is_final_prediction_locked_config_missing.sql
        ├── is_final_prediction_locked_config_changes.sql
        ├── is_final_prediction_locked_uses_db_clock.sql
        ├── is_final_prediction_locked_perf.sql
        ├── submit_final_prediction_create_champion_happy.sql
        ├── submit_final_prediction_create_top_scorer_happy.sql
        ├── submit_final_prediction_update_supersedes.sql
        ├── submit_final_prediction_locked.sql
        ├── submit_final_prediction_invalid_kind.sql
        ├── submit_final_prediction_invalid_target_shape.sql
        ├── submit_final_prediction_invalid_target_missing.sql
        ├── submit_final_prediction_invalid_target_removed_player.sql
        ├── submit_final_prediction_identical_champion_runner_up.sql
        ├── submit_final_prediction_serializes_concurrent.sql
        ├── submit_final_prediction_audit_format.sql
        ├── submit_final_prediction_admin_override.sql
        ├── slice-004-me-final-predictions-rls.sql
        ├── players_ingest_happy.sql
        ├── players_ingest_update.sql
        ├── players_ingest_soft_delete.sql
        └── players_ingest_undersized_quarantined.sql
```

**Structure Decision**: **Option 2 (web application)** — same as Slices 001 + 002 + 003. Authoritative business logic lives in `supabase/migrations/` (SP + predicate + RLS + triggers) per Constitution Principle III; the Next.js layer is presentation + thin write-path. Tests live with the layer they validate.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | _(none)_   | _(none)_                            |
