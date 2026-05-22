// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/players?q=mes 200 returns Messi (and friends).
// --------------------------------------------------------------------------
// RED acceptance test for the `q` substring-search branch of GET /api/players.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/players § Request — `q` substring match on
//     full_name (case-insensitive).
//   - slice-004-fixture.sql — Lionel Messi (player 01) full_name contains "Mes".
//
// Scenario:
//   Sign in as alpha. GET /api/players?q=mes. Assert 200 + Messi appears
//   in the result set. The contract text mentions an `aliases` column for
//   alias-substring matching; the slice-004 schema (migration 0039) ships
//   only `full_name` + `display_name` (no aliases). This test pins the
//   minimum: q='mes' MUST surface Lionel Messi via full_name substring
//   match.
//
// RED until T018 ships the /api/players handler with the q-filter.
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

const MESSI_ID = "dddd1000-0000-0000-0000-000000000001";

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
  "US1 — GET /api/players?q=mes returns at least Lionel Messi (case-insensitive substring) @slice-004 @us1",
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
      "alpha GET /api/players?q=mes returns at least Lionel Messi @slice-004 @us1",
      async ({ page, request }) => {
        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        const response = await request.get("/api/players?q=mes", {
          headers: { Cookie: cookieHeader },
        });
        expect(response.status(), "GET /api/players?q=mes MUST be 200").toBe(
          200,
        );

        const body = (await response.json()) as PlayersResponse;
        expect(body).toMatchObject({
          players: expect.any(Array),
          total_matching: expect.any(Number),
        });

        // Messi MUST appear (full_name 'Lionel Messi' contains 'mes' case-
        // insensitively).
        const messi = body.players.find((p) => p.id === MESSI_ID);
        expect(
          messi,
          "q='mes' MUST surface Lionel Messi via case-insensitive full_name substring match",
        ).toBeDefined();
        expect(messi?.full_name).toBe("Lionel Messi");
        expect(messi?.team_short_code).toBe("ARG");

        // Every returned row's full_name MUST contain 'mes' case-
        // insensitively (the contract's documented filter behavior).
        for (const p of body.players) {
          expect(
            p.full_name.toLowerCase(),
            `q='mes' filter result row ${p.id} (${p.full_name}) must contain 'mes' case-insensitively in full_name`,
          ).toContain("mes");
        }

        // total_matching MUST be >= the page length (= count(*) over the
        // filter, before LIMIT).
        expect(body.total_matching).toBeGreaterThanOrEqual(body.players.length);
        expect(body.total_matching).toBeGreaterThanOrEqual(1);
      },
    );
  },
);
