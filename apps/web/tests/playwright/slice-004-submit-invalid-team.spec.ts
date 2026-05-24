// --------------------------------------------------------------------------
// Slice 004 / T013 — `POST /api/final-predictions` 404 invalid-team path.
// --------------------------------------------------------------------------
// RED acceptance test for the team-target-not-found branch of the
// final-predictions submit route.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § 404 Not Found — INVALID_TARGET with reason='team_not_found'.
//   - § Server behavior step 4: "Team kinds: SELECT 1 FROM teams WHERE id
//     = body.target_team_id. Zero rows → 404 with reason='team_not_found'."
//   - § Security invariants: 404 body distinguishes team_not_found vs
//     player_not_found vs player_removed.
//
// Scenario:
//   Sign in as charlie. POST /api/final-predictions with
//   `{ item_kind: 'champion', target_team_id: <all-zeros UUID> }` — the
//   all-zeros UUID is syntactically valid but absent from the slice-002
//   teams fixture (which uses aaaa0000-... namespace). Expect 404 with
//   body envelope { error: { code: 'INVALID_TARGET', reason:
//   'team_not_found', message } }.
//
// Cleanup contract:
//   The 404 path never inserts a row, so no DB cleanup is required. We
//   still resetStub afterEach for hygiene.
//
// RED until T018 wires the target-existence check into the POST handler.
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

// All-zeros UUID — syntactically valid, semantically absent from the
// slice-002 teams fixture (which uses the aaaa0000-... namespace).
const ABSENT_TEAM_UUID = "00000000-0000-0000-0000-000000000000";

test.describe(
  "US1 — POST /api/final-predictions 404 invalid team @slice-004 @us1",
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
      "POST champion with a non-existent target_team_id MUST be 404 INVALID_TARGET team_not_found @slice-004 @us1",
      async ({ page, request }) => {
        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const response = await request.post("/api/final-predictions", {
          headers: { Cookie: cookieHeader },
          data: {
            item_kind: "champion",
            target_team_id: ABSENT_TEAM_UUID,
          },
        });

        expect(
          response.status(),
          "absent target_team_id MUST be rejected with 404 (contract § 404 INVALID_TARGET)",
        ).toBe(404);

        const body = (await response.json()) as unknown;
        expect(body).toMatchObject({
          error: {
            code: "INVALID_TARGET",
            message: expect.any(String),
            reason: "team_not_found",
          },
        });

        // The 404 body MUST NOT leak any other team's UUID (defense
        // against enumeration per § Security invariants).
        const rawText = JSON.stringify(body);
        expect(
          rawText,
          "404 body MUST NOT leak any aaaa0000-... team UUID",
        ).not.toMatch(/aaaa0000-0000-0000-0000-/i);
      },
    );
  },
);
