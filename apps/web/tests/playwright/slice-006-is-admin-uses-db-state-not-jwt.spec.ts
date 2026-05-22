// --------------------------------------------------------------------------
// Slice 006 / T034 — is_admin reads admin_roles, NOT JWT claims (RED).
// --------------------------------------------------------------------------
// RED acceptance test that nails down the cross-slice contract of
// `public.is_admin(p_user_id uuid)` after T007 replaces the slice 001 stub
// (which always returned `SELECT false`) with a real body that joins
// `admin_roles -> participants` and filters `revoked_at IS NULL`.
//
// Why this test exists
// --------------------
// Before T007, an attacker who controlled their JWT contents (or a buggy
// fixture that synthesized `{"role":"admin"}` directly into claims) could
// not actually escalate — but the *risk shape* was unclear because the body
// returned false unconditionally. After T007, the body explicitly reads
// `admin_roles` via `auth_user_id` mapping. This test pins that contract:
// the ONLY source of truth for "is admin?" is the `admin_roles` table state
// at query time. JWT claims do not, and MUST not, confer admin authority.
//
// Spec source of truth:
//   - specs/006-admin-overrides/spec.md § US4 Acceptance Scenarios:
//       1. "an eligible participant who is NOT an administrator ...
//          access MUST be denied; no admin data MUST be served."
//       2. "the same participant ... API MUST reject the request with the
//          same denial regardless of route."
//   - specs/006-admin-overrides/contracts/is-admin.predicate.sql.md
//       (the locked predicate body — joins admin_roles on
//       p.auth_user_id = p_user_id AND ar.revoked_at IS NULL).
//   - supabase/migrations/0062_is_admin_real_body.sql — T007 implementation.
//   - apps/web/lib/auth/requireAdmin.ts § Step 2 — call site that proves the
//       app trusts is_admin(), not the JWT.
//
// Persona: alpha — slice-001-fixture.sql.
//   alpha (auth.users sub 00000000-0000-0000-0000-00000000000a, participants
//   id 11111111-1111-1111-1111-111111111111). alpha is ELIGIBLE but is NEVER
//   bootstrapped as admin — the slice 006 bootstrap (T009 slot 0074) seeds
//   ONLY admin1's admin_roles row.
//
// Proof approach (service-role direct RPC, then UI fall-through)
// ---------------------------------------------------------------
// Playwright cannot forge a Supabase-signed JWT with an `admin` claim
// without bypassing the entire OIDC + Supabase Auth round-trip — and
// forging such a JWT would prove nothing because the *server* signs the
// access token, not the test. Instead we prove the contract by direct
// observation of the predicate output across a controlled admin_roles
// state change:
//
//   Phase A — Baseline (no admin_roles row for alpha):
//     1. Service-role DELETE any active admin_roles row for alpha
//        (defensive — alpha is not bootstrapped, but a prior test could
//        have inserted one and crashed before cleanup).
//     2. Call `public.is_admin(alpha_auth_user_id)` via service-role RPC.
//     3. Assert returns FALSE.
//     4. Sign alpha in via OIDC stub. Navigate to /admin.
//     5. Assert URL settles on /admin/denied (the `requireAdmin` gate
//        called `is_admin()` which returned false because no admin_roles
//        row exists; alpha's JWT contents are irrelevant).
//
//   Phase B — Synthetic admin grant (admin_roles row INSERTed):
//     6. Service-role INSERT a fresh active admin_roles row for alpha
//        (granted_by=NULL, revoked_at=NULL). This is the ONLY thing that
//        changes between Phase A and Phase B — no JWT change, no sign-out,
//        no session refresh.
//     7. Call `public.is_admin(alpha_auth_user_id)` via service-role RPC.
//     8. Assert returns TRUE.
//
//   Together, the FALSE -> TRUE transition driven SOLELY by an
//   admin_roles INSERT proves the predicate body reads the table, not the
//   JWT.
//
//   Cleanup (afterEach):
//     - DELETE the synthetic admin_roles row for alpha (we own it; it was
//       not bootstrapped). This is a HARD DELETE, not a revoke — the row
//       is purely a test artifact and the next test must see alpha as a
//       fresh non-admin. The slice 006 audit posture trigger emits
//       `admin.role_granted` and `admin.role_revoked` on INSERT/UPDATE,
//       but DELETE bypasses the trigger and leaves no audit_log row.
//       This matches the test's intent — we are not exercising the audit
//       trail here, only the predicate.
//     - resetStub.
//
// Cleanup contract:
//   beforeEach: resetStub + DELETE any pre-existing alpha admin_roles row
//     so Phase A's baseline assertion is deterministic.
//   afterEach: DELETE any alpha admin_roles row we created in Phase B +
//     resetStub.
//
// RED-by-design until:
//   - T007 ships `is_admin(uuid)` real body that consults admin_roles
//     (supabase/migrations/0062_is_admin_real_body.sql).
//   - T015 ships `/admin/layout.tsx` with requireAdmin + redirect.
//   - T002 ships the admin_roles table (so INSERT/DELETE succeed).
//   Until those land:
//     * The service-role admin_roles INSERT/DELETE fails (no table).
//     * `is_admin(alpha)` returns false from the slice 001 stub
//       regardless of admin_roles state (Phase B's TRUE assertion fails).
//     * `page.goto('/admin')` 404s before the URL assertion runs.
//
// Constitution:
//   - Principle II (Security by Design): authorization derives from
//     server-managed state, not client-controllable JWT claims.
//   - Principle IX (Test-First): every Then-clause asserts a specific
//     value (FALSE, TRUE, '/admin/denied'), no boolean-without-value
//     assertions.
//   - Principle XI (Signature lock): is_admin's signature
//     (p_user_id uuid -> boolean) is referenced verbatim.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

// alpha — slice-001-fixture.sql.
const ALPHA = {
  authUserId: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

/**
 * Hard-deletes any admin_roles row for alpha (active or revoked). Used in
 * beforeEach/afterEach to guarantee a deterministic baseline. The row(s)
 * are pure test artifacts — alpha is NEVER bootstrapped as admin in any
 * fixture, so any row we encounter was inserted by a previous test run
 * (possibly crashed before cleanup).
 */
async function purgeAlphaAdminRoles(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("admin_roles")
    .delete()
    .eq("participant_id", ALPHA.participantId);
  if (error) {
    throw new Error(`purgeAlphaAdminRoles: ${error.message}`);
  }
}

/**
 * Inserts a fresh ACTIVE admin_roles row for alpha (granted_by=NULL,
 * revoked_at=NULL). Returns the new row's id so the afterEach can verify
 * cleanup if desired.
 */
async function grantAlphaAdminSynthetic(): Promise<string> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("admin_roles")
    .insert({ participant_id: ALPHA.participantId, granted_by: null })
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`grantAlphaAdminSynthetic insert: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      "grantAlphaAdminSynthetic: INSERT returned no row — admin_roles table may be missing or RLS-blocked for service-role.",
    );
  }
  return data.id as string;
}

/**
 * Calls `public.is_admin(p_user_id)` via service-role RPC and returns the
 * boolean result. Service-role bypasses RLS so we observe the predicate's
 * pure output, not what an `authenticated` caller would see. This is
 * exactly what we want — we are testing the FUNCTION BODY, not RLS.
 */
async function callIsAdmin(pUserId: string): Promise<boolean> {
  const client = getServiceClient();
  const { data, error } = await client.rpc("is_admin", { p_user_id: pUserId });
  if (error) {
    throw new Error(`callIsAdmin(${pUserId}): ${error.message}`);
  }
  if (typeof data !== "boolean") {
    throw new Error(
      `callIsAdmin(${pUserId}): expected boolean, got ${typeof data} (${JSON.stringify(data)})`,
    );
  }
  return data;
}

test.describe(
  "US4 — is_admin() reads admin_roles table state, NOT JWT claims @slice-006 @us4",
  () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      // Deterministic baseline: alpha has NO admin_roles row of any kind.
      await purgeAlphaAdminRoles();
    });

    test.afterEach(async () => {
      // Remove any synthetic row we inserted during the test.
      await purgeAlphaAdminRoles();
      await resetStub();
    });

    test(
      "alpha has no admin_roles row → is_admin(alpha)=FALSE and /admin redirects to /admin/denied; INSERT synthetic admin_roles row → is_admin(alpha)=TRUE; proves predicate reads DB state, not JWT @slice-006 @us4",
      async ({ page }) => {
        // -------------------------------------------------------------
        // Phase A — Baseline: no admin_roles row for alpha.
        // -------------------------------------------------------------

        // A1. Predicate output BEFORE any grant.
        const baselineIsAdmin = await callIsAdmin(ALPHA.authUserId);
        expect(
          baselineIsAdmin,
          `is_admin('${ALPHA.authUserId}') MUST return FALSE when alpha has no active admin_roles row ` +
            "(predicate body: SELECT EXISTS ... admin_roles JOIN participants WHERE auth_user_id = p_user_id AND revoked_at IS NULL). " +
            "If this assertion fails with TRUE, EITHER a prior test leaked an admin_roles row OR the predicate is reading something other than admin_roles.",
        ).toBe(false);

        // A2. UI sanity-check: alpha (signed in, eligible, non-admin) hits
        // /admin and lands on /admin/denied. The JWT alpha receives from
        // the OIDC stub contains NO admin claim (the stub mints standard
        // OIDC claims: sub, email, email_verified, name). If the
        // requireAdmin gate were reading JWT claims instead of calling
        // is_admin(), this test would still pass — so this assertion is
        // a sanity check, not the core proof. The core proof is the
        // FALSE -> TRUE transition in A1 -> B1 below.
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.authUserId,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        await page.goto("/admin");
        await page.waitForURL(
          (url) => url.pathname.endsWith("/admin/denied"),
          { timeout: 10_000 },
        );
        const finalPath = new URL(page.url()).pathname;
        expect(
          finalPath.endsWith("/admin/denied"),
          `alpha (non-admin) navigating to /admin MUST land on /admin/denied (got '${finalPath}'). ` +
            "requireAdmin called is_admin(alpha) which returned false because no admin_roles row exists.",
        ).toBe(true);

        // -------------------------------------------------------------
        // Phase B — Synthetic admin grant via admin_roles INSERT.
        // -------------------------------------------------------------
        // Critical: between Phase A and Phase B, NOTHING about alpha's
        // JWT changes — no sign-out, no token refresh, no claim mutation.
        // The ONLY state change is the admin_roles INSERT below. If the
        // predicate is reading the table, callIsAdmin() must now return
        // TRUE. If it were reading JWT claims, it would still return
        // FALSE (alpha's claims contain no admin marker).
        // -------------------------------------------------------------

        const insertedRowId = await grantAlphaAdminSynthetic();
        expect(
          insertedRowId,
          "grantAlphaAdminSynthetic MUST return a non-empty admin_roles.id (uuid) for the new row",
        ).toMatch(/^[0-9a-fA-F-]{36}$/);

        // B1. Predicate output AFTER the INSERT.
        const grantedIsAdmin = await callIsAdmin(ALPHA.authUserId);
        expect(
          grantedIsAdmin,
          `is_admin('${ALPHA.authUserId}') MUST return TRUE immediately after a service-role INSERT into admin_roles for alpha ` +
            "(no JWT changed; no session refresh occurred). " +
            "FALSE -> TRUE transition driven solely by admin_roles state proves the predicate reads the table, not JWT claims. " +
            "If this assertion fails, the predicate is consulting a non-table source (JWT claim, cached function result, etc.).",
        ).toBe(true);
      },
    );
  },
);
