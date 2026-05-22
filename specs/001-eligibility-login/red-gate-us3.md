# RED Gate — Slice 001 / User Story 3 (US3)

**Slice**: `001-eligibility-login`
**Phase**: 5 (US3 — "Returning user with changed attributes")
**Date**: 2026-05-19
**Constitution anchor**: Principle IX (TDD via BDD) — the gate that requires every behaviorally-meaningful test for a slice to be observed RED *before* the corresponding GREEN implementation lands.
**Task**: T039 (the Principle IX gate task for US3)

---

## Status: DEFERRED

**This gate was NOT executed.** The Docker daemon required by `supabase start` (and therefore by both the Playwright suite — which boots the local Supabase stack as a fixture — and by `supabase test db` for pgTAP) was **down at the time of execution**. The test inventory below is therefore documentary, not observed.

This document exists so that:

1. The Phase-5 tests authored in T036, T037, and T038 are catalogued exactly once with their expected pre-implementation failure signatures.
2. The user has a deterministic, copy-pasteable verification recipe to run once Docker is back up.
3. Reviewers can see, before merge, that the gate was *acknowledged and deferred* — not skipped silently.

The merge of Slice 001 to `main` is **blocked** until the verification commands at the bottom of this document have been run by the user and their output is appended (or referenced from the PR description). The US1 gate (`red-gate-us1.md`) and the US2 gate (`red-gate-us2.md`) must also be satisfied.

---

## Expected-GREEN-already callout (READ FIRST)

T038 (`auth_hook_fails_closed_on_missing_config.sql`) is the **mixed gate** for this phase. Its three scenarios deliberately exercise BOTH auth-hook functions:

- **Scenario 1** (`handle_auth_user_created` + missing config row) — exercises T024's already-shipped function. The fail-closed branch fires via `is_approved_domain` COALESCEing to `false` against a deleted config row. **Expected GREEN already** — T024 is live in migration `0009_auth_hooks.sql`.
- **Scenario 2** (`handle_auth_user_signed_in` + missing config row) — exercises T040's not-yet-shipped function. The DO-block in the test swallows the `undefined_function` exception so the post-condition assertions still execute against a usable transaction state, but they all fail because no audit row was written and no decision envelope was returned. **Expected RED**, transitions to GREEN when T040 lands.
- **Scenario 3** (`handle_auth_user_created` + empty `[]` approved_domains array) — exercises T024 again. The reject branch fires on `is_approved_domain` returning false against an empty jsonb array. **Expected GREEN already**.

This asymmetry is the substance of **D-005** (see § Cumulative spec deviations below): the two hook functions return different envelope shapes because they bind to different Supabase Auth hook keys, so the test file asserts the appropriate shape per scenario. Reviewers must not interpret S1 + S3 going GREEN under the pre-T040 stash as a failure of Principle IX — those scenarios gate T024, which already shipped under Phase 3.

The four Playwright specs (T036) and the entire `auth_hook_returning_login.sql` file (T037) are uniformly **expected RED** until T040 ships.

---

## Test inventory

The 6 test files authored under T036 (four Playwright specs), T037 (one pgTAP file with `plan(15)`), and T038 (one pgTAP file with `plan(8)`), with their expected pre-implementation failure signatures.

| # | Test file | Test type | Test count / plan | Expected RED failure (PRE-T040) | GREEN implementer |
|---|-----------|-----------|-------------------|----------------------------------|-------------------|
| 1 | `apps/web/tests/playwright/slice-001-returning-login-refresh.spec.ts` | Playwright (@us3) | 1 test | `handle_auth_user_signed_in` does not exist; the `custom_access_token` hook is unwired, so Alpha's existing claims pass through untouched. `display_name` on `participants` stays pinned to the beforeEach value (`'Alpha Tester'`) rather than refreshing to `'Alpha Tester Updated'` → the `expect(row.display_name).toBe(ALPHA.idpDisplayName)` assertion fails. `last_login_at` is also untouched, so `last > first` fails (they're equal-or-close from seed). The `audit_log` query for `participant.updated/trigger` returns zero rows → the `rows.length >= 1` assertion fails. | T040 (`handle_auth_user_signed_in` body + invocation of T013's `participant.updated` trigger via the refresh UPDATE). |
| 2 | `apps/web/tests/playwright/slice-001-email-drift.spec.ts` | Playwright (@us3) | 1 test | Same root cause — `handle_auth_user_signed_in` does not exist. The hook cannot detect the email drift or write the `participant.email_drift` audit row. The stored email assertion happens to pass (no hook = no write = email stays at `alpha@nortal.com`), but the audit-row query (`action='participant.email_drift', source='auth_hook'`) returns zero rows → the `rows.length >= 1` assertion fails. | T040 (drift detection step per R-010 / `contracts/auth-hook.sql.md` § Step 4). |
| 3 | `apps/web/tests/playwright/slice-001-domain-removed-mid-session.spec.ts` | Playwright (@us3, @edge) | 1 test | Inside `withTemporaryConfig('eligibility.approved_domains', [], ...)`, the page-server `getCurrentParticipant` → `requireEligible` call must redirect to `/auth/denied?reason=domain_not_approved`. Today's `/dashboard` server component does not yet call `requireEligible` (T034 wires it), and `requireEligible` does not yet write the `api_guard` audit row. The `waitForURL(.../auth/denied)` either times out or the URL stays on `/dashboard` → the `expect(denied.pathname).toBe(DENIED_PATH)` assertion fails. Even if the redirect happened, the audit-row query for `access.denied/api_guard` would return zero rows. | T034 (predicate wired into `requireEligible`) + T040 (returning-hook denial path emitting the audit row on token refresh). |
| 4 | `apps/web/tests/playwright/slice-001-missing-optional-claim.spec.ts` | Playwright (@us3) | 1 test | `handle_auth_user_signed_in` does not exist; no refresh runs at all. The stored `region` assertion (still `'EE-North'`) happens to pass trivially because nothing writes to it. The "no region-delete audit row" assertion also passes trivially (no rows of any kind are written). Sign-in succeeds because the `before_user_created` hook does NOT fire on a returning login (Alpha already exists in `auth.users`) — so the test may degenerate to a non-meaningful pass. The MEANINGFUL RED signal here is *only observed once T040 ships and could-have-emitted a wrong audit row but didn't*. Treat the pre-T040 pass as a "vacuous pass" rather than a true RED. | T040 (refresh-whitelist step that MUST treat missing claim as "no signal" per Clarifications Q4). |
| 5 | `supabase/tests/pgtap/auth_hook_returning_login.sql` | pgTAP | `plan(15)` — 5 scenarios × multiple assertions (6 + 3 + 2 + 2 + 2 = 15) | `public.handle_auth_user_signed_in(event jsonb)` does NOT exist. Every `SELECT ... handle_auth_user_signed_in(...)` invocation aborts with `undefined_function`. Because the calls are NOT wrapped in a DO-block here (only Scenario 2 of T038 wraps), the failure is the test file aborting at S1.a with `function public.handle_auth_user_signed_in(jsonb) does not exist` → `supabase test db` reports failure for the whole file. | T040 (function body + `custom_access_token` envelope + audit-row writes). |
| 6 | `supabase/tests/pgtap/auth_hook_fails_closed_on_missing_config.sql` | pgTAP | `plan(8)` — 3 scenarios (3 + 4 + 2 = 9 SELECT-asserts but plan(8); see file for the exact accounting) | **Mixed.** Scenario 1 (S1.a, S1.b, S1.c — `handle_auth_user_created` with no config row) is **GREEN already** — T024 is live and emits the `{decision:'reject', message:...}` envelope on missing-config. Scenario 3 (S3.a, S3.b — `handle_auth_user_created` against empty `[]`) is also **GREEN already** for the same reason. Scenario 2 (S2.a, S2.b, S2.c, S2.d — `handle_auth_user_signed_in` with no config row) is **RED**: the DO-block swallows `undefined_function`, so `t_scenario_2_result` stays empty; `S2.a` (error key present) returns NULL → false; `S2.b` (http_code='403') returns NULL ≠ '403'; `S2.c` (last_login_at unchanged) happens to pass trivially because no UPDATE ran; `S2.d` (one access.denied/auth_hook audit row) returns count 0 ≠ 1. So 3 of S2's 4 assertions are observably RED. | Scenario 2 only — T040 (`handle_auth_user_signed_in` body, fail-closed denial branch, audit-row write). Scenarios 1 + 3 require no further work. |

**Total inventoried**: 6 test files (4 Playwright specs + 2 pgTAP scripts).
**Total assertions across pgTAP**: `plan(15) + plan(8) = 23` planned pgTAP assertions.
**Total Playwright test cases**: 4 (one `test(...)` per file).
**Of which expected RED**: 5 (the four Playwright specs + `auth_hook_returning_login.sql`) + 3 assertions inside `auth_hook_fails_closed_on_missing_config.sql` Scenario 2 = ~3 + 15 + 4 = ~22 behaviorally-RED checkpoints.
**Of which expected GREEN-already**: `auth_hook_fails_closed_on_missing_config.sql` Scenarios 1 + 3 = ~5 assertions.
**Coverage**: FR-002 (server-side re-check on every authenticated request), FR-004 (in-place refresh, no duplicate row), FR-006 (audit every decision), FR-008 (fail-closed on missing config), Clarifications 2026-05-15 (Q2 email-drift, Q4 missing optional claim), spec.md US3 Acceptance Scenarios 1–3, Edge case E-3 (long-running session variant).

---

## D-001 / D-005 callout (READ BEFORE INSPECTING T040)

T040's implementation MUST emit the Supabase `custom_access_token` hook envelope, NOT the `{decision, message}` envelope documented in `contracts/auth-hook.sql.md`. This is the substance of D-005 (and a downstream consequence of D-001).

**Why the envelope shapes diverge between the two hook functions:**

- `handle_auth_user_created` binds to the Supabase Auth `before_user_created` hook key. That key respects the contract's documented `{decision, message}` envelope:
  - Accept: `{"decision": "continue"}`
  - Reject: `{"decision": "reject", "message": "<reason>"}`

- `handle_auth_user_signed_in` binds to the Supabase Auth `custom_access_token` hook key (per D-001 — the only Supabase CLI v2.98.2 hook key that fires on every token issuance, which is what FR-002 requires). That key respects a DIFFERENT envelope:
  - Accept: `jsonb_build_object('claims', <claims>)` — the function returns the (possibly mutated) claims object that Supabase Auth then signs into the JWT.
  - Reject: `jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', '<reason>'))` — Supabase Auth surfaces the `error.message` to the client and refuses to issue the token.

Returning `{decision: 'reject', ...}` from `custom_access_token` would be silently ignored — Supabase Auth would issue the token anyway, ADMITTING a reject. This is a security-critical mismatch; the test files must enforce the correct shape.

**Concrete assertions affected:**

- `auth_hook_returning_login.sql` S1.a, S2.a, S3.a assert `result ? 'claims' AND NOT (result ? 'error')` — the success envelope.
- `auth_hook_returning_login.sql` S4.a, S5.a assert `result ? 'error' AND NOT (result ? 'claims') AND result -> 'error' ->> 'http_code' = '403'` — the reject envelope.
- `auth_hook_fails_closed_on_missing_config.sql` S2.a asserts `result ? 'error' IS TRUE`; S2.b asserts `result -> 'error' ->> 'http_code' = '403'` — the reject envelope.
- `auth_hook_fails_closed_on_missing_config.sql` S1.a, S3.a assert `result ->> 'decision' = 'reject'` — the LEGACY envelope, intentional because Scenarios 1 + 3 exercise `handle_auth_user_created` (a `before_user_created` hook).

**Concrete instruction to T040's implementer:**

- Implement `public.handle_auth_user_signed_in(event jsonb) RETURNS jsonb`.
- On accept: `RETURN jsonb_build_object('claims', event -> 'claims');` (or with mutated claims as required by the refresh logic).
- On reject: `RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', '<reason>'));`.
- Do NOT return `{decision: ...}` — the contract markdown's documented envelope is superseded for this function by D-005. The contract file will be reconciled when next opened.

If T040 returns the `{decision: ...}` shape, every Playwright spec in this gate (rows 1–4) will fail because the user is ADMITTED to `/dashboard` on a reject path (Supabase Auth ignored the envelope), and every pgTAP assertion that checks for the `error` key will fail.

---

## Implementation note — RED state inferred, not observed

In this session (2026-05-19, under Auto mode with Docker down), the RED tests for US3 (T036, T037, T038) were authored in the same pass as the documentation of T040's expected behavior. T040 itself has not yet shipped, so the test artifacts CAN'T have been observed RED — but neither can they have been observed GREEN, because the runtime to evaluate them is unavailable. The expected failure signatures in the table above are inferred from straightforward "function does not exist" / "hook is unwired" reasoning — they are not transcripts of an actual test run.

**This means the user MUST manually verify the RED-then-GREEN transition before merging Slice 001.** The recipe (same shape as US1 / US2 gates):

1. Start Docker Desktop and wait for it to be healthy.
2. From the repo root, stash the GREEN implementation files so the working tree returns to its pre-T040 state. Likely candidates (substitute the actual filenames T040 ships):
   ```powershell
   git stash push -m "slice-001 US3 GREEN stash for RED verification" `
     supabase/migrations/0012_handle_auth_user_signed_in.sql
   ```
   (If T040 lands its body INSIDE the existing `0009_auth_hooks.sql` rather than as a new migration, stash that file instead. The exact filename is up to T040's author. If no T040 work has been merged yet, skip the stash and run the verification against the current tree — every test in rows 1–6 except the Scenario 1 + Scenario 3 halves of row 6 MUST fail.)
   Note: row 6 (Scenarios 1 + 3) is **expected GREEN-already** — do NOT expect those assertions to flip RED under this stash. They will be GREEN both pre- and post-stash. That is correct and is the substance of D-005's asymmetry callout.
3. Run the verification commands in the next section. Every test listed in rows 1–5 plus Scenario 2 (S2.a, S2.b, S2.d — S2.c may pass vacuously) of row 6 MUST fail. Scenarios 1 + 3 of row 6 will pass. Capture the output.
4. Restore the GREEN implementation:
   ```powershell
   git stash pop
   ```
5. Re-run the same verification commands. Every test in the inventory MUST now pass.
6. Append both transcripts (RED + GREEN), or links to CI runs that exhibit them, to the Slice 001 PR description.

If step 3 produces a GREEN result for any test in rows 1–5 or for S2.a/S2.b/S2.d in row 6, that test is not actually RED-gated by the implementation it claims to gate — stop and investigate before proceeding.

---

## Verification commands (run once Docker is up)

From the repo root on branch `001-eligibility-login` (PowerShell on Windows):

```powershell
# 1. Boot the local Supabase stack (Postgres + Auth + Storage + Studio).
supabase start

# 2. Reset the database — applies all migrations and reloads seed fixtures
#    (including supabase/seed/slice-001-fixture.sql).
supabase db reset

# 3. Run every pgTAP test file individually.
Get-ChildItem supabase/tests/pgtap -Filter *.sql | ForEach-Object { supabase test db $_.FullName }

# 4. Typecheck the web workspace.
pnpm -F web exec tsc --noEmit

# 5. Run the US3 Playwright suite. The @us3 tag is applied by every spec
#    authored under T036 via test.describe annotations.
pnpm -F web e2e -- --grep '@us3'
```

**Pass criteria for the GREEN run** (post-`git stash pop`):

- Every pgTAP file reports `ok` for every planned assertion. For `auth_hook_fails_closed_on_missing_config.sql` this is true both pre- and post-stash for Scenarios 1 + 3 (see the GREEN-already callout) and only post-stash for Scenario 2.
- Every Playwright test tagged `@us3` reports `passed`. No `fixme` is allowed to flip to `failed`.
- The audit_log rows written by the returning-hook denial paths carry `source='auth_hook'`; the rows written by the in-place refresh trigger carry `source='trigger'`; the rows written by the email-drift detection carry `source='auth_hook'` with `action='participant.email_drift'`.
- `pnpm -F web exec tsc --noEmit` exits 0.

**Pass criteria for the RED run** (between `git stash push` and `git stash pop`, or in the current tree if T040 has not landed):

- `auth_hook_returning_login.sql` fails the file as a whole (the first `SELECT public.handle_auth_user_signed_in(...)` raises `undefined_function`).
- `auth_hook_fails_closed_on_missing_config.sql` Scenario 2 reports `not ok` on S2.a, S2.b, S2.d (S2.c may pass vacuously); Scenarios 1 + 3 PASS.
- The four Playwright @us3 specs all fail for assertion-or-resolution reasons matching the "Expected RED failure" column above — *not* for a syntax error in the test file itself or a Docker-stack startup failure. Note that `slice-001-missing-optional-claim.spec.ts` may degenerate to a vacuous PASS in the RED state (see row 4) — this is acceptable as long as the GREEN run also passes.

If both criteria hold, the Principle IX gate is observationally satisfied for US3 and Slice 001 is cleared to merge from a US3 perspective.

---

## Cumulative spec deviations

Cross-reference with the running log in `specs/001-eligibility-login/tasks.md § Implementation deviations` and with the carry-forward entries in `red-gate-us1.md § Spec deviations encountered during Phase 3` and `red-gate-us2.md § Spec deviations consolidated`. The entries below are *consolidations*; this document does not introduce new deviations.

- **D-001 (carry-forward from T004; tasks.md lines 83–91)** — Auth hook key renamed from the spec's `[auth.hook.before_user_signed_in]` to the Supabase-CLI-supported `[auth.hook.custom_access_token]`. Directly governs T040's binding and is the root cause of D-005's envelope shape change.
- **D-002 (carry-forward from T019/T022; tasks.md lines 77–81)** — `is_approved_domain(p_email text)` accepts a FULL EMAIL, extracts the domain internally. T037 + T038 pass full emails in their `claims.email` payloads accordingly.
- **D-003 (carry-forward from T028; tasks.md lines 69–75)** — `/api/me` response body shape pinned to contract (`{participant: {...}}` on 200; `{error: {code, message}}` on error; `Cache-Control: private, max-age=0, must-revalidate` on every response). Does not directly affect US3 tests but governs the `/dashboard` server component's downstream consumption.
- **D-004 (carry-forward from T034; tasks.md lines 58–67)** — `participants` RLS tightening already shipped by T012 in migration 0007; T034's migration 0011 is a header-only no-op. Relevant to `slice-001-domain-removed-mid-session.spec.ts` (row 3): the RLS-half of the defense-in-depth posture is already live, so the spec's behavior is partially gated by the database; T034 + T040 are still required for the page-server `requireEligible` redirect and the api_guard audit-row write.
- **D-005 (surfaced in T038; tasks.md lines 48–56)** — `handle_auth_user_signed_in` returns the Supabase `custom_access_token` envelope (`{claims: ...}` on accept, `{error: {http_code, message}}` on reject), NOT the spec contract's `{decision, message}` envelope. T037 and T038 Scenario 2 are authored to the `custom_access_token` envelope. `handle_auth_user_created` (T024) retains the `{decision, message}` envelope because `before_user_created` is a distinct hook key with a distinct contract. Cross-referenced in the D-001 / D-005 callout above and in every header of every US3 test file.

---

## Sign-off checklist (for the Slice 001 PR)

- [ ] Docker daemon up and healthy on the verifying machine.
- [ ] RED run completed (per the stash-and-test recipe above); transcript or CI link recorded. Rows 1–5 RED, row 6 mixed per D-005 — both outcomes acceptable.
- [ ] GREEN run completed; transcript or CI link recorded. Rows 1–6 all GREEN.
- [ ] T040 emits the Supabase `custom_access_token` envelope (`{claims}` / `{error}`), confirmed by inspection of the migration shipping the function body.
- [ ] PR description references this file by path: `specs/001-eligibility-login/red-gate-us3.md`.
- [ ] No test in the inventory was edited between the RED and GREEN runs.

Until every box above is ticked, Slice 001 does not satisfy Constitution Principle IX for US3 and must not merge.
