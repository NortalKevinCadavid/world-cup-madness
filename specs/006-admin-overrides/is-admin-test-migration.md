# Cross-slice `is_admin` test migration audit

**Slice**: 006-admin-overrides
**Task**: T002
**Date**: 2026-05-21
**Constitution anchor**: Principle XI (NON-NEGOTIABLE regression preservation across cross-slice contract changes)
**Status**: AUDIT COMPLETE (survey only; edits owned by T008)

---

## Executive summary

This audit catalogues every Slice 001–005 test whose pass/fail behavior depends on the semantic of `public.is_admin(uuid)`. Slice 006's T007 will `CREATE OR REPLACE` the function body to read `public.admin_roles` instead of (today's) constant `false`. T008 is the cross-slice edit task; this document is its work order.

### Key finding — premise correction

The T002 task prompt (lines 76, 88 of `tasks.md`) describes the Slice 001 stub as returning `auth.jwt() ->> 'role' = 'admin'`. **The on-disk migration `supabase/migrations/0006_is_admin_stub.sql` actually returns `SELECT false;`** — the JWT-claim variant is described only in the slice 006 contract document as a hypothetical, not in the current source tree. Consequently **no existing test "synthesises admin via JWT claim"** — that pattern simply does not appear in the codebase. Grep for `"role":"admin"` across `supabase/tests/pgtap/` and `apps/web/tests/playwright/` returns zero matches (only `"role":"authenticated"` is set in JWT-claim test fixtures).

The actual cross-slice migration surface is narrower than the prompt anticipates: tests that **sign in as `admin1@nortal.com` via the OIDC stub and exercise the production `is_admin(auth.uid())` path** (i.e., NOT the X-Internal-Auth bypass path).

### Bootstrap admin coverage (T009)

Slice 006's T009 bootstrap migration (`0061_admin_bootstrap.sql`) defaults `tournament_config.admin.bootstrap_participant_email` to `"admin1@nortal.com"` and conditionally INSERTs an `admin_roles` row for the matching participant. The Slice 005 fixture (`supabase/seed/slice-005-fixture.sql` lines 245-258) already seeds the participants row `id=77777777-7777-7777-7777-777777777777, email='admin1@nortal.com', status='active'`. Therefore, **after T007 + T009 ship together, admin1's `admin_roles` row will exist with no additional test-file edits**. Every Type 1 test below uses admin1 → all are auto-covered by T009.

This means **T008 is effectively a no-op for the current test inventory** — its only deliverable is verification that the existing tests turn GREEN after T007/T009 land. If T008 still wants belt-and-suspenders inline INSERTs (defensive vs. fixture drift), the per-test guidance in § 5 below is exhaustive.

---

## 1. Survey methodology

- `Grep` over `supabase/tests/pgtap/**/*.sql`, `apps/web/tests/playwright/**/*.{ts,spec.ts}`, `supabase/functions/**/tests/**/*.ts` for:
  - `is_admin`
  - `role.*admin` (case-insensitive)
  - `admin1@nortal`
  - `jwt.*admin`
  - `ADMIN1` (Playwright identity constant)
- Per-match classification:
  - **Type 1** — uses admin context and expects admin-allowed behavior (NEEDS migration after T007).
  - **Type 2** — asserts non-admin denial path (no change needed; deny still holds).
  - **Type 3** — explicitly tests the `is_admin` stub itself (replaced by T033's pgTAP suite).
  - **Comment-only** — file mentions `is_admin` in comments/docstrings but exercises no admin-dependent assertion.

---

## 2. Inventory table

### pgTAP tests (`supabase/tests/pgtap/`)

| Test file | Type | Current setup | Required `admin_roles` INSERT | T008 owner |
|---|---|---|---|---|
| `slice-001-api-me-rls.sql` | Type 2 + comment-only | Alpha/bravo JWTs only (`role=authenticated`); never sets up admin. RLS policy `participants_self_or_admin_read` has `OR public.is_admin(auth.uid())` branch but test deliberately exercises self-only branch (comments line 21-22 acknowledge admin branch is inert under stub). | NONE — adding admin1 admin_roles would activate the OR branch and break "exactly 1 row" assertions. **Do not edit**. | n/a |
| `participants_rls_mid_session_deny.sql` | Type 2 + comment-only | Alpha JWT only; mid-session deny test. Comment line 28 references the policy's `OR is_admin(...)` clause; test exercises the self branch. | NONE. | n/a |
| `slice-002-catalog-rls.sql` | Type 2 + comment-only | Alpha + outsider JWTs only. Comments lines 18, 36, 40, 104 acknowledge `is_admin` stub returns false; test asserts non-admin alpha sees 0 rows from admin-only tables. Adding admin1 admin_roles row would invalidate Scenario 2 ("0 rows"). | NONE — deny path remains correct after T007. **Do not edit**. | n/a |
| `record_match_result_admin_correction_requires_admin.sql` | Type 2 | Calls SP with `p_approved_by='11111111-...-1' (alpha)`; expects SP to RAISE because alpha is non-admin. After T007: alpha still has no admin_roles row → still non-admin → SP still raises. | NONE — assertion still holds. | n/a |
| `record_match_result_admin_correction_requires_approver.sql` | Type 2 | Calls SP with `p_approved_by=NULL`; expects RAISE on the approver-required guard (NULL check fires before `is_admin`). | NONE. | n/a |
| `submit_prediction_admin_override.sql` | Type 2 (SP enum-path test) | Calls `submit_prediction(..., 'admin_override')` directly as superuser. The SP does NOT call `is_admin` (per T013 body it only validates the source enum value and inserts; admin authority is enforced by the Slice 006 wrapper RPC, not this SP). | NONE — SP body never touches `is_admin`. | n/a |
| `submit_final_prediction_admin_override.sql` | Type 2 (SP enum-path test) | Same pattern as above for finals SP. | NONE. | n/a |
| `peer_pick_rls_lock_boundary.sql` | Type 2 | Uses alpha JWT only; tests view's lock predicate. Contract documents no admin bypass on `peer_pick_v`. | NONE. | n/a |
| (other ~60 pgTAP files) | comment-only / no admin reference | grep returned zero admin-context setup | NONE | n/a |

**pgTAP total**: 75 files scanned; 0 require migration.

### Playwright tests (`apps/web/tests/playwright/`)

| Test file | Type | Current setup | Required `admin_roles` INSERT | T008 owner |
|---|---|---|---|---|
| `slice-005-match-scoring.spec.ts` (7 tests: AS1–AS7) | **Type 1** | Each test calls `signInWithIdentity(page, { claims: { sub: ADMIN1.sub='00...0d3', email: 'admin1@nortal.com', ...} })`, then POSTs to `/functions/v1/score-trigger` forwarding the session cookie. The Edge Function `score-trigger` calls `service.rpc('is_admin', { p_uid: user.id })` (see `supabase/functions/score-trigger/index.ts` line 185). Comments lines 59-69 explicitly note: "Slice 005 fixture seeds admin1 in `participants` but the `admin_roles` table is owned by Slice 006 ... When T015 [now T003+T007+T009] ships, the admin_roles fixture row will be added alongside it and these tests will turn GREEN without modification." | **Covered by T009 bootstrap** (admin1@nortal.com is the default `admin.bootstrap_participant_email`). If T008 wants inline defense: ensure the slice-005 fixture or a Playwright `beforeAll` runs `INSERT INTO public.admin_roles (participant_id) VALUES ('77777777-7777-7777-7777-777777777777') ON CONFLICT (participant_id) WHERE revoked_at IS NULL DO NOTHING;` once per worker. | **T008** (verify only) |
| `slice-005-peer-pick-visibility.spec.ts` — Test 5 only ("Direct REST with admin JWT pre-lock") | **Type 1** but **assertion is "admin sees 0 rows"** | Signs in as ADMIN1, calls `/rest/v1/peer_pick_v?match_id=eq.<M_TEST>` with admin1's JWT. Comments lines 56-74, 126-135 lock in the strict reading: contract documents NO admin bypass on `peer_pick_v`. Assertion: `parsed?.length === 0`. After T007+T009: admin1 becomes a true admin, BUT `peer_pick_v` RLS still gates only on eligibility + lock predicates (no `is_admin` carve-out per contract). Assertion remains correct. | NONE — assertion is the no-bypass case; result unchanged post-T007. | **T008** (verify only; no edit) |
| `slice-005-peer-pick-visibility.spec.ts` — Tests 1-4, 6-10 | Type 2 / N/A | Sign in as alpha/bravo (regular participants). | NONE. | n/a |
| `slice-005-final-scoring.spec.ts` | N/A (X-Internal-Auth bypass) | Uses `X-Internal-Auth: <SCORE_TRIGGER_INTERNAL_AUTH_SECRET>` header per D-025 option B; DOES NOT sign in via OIDC stub. The bypass skips the `is_admin` check entirely (see `score-trigger/index.ts` lines 38-45). | NONE. | n/a |
| `slice-005-leaderboard.spec.ts` | N/A (X-Internal-Auth bypass for score-trigger; alpha sign-in for UI assertions) | Score-trigger POSTs use `X-Internal-Auth` header; OIDC sign-in is as `ALPHA_IDENTITY` (regular participant) for UI-side leaderboard reads. | NONE. | n/a |
| `slice-005-breakdown.spec.ts` | N/A (same as leaderboard) | Same pattern — `X-Internal-Auth` for trigger; alpha/bravo sign-in for breakdown UI. | NONE. | n/a |
| `slice-005-breakdown.perf.spec.ts` | N/A | Same. | NONE. | n/a |
| `slice-002-empty-payload-served-last-known.spec.ts`, `slice-002-conflict-quarantined.spec.ts`, `slice-002-late-fixture-appears.spec.ts`, `slice-002-outage-alert-dedup.spec.ts` | N/A (X-Internal-Auth bypass) | All four `sync-catalog` Playwright tests use `X-Internal-Auth: <SYNC_INTERNAL_AUTH_SECRET>` header. No admin JWT path. | NONE. | n/a |
| `slice-002-catalog-no-leak.spec.ts` | Type 2 + comment-only | Greps response body for forbidden tokens including the literal string `"is_admin"`. Sign-in is as alpha; no admin auth path exercised. | NONE. | n/a |
| `slice-001-*`, `slice-003-*`, `slice-004-*` Playwright specs | comment-only / no admin reference | None reference admin1 or `is_admin` in setup. | NONE. | n/a |

**Playwright total**: 92 files scanned; **8 tests** in 1 file (slice-005-match-scoring) require admin authority at runtime; **1 additional test** in slice-005-peer-pick-visibility uses admin1 but asserts the deny case. All 9 admin-touching tests use admin1 and are covered by the T009 bootstrap seed.

### Deno (Edge Function) tests (`supabase/functions/*/tests/`)

| Test file | Type | Current setup | Required `admin_roles` INSERT | T008 owner |
|---|---|---|---|---|
| `supabase/functions/sync-catalog/tests/non_admin_returns_403.test.ts` | **Type 2** | Mints a one-shot eligible-domain user via service-role admin API, signs in to get an anon-scope JWT, POSTs to `/functions/v1/sync-catalog` WITHOUT `X-Internal-Auth`. Expects 403. Comments lines 11-19 reference the slice 001 stub. After T007: the freshly minted user has no `admin_roles` row → still non-admin → still 403. | NONE — deny path unchanged. | n/a |
| `supabase/functions/score-trigger/tests/non_admin_returns_403.test.ts` | **Type 2** | Same pattern, score-trigger surface. After T007: still 403. | NONE. | n/a |
| `supabase/functions/sync-catalog/tests/internal_auth_path.test.ts` | N/A (X-Internal-Auth bypass) | Tests bypass header acceptance. | NONE. | n/a |
| (other ~22 Deno test files) | N/A | None set admin context. | NONE. | n/a |

**Deno total**: 24 files scanned; 0 require migration. (Note: the 2 `non_admin_returns_403` tests do INTERACT with `is_admin` semantics but assert the deny outcome that the new body also produces.)

---

## 3. Summary counts

| Category | Count |
|---|---|
| Total test files scanned | **191** (75 pgTAP + 92 Playwright + 24 Deno) |
| Files containing any `is_admin` / admin-context reference | 11 |
| **Type 1** (uses admin authority, will need admin_roles for assertion to pass) | **8 tests in 1 file** (slice-005-match-scoring.spec.ts AS1–AS7) |
| **Type 2** (asserts non-admin denial; no migration needed) | 9 (2 pgTAP record_match_result_admin_correction*, 2 pgTAP submit_*_admin_override, 4 Playwright peer-pick tests using alpha + 1 admin-but-asserts-deny, 2 Deno non_admin_returns_403, 3 pgTAP RLS-deny tests) |
| **Type 3** (explicitly tests the stub itself) | **0** — the Slice 001 stub returns `SELECT false;` and has no dedicated pgTAP file. T033 of this slice will author the new `is_admin_*.sql` test suite from scratch (per contract § Test surface). No pre-existing stub tests need removal. |
| Comment-only references (no admin assertion) | ~60 |
| **Files actually requiring T008 source edits** | **0** (all Type 1 tests are auto-covered by T009 bootstrap of admin1's admin_roles row) |

---

## 4. Bootstrap admin coverage analysis

| Question | Answer |
|---|---|
| Does the slice-005 fixture seed `participants.email='admin1@nortal.com'`? | **Yes** — `supabase/seed/slice-005-fixture.sql` lines 248-258 seed `(id='77777777-7777-7777-7777-777777777777', auth_user_id='00...0d3', email='admin1@nortal.com', status='active')`. |
| Does T009 bootstrap target this participant? | **Yes** — T009's default `tournament_config.admin.bootstrap_participant_email='admin1@nortal.com'`; the conditional INSERT matches on email. |
| After T007 + T009 land, will the 8 Type 1 tests GREEN automatically? | **Yes**, provided the slice-005 fixture is loaded BEFORE T009 migration runs (so the participants row exists for T009's conditional INSERT to see). Standard local-dev order: `supabase db reset` reapplies migrations after seeds; T009 INSERT will run AFTER the seed in the dev workflow. **For CI**: confirm migration order — if T009 runs before fixtures load, the bootstrap INSERT no-ops and the Type 1 tests fail. **Action for T008 / T009**: T009's header comment already notes the order constraint; T008's verify step MUST re-run the slice-005-match-scoring suite after `supabase db reset` to confirm GREEN. |
| Are there any synthetic / non-admin1 admin identities? | **No** — every admin-touching test uses admin1 (sub `00...0d3`, participant_id `77777777-7777-7777-7777-777777777777`). No second admin persona exists in any fixture. |

---

## 5. T008 work order (per-file, line-level guidance)

### A. Tests requiring source edits

**None.** All Type 1 tests are covered by T009's bootstrap seed.

### B. Tests requiring T008 verification (post-T007/T009 re-run)

T008's `What to do` step 3 says "Verify: re-run the affected tests; assert they still GREEN with the new is_admin body." That step IS the deliverable for these files — re-run, capture green, document in the regression checkpoint.

1. `apps/web/tests/playwright/slice-005-match-scoring.spec.ts` — run all 7 AS tests. Expected: GREEN (currently RED-by-design because slice 001 stub returns false → 403). The transition from 403 to 200 IS the proof that T007 + T009 wired up correctly.
2. `apps/web/tests/playwright/slice-005-peer-pick-visibility.spec.ts` Test 5 — re-run. Expected: still GREEN (0 rows; admin gets no bypass on this view).
3. `supabase/functions/score-trigger/tests/non_admin_returns_403.test.ts` — re-run. Expected: still GREEN (newly minted user has no admin_roles row → 403).
4. `supabase/functions/sync-catalog/tests/non_admin_returns_403.test.ts` — re-run. Expected: still GREEN.

### C. Optional defensive belt-and-suspenders edits (if T008 chooses)

If T008 opts to make the `admin_roles` seed visible at the test file level (rather than relying on T009's fixture-coupled bootstrap), a Playwright `beforeAll` block in `slice-005-match-scoring.spec.ts` could call the service-role client to ensure the row exists. **Recommended pattern**:

```typescript
// At the top of slice-005-match-scoring.spec.ts test.describe block:
test.beforeAll(async () => {
  await assertOidcStubReachable();
  // Belt-and-suspenders: ensure admin1 has an active admin_roles row
  // regardless of T009 bootstrap ordering. ON CONFLICT no-ops if T009 already
  // seeded the row.
  const client = getServiceClient();
  const { error } = await client.from("admin_roles").upsert(
    { participant_id: "77777777-7777-7777-7777-777777777777" },
    { onConflict: "participant_id" },
  );
  if (error && !error.message.includes("duplicate")) {
    throw new Error(`admin1 admin_roles seed: ${error.message}`);
  }
});
```

Note: this requires the `admin_roles_active_uk` partial unique index to be the conflict target; using `participant_id` only works because the upsert is on participants with no existing revoked rows. If revoked rows exist for admin1 (they shouldn't in test fixtures), prefer a raw INSERT … WHERE NOT EXISTS pattern via `client.rpc('execute_sql', ...)` or simply an `INSERT ... ON CONFLICT DO NOTHING` via a thin RPC.

**For pgTAP**: no edits are needed (no Type 1 pgTAP test exists). If T033's new `is_admin_*.sql` suite is authored before T007 ships, those new pgTAP files will manage their own setup per `contracts/is-admin.predicate.sql.md` § Test surface.

---

## 6. Cross-slice contract impact note

The Slice 006 contract document (`contracts/is-admin.predicate.sql.md` § Difference from Slice 001 stub) describes the Slice 001 stub body as `SELECT COALESCE(auth.jwt() ->> 'role' = 'admin', false)`. **This does not match the on-disk Slice 001 migration**, which is `SELECT false;`. The contract description is internally consistent (the hypothetical JWT-claim variant would have been the alternative if Slice 001 had chosen that posture), but it is not the source of truth. The actual cross-slice impact is smaller than the contract narrative implies:

- No test in the repo ever sets `"role":"admin"` in a JWT claim.
- No test currently relies on the stub returning true; the stub returns false universally.
- The migration surface is purely: tests that go through the production `is_admin` path AND sign in as admin1.

**Recommendation for slice 006 documentation**: amend the contract's "Difference from Slice 001 stub" table to read:

| Aspect | Slice 001 stub (actual) | This slice (real) |
|---|---|---|
| Body | `SELECT false;` (no admin path active) | EXISTS query against `admin_roles` |

This correction is OUT OF SCOPE for T002 (audit only) but should be filed against the contract author. Logged here for traceability under Principle XI.

---

## 7. Definition of done (T002)

- [x] Survey covers all `supabase/tests/pgtap/`, `apps/web/tests/playwright/`, and `supabase/functions/*/tests/` directories.
- [x] Every test that references `is_admin` or admin authority is classified (Type 1 / 2 / 3 / comment-only).
- [x] Per-test migration plan documented (or NONE justified).
- [x] T008 work order enumerated with file-level guidance.
- [x] T009 bootstrap coverage analyzed (admin1 → auto-covered).
- [x] Anomaly between contract description and on-disk Slice 001 stub body flagged.

**Total bytes of test code requiring source edit under T008: 0.**
**T008 reduces to verification + (optional) defensive `beforeAll` insertions.**
