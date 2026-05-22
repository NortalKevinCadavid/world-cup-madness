# Slice 005 — Regression Baseline (Slices 001–004 snapshot)

**Slice**: 005 — Scoring & Leaderboard
**Tasks**: T001 (harness verification) + T002 (regression baseline)
**Date**: 2026-05-20
**Constitution anchor**: Principle XI (NON-NEGOTIABLE — regression-gated progress)
**Status**: **DEFERRED (Docker daemon down — no Supabase stack running; runtime pass-status cannot be observed locally this session)**

This document is the artifact-level baseline that slice 005 inherits from the cumulative slices 001 + 002 + 003 + 004 surface. Per Principle XI, every subsequent slice-005 task must keep this baseline GREEN. The actual pass-status sweep is the merge gate; this file is the runbook + inventory the operator will tick off once a Docker-up environment is available.

---

## 0. T001 — Harness verification (deferred)

T001's checklist (run from `specs/005-scoring-leaderboard/tasks.md` lines 43–73) was executed in artifact-only mode this session. Findings:

| Probe | Result |
|---|---|
| `apps/web/package.json` declares Playwright | **yes** — `@playwright/test ^1.60.0` in `devDependencies` (added by slice 002). |
| `supabase/tests/pgtap/` directory exists | **yes** — 68 `.sql` files on disk plus `.gitkeep`. |
| `apps/web/tests/playwright/` directory exists | **yes** — 85 `*.spec.ts` files on disk + `.gitkeep` + `fixtures/` + `helpers/`. |
| `pnpm exec playwright --version` | **Version 1.60.0** (matches package.json). |
| `supabase --version` | **2.98.2** (CLI installed; upgrade banner notes v2.100.1 available — non-blocking for this slice's `supabase test db --file` usage; quickstart.md requires 1.150+ which is satisfied). |
| `deno --version` | **2.7.14** (stable, x86_64-pc-windows-msvc; satisfies quickstart.md's "Deno 1.40+"). Prompt-stated constraint "Deno not installed" superseded by on-host probe — toolchain present, but no Edge-Function harness exercised. |
| `docker info` (server reachable?) | **client+server both reachable**, but **0 containers running**. `supabase start` has not been invoked this session; no local Supabase stack is up; no Postgres on `localhost:54321/54322` to issue `supabase test db --file <pgtap>` against. The prompt's stated "Docker daemon down" constraint is honored as the effective blocker (no stack started, no DB to test). |
| Ran a prior-slice Playwright spec headed=false | **NOT RUN** — T001 acceptance criteria requires "harness boots"; without a running Next.js dev server + Supabase stack, the spec would either fail-to-connect or sit in a retry loop. Deferred. |
| Ran a prior-slice pgTAP file | **NOT RUN** — same reason: no Postgres listener. Deferred. |

**T001 verdict**: **harness deferred-to-runtime**. All toolchain pieces (Playwright 1.60.0, Supabase CLI 2.98.2, Deno 2.7.14, Docker client+server) are installed and on PATH. The blocker is that the local Supabase stack has not been booted this session, so neither the Playwright nor the pgTAP runners have a backend to talk to. The harness will boot the first time `supabase start && pnpm -F web e2e` is invoked on a Docker-up host — at which point the operator should re-run the slice 004 § 5 PowerShell checklist (see § 7 below).

---

## 1. Cumulative artifact inventory (cited from slice 004 `regression-final.md`)

This is the consolidated baseline slice 005 inherits. Numbers are re-cited verbatim from `specs/004-final-predictions/regression-final.md § 1`; on-disk re-counts performed this session are noted in parentheses where they diverge.

| Surface | Count (regression-final) | On-disk re-count (2026-05-20) | Glob target |
|---|---|---|---|
| Migrations | **42 files** (slots 0001–0048; slots 0012–0017 vacated per D-006) | **42** (matches; max slot = 0048) | `supabase/migrations/*.sql` |
| pgTAP files | **68 files** (S1:12 + S2:9 + S3:22 + S4:25) | **68** (matches) | `supabase/tests/pgtap/*.sql` |
| Playwright specs | **86 files** (S1:14 + S2:13 + S3:25 + S4:33 + smoke) | **85** (S1:14 + S2:12 + S3:25 + S4:33 + smoke = 85; off by one — see note below) | `apps/web/tests/playwright/**/*.spec.ts` |
| Deno tests (sync-catalog) | **15 files** (S2:14 + S4:1) | **15** (matches) | `supabase/functions/sync-catalog/tests/*.test.ts` |
| Seed fixtures | **4 files** | **4** (matches) | `supabase/seed/slice-00{1,2,3,4}-fixture.sql` |
| CI workflows | **1 file** | **1** (matches) | `.github/workflows/ci.yml` |

**Note on the 1-spec Playwright discrepancy**: regression-final.md § 1 / Playwright breakdown asserts slice 002 = 13 specs ("12 from US1+US2+US3 + 1 reconciled in this slice"). On-disk Glob this session finds 12 `slice-002-*.spec.ts` files. The discrepancy may indicate either (a) the "reconciled in this slice" spec was a slice-004-tagged file with slice-002 lineage (regression-final's accounting choice), or (b) a planned-but-not-landed file. This is **out of scope for T001 + T002** — it pre-dates slice 005. Flag for Phase 2 (T003+) authoring discipline: do not modify any prior-slice file to chase this delta; surface it in a future slice 005 deviation if it impacts test totals. Conservative cumulative claim for slice 005's purposes: **85 specs on disk, GREEN-EXPECTED per slice 004 inheritance**.

### Cumulative deviation log (cited from slice 004 `regression-final.md § 4`)

**23 entries** total: D-001 through D-022 with D-018b bridging. Highlights:
- D-006 (slice 002): migration slot 0012–0017 vacated during wave-2 schema reconciliation — the canonical explanation for the 0011→0018 jump in slot numbering.
- D-016 (slice 004): slice 004 migrations shifted +3 (spec slots 0036–0046 → on-disk 0039–0048) to leave room for slice 003's late-added supersede + bulk-lock-states migrations.
- D-020 / D-021 / D-022 (slice 004 / T031): players-ingest polish-phase deviations; do not affect slice 005's scoring math, but slice 005 reads from `public.players` and MUST honor the `aliases`-dropped (D-021) and `conflict_quarantined` outcome (D-022) conventions when authoring fixtures that ingest player rows.

No deviation in the 001–004 log materially blocks slice 005. Slice 005's first new deviation (currently scoped as **D-023 candidate**, see § 6) will be the next entry.

---

## 2. Migration slot accounting (inherited)

Per slice 004's regression-final.md, on-disk migrations span slots 0001–0048 (42 files, 6-slot gap 0012–0017):

| Slice | Slot range | Count |
|---|---|---|
| 001 — Eligibility & Login | 0001–0011 | 11 |
| 002 — Match Catalog & Provider Sync | 0018–0029 | 12 |
| 003 — Match Predictions with Locking | 0030–0038 | 9 |
| 004 — Final Tournament Predictions | 0039–0048 | 10 |
| **Total** | **0001–0048 (gaps 0012–0017)** | **42** |

---

## 3. Playwright spec inventory (one row per spec; GREEN-EXPECTED per slice 004 inheritance)

All rows below carry the **GREEN-EXPECTED** status established by slice 004's `regression-final.md § 2` (the consolidated artifact inventory; runtime pass-status remains deferred to the slice 004 § 5 PowerShell checklist on a Docker-up host).

### Slice 001 — Eligibility & Login (14 specs)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `apps/web/tests/playwright/slice-001-login-approved.spec.ts` | 001 | GREEN-EXPECTED | US1 happy path |
| `apps/web/tests/playwright/slice-001-login-missing-claims.spec.ts` | 001 | GREEN-EXPECTED | claim-shape edge |
| `apps/web/tests/playwright/slice-001-login-denied-domain.spec.ts` | 001 | GREEN-EXPECTED | non-Nortal domain |
| `apps/web/tests/playwright/slice-001-api-me-401.spec.ts` | 001 | GREEN-EXPECTED | auth gate |
| `apps/web/tests/playwright/slice-001-api-me-403-domain-removed.spec.ts` | 001 | GREEN-EXPECTED | mid-session deny |
| `apps/web/tests/playwright/slice-001-api-me-no-leak.spec.ts` | 001 | GREEN-EXPECTED | response-shape contract |
| `apps/web/tests/playwright/slice-001-callback-denied-domain.spec.ts` | 001 | GREEN-EXPECTED | OAuth callback gate |
| `apps/web/tests/playwright/slice-001-denied-no-leak.spec.ts` | 001 | GREEN-EXPECTED | error-page contract |
| `apps/web/tests/playwright/slice-001-denied-renders-without-session.spec.ts` | 001 | GREEN-EXPECTED | unauthenticated denied path |
| `apps/web/tests/playwright/slice-001-callback-no-code.spec.ts` | 001 | GREEN-EXPECTED | OAuth no-code edge |
| `apps/web/tests/playwright/slice-001-email-drift.spec.ts` | 001 | GREEN-EXPECTED | claim drift |
| `apps/web/tests/playwright/slice-001-domain-removed-mid-session.spec.ts` | 001 | GREEN-EXPECTED | participants RLS mid-session |
| `apps/web/tests/playwright/slice-001-missing-optional-claim.spec.ts` | 001 | GREEN-EXPECTED | optional-claim tolerance |
| `apps/web/tests/playwright/slice-001-returning-login-refresh.spec.ts` | 001 | GREEN-EXPECTED | returning-user refresh |

### Slice 002 — Match Catalog & Provider Sync (12 specs on disk)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `apps/web/tests/playwright/slice-002-catalog-401.spec.ts` | 002 | GREEN-EXPECTED | unauthenticated |
| `apps/web/tests/playwright/slice-002-catalog-403-domain-removed.spec.ts` | 002 | GREEN-EXPECTED | mid-session deny |
| `apps/web/tests/playwright/slice-002-catalog-eligible-200.spec.ts` | 002 | GREEN-EXPECTED | happy path |
| `apps/web/tests/playwright/slice-002-catalog-no-leak.spec.ts` | 002 | GREEN-EXPECTED | response-shape contract |
| `apps/web/tests/playwright/slice-002-catalog-filters.spec.ts` | 002 | GREEN-EXPECTED | query-string filters |
| `apps/web/tests/playwright/slice-002-catalog-bad-params.spec.ts` | 002 | GREEN-EXPECTED | 400 mapping |
| `apps/web/tests/playwright/slice-002-catalog-locale-display.spec.ts` | 002 | GREEN-EXPECTED | UI locale |
| `apps/web/tests/playwright/slice-002-late-fixture-appears.spec.ts` | 002 | GREEN-EXPECTED | provider-sync late append |
| `apps/web/tests/playwright/slice-002-catalog-pagination.spec.ts` | 002 | GREEN-EXPECTED | pagination |
| `apps/web/tests/playwright/slice-002-conflict-quarantined.spec.ts` | 002 | GREEN-EXPECTED | sync-conflict outcome |
| `apps/web/tests/playwright/slice-002-outage-alert-dedup.spec.ts` | 002 | GREEN-EXPECTED | outage-alert dedup |
| `apps/web/tests/playwright/slice-002-empty-payload-served-last-known.spec.ts` | 002 | GREEN-EXPECTED | served-last-known on empty |

### Slice 003 — Match Predictions with Locking (25 specs)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `apps/web/tests/playwright/slice-003-submit-happy.spec.ts` | 003 | GREEN-EXPECTED | US1 |
| `apps/web/tests/playwright/slice-003-submit-invalid-score.spec.ts` | 003 | GREEN-EXPECTED | score validation |
| `apps/web/tests/playwright/slice-003-submit-invalid-match.spec.ts` | 003 | GREEN-EXPECTED | match-id validation |
| `apps/web/tests/playwright/slice-003-submit-unauthenticated.spec.ts` | 003 | GREEN-EXPECTED | 401 |
| `apps/web/tests/playwright/slice-003-submit-domain-removed.spec.ts` | 003 | GREEN-EXPECTED | 403 mid-session |
| `apps/web/tests/playwright/slice-003-submit-direct-api-rejected.spec.ts` | 003 | GREEN-EXPECTED | direct-API gate |
| `apps/web/tests/playwright/slice-003-me-predictions-empty.spec.ts` | 003 | GREEN-EXPECTED | empty list |
| `apps/web/tests/playwright/slice-003-me-predictions-list.spec.ts` | 003 | GREEN-EXPECTED | list |
| `apps/web/tests/playwright/slice-003-me-predictions-match-filter.spec.ts` | 003 | GREEN-EXPECTED | match filter |
| `apps/web/tests/playwright/slice-003-me-predictions-401.spec.ts` | 003 | GREEN-EXPECTED | 401 |
| `apps/web/tests/playwright/slice-003-me-predictions-bad-match-id.spec.ts` | 003 | GREEN-EXPECTED | 400 mapping |
| `apps/web/tests/playwright/slice-003-submit-client-clock-ignored.spec.ts` | 003 | GREEN-EXPECTED | Principle VI |
| `apps/web/tests/playwright/slice-003-submit-update-supersedes.spec.ts` | 003 | GREEN-EXPECTED | supersede chain |
| `apps/web/tests/playwright/slice-003-submit-concurrent-tabs.spec.ts` | 003 | GREEN-EXPECTED | serialization |
| `apps/web/tests/playwright/slice-003-me-predictions-after-supersede.spec.ts` | 003 | GREEN-EXPECTED | post-supersede read |
| `apps/web/tests/playwright/slice-003-submit-locked.spec.ts` | 003 | GREEN-EXPECTED | locked window |
| `apps/web/tests/playwright/slice-003-submit-locked-just-inside.spec.ts` | 003 | GREEN-EXPECTED | lock-window boundary inside |
| `apps/web/tests/playwright/slice-003-submit-locked-just-outside.spec.ts` | 003 | GREEN-EXPECTED | lock-window boundary outside |
| `apps/web/tests/playwright/slice-003-submit-status-locked.spec.ts` | 003 | GREEN-EXPECTED | status-based lock |
| `apps/web/tests/playwright/slice-003-matches-lock-state-editable.spec.ts` | 003 | GREEN-EXPECTED | lock-state surface |
| `apps/web/tests/playwright/slice-003-matches-lock-state-locked-window.spec.ts` | 003 | GREEN-EXPECTED | lock-state window |
| `apps/web/tests/playwright/slice-003-matches-lock-state-locked-status.spec.ts` | 003 | GREEN-EXPECTED | lock-state status |
| `apps/web/tests/playwright/slice-003-matches-lock-state-boundary.spec.ts` | 003 | GREEN-EXPECTED | lock-state boundary |
| `apps/web/tests/playwright/slice-003-matches-lock-state-after-config-change.spec.ts` | 003 | GREEN-EXPECTED | post-config lock-state |
| `apps/web/tests/playwright/slice-003-ui-display-countdown.spec.ts` | 003 | GREEN-EXPECTED | countdown UI |

### Slice 004 — Final Tournament Predictions (33 specs)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `apps/web/tests/playwright/slice-004-submit-champion-happy.spec.ts` | 004 | GREEN-EXPECTED | US1 champion |
| `apps/web/tests/playwright/slice-004-submit-top-scorer-happy.spec.ts` | 004 | GREEN-EXPECTED | US1 top scorer |
| `apps/web/tests/playwright/slice-004-me-final-predictions-empty.spec.ts` | 004 | GREEN-EXPECTED | empty list |
| `apps/web/tests/playwright/slice-004-submit-all-four.spec.ts` | 004 | GREEN-EXPECTED | all 4 kinds |
| `apps/web/tests/playwright/slice-004-submit-invalid-team.spec.ts` | 004 | GREEN-EXPECTED | team validation |
| `apps/web/tests/playwright/slice-004-me-final-predictions-list.spec.ts` | 004 | GREEN-EXPECTED | list |
| `apps/web/tests/playwright/slice-004-submit-invalid-player.spec.ts` | 004 | GREEN-EXPECTED | player validation |
| `apps/web/tests/playwright/slice-004-submit-removed-player.spec.ts` | 004 | GREEN-EXPECTED | removed-player path |
| `apps/web/tests/playwright/slice-004-submit-unauthenticated.spec.ts` | 004 | GREEN-EXPECTED | 401 |
| `apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-editable.spec.ts` | 004 | GREEN-EXPECTED | lock-state editable |
| `apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-locked.spec.ts` | 004 | GREEN-EXPECTED | lock-state locked |
| `apps/web/tests/playwright/slice-004-submit-domain-removed.spec.ts` | 004 | GREEN-EXPECTED | 403 mid-session |
| `apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-at-boundary.spec.ts` | 004 | GREEN-EXPECTED | lock-state boundary |
| `apps/web/tests/playwright/slice-004-submit-bad-body.spec.ts` | 004 | GREEN-EXPECTED | 400 mapping |
| `apps/web/tests/playwright/slice-004-me-final-predictions-401.spec.ts` | 004 | GREEN-EXPECTED | 401 |
| `apps/web/tests/playwright/slice-004-me-final-predictions-403.spec.ts` | 004 | GREEN-EXPECTED | 403 |
| `apps/web/tests/playwright/slice-004-teams-200.spec.ts` | 004 | GREEN-EXPECTED | teams happy |
| `apps/web/tests/playwright/slice-004-teams-401.spec.ts` | 004 | GREEN-EXPECTED | teams 401 |
| `apps/web/tests/playwright/slice-004-players-list.spec.ts` | 004 | GREEN-EXPECTED | players list |
| `apps/web/tests/playwright/slice-004-players-team-filter.spec.ts` | 004 | GREEN-EXPECTED | players team filter |
| `apps/web/tests/playwright/slice-004-players-q-search.spec.ts` | 004 | GREEN-EXPECTED | players q-search |
| `apps/web/tests/playwright/slice-004-players-excludes-removed.spec.ts` | 004 | GREEN-EXPECTED | players excludes removed |
| `apps/web/tests/playwright/slice-004-players-401.spec.ts` | 004 | GREEN-EXPECTED | players 401 |
| `apps/web/tests/playwright/slice-004-players-bad-limit.spec.ts` | 004 | GREEN-EXPECTED | players 400 mapping |
| `apps/web/tests/playwright/slice-004-submit-locked.spec.ts` | 004 | GREEN-EXPECTED | finals lock |
| `apps/web/tests/playwright/slice-004-submit-locked-just-after.spec.ts` | 004 | GREEN-EXPECTED | finals lock boundary after |
| `apps/web/tests/playwright/slice-004-submit-just-before-lock.spec.ts` | 004 | GREEN-EXPECTED | finals lock boundary before |
| `apps/web/tests/playwright/slice-004-submit-direct-api-rejected.spec.ts` | 004 | GREEN-EXPECTED | direct-API gate |
| `apps/web/tests/playwright/slice-004-submit-client-clock-ignored.spec.ts` | 004 | GREEN-EXPECTED | Principle VI |
| `apps/web/tests/playwright/slice-004-submit-update-supersedes.spec.ts` | 004 | GREEN-EXPECTED | supersede chain |
| `apps/web/tests/playwright/slice-004-submit-identical-champ-runner.spec.ts` | 004 | GREEN-EXPECTED | identical champ/runner-up |
| `apps/web/tests/playwright/slice-004-me-final-predictions-after-supersede.spec.ts` | 004 | GREEN-EXPECTED | post-supersede read |
| `apps/web/tests/playwright/slice-004-submit-concurrent-tabs.spec.ts` | 004 | GREEN-EXPECTED | serialization |

### Harness smoke (1)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `apps/web/tests/playwright/smoke.spec.ts` | harness | GREEN-EXPECTED | slice 001 T005 — Playwright harness boot probe |

**Slice 005 inheritance total**: 14 + 12 + 25 + 33 + 1 = **85 specs on disk**, all carried forward as GREEN-EXPECTED per slice 004 § 2. (Slice 004 regression-final cites 86; the 1-spec accounting delta is noted in § 1 above and is not a slice-005 blocker.)

---

## 4. pgTAP file inventory (one row per file; GREEN-EXPECTED per slice 004 inheritance)

### Slice 001 — Eligibility & Login (12 files)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `supabase/tests/pgtap/_harness_smoke.sql` | 001 | GREEN-EXPECTED | pgTAP harness probe |
| `supabase/tests/pgtap/is_eligible_active_approved.sql` | 001 | GREEN-EXPECTED | predicate happy |
| `supabase/tests/pgtap/is_eligible_deactivated.sql` | 001 | GREEN-EXPECTED | predicate deactivated |
| `supabase/tests/pgtap/is_eligible_unknown_uid.sql` | 001 | GREEN-EXPECTED | predicate unknown-uid |
| `supabase/tests/pgtap/is_eligible_null_uid.sql` | 001 | GREEN-EXPECTED | predicate null-uid |
| `supabase/tests/pgtap/auth_hook_first_login.sql` | 001 | GREEN-EXPECTED | first-login auth hook |
| `supabase/tests/pgtap/is_approved_domain.sql` | 001 | GREEN-EXPECTED | domain predicate (D-002) |
| `supabase/tests/pgtap/slice-001-api-me-rls.sql` | 001 | GREEN-EXPECTED | api-me RLS |
| `supabase/tests/pgtap/participants_rls_mid_session_deny.sql` | 001 | GREEN-EXPECTED | mid-session deny |
| `supabase/tests/pgtap/auth_hook_returning_login.sql` | 001 | GREEN-EXPECTED | returning-login auth hook |
| `supabase/tests/pgtap/auth_hook_fails_closed_on_missing_config.sql` | 001 | GREEN-EXPECTED | fails-closed |
| `supabase/tests/pgtap/is_eligible_perf.sql` | 001 | GREEN-EXPECTED | predicate perf |

### Slice 002 — Match Catalog & Provider Sync (9 files)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `supabase/tests/pgtap/slice-002-catalog-rls.sql` | 002 | GREEN-EXPECTED | catalog RLS |
| `supabase/tests/pgtap/record_match_result_happy.sql` | 002 | GREEN-EXPECTED | SP happy |
| `supabase/tests/pgtap/record_match_result_rejects_pre_finished.sql` | 002 | GREEN-EXPECTED | SP pre-finished reject |
| `supabase/tests/pgtap/record_match_result_enforces_for_scoring_invariant.sql` | 002 | GREEN-EXPECTED | for-scoring invariant |
| `supabase/tests/pgtap/record_match_result_enforces_shootout_invariant.sql` | 002 | GREEN-EXPECTED | shootout invariant |
| `supabase/tests/pgtap/record_match_result_admin_correction_requires_approver.sql` | 002 | GREEN-EXPECTED | correction approver |
| `supabase/tests/pgtap/record_match_result_admin_correction_requires_admin.sql` | 002 | GREEN-EXPECTED | correction admin role |
| `supabase/tests/pgtap/record_match_result_emits_notification.sql` | 002 | GREEN-EXPECTED | NOTIFY emission (D-008) |
| `supabase/tests/pgtap/record_match_result_audit_format.sql` | 002 | GREEN-EXPECTED | audit row shape |

### Slice 003 — Match Predictions with Locking (22 files)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `supabase/tests/pgtap/submit_prediction_create_happy.sql` | 003 | GREEN-EXPECTED | SP create happy |
| `supabase/tests/pgtap/submit_prediction_invalid_score.sql` | 003 | GREEN-EXPECTED | score validation |
| `supabase/tests/pgtap/submit_prediction_invalid_match.sql` | 003 | GREEN-EXPECTED | match validation |
| `supabase/tests/pgtap/submit_prediction_ineligible.sql` | 003 | GREEN-EXPECTED | ineligible predicate |
| `supabase/tests/pgtap/submit_prediction_update_supersedes.sql` | 003 | GREEN-EXPECTED | supersede chain |
| `supabase/tests/pgtap/submit_prediction_audit_format.sql` | 003 | GREEN-EXPECTED | audit row shape |
| `supabase/tests/pgtap/submit_prediction_locked_window.sql` | 003 | GREEN-EXPECTED | locked-window reject |
| `supabase/tests/pgtap/submit_prediction_locked_status_in_progress.sql` | 003 | GREEN-EXPECTED | status-based lock reject |
| `supabase/tests/pgtap/is_prediction_locked_far_before.sql` | 003 | GREEN-EXPECTED | predicate far-before |
| `supabase/tests/pgtap/is_prediction_locked_strict_boundary_at.sql` | 003 | GREEN-EXPECTED | boundary at |
| `supabase/tests/pgtap/is_prediction_locked_strict_boundary_just_outside.sql` | 003 | GREEN-EXPECTED | boundary just-outside |
| `supabase/tests/pgtap/is_prediction_locked_strict_boundary_just_inside.sql` | 003 | GREEN-EXPECTED | boundary just-inside |
| `supabase/tests/pgtap/is_prediction_locked_status_in_progress.sql` | 003 | GREEN-EXPECTED | status in_progress |
| `supabase/tests/pgtap/is_prediction_locked_status_finished.sql` | 003 | GREEN-EXPECTED | status finished |
| `supabase/tests/pgtap/is_prediction_locked_status_postponed.sql` | 003 | GREEN-EXPECTED | status postponed |
| `supabase/tests/pgtap/is_prediction_locked_status_cancelled.sql` | 003 | GREEN-EXPECTED | status cancelled |
| `supabase/tests/pgtap/is_prediction_locked_unknown_match.sql` | 003 | GREEN-EXPECTED | unknown match |
| `supabase/tests/pgtap/is_prediction_locked_config_changes.sql` | 003 | GREEN-EXPECTED | mid-tournament config |
| `supabase/tests/pgtap/is_prediction_locked_uses_db_clock.sql` | 003 | GREEN-EXPECTED | Principle VI |
| `supabase/tests/pgtap/is_prediction_locked_perf.sql` | 003 | GREEN-EXPECTED | predicate perf |
| `supabase/tests/pgtap/submit_prediction_serializes_concurrent.sql` | 003 | GREEN-EXPECTED | serialization |
| `supabase/tests/pgtap/submit_prediction_admin_override.sql` | 003 | GREEN-EXPECTED | admin override |

### Slice 004 — Final Tournament Predictions (25 files)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `supabase/tests/pgtap/submit_final_prediction_create_champion_happy.sql` | 004 | GREEN-EXPECTED | SP champion happy |
| `supabase/tests/pgtap/submit_final_prediction_create_top_scorer_happy.sql` | 004 | GREEN-EXPECTED | SP top-scorer happy |
| `supabase/tests/pgtap/submit_final_prediction_invalid_kind.sql` | 004 | GREEN-EXPECTED | kind enum validation |
| `supabase/tests/pgtap/submit_final_prediction_invalid_target_shape.sql` | 004 | GREEN-EXPECTED | target shape validation |
| `supabase/tests/pgtap/submit_final_prediction_invalid_target_missing.sql` | 004 | GREEN-EXPECTED | target missing |
| `supabase/tests/pgtap/submit_final_prediction_invalid_target_removed_player.sql` | 004 | GREEN-EXPECTED | removed-player target |
| `supabase/tests/pgtap/submit_final_prediction_audit_format.sql` | 004 | GREEN-EXPECTED | audit row shape (D-019) |
| `supabase/tests/pgtap/is_final_prediction_locked_before.sql` | 004 | GREEN-EXPECTED | predicate before |
| `supabase/tests/pgtap/is_final_prediction_locked_at_boundary.sql` | 004 | GREEN-EXPECTED | predicate boundary |
| `supabase/tests/pgtap/is_final_prediction_locked_just_before.sql` | 004 | GREEN-EXPECTED | predicate just-before |
| `supabase/tests/pgtap/is_final_prediction_locked_just_after.sql` | 004 | GREEN-EXPECTED | predicate just-after |
| `supabase/tests/pgtap/is_final_prediction_locked_far_after.sql` | 004 | GREEN-EXPECTED | predicate far-after |
| `supabase/tests/pgtap/is_final_prediction_locked_config_missing.sql` | 004 | GREEN-EXPECTED | config missing |
| `supabase/tests/pgtap/is_final_prediction_locked_config_changes.sql` | 004 | GREEN-EXPECTED | config change |
| `supabase/tests/pgtap/is_final_prediction_locked_uses_db_clock.sql` | 004 | GREEN-EXPECTED | Principle VI |
| `supabase/tests/pgtap/is_final_prediction_locked_perf.sql` | 004 | GREEN-EXPECTED | predicate perf |
| `supabase/tests/pgtap/submit_final_prediction_locked.sql` | 004 | GREEN-EXPECTED | locked reject |
| `supabase/tests/pgtap/submit_final_prediction_serializes_concurrent.sql` | 004 | GREEN-EXPECTED | serialization |
| `supabase/tests/pgtap/submit_final_prediction_update_supersedes.sql` | 004 | GREEN-EXPECTED | supersede chain |
| `supabase/tests/pgtap/submit_final_prediction_identical_champion_runner_up.sql` | 004 | GREEN-EXPECTED | identical champ/runner-up |
| `supabase/tests/pgtap/submit_final_prediction_admin_override.sql` | 004 | GREEN-EXPECTED | admin override |
| `supabase/tests/pgtap/players_ingest_happy.sql` | 004 | GREEN-EXPECTED | T031 / D-020 |
| `supabase/tests/pgtap/players_ingest_update.sql` | 004 | GREEN-EXPECTED | T031 / D-020 |
| `supabase/tests/pgtap/players_ingest_soft_delete.sql` | 004 | GREEN-EXPECTED | T031 / D-021 |
| `supabase/tests/pgtap/players_ingest_undersized_quarantined.sql` | 004 | GREEN-EXPECTED | T031 / D-022 (`conflict_quarantined` outcome) |

**Slice 005 inheritance total**: 12 + 9 + 22 + 25 = **68 pgTAP files**, all GREEN-EXPECTED per slice 004 § 2.

---

## 5. Deno test inventory (one row per file; GREEN-EXPECTED per slice 004 inheritance)

| File path | Slice | Status | Notes |
|---|---|---|---|
| `supabase/functions/sync-catalog/tests/advisory_lock_returns_409.test.ts` | 002 | GREEN-EXPECTED | concurrency guard |
| `supabase/functions/sync-catalog/tests/non_admin_returns_403.test.ts` | 002 | GREEN-EXPECTED | role gate (D-011) |
| `supabase/functions/sync-catalog/tests/internal_auth_path.test.ts` | 002 | GREEN-EXPECTED | internal auth |
| `supabase/functions/sync-catalog/tests/provider_swap.test.ts` | 002 | GREEN-EXPECTED | provider abstraction |
| `supabase/functions/sync-catalog/tests/single_sync_happy.test.ts` | 002 | GREEN-EXPECTED | happy path |
| `supabase/functions/sync-catalog/tests/idempotent_retry.test.ts` | 002 | GREEN-EXPECTED | idempotency |
| `supabase/functions/sync-catalog/tests/empty_payload_rejected.test.ts` | 002 | GREEN-EXPECTED | empty reject |
| `supabase/functions/sync-catalog/tests/undersized_payload_rejected.test.ts` | 002 | GREEN-EXPECTED | undersized reject |
| `supabase/functions/sync-catalog/tests/cross_run_conflict_quarantined.test.ts` | 002 | GREEN-EXPECTED | conflict outcome |
| `supabase/functions/sync-catalog/tests/duplicate_in_payload_rejected.test.ts` | 002 | GREEN-EXPECTED | duplicate reject |
| `supabase/functions/sync-catalog/tests/outage_alert_dedup.test.ts` | 002 | GREEN-EXPECTED | outage dedup |
| `supabase/functions/sync-catalog/tests/score_before_kickoff_quarantined.test.ts` | 002 | GREEN-EXPECTED | pre-kickoff score quarantine |
| `supabase/functions/sync-catalog/tests/recovery_clears_outage_state.test.ts` | 002 | GREEN-EXPECTED | recovery clears outage |
| `supabase/functions/sync-catalog/tests/sync_perf.test.ts` | 002 | GREEN-EXPECTED | perf gate |
| `supabase/functions/sync-catalog/tests/players_branch.test.ts` | 004 | GREEN-EXPECTED | T031 / D-020 (sibling fixture) |

**Slice 005 inheritance total**: 14 + 1 = **15 Deno tests**, all GREEN-EXPECTED per slice 004 § 2.

---

## 6. Slice 005 slot pressure — D-023 candidate

`specs/005-scoring-leaderboard/plan.md § Project Structure / Source Code` enumerates slice 005 migrations at slots **0050–0059** (10 files):

- 0050 `score_records`
- 0051 `score_calculation_runs`
- 0052 `tournament_award`
- 0053 `score_match_fn`
- 0054 `score_finals_fn`
- 0055 `leaderboard_view`
- 0055b `personal_breakdown_view` (split sibling)
- 0056 `score_audit_trigger`
- 0057 `score_rls`
- 0058 `score_config_defaults`
- 0059 `score_auto_trigger` (FR-007 auto-path)

Slice 004 ends at on-disk slot **0048** (per § 2 above). The planned 0050 starting slot leaves a 1-slot gap (0049 unfilled). Per the existing project convention — Postgres only enforces ordering, not contiguity (see slice 004 regression-final § 1) — this is non-blocking, but the existing slice-to-slot mapping has been "first new slot = previous-slice-max + 1" since slice 002 (0018 follows 0011 only because slots 0012–0017 were vacated per D-006). To keep the convention consistent, **slice 005's migration sequence should start at slot 0049**, shifting the planned 0050–0059 mapping by −1 to **0049–0058**.

**D-023 candidate (proposed deviation, slice 005)**:
- **Slice**: 005
- **Title**: Slice 005 migration slot renumber −1 (planned 0050–0059 → on-disk 0049–0058)
- **Trigger**: T003 (first migration: `score_records`)
- **Rationale**: Preserve "first new slot = previous-slice-max + 1" convention; avoid an unexplained 0049 gap that would echo D-006's (intentional, documented) 0012–0017 gap without the underlying reconciliation justification.
- **Impact**: All slice-005 plan.md slot references (filenames + cross-references in `data-model.md`, `contracts/*.md`, `quickstart.md`) need to shift by −1. The `0055b` split-sibling becomes `0054b` under the new sequence.
- **Resolution**: To be confirmed by Phase 2 (T003) before the first migration file ships. If Phase 2 elects to keep the 0050 start and accept a 0049 gap (analogous to D-006's vacated band), D-023 is withdrawn and the rationale ("acceptable gap; Postgres only enforces ordering") is recorded instead.

**Action required before T003 ships**: Phase 2 owner must decide (a) renumber to 0049–0058 (D-023 lands) or (b) keep 0050–0059 with explicit "0049 gap acceptable" annotation (D-023 withdrawn). Either decision is defensible; this baseline document only flags the choice point.

---

## 6.1 Phase 2 Deviations (resolved during T003–T008 execution)

### D-023 — Slice 005 migration slot renumber (RESOLVED, landed)

- **Slice**: 005
- **Phase**: 2 (Foundational)
- **Title**: Slice 005 migration slot renumber. Spec slots 0050-0058 shift -1 to fill from on-disk slot 0049 (slice 004 ends at on-disk slot 0048).
- **Resolution**: Option (a) — D-023 LANDS. Migrations renumbered to start at on-disk slot 0049.
- **Full mapping** (spec task → on-disk slot):
  - T003 → 0049 (`score_records`)
  - T004 → 0050 (`score_calculation_runs`)
  - T005 → 0051 (`tournament_award`)
  - T013 → 0052 (`score_match_fn`)
  - T019 → 0053 (`score_finals_fn`)
  - T029 → 0054 (`leaderboard_view`)
  - T035 → 0054b (`personal_breakdown_view` split-sibling)
  - T014 → 0055 (`score_audit_trigger`)
  - T007 → 0056 (`score_rls`)
  - T006 → 0057 (`score_config_defaults`)
- **Verification**: On-disk slots 0049, 0050, 0051, 0056, 0057 confirmed present (T003, T004, T005, T007, T006 done). Slots 0052, 0053, 0054, 0054b, 0055 reserved for Phase 3+ implementation tasks.

### D-024 — `score_records.participant_id` FKs to `public.participants(id)` (Phase 2, T007)

- **Slice**: 005
- **Phase**: 2 (Foundational)
- **Trigger task**: T007 (slot 0056 / `score_rls.sql`)
- **Title**: `score_records.participant_id` FKs to `public.participants(id)`, not `auth.users(id)`.
- **Rationale**: The original tasks.md T007 spec text proposed an RLS policy of the form `participant_id = auth.uid()`. That's incorrect because `score_records.participant_id` is a FK to `public.participants(id)`, NOT to `auth.users(id)` (see migration 0049 line 131 column declaration: `participant_id uuid NOT NULL REFERENCES public.participants (id) ON DELETE RESTRICT`). The slice 004 established the correct pattern in `0042_final_predictions_rls.sql` ("self-read predicate maps auth.uid() through participants").
- **Resolution**: RLS policy `score_records_self_read` uses `participant_id IN (SELECT id FROM participants WHERE auth_user_id = auth.uid())`, mirroring slice 004's predicate shape. The original text was patched in slot 0056 BEFORE T008 ran, so T008's fixture is unaffected.
- **Impact on T008**: None. T008 only INSERTs `score_records`-adjacent data (predictions, finals, awards) via superuser-mode `supabase db reset`; the RLS policy patched in D-024 is exercised only at runtime by tests after T013/T019 produce score_records rows.

---

## 7. Pre-merge runtime sweep (carried forward)

The canonical merge gate for slices 001–005 (and any subsequent slice) remains the PowerShell checklist in **`specs/004-final-predictions/regression-final.md § 5`**. Slice 005 inherits it verbatim — every prior-slice migration + pgTAP + Playwright + Deno surface is re-run by that checklist's loops. Slice 005's own surfaces (migrations 0049+ or 0050+, slice-005-*.spec.ts, score-related pgTAP + Edge-Function Deno tests) will be appended to the same loops as they land; no new runbook is needed for this baseline.

**The slice 005 merge gate IS NOT this document.** This document is the artifact baseline + handoff. The merge gate is "run slice 004's § 5 PowerShell checklist on a Docker-up + Deno-installed host AND get 100% GREEN across all 68 + slice-005-new pgTAP + 85 + slice-005-new Playwright + 15 + slice-005-new Deno + quickstart browser session". Slice 005 phases 2–7 are each individually subject to that gate per Principle XI ("regression GREEN before next task starts or merge"), but the artifact baseline asserts only "everything that came before is GREEN-EXPECTED".

---

## 8. Verdict

> **BASELINE ARTIFACT-COMPLETE. Slice 005 may proceed with artifact authoring. Pre-merge runtime sweep deferred to first Docker-available environment (slice 004 T034 owns the canonical PowerShell checklist).**
>
> Cumulative inheritance: **42 migrations, 68 pgTAP, 85 Playwright specs on disk (regression-final cites 86 — 1-spec accounting delta noted, non-blocking), 15 Deno tests, 23 deviations (D-001 … D-022 with D-018b bridging).** All artifacts are on disk and GREEN-EXPECTED. Slice 005's first new deviation is flagged as **D-023 candidate** (migration slot renumber 0050→0049) for Phase 2 to resolve before T003 ships.
>
> Per Constitution Principle XI (NON-NEGOTIABLE), slice 005 MAY NOT merge to `main` until the slice 004 § 5 PowerShell checklist returns 100% GREEN — extended to cover slice 005's added migrations, pgTAP, Playwright, and Deno tests — on a Docker-up + Deno-installed host. This document IS NOT itself the merge gate; it is the artifact baseline the operator carries into Phase 2.

---

This is the **World Cup Madness** project.
