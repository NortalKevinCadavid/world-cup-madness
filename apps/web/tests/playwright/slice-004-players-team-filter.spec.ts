// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/players?team_id=<ARG> 200 returns ARG roster only.
// --------------------------------------------------------------------------
// RED acceptance test for the team_id filter branch of GET /api/players.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/players § Request — team_id filter.
//   - slice-004-fixture.sql — ARG roster: Messi (player 01) + Álvarez (player 02).
//
// Scenario:
//   Sign in as alpha. GET /api/players?team_id=<ARG_UUID>. Assert 200 +
//   exactly 2 players (Messi + Álvarez), all with team_short_code='ARG'.
//
// RED until T018 ships the /api/players handler with the team_id filter.
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
const MESSI_ID = "dddd1000-0000-0000-0000-000000000001";
const ALVAREZ_ID = "dddd1000-0000-0000-0000-000000000002";

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
  "US1 — GET /api/players?team_id=<ARG> returns ARG-only roster @slice-004 @us1",
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
      "alpha GET /api/players?team_id=<ARG> returns exactly Messi + Álvarez @slice-004 @us1",
      async ({ page, request }) => {
        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        const response = await request.get(
          `/api/players?team_id=${ARG_ID}`,
          { headers: { Cookie: cookieHeader } },
        );
        expect(
          response.status(),
          "GET /api/players?team_id=<ARG> MUST be 200",
        ).toBe(200);

        const body = (await response.json()) as PlayersResponse;
        expect(body).toMatchObject({
          players: expect.any(Array),
          total_matching: expect.any(Number),
        });
        expect(
          body.players.length,
          "ARG roster MUST contain exactly 2 players (Messi + Álvarez)",
        ).toBe(2);
        expect(body.total_matching).toBe(2);

        const ids = body.players.map((p) => p.id).sort();
        expect(ids).toEqual([MESSI_ID, ALVAREZ_ID].sort());

        for (const p of body.players) {
          expect(p.team_id).toBe(ARG_ID);
          expect(p.team_short_code).toBe("ARG");
        }
      },
    );
  },
);
