// --------------------------------------------------------------------------
// Slice 002 / T013 — `GET /api/matches` 200 happy-path Playwright spec.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) Acceptance Scenario 1:
// "Sign in eligible; GET /api/matches; assert 200 + body matches seed fixture".
//
// Source of truth: `specs/002-match-catalog/contracts/match-catalog.read.md`
// § Response 200 OK + § Test surface.
//
// Fixture under test: `supabase/seed/slice-002-fixture.sql`
//   - 8 teams (Groups A + B)
//   - 8 matches, all stage='group'
//   - 6 scheduled + 1 in_progress (M2 CAN-POL) + 1 finished (M1 ARG-MEX)
//   - 1 match_results row for M1 (ARG 2-0 MEX, regulation result)
//
// Then-clauses asserted here:
//   1. Status code exactly 200.
//   2. Body shape per contract: { matches: [...], page, page_size, total }.
//   3. Exactly 8 matches returned; `total === 8`.
//   4. Pagination defaults: `page === 1`, `page_size === 50`.
//   5. Every match row has the contract-required keys (id, home_team,
//      away_team, stage, group_id, kickoff_utc, venue, status, match_result).
//   6. Nested team objects have id, name, short_code, flag_url.
//   7. Chronological order: kickoff_utc ascending (contract § default sort).
//   8. The 7 non-finished matches have `match_result: null`.
//   9. M1 (ARG-MEX, finished) has `match_result` populated with
//      home_score_official=2, away_score_official=0, result_status='regulation'.
//
// Spec deviation note (D-T013-001): the original tasks.md prompt body
// (line 572) referenced "4 matches" and a penalty_shootout result. The
// actual T012 fixture seeds 8 matches with a regulation result on M1.
// Tests are written against the actual fixture per the user brief.
//
// Spec deviation note (D-T013-002): the contract example payload uses
// `home_score_official` / `away_score_official` field names on the
// `match_result` object. The fixture's `match_results` table columns are
// `home_score` / `away_score`. The route handler (T016) is expected to
// alias these on the way out; this spec asserts the CONTRACT field names.
//
// RED until T016 (the `/api/matches` route handler) lands.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

// --------------------------------------------------------------------------
// Persona — alpha@nortal.com is the eligible fixture row from slice-001.
// --------------------------------------------------------------------------
const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

// --------------------------------------------------------------------------
// Local contract types (mirror contracts/match-catalog.read.md § Response).
// Declared locally so the spec does not depend on the not-yet-shipped
// `apps/web/lib/types/match.ts` module.
// --------------------------------------------------------------------------
interface TeamShape {
  id: string;
  name: string;
  short_code: string;
  flag_url: string | null;
}

interface MatchResultShape {
  home_score_official: number;
  away_score_official: number;
  home_score_for_scoring: number;
  away_score_for_scoring: number;
  result_status:
    | "regulation"
    | "extra_time"
    | "penalties_shootout"
    | string;
  approved_at: string | null;
}

interface MatchShape {
  id: string;
  home_team: TeamShape;
  away_team: TeamShape;
  stage: "group" | "r16" | "qf" | "sf" | "final" | "third_place";
  group_id: string | null;
  kickoff_utc: string;
  venue: string | null;
  status: "scheduled" | "in_progress" | "finished" | "postponed" | "cancelled";
  match_result: MatchResultShape | null;
}

interface MatchCatalogResponse {
  matches: MatchShape[];
  page: number;
  page_size: number;
  total: number;
}

// Fixture's deterministic UUID for M1 (ARG vs MEX, finished).
const M1_ARG_MEX_ID = "bbbb0000-0000-0000-0000-000000000001";

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US1 — GET /api/matches returns the seeded catalog @slice-002 @us1", () => {
  test.beforeAll(async () => {
    await assertOidcStubReachable();
  });

  test.beforeEach(async () => {
    await resetStub();
  });

  test.afterEach(async () => {
    await resetStub();
  });

  test(
    "Eligible participant receives all 8 fixture matches with contract body shape @slice-002 @us1",
    async ({ page, request, context }) => {
      // Sign in as alpha — an eligible @nortal.com fixture identity.
      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA.sub,
          email: ALPHA.email,
          email_verified: ALPHA.email_verified,
          name: ALPHA.name,
        },
      });

      // Forward signed-in cookies to the bare `request` fixture — Keycloak/
      // PKCE migration (commit 5a74acf) put the Supabase session in cookies
      // on the page's BrowserContext, and `request` no longer shares storage.
      // See specs/001-eligibility-login/follow-up-test-cookie-forwarding-after-keycloak.md.
      const cookies = await context.cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      const response = await request.get("/api/matches", {
        headers: { Cookie: cookieHeader },
      });

      // Then 1 — status code exactly 200.
      expect(
        response.status(),
        "GET /api/matches for an eligible session MUST be 200 (contract § 200)",
      ).toBe(200);

      const body = (await response.json()) as MatchCatalogResponse;

      // Then 2 — top-level body shape.
      expect(body).toMatchObject({
        matches: expect.any(Array),
        page: expect.any(Number),
        page_size: expect.any(Number),
        total: expect.any(Number),
      });

      // Then 3 — exactly 8 matches; total === 8 (fixture row count).
      expect(
        body.matches.length,
        "fixture seeds exactly 8 matches",
      ).toBe(8);
      expect(
        body.total,
        "`total` MUST equal the fixture row count of 8",
      ).toBe(8);

      // Then 4 — pagination defaults per contract § Query parameters table.
      expect(body.page, "default page MUST be 1").toBe(1);
      expect(body.page_size, "default page_size MUST be 50").toBe(50);

      // Then 5 + 6 — every row has the contract-required keys, and the
      // nested team objects are well-formed.
      for (const m of body.matches) {
        expect(m).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            home_team: expect.objectContaining({
              id: expect.any(String),
              name: expect.any(String),
              short_code: expect.any(String),
            }),
            away_team: expect.objectContaining({
              id: expect.any(String),
              name: expect.any(String),
              short_code: expect.any(String),
            }),
            stage: expect.any(String),
            kickoff_utc: expect.any(String),
            status: expect.any(String),
          }),
        );
        // group_id is nullable but the property MUST be present.
        expect(m).toHaveProperty("group_id");
        // venue is nullable but the property MUST be present.
        expect(m).toHaveProperty("venue");
        // match_result is nullable but the property MUST be present.
        expect(m).toHaveProperty("match_result");
        // flag_url is nullable but the property MUST be present on teams.
        expect(m.home_team).toHaveProperty("flag_url");
        expect(m.away_team).toHaveProperty("flag_url");
        // kickoff_utc MUST be ISO-8601 parsable.
        expect(
          Number.isNaN(Date.parse(m.kickoff_utc)),
          `kickoff_utc "${m.kickoff_utc}" must be ISO-8601 parsable`,
        ).toBe(false);
        // The fixture is entirely group stage; every row MUST report
        // stage='group' and a non-NULL group_id (matches_group_id_consistency
        // CHECK in migration 0019).
        expect(m.stage).toBe("group");
        expect(m.group_id, "fixture rows all have group_id A or B").toMatch(/^[AB]$/);
      }

      // Then 7 — chronological order (default sort = kickoff_utc_asc).
      for (let i = 1; i < body.matches.length; i++) {
        const prev = Date.parse(body.matches[i - 1]!.kickoff_utc);
        const curr = Date.parse(body.matches[i]!.kickoff_utc);
        expect(
          curr,
          `matches[${i}].kickoff_utc must be >= matches[${i - 1}].kickoff_utc (contract default sort kickoff_utc_asc)`,
        ).toBeGreaterThanOrEqual(prev);
      }

      // Then 8 — 7 non-finished matches have match_result === null.
      const finished = body.matches.filter((m) => m.status === "finished");
      const nonFinished = body.matches.filter((m) => m.status !== "finished");
      expect(
        nonFinished.length,
        "fixture has exactly 7 non-finished matches",
      ).toBe(7);
      for (const m of nonFinished) {
        expect(
          m.match_result,
          `non-finished match ${m.id} (status=${m.status}) MUST have match_result: null`,
        ).toBeNull();
      }

      // Then 9 — M1 (ARG vs MEX, finished) has match_result populated.
      expect(finished.length, "fixture has exactly 1 finished match (M1)").toBe(1);
      const m1 = finished[0]!;
      expect(m1.id, "the finished match MUST be M1 (ARG vs MEX)").toBe(M1_ARG_MEX_ID);
      expect(m1.home_team.short_code).toBe("ARG");
      expect(m1.away_team.short_code).toBe("MEX");
      expect(m1.status).toBe("finished");

      // The match_result block — assert exact values from the fixture.
      const result = m1.match_result;
      expect(result, "finished M1 MUST have a non-null match_result").not.toBeNull();
      expect(result!.home_score_official).toBe(2);
      expect(result!.away_score_official).toBe(0);
      expect(result!.home_score_for_scoring).toBe(2);
      expect(result!.away_score_for_scoring).toBe(0);
      expect(result!.result_status).toBe("regulation");
      // approved_at is nullable in the fixture (recorded by provider_sync,
      // not an admin); the contract still requires the field to be present.
      expect(result).toHaveProperty("approved_at");
    },
  );
});
