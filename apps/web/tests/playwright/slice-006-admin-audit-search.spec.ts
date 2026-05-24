// --------------------------------------------------------------------------
// Slice 006 / T039 — `/admin/audit` paginated search + free-text + filter
// surfaces (the API `GET /api/admin/audit` and the SSR page).
// --------------------------------------------------------------------------
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md § `/admin/audit`
//   - specs/006-admin-overrides/contracts/admin-audit.read.md §
//     `GET /api/admin/audit` — paginated search, default page_size=50, max 200.
//
// Persona: admin1.
// Pre-state: seed three audit rows (action='admin.match_result_corrected',
//            'admin.match_updated', 'admin.award_updated') via service-role
//            so this test is independent of sibling state.
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

const UNIQUE_TOKEN = `t039-audit-search-${Date.now()}`;
const TOKEN_REASON_A = `${UNIQUE_TOKEN}-A: lorem ipsum dolor`;
const TOKEN_REASON_B = `${UNIQUE_TOKEN}-B: consectetur adipiscing`;

async function seedAuditRows(): Promise<string[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .insert([
      {
        actor: ADMIN1_PARTICIPANT_ID,
        action: "admin.match_result_corrected",
        entity_type: "match_result",
        entity_id: "eeee0050-0000-0000-0000-000000000001",
        reason: TOKEN_REASON_A,
        source: "admin_rpc",
        source_citation: "https://internal.example/audit-test-a",
      },
      {
        actor: ADMIN1_PARTICIPANT_ID,
        action: "admin.match_updated",
        entity_type: "match",
        entity_id: "eeee0050-0000-0000-0000-000000000001",
        reason: TOKEN_REASON_B,
        source: "admin_rpc",
        source_citation: "https://internal.example/audit-test-b",
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
  "T039 — /admin/audit search by actor + free-text on reason + API pagination shape @slice-006 @t039",
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
      "admin1 GETs /api/admin/audit?action=admin.match_result_corrected&q=<unique-token>; response status=200; body.audit_log contains the seeded row; body.total >= 1 @slice-006 @t039",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

        // Drive via the API directly first to exercise the shape.
        const url =
          `/api/admin/audit?action=admin.match_result_corrected` +
          `&q=${encodeURIComponent(UNIQUE_TOKEN)}&page=1&page_size=10`;
        const apiResponse = await request.get(url, {
          headers: { accept: "application/json", Cookie: cookieHeader },
        });
        expect(
          apiResponse.status(),
          `GET ${url} MUST return 200 for an admin (admin-audit.read.md § GET /api/admin/audit)`,
        ).toBe(200);

        const body = (await apiResponse.json()) as {
          audit_log: Array<{ action: string; reason: string | null }>;
          page: number;
          page_size: number;
          total: number;
        };
        expect(
          body.page,
          "response body.page MUST equal the requested page (1)",
        ).toBe(1);
        expect(
          body.page_size,
          "response body.page_size MUST equal the requested page_size (10)",
        ).toBe(10);
        expect(
          body.total,
          "response body.total MUST be >= 1 (the seeded admin.match_result_corrected row matches)",
        ).toBeGreaterThanOrEqual(1);
        expect(
          body.audit_log.length,
          "response body.audit_log MUST contain >= 1 row",
        ).toBeGreaterThanOrEqual(1);
        expect(
          body.audit_log.every(
            (r) => r.action === "admin.match_result_corrected",
          ),
          "every returned row's action MUST equal 'admin.match_result_corrected' when the filter is exact",
        ).toBe(true);
        expect(
          body.audit_log.some((r) =>
            (r.reason ?? "").includes(UNIQUE_TOKEN),
          ),
          `at least one returned row's reason MUST include the unique token '${UNIQUE_TOKEN}' (free-text search match)`,
        ).toBe(true);

        // Also exercise the SSR page with the same filter.
        const pageResponse = await page.goto(
          `/admin/audit?action=admin.match_result_corrected&q=${encodeURIComponent(
            UNIQUE_TOKEN,
          )}`,
        );
        expect(
          pageResponse!.status(),
          "/admin/audit MUST return 200 for an admin",
        ).toBe(200);
        await expect(
          page.locator('[data-testid="admin-audit-page"]'),
          '[data-testid="admin-audit-page"] MUST be visible',
        ).toBeVisible();
        await expect(
          page.locator('[data-testid="admin-audit-row"]').first(),
          'at least one [data-testid="admin-audit-row"] MUST be rendered after seeded row appears in filtered results',
        ).toBeVisible();
      },
    );
  },
);
