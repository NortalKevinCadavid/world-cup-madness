/**
 * T024 — Auth contract test (RED).
 *
 * Contract: contracts/sync-runner.scheduled.md § Auth, § Coordinator behavior
 * step 1 ("Parse & auth. Reject 401/403 on bad credentials.").
 *
 * Asserts that a request bearing a participant (non-admin) JWT and NO
 * `X-Internal-Auth` header is rejected with HTTP 403 +
 * `{ error: { code: 'FORBIDDEN' } }`.
 *
 * Slice 001's `public.is_admin(uuid)` is a stub that returns `false` for every
 * user (see supabase/migrations/0006_is_admin_stub.sql), so ANY authenticated
 * Supabase JWT counts as "non-admin" for the duration of Slice 002. We sign
 * in via the standard Supabase JS client to mint a real session token rather
 * than hand-forging a JWT — this keeps the test resilient to future JWT
 * payload changes.
 *
 * Self-skip mirrors T023's env-var pattern.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const RUN = Deno.env.get("RUN_SYNC_CATALOG_TESTS") === "1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PARTICIPANT_JWT_OVERRIDE = Deno.env.get("PARTICIPANT_JWT") ?? "";

// We need EITHER a pre-minted participant JWT (CI path) OR enough credentials
// to create a participant on the fly via the service-role client (local path).
const HAS_ENV =
  RUN &&
  SUPABASE_URL.length > 0 &&
  (PARTICIPANT_JWT_OVERRIDE.length > 0 ||
    (SUPABASE_ANON_KEY.length > 0 && SUPABASE_SERVICE_ROLE_KEY.length > 0));

const PROVIDER = "stub";
const RUN_ID = "00000000-0000-0000-0000-0000000004A2";

/**
 * Resolves a participant JWT. Prefers the override (so CI can pass a long-
 * lived token); otherwise mints a one-shot user via service-role admin API
 * and signs them in to get a real anon-key-scoped JWT.
 */
async function getParticipantJwt(): Promise<string> {
  if (PARTICIPANT_JWT_OVERRIDE) return PARTICIPANT_JWT_OVERRIDE;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Test user is eligible-domain so the auth hook accepts the account, but
  // is_admin(...) remains false (the slice-001 stub).
  const email = `participant-${crypto.randomUUID()}@nortal.com`;
  const password = `Test-${crypto.randomUUID()}!`;

  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) throw new Error(`createUser failed: ${createErr.message}`);

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session?.access_token) {
    throw new Error(
      `signInWithPassword failed: ${error?.message ?? "no access_token"}`,
    );
  }
  return data.session.access_token;
}

Deno.test({
  name:
    "non_admin_returns_403: participant JWT (is_admin=false) without internal-auth gets 403 FORBIDDEN",
  ignore: !HAS_ENV,
  async fn() {
    const jwt = await getParticipantJwt();

    const response = await fetch(`${SUPABASE_URL}/functions/v1/sync-catalog`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        // Intentionally NO X-Internal-Auth header — non-admin JWT must fail.
      },
      body: JSON.stringify({
        provider: PROVIDER,
        trigger: "admin_manual",
        run_id: RUN_ID,
        reason: "non-admin negative test",
      }),
    });

    assertEquals(
      response.status,
      403,
      "non-admin authenticated user must receive 403, not 401",
    );

    const body = await response.json();
    assertEquals(
      body?.error?.code,
      "FORBIDDEN",
      "403 body must carry error.code='FORBIDDEN' per contracts/sync-runner.scheduled.md § Auth",
    );
    assertEquals(
      typeof body?.error?.message,
      "string",
      "403 body must include a human-readable error.message",
    );
  },
});
