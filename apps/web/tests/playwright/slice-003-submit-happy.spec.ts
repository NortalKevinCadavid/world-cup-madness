// --------------------------------------------------------------------------
// Slice 003 / T011 — `POST /api/predictions` 200 happy-path Playwright spec.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) Acceptance Scenario 1.
//
// Source of truth:
//   - specs/003-match-predictions/contracts/predictions.write.md
//     § Endpoint POST /api/predictions, § Server behavior, § Response shapes
//   - specs/003-match-predictions/contracts/predictions.read.md
//     § Endpoint GET /api/me/predictions
//   - specs/003-match-predictions/spec.md § US1 Acceptance Scenario 1
//
// Scenario covered:
//   Sign in as alpha (eligible). POST /api/predictions for M6 USA-JPN — a
//   scheduled match alpha has NO existing prediction for in the slice-003
//   fixture (alpha's fixture-active matches are M3, M4, M5). Assert 200 +
//   `prediction.id` in the body. Then GET /api/me/predictions and assert
//   the new prediction appears.
//
// Cleanup contract:
//   The fixture's eight cccc... predictions are recreated on every
//   `supabase db reset`, but THIS test inserts an additional row whose UUID
//   is server-generated. To keep sibling tests from leaking state, the
//   afterEach uses the service-role helper to DELETE any prediction the
//   test introduced (matched by participant_id = alpha + match_id = M6).
//
// RED until T015 (the `/api/predictions` POST route handler) and the
// `/api/me/predictions` GET route handler land. Until then both requests
// fail with 404 from Next.js's default no-route response.
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

interface MePredictionsResponse {
  predictions: Array<{
    id: string;
    match_id: string;
    predicted_home: number;
    predicted_away: number;
    submitted_at: string;
    source: string;
  }>;
}

test.describe(
  "US1 — POST /api/predictions happy path @slice-003 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
      // Service-role cleanup: remove any row this test inserted for
      // (alpha, M6). The fixture never seeds this pair, so a DELETE here is
      // either a no-op (test failed before INSERT) or the cleanup of the
      // single row the test created.
      const client = getServiceClient();
      const { error } = await client
        .from("predictions")
        .delete()
        .eq("participant_id", ALPHA.participantId)
        .eq("match_id", M6_USA_JPN_ID);
      if (error) {
        throw new Error(
          `submit-happy afterEach cleanup failed — ${error.message}`,
        );
      }
    });

    test(
      "alpha submits 2-1 for M6 USA-JPN; receives 200 + body; row appears in GET /api/me/predictions @slice-003 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const submit = await request.post("/api/predictions", {
          data: { match_id: M6_USA_JPN_ID, home: 2, away: 1 },
        });

        expect(
          submit.status(),
          "submit MUST be 200 (contract § 200 OK — submission accepted)",
        ).toBe(200);

        const submitBody = (await submit.json()) as SubmitResponse;
        expect(
          submitBody,
          "200 body MUST match { prediction: { ... } } envelope",
        ).toMatchObject({
          prediction: {
            id: expect.any(String),
            match_id: M6_USA_JPN_ID,
            predicted_home: 2,
            predicted_away: 1,
            submitted_at: expect.any(String),
            source: "ui",
            superseded_at: null,
          },
        });

        // ISO-8601 parseable.
        expect(
          Number.isNaN(Date.parse(submitBody.prediction.submitted_at)),
          "submitted_at must be ISO-8601 parseable",
        ).toBe(false);

        const newId = submitBody.prediction.id;

        // Now GET /api/me/predictions and confirm the new row appears.
        const list = await request.get("/api/me/predictions");
        expect(
          list.status(),
          "GET /api/me/predictions for alpha MUST be 200",
        ).toBe(200);

        const listBody = (await list.json()) as MePredictionsResponse;
        const m6Entry = listBody.predictions.find(
          (p) => p.match_id === M6_USA_JPN_ID,
        );
        expect(
          m6Entry,
          "the newly-inserted prediction MUST appear in /api/me/predictions",
        ).toBeDefined();
        expect(m6Entry!.id).toBe(newId);
        expect(m6Entry!.predicted_home).toBe(2);
        expect(m6Entry!.predicted_away).toBe(1);
      },
    );
  },
);
