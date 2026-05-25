// --------------------------------------------------------------------------
// Slice 002 / T013 — `GET /api/matches` filter dimensions Playwright spec.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) Acceptance Scenarios 1 + the
// FR-012 filter set (stage, group, date window, team).
//
// Source of truth: `specs/002-match-catalog/contracts/match-catalog.read.md`
// § Query parameters + § Test surface (`slice-002-catalog-filters.spec.ts`).
//
// Fixture under test: `supabase/seed/slice-002-fixture.sql` — 8 matches,
// all stage='group':
//   Group A:
//     M1 ARG-MEX  finished     2026-06-11T20:00:00Z
//     M2 CAN-POL  in_progress  2026-06-12T20:00:00Z
//     M3 ARG-CAN  scheduled    2026-06-16T20:00:00Z
//     M4 MEX-POL  scheduled    2026-06-17T20:00:00Z
//   Group B:
//     M5 ESP-BRA  scheduled    2026-06-13T20:00:00Z
//     M6 USA-JPN  scheduled    2026-06-14T20:00:00Z
//     M7 ESP-USA  scheduled    2026-06-18T20:00:00Z
//     M8 BRA-JPN  scheduled    2026-06-19T20:00:00Z
//
// Six filter dimensions, one test each:
//   1. ?stage=group           → all 8 (fixture is entirely group stage)
//   2. ?status=finished       → 1 (M1 ARG-MEX)
//   3. ?status=in_progress    → 1 (M2 CAN-POL)
//   4. ?team_id=<ARG-uuid>    → 2 (M1 ARG-MEX, M3 ARG-CAN)
//   5. ?from=2026-06-13&to=2026-06-18 → 4 (M5, M6, M3, M4)
//   6. ?group=A               → 4 (M1, M2, M3, M4)
//
// Per the user brief and contract robustness guidance, the ARG team UUID
// is resolved at runtime via service-role using `short_code='ARG'` rather
// than hardcoded — making the test resilient to a future fixture UUID
// refactor (D-006 schema reconciliation already touched these tables once).
//
// RED until T016 (the `/api/matches` route handler) lands.
// --------------------------------------------------------------------------

import { test, expect, type Page } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

/**
 * Build a `Cookie:` header from the signed-in page's cookie jar so bare
 * `request` calls inherit the Supabase session set by signInWithIdentity.
 * See specs/001-eligibility-login/follow-up-test-cookie-forwarding-after-keycloak.md.
 */
async function buildCookieHeader(page: Page): Promise<{ Cookie: string }> {
  const cookies = await page.context().cookies();
  return { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}

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
// Local contract types (mirror contracts/match-catalog.read.md § Response).
// --------------------------------------------------------------------------
interface TeamShape {
  id: string;
  name: string;
  short_code: string;
  flag_url: string | null;
}

interface MatchShape {
  id: string;
  home_team: TeamShape;
  away_team: TeamShape;
  stage: string;
  group_id: string | null;
  kickoff_utc: string;
  venue: string | null;
  status: string;
  match_result: unknown;
}

interface MatchCatalogResponse {
  matches: MatchShape[];
  page: number;
  page_size: number;
  total: number;
}

// Fixture match UUIDs — used to assert filtered subsets by membership.
const M1_ARG_MEX = "bbbb0000-0000-0000-0000-000000000001";
const M2_CAN_POL = "bbbb0000-0000-0000-0000-000000000002";
const M3_ARG_CAN = "bbbb0000-0000-0000-0000-000000000003";
const M4_MEX_POL = "bbbb0000-0000-0000-0000-000000000004";
const M5_ESP_BRA = "bbbb0000-0000-0000-0000-000000000005";
const M6_USA_JPN = "bbbb0000-0000-0000-0000-000000000006";

/**
 * Resolves the deterministic team UUID by short_code via the service-role
 * client. Used by the team_id-filter test so the assertion does not bake
 * in the fixture's specific UUID layout.
 */
async function resolveTeamIdByShortCode(shortCode: string): Promise<string> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("teams")
    .select("id")
    .eq("short_code", shortCode)
    .maybeSingle();
  if (error) {
    throw new Error(
      `resolveTeamIdByShortCode(${shortCode}): ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(
      `resolveTeamIdByShortCode(${shortCode}): no row found — fixture missing?`,
    );
  }
  return data.id as string;
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US1 — GET /api/matches filters @slice-002 @us1", () => {
  test.beforeAll(async () => {
    await assertOidcStubReachable();
  });

  test.beforeEach(async ({ page }) => {
    await resetStub();
    // Every filter test signs in as the same eligible alpha persona — the
    // catalog endpoint is participant-bound, not admin-bound, so reusing
    // the persona across tests keeps each test cheap and isolated.
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
  // Filter 1 — ?stage=group → all 8 (fixture is entirely group-stage)
  // ------------------------------------------------------------------------
  test(
    "?stage=group returns all 8 slice-002 rows (fixture is entirely group-stage) @slice-002 @us1",
    async ({ page, request }) => {
      const response = await request.get("/api/matches?stage=group", {
        headers: await buildCookieHeader(page),
      });
      expect(response.status(), "200 for valid stage filter").toBe(200);

      const body = (await response.json()) as MatchCatalogResponse;
      // Filter to slice-002 namespace — other slices add to the matches
      // table (e.g., slice-005's eeee0050-* finished matches).
      const slice002 = body.matches.filter((m) => m.id.startsWith("bbbb0000-"));
      expect(slice002.length, "slice-002 contributes exactly 8 matches").toBe(8);
      expect(
        body.total,
        "total includes slice-002 (>=8); other slices may add more",
      ).toBeGreaterThanOrEqual(8);
      for (const m of body.matches) {
        expect(m.stage).toBe("group");
      }
    },
  );

  // ------------------------------------------------------------------------
  // Filter 2 — ?status=finished → 1 (M1 ARG-MEX)
  // ------------------------------------------------------------------------
  test(
    "?status=finished returns M1 (ARG-MEX) among the finished matches @slice-002 @us1",
    async ({ page, request }) => {
      const response = await request.get("/api/matches?status=finished", {
        headers: await buildCookieHeader(page),
      });
      expect(response.status(), "200 for valid status filter").toBe(200);

      const body = (await response.json()) as MatchCatalogResponse;
      // Filter to slice-002 namespace — slice-005 adds finished matches too
      // (eeee0050-*), so the global count is no longer slice-002-specific.
      const slice002Finished = body.matches.filter((m) =>
        m.id.startsWith("bbbb0000-"),
      );
      expect(
        slice002Finished.length,
        "slice-002 contributes exactly 1 finished match (M1 ARG-MEX)",
      ).toBe(1);

      const m = slice002Finished[0]!;
      expect(m.id).toBe(M1_ARG_MEX);
      expect(m.status).toBe("finished");
      expect(m.home_team.short_code).toBe("ARG");
      expect(m.away_team.short_code).toBe("MEX");
    },
  );

  // ------------------------------------------------------------------------
  // Filter 3 — ?status=in_progress → 1 (M2 CAN-POL)
  // ------------------------------------------------------------------------
  test(
    "?status=in_progress returns M2 (CAN-POL) among the in_progress matches @slice-002 @us1",
    async ({ page, request }) => {
      const response = await request.get("/api/matches?status=in_progress", {
        headers: await buildCookieHeader(page),
      });
      expect(response.status(), "200 for valid status filter").toBe(200);

      const body = (await response.json()) as MatchCatalogResponse;
      // Filter to slice-002 namespace.
      const slice002InProgress = body.matches.filter((m) =>
        m.id.startsWith("bbbb0000-"),
      );
      expect(
        slice002InProgress.length,
        "slice-002 contributes exactly 1 in_progress match (M2 CAN-POL)",
      ).toBe(1);

      const m = slice002InProgress[0]!;
      expect(m.id).toBe(M2_CAN_POL);
      expect(m.status).toBe("in_progress");
      expect(m.home_team.short_code).toBe("CAN");
      expect(m.away_team.short_code).toBe("POL");
    },
  );

  // ------------------------------------------------------------------------
  // Filter 4 — ?team_id=<ARG> → 2 (M1 ARG-MEX, M3 ARG-CAN)
  // ------------------------------------------------------------------------
  test(
    "?team_id=<ARG> returns the 2 slice-002 matches Argentina appears in @slice-002 @us1",
    async ({ page, request }) => {
      const argTeamId = await resolveTeamIdByShortCode("ARG");

      const response = await request.get(
        `/api/matches?team_id=${encodeURIComponent(argTeamId)}`,
        { headers: await buildCookieHeader(page) },
      );
      expect(response.status(), "200 for valid team_id filter").toBe(200);

      const body = (await response.json()) as MatchCatalogResponse;
      // Filter to slice-002 namespace — team_id is global (shared across
      // slices via the teams table), so slice-005 ARG matches appear here too.
      const slice002Arg = body.matches.filter((m) =>
        m.id.startsWith("bbbb0000-"),
      );
      expect(
        slice002Arg.length,
        "ARG plays in exactly 2 slice-002 fixture matches (M1, M3)",
      ).toBe(2);

      // Membership assertion — the two slice-002 IDs must be exactly M1 and M3.
      const returnedIds = slice002Arg.map((m) => m.id).sort();
      expect(returnedIds).toEqual([M1_ARG_MEX, M3_ARG_CAN].sort());

      // Every returned row in the global response MUST include ARG on either
      // side (home OR away) — the filter holds across all slices.
      for (const m of body.matches) {
        const arg = m.home_team.short_code === "ARG" || m.away_team.short_code === "ARG";
        expect(arg, `match ${m.id} must involve ARG`).toBe(true);
      }
    },
  );

  // ------------------------------------------------------------------------
  // Filter 5 — ?from=2026-06-13&to=2026-06-18 → 4
  // (half-open window: >= from, < to; covers M5, M6, M3, M4)
  // ------------------------------------------------------------------------
  test(
    "?from + ?to half-open window returns matches within [from, to) @slice-002 @us1",
    async ({ page, request }) => {
      const from = "2026-06-13T00:00:00Z";
      const to = "2026-06-18T00:00:00Z";

      const response = await request.get(
        `/api/matches?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { headers: await buildCookieHeader(page) },
      );
      expect(response.status(), "200 for valid date window").toBe(200);

      const body = (await response.json()) as MatchCatalogResponse;

      // Filter to slice-002 namespace — slice-005 may also have matches in
      // the same date window.
      const slice002Window = body.matches.filter((m) =>
        m.id.startsWith("bbbb0000-"),
      );

      // Window covers: M5 (06-13), M6 (06-14), M3 (06-16), M4 (06-17) = 4 rows.
      // Excludes:      M1 (06-11), M2 (06-12) [< from], M7 (06-18) [>= to, exclusive], M8 (06-19).
      expect(
        slice002Window.length,
        "exactly 4 slice-002 matches fall in the window",
      ).toBe(4);

      const returnedIds = slice002Window.map((m) => m.id).sort();
      expect(returnedIds).toEqual(
        [M5_ESP_BRA, M6_USA_JPN, M3_ARG_CAN, M4_MEX_POL].sort(),
      );

      // Every returned kickoff MUST satisfy `kickoff_utc >= from && < to`.
      // This invariant holds across all slices, not just slice-002.
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      for (const m of body.matches) {
        const k = Date.parse(m.kickoff_utc);
        expect(k, `${m.id} kickoff in window`).toBeGreaterThanOrEqual(fromMs);
        expect(k, `${m.id} kickoff strictly less than to (half-open)`).toBeLessThan(toMs);
      }
    },
  );

  // ------------------------------------------------------------------------
  // Filter 6 — ?group=A → 4 (Group A pairings M1–M4)
  // ------------------------------------------------------------------------
  test(
    "?group=A returns the 4 slice-002 Group A matches @slice-002 @us1",
    async ({ page, request }) => {
      const response = await request.get("/api/matches?group=A", {
        headers: await buildCookieHeader(page),
      });
      expect(response.status(), "200 for valid group filter").toBe(200);

      const body = (await response.json()) as MatchCatalogResponse;
      // Filter to slice-002 namespace — slice-005 also has Group A matches.
      const slice002GroupA = body.matches.filter((m) =>
        m.id.startsWith("bbbb0000-"),
      );
      expect(
        slice002GroupA.length,
        "slice-002 contributes 4 Group A matches",
      ).toBe(4);

      const returnedIds = slice002GroupA.map((m) => m.id).sort();
      expect(returnedIds).toEqual(
        [M1_ARG_MEX, M2_CAN_POL, M3_ARG_CAN, M4_MEX_POL].sort(),
      );

      // group_id=A invariant holds for every row in the response, not just
      // slice-002's contribution.
      for (const m of body.matches) {
        expect(m.group_id, `match ${m.id} must be group A`).toBe("A");
      }
    },
  );
});
