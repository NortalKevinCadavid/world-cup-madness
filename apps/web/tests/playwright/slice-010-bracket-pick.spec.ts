// --------------------------------------------------------------------------
// Slice 010 / T018 — US2 "Build the bracket by selecting winners".
// --------------------------------------------------------------------------
// Per contracts/bracket.pick.write.md. Uses charlie (no fixture bracket picks
// → clean slate). Cookie-forwarded auth (slice-001 follow-up). Serial so the
// pick mutations don't interleave.
// --------------------------------------------------------------------------

import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { assertOidcStubReachable, resetStub, signInWithIdentity } from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

test.describe.configure({ mode: "serial" });

const CHARLIE = {
  sub: "00000000-0000-0000-0000-00000000000c",
  email: "charlie@nortal.com",
  email_verified: true,
  name: "Charlie Tester",
} as const;
const CHARLIE_PID = "33333333-3333-3333-3333-333333333333";

// Fixture UUIDs (supabase/seed/slice-010-fixture.sql).
const R32_1 = "dddd0032-0000-0000-0000-000000000001"; // France vs Germany → R16#1 slot A
const R32_2 = "dddd0032-0000-0000-0000-000000000002"; // England vs Portugal → R16#1 slot B
const R16_1 = "dddd0016-0000-0000-0000-000000000001";
const R16_8 = "dddd0016-0000-0000-0000-000000000008"; // pending (no upstream picks)
const FRANCE = "cccc0010-0000-0000-0000-000000000001";
const GERMANY = "cccc0010-0000-0000-0000-000000000002";
const ENGLAND = "cccc0010-0000-0000-0000-000000000003";
const ITALY = "cccc0010-0000-0000-0000-000000000007"; // NOT in R32#1

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
  // Clean charlie's bracket picks for a deterministic start.
  await getServiceClient().from("bracket_picks").delete().eq("participant_id", CHARLIE_PID);
});
test.afterEach(async () => {
  await getServiceClient().from("bracket_picks").delete().eq("participant_id", CHARLIE_PID);
  await resetStub();
});

test("AS1 — a valid R32 winner advances into the dependent R16 matchup @slice-010 @us2", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);

  const r = await pick(request, h, R32_1, FRANCE);
  expect(r.status(), "valid R32 pick → 200").toBe(200);

  const read = await request.get("/api/bracket", { headers: h });
  const body = (await read.json()) as { matchups: Array<{ id: string; team_a: { id: string } | null }> };
  const r16 = body.matchups.find((m) => m.id === R16_1)!;
  expect(r16.team_a?.id, "R16#1 slot A resolves to the R32#1 winner (France)").toBe(FRANCE);
});

test("AS2 — changing an upstream winner clears the now-impossible downstream pick @slice-010 @us2", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);

  await pick(request, h, R32_1, FRANCE);   // R16#1 slot A = France
  await pick(request, h, R32_2, ENGLAND);  // R16#1 slot B = England
  const r16Pick = await pick(request, h, R16_1, FRANCE); // valid now
  expect(r16Pick.status(), "R16#1 winner France is valid").toBe(200);

  // Change R32#1 to Germany → R16#1 becomes {Germany, England}; France impossible.
  const change = await pick(request, h, R32_1, GERMANY);
  expect(change.status()).toBe(200);
  const changeBody = (await change.json()) as { cleared_matchup_ids: string[]; status: { completed: number } };
  expect(changeBody.cleared_matchup_ids, "R16#1 pick is cleared by the cascade").toContain(R16_1);
});

test("AS3 — a matchup with unresolved competitors is not ready @slice-010 @us2", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);
  const r = await pick(request, h, R16_8, FRANCE); // pos8 has no upstream picks
  expect(r.status(), "picking a pending matchup → 409 MATCHUP_NOT_READY").toBe(409);
  expect((await r.json()).error.code).toBe("MATCHUP_NOT_READY");
});

test("AS4 — a winner that is not a competitor is rejected @slice-010 @us2", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);
  const r = await pick(request, h, R32_1, ITALY); // Italy not in R32#1
  expect(r.status(), "non-competitor winner → 422 INVALID_WINNER").toBe(422);
  expect((await r.json()).error.code).toBe("INVALID_WINNER");
});

test("AS5 — picks are rejected after the lock deadline @slice-010 @us2", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);
  const svc = getServiceClient();
  const { data: orig } = await svc.from("tournament_config").select("value").eq("key", "first_kickoff_utc").single();
  try {
    await svc.from("tournament_config").update({ value: "2020-01-01T00:00:00Z" }).eq("key", "first_kickoff_utc");
    const r = await pick(request, h, R32_1, FRANCE);
    expect(r.status(), "pick after lock → 409 BRACKET_LOCKED").toBe(409);
    expect((await r.json()).error.code).toBe("BRACKET_LOCKED");
  } finally {
    await svc.from("tournament_config").update({ value: orig!.value }).eq("key", "first_kickoff_utc");
  }
});
