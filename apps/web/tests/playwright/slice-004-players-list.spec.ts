// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/players 200 returns the 16-player roster.
// --------------------------------------------------------------------------
// RED acceptance test for the eligible-caller branch of GET /api/players,
// an RLS-gated roster with optional team/q filters.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/players + § Test surface — slice-004-players-list.
//   - supabase/seed/slice-004-fixture.sql — 16 players (2 per team × 8 teams).
//
// Scenario:
//   Sign in as alpha. GET /api/players (no filters). Assert 200 + array of
//   16 players, total_matching=16, sorted by full_name ASC, every entry
//   carries (id, full_name, team_id, team_short_code).
//
// RED until T018 ships the /api/players handler.
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

test.describe(
  "US1 — GET /api/players 200 returns the 16-player slice-004 fixture roster @slice-004 @us1",
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
      "alpha GET /api/players returns 16 active players with total_matching=16, sorted by full_name ASC @slice-004 @us1",
      async ({ page, request }) => {
        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        // Request a large limit so all 16 fixture players fit in the page
        // (default limit is 50 per contract; this is belt-and-braces).
        const response = await request.get("/api/players?limit=100", {
          headers: { Cookie: cookieHeader },
        });
        expect(response.status(), "GET /api/players MUST be 200").toBe(200);

        const body = (await response.json()) as PlayersResponse;
        expect(body).toMatchObject({
          players: expect.any(Array),
          total_matching: expect.any(Number),
        });
        expect(
          body.players.length,
          "fixture seeds exactly 16 players (2 per team × 8 teams)",
        ).toBe(16);
        expect(
          body.total_matching,
          "total_matching MUST reflect the COUNT(*) OVER () = 16",
        ).toBe(16);

        // Sorted by full_name ASC (contract § Server behavior step 3).
        const names = body.players.map((p) => p.full_name);
        const sorted = [...names].sort((a, b) => a.localeCompare(b));
        expect(names, "players MUST be sorted by full_name ASC").toEqual(
          sorted,
        );

        // Contract body shape — every entry has the documented keys.
        for (const p of body.players) {
          expect(p).toEqual(
            expect.objectContaining({
              id: expect.any(String),
              full_name: expect.any(String),
            }),
          );
          expect("team_id" in p).toBe(true);
          expect("team_short_code" in p).toBe(true);
        }

        // Spot-check Messi is present with team ARG.
        const messi = body.players.find((p) => p.full_name === "Lionel Messi");
        expect(messi, "Lionel Messi MUST be in the roster").toBeDefined();
        expect(messi?.team_short_code).toBe("ARG");
      },
    );
  },
);
