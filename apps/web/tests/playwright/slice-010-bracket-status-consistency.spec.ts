// --------------------------------------------------------------------------
// Slice 010 / T037 — US5 "Consistent status from one source".
// --------------------------------------------------------------------------
// SC-004 / FR-014,FR-015: after a single pick, the header progress, the mobile
// sticky footer, the status badge, the submit-button state, and the review
// screen all reflect identical completed/required counts and the same
// submission state — because they all derive from the one bracket_status shape.
// charlie persona (clean slate); cookie-forwarded auth.
// --------------------------------------------------------------------------

import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { assertOidcStubReachable, resetStub, signInWithIdentity } from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

test.describe.configure({ mode: "serial" });

const CHARLIE = { sub: "00000000-0000-0000-0000-00000000000c", email: "charlie@nortal.com", email_verified: true, name: "Charlie Tester" } as const;
const CHARLIE_PID = "33333333-3333-3333-3333-333333333333";
const R32_1 = "dddd0032-0000-0000-0000-000000000001";
const FRANCE = "cccc0010-0000-0000-0000-000000000001";

async function hdr(context: BrowserContext): Promise<{ Cookie: string }> {
  const cookies = await context.cookies();
  return { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}
async function pick(request: APIRequestContext, h: { Cookie: string }, matchup: string, winner: string) {
  return request.post("/api/bracket/pick", {
    headers: { ...h, "Content-Type": "application/json" },
    data: { matchup_id: matchup, winner_team_id: winner },
  });
}

test.beforeAll(async () => { await assertOidcStubReachable(); });
test.beforeEach(async () => {
  await resetStub();
  await getServiceClient().from("bracket_picks").delete().eq("participant_id", CHARLIE_PID);
  await getServiceClient().from("bracket_submissions").delete().eq("participant_id", CHARLIE_PID);
});
test.afterEach(async () => {
  await getServiceClient().from("bracket_picks").delete().eq("participant_id", CHARLIE_PID);
  await getServiceClient().from("bracket_submissions").delete().eq("participant_id", CHARLIE_PID);
  await resetStub();
});

test("AS1 — after one pick every surface shows identical counts + state @slice-010 @us5", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);

  // Make a single pick server-side, then load each surface fresh.
  const r = await pick(request, h, R32_1, FRANCE);
  expect(r.status()).toBe(200);

  await page.goto("/bracket");

  // Header + mobile footer derive from the same status → identical "1 of 31".
  await expect(page.getByTestId("bracket-progress")).toContainText("1 of 31");
  await expect(page.getByTestId("bracket-mobile-progress")).toContainText("1 of 31");

  // Status badge reflects draft (incomplete, unsubmitted).
  await expect(page.getByTestId("bracket-status-badge").first()).toHaveAttribute("data-status", "draft");

  // Submit is disabled while incomplete (header instance).
  await expect(page.getByTestId("bracket-submit").first()).toBeDisabled();

  // Review screen shows the SAME count + state from the one source.
  await page.goto("/bracket/review");
  await expect(page.getByTestId("bracket-progress")).toContainText("1 of 31");
  await expect(page.getByTestId("bracket-status-badge").first()).toHaveAttribute("data-status", "draft");
});
