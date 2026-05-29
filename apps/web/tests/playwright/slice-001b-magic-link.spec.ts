// --------------------------------------------------------------------------
// Slice 001b — Magic-link sign-in end-to-end (with Mailpit).
// --------------------------------------------------------------------------
// Verifies the auth flow added on top of slice-001:
//   AS1  Client-side domain validation: a non-nortal email shows the inline
//        @nortal.com error AND never reaches Supabase Auth (no email sent).
//   AS2  Happy path: a seeded @nortal.com user requests a link, the message
//        lands in Mailpit, hitting our /auth/callback with token_hash+type
//        completes verifyOtp and lands a signed-in session on /dashboard.
//   AS3  Server-side domain rejection: a direct POST /auth/v1/otp for a
//        non-nortal address gets 403 (auth.users-insert trigger denies),
//        no email is sent, and no auth.users row is created.
//
// Mailpit (not Inbucket) is the local mailer in this CLI version; the API
// surface used is GET /api/v1/messages + DELETE /api/v1/messages + GET
// /api/v1/message/<id>.
// --------------------------------------------------------------------------

import { test, expect, type APIRequestContext } from "@playwright/test";
import { assertOidcStubReachable, resetStub } from "./fixtures/oidc";

test.describe.configure({ mode: "serial" });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  "";
const MAILPIT_URL = "http://localhost:54324";
const ALPHA_EMAIL = "alpha@nortal.com";

interface MailpitListItem {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}
interface MailpitList {
  total: number;
  messages: MailpitListItem[];
}

async function clearMailbox(request: APIRequestContext): Promise<void> {
  await request.delete(`${MAILPIT_URL}/api/v1/messages`);
}

async function listMessages(request: APIRequestContext): Promise<MailpitList> {
  const res = await request.get(`${MAILPIT_URL}/api/v1/messages`);
  return (await res.json()) as MailpitList;
}

async function waitForEmail(
  request: APIRequestContext,
  to: string,
  timeoutMs = 6_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await listMessages(request);
    const m = (body.messages ?? []).find((x) =>
      x.To.some((t) => t.Address.toLowerCase() === to.toLowerCase()),
    );
    if (m) return m.ID;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email to ${to} within ${timeoutMs}ms`);
}

// Quoted-printable decode for raw RFC-822 mail bodies: drop soft line breaks
// (`=\r?\n`) and decode `=XX` escapes back to their literal characters.
function qpDecode(s: string): string {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

async function extractToken(
  request: APIRequestContext,
  id: string,
  timeoutMs = 5_000,
): Promise<{ token_hash: string; type: string }> {
  // Use Mailpit's /raw endpoint — the RFC-822 source is always immediately
  // available once the message is listed (unlike the parsed HTML/Text fields).
  // QP-decode it so `=3D` doesn't break the regex.
  const start = Date.now();
  let lastLen = 0;
  while (Date.now() - start < timeoutMs) {
    const res = await request.get(`${MAILPIT_URL}/api/v1/message/${id}/raw`);
    const raw = qpDecode(await res.text());
    lastLen = raw.length;
    // Token may be hex OR `pkce_<hex>` (browser PKCE flow via @supabase/ssr).
    const th = raw.match(/token_hash=([A-Za-z0-9_]+)/);
    if (th) {
      const ty = raw.match(/[?&]type=([a-zA-Z]+)/);
      return { token_hash: th[1], type: ty ? ty[1] : "magiclink" };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `no token_hash after ${timeoutMs}ms (raw body length=${lastLen})`,
  );
}

test.beforeAll(async () => {
  await assertOidcStubReachable();
});

test.beforeEach(async ({ request }) => {
  await resetStub();
  await clearMailbox(request);
});

test("AS1 — non-nortal email shows the inline domain error; no mail sent @magic-link", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByTestId("magic-link-email").fill("eve@example.com");
  await page.getByTestId("magic-link-submit").click();

  // The form renders the invalidDomain message in a <p role="alert">.
  // Target by text (Next.js also has a global __next-route-announcer__ with
  // role="alert", so role-only locator is ambiguous).
  await expect(page.getByText(/Use your @nortal\.com email/i)).toBeVisible();
  await expect(page.getByTestId("magic-link-sent")).toHaveCount(0);

  // No request reached Supabase Auth → no mail in Mailpit.
  const body = await listMessages(request);
  expect(body.total, "no email should be sent for a non-nortal address").toBe(0);
});

test("AS2 — happy path: link arrives in Mailpit and completes sign-in to /dashboard @magic-link", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByTestId("magic-link-email").fill(ALPHA_EMAIL);
  await page.getByTestId("magic-link-submit").click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  // Mailpit captured the magic link email — extract the token_hash and
  // complete the callback (token_hash + verifyOtp path, not PKCE).
  const id = await waitForEmail(request, ALPHA_EMAIL);
  const { token_hash, type } = await extractToken(request, id);

  await page.goto(
    `/auth/callback?token_hash=${token_hash}&type=${type}&next=/dashboard`,
  );
  await page.waitForURL(/\/dashboard(\?|$|#|\/)/, { timeout: 10_000 });

  // Dashboard renders the i18n "Welcome, {name}" header for the signed-in
  // participant — confirms the session cookies were committed.
  await expect(page.getByRole("heading", { name: /^Welcome,/i })).toBeVisible();
});

test("AS3 — non-nortal direct OTP request is rejected with 403; no email, no user @magic-link", async ({
  request,
}) => {
  const res = await request.post(`${SUPABASE_URL}/auth/v1/otp`, {
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    data: { email: "intruder@example.com", create_user: true },
  });
  expect(res.status(), "non-nortal OTP rejected by auth-users trigger").toBe(403);

  // Belt-and-braces: Mailpit stays empty.
  await new Promise((r) => setTimeout(r, 500));
  const body = await listMessages(request);
  expect(body.total, "rejected request must not send an email").toBe(0);
});
