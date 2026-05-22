// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/players excludes rows with removed_at IS NOT NULL.
// --------------------------------------------------------------------------
// RED acceptance test for the soft-delete filter branch of GET /api/players.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/players § Server behavior step 3 — SQL filter
//     `WHERE p.removed_at IS NULL` (active roster only).
//   - migrations/0039_players.sql — removed_at soft-delete signal.
//   - Clarifications 2026-05-17 Q1 — soft-delete semantics for players.
//
// Scenario:
//   Service-role mutates Pedri's (player 09) `removed_at` to `now()`.
//   Sign in as alpha and GET /api/players (large limit). Assert Pedri is
//   NOT in the response. Cleanup restores Pedri's `removed_at = NULL` in
//   afterEach so sibling tests see the canonical fixture roster.
//
// RED until T018 ships the /api/players handler with the active-only
// filter.
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
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const PEDRI_ID = "dddd1000-0000-0000-0000-000000000009";

interface PlayerRow {
  id: string;
  full_name: string;
  team_id: string | null;
  team_short_code: string | null;
}

interface PlayersResponse {
  players: PlayerRow[];
  total_matching: number;
}

async function setPlayerRemovedAt(
  playerId: string,
  value: string | null,
): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("players")
    .update({ removed_at: value })
    .eq("id", playerId);
  if (error) {
    throw new Error(
      `setPlayerRemovedAt(${playerId}, ${String(value)}) failed — ${error.message}`,
    );
  }
}

test.describe(
  "US1 — GET /api/players excludes rows with removed_at IS NOT NULL @slice-004 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      // Soft-delete Pedri for the duration of this test.
      await setPlayerRemovedAt(PEDRI_ID, new Date().toISOString());
    });

    test.afterEach(async () => {
      // Restore the fixture state — Pedri is on roster (removed_at = NULL).
      await setPlayerRemovedAt(PEDRI_ID, null);
      await resetStub();
    });

    test(
      "alpha GET /api/players does NOT include Pedri after his removed_at is set @slice-004 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        const response = await request.get("/api/players?limit=100", {
          headers: { Cookie: cookieHeader },
        });
        expect(response.status(), "GET /api/players MUST be 200").toBe(200);

        const body = (await response.json()) as PlayersResponse;
        const ids = body.players.map((p) => p.id);
        expect(
          ids,
          "Pedri (removed_at != NULL) MUST NOT appear in /api/players output",
        ).not.toContain(PEDRI_ID);

        // 16 - 1 = 15 remaining active fixture players.
        expect(
          body.players.length,
          "removing 1 player from the 16-row fixture roster leaves 15 active rows",
        ).toBe(15);
        expect(
          body.total_matching,
          "total_matching MUST reflect active-only count = 15",
        ).toBe(15);
      },
    );
  },
);
