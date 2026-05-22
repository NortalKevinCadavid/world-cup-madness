// --------------------------------------------------------------------------
// Slice 006 / T011 — non-admin /admin UI access is rejected (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 4 (P1) Acceptance Scenario 1:
//
//   "Given an eligible participant who is NOT an administrator, When they
//   attempt to access any admin UI route, Then access MUST be denied; no
//   admin data MUST be served."
//
//   + Acceptance Scenario 3: "Given any rejection from this slice, When it
//   occurs, Then an audit event MUST be recorded with actor, attempted
//   action, source (UI / API), and reason."
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § Common server-side gate — `AdminLayout` catches AdminAccessDenied
//       and `redirect('/admin/denied')`. § `requireAdmin(client)` writes an
//       `audit_log` row `action='admin.access_denied'`, `reason='not_admin'`
//       (or 'is_admin_rpc_failed'), `source='api_guard'`,
//       `actor = caller's participants.id`.
//   - specs/006-admin-overrides/spec.md § US4 AS1 + AS3.
//   - specs/006-admin-overrides/quickstart.md line 135 — alpha as the
//     canonical non-admin probe.
//   - apps/web/tests/playwright/slice-001-fixture.sql — alpha
//     (auth.users sub 00000000-0000-0000-0000-00000000000a, participants
//     11111111-1111-1111-1111-111111111111).
//
// Persona: alpha (eligible, NOT admin).
//
// Cleanup contract:
//   beforeEach: resetStub + DEFENSIVE check that alpha does NOT have an
//   active admin_roles row (alpha is never bootstrapped as admin, but
//   future test drift could break this — we assert the precondition).
//   afterEach: resetStub. Audit_log rows are append-only.
//
// RED-by-design until:
//   - T015 ships `/admin/layout.tsx` with the `requireAdmin` gate and the
//     `/admin/denied/page.tsx` static page.
//   - T007 ships the real `is_admin(uuid)` body.
//   Until those land, `page.goto('/admin')` 404s and the URL assertion
//   fails before the audit assertion runs.
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
  sub: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

interface AuditLogRow {
  id: string;
  actor: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  reason: string | null;
  source: string;
  occurred_at: string;
}

async function assertAlphaNotAdmin(): Promise<void> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("admin_roles")
    .select("id")
    .eq("participant_id", ALPHA.participantId)
    .is("revoked_at", null);
  if (error) {
    throw new Error(`assertAlphaNotAdmin: ${error.message}`);
  }
  if (data && data.length > 0) {
    throw new Error(
      `Precondition failed: alpha (${ALPHA.participantId}) has an ACTIVE admin_roles row. ` +
        `This test requires alpha to be a non-admin. Revoke or delete the row before running.`,
    );
  }
}

async function readAlphaAccessDeniedRows(since: Date): Promise<AuditLogRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .select("id,actor,action,entity_type,entity_id,reason,source,occurred_at")
    .eq("action", "admin.access_denied")
    .eq("actor", ALPHA.participantId)
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readAlphaAccessDeniedRows: ${error.message}`);
  }
  return (data ?? []) as AuditLogRow[];
}

test.describe(
  "US4 — non-admin /admin UI access redirects to /admin/denied @slice-006 @us1",
  () => {
    test.setTimeout(60_000);

    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await assertAlphaNotAdmin();
      testStartInstant = new Date();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "alpha (non-admin) navigates to /admin; lands on /admin/denied; audit row admin.access_denied written for alpha @slice-006 @us1",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        // Navigate to /admin. The layout's requireAdmin gate MUST throw
        // AdminAccessDeniedError and the catch MUST redirect to /admin/denied.
        await page.goto("/admin");

        // Wait for the redirect to settle on /admin/denied.
        await page.waitForURL(
          (url) => url.pathname.endsWith("/admin/denied"),
          { timeout: 10_000 },
        );

        const finalPath = new URL(page.url()).pathname;
        expect(
          finalPath.endsWith("/admin/denied"),
          `Final URL pathname MUST end with '/admin/denied' for a non-admin (got '${finalPath}'). ` +
            "admin-ui.surface.md § Common server-side gate.",
        ).toBe(true);

        // Service-role verify: audit_log row admin.access_denied for alpha.
        const auditRows = await readAlphaAccessDeniedRows(testStartInstant);
        expect(
          auditRows.length,
          "audit_log MUST contain at least one admin.access_denied row for alpha written after the test started. " +
            "admin-ui.surface.md § requireAdmin(client) writes this row.",
        ).toBeGreaterThanOrEqual(1);

        const row = auditRows[0];
        expect(
          row.action,
          "audit row action MUST be 'admin.access_denied'",
        ).toBe("admin.access_denied");
        expect(
          row.actor,
          `audit row actor MUST equal alpha's participants.id ('${ALPHA.participantId}')`,
        ).toBe(ALPHA.participantId);
      },
    );
  },
);
