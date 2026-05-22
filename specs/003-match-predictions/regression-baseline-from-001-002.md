# Regression baseline from Slice 001 + Slice 002 — Slice 003 starting point

- **Slice**: `003-match-predictions`
- **Phase**: 1 (Setup)
- **Date**: 2026-05-20
- **Purpose**: Baseline verification from Slice 001 + Slice 002 — confirm both prior slices' artifact inventories are complete on disk so Slice 003 can build on the cross-slice contracts they lock (eligibility predicate, admin stub, `participants`, `audit_log`, `tournament_config`, `matches`, `match_status`, `kickoff_utc`, the `/api/matches` route handler + `Match` TypeScript type). Per Constitution Principle XI, Slice 003 cannot start with any prior-slice regression suite in a red state.
- **Owning task**: T001 (`specs/003-match-predictions/tasks.md` line 69)
- **Companion artifacts**:
  - `specs/001-eligibility-login/regression-final.md` (Slice 001's final gate — the canonical predecessor)
  - `specs/002-match-catalog/regression-final.md` (Slice 002's final gate — the canonical predecessor)
  - `specs/002-match-catalog/regression-baseline-from-001.md` (the document this one structurally mirrors)
  - `specs/001-eligibility-login/tasks.md § Implementation deviations` (D-001 through D-005)
  - `specs/002-match-catalog/tasks.md § Implementation deviations` (D-006 through D-011)
  - `specs/003-match-predictions/tasks.md § Implementation deviations` (D-012 surfaced at slice start)

---

## Status: DEFERRED (artifact baseline complete; runtime verification jointly deferred with Slice 001 + Slice 002)

Both prior slices' `regression-final.md` status lines read `DEFERRED (artifacts complete, runtime verification pending)` because two distinct runtime dependencies remain unavailable on the executing machine:

1. **Docker Desktop daemon DOWN.** Every `supabase start` / `supabase db reset` / pgTAP loop / Edge Function runtime / pg_cron / Playwright spec that boots a live Next.js dev server depends on a working Docker daemon. None of these has been executed against a live stack for either prior slice.
2. **Deno not installed locally** (`deno --version` not on PATH). The 14 Deno test files Slice 002 ships under `supabase/functions/sync-catalog/tests/` cannot be executed without Deno — `deno test --allow-all` is the only supported runner.

**This document is therefore an artifact-level baseline, not a runtime observation.** All Slice 001 + Slice 002 artifacts (migrations, app code, Edge Function code, tests, contract locks, deviations) are confirmed present on disk by direct file-system inspection executed during T001 today. What remains is the joint runtime confirmation across all three slices — that runtime probe lives in this slice's `regression-final.md` (T038) and inherits both predecessor checklists verbatim.

**Per Principle XI, Slice 003 may proceed with artifact authoring** (Phase 1 setup additions, Phase 2 foundational migrations, Phase 3 pgTAP / Deno RED gates, Phase 4 US1 + US2 + US3 + US4 implementation, Phase 6 polish) on the strength of the artifact baseline below. Slice 003 MUST NOT merge until all three slices' runtime gates are GREEN — the slice-001 § 5 pre-merge checklist, the slice-002 § 7 pre-merge checklist, and the slice-003 equivalent at T038.

---

## 1. Slice 001 + Slice 002 artifact inventory

Verified by direct file-system listing on 2026-05-20. Every row labeled `EXISTS` was confirmed via `Glob` / `ls` against the working tree.

### 1.1 Slice 001 inventory (carry-forward)

| Category | Expected count | On-disk count | Status |
|---|---|---|---|
| Migrations (`supabase/migrations/0001…0011`) | 11 | 11 | EXISTS |
| pgTAP files (`supabase/tests/pgtap/*.sql`, slice-001 set) | 12 (1 harness + 10 functional + 1 perf) | 12 | EXISTS |
| Playwright specs (`apps/web/tests/playwright/`, slice-001 set) | 15 (14 `@slice-001` + 1 untagged `smoke.spec.ts`) | 15 | EXISTS |
| First-party app files (`apps/web/`) | 7 (`lib/types/participant.ts`, `lib/auth/requireEligible.ts`, `lib/auth/getCurrentParticipant.ts`, `app/auth/callback/page.tsx`, `app/auth/denied/page.tsx`, `app/dashboard/page.tsx`, `app/api/me/route.ts`) | 7 | EXISTS |
| Seed fixture (`supabase/seed/slice-001-fixture.sql`) | 1 | 1 | EXISTS |
| OIDC stub infrastructure (`infra/oidc-stub/`, `docker-compose.override.yml`) | dir + override file | EXISTS (dir contains `README.md` + `keys/`) | EXISTS |
| CI workflow (`.github/workflows/ci.yml`) | 1 | 1 | EXISTS |
| Dev-only Playwright helper (`apps/web/tests/playwright/helpers/service-role.ts`) | 1 | 1 | EXISTS |

**Slice 001 tally**: 11 migrations + 12 pgTAP + 15 Playwright + 7 app files + 1 fixture + OIDC stub + CI workflow + 1 helper — all EXISTS, 0 MISSING.

### 1.2 Slice 002 inventory

| Category | Expected count | On-disk count | Status |
|---|---|---|---|
| Migrations (`supabase/migrations/0018…0029`) | 12 | 12 | EXISTS |
| pgTAP files (slice-002 set: `slice-002-catalog-rls.sql` + 8 `record_match_result_*.sql`) | 9 | 9 | EXISTS |
| Playwright specs (slice-002 set, `@slice-002`-tagged) | 12 (9 US1 + 3 US3; 1 of the 12 ships as `test.fixme`) | 12 | EXISTS |
| Deno test files (`supabase/functions/sync-catalog/tests/*.test.ts`) | 14 (6 US2 + 7 US3 + 1 perf = 15 sub-tests) | 14 | EXISTS |
| First-party app files (slice-002 set under `apps/web/`) | 8 (`lib/types/match.ts`, `lib/catalog/client.ts`, `lib/catalog/format.ts`, `lib/catalog/format.test.ts`, `app/api/matches/route.ts`, `app/(participant)/layout.tsx`, `app/(participant)/matches/page.tsx`, plus 2 components — slice 002's regression-final.md § 2 counts 8 first-party files) | 8 | EXISTS |
| Component files (`app/(participant)/matches/components/`) | 2 (`MatchListFilters.tsx`, `PaginationControls.tsx`) — counted within the 8 above | 2 | EXISTS |
| Edge Function (`supabase/functions/sync-catalog/index.ts` + 3 helpers + `deno.json`) | Coordinator + `payload_sanity.ts` + `conflict_quarantine.ts` + `outage_state.ts` | EXISTS (all 4 source files present plus `deno.json` / `deno.lock`) | EXISTS |
| Provider adapters (`supabase/functions/_shared/providers/`) | 3 (`stub/`, `stub2/`, `footballdata/`) + `types.ts` interface lock | EXISTS (all 4 present) | EXISTS |
| Seed fixture (`supabase/seed/slice-002-fixture.sql`) | 1 | 1 | EXISTS |

**Slice 002 tally**: 12 migrations + 9 pgTAP + 12 Playwright + 14 Deno + 8 first-party app files (incl. 2 components) + Edge Function + 3 adapters + 1 fixture — all EXISTS, 0 MISSING.

### 1.3 Cumulative aggregate (both slices, end of Slice 002 / start of Slice 003)

| Surface | Cumulative count | MISSING |
|---|---|---|
| Migrations | **23** (11 slice-001 `0001…0011` + 12 slice-002 `0018…0029`) | 0 |
| pgTAP files | **21** (12 slice-001 + 9 slice-002) | 0 |
| Playwright specs | **27** (15 slice-001 incl. `smoke.spec.ts` harness + 12 slice-002) | 0 |
| Deno test files | **14** (all slice-002) | 0 |
| Seed fixtures | **2** (`slice-001-fixture.sql`, `slice-002-fixture.sql`) | 0 |

These numbers match the canonical tallies in `specs/002-match-catalog/regression-final.md § 2`. Zero MISSING. The cumulative artifact phase is complete on disk.

---

## 2. Cross-slice contracts Slice 003 depends on

Slice 003's `spec.md § Architecture anchors` (FR-001…FR-013) and `tasks.md` reference five concrete prior-slice-owned symbols. Each is confirmed below by direct grep / file-system inspection.

| # | Symbol / shape | Owning slice | Source on disk | Slice 003 consumer | Confirmation |
|---|---|---|---|---|---|
| 1 | `public.participants` table (canonical column list locked in slice-001 regression-final § 3; FK target for `predictions.participant_id`) | Slice 001 | `supabase/migrations/0001_participants.sql` | T003's `predictions.participant_id uuid NOT NULL REFERENCES public.participants(id)` FK | EXISTS (migration 0001); locked in slice-001 regression-final § 3 |
| 2 | `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE SECURITY INVOKER` | Slice 001 | `supabase/migrations/0005_is_eligible_nortal_participant.sql` | T005 predictions RLS read policy embeds the predicate via `auth.uid()`; SP wrapper at T013 re-checks before any write | EXISTS (migration 0005); locked in slice-001 regression-final § 3 row 1 |
| 3 | `public.is_admin(p_user_id uuid) RETURNS boolean STABLE` (stub returning constant `FALSE`) | Slice 001 | `supabase/migrations/0006_is_admin_stub.sql` | T013 `submit_prediction(...)` SP MUST short-circuit on `is_admin(auth.uid())` — admins bypass the lock window (BR-LOCK-006); signature LOCKED, body replaced by slice 006 | EXISTS (migration 0006); locked in slice-001 regression-final § 3 row 2 |
| 4 | `public.audit_log` shape (10 canonical columns: `id`, `actor`, `action`, `source` CHECK in `{auth_hook, rls, api_guard, ui, trigger}`, `entity_type`, `entity_id`, `previous_value`, `new_value`, `reason`, `occurred_at`) | Slice 001 | `supabase/migrations/0003_audit_log_stub.sql` | T006 predictions audit trigger writes `source='trigger'` rows for every create / update / reject / kickoff-correction event in the same transaction as the underlying mutation; SP at T013 writes denial rows with `source='api_guard'` | EXISTS (migration 0003); locked in slice-001 regression-final § 3 row 6. Additive column changes only — no rename/drop. |
| 5 | `public.tournament_config` table (slice-001 shape: `key text PK`, `value jsonb NOT NULL`, `updated_at timestamptz`) — slice 003 will read **`lock_window_minutes` (default 60)** and **`score_upper_bound` (default 20)** via the keys seeded by T007 migration 0035 | Slice 001 (shape) + Slice 003 (new key inserts via T007) | `supabase/migrations/0002_tournament_config_stub.sql` (table) + T007's new migration at on-disk slot 0035 (key inserts) | T004 `is_prediction_locked(uuid)` predicate reads `lock_window_minutes`; T013 SP validation reads `score_upper_bound`; T031 `/api/matches` route handler reads `score_upper_bound` on cold start to validate body params | EXISTS (migration 0002); locked in slice-001 regression-final § 3 row 7. Slice 003 only INSERTs new rows — no schema changes. |
| 6 | `public.matches` table (cols: `id uuid PK`, `home_team_id`, `away_team_id`, `kickoff_utc timestamptz NOT NULL`, `status public.match_status NOT NULL DEFAULT 'scheduled'`, plus stage/group invariants) | Slice 002 | `supabase/migrations/0020_matches.sql` | T003 `predictions.match_id uuid NOT NULL REFERENCES public.matches(id)` FK; T004 `is_prediction_locked(uuid)` reads `kickoff_utc` AND `status`; T008 kickoff-correction trigger fires `AFTER UPDATE WHEN OLD.kickoff_utc IS DISTINCT FROM NEW.kickoff_utc` | EXISTS (migration 0020); locked in slice-002 regression-final § 3 |
| 7 | `public.match_status` enum — 5 values `{scheduled, in_progress, finished, postponed, cancelled}` (locked per D-006) | Slice 002 | `supabase/migrations/0020_matches.sql` (CREATE TYPE) | T004 `is_prediction_locked(uuid)` returns `true` for any status that is NOT `'scheduled'` (BR-LOCK-004 — once a match starts, no edits regardless of time-to-kickoff) | EXISTS (enum defined in migration 0020); locked in slice-002 regression-final § 3 row 1 |
| 8 | `MatchDataProviderAdapter` interface — locked in `supabase/functions/_shared/providers/types.ts` | Slice 002 | `supabase/functions/_shared/providers/types.ts` + `stub/`, `stub2/`, `footballdata/` impls | **Slice 003 does NOT call the adapter directly.** The `/api/matches` route handler is the consumer slice 003 extends in T031 (additive `lock_state` field). The adapter is referenced here only to document non-dependency — Slice 003's prediction write-path never touches a provider; provider output reaches predictions indirectly via `matches.kickoff_utc` corrections, which slice 003 audits via T008. | EXISTS (`types.ts` + 3 adapters); locked in slice-002 regression-final § 3 row 7. **Slice 003 is contract-neutral toward the adapter — slice 002 owns it end to end.** |
| 9 | `GET /api/matches` route handler (200 envelope `{ matches: Match[], page, page_size, total }`; cache-control private) + `Match` TS type at `apps/web/lib/types/match.ts` | Slice 002 | `apps/web/app/api/matches/route.ts` + `apps/web/lib/types/match.ts` | **T031** modifies the route handler to add the additive `lock_state: 'editable' \| 'locked'` field (computed via `CASE WHEN public.is_prediction_locked(m.id) THEN 'locked' ELSE 'editable' END`); **T032** extends the `Match` TS type with `lock_state: 'editable' \| 'locked'`. Both are ADDITIVE — no field is removed or renamed | EXISTS (both files present per § 1.2 above); locked in slice-002 regression-final § 3 row 9 |

**Tally**: 9 cross-slice contracts confirmed present on disk and unchanged (8 directly consumed + 1 documented non-dependency). Slice 003 may safely build on them.

---

## 3. Slice 001 + Slice 002 deferred items inherited as Slice 003 prerequisites

Per slice-001 regression-final.md § 2 row 7, slice 001 ships with **9 deferred-verification tasks**: T005, T006, T007, T021, T031, T035, T039, T041, T044. Per slice-002 regression-final.md § 2 row 12, slice 002 ships with **11 deferred-verification tasks**: T001, T002, T018, T022, T028, T033, T038, T042, T043, T044, T045.

Of the slice-001 set, three block slice 003 directly because slice 003 reuses the same runtime infrastructure (same as slice 002 inherited them):

- **T005** (pgTAP harness smoke), **T006** (Supabase + OIDC stub boot), **T007** (CI workflow PR-trigger).

The remaining six slice-001 deferrals (T021, T031, T035, T039, T041, T044) are slice-001-internal verification tasks; they block slice 001's merge but do not block slice 003's artifact authoring.

All 11 slice-002 deferrals block slice 003's runtime gate too (because they share the same Docker + Deno requirement and the same `supabase db reset` chain).

| Inherited slice | Deferred tasks | Why slice 003 inherits |
|---|---|---|
| Slice 001 | T005, T006, T007 | Same Docker + OIDC + CI infrastructure |
| Slice 002 | T001, T002, T018, T022, T028, T033, T038, T042, T043, T044, T045 | Same Docker + Deno + Supabase stack + `supabase db reset` chain (all 23 prior migrations must apply cleanly before slice-003 migrations 0030+) |

**Slice 003 will add its own deferred-verification tasks** during its execution; the joint pre-merge checklist for all three slices lives in slice 003's `regression-final.md` at T038. Slice 003 cannot merge to `main` until **all three** pre-merge checklists (slice-001 § 5, slice-002 § 7, slice-003 equivalent) are 100% ticked GREEN against a working Docker daemon + a Deno installation.

---

## 4. D-012 callout — Migration slot renumber (surfaced at slice 003 start)

Slice 003's `tasks.md § Implementation deviations` records a fresh deviation **D-012** captured today (2026-05-20) at slice start. Verbatim from `specs/003-match-predictions/tasks.md` lines 48–63:

- **Symptom**: Slice 003's tasks.md plans migrations at slots **0029–0036**, but slice 002's T032 already shipped `0029_sync_lock_helpers.sql`. Migration filename collisions would break `supabase db reset`.
- **Decision**: Shift every slice-003 migration by **+1** to start at **0030** (not 0029). Reordering preserved.

| Slice-003 task | Spec slot | Actual on-disk slot |
|---|---|---|
| T003 `predictions` | 0029 | **0030** |
| T004 `is_prediction_locked` | 0030 | **0031** |
| T005 `predictions_rls` | 0031 | **0032** |
| T006 `predictions_audit_trigger` | 0032 | **0033** |
| T013 `submit_prediction_sp` | 0033 | **0034** |
| T007 `lock_window_score_bound_seed` | 0034 | **0035** |
| T008 `kickoff_correction_audit_trigger` | 0035 | **0036** |
| T021 `submit_prediction_supersede` (optional) | 0036 | **0037** |

**How D-012 applies**: every Phase 2 + Phase 3 + Phase 4 task in slice 003 MUST use the **actual on-disk slot number**, not the spec's. Tests reference function/table names (`predictions`, `is_prediction_locked`, `submit_prediction`) — not migration numbers — so no test changes are required. This baseline document is the canonical reference for the renumber across the rest of slice 003.

The on-disk migration count at end-of-slice-003 (assuming the optional T021 ships) will be: `0001…0011` (slice 001, 11 files) + `0018…0029` (slice 002, 12 files) + `0030…0037` (slice 003, 8 files) = **31 migrations** under `supabase/migrations/`.

---

## 5. Verdict

**BASELINE ARTIFACTS COMPLETE; runtime verification DEFERRED jointly with Slice 001 + Slice 002.**

- All 23 cumulative migrations (11 slice-001 `0001…0011` + 12 slice-002 `0018…0029`), all 21 pgTAP files (12 + 9), all 27 Playwright specs (15 + 12), all 14 slice-002 Deno test files, both seed fixtures, the slice-002 Edge Function + 3 adapters + interface lock, the slice-001 OIDC stub infrastructure + docker-compose override + CI workflow, and the dev-only Playwright service-role helper are confirmed EXISTS on disk.
- All 9 cross-slice contracts slice 003 consumes (`participants`, `is_eligible_nortal_participant`, `is_admin`, `audit_log`, `tournament_config` shape, `matches`, `match_status`, the `/api/matches` route handler, the `Match` TS type) are confirmed locked and consumable. The `MatchDataProviderAdapter` interface is documented as a non-dependency (slice 003 contract-neutral).
- The 3 slice-001 deferred tasks slice 003 inherits (T005 harness smoke, T006 stack boot, T007 CI PR trigger) and the 11 slice-002 deferred tasks (T001, T002, T018, T022, T028, T033, T038, T042, T043, T044, T045) are documented and roll into the joint pre-merge checklist at slice-003 T038.
- D-012 (migration slot renumber 0029→0030, surfaced at slice start) is captured here as the canonical reference for every slice-003 migration filename.

Slice 003 may proceed with artifact authoring (Phase 1 setup, Phase 2 foundational migrations starting at the renumbered slot 0030, Phase 3 pgTAP / Playwright RED gates, Phase 4 US1 + US2 + US3 + US4 implementation, Phase 6 polish). Slice 003's `regression-final.md` (T038) will carry the joint runtime probe and the joint pre-merge checklist — slice 003 cannot merge to `main` until **all three** slices' runtime checklists land GREEN against a working Docker daemon + Deno installation.

Per Principle XI (NON-NEGOTIABLE): the artifact baseline IS NOT the regression gate. Runtime confirmation against the live stack remains required before merge of any of the three slices.

---

## 6. D-001 through D-011 carry-forward (one-liner per deviation)

Slice 003 inherits and MUST honor all eleven accepted prior-slice deviations. Full entries in `specs/001-eligibility-login/tasks.md § Implementation deviations` and `specs/002-match-catalog/tasks.md § Implementation deviations`.

| ID | One-liner | Slice 003 impact |
|---|---|---|
| **D-001** | Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`; `handle_auth_user_signed_in` fires on every token issuance. | Slice 003 Playwright fixtures (predictions submit / edit / lock-window denial) MUST drive the OIDC stub through `custom_access_token`; the eligibility check at the SP path re-evaluates on every refresh, not once per session. |
| **D-002** | `is_approved_domain(p_email text)` accepts a FULL email and extracts the domain segment internally. | Slice 003 does not call `is_approved_domain` directly (eligibility routes through `is_eligible_nortal_participant`); test fixtures passing emails must use full email strings. |
| **D-003** | `/api/me` body shape: `{ participant: {...} }` on 200, `{ error: { code, message } }` on 4xx/5xx, `Cache-Control: private, max-age=0, must-revalidate`. | Slice 003's new participant-facing APIs (`POST /api/me/predictions`, `GET /api/me/predictions`) MUST mirror this envelope: `{ prediction: {...} }` or `{ predictions: [...] }` on 200, `{ error: { code, message } }` on errors, same `Cache-Control` semantics for authenticated reads. |
| **D-004** | `participants_self_or_admin_read` policy embeds the eligibility predicate in its `USING` clause; migration 0011 is a header-only no-op marker. | Slice 003's predictions RLS (T005, migration 0032) follows the same `is_eligible_nortal_participant(auth.uid())`-in-USING pattern — single policy with embedded predicate, no separately-named self-read + admin-read pair. |
| **D-005** | `handle_auth_user_signed_in` returns the `{claims}` / `{error: {http_code, message}}` `custom_access_token` envelope (not `{decision}`); `handle_auth_user_created` retains `{decision, message}`. The two hooks are deliberately asymmetric. | Slice 003 has no direct dependency on the auth-hook return envelope, but any test fixture that mocks token issuance MUST emit the `{claims}` / `{error}` shape — the `{decision}` shape will be silently ignored. |
| **D-006** | Wave-2 schema reconciliation (slice 002): `match_status` enum is `scheduled/in_progress/finished/postponed/cancelled` (no `live`); `match_stage` short codes; `group_id` not `group_name`; `last_synced_at` added; CHECK constraints; `match_provider_external_ids` renames; provider sync tables ship `bigserial` PK + text+CHECK enums + `correlation_id uuid`; `match_pending_review` text+CHECK enums; `providers.*` plural prefix; multi-method adapter interface. | Slice 003 reads `match_status` BY EXACT SPELLING (`'scheduled'` only is editable; everything else locks per BR-LOCK-004). Slice 003 reads `kickoff_utc` directly. No further schema impact. |
| **D-007** | `match_results` field-name mapping in `/api/matches` (T020): route projects `_official` from split columns; `_for_scoring` passes through unchanged; `result_status` remaps `'penalty_shootout'` → `'penalties_shootout'` on the wire; sort param accepts both `kickoff_utc_{asc,desc}` and `kickoff_{asc,desc}` aliases. | Slice 003 extends `/api/matches` additively with `lock_state` (T031) — the slice-002 D-007 remappings stay in place; slice 003 does not touch them. |
| **D-008** | pgTAP cannot observe `pg_notify` channel reception; `record_match_result_emits_notification.sql` uses structural-proxy assertions; end-to-end channel-receive assertion deferred to slice-005 Deno integration. | Slice 003 does not emit any `pg_notify`; no impact. (Future: if slice 003 ever adds a `predictions_recorded` channel, the same D-008 limitation will apply.) |
| **D-009** | `audit_log.action` name mismatch in `0025_catalog_audit_triggers.sql`: emits `'match_result.updated'` on UPDATE; contract names it `'match_result.corrected'`. INSERT-path matches; UPDATE-path pgTAP deferred to slice 006. | Slice 003 writes its own `audit_log.action` namespace (`'prediction.created'`, `'prediction.rejected_locked'`, `'prediction.rejected_invalid_score'`, `'prediction.kickoff_correction_crossed_lock'`); no overlap with the slice-002 D-009 mismatch. |
| **D-010** | Three sync-coordinator vs Deno tests vs migration 0022 reconciliation gaps (column-name + trigger-value mismatches): (a) `success_no_changes` wire vs `success` storage — doc-only; (b) `single_sync_happy.test.ts` column mismatches — HARD pre-merge gate; (c) six US2 Deno files post unaccepted `trigger` values — HARD pre-merge gate. | Slice 003 does not touch the sync coordinator or its Deno tests; D-010 remains slice-002's hard pre-merge gate. Slice 003 must NOT merge until slice-002's D-010(b) + D-010(c) patches land first. |
| **D-011** | `audit_log.source` CHECK does not include a `'sync'` value; T039 wrote `source='api_guard'` uniformly for every sync-coordinator audit row; slice 007 may extend the CHECK additively. | Slice 003 writes its prediction audit rows with `source='trigger'` (T006 audit trigger path) and `source='api_guard'` (T013 SP denial path) — both already in the slice-001 CHECK whitelist; no new source value required. |

No D-013 reserved by slice 002's final gate; the next deviation slot for slice 003 work is D-013.

---

## 7. Companion runtime gate (where the joint pre-merge checklist lives)

This document is the **artifact-level baseline**. The **runtime-level baseline** for the joint slice-001 + slice-002 + slice-003 regression — the document that records the actual `supabase start` / `supabase db reset` / pgTAP loop / `tsc --noEmit` / `next build` / Playwright `@slice-001 + @slice-002 + @slice-003` / Deno test / quickstart-verification output against a live Docker stack + Deno installation — lives at:

- `specs/003-match-predictions/regression-final.md` (T038, slice 003 Phase 6 polish)

T038 will reproduce slice 001's § 5 pre-merge checklist VERBATIM, append slice 002's § 7 equivalent below it, and append slice 003's own pre-merge checklist (including the new SP / RLS / audit-trigger / lock-predicate / kickoff-correction / `lock_state`-additive surfaces) at the tail. All three checklists MUST land GREEN before slice 003's PR merges to `main`.
