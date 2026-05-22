// --------------------------------------------------------------------------
// Slice 004 / T013 — `POST /api/final-predictions` 400 bad-body specs.
// --------------------------------------------------------------------------
// RED acceptance tests for the three route-handler-level zod validation
// rejection paths.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § 400 Bad Request — malformed body or kind/target mismatch:
//       { error: { code: 'BAD_REQUEST', message: '...' } }
//   - § Request body table (kind/target consistency):
//       target_team_id   required iff item_kind IN ('champion','runner_up')
//       target_player_id required iff item_kind IN ('top_scorer','best_player')
//   - § Server behavior step 2: "Parse + validate body with a Zod schema
//     enforcing kind/target consistency. Failure → 400 BEFORE eligibility
//     check."
//
// Sub-tests in this file:
//   1. Missing `item_kind`            → 400 BAD_REQUEST
//   2. champion + target_player_id    → 400 BAD_REQUEST  (wrong target kind)
//   3. top_scorer + target_team_id    → 400 BAD_REQUEST  (wrong target kind)
//
// All three MUST be rejected by route-handler zod BEFORE the SP is
// invoked — proving § Server behavior step 2 fires before steps 3-7.
// The fact that the rejection is pre-SP also means the request author
// does not need to be eligible-tested specifically here — but charlie
// signs in to make the "rejection precedes eligibility" invariant
// explicit (we are eligible AND still rejected → so it's the body, not
// the JWT).
//
// Cleanup:
//   The 400 path never inserts a row. resetStub afterEach for hygiene.
//
// RED until T018 ships the route handler with the zod schema.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

const CHARLIE = {
  sub: "00000000-0000-0000-0000-00000000000c",
  email: "charlie@nortal.com",
  email_verified: true,
  name: "Charlie Tester",
} as const;

const POL_TEAM_ID = "aaaa0000-0000-0000-0000-000000000004";
const MESSI_PLAYER_ID = "dddd1000-0000-0000-0000-000000000001";

function assertBadRequestBody(body: unknown): void {
  expect(body).toMatchObject({
    error: {
      code: "BAD_REQUEST",
      message: expect.any(String),
    },
  });

  // Defense-in-depth — no stack trace leakage.
  const rawText = JSON.stringify(body);
  expect(
    rawText,
    "400 body MUST NOT contain a stack frame",
  ).not.toMatch(/at\s+\S+\s+\(/);
}

test.describe(
  "US1 — POST /api/final-predictions 400 bad-body paths @slice-004 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async ({ page }) => {
      await resetStub();
      await signInWithIdentity(page, {
        claims: {
          sub: CHARLIE.sub,
          email: CHARLIE.email,
          email_verified: CHARLIE.email_verified,
          name: CHARLIE.name,
        },
      });
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "missing item_kind is rejected with 400 BAD_REQUEST @slice-004 @us1",
      async ({ request }) => {
        const response = await request.post("/api/final-predictions", {
          // No item_kind field at all. target_team_id alone cannot tell
          // the server which kind is intended → zod failure.
          data: { target_team_id: POL_TEAM_ID },
        });

        expect(
          response.status(),
          "missing item_kind MUST be 400 (contract § 400 / Server behavior step 2)",
        ).toBe(400);

        assertBadRequestBody(await response.json());
      },
    );

    test(
      "item_kind=champion with target_player_id set is rejected with 400 BAD_REQUEST @slice-004 @us1",
      async ({ request }) => {
        const response = await request.post("/api/final-predictions", {
          data: {
            item_kind: "champion",
            // Wrong target kind for a team-kind item.
            target_player_id: MESSI_PLAYER_ID,
          },
        });

        expect(
          response.status(),
          "champion + target_player_id MUST be 400 (kind/target consistency rule)",
        ).toBe(400);

        assertBadRequestBody(await response.json());
      },
    );

    test(
      "item_kind=top_scorer with target_team_id set is rejected with 400 BAD_REQUEST @slice-004 @us1",
      async ({ request }) => {
        const response = await request.post("/api/final-predictions", {
          data: {
            item_kind: "top_scorer",
            // Wrong target kind for a player-kind item.
            target_team_id: POL_TEAM_ID,
          },
        });

        expect(
          response.status(),
          "top_scorer + target_team_id MUST be 400 (kind/target consistency rule)",
        ).toBe(400);

        assertBadRequestBody(await response.json());
      },
    );
  },
);
