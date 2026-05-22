// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/teams 200 path (RLS-gated team list).
// --------------------------------------------------------------------------
// RED acceptance test for the eligible-caller branch of GET /api/teams, a
// thin RLS-gated wrapper over Slice 002's `teams` table.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/teams + § Test surface — slice-004-teams-200.
//
// Scenario:
//   Sign in as alpha. GET /api/teams. Assert 200 + array of 8 fixture
//   teams (slice 002 seed) with the contract shape:
//   { id, name, short_code, flag_url }.
//
// RED until T018 ships the /api/teams handler.
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

const EXPECTED_TEAM_CODES = [
  "ARG",
  "BRA",
  "CAN",
  "ESP",
  "JPN",
  "MEX",
  "POL",
  "USA",
];

interface TeamRow {
  id: string;
  name: string;
  short_code: string;
  flag_url: string | null;
}

interface TeamsResponse {
  teams: TeamRow[];
}

test.describe(
  "US1 — GET /api/teams 200 returns the RLS-gated team list @slice-004 @us1",
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
      "alpha GET /api/teams returns the 8 slice-002 fixture teams @slice-004 @us1",
      async ({ page, request }) => {
        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        const response = await request.get("/api/teams", {
          headers: { Cookie: cookieHeader },
        });
        expect(response.status(), "GET /api/teams MUST be 200").toBe(200);

        const body = (await response.json()) as TeamsResponse;
        expect(body).toMatchObject({ teams: expect.any(Array) });
        expect(
          body.teams.length,
          "slice-002 fixture seeds exactly 8 teams (Groups A/B)",
        ).toBe(8);

        const codes = body.teams.map((t) => t.short_code).sort();
        expect(codes).toEqual(EXPECTED_TEAM_CODES);

        // Contract body shape — every entry has the documented keys.
        for (const t of body.teams) {
          expect(t).toEqual(
            expect.objectContaining({
              id: expect.any(String),
              name: expect.any(String),
              short_code: expect.any(String),
            }),
          );
          // flag_url is allowed to be null per slice 002 fixture (no CDN
          // assets shipped yet); the key MUST be present.
          expect("flag_url" in t).toBe(true);
        }
      },
    );
  },
);
