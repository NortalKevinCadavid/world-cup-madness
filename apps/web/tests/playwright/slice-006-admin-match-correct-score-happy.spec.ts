// --------------------------------------------------------------------------
// Slice 006 / T011 — `/admin/matches/[id]` correct-score happy path (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) Acceptance Scenario 1:
//
//   "Given an authorized administrator and a scored match with provider
//   score 2-1, When they submit an override changing the score to 2-2
//   with reason 'official correction' and source 'https://...', Then the
//   override MUST be persisted, the previous score MUST be retained in
//   audit history, a recalculation MUST be triggered for affected
//   predictions, and an audit event MUST capture actor, target, previous
//   value, new value, reason, and source."
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § `/admin/matches/[id]` — "Correct Score" form posts to
//       `/api/admin/match-results` which calls `admin_record_match_result`.
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md
//       § `admin_record_match_result(...)` — audit row
//       `action='admin.match_result_corrected'`, previous_value=old jsonb,
//       new_value=new jsonb, reason, source_citation NOT NULL.
//   - specs/006-admin-overrides/spec.md § US1 AS1.
//   - supabase/seed/slice-005-fixture.sql § 4 — M1 fixture state
//     home_score_official=2 away_score_official=1
//     home_score_for_scoring=2 away_score_for_scoring=1.
//   - apps/web/tests/playwright/slice-005-match-scoring.spec.ts — admin1
//     persona + ensureAdminRole + getServiceClient patterns.
//
// Persona: admin1 (admin role active via T009 + ensureAdminRole).
//
// Cleanup contract:
//   beforeEach: resetStub + ensureAdminRole(admin1) + snapshot M1
//   match_results row to a local variable.
//   afterEach: restore M1 match_results to the snapshot value (the
//   fixture-shipped 2-1 / 2-1 state). Audit_log rows are append-only
//   (Slice 007 contract) — they are NOT deleted, but the `since` filter
//   excludes pre-test rows. Also re-ensure admin1 has active role.
//
// RED-by-design until:
//   - T013 ships `admin_record_match_result` SP at migration slot 0064.
//   - T015 ships `/api/admin/match-results/route.ts` (POST → calls the SP).
//   - T016 ships `/admin/matches/[id]/page.tsx` with the correction form.
//   Until those land:
//     * `page.goto('/admin/matches/<M1>')` 404s.
//     * Even if the form existed, the route handler would 404.
//   Failure is always assertion-level (status=200 expectations fail).
//
// Selectors implied (T016 contract):
//   - input[name="home_score"]               — corrected home score
//   - input[name="away_score"]               — corrected away score
//   - textarea[name="reason"]                — free-text reason
//   - input[name="source_citation"]          — URL / document reference
//   - button[type="submit"][data-testid="admin-match-correct-score-submit"]
//     (or any submit button inside [data-testid="admin-match-correct-score-form"]).
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

// M1 from slice-005-fixture.sql § 3 (ARG vs MEX, finished, 2-1).
const M1 = "eeee0050-0000-0000-0000-000000000001";

// Source citation tested literally below — must match audit row exactly.
const SOURCE_CITATION = "https://fifa.example/m1";
const CORRECTION_REASON = "FIFA Bureau decision";

interface MatchResultsRow {
  match_id: string;
  home_score: number;
  away_score: number;
  home_score_for_scoring: number;
  away_score_for_scoring: number;
  result_status: string;
  recorded_at: string;
  recorded_by: string | null;
  source: string;
  // home_score_official / away_score_official are the locked Slice 002 names
  // (see admin-rpcs.write.md § admin_record_match_result behavior step 4).
  // Slice 002's match_results table uses `home_score` / `away_score` as the
  // "official" columns plus the separate `*_for_scoring` columns. The
  // task body refers to these as `home_score_official` / `away_score_official`
  // — they ARE the `home_score` / `away_score` columns. We assert via both
  // shapes below.
}

async function readM1MatchResults(): Promise<MatchResultsRow | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("match_results")
    .select("*")
    .eq("match_id", M1)
    .maybeSingle();
  if (error) {
    throw new Error(`readM1MatchResults: ${error.message}`);
  }
  return (data ?? null) as MatchResultsRow | null;
}

async function restoreM1ToFixtureState(snapshot: MatchResultsRow): Promise<void> {
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
    throw new Error(`restoreM1ToFixtureState: ${error.message}`);
  }
}

interface AuditLogRow {
  id: string;
  actor: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  previous_value: unknown;
  new_value: unknown;
  reason: string | null;
  source: string;
  // source_citation added by Slice 006 / T005 (migration 0059) per
  // data-model.md § audit_log additive column.
  source_citation: string | null;
  occurred_at: string;
}

async function readMatchCorrectedAuditRows(since: Date): Promise<AuditLogRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .select(
      "id,actor,action,entity_type,entity_id,previous_value,new_value,reason,source,source_citation,occurred_at",
    )
    .eq("action", "admin.match_result_corrected")
    .eq("entity_id", M1)
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readMatchCorrectedAuditRows: ${error.message}`);
  }
  return (data ?? []) as AuditLogRow[];
}

test.describe(
  "US1 — admin corrects M1 score 2-1 → 2-2 happy path @slice-006 @us1",
  () => {
    test.setTimeout(60_000);

    let fixtureSnapshot: MatchResultsRow | null = null;
    let testStartInstant: Date;

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
      testStartInstant = new Date();
    });

    test.afterEach(async () => {
      if (fixtureSnapshot) {
        await restoreM1ToFixtureState(fixtureSnapshot);
      }
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 navigates to /admin/matches/M1, submits 2-2 with reason + source; response 200; match_results updated; audit row written @slice-006 @us1",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        // Navigate to match detail page.
        const detailResponse = await page.goto(`/admin/matches/${M1}`);
        expect(
          detailResponse,
          "page.goto('/admin/matches/M1') MUST return a Response object",
        ).not.toBeNull();
        expect(
          detailResponse!.status(),
          "/admin/matches/M1 MUST return 200 for an active admin",
        ).toBe(200);

        // Fill the correction form. The contract names the fields:
        //   home_score, away_score, reason, source_citation.
        // T016's page MUST surface input names matching the route-handler
        // body shape (which delegates to admin_record_match_result).
        await page.locator('input[name="home_score"]').fill("2");
        await page.locator('input[name="away_score"]').fill("2");
        await page.locator('textarea[name="reason"]').fill(CORRECTION_REASON);
        await page
          .locator('input[name="source_citation"]')
          .fill(SOURCE_CITATION);

        // Submit and capture the underlying POST response.
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
          "POST /api/admin/match-results MUST return 200 (admin-rpcs.write.md § admin_record_match_result Returns)",
        ).toBe(200);

        // Service-role verify: match_results row reflects 2-2.
        const updated = await readM1MatchResults();
        expect(updated, "match_results row for M1 MUST still exist").not.toBeNull();
        expect(
          updated!.home_score,
          "match_results.home_score (the 'official' home score per Slice 002 column naming) MUST be 2 after the correction",
        ).toBe(2);
        expect(
          updated!.away_score,
          "match_results.away_score (the 'official' away score) MUST be 2 after the correction",
        ).toBe(2);
        expect(
          updated!.home_score_for_scoring,
          "match_results.home_score_for_scoring MUST be 2 after the correction (Slice 005's score_match reads this column)",
        ).toBe(2);
        expect(
          updated!.away_score_for_scoring,
          "match_results.away_score_for_scoring MUST be 2 after the correction",
        ).toBe(2);

        // Service-role verify: audit row written.
        const auditRows = await readMatchCorrectedAuditRows(testStartInstant);
        expect(
          auditRows.length,
          "audit_log MUST contain at least one admin.match_result_corrected row for M1 written after the test started",
        ).toBeGreaterThanOrEqual(1);

        const auditRow = auditRows[0];
        expect(
          auditRow.action,
          "audit row action MUST be 'admin.match_result_corrected' (admin-rpcs.write.md § admin_record_match_result behavior step 6)",
        ).toBe("admin.match_result_corrected");
        expect(
          auditRow.entity_id,
          `audit row entity_id MUST equal M1 ('${M1}')`,
        ).toBe(M1);
        expect(
          auditRow.source_citation,
          `audit row source_citation MUST equal '${SOURCE_CITATION}' verbatim (data-model.md § audit_log additive column)`,
        ).toBe(SOURCE_CITATION);
        expect(
          auditRow.reason,
          `audit row reason MUST equal '${CORRECTION_REASON}' verbatim`,
        ).toBe(CORRECTION_REASON);
        expect(
          auditRow.actor,
          `audit row actor MUST equal admin1's participants.id ('${ADMIN1_PARTICIPANT_ID}')`,
        ).toBe(ADMIN1_PARTICIPANT_ID);
      },
    );
  },
);
