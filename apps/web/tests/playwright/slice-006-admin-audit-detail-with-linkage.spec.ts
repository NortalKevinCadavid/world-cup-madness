// --------------------------------------------------------------------------
// Slice 006 / T039 — `/admin/audit/[id]` + `GET /api/admin/audit/[id]` —
// single audit row with derived linkage (e.g. `triggered_recalc_run_id` for
// admin.recalc_triggered rows).
// --------------------------------------------------------------------------
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-audit.read.md §
//     `GET /api/admin/audit/[id]` — linkage block.
//
// Persona: admin1.
// Pre-state: seed an `admin.recalc_triggered` audit row and a paired
//            `score_calculation_runs` row pointing back via
//            `triggering_audit_log_id`. The shapes mirror what
//            admin_trigger_recalc (slot 0070) writes.
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

interface SeedResult {
  auditId: string;
  runId: string;
  affectedRecordCount: number;
}

async function seedAuditAndRun(): Promise<SeedResult> {
  const client = getServiceClient();
  const affectedRecordCount = 42;

  const auditRes = await client
    .from("audit_log")
    .insert({
      actor: ADMIN1_PARTICIPANT_ID,
      action: "admin.recalc_triggered",
      entity_type: "score_calculation_run",
      reason: "T039 audit detail linkage test seed",
      source: "admin_rpc",
      source_citation: "https://internal.example/t039-linkage",
    })
    .select("id")
    .single();
  if (auditRes.error) {
    throw new Error(`seedAuditAndRun audit_log: ${auditRes.error.message}`);
  }
  const auditId = (auditRes.data as { id: string }).id;

  const runRes = await client
    .from("score_calculation_runs")
    .insert({
      scope: "all",
      trigger: "admin_recalc",
      triggered_by: ADMIN1_PARTICIPANT_ID,
      status: "succeeded",
      affected_record_count: affectedRecordCount,
      completed_at: new Date().toISOString(),
      triggering_audit_log_id: auditId,
    })
    .select("id")
    .single();
  if (runRes.error) {
    throw new Error(`seedAuditAndRun score_calculation_runs: ${runRes.error.message}`);
  }
  const runId = (runRes.data as { id: string }).id;

  // Backfill the audit row's entity_id to point at the run.
  const upd = await client
    .from("audit_log")
    .update({ entity_id: runId })
    .eq("id", auditId);
  if (upd.error) {
    throw new Error(`seedAuditAndRun update entity_id: ${upd.error.message}`);
  }

  return { auditId, runId, affectedRecordCount };
}

async function deleteSeed(seed: SeedResult): Promise<void> {
  const client = getServiceClient();
  // Delete score_records first if any (none in this seed), then the run, then
  // the audit row (in that order to avoid FK cascade surprises if the data
  // model later constrains things).
  const delRun = await client
    .from("score_calculation_runs")
    .delete()
    .eq("id", seed.runId);
  if (delRun.error) {
    console.error(`deleteSeed run: ${delRun.error.message}`);
  }
  const delAudit = await client
    .from("audit_log")
    .delete()
    .eq("id", seed.auditId);
  if (delAudit.error) {
    console.error(`deleteSeed audit: ${delAudit.error.message}`);
  }
}

test.describe(
  "T039 — /api/admin/audit/[id] returns linkage for admin.recalc_triggered rows @slice-006 @t039",
  () => {
    test.setTimeout(60_000);

    let seed: SeedResult | null = null;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      seed = await seedAuditAndRun();
    });

    test.afterEach(async () => {
      if (seed) {
        await deleteSeed(seed);
        seed = null;
      }
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 GETs /api/admin/audit/<id> for the seeded admin.recalc_triggered row; response.linkage.triggered_recalc_run_id equals the seeded run_id; affected_score_records_count equals 42 @slice-006 @t039",
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
          `/api/admin/audit/${seed!.auditId}`,
          { headers: { accept: "application/json" } },
        );
        expect(
          apiResponse.status(),
          `GET /api/admin/audit/${seed!.auditId} MUST return 200 for an admin (admin-audit.read.md)`,
        ).toBe(200);

        const body = (await apiResponse.json()) as {
          audit_log: { id: string; action: string };
          linkage: {
            triggered_recalc_run_id: string | null;
            affected_score_records_count: number;
            affected_participants_count: number;
          };
        };

        expect(
          body.audit_log.id,
          `response.audit_log.id MUST equal the seeded audit id '${seed!.auditId}'`,
        ).toBe(seed!.auditId);
        expect(
          body.audit_log.action,
          "response.audit_log.action MUST equal 'admin.recalc_triggered'",
        ).toBe("admin.recalc_triggered");
        expect(
          body.linkage.triggered_recalc_run_id,
          `response.linkage.triggered_recalc_run_id MUST equal the seeded run id '${seed!.runId}'`,
        ).toBe(seed!.runId);
        expect(
          body.linkage.affected_score_records_count,
          "response.linkage.affected_score_records_count MUST equal the run's affected_record_count (42)",
        ).toBe(seed!.affectedRecordCount);

        // Also navigate the SSR detail page and assert visibility + linkage
        // marker rendered.
        const pageResponse = await page.goto(
          `/admin/audit/${seed!.auditId}`,
        );
        expect(
          pageResponse!.status(),
          "/admin/audit/[id] MUST return 200 for an admin",
        ).toBe(200);
        await expect(
          page.locator('[data-testid="admin-audit-detail-page"]'),
          '[data-testid="admin-audit-detail-page"] MUST be visible',
        ).toBeVisible();
        await expect(
          page.locator('[data-testid="admin-audit-detail-triggered-run-id"]'),
          '[data-testid="admin-audit-detail-triggered-run-id"] MUST be visible (linkage rendered)',
        ).toHaveText(seed!.runId);
      },
    );
  },
);
