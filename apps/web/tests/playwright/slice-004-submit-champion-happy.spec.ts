// --------------------------------------------------------------------------
// Slice 004 / T013 — `POST /api/final-predictions` champion happy-path spec.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) Acceptance Scenario 1 (champion
// branch).
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Endpoint POST /api/final-predictions, § Response shapes (200 OK),
//     § Server behavior.
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/me/final-predictions.
//   - specs/004-final-predictions/spec.md § US1 Acceptance Scenario 1.
//
// Scenario covered:
//   Sign in as charlie (eligible). Charlie has NO existing champion pick
//   in the slice-004 fixture (Charlie's only fixture row is `best_player`
//   = Pedri), so the POST is a CREATE, never a supersede. POST
//   /api/final-predictions with `{ item_kind: 'champion', target_team_id:
//   <POL UUID> }`. Assert 200 + `final_prediction` envelope with the
//   contract's body shape. Then GET /api/me/final-predictions and assert
//   the new champion row appears in the response array.
//
// Cleanup contract:
//   The slice-004 fixture seeds Charlie's best_player row but never seeds
//   a champion pick for Charlie. THIS test inserts a champion row whose
//   UUID is server-generated. To keep sibling tests from leaking state,
//   beforeEach + afterEach use the service-role helper to DELETE any
//   final_predictions rows for (charlie, item_kind='champion'). Both
//   DELETEs are no-ops in the happy case (fixture never seeds the pair).
//
// RED until T018 ships the `/api/final-predictions` POST route handler
// and T011's `submit_final_prediction` SP. Until then both requests fail
// with 404 from Next.js's default no-route response.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

const CHARLIE = {
  sub: "00000000-0000-0000-0000-00000000000c",
  participantId: "33333333-3333-3333-3333-333333333333",
  email: "charlie@nortal.com",
  email_verified: true,
  name: "Charlie Tester",
} as const;

const POL_TEAM_ID = "aaaa0000-0000-0000-0000-000000000004";

interface FinalPredictionShape {
  id: string;
  item_kind: "champion" | "runner_up" | "top_scorer" | "best_player";
  target_team_id: string | null;
  target_player_id: string | null;
  submitted_at: string;
  source: "ui" | "api" | "admin_override";
  superseded_at: string | null;
}

interface SubmitResponse {
  final_prediction: FinalPredictionShape;
}

interface MeFinalPredictionsResponse {
  final_predictions: Array<{
    id: string;
    item_kind: string;
    target_team_id: string | null;
    target_player_id: string | null;
    submitted_at: string;
    source: string;
  }>;
  lock_state: "editable" | "locked";
  first_kickoff_utc: string | null;
}

async function cleanupCharlieChampionRows(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("final_predictions")
    .delete()
    .eq("participant_id", CHARLIE.participantId)
    .eq("item_kind", "champion");
  if (error) {
    throw new Error(
      `cleanupCharlieChampionRows failed — ${error.message}`,
    );
  }
}

test.describe(
  "US1 — POST /api/final-predictions champion happy path @slice-004 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await cleanupCharlieChampionRows();
    });

    test.afterEach(async () => {
      await resetStub();
      await cleanupCharlieChampionRows();
    });

    test(
      "charlie submits champion=POL; receives 200 + body; row appears in GET /api/me/final-predictions @slice-004 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: CHARLIE.sub,
            email: CHARLIE.email,
            email_verified: CHARLIE.email_verified,
            name: CHARLIE.name,
          },
        });

        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const authHeaders = { Cookie: cookieHeader };

        const submit = await request.post("/api/final-predictions", {
          headers: authHeaders,
          data: { item_kind: "champion", target_team_id: POL_TEAM_ID },
        });

        expect(
          submit.status(),
          "submit MUST be 200 (contract § 200 OK — submission accepted)",
        ).toBe(200);

        const submitBody = (await submit.json()) as SubmitResponse;
        expect(
          submitBody,
          "200 body MUST match { final_prediction: { ... } } envelope",
        ).toMatchObject({
          final_prediction: {
            id: expect.any(String),
            item_kind: "champion",
            target_team_id: POL_TEAM_ID,
            target_player_id: null,
            submitted_at: expect.any(String),
            source: "ui",
            superseded_at: null,
          },
        });

        // ISO-8601 parseable.
        expect(
          Number.isNaN(Date.parse(submitBody.final_prediction.submitted_at)),
          "submitted_at must be ISO-8601 parseable",
        ).toBe(false);

        const newId = submitBody.final_prediction.id;

        // Now GET /api/me/final-predictions and confirm the new row appears.
        const list = await request.get("/api/me/final-predictions", {
          headers: authHeaders,
        });
        expect(
          list.status(),
          "GET /api/me/final-predictions for charlie MUST be 200",
        ).toBe(200);

        const listBody = (await list.json()) as MeFinalPredictionsResponse;
        const championEntry = listBody.final_predictions.find(
          (p) => p.item_kind === "champion",
        );
        expect(
          championEntry,
          "the newly-inserted champion pick MUST appear in /api/me/final-predictions",
        ).toBeDefined();
        expect(championEntry!.id).toBe(newId);
        expect(championEntry!.target_team_id).toBe(POL_TEAM_ID);
        expect(championEntry!.target_player_id).toBeNull();
      },
    );
  },
);
