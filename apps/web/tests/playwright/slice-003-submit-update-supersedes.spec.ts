// --------------------------------------------------------------------------
// Slice 003 / T019 — `POST /api/predictions` update supersedes prior row.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 2 (P1) Acceptance Scenarios 1 + 2.
//
// Source of truth:
//   - specs/003-match-predictions/spec.md § US2 Acceptance Scenarios
//       1. New prediction MUST become the active record; previous MUST be
//          retained as superseded (not deleted); audit MUST capture both.
//       2. Exactly one active prediction MUST exist per (participant, match)
//          pair at any point in time (FR-006).
//   - specs/003-match-predictions/contracts/predictions.write.md
//       § Stored procedure — submit_prediction § Semantics steps 7-9
//       (active row SELECT FOR UPDATE; INSERT new; UPDATE old
//        superseded_at = now(), superseded_by = v_new_id).
//
// Scenario covered:
//   Sign in as alpha. POST 1-0 for M6 USA-JPN — alpha has no fixture row
//   for M6 so this is a CREATE. Capture the first prediction.id. POST 2-1
//   for M6 — this is an UPDATE that supersedes the first. Capture the
//   second prediction.id (MUST differ from the first). Then via the
//   service-role helper verify the data invariants:
//     - first row: superseded_at IS NOT NULL, superseded_by = second.id
//     - second row: superseded_at IS NULL
//     - exactly ONE active row exists for (alpha, M6)
//
// Why M6: alpha's fixture-active matches are M3, M4, M5. M6 USA-JPN has no
// seeded prediction for alpha (see slice-003-fixture.sql and
// slice-003-submit-happy.spec.ts), so we never collide with the existing
// (alpha, M4) 1-1 fixture row.
//
// Cleanup contract:
//   beforeEach deletes any (alpha, M6) rows via service-role so a prior
//   worker leak does not poison the test. afterEach repeats the DELETE to
//   keep sibling tests clean. The fixture seed never touches (alpha, M6),
//   so both DELETEs are no-ops in the happy case.
//
// RED until T021 replaces the WCM06 DUPLICATE_ACTIVE branch with the
// supersede semantics described in contracts/predictions.write.md.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

// M6 USA-JPN — scheduled, alpha has no fixture prediction on this match.
const M6_USA_JPN_ID = "bbbb0000-0000-0000-0000-000000000006";

interface PredictionShape {
  id: string;
  match_id: string;
  predicted_home: number;
  predicted_away: number;
  submitted_at: string;
  source: "ui" | "api" | "admin_override";
  superseded_at: string | null;
}

interface SubmitResponse {
  prediction: PredictionShape;
}

/**
 * Service-role DELETE of any predictions for (alpha, M6). Both beforeEach
 * and afterEach call this so a crash mid-test does not poison siblings.
 */
async function cleanupAlphaM6PredictionsViaServiceRole(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("predictions")
    .delete()
    .eq("participant_id", ALPHA.participantId)
    .eq("match_id", M6_USA_JPN_ID);
  if (error) {
    throw new Error(
      `cleanupAlphaM6PredictionsViaServiceRole failed — ${error.message}`,
    );
  }
}

test.describe(
  "US2 — POST /api/predictions update supersedes prior active row @slice-003 @us2",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await cleanupAlphaM6PredictionsViaServiceRole();
    });

    test.afterEach(async () => {
      await resetStub();
      await cleanupAlphaM6PredictionsViaServiceRole();
    });

    test(
      "alpha POSTs 1-0 then 2-1 for M6; first row is superseded; exactly one active row remains @slice-003 @us2",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const authHeaders = { Cookie: cookieHeader };

        // ---- 1. CREATE: POST 1-0 → 200 ----------------------------------
        const first = await request.post("/api/predictions", {
          headers: authHeaders,
          data: { match_id: M6_USA_JPN_ID, home: 1, away: 0 },
        });
        expect(
          first.status(),
          "first POST (CREATE) MUST be 200 per contract § 200 OK",
        ).toBe(200);
        const firstBody = (await first.json()) as SubmitResponse;
        const firstId = firstBody.prediction.id;
        expect(firstBody.prediction.predicted_home).toBe(1);
        expect(firstBody.prediction.predicted_away).toBe(0);
        expect(
          firstBody.prediction.superseded_at,
          "freshly-created active row MUST have superseded_at = null",
        ).toBeNull();

        // ---- 2. UPDATE: POST 2-1 → 200, new id ---------------------------
        const second = await request.post("/api/predictions", {
          headers: authHeaders,
          data: { match_id: M6_USA_JPN_ID, home: 2, away: 1 },
        });
        expect(
          second.status(),
          "second POST (UPDATE/supersede) MUST be 200 — NOT 409 — per US2 AS-1",
        ).toBe(200);
        const secondBody = (await second.json()) as SubmitResponse;
        const secondId = secondBody.prediction.id;
        expect(secondBody.prediction.predicted_home).toBe(2);
        expect(secondBody.prediction.predicted_away).toBe(1);
        expect(
          secondBody.prediction.superseded_at,
          "the new active row MUST have superseded_at = null",
        ).toBeNull();
        expect(
          secondId,
          "the supersede branch MUST INSERT a new row — id MUST differ from the prior active row",
        ).not.toBe(firstId);

        // ---- 3. Verify supersede chain via service-role -----------------
        const client = getServiceClient();

        const { data: firstRow, error: firstReadErr } = await client
          .from("predictions")
          .select("id, superseded_at, superseded_by, participant_id, match_id")
          .eq("id", firstId)
          .maybeSingle();
        if (firstReadErr) {
          throw new Error(
            `service-role read of first row failed — ${firstReadErr.message}`,
          );
        }
        expect(firstRow, "the first (now-superseded) row MUST still exist (NOT deleted)").not.toBeNull();
        expect(
          firstRow!.superseded_at,
          "the first row's superseded_at MUST be set after the update (FR-006 / US2 AS-1)",
        ).not.toBeNull();
        expect(
          firstRow!.superseded_by,
          "the first row's superseded_by MUST point at the new active row",
        ).toBe(secondId);

        const { data: secondRow, error: secondReadErr } = await client
          .from("predictions")
          .select("id, superseded_at, superseded_by, participant_id, match_id")
          .eq("id", secondId)
          .maybeSingle();
        if (secondReadErr) {
          throw new Error(
            `service-role read of second row failed — ${secondReadErr.message}`,
          );
        }
        expect(secondRow, "the second (active) row MUST exist").not.toBeNull();
        expect(
          secondRow!.superseded_at,
          "the second row MUST be active (superseded_at IS NULL)",
        ).toBeNull();

        // ---- 4. Exactly ONE active row for (alpha, M6) — FR-006 ---------
        const { count: activeCount, error: countErr } = await client
          .from("predictions")
          .select("id", { count: "exact", head: true })
          .eq("participant_id", ALPHA.participantId)
          .eq("match_id", M6_USA_JPN_ID)
          .is("superseded_at", null);
        if (countErr) {
          throw new Error(
            `service-role count of active rows failed — ${countErr.message}`,
          );
        }
        expect(
          activeCount,
          "exactly ONE active prediction MUST exist per (participant, match) — FR-006",
        ).toBe(1);
      },
    );
  },
);
