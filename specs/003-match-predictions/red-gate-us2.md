# RED Gate — Slice 003 / User Story 2 (US2)

**Slice**: `003-match-predictions`
**Phase**: 4 (US2 — "Eligible participant updates an in-window prediction; prior submission retained as superseded history")
**Date**: 2026-05-20
**Constitution anchor**: Principle IX (TDD via BDD) — every behaviorally-meaningful test for a slice must be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T020 (the Principle IX gate task itself; US2 red-gate document)

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-4 / US2 RED tests authored in T018 (pgTAP, 2 files) and T019 (Playwright, 3 files / 3 tests) are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 003 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

Phase 4 (US2) produced **5 RED-state test files** (3 Playwright specs + 2 pgTAP scripts). T018 fans out into 2 pgTAP files covering the supersede branch of the existing `submit_prediction(...)` SP at on-disk slot **0034** (the body extended by T021 at slot **0037** per D-012's slot map). T019 fans out into 3 Playwright files / 3 tests covering the supersede behavior over the HTTP route surface (`POST /api/predictions` + `GET /api/me/predictions`).

Total: **3 Playwright tests + 2 pgTAP scripts** (with `plan(6) + plan(5) = 11` pgTAP assertions) **= 5 behaviorally-distinct RED units**.

### pgTAP files (T018 — 2 files, 11 planned assertions)

All RED units in this slice share **one** root-cause failure mode: T013 (the US1-owned SP body shipped at on-disk slot 0034) raises the **provisional `WCM06` (`DUPLICATE_ACTIVE`)** error on any pre-existing active row for `(participant_id, match_id)` per **D-013**. T021 will replace that WCM06 branch with the supersede UPDATE+INSERT pattern (`SELECT ... FOR UPDATE` of the active row, `INSERT` new, `UPDATE` old setting `superseded_at = now()` + `superseded_by = v_new_id`). Every assertion below is unreachable until T021 lands. Each file uses the BEGIN / `plan(N)` / asserts / `finish` / ROLLBACK pattern so no residue persists if the SP partially exists.

| # | Test file | `plan(N)` | Expected RED failure signature PRE-T021 | GREEN implementer |
|---|-----------|-----------|-----------------------------------------|-------------------|
| 1 | `supabase/tests/pgtap/submit_prediction_update_supersedes.sql` | `plan(6)` | **RED**. The fixture row 5 (alpha + M4, 1-1, ui) is intentionally retained (NOT deleted, contrast T010's create-happy test). The first and only `public.submit_prediction(alpha, M4, 2, 1, 'ui')` call at lines ~43–49 raises `ERRCODE='WCM06'` (`DUPLICATE_ACTIVE`) per D-013's provisional branch. The `set_config('test.new_id', …)` never executes, so all six assertions (A1 OLD row superseded with `superseded_by` link, A2 NEW row active, A3 exactly one active row for `(alpha, M4)`, A4 NEW row carries `predicted_home=2, predicted_away=1, source='ui'`, A5 one `prediction.superseded` audit row references OLD id, A6 one `prediction.created` audit row references NEW id) are unreachable — pgTAP reports either a function-level exception bailout or a planned-vs-run mismatch. | T021 (migration `0036_submit_prediction_supersede.sql` shipped at on-disk slot **0037** per D-012; replaces the WCM06 branch with the supersede UPDATE+INSERT chain). |
| 2 | `supabase/tests/pgtap/submit_prediction_audit_format.sql` | `plan(5)` | **RED on the supersede half**. Step 1 (line ~46) calls the SP for the previously-empty `(alpha, M6)` pair — this is the CREATE branch and **may** execute successfully against T013 today, but assertions A1 + A2 (audit-row shape verification for `prediction.created`) depend on the slot-0033 trigger emitting the row with the correct FR-011 shape. Step 2 (line ~98) issues a second call for the same `(alpha, M6)` pair with `(3, 2)`; this re-enters the SP with an active row already present and raises `ERRCODE='WCM06'` per D-013. Assertions A3 (`prediction.superseded` audit row carrying OLD scores in `previous_value` and post-UPDATE `superseded_at` in `new_value`), A4 (actor on the superseded row = NEW prediction's `created_by` = alpha), and A5 (exactly 3 audit rows total: 2 `prediction.created` + 1 `prediction.superseded`) are unreachable because the audit row count remains at 1 (`prediction.created` for the first id only). pgTAP marks A3–A5 as `not ok`. | T021 (replaces the WCM06 branch so the second call INSERTs + UPDATEs in one txn; the slot-0033 trigger already emits both `prediction.created` (new row) and `prediction.superseded` (old row) automatically — no trigger change needed). |

### Playwright files (T019 — 3 files, 3 tests)

All 3 files are tagged `@slice-003 @us2`. The expected RED reason is uniformly: the **second** `POST /api/predictions` call in each scenario returns HTTP **409** with body `{ error: { code: "DUPLICATE_ACTIVE", … } }` because the route handler (T015, shipped in US1) maps the SP's `WCM06` SQLSTATE to a 409 envelope. Each test's first status assertion past that point — `expect(second.status()).toBe(200)` (supersedes / me-after-supersede) or `expect(respB.status()).toBe(200)` (concurrent-tabs) — fails immediately. The pre-supersede `POST` (the CREATE) succeeds today against T013 + T015, so the failure surface is the *transition* from CREATE to UPDATE, not the route handler itself.

| # | Test file | Tests | Expected status PRE-T021 | GREEN implementer |
|---|-----------|-------|--------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-003-submit-update-supersedes.spec.ts` | 1 test | **RED**. First POST `(alpha, M6, 1, 0)` returns 200 (CREATE branch). Second POST `(alpha, M6, 2, 1)` returns **409 `DUPLICATE_ACTIVE`** per D-013 — the assertion `expect(second.status(), "second POST (UPDATE/supersede) MUST be 200 — NOT 409 — per US2 AS-1").toBe(200)` (line ~146) fails. The downstream service-role assertions (first row's `superseded_at` set + `superseded_by` linking to second id; second row active; exactly one active row for `(alpha, M6)`) are unreachable. | T021 (SP supersede branch → second POST returns 200 with the new active row; the route handler in T015 already returns the SP's row as-is so no T015 change is required). |
| 2 | `apps/web/tests/playwright/slice-003-submit-concurrent-tabs.spec.ts` | 1 test | **RED**. Two browser contexts both signed in as alpha fire `POST /api/predictions` on M6 in parallel via `Promise.all`. The SP's `pg_advisory_xact_lock(hashtext(participant || ':' || match))` serializes them, so the *first* writer wins the lock and INSERTs (CREATE branch → 200). The *second* writer acquires the lock, sees the active row from the first writer, and raises **`WCM06`** → route maps to **409 `DUPLICATE_ACTIVE`**. The assertion `expect(respB.status(), "context B POST MUST be 200 — advisory lock serializes, never 409").toBe(200)` (line ~155) fails (or `respA` if A drew the second slot — order is not contract). Service-role invariants (1 active + 1 superseded = 2 total) are unreachable. | T021 (SP supersede branch → both writers' transactions commit serially via the advisory lock; second writer's INSERT supersedes the first writer's row → both return 200). |
| 3 | `apps/web/tests/playwright/slice-003-me-predictions-after-supersede.spec.ts` | 1 test | **RED**. First POST `(alpha, M6, 1, 0)` returns 200 (CREATE). Second POST `(alpha, M6, 2, 1)` returns **409 `DUPLICATE_ACTIVE`** per D-013. The assertion `expect(update.status(), "second POST (UPDATE) MUST be 200 — NOT 409 — per US2 AS-1").toBe(200)` (line ~141) fails. The subsequent read-side assertions (GET `/api/me/predictions?match_id=M6` returns exactly 1 entry with the active 2-1; GET `/api/me/predictions` returns the M6 entry exactly once with the active 2-1; the superseded id absent from both responses; service-role total=2 + active=1) are unreachable. | T021 (SP supersede branch → second POST returns 200; the existing `/api/me/predictions` GET handler shipped in T015 already filters `superseded_at IS NULL`, so no read-side change required). |

---

## D-013 connection — single root cause across all 5 tests

**Explicit callout**: **every** RED unit in this gate (2 pgTAP + 3 Playwright = 5 tests) fails for the **same root cause**: T013's provisional **WCM06 (`DUPLICATE_ACTIVE`)** branch (per D-013) fires when the SP is invoked for a `(participant, match)` pair that already has an active row. T021's GREEN implementation **replaces** that WCM06 branch with the supersede UPDATE+INSERT pattern (per `contracts/predictions.write.md` § Stored procedure semantics steps 7–9 and § D-013 § How to apply). When T021 lands at on-disk slot **0037**:

- The SP no longer raises `WCM06` — instead it issues `SELECT … FOR UPDATE` on the active row, INSERTs the new row, and UPDATEs the old row's `superseded_at` + `superseded_by`. All 5 tests flip GREEN.
- The slot-0033 audit trigger already emits both `prediction.created` (on the new INSERT, where `NEW.superseded_at IS NULL`) and `prediction.superseded` (on the UPDATE, where `OLD.superseded_at IS NULL → NEW.superseded_at IS NOT NULL`) — **no trigger change is required**.
- The T015 route handler returns the SP's row as-is — **no route-handler change is required**.
- `WCM06` is removed from the SP body entirely; per D-013 "after T021 lands, no caller should ever observe `WCM06`". This gate's tests are therefore the only fixtures that reference the WCM06 → supersede transition, and T021 is the sole GREEN implementer for the entire batch.

The 5-tests-one-fix property is by design: D-013 funnels the provisional pre-supersede behavior through a single SQLSTATE so US2's test surface has exactly one fault to fix. If any of the 5 tests fails for a *different* reason during the runtime RED run (e.g. function-not-found, 404, fixture error, RLS denial), the test is not actually exercising the supersede transition and must be re-investigated before T021 ships.

---

## Implementation note — RED state inferred, not observed (TDD caveat)

In this session (2026-05-20, Auto mode, Docker daemon down), the RED tests T018 + T019 were authored and the matching GREEN-implementation task T021 (`submit_prediction` supersede branch migration at on-disk slot 0037) **may be authored in the same agentic session** without an intervening Docker-based run to *observe* the RED state. The expected failure signatures in the tables above are inferred from straightforward D-013 reasoning (provisional WCM06 → route returns 409 → assertion fails on `.toBe(200)`) — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 003.** The recipe mirrors slices 001 + 002 + slice 003 US1: stash the GREEN implementation file (the migration at slot 0037), run the verification commands below, observe every test fail with the documented 409 / WCM06 / planned-vs-run signature, restore the stash, re-run, observe every test pass. Per-file paths to stash will be enumerated in the slice's `regression-final.md` once T021 lands.

If any test in the inventory comes up GREEN *before* the stash-restore then that test is not actually gating the implementation it claims to gate. Stop and investigate before proceeding.

---

## Verification commands (run once Docker is up)

From the repo root on branch `003-match-predictions`:

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio + Edge Functions).
supabase start

# 2. Reset the database — applies all migrations (slice 001's 0001..0018 +
#    slice 002's 0019..0029 + slice 003's 0030..0037 per D-012 renumber) and
#    loads the three seed fixtures
#    (supabase/seed/slice-001-fixture.sql + slice-002-fixture.sql + slice-003-fixture.sql).
supabase db reset

# 3. Run the slice-003 submit_prediction pgTAP suite. Both US1 + US2 pgTAP
#    files share the submit_prediction_*.sql glob (US1: create_happy,
#    invalid_score, invalid_match, ineligible; US2: update_supersedes,
#    audit_format). The US2-relevant files in scope here are the last two.
Get-ChildItem supabase/tests/pgtap -Filter 'submit_prediction_*.sql' | ForEach-Object { supabase test db $_.FullName }

# 4. Typecheck the web app — catches any contract-shape drift between the
#    locally-declared response types in the specs and the route handlers.
pnpm -F web exec tsc --noEmit

# 5. Run the US2 Playwright suite, scoped to slice 003. The @slice-003 + @us2
#    tags are applied by T019 via test.describe annotations.
pnpm -F web e2e -- --grep '@slice-003 @us2'
```

**Pass criteria for the GREEN run** (post-stash-restore of slot 0037, T021 shipped):

- Both `submit_prediction_update_supersedes.sql` and `submit_prediction_audit_format.sql` pgTAP files report `ok` for every planned assertion (6 + 5 = 11 ok lines).
- All 3 Playwright tests tagged `@slice-003 @us2` report `passed`.
- `pnpm -F web exec tsc --noEmit` is clean.

**Pass criteria for the RED run** (stash slot 0037, BEFORE T021 lands):

- `submit_prediction_update_supersedes.sql` fails because the only SP invocation raises `WCM06` (D-013 provisional branch); A1–A6 are unreachable.
- `submit_prediction_audit_format.sql` fails the second-call assertions (A3–A5) because the second SP invocation raises `WCM06`; A1–A2 may pass if the CREATE branch is healthy.
- All 3 Playwright tests fail on the *second* (supersede) POST's status assertion — `.toBe(200)` blows up with the actual status 409 — for the documented D-013 reason, not for a 404, fixture, RLS, or framework error. The *first* (CREATE) POST in each test succeeds.

If both criteria hold, the Principle IX gate is observationally satisfied and Slice 003 US2 is cleared to merge.

---

## Inherited spec deviations

Slice 003 inherits **D-001 through D-011** from slices 001 + 002 and adds **D-012** + **D-013** of its own. One-liners:

- **D-001** (slice 001, T004) — Auth hook key renamed from spec's `[auth.hook.before_user_signed_in]` to Supabase-CLI-supported `[auth.hook.custom_access_token]`; slice 003 US2's `requireEligible()` re-check on every `/api/predictions` POST inherits the renamed hook path (each concurrent-tab session goes through it).
- **D-002** (slice 001, T019/T022) — `is_approved_domain(p_email text)` accepts a full email and extracts the domain internally; not directly exercised by US2 (no mid-session-deny test in this phase) but inherited via the shared `requireEligible()` helper used by every POST.
- **D-003** (slice 001, T028) — `/api/me` response body locked to `{ participant: {...} }` with `{ error: { code, message } }` envelopes and `Cache-Control: private, max-age=0, must-revalidate`; US2's `POST /api/predictions` and `GET /api/me/predictions` reuse the same error envelope byte-for-byte (the RED-state 409 `{ error: { code: "DUPLICATE_ACTIVE", message } }` envelope is the locked shape, though no US2 test asserts the envelope text directly — they assert the status code).
- **D-004** (slice 001, T034) — `participants_self_or_admin_read` policy embeds the eligibility predicate as a combined OR'd policy; US2's per-row predictions RLS (rows for `(alpha, M6)` and `(alpha, M4)`) depends on the live combined policy through `is_eligible_nortal_participant(...)`.
- **D-005** (slice 001, T038) — `handle_auth_user_signed_in` returns the `custom_access_token` envelope (`{claims}` / `{error}`), not the `{decision}` envelope used by `handle_auth_user_created`; relevant to US2 only insofar as the concurrent-tabs test's two-session sign-in flow traverses this hook twice.
- **D-006** (slice 002, T003–T011 wave-2 schema reconciliation) — `match_status` enum is `scheduled/in_progress/finished/postponed/cancelled` (canonical, fixed inline); `match_results` keeps split columns with locked cross-slice names; `result_status` uses singular `'penalty_shootout'`; M4 (MEX-POL) and M6 (USA-JPN) are both `scheduled` and well outside the lock window for US2's tests.
- **D-007** (slice 002, T020) — `match_results` field-name mapping in the catalog route; not directly exercised by US2 (predictions does not query `match_results`).
- **D-008** (slice 002, T026) — pgTAP cannot observe `pg_notify` channel reception; slice 003's prediction-audit triggers do not emit notifications, so D-008 is informational only.
- **D-009** (slice 002, T026) — `audit_log.action` name mismatch (`'match_result.recorded'` vs `'match_result.updated'`/`'corrected'`); slice 003's parallel `'prediction.created'` / `'prediction.superseded'` vocabulary avoids the same trap — the audit-format pgTAP test (T018, file 2) pins `'prediction.created'` and `'prediction.superseded'` exactly.
- **D-010** (slice 002, T032/T033) — `sync-catalog` coordinator vs Deno tests vs migration 0022 reconciliation gaps; not exercised by US2.
- **D-011** (slice 002, T039) — `audit_log.source` enum value reuse; slice 003 reuses `source='trigger'` for the audit-trigger path (asserted by A1 + A3 in `submit_prediction_audit_format.sql`), already-allowed enum value, so D-011 does not regress here.
- **D-012** (slice 003, surfaced at slice start) — Migration slot renumber: slice 003's migrations shifted +1 (e.g. `submit_prediction_sp` lives at on-disk slot **0034**, the supersede extension at slot **0037**, not the spec's 0033 + 0036). Tests reference function/table names (not slot numbers), so no test-file change is required — but the verification command `supabase db reset` must apply the renumbered set cleanly without filename collisions against slice 002's slot 0029 (`sync_lock_helpers`).
- **D-013** (slice 003, surfaced at T013) — T013 ships the SP with a **provisional `WCM06` (`DUPLICATE_ACTIVE`)** branch on any pre-existing active row for `(participant_id, match_id)`. The branch is the **single root cause** of all 5 US2 RED tests in this gate. T021 removes the branch entirely and replaces it with the supersede UPDATE+INSERT pattern; after T021 lands, no caller should ever observe `WCM06`. See § D-013 connection above for the full one-fix-five-tests rationale.

---

## Sign-off checklist (for the Slice 003 US2 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] RED run completed (per the stash-and-test recipe — paths to be enumerated in the slice's `regression-final.md`); transcript or CI link recorded.
- [ ] GREEN run completed (post-T021); transcript or CI link recorded.
- [ ] PR description references this file by path: `specs/003-match-predictions/red-gate-us2.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.
- [ ] Both pgTAP files report `ok` on the GREEN run (11 total assertions); all 3 Playwright tests report `passed` on the GREEN run.
- [ ] `WCM06` is absent from the post-T021 SP body (the D-013 provisional branch is removed, not merely bypassed).

Until every box above is ticked, Slice 003 US2 does not satisfy Constitution Principle IX and must not merge.
