// --------------------------------------------------------------------------
// Slice 002 / T013 — `GET /api/matches` pagination Playwright spec.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) pagination behavior.
//
// Source of truth: `specs/002-match-catalog/contracts/match-catalog.read.md`
// § Query parameters table + § Test surface
// (`slice-002-catalog-pagination.spec.ts` row).
//
// Fixture under test: 8 matches (`supabase/seed/slice-002-fixture.sql`).
// Default sort is `kickoff_utc_asc` (contract); the deterministic order is:
//   page 1 (page_size=3): M1 (06-11), M2 (06-12), M5 (06-13)
//   page 2 (page_size=3): M6 (06-14), M3 (06-16), M4 (06-17)
//   page 3 (page_size=3): M7 (06-18), M8 (06-19)
//
// Then-clauses:
//   1. ?page_size=3                     → 3 rows + page=1 + page_size=3 + total=8
//   2. ?page_size=3&page=2              → next 3 rows + page=2 + page_size=3 + total=8
//   3. No overlap between page 1 and page 2 (deterministic order, no
//      row appears on both pages).
//   4. The 2 pages combined contain 6 distinct match IDs, all from the
//      8-row fixture.
//   5. Within each page, kickoff_utc is non-decreasing.
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
// Persona — alpha@nortal.com is the eligible fixture row.
// --------------------------------------------------------------------------
const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

// --------------------------------------------------------------------------
// Local contract types.
// --------------------------------------------------------------------------
interface MatchShape {
  id: string;
  kickoff_utc: string;
  [k: string]: unknown;
}

interface MatchCatalogResponse {
  matches: MatchShape[];
  page: number;
  page_size: number;
  total: number;
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US1 — GET /api/matches pagination @slice-002 @us1", () => {
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

  // ------------------------------------------------------------------------
  // Page 1: ?page_size=3
  // ------------------------------------------------------------------------
  test(
    "?page_size=3 returns the first 3 matches with total=8 @slice-002 @us1",
    async ({ request }) => {
      const response = await request.get("/api/matches?page_size=3");
      expect(response.status(), "200 for valid page_size").toBe(200);

      const body = (await response.json()) as MatchCatalogResponse;
      expect(body.matches.length, "page_size=3 → exactly 3 rows").toBe(3);
      expect(body.page, "default page is 1").toBe(1);
      expect(body.page_size, "page_size echoes the requested value").toBe(3);
      expect(body.total, "total MUST equal the fixture row count").toBe(8);

      // Non-decreasing kickoff_utc within the page (default sort).
      for (let i = 1; i < body.matches.length; i++) {
        const prev = Date.parse(body.matches[i - 1]!.kickoff_utc);
        const curr = Date.parse(body.matches[i]!.kickoff_utc);
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    },
  );

  // ------------------------------------------------------------------------
  // Page 2: ?page_size=3&page=2 → distinct from page 1
  // ------------------------------------------------------------------------
  test(
    "?page_size=3&page=2 returns the next 3 matches with no overlap @slice-002 @us1",
    async ({ request }) => {
      const r1 = await request.get("/api/matches?page_size=3&page=1");
      expect(r1.status(), "200 for page=1").toBe(200);
      const body1 = (await r1.json()) as MatchCatalogResponse;

      const r2 = await request.get("/api/matches?page_size=3&page=2");
      expect(r2.status(), "200 for page=2").toBe(200);
      const body2 = (await r2.json()) as MatchCatalogResponse;

      // Page 2 must be 3 rows.
      expect(body2.matches.length, "page=2 page_size=3 → 3 rows").toBe(3);
      expect(body2.page, "page echoes 2").toBe(2);
      expect(body2.page_size).toBe(3);
      expect(body2.total, "total stays 8 across pages").toBe(8);

      // No row should appear on both page 1 and page 2.
      const ids1 = body1.matches.map((m) => m.id);
      const ids2 = body2.matches.map((m) => m.id);
      const ids1Set = new Set(ids1);
      for (const id of ids2) {
        expect(
          ids1Set.has(id),
          `match ${id} must not appear on both page 1 and page 2`,
        ).toBe(false);
      }

      // The 6 IDs from the first two pages must all be drawn from the
      // 8-row fixture (i.e., all unique).
      const combinedIds = ids1.concat(ids2);
      const distinct = new Set(combinedIds);
      expect(distinct.size, "page 1 + page 2 yield 6 distinct rows").toBe(6);

      // Page 2 must continue the chronological order: the first row of
      // page 2 must have a kickoff_utc >= the last row of page 1
      // (default sort = kickoff_utc_asc, with id-tiebreak per contract
      // § Server-side query shape).
      const lastOfPage1 = Date.parse(body1.matches[body1.matches.length - 1]!.kickoff_utc);
      const firstOfPage2 = Date.parse(body2.matches[0]!.kickoff_utc);
      expect(
        firstOfPage2,
        "page 2 must continue the kickoff_utc_asc order from page 1",
      ).toBeGreaterThanOrEqual(lastOfPage1);

      // Non-decreasing within page 2.
      for (let i = 1; i < body2.matches.length; i++) {
        const prev = Date.parse(body2.matches[i - 1]!.kickoff_utc);
        const curr = Date.parse(body2.matches[i]!.kickoff_utc);
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    },
  );
});
