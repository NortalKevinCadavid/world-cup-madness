// --------------------------------------------------------------------------
// Slice 001 / T029 — US2 Acceptance Scenario 1 (UI denial path).
// --------------------------------------------------------------------------
// RED acceptance suite for the "ineligible domain rejected at the UI"
// scenario in `specs/001-eligibility-login/spec.md` § User Story 2 AS-1.
//
// Then-clauses (mapped to the spec text):
//   1. Redirect to `/auth/denied?reason=domain_not_approved`
//      (contracts/auth-callback.page.md § Behavior `/auth/denied`).
//   2. Denial message rendered exactly per the contract's `domain_not_approved`
//      row.
//   3. NO new `participants` row is created for the attempted identity
//      (FR-002: no provisioning on ineligible sign-in).
//   4. Exactly one `audit_log` row exists with
//      `action='access.denied', reason='domain_not_approved',
//      source='auth_hook'` (FR-006).
//
// This file MUST be RED until:
//   - `/auth/denied` page ships (T032)
//   - The auth hook's denial path writes the audit row (T024)
//   - The auth hook rejects ineligible domains with reason='domain_not_approved'
//     (T024 + auth-hook.sql.md § Decision matrix)
//
// Do NOT relax the no-info-leak assertion. Do NOT delete the audit-row
// assertion when it fails — fix the hook, not the test.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import {
  countParticipantsByEmail,
  readAuditLog,
} from "./helpers/service-role";

const DENIED_PATH = "/auth/denied";

// outsider fixture row — auth.users 00000000-0000-0000-0000-00000000000e
// (see supabase/seed/slice-001-fixture.sql). Email domain is example.com —
// NOT on the approved list — and no participants row exists.
const OUTSIDER = {
  sub: "00000000-0000-0000-0000-00000000000e",
  email: "outsider@example.com",
  email_verified: true,
  name: "Outsider",
} as const;

test.describe("US2 — ineligible domain denied at UI @slice-001 @us2", () => {
  test.beforeAll(async () => {
    await assertOidcStubReachable();
  });

  test.beforeEach(async () => {
    // Reset BEFORE each test so a leaked token-callback from a prior test
    // (or prior file in parallel mode) cannot poison this test's stub
    // payload. The afterEach also resets so we leave the stub clean for
    // the next file.
    await resetStub();
  });

  test.afterEach(async () => {
    await resetStub();
  });

  test(
    "AS-1 — outsider@example.com sign-in is denied, no participant row created, audit row written @slice-001 @us2",
    async ({ page }) => {
      // Capture the wall-clock floor so the audit-row query can scope
      // its results to rows written during this test (filters out any
      // historical rows produced by earlier tests in the same run).
      const testStartedAt = new Date(Date.now() - 1_000); // -1s slack

      const finalUrl = await signInWithIdentity(page, {
        claims: {
          sub: OUTSIDER.sub,
          email: OUTSIDER.email,
          email_verified: OUTSIDER.email_verified,
          name: OUTSIDER.name,
        },
        expectedPostSignInPath: DENIED_PATH,
      });

      // Then 1 — landed on /auth/denied with the contract-mandated reason.
      const denied = new URL(finalUrl);
      expect(denied.pathname).toBe(DENIED_PATH);
      expect(denied.searchParams.get("reason")).toBe("domain_not_approved");

      // Then 2 — denial message rendered per the contract's matrix row.
      // Contract: "This application is restricted to approved Nortal
      // corporate identities. Contact the tournament administrator if you
      // believe this is a mistake." We assert on a stable substring rather
      // than the full string so a future copy edit doesn't break the test
      // — but the assertion still requires the contract's core wording.
      await expect(
        page.getByText(/restricted to approved Nortal corporate identities/i),
      ).toBeVisible();

      // Then 3 — NO participants row for outsider@example.com. The
      // service-role helper bypasses RLS so we can authoritatively assert
      // the absence (the seed deliberately leaves the row out).
      const provisionedCount = await countParticipantsByEmail(OUTSIDER.email);
      expect(
        provisionedCount,
        "FR-002: no participants row may be created for an ineligible sign-in",
      ).toBe(0);

      // Then 4 — exactly one audit_log row with the contract's denial shape.
      const rows = await readAuditLog({
        action: "access.denied",
        reason: "domain_not_approved",
        source: "auth_hook",
        since: testStartedAt,
      });
      expect(
        rows.length,
        "FR-006: an audit_log row MUST be written by the auth hook on UI denial",
      ).toBe(1);

      // No information-leak in the audit row's public-readable fields.
      // (Slice 007 will harden this further; for now we just check that
      // the row has the denial shape.)
      const auditRow = rows[0]!;
      expect(auditRow.source).toBe("auth_hook");
      expect(auditRow.reason).toBe("domain_not_approved");
    },
  );
});
