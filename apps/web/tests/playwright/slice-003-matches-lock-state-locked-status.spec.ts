// --------------------------------------------------------------------------
// Slice 003 / T029 — `GET /api/matches` returns lock_state='locked' for
// matches with non-scheduled status (BR-LOCK-004 status branch).
// --------------------------------------------------------------------------
// Uses EXISTING fixture matches — no synthetic setup needed:
//   M1 ARG-MEX finished    `bbbb0000-0000-0000-0000-000000000001`
//   M2 CAN-POL in_progress `bbbb0000-0000-0000-0000-000000000002`
// Both MUST return lock_state='locked' regardless of kickoff time.
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

const M1_FINISHED = "bbbb0000-0000-0000-0000-000000000001";
const M2_IN_PROGRESS = "bbbb0000-0000-0000-0000-000000000002";

async function fetchMatches(page: any, request: any) {
  await signInWithIdentity(page, { claims: { sub: ALPHA.sub, email: ALPHA.email, email_verified: ALPHA.email_verified, name: ALPHA.name } });
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  const response = await request.get("/api/matches?page_size=200", { headers: { Cookie: cookieHeader } });
  expect(response.status()).toBe(200);
  return (await response.json()) as { matches: Array<{ id: string; lock_state?: string; status?: string }> };
}

test.describe(
  "US4 — /api/matches lock_state='locked' by status (BR-LOCK-004) @slice-003 @us4",
  () => {
    test.beforeAll(async () => { await assertOidcStubReachable(); });
    test.beforeEach(async () => { await resetStub(); });
    test.afterEach(async () => { await resetStub(); });

    test("M1 (finished) returns lock_state='locked'", async ({ page, request }) => {
      const body = await fetchMatches(page, request);
      const m1 = body.matches.find((m) => m.id === M1_FINISHED);
      expect(m1, "M1 must be in catalog").toBeDefined();
      expect(m1?.status).toBe("finished");
      expect(m1?.lock_state, "finished match must be 'locked' regardless of kickoff").toBe("locked");
    });

    test("M2 (in_progress) returns lock_state='locked'", async ({ page, request }) => {
      const body = await fetchMatches(page, request);
      const m2 = body.matches.find((m) => m.id === M2_IN_PROGRESS);
      expect(m2).toBeDefined();
      expect(m2?.status).toBe("in_progress");
      expect(m2?.lock_state, "in_progress match must be 'locked'").toBe("locked");
    });
  },
);
