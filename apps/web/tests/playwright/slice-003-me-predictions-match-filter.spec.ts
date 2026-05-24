// --------------------------------------------------------------------------
// Slice 003 / T011 — `GET /api/me/predictions?match_id=<uuid>` filter.
// --------------------------------------------------------------------------
// RED acceptance test for the single-match query-param variant of GET
// /api/me/predictions.
//
// Source of truth:
//   - specs/003-match-predictions/contracts/predictions.read.md § Request
//     "When present, returns at most one prediction (the active one for
//     that match)."
//   - § 200 OK: "When `match_id` is supplied and no prediction exists for
//     that match: { predictions: [] }."
//
// Scenario (uses the slice-003-fixture.sql seed):
//   Alpha has an active prediction on M3 (cccc...001, 2-1) but NO active
//   prediction on M2 (M2 belongs to charlie's fixture).
//
//   Test A — GET ?match_id=<M3>  -> exactly 1 entry (alpha's M3 row)
//   Test B — GET ?match_id=<M2>  -> 0 entries
//
//   Both assertions in a single test body so the same signed-in session
//   exercises both branches.
//
// RED until T015 ships the /api/me/predictions GET handler with query
// validation + match_id filtering.
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

const M3_ARG_CAN_ID = "bbbb0000-0000-0000-0000-000000000003"; // alpha active 2-1
const M2_CAN_POL_ID = "bbbb0000-0000-0000-0000-000000000002"; // charlie's, alpha has none

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
  "US1 — GET /api/me/predictions?match_id filter @slice-003 @us1",
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
      "?match_id=<M3> returns 1 entry; ?match_id=<M2> returns 0 entries @slice-003 @us1",
      async ({ page, request }) => {
        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const headers = { Cookie: cookieHeader };

        // Branch A — alpha's active M3 pick MUST be returned exactly once.
        const hit = await request.get(
          `/api/me/predictions?match_id=${M3_ARG_CAN_ID}`,
          { headers },
        );
        expect(hit.status(), "filter by M3 MUST be 200").toBe(200);

        const hitBody = (await hit.json()) as MePredictionsResponse;
        expect(hitBody).toMatchObject({ predictions: expect.any(Array) });
        expect(
          hitBody.predictions.length,
          "alpha's M3 fixture pick MUST be the single returned row",
        ).toBe(1);

        const m3 = hitBody.predictions[0]!;
        expect(m3.match_id).toBe(M3_ARG_CAN_ID);
        expect(m3.predicted_home).toBe(2);
        expect(m3.predicted_away).toBe(1);
        expect(m3.source).toBe("ui");

        // Branch B — M2 belongs to charlie's fixture; alpha has no active
        // pick. The contract says "{ predictions: [] }" for this branch.
        const miss = await request.get(
          `/api/me/predictions?match_id=${M2_CAN_POL_ID}`,
          { headers },
        );
        expect(
          miss.status(),
          "filter by M2 (alpha has no row there) MUST still be 200, not 404",
        ).toBe(200);

        const missBody = (await miss.json()) as MePredictionsResponse;
        expect(missBody).toMatchObject({ predictions: expect.any(Array) });
        expect(
          missBody.predictions.length,
          "no active alpha-row for M2 means empty array per contract",
        ).toBe(0);
      },
    );
  },
);
