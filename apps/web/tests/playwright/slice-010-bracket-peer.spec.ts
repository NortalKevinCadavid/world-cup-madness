// --------------------------------------------------------------------------
// Slice 010 / T032 — US4 "Privacy before lock & peer view after".
// --------------------------------------------------------------------------
// Mirrors slice-005 SC-009. The gate lives in bracket_peer_v (DEFINER + lock +
// self-exclusion, migration 0091), so a participant who bypasses the route and
// hits /rest/v1/bracket_peer_v directly with their JWT gets the SAME answer.
// Per contracts/bracket-peer.read.md. Serial; lock is driven by snapshotting
// tournament_config.first_kickoff_utc and restoring it byte-identically.
// --------------------------------------------------------------------------

import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { assertOidcStubReachable, resetStub, signInWithIdentity } from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

test.describe.configure({ mode: "serial" });

const ALPHA = { sub: "00000000-0000-0000-0000-00000000000a", email: "alpha@nortal.com", email_verified: true, name: "Alpha Tester" } as const;
const ADMIN1 = { sub: "00000000-0000-0000-0000-0000000000d3", email: "admin1@nortal.com", email_verified: true, name: "Admin One" } as const;
const BRAVO_PID = "22222222-2222-2222-2222-222222222222";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function extractJwt(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies();
  const chunks = cookies
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => Number.parseInt(a.name.split(".").pop() ?? "0", 10) - Number.parseInt(b.name.split(".").pop() ?? "0", 10));
  if (chunks.length === 0) return null;
  let combined = chunks.map((c) => c.value).join("");
  if (combined.startsWith("base64-")) combined = combined.slice("base64-".length);
  try {
    return (JSON.parse(Buffer.from(combined, "base64").toString("utf8")) as { access_token?: string }).access_token ?? null;
  } catch {
    try {
      return (JSON.parse(decodeURIComponent(combined)) as { access_token?: string }).access_token ?? null;
    } catch {
      return null;
    }
  }
}

async function setFirstKickoff(iso: string): Promise<() => Promise<void>> {
  const client = getServiceClient();
  const { data } = await client.from("tournament_config").select("value").eq("key", "first_kickoff_utc").maybeSingle();
  const original = data!.value;
  await client.from("tournament_config").update({ value: iso }).eq("key", "first_kickoff_utc");
  return async () => { await client.from("tournament_config").update({ value: original }).eq("key", "first_kickoff_utc"); };
}

async function directPeer(request: APIRequestContext, jwt: string): Promise<unknown[] | null> {
  const url = `${SUPABASE_URL}/rest/v1/bracket_peer_v?participant_id=eq.${BRAVO_PID}&select=*`;
  const res = await request.get(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}`, Accept: "application/json" } });
  try {
    const json = JSON.parse(await res.text()) as unknown;
    return Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

let restoreLock: (() => Promise<void>) | null = null;

test.beforeAll(async () => { await assertOidcStubReachable(); });
test.beforeEach(async () => { await resetStub(); restoreLock = null; });
test.afterEach(async () => { if (restoreLock) { await restoreLock(); restoreLock = null; } await resetStub(); });

test("AS1 — pre-lock peer GET returns non-leaking { bracket: null } @slice-010 @us4", async ({ page, request, context }) => {
  restoreLock = await setFirstKickoff(new Date(Date.now() + 60 * 60 * 1000).toISOString());
  await signInWithIdentity(page, { claims: { ...ALPHA } });
  const res = await request.get(`/api/bracket-peer/${BRAVO_PID}`, { headers: { Cookie: await cookieHeader(context) } });
  expect(res.status(), "pre-lock peer GET → 200").toBe(200);
  expect((await res.json()).bracket, "pre-lock → bracket null (no existence/contents leak)").toBeNull();
});

test("AS2 — pre-lock direct REST with participant JWT returns [] @slice-010 @us4", async ({ page, request, context }) => {
  restoreLock = await setFirstKickoff(new Date(Date.now() + 60 * 60 * 1000).toISOString());
  await signInWithIdentity(page, { claims: { ...ALPHA } });
  const jwt = await extractJwt(context);
  expect(jwt, "alpha JWT extractable").not.toBeNull();
  const rows = await directPeer(request, jwt as string);
  expect(rows, "direct REST body parses as array").not.toBeNull();
  expect(rows?.length, "pre-lock direct REST → [] (gate is the view, SC-005)").toBe(0);
});

test("AS3 — pre-lock direct REST with admin JWT also returns [] (no admin bypass) @slice-010 @us4", async ({ page, request, context }) => {
  restoreLock = await setFirstKickoff(new Date(Date.now() + 60 * 60 * 1000).toISOString());
  await signInWithIdentity(page, { claims: { ...ADMIN1 } });
  const jwt = await extractJwt(context);
  expect(jwt, "admin JWT extractable").not.toBeNull();
  const rows = await directPeer(request, jwt as string);
  expect(rows?.length, "admin pre-lock direct REST → [] (no documented admin bypass on bracket_peer_v)").toBe(0);
});

test("AS4 — post-lock peer GET returns the peer's read-only bracket @slice-010 @us4", async ({ page, request, context }) => {
  restoreLock = await setFirstKickoff(new Date(Date.now() - 60 * 60 * 1000).toISOString());
  await signInWithIdentity(page, { claims: { ...ALPHA } });
  const res = await request.get(`/api/bracket-peer/${BRAVO_PID}`, { headers: { Cookie: await cookieHeader(context) } });
  expect(res.status(), "post-lock peer GET → 200").toBe(200);
  const body = (await res.json()) as { bracket?: null; participant?: { id: string }; matchups?: unknown[]; status?: { submission_status: string } };
  expect(body.bracket, "post-lock is NOT the null shape").toBeUndefined();
  expect(body.participant?.id, "post-lock returns bravo's bracket").toBe(BRAVO_PID);
  expect(body.matchups?.length, "post-lock returns the full 31-matchup tree").toBe(31);
  expect(body.status?.submission_status, "post-lock peer status is locked").toBe("locked");
});
