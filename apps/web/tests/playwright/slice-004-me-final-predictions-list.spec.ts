// --------------------------------------------------------------------------
// Slice 004 / T014 — `GET /api/me/final-predictions` list (multiple active rows).
// --------------------------------------------------------------------------
// RED acceptance test confirming GET /api/me/final-predictions returns
// ONLY the caller's active final predictions (`superseded_at IS NULL`),
// in the contract body shape, and never any other participant's rows.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/me/final-predictions — returns rows WHERE
//       participant_id = (caller) AND superseded_at IS NULL.
//
// Scenario (uses the slice-004-fixture.sql seed):
//   Alpha has THREE active final predictions in the fixture:
//     - dddd2000-0000-0000-0000-000000000001 — champion -> ARG
//     - dddd2000-0000-0000-0000-000000000002 — runner_up -> ESP
//     - dddd2000-0000-0000-0000-000000000003 — top_scorer -> Messi (player 01)
//
//   Sign in as alpha and GET /api/me/final-predictions. Assert:
//     - exactly 3 entries in the array
//     - item_kind set is {champion, runner_up, top_scorer}
//     - target_team_id for champion = ARG; for runner_up = ESP
//     - target_player_id for top_scorer = Messi (player 01)
//     - every entry carries the contract body shape (id, item_kind,
//       target_team_id, target_player_id, submitted_at, source)
//     - bravo's and charlie's final_predictions are NOT returned (RLS-bound)
//
// RED until T018 ships the /api/me/final-predictions GET handler.
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

const ARG_ID = "aaaa0000-0000-0000-0000-000000000001";
const ESP_ID = "aaaa0000-0000-0000-0000-000000000005";
const BRA_ID = "aaaa0000-0000-0000-0000-000000000006";
const MESSI_ID = "dddd1000-0000-0000-0000-000000000001";
const VINICIUS_ID = "dddd1000-0000-0000-0000-000000000011";
const PEDRI_ID = "dddd1000-0000-0000-0000-000000000009";

// Other-participant final predictions that MUST NOT appear in alpha's response.
const BRAVO_CHAMPION_FIXTURE_ID = "dddd2000-0000-0000-0000-000000000004";
const CHARLIE_BEST_PLAYER_FIXTURE_ID = "dddd2000-0000-0000-0000-000000000006";

interface FinalPredictionShape {
  id: string;
  item_kind: "champion" | "runner_up" | "top_scorer" | "best_player";
  target_team_id: string | null;
  target_player_id: string | null;
  submitted_at: string;
  source: string;
}

interface MeFinalPredictionsResponse {
  final_predictions: FinalPredictionShape[];
  lock_state: "editable" | "locked";
  first_kickoff_utc: string | null;
}

test.describe(
  "US1 — GET /api/me/final-predictions returns the caller's active rows only @slice-004 @us1",
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
      "alpha sees exactly 3 active fixture final predictions; bravo's and charlie's rows are excluded @slice-004 @us1",
      async ({ page, request }) => {
        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        const response = await request.get("/api/me/final-predictions", {
          headers: { Cookie: cookieHeader },
        });
        expect(
          response.status(),
          "GET /api/me/final-predictions MUST be 200",
        ).toBe(200);

        const body = (await response.json()) as MeFinalPredictionsResponse;
        expect(body).toMatchObject({
          final_predictions: expect.any(Array),
        });
        expect(
          body.final_predictions.length,
          "alpha has exactly 3 active fixture final predictions (champion ARG, runner_up ESP, top_scorer Messi)",
        ).toBe(3);

        const itemKinds = body.final_predictions.map((p) => p.item_kind).sort();
        expect(itemKinds).toEqual(["champion", "runner_up", "top_scorer"]);

        const champion = body.final_predictions.find(
          (p) => p.item_kind === "champion",
        )!;
        expect(champion).toBeDefined();
        expect(champion.target_team_id).toBe(ARG_ID);
        expect(champion.target_player_id).toBeNull();

        const runnerUp = body.final_predictions.find(
          (p) => p.item_kind === "runner_up",
        )!;
        expect(runnerUp).toBeDefined();
        expect(runnerUp.target_team_id).toBe(ESP_ID);
        expect(runnerUp.target_player_id).toBeNull();

        const topScorer = body.final_predictions.find(
          (p) => p.item_kind === "top_scorer",
        )!;
        expect(topScorer).toBeDefined();
        expect(topScorer.target_team_id).toBeNull();
        expect(topScorer.target_player_id).toBe(MESSI_ID);

        // Cross-participant rows MUST NOT appear (RLS-bound).
        const ids = body.final_predictions.map((p) => p.id);
        expect(
          ids,
          "bravo's champion fixture row MUST NOT leak into alpha's response",
        ).not.toContain(BRAVO_CHAMPION_FIXTURE_ID);
        expect(
          ids,
          "charlie's best_player fixture row MUST NOT leak into alpha's response",
        ).not.toContain(CHARLIE_BEST_PLAYER_FIXTURE_ID);

        // Cross-participant target IDs MUST NOT appear.
        const teamTargets = body.final_predictions
          .map((p) => p.target_team_id)
          .filter((x): x is string => x !== null);
        expect(
          teamTargets,
          "bravo's BRA champion target MUST NOT appear",
        ).not.toContain(BRA_ID);
        const playerTargets = body.final_predictions
          .map((p) => p.target_player_id)
          .filter((x): x is string => x !== null);
        expect(
          playerTargets,
          "bravo's Vinícius top_scorer target MUST NOT appear",
        ).not.toContain(VINICIUS_ID);
        expect(
          playerTargets,
          "charlie's Pedri best_player target MUST NOT appear",
        ).not.toContain(PEDRI_ID);

        // Contract body shape — every entry has the documented keys.
        for (const p of body.final_predictions) {
          expect(p).toEqual(
            expect.objectContaining({
              id: expect.any(String),
              item_kind: expect.any(String),
              submitted_at: expect.any(String),
              source: expect.any(String),
            }),
          );
          expect(
            Number.isNaN(Date.parse(p.submitted_at)),
            `submitted_at for final prediction ${p.id} must be ISO-8601`,
          ).toBe(false);
          // XOR check on target_team_id / target_player_id (data-model
          // CHECK final_predictions_target_xor_kind).
          const teamPresent = p.target_team_id !== null;
          const playerPresent = p.target_player_id !== null;
          expect(
            teamPresent !== playerPresent,
            `final prediction ${p.id} MUST populate exactly one of target_team_id / target_player_id (XOR)`,
          ).toBe(true);
          expect(p.source).toBe("ui");
        }
      },
    );
  },
);
