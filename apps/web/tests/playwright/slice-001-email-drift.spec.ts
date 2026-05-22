// --------------------------------------------------------------------------
// Slice 001 / T036 — US3 Acceptance Scenario 2 + Clarifications 2026-05-15 Q2
//   "Email drift between IdP payload and stored participant email."
// --------------------------------------------------------------------------
// RED acceptance test for the email-drift clarification of
// `specs/001-eligibility-login/spec.md`:
//
//   On a returning login, if the IdP returns an `email` that differs from
//   the stored `participants.email` for the same authenticated identity:
//     - Sign-in MUST succeed (eligibility is still evaluated against the
//       stored email, which remains authoritative).
//     - Stored `participants.email` MUST NOT be overwritten.
//     - A `participant.email_drift` audit row MUST be written capturing
//       both the stored and IdP-provided addresses.
//   Rationale: prevents an IdP-side email reassignment from silently
//   inheriting another participant's history (account-takeover guard).
//
// Then-clauses asserted in this file:
//   1. Sign-in succeeds — page lands on `/dashboard`.
//   2. Stored `participants.email` for alpha's auth_user_id is STILL
//      `alpha@nortal.com` (UNCHANGED — audit-only policy).
//   3. An `audit_log` row with `action='participant.email_drift'`,
//      `source='auth_hook'`, `previous_value->>'email'='alpha@nortal.com'`,
//      `new_value->>'email'='alpha-aka@nortal.com'` exists for this sign-in.
//
// --------------------------------------------------------------------------
// Spec deviations
// --------------------------------------------------------------------------
// D-T036-C: The auth hook (`handle_auth_user_signed_in`) is NOT yet
//   implemented (T040 ships it). This test is RED until T040 lands and the
//   email-drift detection step (R-010 / contracts/auth-hook.sql.md § Step 4)
//   is wired in.
//
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import {
  getServiceClient,
  readAuditLog,
} from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  storedEmail: "alpha@nortal.com",
  // IdP-supplied email for THIS sign-in — diverges from the stored value.
  idpEmail: "alpha-aka@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
  region: "EE-North",
} as const;

test.describe("US3 — email drift is audited; stored email unchanged @slice-001 @us3", () => {
  test.beforeAll(async () => {
    await assertOidcStubReachable();
  });

  test.beforeEach(async () => {
    await resetStub();

    // Ensure alpha's stored email is the canonical fixture value before the
    // test runs. The seed already provisions it but a previous test could
    // have left drift; defensively pin it via service-role.
    const client = getServiceClient();
    const { error } = await client
      .from("participants")
      .update({ email: ALPHA.storedEmail })
      .eq("auth_user_id", ALPHA.sub);
    if (error) {
      throw new Error(
        `beforeEach: failed to pin alpha's email — ${error.message}`,
      );
    }
  });

  test.afterEach(async () => {
    await resetStub();

    // Belt-and-braces: in case a (broken) hook implementation HAS mutated
    // the stored email, restore it for the next test.
    const client = getServiceClient();
    await client
      .from("participants")
      .update({ email: ALPHA.storedEmail })
      .eq("auth_user_id", ALPHA.sub);
  });

  test(
    "AS-2 — IdP returns a different email; sign-in succeeds, stored email unchanged, drift audited @slice-001 @us3",
    async ({ page }) => {
      const testStartedAt = new Date(Date.now() - 1_000);

      // Step 1 — sign in with the divergent email but the SAME sub.
      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA.sub,
          email: ALPHA.idpEmail,
          email_verified: ALPHA.email_verified,
          name: ALPHA.name,
          region: ALPHA.region,
        },
      });

      // Then 1 — sign-in succeeded; landed on /dashboard.
      expect(page.url()).toMatch(/\/dashboard(\?|$|#|\/)/);

      // Then 2 — stored email is STILL alpha@nortal.com.
      const client = getServiceClient();
      const { data: row, error: rowErr } = await client
        .from("participants")
        .select("id, email")
        .eq("auth_user_id", ALPHA.sub)
        .single();
      if (rowErr) {
        throw new Error(`participants read failed: ${rowErr.message}`);
      }
      expect(row.id).toBe(ALPHA.participantId);
      expect(
        row.email,
        "Clarifications 2026-05-15 Q2: stored email MUST NOT be overwritten on IdP drift",
      ).toBe(ALPHA.storedEmail);

      // Then 3 — exactly one audit row with the drift shape.
      const rows = await readAuditLog({
        action: "participant.email_drift",
        source: "auth_hook",
        since: testStartedAt,
      });
      expect(
        rows.length,
        "Clarifications 2026-05-15 Q2: an audit_log row MUST be written on email drift",
      ).toBeGreaterThanOrEqual(1);

      const matching = rows.find((r) => {
        const prev = (r.previous_value as { email?: string } | null);
        const next = (r.new_value as { email?: string } | null);
        return (
          prev?.email === ALPHA.storedEmail &&
          next?.email === ALPHA.idpEmail
        );
      });
      expect(
        matching,
        `expected an email_drift audit row with previous.email='${ALPHA.storedEmail}' and new.email='${ALPHA.idpEmail}'`,
      ).toBeDefined();
    },
  );
});
