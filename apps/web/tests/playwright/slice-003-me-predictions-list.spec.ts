// --------------------------------------------------------------------------
// Slice 003 / T011 — `GET /api/me/predictions` list (multiple active rows).
// --------------------------------------------------------------------------
// RED acceptance test confirming GET /api/me/predictions returns ONLY the
// caller's active predictions (`superseded_at IS NULL`), in the contract
// body shape, and never any other participant's rows.
//
// Source of truth:
//   - specs/003-match-predictions/contracts/predictions.read.md § Endpoint
//     GET /api/me/predictions — returns rows WHERE
//       participant_id = (caller) AND superseded_at IS NULL
//     ORDERed by submitted_at DESC.
//   - specs/003-match-predictions/spec.md § US1 Acceptance Scenario 1 +
//     Clarifications 2026-05-16 Q3 (active-only — no history surface).
//
// Scenario (uses the slice-003-fixture.sql seed, no inline writes):
//   Alpha has THREE active predictions in the fixture:
//     - cccc...001 — M3 ARG-CAN, 2-1 (UI). Row 2 of the fixture (1-0) is
//       superseded by Row 1 and MUST NOT appear.
//     - cccc...005 — M4 MEX-POL, 1-1 (UI).
//     - cccc...007 — M5 ESP-BRA, 2-2 (API source).
//
//   Sign in as alpha and GET /api/me/predictions. Assert:
//     - exactly 3 entries in the array
//     - all three match_ids appear (M3, M4, M5)
//     - the superseded 1-0 / cccc...002 row is ABSENT
//     - every entry carries the contract body shape (id, match_id,
//       predicted_home, predicted_away, submitted_at, source)
//     - bravo's and charlie's predictions on M3 are NOT returned (RLS-bound)
//
// RED until T015 ships the /api/me/predictions GET handler.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const M3_ARG_CAN_ID = "bbbb0000-0000-0000-0000-000000000003";
const M4_MEX_POL_ID = "bbbb0000-0000-0000-0000-000000000004";
const M5_ESP_BRA_ID = "bbbb0000-0000-0000-0000-000000000005";

// Other-participant matches that MUST NOT appear in alpha's response.
const M1_ARG_MEX_ID = "bbbb0000-0000-0000-0000-000000000001"; // bravo's
const M2_CAN_POL_ID = "bbbb0000-0000-0000-0000-000000000002"; // charlie's

const ALPHA_ACTIVE_FIXTURE_ID = "cccc0000-0000-0000-0000-000000000001"; // M3 row 1
const ALPHA_SUPERSEDED_FIXTURE_ID = "cccc0000-0000-0000-0000-000000000002"; // M3 row 2

interface PredictionShape {
  id: string;
  match_id: string;
  predicted_home: number;
  predicted_away: number;
  submitted_at: string;
  source: string;
}

interface MePredictionsResponse {
  predictions: PredictionShape[];
}

test.describe(
  "US1 — GET /api/me/predictions returns the caller's active rows only @slice-003 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async ({ page }) => {
      await resetStub();
      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA.sub,
          email: ALPHA.email,
          email_verified: ALPHA.email_verified,
          name: ALPHA.name,
        },
      });
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "alpha sees exactly 3 active fixture predictions; the superseded row and other participants' rows are excluded @slice-003 @us1",
      async ({ page, request }) => {
        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const response = await request.get("/api/me/predictions", {
          headers: { Cookie: cookieHeader },
        });
        expect(response.status(), "GET /api/me/predictions MUST be 200").toBe(
          200,
        );

        const body = (await response.json()) as MePredictionsResponse;
        expect(body).toMatchObject({ predictions: expect.any(Array) });
        expect(
          body.predictions.length,
          "alpha has exactly 3 active fixture predictions (M3 2-1, M4 1-1, M5 2-2)",
        ).toBe(3);

        const matchIds = body.predictions.map((p) => p.match_id).sort();
        expect(matchIds).toEqual(
          [M3_ARG_CAN_ID, M4_MEX_POL_ID, M5_ESP_BRA_ID].sort(),
        );

        // The superseded M3 row 2 (1-0) MUST be excluded — Clarifications
        // 2026-05-16 Q3: active-only.
        const ids = body.predictions.map((p) => p.id);
        expect(
          ids,
          "the superseded fixture row MUST be excluded (active-only per Q3)",
        ).not.toContain(ALPHA_SUPERSEDED_FIXTURE_ID);
        expect(
          ids,
          "the current active M3 row MUST be included",
        ).toContain(ALPHA_ACTIVE_FIXTURE_ID);

        // Cross-participant rows MUST NOT appear (RLS-bound).
        expect(matchIds).not.toContain(M1_ARG_MEX_ID);
        expect(matchIds).not.toContain(M2_CAN_POL_ID);

        // Contract body shape — every entry has the documented keys.
        for (const p of body.predictions) {
          expect(p).toEqual(
            expect.objectContaining({
              id: expect.any(String),
              match_id: expect.any(String),
              predicted_home: expect.any(Number),
              predicted_away: expect.any(Number),
              submitted_at: expect.any(String),
              source: expect.any(String),
            }),
          );
          expect(
            Number.isNaN(Date.parse(p.submitted_at)),
            `submitted_at for prediction ${p.id} must be ISO-8601`,
          ).toBe(false);
        }

        // Spot-check the contract field values for the M3 active pick.
        const m3 = body.predictions.find((p) => p.match_id === M3_ARG_CAN_ID)!;
        expect(m3.predicted_home).toBe(2);
        expect(m3.predicted_away).toBe(1);
        expect(m3.source).toBe("ui");

        // Spot-check the API-source pick for M5 — proves `source` carries
        // the SP's value through unchanged.
        const m5 = body.predictions.find((p) => p.match_id === M5_ESP_BRA_ID)!;
        expect(m5.source).toBe("api");
      },
    );
  },
);
