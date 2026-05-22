// --------------------------------------------------------------------------
// Slice 006 / T039 — `/admin/audit/by-target/[entity_type]/[entity_id]` +
// `GET /api/admin/audit/by-target/[entity_type]/[entity_id]` — full audit
// history for a specific (entity_type, entity_id).
// --------------------------------------------------------------------------
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-audit.read.md §
//     `GET /api/admin/audit/by-target/[entity_type]/[entity_id]`.
//
// Persona: admin1.
// Pre-state: seed two audit rows targeting the same (entity_type='match',
//            entity_id=M1) — one admin.match_updated and one
//            admin.match_result_corrected. Assert both come back in the
//            response.
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

const M1 = "eeee0050-0000-0000-0000-000000000001";

const TOKEN = `t039-by-target-${Date.now()}`;

async function seedAuditRows(): Promise<string[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .insert([
      {
        actor: ADMIN1_PARTICIPANT_ID,
        action: "admin.match_updated",
        entity_type: "match",
        entity_id: M1,
        reason: `${TOKEN}: status flip`,
        source: "admin_rpc",
        source_citation: "https://internal.example/by-target-a",
      },
      {
        actor: ADMIN1_PARTICIPANT_ID,
        action: "admin.match_result_corrected",
        entity_type: "match",
        entity_id: M1,
        reason: `${TOKEN}: score correction`,
        source: "admin_rpc",
        source_citation: "https://internal.example/by-target-b",
      },
    ])
    .select("id");
  if (error) {
    throw new Error(`seedAuditRows: ${error.message}`);
  }
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

async function deleteAuditRows(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const client = getServiceClient();
  const { error } = await client.from("audit_log").delete().in("id", ids);
  if (error) {
    console.error(`deleteAuditRows: ${error.message}`);
  }
}

test.describe(
  "T039 — /api/admin/audit/by-target returns the full history for (match, M1) @slice-006 @t039",
  () => {
    test.setTimeout(60_000);

    let seededIds: string[] = [];

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      seededIds = await seedAuditRows();
    });

    test.afterEach(async () => {
      await deleteAuditRows(seededIds);
      seededIds = [];
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 GETs /api/admin/audit/by-target/match/<M1>; response.target.entity_type='match'; response.audit_log contains BOTH seeded rows (admin.match_updated AND admin.match_result_corrected) @slice-006 @t039",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        const apiResponse = await request.get(
          `/api/admin/audit/by-target/match/${M1}`,
          { headers: { accept: "application/json" } },
        );
        expect(
          apiResponse.status(),
          `GET /api/admin/audit/by-target/match/${M1} MUST return 200 for an admin (admin-audit.read.md)`,
        ).toBe(200);

        const body = (await apiResponse.json()) as {
          target: { entity_type: string; entity_id: string };
          audit_log: Array<{ id: string; action: string; reason: string | null }>;
          current_state: unknown;
        };

        expect(
          body.target.entity_type,
          "response.target.entity_type MUST equal 'match'",
        ).toBe("match");
        expect(
          body.target.entity_id,
          `response.target.entity_id MUST equal '${M1}'`,
        ).toBe(M1);

        const seededRowsInResponse = body.audit_log.filter((r) =>
          seededIds.includes(r.id),
        );
        expect(
          seededRowsInResponse.length,
          `response.audit_log MUST contain BOTH seeded rows (got ${seededRowsInResponse.length} of 2)`,
        ).toBe(2);

        const actionsInResponse = new Set(
          seededRowsInResponse.map((r) => r.action),
        );
        expect(
          actionsInResponse.has("admin.match_updated"),
          "the seeded admin.match_updated row MUST appear in response.audit_log",
        ).toBe(true);
        expect(
          actionsInResponse.has("admin.match_result_corrected"),
          "the seeded admin.match_result_corrected row MUST appear in response.audit_log",
        ).toBe(true);

        // Also navigate the SSR page and assert visibility.
        const pageResponse = await page.goto(
          `/admin/audit/by-target/match/${M1}`,
        );
        expect(
          pageResponse!.status(),
          "/admin/audit/by-target/[entity_type]/[entity_id] MUST return 200 for an admin",
        ).toBe(200);
        await expect(
          page.locator('[data-testid="admin-audit-by-target-page"]'),
          '[data-testid="admin-audit-by-target-page"] MUST be visible',
        ).toBeVisible();
        const rowCount = await page
          .locator('[data-testid="admin-audit-by-target-row"]')
          .count();
        expect(
          rowCount,
          'at least one [data-testid="admin-audit-by-target-row"] MUST be rendered for the seeded target',
        ).toBeGreaterThanOrEqual(2);
      },
    );
  },
);
