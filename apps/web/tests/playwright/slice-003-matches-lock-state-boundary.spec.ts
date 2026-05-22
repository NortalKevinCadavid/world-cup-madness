// --------------------------------------------------------------------------
// Slice 003 / T029 — `GET /api/matches` returns lock_state='locked' at the
// EXACT lock boundary (kickoff = now + lock_window_minutes). Per BR-LOCK-002
// the predicate is strict `>=`, so an exactly-at-boundary match is locked.
// --------------------------------------------------------------------------
// Synthetic match UUID: dddd0000-0000-0000-0000-000000000302 (kickoff = now
// + 60min — the exact boundary).
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const MATCH_ID = "dddd0000-0000-0000-0000-000000000302";

interface TeamRow { id: string; short_code: string; }

async function setupMatch(): Promise<void> {
  const supabase = getServiceClient();
  const { data: teams, error } = await supabase
    .from("teams")
    .select("id, short_code")
    .order("short_code", { ascending: true })
    .limit(2);
  if (error) throw new Error(`teams lookup: ${error.message}`);
  const rows = (teams ?? []) as TeamRow[];
  if (!rows[0]?.id || !rows[1]?.id) throw new Error("teams fixture missing");

  const { error: upsertErr } = await supabase.from("matches").upsert({
    id: MATCH_ID,
    home_team_id: rows[0].id,
    away_team_id: rows[1].id,
    stage: "group",
    group_id: "A",
    kickoff_utc: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: "scheduled",
  });
  if (upsertErr) throw new Error(`matches upsert: ${upsertErr.message}`);
}

async function teardown(): Promise<void> {
  const supabase = getServiceClient();
  await supabase.from("predictions").delete().eq("match_id", MATCH_ID);
  await supabase.from("matches").delete().eq("id", MATCH_ID);
}

test.describe(
  "US4 — /api/matches lock_state='locked' at EXACT boundary (BR-LOCK-002 strict >=) @slice-003 @us4",
  () => {
    test.beforeAll(async () => { await assertOidcStubReachable(); });
    test.beforeEach(async () => {
      await resetStub();
      await teardown();
      await setupMatch();
    });
    test.afterEach(async () => {
      await teardown();
      await resetStub();
    });

    test("synthetic match at exact 60-min boundary returns lock_state='locked'", async ({ page, request }) => {
      await signInWithIdentity(page, { claims: { sub: ALPHA.sub, email: ALPHA.email, email_verified: ALPHA.email_verified, name: ALPHA.name } });
      const cookies = await page.context().cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      const response = await request.get("/api/matches?page_size=200", { headers: { Cookie: cookieHeader } });
      expect(response.status()).toBe(200);

      const body = (await response.json()) as { matches: Array<{ id: string; lock_state?: string }> };
      const match = body.matches.find((m) => m.id === MATCH_ID);
      expect(match).toBeDefined();
      expect(match?.lock_state, "exact-boundary match MUST be 'locked' (BR-LOCK-002 strict >=)").toBe("locked");
    });
  },
);
