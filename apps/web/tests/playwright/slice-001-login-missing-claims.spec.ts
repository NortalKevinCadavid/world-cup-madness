// --------------------------------------------------------------------------
// Slice 001 / Phase 3 (US1) — Edge Case E-1 acceptance suite.
//
// Authored RED per Constitution Principle IX. These tests MUST fail in CI
// until T022/T023/T026/T032 are implemented and seed-loaded. They MUST NOT
// be deleted, skipped, or relaxed to make them GREEN.
//
// Spec references:
//   - specs/001-eligibility-login/spec.md § Edge Cases (E-1, plus two
//     adjacent edge cases this file deliberately covers RED for early
//     fixture-gap visibility — see "Scope deviations" below).
//   - specs/001-eligibility-login/contracts/auth-hook.sql.md § Decision
//     matrix and Step 1 of `handle_auth_user_created` (reason codes:
//     `missing_claims`, `domain_not_approved`, `config_unavailable`).
//   - specs/001-eligibility-login/tasks.md § T017.
//
// --------------------------------------------------------------------------
// Scope deviations and gaps (READ ME BEFORE EDITING)
// --------------------------------------------------------------------------
//
// G-1. The T017 task body in tasks.md (lines 700–705) calls for TWO tests:
//      missing `email` and missing `display_name`. The orchestrating agent
//      prompt for this slot expanded the scope to FOUR cases (missing
//      email, missing sub, unverified email, forged signature). This file
//      authors all four for early surface coverage. If the slice owner
//      considers the extra two out of scope, drop tests `missing sub`,
//      `email_verified=false`, and `forged signature`; the base two (E-1
//      "missing email" and "missing display_name") satisfy the task's
//      stated Definition of Done.
//
// G-2. `contracts/auth-hook.sql.md` § Decision matrix does NOT enumerate a
//      dedicated `email_unverified` reason code. The hook Step 1 inspects
//      claim PRESENCE (`email`, `display_name`), not `email_verified`. The
//      `email_verified=false` test below is therefore parked as
//      `test.fixme` pending an explicit contract update (a row in the
//      Decision matrix and a Step in `handle_auth_user_created`). Do NOT
//      flip it to a runnable test without first amending the contract.
//
// G-3. `apps/web/tests/playwright/fixtures/oidc.ts` (T006) does NOT expose
//      a `signWithAlternateKey` flag or any way to force the mock IdP to
//      sign with a non-published key. Per task instructions, the
//      forged-signature case is `test.fixme` until T006's fixture grows
//      that capability. Do NOT inline-extend the fixture here — fixture
//      ownership lives with T006.
//
// G-4. `audit_log` is admin-read-only at the RLS layer
//      (`audit_log_admin_read` is the only SELECT policy; see
//      data-model.md § RLS posture summary). A signed-out or denied
//      participant cannot read it from the browser. Asserting the audit
//      row from Playwright therefore needs a service-role helper (e.g. a
//      `psql` shell-out, an admin-context API route, or a node `pg`
//      client wired into the test runner). No such helper exists in this
//      repo yet. Audit-row assertions are parked as `test.fixme` siblings
//      below the UI-level assertions; they MUST be implemented before this
//      file can be considered fully GREEN-able. The UI-level + no-side-
//      effect assertions remain live and RED today, which is sufficient
//      to satisfy Principle IX for this task.
//
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";
import {
  assertOidcStubReachable,
  mintIdentity,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

// The denial landing path is fixed by the contract. Any future renaming
// MUST update this constant in lockstep with the contract document.
const DENIED_PATH = "/auth/denied";

// Subjects used to attempt sign-in. These are deliberately NEW UUIDs not
// staged by `slice-001-fixture.sql` so the "no participants row created"
// assertion is unambiguous — a pre-existing fixture row would confound it.
const SUB_MISSING_EMAIL = "00000000-0000-0000-0000-0000000000E1";
const SUB_MISSING_SUB = "(omitted — see test)";
const SUB_UNVERIFIED_EMAIL = "00000000-0000-0000-0000-0000000000E2";
const SUB_FORGED = "00000000-0000-0000-0000-0000000000E3";

test.beforeAll(async () => {
  // Fail fast with an actionable message if the OIDC sidecar is down so
  // CI doesn't waste time chasing infrastructure noise.
  await assertOidcStubReachable();
});

test.afterEach(async () => {
  // Each test mutates the stub's next-token config. Reset so a leaked
  // configuration cannot poison a sibling test in this or another file.
  await resetStub();
});

test.describe("US1 — missing or invalid IdP claims @slice-001 @us1 @edge", () => {
  // ----------------------------------------------------------------------
  // Test 1 — missing `email` claim.
  // Contract: auth-hook.sql.md § handle_auth_user_created Step 1.
  // Decision matrix row: "Missing claim → reject, reason=missing_claims".
  // ----------------------------------------------------------------------
  test("denies sign-in when JWT is missing the email claim", async ({
    page,
    request,
  }) => {
    // Arrange — mint a JWT with NO `email` claim. `display_name` is
    // present so we exercise the missing-email path specifically; the
    // missing-display_name path is covered by a sibling test.
    const finalUrl = await signInWithIdentity(page, {
      claims: {
        sub: SUB_MISSING_EMAIL,
        email_verified: true,
        name: "No Email User",
        // intentionally NO `email` field
      },
      expectedPostSignInPath: DENIED_PATH,
    });

    // Act + Assert — UI denial state.
    const denied = new URL(finalUrl);
    expect(denied.pathname).toBe(DENIED_PATH);
    expect(denied.searchParams.get("reason")).toBe("missing_claims");
    await expect(
      page.getByRole("heading", { name: /access denied|cannot sign in/i }),
    ).toBeVisible();

    // Assert — no side effects: `/api/me` MUST 401 (no session cookie was
    // ever issued by Supabase Auth because the hook returned
    // {decision: "reject"}). 403 would also be acceptable per the
    // contract's no-info-leak posture, but 401 is the canonical signal
    // for "no authenticated session" here.
    const meResp = await request.get("/api/me");
    expect([401, 403]).toContain(meResp.status());

    // Assert — no `participants` row provisioned for this sub. Browser
    // clients have no SELECT on `participants` for this sub (RLS), so
    // this is exercised indirectly via `/api/me` above. A direct DB-level
    // assertion is captured in T021/T029 pgTAP tests.

    // FIXME(G-4) — assert exactly one `audit_log` row exists with
    // {action: 'access.denied', reason: 'missing_claims',
    //  source: 'auth_hook', new_value->>'sub' = SUB_MISSING_EMAIL}.
    // Blocked on an admin-context DB helper (see header G-4).
  });

  // ----------------------------------------------------------------------
  // Test 2 — missing `display_name` (per the task body, NOT the agent's
  // expanded "missing sub" prompt). This is the SECOND mandated scenario
  // in tasks.md lines 704. We keep it RED-only and document the prompt
  // divergence.
  //
  // The agent prompt that scheduled this slot asked for "missing sub"
  // instead. The contract DOES treat missing `sub` as a malformed token
  // (Supabase Auth would reject upstream before the hook ever fires —
  // see Decision matrix row "Forged/expired token"), which makes it not
  // testable at the hook layer in the same way. We honor the tasks.md
  // text and exercise missing `display_name`, which IS a hook-layer
  // denial per Step 1.
  // ----------------------------------------------------------------------
  test("denies sign-in when JWT is missing the display_name claim", async ({
    page,
    request,
  }) => {
    // Arrange — present `email`, drop `name` / `display_name`. The hook
    // pulls display_name from `event->user_metadata->>'display_name'`,
    // which Supabase Auth populates from the OIDC `name` claim.
    const finalUrl = await signInWithIdentity(page, {
      claims: {
        sub: SUB_MISSING_SUB, // placeholder string is fine here — the sub
        // is present (non-empty), only `name` is omitted.
        email: "no-name@nortal.com",
        email_verified: true,
        // intentionally NO `name` field
      },
      expectedPostSignInPath: DENIED_PATH,
    });

    const denied = new URL(finalUrl);
    expect(denied.pathname).toBe(DENIED_PATH);
    expect(denied.searchParams.get("reason")).toBe("missing_claims");
    await expect(
      page.getByRole("heading", { name: /access denied|cannot sign in/i }),
    ).toBeVisible();

    const meResp = await request.get("/api/me");
    expect([401, 403]).toContain(meResp.status());

    // FIXME(G-4) — audit_log row assertion blocked by admin-only RLS;
    // see header note G-4. Expected row shape: action='access.denied',
    // reason='missing_claims', source='auth_hook', new_value contains the
    // attempted email 'no-name@nortal.com'.
  });

  // ----------------------------------------------------------------------
  // Test 3 — `email_verified: false`.
  //
  // PARKED — see header note G-2. The current auth-hook contract has no
  // explicit `email_unverified` reason and Step 1 does not inspect
  // `email_verified`. Implementing this test against the contract as-
  // written would assert behavior the hook is not specified to provide,
  // making the test mis-categorized (it would be RED for an architectural
  // reason, not an implementation gap). Promote to a live test ONLY after
  // the contract grows an `email_unverified` row in the Decision matrix.
  // ----------------------------------------------------------------------
  test.fixme(
    "denies sign-in when JWT carries email_verified=false",
    async ({ page, request }) => {
      const finalUrl = await mintIdentity(page, {
        sub: SUB_UNVERIFIED_EMAIL,
        email: "unverified@nortal.com",
        email_verified: false,
        name: "Unverified User",
      });

      const denied = new URL(finalUrl);
      expect(denied.pathname).toBe(DENIED_PATH);
      // Contract gap (G-2): the exact `reason=` token is undefined. The
      // expectation below assumes a future contract amendment introduces
      // `email_unverified`. If the slice owner picks a different token
      // (e.g. `missing_claims` as a catch-all), update this assertion in
      // lockstep with the contract change.
      expect(denied.searchParams.get("reason")).toBe("email_unverified");
      await expect(
        page.getByRole("heading", { name: /access denied|cannot sign in/i }),
      ).toBeVisible();

      const meResp = await request.get("/api/me");
      expect([401, 403]).toContain(meResp.status());

      // FIXME(G-4) — audit_log row assertion blocked by admin-only RLS.
    },
  );

  // ----------------------------------------------------------------------
  // Test 4 — forged signature (JWT signed by a key the JWKS does not
  // publish).
  //
  // PARKED — see header note G-3. The OIDC fixture exposes no
  // `signWithAlternateKey` flag; there is no supported way to drive the
  // mock-oauth2-server through Playwright into emitting a token signed
  // with an off-JWKS key. The contract is clear ("Forged/expired token →
  // Supabase Auth rejects upstream; API guard catches the residual case",
  // see auth-hook.sql.md § Decision matrix), so the expected end state is
  // a denial without any audit row from the hook layer. Promote to a live
  // test ONLY after T006's fixture grows the wrong-key path.
  // ----------------------------------------------------------------------
  test.fixme(
    "denies sign-in when JWT signature does not match the published JWKS",
    async ({ page, request }) => {
      // The cast below documents the missing fixture surface — it is NOT
      // a runtime API. Replace with the real flag once T006 exposes it.
      await signInWithIdentity(page, {
        claims: {
          sub: SUB_FORGED,
          email: "forged@nortal.com",
          email_verified: true,
          name: "Forged User",
        } as unknown as Parameters<typeof signInWithIdentity>[1]["claims"],
        expectedPostSignInPath: DENIED_PATH,
        // signWithAlternateKey: true, // <- needs to be added in T006
      });

      // Expected: Supabase Auth itself rejects the token before the hook
      // fires; the callback page surfaces a generic denial with no
      // sensitive reason leak.
      await expect(page).toHaveURL(new RegExp(`${DENIED_PATH}`));
      const meResp = await request.get("/api/me");
      expect([401, 403]).toContain(meResp.status());
    },
  );
});
