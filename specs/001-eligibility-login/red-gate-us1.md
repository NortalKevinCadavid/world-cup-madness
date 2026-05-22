# RED Gate — Slice 001 / User Story 1 (US1)

**Slice**: `001-eligibility-login`
**Phase**: 3 (US1 — "Eligible employee signs in")
**Date**: 2026-05-19
**Constitution anchor**: Principle IX (TDD via BDD) — the gate that requires every behaviorally-meaningful test for a slice to be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T021 (the Principle IX gate task itself)

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-3 RED tests authored in T016–T020 are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 001 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description).

---

## Test inventory

The seven RED-state test files authored in Phase 3 (US1) — six SQL pgTAP files and two Playwright specs (T018 produced four pgTAP files; the rest are 1:1 with their tasks).

| # | Test file | Test type | Expected RED failure (PRE-implementation) | GREEN implementer |
|---|-----------|-----------|--------------------------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-001-login-approved.spec.ts` | Playwright (@us1) | Page route `/dashboard` and API route `/api/me` do not yet exist → first navigation assertion fails with a 404 from Next.js. Auth callback at `/auth/callback` either 404s or does not perform the OIDC-stub exchange, so `participants` row is never created and the "first_login_at within 60s" assertion is unreachable. Returning-login scenario fails for the same root cause (no provisioning happened on the first pass). Scenario 3a (`GET /api/me` 200 for alpha) fails because the route does not exist. | T026 (`/auth/callback`), T027 (`/api/me`), plus the dashboard page work in T026's wake. |
| 2 | `apps/web/tests/playwright/slice-001-login-missing-claims.spec.ts` | Playwright (@us1, E-1) | All four expanded edge cases (missing email, missing sub, unverified email, forged signature) require the auth hook to be live and the callback route to translate hook denials into a rendered access-denied surface. With the hook function absent (`handle_auth_user_created` not yet created) and `/auth/callback` not yet implemented, each test fails on the very first navigation or on the absence of the expected `access.denied` audit row. | T024 (auth hook body) and T026 (callback page) jointly satisfy these once shipped. |
| 3 | `supabase/tests/pgtap/is_eligible_active_approved.sql` | pgTAP | `ERROR: function public.is_eligible_nortal_participant(uuid) does not exist` — the eligibility predicate is not created until T023. The `SELECT plan(1)` itself executes, but the `is(...)` assertion blows up at parse-time of the inner call. | T023 (`is_eligible_nortal_participant` body). |
| 4 | `supabase/tests/pgtap/is_eligible_deactivated.sql` | pgTAP | Same as row 3 — `is_eligible_nortal_participant` does not exist. Test cannot reach the "deactivated participant returns false" assertion. | T023. |
| 5 | `supabase/tests/pgtap/is_eligible_unknown_uid.sql` | pgTAP | Same as row 3 — function missing. The "unknown auth_user_id returns false" branch is unreachable. | T023. |
| 6 | `supabase/tests/pgtap/is_eligible_null_uid.sql` | pgTAP | Same as row 3 — function missing. The "NULL input returns false fail-closed" assertion cannot run. | T023. |
| 7 | `supabase/tests/pgtap/is_approved_domain.sql` | pgTAP | `ERROR: function public.is_approved_domain(text) does not exist`. All 9 planned assertions fail at the same point. (NB: this file was patched mid-Phase-3 to match the locked email-input contract — see deviation D-T019/T022 below.) | T022 (`is_approved_domain` body). |
| 8 | `supabase/tests/pgtap/auth_hook_first_login.sql` | pgTAP | `ERROR: function public.handle_auth_user_created(jsonb) does not exist`. None of the ~8 planned scenarios (approved+first-login provisioning, returning-sub idempotency, denied-domain audit, missing-claim audit, config-unavailable fail-closed) can execute. | T024 (auth hook function body). |

**Total inventoried**: 8 RED-state test files (2 Playwright specs + 6 pgTAP scripts) covering FR-001, FR-002, FR-003, FR-006, FR-007, FR-008 and edge cases E-1 and E-5.

---

## Implementation note — RED state inferred, not observed

In this session (2026-05-19, under Auto mode with Docker down), the GREEN-implementation tasks **T022 (`is_approved_domain`), T023 (`is_eligible_nortal_participant`), T024 (`handle_auth_user_created`), T025 (auth hook config wiring), T026 (`/auth/callback` page), and T027 (`/api/me` route)** were authored **after** the RED tests but **without** an intervening Docker-based run to *observe* the RED state. The expected failure signatures in the table above are inferred from straightforward "function does not exist" / "route returns 404" reasoning — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 001.** The recipe:

1. Start Docker Desktop and wait for it to be healthy.
2. From the repo root, stash the GREEN implementation files so the working tree returns to its pre-T022 state:
   ```powershell
   git stash push -m "slice-001 GREEN stash for RED verification" `
     supabase/migrations/0004_is_approved_domain.sql `
     supabase/migrations/0005_is_eligible_nortal_participant.sql `
     supabase/migrations/0009_handle_auth_user_created.sql `
     apps/web/lib/auth/ `
     apps/web/app/auth/callback/page.tsx `
     apps/web/app/dashboard/page.tsx `
     apps/web/app/api/me/route.ts
   ```
   (If any path above does not exist in your working tree, omit it from the `git stash push` invocation — `git stash` will refuse a pathspec that matches nothing.)
3. Run the verification commands in the next section. Every test listed in the inventory MUST fail. Capture the output.
4. Restore the GREEN implementation:
   ```powershell
   git stash pop
   ```
5. Re-run the same verification commands. Every test in the inventory MUST now pass.
6. Append both transcripts (RED + GREEN), or links to CI runs that exhibit them, to the Slice 001 PR description.

If step 3 produces a GREEN result for any test, that test is not actually RED-gated by the implementation it claims to gate — stop and investigate before proceeding.

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

# 4. Run the US1 Playwright suite. The @us1 tag is applied by T016 and T017
#    via test.describe annotations.
pnpm -F web e2e -- --grep @us1
```

**Pass criteria for the GREEN run** (post-`git stash pop`):

- Every pgTAP file reports `ok` for every planned assertion. The two test files that exercise fail-closed paths (`is_eligible_null_uid.sql` and the `config_unavailable` case inside `auth_hook_first_login.sql`) must pass *and* leave no residual state behind (each file is wrapped in `BEGIN; … ROLLBACK;`).
- Every Playwright test tagged `@us1` reports `passed`. No `fixme` is allowed to flip to `failed`; the deactivation-mid-session half of Scenario 3 stays `fixme` (it is owned by T034 in a later slice phase, per the comment header of `slice-001-login-approved.spec.ts`).

**Pass criteria for the RED run** (between `git stash push` and `git stash pop`):

- Every pgTAP file fails for an assertion-or-resolution reason matching the "Expected RED failure" column above — *not* for a syntax error in the test file itself.
- Both Playwright specs fail because the routes / hook they depend on are absent.

If both criteria hold, the Principle IX gate is observationally satisfied and Slice 001 is cleared to merge.

---

## Spec deviations encountered during Phase 3

Cross-reference with the running log in `specs/001-eligibility-login/tasks.md § Implementation deviations`. The entries below are *consolidations* of deviations already raised in-line in the test/implementation files; this document does not introduce any new deviations.

- **D-001 (carry-forward from T004)** — Auth hook key renamed from the spec's `[auth.hook.before_user_signed_in]` to the Supabase-CLI-supported `[auth.hook.custom_access_token]`. Affects T024 (function signature uses the `{user_id, claims, authentication_method}` envelope) and T025 (hook wiring). The PG function name `handle_auth_user_created` is retained for the first-login hook per the contract; the custom-access-token variant `handle_auth_user_signed_in` is owned by T040 in a later phase.
- **D-T019/T022 (email-input contract reconciliation)** — `contracts/eligibility-predicate.sql.md` line 104 locks the helper signature as `is_approved_domain(p_email text)` (accepting a full email, extracting the domain internally via `split_part(lower(p_email),'@',2)`), while the original T019 test draft and T022 implementation sketch had used a bare-domain input. The pgTAP file `is_approved_domain.sql` was patched to the email-input contract before commit; T022's GREEN body must match the same signature. No spec change is required — the contract was already the source of truth.
- **D-T026 / D-T027 (response body-shape choices vs. the locked API contract)** — Phase 3 surfaced two cases where the locked `contracts/api-me.md` body shape forced minor changes to the implementing routes versus the agent-prompt sketches in tasks.md: (a) `/api/me` returns the participant record under a top-level key (not flattened), and (b) the auth-callback redirect carries a denial reason as a query parameter rather than a server-rendered template. Both are choices that align the routes to the locked contract; neither widens the slice's scope. No spec/contract edit was required.

---

## Sign-off checklist (for the Slice 001 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] RED run completed (per the stash-and-test recipe above); transcript or CI link recorded.
- [ ] GREEN run completed; transcript or CI link recorded.
- [ ] PR description references this file by path: `specs/001-eligibility-login/red-gate-us1.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.

Until every box above is ticked, Slice 001 does not satisfy Constitution Principle IX and must not merge.
