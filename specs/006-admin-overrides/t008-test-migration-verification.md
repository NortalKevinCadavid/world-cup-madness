# T008 — Cross-slice `is_admin` test migration verification

**Slice**: 006-admin-overrides
**Task**: T008
**Date**: 2026-05-21
**Constitution anchor**: Principle XI (NON-NEGOTIABLE regression preservation across cross-slice contract changes)
**Status**: **VERIFIED — no test source edits required.** Defensive `beforeAll` upsert added to `slice-005-match-scoring.spec.ts`.

---

## 1. Audit reference

This verification reuses T002's per-test inventory verbatim. Re-running that audit was out of scope for T008; the source-of-truth document is:

- `specs/006-admin-overrides/is-admin-test-migration.md` (T002 output, 2026-05-21)

T002 scanned **191 test files** (75 pgTAP + 92 Playwright + 24 Deno) and classified every `is_admin`/admin-context reference as Type 1, Type 2, Type 3, or comment-only. The key finding (§ 2 of T002):

> **Total bytes of test code requiring source edit under T008: 0.**
> **T008 reduces to verification + (optional) defensive `beforeAll` insertions.**

This document is that verification + defensive insertion record.

---

## 2. Why no source edits are required

Two cross-slice facts compose to make T008 a no-op for the test inventory:

1. **All Type 1 tests use admin1@nortal.com.** T002 found 8 Type 1 tests (7 named tests + 1 AS5 helper call in `slice-005-match-scoring.spec.ts`); every one signs in via the OIDC stub as `ADMIN1` (sub `00...0d3`, participant_id `77777777-...-7`).
2. **T009's bootstrap (slot 0074) seeds `admin_roles` for admin1.** The migration defaults `tournament_config.admin.bootstrap_participant_email = "admin1@nortal.com"` and conditionally INSERTs an `admin_roles` row for the matching participant. The slice-005 fixture already seeds that participant at lines 247-258, so the bootstrap conditional matches.

Result: after `supabase db reset` (which applies migrations after seeds), admin1 has an active `admin_roles` row with no per-test code change.

---

## 3. Per-test verification table

| Test file | Test count | Type | Bootstrap coverage | Source edit required |
|---|---|---|---|---|
| `apps/web/tests/playwright/slice-005-match-scoring.spec.ts` (AS1-AS7 + AS5 audit-row helper) | 7 tests + 1 helper | **Type 1** | T009 slot 0074 seeds `admin_roles` for admin1 (`77777777-...-7`) | **No** — defensive `beforeAll` upsert added (see § 4) |
| `apps/web/tests/playwright/slice-005-peer-pick-visibility.spec.ts` Test 5 ("Direct REST with admin JWT pre-lock") | 1 | Type 2 (admin asserts deny) | n/a — assertion is `length === 0`; admin gets no bypass on `peer_pick_v` | No |
| `supabase/tests/pgtap/slice-001-api-me-rls.sql` | comment-only | Type 2 + comment-only | n/a — never sets up admin context | No |
| `supabase/tests/pgtap/participants_rls_mid_session_deny.sql` | comment-only | Type 2 + comment-only | n/a | No |
| `supabase/tests/pgtap/slice-002-catalog-rls.sql` | comment-only | Type 2 + comment-only | n/a — adding admin1 admin_roles would BREAK "0 rows" assertions | No (intentional) |
| `supabase/tests/pgtap/record_match_result_admin_correction_requires_admin.sql` | 1 | Type 2 | n/a — alpha (non-admin) still raises | No |
| `supabase/tests/pgtap/record_match_result_admin_correction_requires_approver.sql` | 1 | Type 2 | n/a — NULL approver check fires before is_admin | No |
| `supabase/tests/pgtap/submit_prediction_admin_override.sql` | 1 | Type 2 (SP enum path) | n/a — SP body never calls is_admin | No |
| `supabase/tests/pgtap/submit_final_prediction_admin_override.sql` | 1 | Type 2 (SP enum path) | n/a — same | No |
| `supabase/tests/pgtap/peer_pick_rls_lock_boundary.sql` | 1 | Type 2 | n/a — alpha only | No |
| `supabase/functions/sync-catalog/tests/non_admin_returns_403.test.ts` | 1 | Type 2 | n/a — fresh user has no admin_roles row → 403 still holds | No |
| `supabase/functions/score-trigger/tests/non_admin_returns_403.test.ts` | 1 | Type 2 | n/a — same | No |
| `apps/web/tests/playwright/slice-005-final-scoring.spec.ts` | n/a | N/A (X-Internal-Auth bypass) | n/a — bypass skips is_admin | No |
| `apps/web/tests/playwright/slice-005-leaderboard.spec.ts` | n/a | N/A (X-Internal-Auth + alpha sign-in) | n/a | No |
| `apps/web/tests/playwright/slice-005-breakdown*.spec.ts` (2 files) | n/a | N/A | n/a | No |
| `apps/web/tests/playwright/slice-002-*.spec.ts` (5 files) | n/a | N/A / comment-only | n/a | No |
| All `slice-001-*`, `slice-003-*`, `slice-004-*` Playwright specs | n/a | comment-only / no admin reference | n/a | No |
| (no Type 3 tests per T002 § 3) | 0 | — | — | — |

**Totals**: 8 Type 1 tests in 1 file (all bootstrap-covered) · 13 Type 2 tests across 9 files (deny path unchanged) · 0 Type 3 tests · 0 source edits required.

---

## 4. Defensive `beforeAll` upsert decision

**Decision: ADDED.** A defensive `beforeAll` admin_roles upsert was added to `apps/web/tests/playwright/slice-005-match-scoring.spec.ts`.

### Rationale

The Slice 005 fixture seeds admin1 in `participants`; the T009 bootstrap migration seeds `admin_roles` for the matching participant. The two are correctly coupled in the standard `supabase db reset` workflow. However, the test file is theoretically exposed to drift in three scenarios:

1. **Partial migration replay** — a developer runs only a subset of migrations and skips T009 (slot 0074) without realising the slice-005 tests have a transitive dependency on it.
2. **Fixture-only DB resets** — a workflow that loads the seed file without re-running migrations leaves admin1 in `participants` but without an `admin_roles` row.
3. **Future fixture drift** — if a later slice changes admin1's email or the bootstrap key, the T009 conditional would no-op silently.

The defensive seed is cheap (one round-trip per test file), idempotent, and shares semantics with the bootstrap (NULL `granted_by`, active row keyed on `participant_id WHERE revoked_at IS NULL`). It does not change test semantics — in the common path (bootstrap already seeded admin1) it is a no-op SELECT.

### Implementation

A shared helper was added at:

- `apps/web/tests/playwright/helpers/admin-roles.ts` (new file)

The helper exports `ensureAdminRole(participantId: string): Promise<AdminRoleRow>`, which uses a SELECT-then-INSERT pattern (because supabase-js does not support partial-index conflict targets — `ON CONFLICT (participant_id) WHERE revoked_at IS NULL` — natively). The helper recovers from the unique-violation race by re-SELECTing.

The spec file was modified at two points:

1. Imported `ensureAdminRole` from `./helpers/admin-roles`.
2. Extended the existing `test.beforeAll` hook to call `ensureAdminRole(ADMIN1_PARTICIPANT_ID)` after `assertOidcStubReachable()`.

A new fixture-derived constant `ADMIN1_PARTICIPANT_ID = "77777777-7777-7777-7777-777777777777"` was added alongside the existing `PARTICIPANTS` map (it deliberately lives outside that map because admin1 is not a regular participant in the AS1-AS7 truth table).

### Files touched

| File | Change |
|---|---|
| `apps/web/tests/playwright/helpers/admin-roles.ts` | NEW — `ensureAdminRole(participantId)` helper |
| `apps/web/tests/playwright/slice-005-match-scoring.spec.ts` | Added import + `ADMIN1_PARTICIPANT_ID` constant + `ensureAdminRole` call in `test.beforeAll` |

### Alternative considered — strict bootstrap-only contract

The alternative posture is: "test files must NEVER seed admin authority — the bootstrap migration is the sole source of truth, and any failure of that bootstrap is a migration bug, not a test bug." Under that posture no `beforeAll` would be added; a missing admin_roles row would surface as 403s in CI and be diagnosed as a missing T009 application.

This alternative was REJECTED because (a) the defensive seed is small and mode-safe, (b) it shortens the diagnostic feedback loop for the "I forgot to re-run migrations" failure mode, and (c) Principle XI prioritises regression preservation over architectural purity for cross-slice contract changes.

---

## 5. Recommendation

**Add the defensive upsert** (DONE). It costs ~10 lines of test-side code, is idempotent, and protects the Type 1 tests against three identified drift scenarios. Future slice 006 tests that need admin authority can reuse `ensureAdminRole(...)` from the shared helper.

---

## 6. Verdict

**T008 complete.**

- All 191 test files surveyed by T002 are accounted for in § 3.
- 0 source edits were required for is_admin semantics.
- Defensive `beforeAll` admin_roles seed added to the 1 Type 1 test file as belt-and-suspenders.
- No breakage is expected from T007's `is_admin` body change because:
  - Type 1 (8 tests) — now satisfied by T009 bootstrap AND by the defensive `beforeAll`.
  - Type 2 (13 tests) — deny path is unchanged.
  - Type 3 (0 tests) — none exist; T033 will author the new `is_admin_*.sql` suite from scratch.

Re-run verification (per T002 § 5.B) will be captured in the regression baseline checkpoint after T007 + T009 land together.

---

## 7. Definition of done (T008)

- [x] Cross-slice impact verified against T002's inventory.
- [x] Defensive `beforeAll` upsert added to `slice-005-match-scoring.spec.ts`.
- [x] Reusable `ensureAdminRole(participantId)` helper authored for future slice 006 tests.
- [x] Verification document filed at `specs/006-admin-overrides/t008-test-migration-verification.md`.
- [x] No migrations modified; no pgTAP files modified.
- [x] Principle XI regression-preservation traceability anchored in this document.
