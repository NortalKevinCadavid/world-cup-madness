// --------------------------------------------------------------------------
// Slice 006 / T039 — `/admin/predictions/[participant]` admin submits a match
// prediction on behalf of a participant (RED-by-design until slot 0066 ships).
// --------------------------------------------------------------------------
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
//     `/admin/predictions/[participant]` — "Submit Prediction on Behalf"
//     form posts to /api/admin/predictions which calls admin_submit_prediction.
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md §
//     admin_submit_prediction — emits audit row
//     action='admin.prediction_submitted', delegates to slice 003's
//     submit_prediction OR the bypass-lock sibling depending on lock state.
//
// Persona: admin1 (admin role active via T009 + ensureAdminRole).
// Target participant: alpha (eligible non-admin).
// Target match: M4 from slice-005-fixture (status='scheduled' — unlocked
// so we go through Slice 003's regular submit_prediction path).
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
const ALPHA_PARTICIPANT_ID = "11111111-1111-1111-1111-111111111111";

// M4 from slice-005-fixture: scheduled (unlocked).
const M4 = "eeee0050-0000-0000-0000-000000000004";

const REASON = "Submitted on behalf — participant unavailable during window";
const SOURCE_CITATION = "https://internal.example/ticket/123";

interface AuditLogRow {
  id: string;
  actor: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  reason: string | null;
  source: string;
  source_citation: string | null;
  occurred_at: string;
}

async function readPredictionSubmittedRows(
  since: Date,
): Promise<AuditLogRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .select(
      "id,actor,action,entity_type,entity_id,reason,source,source_citation,occurred_at",
    )
    .eq("action", "admin.prediction_submitted")
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readPredictionSubmittedRows: ${error.message}`);
  }
  return (data ?? []) as AuditLogRow[];
}

async function purgeAdminPredictionsSince(since: Date): Promise<void> {
  const client = getServiceClient();
  const sinceIso = since.toISOString();
  // Delete admin-submitted predictions written by this test.
  const { error } = await client
    .from("predictions")
    .delete()
    .eq("participant_id", ALPHA_PARTICIPANT_ID)
    .eq("match_id", M4)
    .gte("submitted_at", sinceIso);
  if (error) {
    // Treat as soft cleanup failure — log but do not throw so afterEach
    // continues to restore other state.
    console.error(`purgeAdminPredictionsSince: ${error.message}`);
  }
}

test.describe(
  "T039 — admin submits prediction on behalf via /admin/predictions/[participant] @slice-006 @t039",
  () => {
    test.setTimeout(60_000);

    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      testStartInstant = new Date();
    });

    test.afterEach(async () => {
      await purgeAdminPredictionsSince(testStartInstant);
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 navigates to /admin/predictions/[alpha], submits match prediction via the form; POST /api/admin/predictions returns 200; audit row admin.prediction_submitted written for alpha @slice-006 @t039",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        const pageResponse = await page.goto(
          `/admin/predictions/${ALPHA_PARTICIPANT_ID}`,
        );
        expect(
          pageResponse,
          "page.goto('/admin/predictions/<alpha>') MUST return a Response object",
        ).not.toBeNull();
        expect(
          pageResponse!.status(),
          "/admin/predictions/[participant] MUST return 200 for an active admin",
        ).toBe(200);

        expect(
          new URL(page.url()).pathname,
          "Final URL pathname MUST be '/admin/predictions/<alpha>' (no redirect to /admin/denied)",
        ).toBe(`/admin/predictions/${ALPHA_PARTICIPANT_ID}`);

        await expect(
          page.locator('[data-testid="admin-predictions-page"]'),
          '[data-testid="admin-predictions-page"] MUST be visible on /admin/predictions/[participant]',
        ).toBeVisible();

        const form = page
          .locator('[data-testid="admin-submit-prediction-form"]')
          .first();
        await expect(
          form,
          '[data-testid="admin-submit-prediction-form"] MUST be visible (T039 contract)',
        ).toBeVisible();

        await form.locator('input[name="match_id"]').fill(M4);
        await form.locator('input[name="home_score"]').fill("2");
        await form.locator('input[name="away_score"]').fill("1");
        await form.locator('textarea[name="reason"]').fill(REASON);
        await form.locator('input[name="source_citation"]').fill(SOURCE_CITATION);

        const [postResponse] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes("/api/admin/predictions") &&
              r.request().method() === "POST",
            { timeout: 15_000 },
          ),
          form.locator('[data-testid="admin-submit-prediction-submit"]').click(),
        ]);

        expect(
          postResponse.status(),
          "POST /api/admin/predictions MUST return 200 for an admin call delegating to admin_submit_prediction (admin-rpcs.write.md § admin_submit_prediction)",
        ).toBe(200);

        const auditRows = await readPredictionSubmittedRows(testStartInstant);
        expect(
          auditRows.length,
          "audit_log MUST contain >= 1 admin.prediction_submitted row written since testStartInstant",
        ).toBeGreaterThanOrEqual(1);

        const auditRow = auditRows[0];
        expect(
          auditRow.action,
          "audit row action MUST equal 'admin.prediction_submitted'",
        ).toBe("admin.prediction_submitted");
        expect(
          auditRow.actor,
          `audit row actor MUST equal admin1's participants.id ('${ADMIN1_PARTICIPANT_ID}')`,
        ).toBe(ADMIN1_PARTICIPANT_ID);
        expect(
          auditRow.reason,
          `audit row reason MUST equal '${REASON}' verbatim`,
        ).toBe(REASON);
        expect(
          auditRow.source_citation,
          `audit row source_citation MUST equal '${SOURCE_CITATION}' verbatim`,
        ).toBe(SOURCE_CITATION);
      },
    );
  },
);
