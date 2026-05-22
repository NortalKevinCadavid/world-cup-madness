// --------------------------------------------------------------------------
// Slice 006 / T011 — admin role revoked mid-session (RED).
// --------------------------------------------------------------------------
// RED acceptance test for the spec's Edge Case:
//
//   "An administrator account is deactivated mid-override-edit → the
//   active session MUST lose authorization immediately on next request;
//   pending edits MUST be discarded; the deactivation MUST be audited."
//
// And FR-009: "An administrator who has been deactivated MUST lose
// access immediately on next request."
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § `/admin/denied` — "Admins whose `admin_roles` row was revoked
//       mid-session (next request lands here)."
//   - specs/006-admin-overrides/data-model.md § audit posture —
//       "AFTER INSERT OR UPDATE trigger on `admin_roles` emits audit_log
//       rows: ... UPDATE setting `revoked_at` → `admin.role_revoked`."
//   - specs/006-admin-overrides/spec.md § Edge Cases + FR-009.
//   - apps/web/tests/playwright/helpers/admin-roles.ts — defensive
//     `ensureAdminRole(participantId)` upsert used in the afterEach to
//     restore admin1 (task body explicitly notes "the defensive helper
//     handles this").
//
// Persona: admin1.
//
// Revoke-mid-session approach:
//   1. Sign in as admin1 via OIDC stub. Navigate to /admin (auth OK).
//   2. Capture `testStartInstant` AFTER the first /admin load so the
//      audit-row `since` filter excludes any pre-test rows.
//   3. Use service-role to UPDATE admin_roles SET revoked_at=now(),
//      revoked_by=admin1's id, revoke_reason='test' WHERE
//      participant_id=admin1 AND revoked_at IS NULL.
//   4. `page.reload()` — the layout's `requireAdmin` gate sees the row
//      is now revoked (is_admin returns false) and redirects to /admin/denied.
//   5. Service-role verify: audit_log has both admin.role_revoked
//      (emitted by the AFTER UPDATE trigger) AND admin.access_denied
//      (emitted by requireAdmin on the reload).
//
// Cleanup (afterEach):
//   - ensureAdminRole(admin1) restores admin1's active row. The helper
//     is idempotent: it SELECTs first; if an active row exists, no-op;
//     if not, it INSERTs a fresh `granted_by=NULL` row. The previously-
//     revoked row is left in place as immutable history (Principle V).
//   - resetStub.
//
// RED-by-design until:
//   - T002/T003 ship `admin_roles` table + audit trigger emitting
//     admin.role_revoked on UPDATE.
//   - T015 ships `/admin/layout.tsx` with requireAdmin + redirect.
//   - T007 ships real `is_admin(uuid)` body that consults admin_roles.
//   Until those land:
//     * `page.goto('/admin')` 404s before the revoke even happens.
//     * The service-role UPDATE fails (no admin_roles table).
//     * No admin.role_revoked / admin.access_denied audit rows exist.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { ensureAdminRole } from "./helpers/admin-roles";
import { getServiceClient } from "./helpers/service-role";

const ADMIN1 = {
  sub: "00000000-0000-0000-0000-0000000000d3",
  email: "admin1@nortal.com",
  email_verified: true,
  name: "Admin One",
} as const;

const ADMIN1_PARTICIPANT_ID = "77777777-7777-7777-7777-777777777777";

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

/**
 * Revokes admin1's currently-active admin_roles row via service-role.
 * Returns the id of the now-revoked row (for trace / debug). Fails loudly
 * if no active row is found — that would mean ensureAdminRole did not run.
 */
async function revokeAdmin1ActiveRow(): Promise<string> {
  const client = getServiceClient();
  const { data: active, error: selErr } = await client
    .from("admin_roles")
    .select("id")
    .eq("participant_id", ADMIN1_PARTICIPANT_ID)
    .is("revoked_at", null)
    .maybeSingle();
  if (selErr) {
    throw new Error(`revokeAdmin1ActiveRow select: ${selErr.message}`);
  }
  if (!active) {
    throw new Error(
      `revokeAdmin1ActiveRow: no active admin_roles row found for admin1 (${ADMIN1_PARTICIPANT_ID}). ` +
        "ensureAdminRole MUST have run in beforeEach.",
    );
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await client
    .from("admin_roles")
    .update({
      revoked_at: nowIso,
      revoked_by: ADMIN1_PARTICIPANT_ID,
      revoke_reason: "test",
    })
    .eq("id", active.id);
  if (updErr) {
    throw new Error(`revokeAdmin1ActiveRow update: ${updErr.message}`);
  }
  return active.id;
}

async function readAdmin1AuditRows(
  action: string,
  since: Date,
): Promise<AuditLogRow[]> {
  const client = getServiceClient();
  let q = client
    .from("audit_log")
    .select(
      "id,actor,action,entity_type,entity_id,reason,source,occurred_at",
    )
    .eq("action", action)
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });

  // admin.role_revoked uses `entity_id = admin_roles.id` (per data-model.md)
  // — we widen the filter to admin1 via either actor OR entity_id-not-null
  // and let the test caller narrow with subsequent assertions.
  // admin.access_denied has `actor = admin1's participants.id`.
  if (action === "admin.access_denied") {
    q = q.eq("actor", ADMIN1_PARTICIPANT_ID);
  }
  const { data, error } = await q;
  if (error) {
    throw new Error(`readAdmin1AuditRows(${action}): ${error.message}`);
  }
  return (data ?? []) as AuditLogRow[];
}

test.describe(
  "US4 — admin role revoked mid-session: next request hits /admin/denied @slice-006 @us1",
  () => {
    test.setTimeout(60_000);

    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      // Guarantee admin1 has an active admin_roles row entering the test.
      // ensureAdminRole is idempotent: if T009's bootstrap row is still
      // active, this is a no-op; if a prior test revoked it, this inserts a
      // fresh active row (leaving the old revoked row as history).
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      testStartInstant = new Date();
    });

    test.afterEach(async () => {
      // Restore admin1 for the next test. The previously-revoked row stays
      // in admin_roles as immutable history (Principle V).
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      await resetStub();
    });

    test(
      "admin1 visits /admin (auth OK); service-role revokes admin_roles row; reload → /admin/denied; both audit rows present @slice-006 @us1",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        // 1) /admin loads OK (auth still active).
        const firstResponse = await page.goto("/admin");
        expect(
          firstResponse,
          "page.goto('/admin') MUST return a Response object",
        ).not.toBeNull();
        expect(
          firstResponse!.status(),
          "/admin MUST return 200 while admin1's admin_roles row is still active",
        ).toBe(200);

        // 2) Service-role revokes admin1's active admin_roles row mid-session.
        await revokeAdmin1ActiveRow();

        // 3) Reload — requireAdmin now sees is_admin=false → redirect to /admin/denied.
        await page.reload();
        await page.waitForURL(
          (url) => url.pathname.endsWith("/admin/denied"),
          { timeout: 10_000 },
        );

        const finalPath = new URL(page.url()).pathname;
        expect(
          finalPath.endsWith("/admin/denied"),
          `After reload post-revoke, URL MUST end with '/admin/denied' (got '${finalPath}'). ` +
            "admin-ui.surface.md § `/admin/denied` — 'Admins whose admin_roles row was revoked mid-session (next request lands here).'",
        ).toBe(true);

        // 4a) Verify audit row admin.role_revoked written by the AFTER UPDATE
        // trigger on admin_roles (data-model.md § audit posture).
        const revokedRows = await readAdmin1AuditRows(
          "admin.role_revoked",
          testStartInstant,
        );
        expect(
          revokedRows.length,
          "audit_log MUST contain at least one admin.role_revoked row written after the test started " +
            "(data-model.md § audit posture — AFTER UPDATE trigger emits admin.role_revoked).",
        ).toBeGreaterThanOrEqual(1);

        // 4b) Verify audit row admin.access_denied written by requireAdmin on
        // the reload (admin-ui.surface.md § requireAdmin(client)).
        const deniedRows = await readAdmin1AuditRows(
          "admin.access_denied",
          testStartInstant,
        );
        expect(
          deniedRows.length,
          "audit_log MUST contain at least one admin.access_denied row for admin1 " +
            "written by requireAdmin on the post-revoke reload.",
        ).toBeGreaterThanOrEqual(1);
        expect(
          deniedRows[0].actor,
          `audit row actor MUST equal admin1's participants.id ('${ADMIN1_PARTICIPANT_ID}')`,
        ).toBe(ADMIN1_PARTICIPANT_ID);
      },
    );
  },
);
