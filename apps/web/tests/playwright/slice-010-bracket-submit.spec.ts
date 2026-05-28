// --------------------------------------------------------------------------
// Slice 010 / T024 — US3 "Completion status & submission".
// --------------------------------------------------------------------------
// Per contracts/bracket.submit.write.md. charlie persona (clean slate; the
// fixture seeds no picks for them). Cookie-forwarded auth. Serial so the
// submit/edit mutations don't interleave. Server is authoritative on
// completeness, lock, idempotency, and audit.
// --------------------------------------------------------------------------

import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
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

const FINAL = "dddd0001-0000-0000-0000-000000000001";

interface MatchupRow {
  id: string;
  team_a: { id: string } | null;
  team_b: { id: string } | null;
  winner_team_id: string | null;
}
interface BracketBody {
  matchups: MatchupRow[];
  status: { completed: number; total_required: number; is_complete: boolean; submission_status: string };
}

async function hdr(context: BrowserContext): Promise<{ Cookie: string }> {
  const cookies = await context.cookies();
  return { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}
async function readBracket(request: APIRequestContext, h: { Cookie: string }): Promise<BracketBody> {
  const res = await request.get("/api/bracket", { headers: h });
  return (await res.json()) as BracketBody;
}
async function pick(request: APIRequestContext, h: { Cookie: string }, matchup: string, winner: string) {
  return request.post("/api/bracket/pick", {
    headers: { ...h, "Content-Type": "application/json" },
    data: { matchup_id: matchup, winner_team_id: winner },
  });
}
async function submit(request: APIRequestContext, h: { Cookie: string }, token = randomUUID()) {
  return request.post("/api/bracket/submit", {
    headers: { ...h, "Content-Type": "application/json" },
    data: { run_token: token },
  });
}
// Always pick team_a for every ready, unpicked matchup; round by round the
// later competitors resolve until the full 31-pick tree is filled.
async function fillBracket(
  request: APIRequestContext,
  h: { Cookie: string },
  skipMatchupId?: string,
): Promise<BracketBody> {
  for (let round = 0; round < 6; round++) {
    const b = await readBracket(request, h);
    let progressed = false;
    for (const m of b.matchups) {
      if (skipMatchupId && m.id === skipMatchupId) continue;
      if (m.team_a && m.team_b && !m.winner_team_id) {
        await pick(request, h, m.id, m.team_a.id);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return readBracket(request, h);
}

test.beforeAll(async () => { await assertOidcStubReachable(); });
test.beforeEach(async () => {
  await resetStub();
  const svc = getServiceClient();
  await svc.from("bracket_picks").delete().eq("participant_id", CHARLIE_PID);
  await svc.from("bracket_submissions").delete().eq("participant_id", CHARLIE_PID);
});
test.afterEach(async () => {
  const svc = getServiceClient();
  await svc.from("bracket_picks").delete().eq("participant_id", CHARLIE_PID);
  await svc.from("bracket_submissions").delete().eq("participant_id", CHARLIE_PID);
  await resetStub();
});

test("AS1 — submit disabled with N-of-31 progress while incomplete @slice-010 @us3", async ({ page }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  await page.goto("/bracket");
  await expect(page.getByTestId("bracket-progress").first()).toContainText("of 31");
  // Two submit controls share this testid (header + mobile sticky footer);
  // assert the header one (first in DOM, visible on the desktop viewport).
  const submitBtn = page.getByTestId("bracket-submit").first();
  await expect(submitBtn).toBeVisible();
  await expect(submitBtn).toBeDisabled();
});

test("AS2 — submit enabled at 31/31 @slice-010 @us3", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);
  const filled = await fillBracket(request, h);
  expect(filled.status.completed, "all 31 picks present").toBe(31);

  await page.goto("/bracket");
  await expect(page.getByTestId("bracket-submit")).toBeEnabled();
});

test("AS3 — a complete bracket submits → 200 submitted @slice-010 @us3", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);
  await fillBracket(request, h);

  const r = await submit(request, h);
  expect(r.status(), "complete submit → 200").toBe(200);
  const body = (await r.json()) as { submission_status: string; version: number; status: { submission_status: string } };
  expect(body.submission_status).toBe("submitted");
  expect(body.version).toBe(1);
  expect(body.status.submission_status).toBe("submitted");
});

test("AS4 — 30/31 via direct API → 422 BRACKET_INCOMPLETE with missing_count @slice-010 @us3", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);
  const filled = await fillBracket(request, h, FINAL); // leave the Final unpicked
  expect(filled.status.completed, "30 of 31 picked").toBe(30);

  const r = await submit(request, h);
  expect(r.status(), "incomplete submit → 422").toBe(422);
  const body = (await r.json()) as { error: { code: string; missing_count?: number } };
  expect(body.error.code).toBe("BRACKET_INCOMPLETE");
  expect(body.error.missing_count).toBe(1);
});

test("AS5 — re-submit after an edit supersedes (version bumps) @slice-010 @us3", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);
  const filled = await fillBracket(request, h);

  const first = await submit(request, h);
  expect((await first.json()).version).toBe(1);

  // Edit the Final winner (no downstream → stays complete), then re-submit.
  const finalMatchup = filled.matchups.find((m) => m.id === FINAL)!;
  const other = finalMatchup.team_b!.id; // team_a was picked by fill; switch to team_b
  const edit = await pick(request, h, FINAL, other);
  expect(edit.status()).toBe(200);

  const second = await submit(request, h);
  expect(second.status(), "re-submit before lock → 200").toBe(200);
  expect((await second.json()).version, "version bumps on re-submit (FR-028)").toBe(2);
});

test("AS6 — submit after lock → 409 BRACKET_LOCKED @slice-010 @us3", async ({ page, request, context }) => {
  await signInWithIdentity(page, { claims: { ...CHARLIE } });
  const h = await hdr(context);
  await fillBracket(request, h);

  const svc = getServiceClient();
  const { data: orig } = await svc.from("tournament_config").select("value").eq("key", "first_kickoff_utc").single();
  try {
    await svc.from("tournament_config").update({ value: "2020-01-01T00:00:00Z" }).eq("key", "first_kickoff_utc");
    const r = await submit(request, h);
    expect(r.status(), "submit after lock → 409").toBe(409);
    expect((await r.json()).error.code).toBe("BRACKET_LOCKED");
  } finally {
    await svc.from("tournament_config").update({ value: orig!.value }).eq("key", "first_kickoff_utc");
  }
});
