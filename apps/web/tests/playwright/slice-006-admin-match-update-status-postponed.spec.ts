// --------------------------------------------------------------------------
// Slice 006 / T028 — `/admin/matches/[id]` update status 'finished' → 'postponed' (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 (P2) "Match status correction":
//
//   "Given an authorized administrator and a match with status='finished',
//   When the admin submits the MatchUpdateForm with status='postponed'
//   (plus reason + source), Then the matches row MUST be persisted, an
//   audit row `action='admin.match_updated'` MUST capture the previous_value
//   and new_value showing the status transition, and Slice 005's
//   `score_match` will skip this match on subsequent recalcs because
//   status != 'finished'."
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § `/admin/matches/[id]` — "Update Status / Kickoff" form posts to
//       `/api/admin/matches/[id]` which calls `admin_update_match`.
//       Test surface row: "Update status to 'postponed' → 200 + Slice 003
//       fan-out trigger fires for active predictions".
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md
//       § `admin_update_match` — UPDATE matches with COALESCE; audit row
//       `action='admin.match_updated'` capturing OLD + NEW.
//   - specs/006-admin-overrides/data-model.md § audit_log — action label
//       admin.match_updated is canonical.
//   - specs/006-admin-overrides/tasks.md § T028.
//   - supabase/seed/slice-005-fixture.sql § 3 — M1 status='finished'
//       (eeee0050-…-001, ARG vs MEX, kickoff 2026-06-01T20:00Z).
//   - apps/web/tests/playwright/slice-006-admin-match-correct-score-happy.spec.ts —
//       admin1 + ensureAdminRole + match-detail navigation + audit verify pattern.
//
// Persona: admin1 (admin role active via T009 + ensureAdminRole).
//
// Cleanup contract:
//   beforeEach: resetStub + ensureAdminRole(admin1) + snapshot M1
//   matches row (status + kickoff_utc) + capture testStartInstant.
//   afterEach:
//     1. Restore M1.status='finished' (and kickoff_utc to its fixture value)
//        byte-identically to the snapshot.
//     2. Slice 003's kickoff-correction fan-out trigger and Slice 005's
//        score-trigger MAY have produced score_records /
//        score_calculation_runs rows — purge any with since-cutoff
//        testStartInstant.
//     3. audit_log rows are append-only; not deleted.
//     4. resetStub + ensureAdminRole (defensive).
//
// RED-by-design until:
//   - T030 ships `admin_update_match` SP at migration slot 0065.
//   - T031 ships `/api/admin/matches/[id]/route.ts` (full POST handler;
//     today T015 only stubs the match-results POST) and `MatchUpdateForm`
//     on `/admin/matches/[id]/page.tsx` (sibling to T016's
//     MatchCorrectionForm).
//   Failure is always assertion-level.
//
// Selectors implied (T031 MUST honor — MatchUpdateForm is a SIBLING to
// MatchCorrectionForm from T016; they live on the same /admin/matches/[id]
// page but render as distinct forms with distinct data-testids):
//   - select[name="status"]
//       Options: scheduled | finished | postponed | cancelled.
//   - input[name="kickoff_utc"]
//       datetime-local input (left blank by this test — only status changes).
//   - textarea[name="reason"]
//   - input[name="source_citation"]
//   - [data-testid="admin-match-update-submit"]
//       Submit button for the MatchUpdateForm (distinct from
//       [data-testid="admin-match-correct-score-submit"] which belongs to
//       MatchCorrectionForm).
//
// Note on Slice 005 score_match skip behavior:
//   Slice 005's score_match SP filters matches to status='finished'. After
//   this test flips M1.status='postponed', a subsequent score_match call
//   would no longer emit score_records for M1. We do NOT trigger that
//   call from this spec — T032 (Phase 5 regression checkpoint) owns the
//   end-to-end recalc verification. This spec asserts the necessary
//   *invariant* on matches.status which is what score_match reads.
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

// M1 from slice-005-fixture.sql § 3 (ARG vs MEX, finished).
const M1 = "eeee0050-0000-0000-0000-000000000001";

const UPDATE_REASON = "Match postponed pending weather review";
const SOURCE_CITATION = "https://fifa.example/notices/m1-postponed";

interface MatchRow {
  id: string;
  home_team_id: string;
  away_team_id: string;
  stage: string;
  group_id: string | null;
  kickoff_utc: string;
  venue: string | null;
  status: string;
}

async function readM1Match(): Promise<MatchRow> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("matches")
    .select(
      "id,home_team_id,away_team_id,stage,group_id,kickoff_utc,venue,status",
    )
    .eq("id", M1)
    .maybeSingle();
  if (error) {
    throw new Error(`readM1Match: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `readM1Match: no matches row for ${M1}. Confirm supabase/seed/slice-005-fixture.sql was applied.`,
    );
  }
  return data as MatchRow;
}

async function restoreM1(snapshot: MatchRow): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("matches")
    .update({
      status: snapshot.status,
      kickoff_utc: snapshot.kickoff_utc,
    })
    .eq("id", M1);
  if (error) {
    throw new Error(
      `restoreM1: ${error.message}. Manual repair required — slice-005 fixture invariant is now broken.`,
    );
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
  source_citation: string | null;
  occurred_at: string;
}

async function readMatchUpdatedAuditRows(since: Date): Promise<AuditLogRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .select(
      "id,actor,action,entity_type,entity_id,previous_value,new_value,reason,source,source_citation,occurred_at",
    )
    .eq("action", "admin.match_updated")
    .eq("entity_id", M1)
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readMatchUpdatedAuditRows: ${error.message}`);
  }
  return (data ?? []) as AuditLogRow[];
}

async function purgeScoringRowsSince(since: Date): Promise<void> {
  const client = getServiceClient();
  const sinceIso = since.toISOString();

  const { error: srErr } = await client
    .from("score_records")
    .delete()
    .gte("calculated_at", sinceIso);
  if (srErr) {
    throw new Error(`purgeScoringRowsSince score_records: ${srErr.message}`);
  }

  const { error: runsErr } = await client
    .from("score_calculation_runs")
    .delete()
    .gte("started_at", sinceIso);
  if (runsErr) {
    throw new Error(
      `purgeScoringRowsSince score_calculation_runs: ${runsErr.message}`,
    );
  }
}

/**
 * Extracts the `status` field from a jsonb-shaped audit_log column
 * (previous_value / new_value). The SP captures row_to_json(matches) into
 * these columns per admin-rpcs.write.md § admin_update_match step 4.
 */
function extractStatus(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.status === "string") return v.status;
  return undefined;
}

test.describe(
  "US3 — admin updates M1 status from 'finished' to 'postponed'; audit row written; matches.status reflects change @slice-006 @us3",
  () => {
    test.setTimeout(60_000);

    let fixtureSnapshot: MatchRow | null = null;
    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      const snap = await readM1Match();
      // Sanity precondition: M1 fixture status MUST start as 'finished'.
      if (snap.status !== "finished") {
        throw new Error(
          `beforeEach precondition: matches.status for M1 MUST start as 'finished'; ` +
            `got '${snap.status}'. A sibling test likely left mutated state.`,
        );
      }
      fixtureSnapshot = snap;
      testStartInstant = new Date();
    });

    test.afterEach(async () => {
      if (fixtureSnapshot) {
        await restoreM1(fixtureSnapshot);
      }
      // Slice 003's kickoff-correction fan-out trigger and Slice 005's
      // score-trigger may have written score rows on the way down. Purge
      // anything we created so sibling tests start from the fixture state.
      await purgeScoringRowsSince(testStartInstant);
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 navigates to /admin/matches/M1, MatchUpdateForm sets status='postponed' with reason + source; response 200; matches.status='postponed'; audit row admin.match_updated written with previous_value.status='finished' AND new_value.status='postponed' @slice-006 @us3",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        // Navigate to /admin/matches/[id].
        const detailResponse = await page.goto(`/admin/matches/${M1}`);
        expect(
          detailResponse,
          "page.goto('/admin/matches/M1') MUST return a Response object",
        ).not.toBeNull();
        expect(
          detailResponse!.status(),
          "/admin/matches/M1 MUST return 200 for an active admin",
        ).toBe(200);

        // Final URL pathname MUST still be /admin/matches/M1 (no redirect).
        expect(
          new URL(page.url()).pathname,
          "Final URL pathname MUST be '/admin/matches/<M1>' for an active admin",
        ).toBe(`/admin/matches/${M1}`);

        // The MatchUpdateForm fields. Scope locators to the MatchUpdateForm's
        // submit button to disambiguate from the sibling MatchCorrectionForm.
        // Selecting status by name MAY return MULTIPLE elements if both forms
        // are on the page; the MatchUpdateForm's status select is the one
        // adjacent to data-testid="admin-match-update-submit". To remain
        // robust to either layout (one form vs two), we change status by
        // selecting the OPTION-bearing select element that's a sibling-or-
        // ancestor of the update-submit button.
        const updateSubmit = page.locator(
          '[data-testid="admin-match-update-submit"]',
        );
        await expect(
          updateSubmit,
          '[data-testid="admin-match-update-submit"] MUST be visible on /admin/matches/<M1> (MatchUpdateForm submit — T031 contract)',
        ).toBeVisible();

        // Use the update form's enclosing region. T031 layout: the
        // MatchUpdateForm is a <form> ancestor of the update-submit button.
        // The selector `xpath=ancestor::form[1]` returns the immediate
        // wrapping form regardless of intermediate DOM.
        const updateForm = updateSubmit.locator("xpath=ancestor::form[1]");

        await updateForm
          .locator('select[name="status"]')
          .selectOption("postponed");

        await updateForm
          .locator('textarea[name="reason"]')
          .fill(UPDATE_REASON);
        await updateForm
          .locator('input[name="source_citation"]')
          .fill(SOURCE_CITATION);

        // Submit and capture the underlying POST response. T031 modifies the
        // T015-stubbed /api/admin/matches/[id] route to call admin_update_match.
        const [postResponse] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes(`/api/admin/matches/${M1}`) &&
              r.request().method() === "POST",
            { timeout: 15_000 },
          ),
          updateSubmit.click(),
        ]);

        expect(
          postResponse.status(),
          "POST /api/admin/matches/<M1> MUST return 200 (admin-rpcs.write.md § admin_update_match)",
        ).toBe(200);

        // Service-role verify: matches.status='postponed'.
        const updated = await readM1Match();
        expect(
          updated.status,
          "matches.status for M1 MUST equal 'postponed' after admin update",
        ).toBe("postponed");

        // Service-role verify: audit_log row admin.match_updated written with
        // OLD.status='finished' AND NEW.status='postponed'.
        const auditRows = await readMatchUpdatedAuditRows(testStartInstant);
        expect(
          auditRows.length,
          "audit_log MUST contain at least one admin.match_updated row for M1 written after the test started",
        ).toBeGreaterThanOrEqual(1);

        const auditRow = auditRows[0];
        expect(
          auditRow.action,
          "audit row action MUST be 'admin.match_updated' (data-model.md § audit_log)",
        ).toBe("admin.match_updated");
        expect(
          auditRow.entity_id,
          `audit row entity_id MUST equal M1 ('${M1}')`,
        ).toBe(M1);
        expect(
          auditRow.actor,
          `audit row actor MUST equal admin1's participants.id ('${ADMIN1_PARTICIPANT_ID}')`,
        ).toBe(ADMIN1_PARTICIPANT_ID);
        expect(
          auditRow.reason,
          `audit row reason MUST equal '${UPDATE_REASON}' verbatim`,
        ).toBe(UPDATE_REASON);
        expect(
          auditRow.source_citation,
          `audit row source_citation MUST equal '${SOURCE_CITATION}' verbatim`,
        ).toBe(SOURCE_CITATION);

        // The SP captures row_to_json(matches) into previous_value / new_value
        // per admin-rpcs.write.md § admin_update_match step 4. The status
        // field of each MUST reflect the transition.
        expect(
          extractStatus(auditRow.previous_value),
          "audit row previous_value.status MUST equal 'finished' (the M1 fixture pre-state captured by admin_update_match step 4)",
        ).toBe("finished");
        expect(
          extractStatus(auditRow.new_value),
          "audit row new_value.status MUST equal 'postponed' (the post-UPDATE row state)",
        ).toBe("postponed");

        // Slice 005 score_match invariant: with matches.status != 'finished',
        // a subsequent score_match call would not emit score_records rows for
        // this match. T032 (Phase 5 regression checkpoint) owns the
        // end-to-end recalc assertion; here we only assert the necessary
        // precondition on matches.status, which is what score_match reads.
        expect(
          updated.status,
          "matches.status='postponed' satisfies the precondition for Slice 005's score_match to skip M1 on subsequent recalcs (status != 'finished'); the end-to-end recalc skip assertion is T032's responsibility",
        ).not.toBe("finished");
      },
    );
  },
);
