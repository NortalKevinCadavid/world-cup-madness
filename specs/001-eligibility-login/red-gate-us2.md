# RED Gate — Slice 001 / User Story 2 (US2)

**Slice**: `001-eligibility-login`
**Phase**: 4 (US2 — "Ineligible domain is rejected")
**Date**: 2026-05-19
**Constitution anchor**: Principle IX (TDD via BDD) — the gate that requires every behaviorally-meaningful test for a slice to be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T031 (the Principle IX gate task for US2)

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-4 tests authored in T029 and T030 are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 001 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Expected-GREEN-already callout (READ FIRST)

The two pgTAP files authored in T030 (`slice-001-api-me-rls.sql` and `participants_rls_mid_session_deny.sql`) are **expected to be GREEN out of the gate** rather than RED. This is a deliberate inversion of the standard Principle IX flow and the user must understand it before running the verification recipe:

- The original T030 brief (see `tasks.md` line 1170) assumed that T012's RLS policy (`participants_self_or_admin_read`, migration `0007_participants_rls.sql`) would, at the time T030 ran, only check `auth_user_id = auth.uid()` — with the eligibility predicate to be welded into the `USING` clause later by T034 (a future migration anticipated to be `0011_participants_rls_tighten.sql` or similar).
- In the **current tree**, however, T012 already front-loaded the tightening: migration `0007_participants_rls.sql` was committed with the predicate already embedded in its `USING` clause:
  ```sql
  (auth_user_id = auth.uid()
     AND public.is_eligible_nortal_participant(auth.uid()))
  OR public.is_admin(auth.uid())
  ```
- Because of this, the mid-session-deny behavior the second pgTAP file exercises is **already live in the database today** — there is nothing for T034 to tighten in the RLS-predicate path.

**Consequences for T034**: T034 (`migration 0011`, per the running phase plan) is **likely a no-op** for the RLS-predicate path. If T034 is allowed to ship a redundant `ALTER POLICY` it will be a tautological re-statement of the current `USING` clause; reviewers should consider closing T034 with a "predicate already shipped under T012" note rather than emitting an empty migration. This question is tracked as decision **D-004** (see § Spec deviations consolidated, below) — T034's author may either confirm the no-op and ship a documentation-only stub, or fold the wording change into another tightening (e.g. binding the policy `TO authenticated` more tightly, or adding `is_admin` short-circuits).

**Consequences for this gate**: The pgTAP halves of US2 (rows 9 and 10 in the inventory below) will *not* exhibit an observable RED-to-GREEN transition. Their pre- and post-T034 runs will both be GREEN. The Playwright halves of US2 (rows 1–8) WILL exhibit the expected RED-to-GREEN transition once T032 (`/auth/denied`), T033 (audit-row write in the API guard), and T034 (no-op or otherwise) all land.

---

## Test inventory

The 10 test files authored under T029 (eight Playwright specs) and T030 (two pgTAP files), with their expected pre-implementation failure signatures.

| # | Test file | Test type | Expected RED failure (PRE-implementation) | GREEN implementer |
|---|-----------|-----------|--------------------------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-001-login-denied-domain.spec.ts` | Playwright (@us2) | The denial UI route `/auth/denied` does not exist → `signInWithIdentity()` fails the `expectedPostSignInPath: '/auth/denied'` assertion (browser is somewhere other than `/auth/denied`). Even if it did, the auth hook's denied-domain branch (T024 + T033) does not yet write `audit_log` rows with `source='auth_hook', reason='domain_not_approved'`, so the "exactly one audit row" assertion would fail too. The `countParticipantsByEmail(outsider)` assertion is the only one that should pass pre-implementation (no provisioning has occurred because no hook ran). | T032 (`/auth/denied` page) + T033 (auth-hook audit-row write). |
| 2 | `apps/web/tests/playwright/slice-001-api-me-401.spec.ts` | Playwright (@us2) | Marginal — the 401 body shape was reconciled in Phase 3 to match the contract, so the 401 status + body assertions could already pass once the dev server is reachable. However, the `Cache-Control` header assertion (`private, max-age=0, must-revalidate`) is **not** emitted by the current `/api/me` route on the 401 path; T033 adds the contract-mandated cache header. Until T033, this test is RED on the cache-header assertion. | T033 (`/api/me` 401 cache header). |
| 3 | `apps/web/tests/playwright/slice-001-api-me-403-domain-removed.spec.ts` | Playwright (@us2) | The current `/api/me` route does not perform a per-request eligibility re-check, so after `withTemporaryConfig` sets `approved_domains=[]`, the route still returns 200 with the participant body — the `expect(response.status()).toBe(403)` assertion fails. Even if 403 were returned, the API-guard audit-row write (`source='api_guard'`) is owned by T033 and absent today, so the `readAuditLog` assertion would also fail. | T033 (api-guard re-check + audit-row write); T034 (the predicate call wired into `requireEligible`). |
| 4 | `apps/web/tests/playwright/slice-001-api-me-no-leak.spec.ts` | Playwright (@us2) | Same root cause as row 3 — the 403 path does not exist today, so the response is a 200 with a participant body. The `expect(response.status()).toBe(403)` precondition fails immediately, and the no-leak assertions never execute (they all guard a 403 body that isn't being produced). | T033 + T034. |
| 5 | `apps/web/tests/playwright/slice-001-callback-denied-domain.spec.ts` | Playwright (@us2) | `/auth/denied` page does not exist → either the callback fails to redirect to it (404), or the redirect target 404s on render → `expect(denied.pathname).toBe('/auth/denied')` fails. The "no leftover `sb-*` access-token cookie" assertion is also liable to fail because the current callback may not clear the partial session on hook denial (T024's denial branch handles this; until T033 ships the supporting plumbing it may not be wired). | T032 (`/auth/denied` page); T024/T033 (denial-branch cookie handling). |
| 6 | `apps/web/tests/playwright/slice-001-denied-no-leak.spec.ts` | Playwright (@us2, @edge) | `/auth/denied` page does not exist → `page.goto('/auth/denied?reason=foo-bar-unknown')` returns 404 → `expect(response!.status()).toBe(200)` fails on the first assertion. All five "must not leak" assertions never run. | T032 (`/auth/denied` page with generic-message fallback). |
| 7 | `apps/web/tests/playwright/slice-001-denied-renders-without-session.spec.ts` | Playwright (@us2, @edge) | `/auth/denied` page does not exist → cookieless `page.goto('/auth/denied?reason=domain_not_approved')` returns 404 → `expect(response!.status()).toBe(200)` fails. The "Sign in with a different account" affordance assertion is unreachable. | T032. |
| 8 | `apps/web/tests/playwright/slice-001-callback-no-code.spec.ts` | Playwright (@us2, @edge) | The current `/auth/callback` page (shipped under T026 for the happy path) likely throws or 500s when called with neither `?code=` nor `?error=`; even if it degrades gracefully, the redirect target `/auth/denied?reason=unknown` does not yet exist (T032). The `expect(finalUrl.pathname).toBe('/auth/denied')` assertion fails. | T032 (`/auth/denied`); T033 (`/auth/callback` bare-GET defensive branch). |
| 9 | `supabase/tests/pgtap/slice-001-api-me-rls.sql` | pgTAP (4 asserts) | **Expected GREEN already.** Migrations 0001–0009 are present, including 0005 (`is_eligible_nortal_participant` body) and 0007 (the RLS policy already embedding the predicate). Both personas (alpha, bravo) are eligible in the seed, so the policy's `USING` clause returns true for their own row and false for the sibling row → all four `is(...)` assertions pass against the current tree. The task's RED-state expectation (tasks.md line 1172) is stale because T023's body shipped under T012's bow wave rather than in Phase 4. | (Already GREEN — T033's `/api/me` work makes the route consume this RLS layer, but the RLS layer itself is already correct.) |
| 10 | `supabase/tests/pgtap/participants_rls_mid_session_deny.sql` | pgTAP (3 asserts) | **Expected GREEN already.** Migration 0007 (shipped under T012) ALREADY embeds the eligibility predicate in its `USING` clause. When the test mutates `tournament_config.eligibility.approved_domains` to `[]`, `is_approved_domain(alpha@nortal.com)` returns false, `is_eligible_nortal_participant(alpha)` returns false, the policy `USING` evaluates to false, and alpha's `SELECT count(*) FROM participants` correctly returns 0 — all three `is(...)` assertions pass. The task's RED-state expectation (tasks.md line 1170) anticipated T034 tightening the policy to add the predicate; T012 did this work pre-emptively. **T034's `migration 0011` is therefore a no-op for the predicate path.** | (Already GREEN — see D-004 below for T034's disposition.) |

**Total inventoried**: 10 test files (8 Playwright specs + 2 pgTAP scripts).
**Of which expected RED**: 8 (the Playwright specs).
**Of which expected GREEN-already**: 2 (the pgTAP files — see callout above).
**Coverage**: FR-001 (eligibility-restricted access), FR-002 (server-side re-check on every request), FR-006 (audit on denial), spec.md US2 Acceptance Scenarios 1–3, Clarifications 2026-05-15 (mid-session deny), Edge cases E-3, E-4, E-7.

---

## Implementation note — RED state inferred, not observed

In this session (2026-05-19, under Auto mode with Docker down), the GREEN-implementation tasks for US2 — **T032 (`/auth/denied` page), T033 (audit-row writes + cache headers + `/api/me` re-check), and T034 (`migration 0011`, likely a no-op per the callout above)** — were authored **after** the RED tests but **without** an intervening Docker-based run to *observe* the RED state. The expected failure signatures in the table above are inferred from straightforward "route does not exist" / "route returns 200 instead of 403" / "audit row never written" reasoning — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 001.** The recipe:

1. Start Docker Desktop and wait for it to be healthy.
2. From the repo root, stash the GREEN implementation files so the working tree returns to its pre-T032 state:
   ```powershell
   git stash push -m "slice-001 US2 GREEN stash for RED verification" `
     apps/web/app/auth/denied/page.tsx `
     supabase/migrations/0010_audit_log_api_guard.sql `
     supabase/migrations/0011_participants_rls_tighten.sql `
     apps/web/app/api/me/route.ts `
     apps/web/lib/auth/require-eligible.ts
   ```
   (If any path above does not exist in your working tree, omit it from the `git stash push` invocation — `git stash` will refuse a pathspec that matches nothing. The exact migration filenames for T033/T034 may differ; substitute the actual filenames produced by those tasks.)
   Note: row 9 and row 10 of the inventory are **expected GREEN-already** — do NOT expect them to flip RED under this stash. They will be GREEN both pre- and post-stash. That is correct and is the substance of D-004.
3. Run the verification commands in the next section. Every test listed in rows 1–8 MUST fail. Tests in rows 9–10 will pass. Capture the output.
4. Restore the GREEN implementation:
   ```powershell
   git stash pop
   ```
5. Re-run the same verification commands. Every test in the inventory MUST now pass.
6. Append both transcripts (RED + GREEN), or links to CI runs that exhibit them, to the Slice 001 PR description.

If step 3 produces a GREEN result for any test in rows 1–8, that test is not actually RED-gated by the implementation it claims to gate — stop and investigate before proceeding.

---

## Verification commands (run once Docker is up)

From the repo root on branch `001-eligibility-login`:

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio).
supabase start

# 2. Reset the database — applies all migrations and reloads seed fixtures
#    (including supabase/seed/slice-001-fixture.sql).
supabase db reset

# 3. Run every pgTAP test file individually.
#    PowerShell (Windows):
Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object { supabase test db $_.FullName }

#    cmd.exe equivalent:
#    for /R supabase\tests\pgtap %f in (*.sql) do supabase test db %f

#    POSIX (bash/zsh) equivalent:
#    for f in supabase/tests/pgtap/*.sql; do supabase test db "$f"; done

# 4. Run the US2 Playwright suite. The @us2 tag is applied by every spec
#    authored under T029 via test.describe annotations.
pnpm -F web e2e -- --grep '@us2'
```

**Pass criteria for the GREEN run** (post-`git stash pop`):

- Every pgTAP file reports `ok` for every planned assertion. For the two US2 pgTAP files this is true both pre- and post-stash (see the GREEN-already callout).
- Every Playwright test tagged `@us2` reports `passed`. No `fixme` is allowed to flip to `failed`.
- The audit_log rows written by the 403 path carry `source='api_guard'` (T033); the audit_log rows written by the UI denial carry `source='auth_hook'` (T024 was extended in Phase 4 to emit these on the denied-domain branch).
- The `Cache-Control` header on `/api/me` 401 and 403 responses is exactly `private, max-age=0, must-revalidate`.

**Pass criteria for the RED run** (between `git stash push` and `git stash pop`):

- Every Playwright spec in rows 1–8 fails for an assertion-or-resolution reason matching the "Expected RED failure" column above — *not* for a syntax error in the test file itself or a Docker-stack startup failure.
- The two pgTAP files in rows 9–10 PASS (they are expected GREEN-already; their pass is part of the substance of D-004).

If both criteria hold, the Principle IX gate is observationally satisfied for US2 and Slice 001 is cleared to merge from a US2 perspective. (The US1 gate, documented in `red-gate-us1.md`, must also be satisfied.)

---

## Spec deviations consolidated

Cross-reference with the running log in `specs/001-eligibility-login/tasks.md § Implementation deviations` and with the carry-forward entries in `red-gate-us1.md § Spec deviations encountered during Phase 3`. The entries below are *consolidations*; this document does not introduce new deviations except for D-004.

- **D-001 (carry-forward from T004)** — Auth hook key renamed from the spec's `[auth.hook.before_user_signed_in]` to the Supabase-CLI-supported `[auth.hook.custom_access_token]`. Continues to apply through Phase 4; T024's denial branch is the hook function exercised by `slice-001-login-denied-domain.spec.ts` and `slice-001-callback-denied-domain.spec.ts`.
- **D-002 (carry-forward — D-T019/T022 from US1 gate)** — The `is_approved_domain(p_email text)` email-input signature locked in `contracts/eligibility-predicate.sql.md` line 104 continues to be the canonical signature used by both `is_eligible_nortal_participant` (called from the RLS policy under test in `slice-001-api-me-rls.sql` and `participants_rls_mid_session_deny.sql`) and by the API-guard re-check (T034). No further change.
- **D-003 (carry-forward — D-T026/T027 from US1 gate)** — `/api/me` response body shapes and `/auth/callback` denial-redirect parameterisation continue to align to the locked contracts. The 401 body `{ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }` and the 403 body `{ error: { code: 'DOMAIN_NOT_APPROVED', message: 'This application is restricted to approved Nortal corporate identities.' } }` are pinned by both the contract and the Phase-4 specs.
- **D-004 (NEW — RLS-predicate front-loading under T012)** — Migration `0007_participants_rls.sql` (shipped under T012 in Phase 2) **already embeds** the eligibility predicate in the `participants_self_or_admin_read` policy's `USING` clause:
  ```sql
  (auth_user_id = auth.uid()
     AND public.is_eligible_nortal_participant(auth.uid()))
  OR public.is_admin(auth.uid())
  ```
  This is an inherited artifact of the same bow wave that produced D-001 — Phase 2 tightened a policy whose tightening the phase plan had reserved for Phase 4 (T034). Direct consequence: the mid-session-deny behavior tested by `participants_rls_mid_session_deny.sql` is live in the database today rather than ship-deferred to T034; the RLS half of the defense-in-depth posture (Constitution Principle II layer 4) is already in place.

  **Open question** (which T034 must resolve, even if its resolution is "no migration shipped"):
  1. Should T034 emit a no-op tautological `ALTER POLICY` migration to satisfy the phase plan's filename slot (`migration 0011`), even though the predicate is already in place? OR
  2. Should T034 be closed with a "predicate already shipped under T012" note and the `migration 0011` slot retired? OR
  3. Should T034's brief be repurposed to a *different* tightening that genuinely belongs in this slice (e.g. binding `is_admin` short-circuits, hardening `tournament_config` write privileges, or wiring the predicate call into the API-guard `requireEligible` helper if it has not already been done by T033)?

  The author of T034 will need to pick a path; this document does not prejudge the answer. What this document DOES record is that the test artifacts in rows 9 and 10 of the inventory above will not exhibit a RED-to-GREEN transition because the GREEN state is the current state. Reviewers must not interpret this as a failure of Principle IX — it is a side-effect of D-001's bow wave landing in Phase 2 work that Phase 4 expected to do.

---

## Sign-off checklist (for the Slice 001 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] RED run completed (per the stash-and-test recipe above); transcript or CI link recorded. Rows 1–8 RED, rows 9–10 GREEN — both outcomes acceptable per D-004.
- [ ] GREEN run completed; transcript or CI link recorded. Rows 1–10 all GREEN.
- [ ] T034's disposition decided per D-004 (no-op migration, retirement, or repurpose).
- [ ] PR description references this file by path: `specs/001-eligibility-login/red-gate-us2.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.

Until every box above is ticked, Slice 001 does not satisfy Constitution Principle IX for US2 and must not merge.
