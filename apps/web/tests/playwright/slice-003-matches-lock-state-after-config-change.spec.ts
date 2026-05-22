// --------------------------------------------------------------------------
// Slice 003 / T029 — `GET /api/matches` reflects `lock_window_minutes`
// changes per SC-005 (admin config edits take effect immediately on the
// next call; predicate is STABLE within a query but re-evaluates between
// queries).
// --------------------------------------------------------------------------
// Synthetic match UUID: dddd0000-0000-0000-0000-000000000303 (kickoff = now
// + 120 min, status='scheduled'). Under the default 60-min lock_window the
// match is editable; after flipping the config to 180 min the same match
// returns 'locked'.
//
// afterEach restores lock_window_minutes to the default 60 to keep the rest
// of the suite deterministic.
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

const MATCH_ID = "dddd0000-0000-0000-0000-000000000303";

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
    kickoff_utc: new Date(Date.now() + 120 * 60 * 1000).toISOString(),
    status: "scheduled",
  });
  if (upsertErr) throw new Error(`matches upsert: ${upsertErr.message}`);
}

async function teardown(): Promise<void> {
  const supabase = getServiceClient();
  await supabase.from("predictions").delete().eq("match_id", MATCH_ID);
  await supabase.from("matches").delete().eq("id", MATCH_ID);
  // Restore default lock window in case a previous run left it modified.
  await supabase
    .from("tournament_config")
    .update({ value: 60 })
    .eq("key", "lock_window_minutes");
}

async function setLockWindowMinutes(minutes: number): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from("tournament_config")
    .update({ value: minutes })
    .eq("key", "lock_window_minutes");
  if (error) throw new Error(`lock_window_minutes update: ${error.message}`);
}

async function fetchLockState(page: any, request: any): Promise<string | undefined> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  const response = await request.get("/api/matches?page_size=200", { headers: { Cookie: cookieHeader } });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { matches: Array<{ id: string; lock_state?: string }> };
  return body.matches.find((m) => m.id === MATCH_ID)?.lock_state;
}

test.describe(
  "US4 / SC-005 — config change flips lock_state on next call @slice-003 @us4",
  () => {
    test.beforeAll(async () => { await assertOidcStubReachable(); });
    test.beforeEach(async () => {
      await resetStub();
      await teardown();
      await setupMatch();
      // Ensure baseline config (idempotent).
      await setLockWindowMinutes(60);
    });
    test.afterEach(async () => {
      await teardown();
      await resetStub();
    });

    test("flipping lock_window_minutes 60 → 180 → 60 toggles lock_state", async ({ page, request }) => {
      await signInWithIdentity(page, { claims: { sub: ALPHA.sub, email: ALPHA.email, email_verified: ALPHA.email_verified, name: ALPHA.name } });

      // Step 1: default 60-min window. Match is 120 min out → editable.
      const before = await fetchLockState(page, request);
      expect(before, "before config change with 60-min window, 120-min-out match must be 'editable'").toBe("editable");

      // Step 2: flip to 180-min window. Match is 120 min out → locked.
      await setLockWindowMinutes(180);
      // Brief defensive wait in case any caching layer needs to refresh.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = await fetchLockState(page, request);
      expect(after, "after flipping window to 180 min, 120-min-out match must be 'locked'").toBe("locked");

      // Step 3: restore.
      await setLockWindowMinutes(60);
      const restored = await fetchLockState(page, request);
      expect(restored, "after restoring window to 60 min, match must be 'editable' again").toBe("editable");
    });
  },
);
