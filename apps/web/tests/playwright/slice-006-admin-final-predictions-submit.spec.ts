// --------------------------------------------------------------------------
// Slice 006 / T039 — `/admin/predictions/[participant]` admin submits a final
// prediction on behalf of a participant (RED-by-design until slot 0067 ships).
// --------------------------------------------------------------------------
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
//     `/admin/predictions/[participant]` — "Submit Final Prediction on Behalf"
//     form posts to /api/admin/final-predictions.
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md §
//     admin_submit_final_prediction — emits audit row
//     action='admin.final_prediction_submitted'; lock-bypass decided by SP.
//
// Persona: admin1.
// Target participant: alpha.
// Item kind: 'champion' (team uuid). Picks ARG.
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

// ARG team id used widely in slice-005-fixture as champion target.
const ARG_TEAM_ID = "cccc0010-0000-0000-0000-000000000001";

const REASON =
  "Submitted final pick on behalf — alpha unavailable during finals window";
const SOURCE_CITATION = "https://internal.example/ticket/124";

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

async function readFinalPredictionSubmittedRows(
  since: Date,
): Promise<AuditLogRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .select(
      "id,actor,action,entity_type,entity_id,reason,source,source_citation,occurred_at",
    )
    .eq("action", "admin.final_prediction_submitted")
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readFinalPredictionSubmittedRows: ${error.message}`);
  }
  return (data ?? []) as AuditLogRow[];
}

async function purgeAdminFinalPredictionsSince(since: Date): Promise<void> {
  const client = getServiceClient();
  const sinceIso = since.toISOString();
  const { error } = await client
    .from("final_predictions")
    .delete()
    .eq("participant_id", ALPHA_PARTICIPANT_ID)
    .eq("item_kind", "champion")
    .gte("submitted_at", sinceIso);
  if (error) {
    console.error(`purgeAdminFinalPredictionsSince: ${error.message}`);
  }
}

test.describe(
  "T039 — admin submits final prediction on behalf via /admin/predictions/[participant] @slice-006 @t039",
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
      await purgeAdminFinalPredictionsSince(testStartInstant);
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 navigates to /admin/predictions/[alpha], submits final prediction (champion=ARG) via the final form; POST /api/admin/final-predictions returns 200; audit row admin.final_prediction_submitted written @slice-006 @t039",
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

        const form = page
          .locator('[data-testid="admin-submit-final-prediction-form"]')
          .first();
        await expect(
          form,
          '[data-testid="admin-submit-final-prediction-form"] MUST be visible (T039 contract)',
        ).toBeVisible();

        await form.locator('select[name="item_kind"]').selectOption("champion");
        await form.locator('input[name="target_id"]').fill(ARG_TEAM_ID);
        await form.locator('textarea[name="reason"]').fill(REASON);
        await form.locator('input[name="source_citation"]').fill(SOURCE_CITATION);

        const [postResponse] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes("/api/admin/final-predictions") &&
              r.request().method() === "POST",
            { timeout: 15_000 },
          ),
          form
            .locator('[data-testid="admin-submit-final-prediction-submit"]')
            .click(),
        ]);

        expect(
          postResponse.status(),
          "POST /api/admin/final-predictions MUST return 200 for a valid admin call (admin-rpcs.write.md § admin_submit_final_prediction)",
        ).toBe(200);

        const auditRows = await readFinalPredictionSubmittedRows(
          testStartInstant,
        );
        expect(
          auditRows.length,
          "audit_log MUST contain >= 1 admin.final_prediction_submitted row written since testStartInstant",
        ).toBeGreaterThanOrEqual(1);

        const auditRow = auditRows[0];
        expect(
          auditRow.action,
          "audit row action MUST equal 'admin.final_prediction_submitted'",
        ).toBe("admin.final_prediction_submitted");
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
