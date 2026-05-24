// --------------------------------------------------------------------------
// Slice 004 / T013 — `POST /api/final-predictions` 404 invalid-player path.
// --------------------------------------------------------------------------
// RED acceptance test for the player-target-not-found branch of the
// final-predictions submit route.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § 404 Not Found — INVALID_TARGET with reason='player_not_found'.
//   - § Server behavior step 4: "Player kinds: SELECT 1 FROM players
//     WHERE id = body.target_player_id AND removed_at IS NULL. Zero rows
//     → 404 (distinguish player_not_found vs player_removed by a second
//     query if needed)."
//   - § Security invariants: 404 body distinguishes the three not-found
//     causes so participants get actionable feedback.
//
// Scenario:
//   Sign in as charlie. POST /api/final-predictions with
//   `{ item_kind: 'top_scorer', target_player_id: <all-zeros UUID> }`.
//   The all-zeros UUID is syntactically valid but absent from the
//   slice-004 players fixture (which uses the dddd1000-... namespace).
//   Expect 404 with body { error: { code: 'INVALID_TARGET', reason:
//   'player_not_found', message } }.
//
// This test deliberately uses an UUID that is NOT a removed player — the
// removed-player branch (reason='player_removed') is covered separately
// by `slice-004-submit-removed-player.spec.ts`.
//
// Cleanup contract:
//   No DB writes on this path. We still resetStub afterEach for hygiene.
//
// RED until T018 ships the route handler.
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
// slice-004 players fixture (which uses dddd1000-... namespace).
const ABSENT_PLAYER_UUID = "00000000-0000-0000-0000-000000000000";

test.describe(
  "US1 — POST /api/final-predictions 404 invalid player @slice-004 @us1",
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
      "POST top_scorer with a non-existent target_player_id MUST be 404 INVALID_TARGET player_not_found @slice-004 @us1",
      async ({ page, request }) => {
        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const response = await request.post("/api/final-predictions", {
          headers: { Cookie: cookieHeader },
          data: {
            item_kind: "top_scorer",
            target_player_id: ABSENT_PLAYER_UUID,
          },
        });

        expect(
          response.status(),
          "absent target_player_id MUST be rejected with 404 (contract § 404 INVALID_TARGET)",
        ).toBe(404);

        const body = (await response.json()) as unknown;
        expect(body).toMatchObject({
          error: {
            code: "INVALID_TARGET",
            message: expect.any(String),
            reason: "player_not_found",
          },
        });

        // The 404 body MUST NOT leak any other player's UUID (defense
        // against enumeration per § Security invariants).
        const rawText = JSON.stringify(body);
        expect(
          rawText,
          "404 body MUST NOT leak any dddd1000-... player UUID",
        ).not.toMatch(/dddd1000-0000-0000-0000-/i);
      },
    );
  },
);
