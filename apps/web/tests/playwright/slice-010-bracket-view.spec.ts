// --------------------------------------------------------------------------
// Slice 010 / T014 — US1 "View all teams with flags" (RED-first).
// --------------------------------------------------------------------------
// Acceptance (spec.md US1):
//   - all bracket teams render with name + flag
//   - a missing-flag team shows the fallback with accessible alt text
//   - later-round matchups show pending
//   - GET /api/bracket returns 31 matchups + status for an eligible caller
//
// Auth: signInWithIdentity (Keycloak) + forward sb-*-auth-token cookies to
// the bare `request` fixture (slice-001 cookie-forwarding follow-up).
// --------------------------------------------------------------------------

import { test, expect, type BrowserContext } from "@playwright/test";
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

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

test.describe("US1 — View bracket teams @slice-010 @us1", () => {
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
    "GET /api/bracket returns 31 matchups + status for an eligible participant @slice-010 @us1",
    async ({ page, request, context }) => {
      await signInWithIdentity(page, { claims: { ...ALPHA } });
      const res = await request.get("/api/bracket", {
        headers: { Cookie: await cookieHeader(context) },
      });
      expect(res.status(), "eligible GET /api/bracket MUST be 200").toBe(200);
      const body = (await res.json()) as {
        matchups: Array<{ round: string; team_a: unknown; team_b: unknown }>;
        status: { total_required: number };
      };
      expect(body.matchups.length, "31 matchups total").toBe(31);
      expect(body.status.total_required, "31 required picks").toBe(31);
      expect(
        body.matchups.filter((m) => m.round === "r32").length,
        "16 R32 matchups",
      ).toBe(16);
      // R32 matchups have both competitors resolved (seeded).
      const r32 = body.matchups.filter((m) => m.round === "r32");
      expect(r32.every((m) => m.team_a && m.team_b), "every R32 matchup has both teams").toBe(true);
    },
  );

  test(
    "the /bracket page renders all R32 teams with flags, a fallback for the missing flag, and pending later rounds @slice-010 @us1",
    async ({ page }) => {
      await signInWithIdentity(page, { claims: { ...ALPHA } });
      await page.goto("/bracket");

      // 16 R32 matchups rendered.
      const r32 = page.locator('[data-testid="bracket-matchup"][data-round="r32"]');
      await expect(r32.first()).toBeVisible({ timeout: 10_000 });
      expect(await r32.count(), "16 R32 matchups on the page").toBe(16);

      // A known seeded team renders by name.
      await expect(page.getByText("France", { exact: true }).first()).toBeVisible();

      // Iran (seeded with NULL flag) shows the fallback with the unavailable alt text.
      await expect(
        page.getByLabel("Flag unavailable for Iran").first(),
        "missing-flag team shows fallback with alt text",
      ).toBeVisible();

      // Later rounds show pending placeholders (no resolved competitors yet for an empty bracket — alpha has only 3 R32 picks in the fixture).
      const pending = page.locator('[data-testid="bracket-pending-slot"]');
      expect(await pending.count(), "later-round pending slots are present").toBeGreaterThan(0);
    },
  );
});
