// --------------------------------------------------------------------------
// Slice 006 / T039 — `/admin/pending-review` admin resolves a match_pending_review
// row via the per-row "Accept Provider" action (RED-by-design until slot 0069
// `admin_resolve_match_pending_review` ships).
// --------------------------------------------------------------------------
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
//     `/admin/pending-review` — per-row resolution buttons post to
//     /api/admin/pending-review/[id].
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md §
//     admin_resolve_match_pending_review — UPDATEs match_pending_review with
//     reviewed_at/reviewer/resolution/resolution_notes; emits audit row
//     action='admin.pending_review_resolved'.
//
// Persona: admin1. Pre-state: an open match_pending_review row is seeded by
// this test (service-role) so it is independent of fixture state.
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

// M1 from slice-005-fixture (finished).
const M1 = "eeee0050-0000-0000-0000-000000000001";

const REASON = "Provider observation matches official scorecard";
const SOURCE_CITATION = "https://fifa.example/m1/observation";

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

interface ReviewRow {
  id: string;
  match_id: string;
  reviewed_at: string | null;
  resolution: string | null;
  reviewer: string | null;
}

async function seedPendingReview(): Promise<string> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("match_pending_review")
    .insert({
      match_id: M1,
      reason: "score_conflict",
      provider_observation: { home_score: 3, away_score: 1 },
      current_value: { home_score: 2, away_score: 1 },
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(`seedPendingReview: ${error.message}`);
  }
  return (data as { id: string }).id;
}

async function deletePendingReview(id: string): Promise<void> {
  const client = getServiceClient();
  const { error } = await client.from("match_pending_review").delete().eq("id", id);
  if (error) {
    console.error(`deletePendingReview(${id}): ${error.message}`);
  }
}

async function readReview(id: string): Promise<ReviewRow | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("match_pending_review")
    .select("id,match_id,reviewed_at,resolution,reviewer")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`readReview: ${error.message}`);
  return (data as ReviewRow | null) ?? null;
}

async function readPendingResolvedRows(since: Date): Promise<AuditLogRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .select(
      "id,actor,action,entity_type,entity_id,reason,source,source_citation,occurred_at",
    )
    .eq("action", "admin.pending_review_resolved")
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readPendingResolvedRows: ${error.message}`);
  }
  return (data ?? []) as AuditLogRow[];
}

test.describe(
  "T039 — admin resolves a match_pending_review row via /admin/pending-review @slice-006 @t039",
  () => {
    test.setTimeout(60_000);

    let reviewId: string | null = null;
    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      reviewId = await seedPendingReview();
      testStartInstant = new Date();
    });

    test.afterEach(async () => {
      if (reviewId) {
        await deletePendingReview(reviewId);
        reviewId = null;
      }
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 navigates to /admin/pending-review, clicks 'Accept Provider' on the seeded row; POST returns 200; match_pending_review.reviewed_at + resolution='accept_provider' set; audit row admin.pending_review_resolved written @slice-006 @t039",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        const pageResponse = await page.goto("/admin/pending-review");
        expect(
          pageResponse,
          "page.goto('/admin/pending-review') MUST return a Response object",
        ).not.toBeNull();
        expect(
          pageResponse!.status(),
          "/admin/pending-review MUST return 200 for an active admin",
        ).toBe(200);

        await expect(
          page.locator('[data-testid="admin-pending-review-page"]'),
          '[data-testid="admin-pending-review-page"] MUST be visible',
        ).toBeVisible();

        // Find our seeded row (there may be others from sibling tests).
        const row = page
          .locator('[data-testid="admin-pending-review-row"]')
          .filter({ hasText: reviewId!.slice(0, 8) })
          .first();
        await expect(
          row,
          `[data-testid="admin-pending-review-row"] containing review id prefix '${reviewId!.slice(0, 8)}' MUST be visible`,
        ).toBeVisible();

        await row.locator('textarea[name="reason"]').fill(REASON);
        await row
          .locator('input[name="source_citation"]')
          .fill(SOURCE_CITATION);

        const [postResponse] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes(`/api/admin/pending-review/${reviewId}`) &&
              r.request().method() === "POST",
            { timeout: 15_000 },
          ),
          row
            .locator('[data-testid="admin-pending-review-accept-provider"]')
            .click(),
        ]);

        expect(
          postResponse.status(),
          "POST /api/admin/pending-review/<id> MUST return 200 (admin-rpcs.write.md § admin_resolve_match_pending_review)",
        ).toBe(200);

        const reviewAfter = await readReview(reviewId!);
        expect(
          reviewAfter,
          `match_pending_review row id='${reviewId}' MUST still exist after resolution`,
        ).not.toBeNull();
        expect(
          reviewAfter!.reviewed_at,
          "match_pending_review.reviewed_at MUST be non-NULL after admin resolution",
        ).not.toBeNull();
        expect(
          reviewAfter!.resolution,
          "match_pending_review.resolution MUST equal 'accept_provider' after the Accept Provider button was clicked",
        ).toBe("accept_provider");
        expect(
          reviewAfter!.reviewer,
          `match_pending_review.reviewer MUST equal admin1's participants.id ('${ADMIN1_PARTICIPANT_ID}')`,
        ).toBe(ADMIN1_PARTICIPANT_ID);

        const auditRows = await readPendingResolvedRows(testStartInstant);
        expect(
          auditRows.length,
          "audit_log MUST contain >= 1 admin.pending_review_resolved row since testStartInstant",
        ).toBeGreaterThanOrEqual(1);

        const auditRow = auditRows[0];
        expect(
          auditRow.action,
          "audit row action MUST equal 'admin.pending_review_resolved'",
        ).toBe("admin.pending_review_resolved");
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
