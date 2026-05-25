// --------------------------------------------------------------------------
// Slice 006 / T011 — `/admin/matches/[id]` rejects empty reason (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) Acceptance Scenario 2:
//
//   "Given an administrator submitting an override, When they omit the
//   reason OR the source field, Then the override MUST be rejected with
//   a clear validation error; the system MUST NOT accept overrides
//   without justification." (FR-002)
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md
//       § Pre-flight (WAR03) — `IF p_reason IS NULL OR length(trim()) = 0
//       THEN RAISE ERRCODE='WAR03'`. Route handler maps WAR03 → HTTP 400
//       with field-level error envelope.
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § `/admin/matches/[id]` — "Each form requires reason +
//       source_citation; client-side validation matches server-side
//       ERRCODE expectations."
//   - specs/006-admin-overrides/spec.md § US1 AS2 + FR-002.
//
// Persona: admin1 (admin role active).
//
// Cleanup contract:
//   beforeEach: resetStub + ensureAdminRole + snapshot M1 match_results.
//   afterEach: restore M1 (defense-in-depth — this test expects NO mutation
//   to happen at all, but the snapshot/restore protects against a future
//   regression that incorrectly persists despite the validation failure).
//
// Selectors implied (T016 contract):
//   - input[name="home_score"], input[name="away_score"]
//   - textarea[name="reason"]              — left BLANK by this test
//   - input[name="source_citation"]
//   - submit button inside admin-match-correct-score-form
//
// Error envelope expected (admin-rpcs.write.md ERRCODE→HTTP map, WAR03):
//   { error: { code: 'VALIDATION_FAILED', reason: 'reason_required',
//              field: 'reason' } }
// The exact `code` / `reason` names match the slice's "Locked per
// WAR01-06" convention in admin-ui.surface.md § Cross-slice contract
// summary. The Then-clause asserts on `error.field === 'reason'` because
// the task body specifies a field-level error MUST be surfaced.
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

const SOURCE_CITATION = "https://fifa.example/m1-empty-reason";

interface MatchResultsRow {
  match_id: string;
  home_score: number;
  away_score: number;
  home_score_for_scoring: number;
  away_score_for_scoring: number;
  result_status: string;
  source: string;
}

async function readM1MatchResults(): Promise<MatchResultsRow | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("match_results")
    .select(
      "match_id,home_score,away_score,home_score_for_scoring,away_score_for_scoring,result_status,source",
    )
    .eq("match_id", M1)
    .maybeSingle();
  if (error) {
    throw new Error(`readM1MatchResults: ${error.message}`);
  }
  return (data ?? null) as MatchResultsRow | null;
}

async function restoreM1(snapshot: MatchResultsRow): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("match_results")
    .update({
      home_score: snapshot.home_score,
      away_score: snapshot.away_score,
      home_score_for_scoring: snapshot.home_score_for_scoring,
      away_score_for_scoring: snapshot.away_score_for_scoring,
      result_status: snapshot.result_status,
      source: snapshot.source,
    })
    .eq("match_id", M1);
  if (error) {
    throw new Error(`restoreM1: ${error.message}`);
  }
}

interface ErrorBody {
  error: {
    code: string;
    message?: string;
    reason?: string;
    field?: string;
  };
}

test.describe(
  "US1 — admin correct-score with empty reason is rejected @slice-006 @us1",
  () => {
    test.setTimeout(60_000);

    let fixtureSnapshot: MatchResultsRow | null = null;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      const snap = await readM1MatchResults();
      if (!snap) {
        throw new Error(
          `M1 (${M1}) match_results row missing — confirm supabase/seed/slice-005-fixture.sql was applied.`,
        );
      }
      fixtureSnapshot = snap;
    });

    test.afterEach(async () => {
      if (fixtureSnapshot) {
        await restoreM1(fixtureSnapshot);
      }
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 submits 3-3 with empty reason; response 400 + field='reason'; match_results unchanged @slice-006 @us1",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        const detailResponse = await page.goto(`/admin/matches/${M1}`);
        expect(
          detailResponse,
          "page.goto('/admin/matches/M1') MUST return a Response object",
        ).not.toBeNull();
        expect(
          detailResponse!.status(),
          "/admin/matches/M1 MUST return 200 for an active admin",
        ).toBe(200);

        // Fill scores + source_citation, leave reason BLANK. The textarea is
        // explicitly cleared (not just left untouched) so the test is robust
        // against any default-value the page might pre-populate.
        // Scope to admin-match-correct-score-form — the page also renders
        // admin-match-update-form (status/venue) which has its own
        // input[name="home_score"] / textarea[name="reason"].
        const correctForm = page.getByTestId("admin-match-correct-score-form");
        await correctForm.locator('input[name="home_score"]').fill("3");
        await correctForm.locator('input[name="away_score"]').fill("3");
        await correctForm.locator('textarea[name="reason"]').fill("");
        await correctForm
          .locator('input[name="source_citation"]')
          .fill(SOURCE_CITATION);

        const [postResponse] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes("/api/admin/match-results") &&
              r.request().method() === "POST",
            { timeout: 10_000 },
          ),
          page
            .locator(
              '[data-testid="admin-match-correct-score-form"] button[type="submit"], [data-testid="admin-match-correct-score-submit"]',
            )
            .first()
            .click(),
        ]);

        expect(
          postResponse.status(),
          "POST /api/admin/match-results with empty reason MUST return 400 " +
            "(admin-rpcs.write.md § Pre-flight WAR03 → HTTP map; FR-002)",
        ).toBe(400);

        const body = (await postResponse.json()) as ErrorBody;
        expect(
          body.error,
          "400 body MUST have an `error` envelope (admin-rpcs.write.md error responses)",
        ).toBeDefined();
        expect(
          body.error.field,
          "400 body MUST surface a field-level error with `error.field === 'reason'` " +
            "(admin-ui.surface.md § `/admin/matches/[id]` — client-side validation matches server-side ERRCODE)",
        ).toBe("reason");

        // Service-role verify: match_results MUST NOT have changed.
        const after = await readM1MatchResults();
        expect(after, "match_results row MUST still exist").not.toBeNull();
        expect(
          after!.home_score,
          `match_results.home_score MUST remain ${fixtureSnapshot!.home_score} (unchanged after 400)`,
        ).toBe(fixtureSnapshot!.home_score);
        expect(
          after!.away_score,
          `match_results.away_score MUST remain ${fixtureSnapshot!.away_score} (unchanged after 400)`,
        ).toBe(fixtureSnapshot!.away_score);
        expect(
          after!.home_score_for_scoring,
          `match_results.home_score_for_scoring MUST remain ${fixtureSnapshot!.home_score_for_scoring}`,
        ).toBe(fixtureSnapshot!.home_score_for_scoring);
        expect(
          after!.away_score_for_scoring,
          `match_results.away_score_for_scoring MUST remain ${fixtureSnapshot!.away_score_for_scoring}`,
        ).toBe(fixtureSnapshot!.away_score_for_scoring);
      },
    );
  },
);
