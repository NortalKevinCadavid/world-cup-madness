/**
 * Slice 005 / T015 — non_admin_returns_403.test.ts (RED).
 *
 * Contract: contracts/scoring-trigger.edge-fn.md
 *   § Request (admin path requires admin JWT)
 *   § Error responses (403 if caller is not admin)
 *
 * What this test proves at runtime:
 *   A POST that supplies an Authorization: Bearer <participant JWT> (a
 *   non-admin) and NO X-Internal-Auth header is rejected with 403 +
 *   `error.code='FORBIDDEN'`.
 *
 * Slice 001's `public.is_admin(uuid)` is a stub returning FALSE for every
 * uid (see supabase/migrations/0006_is_admin_stub.sql), so ANY authenticated
 * Supabase JWT counts as "non-admin" until slice 006 ships the admin_roles
 * table + production is_admin function. We mint a one-shot participant via
 * the service-role admin API and sign them in to get a real anon-scoped JWT
 * — keeps the test resilient to JWT payload changes.
 *
 * Skip policy: mirrors slice 002's non_admin_returns_403.test.ts. Needs
 * SUPABASE_ANON_KEY in addition to the service-role key so the sign-in flow
 * can mint a real session token.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const RUN = Deno.env.get("RUN_EDGE_FN_TESTS") === "1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PARTICIPANT_JWT_OVERRIDE = Deno.env.get("PARTICIPANT_JWT") ?? "";
const FUNCTION_URL = Deno.env.get("SCORE_TRIGGER_FUNCTION_URL")
  ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/score-trigger` : "");

const HAS_ENV =
  RUN &&
  SUPABASE_URL.length > 0 &&
  FUNCTION_URL.length > 0 &&
  (PARTICIPANT_JWT_OVERRIDE.length > 0 ||
    (SUPABASE_ANON_KEY.length > 0 && SUPABASE_SERVICE_ROLE_KEY.length > 0));

const M1 = "eeee0050-0000-0000-0000-000000000001";
const R = "eeee0099-0004-4004-8004-000000000004";

async function getParticipantJwt(): Promise<string> {
  if (PARTICIPANT_JWT_OVERRIDE) return PARTICIPANT_JWT_OVERRIDE;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Eligible-domain so the auth hook accepts the account; is_admin remains
  // false (slice-001 stub).
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
    "non_admin_returns_403: participant JWT (is_admin=false) without X-Internal-Auth gets 403 FORBIDDEN",
  ignore: !HAS_ENV,
  async fn() {
    const jwt = await getParticipantJwt();

    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        // Intentionally NO X-Internal-Auth header — non-admin JWT must fail.
      },
      body: JSON.stringify({
        scope: "match",
        target_id: M1,
        reason: "T015 non_admin_returns_403 test",
        run_id: R,
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
      "403 body must carry error.code='FORBIDDEN' per contracts/scoring-trigger.edge-fn.md § Error responses",
    );
    assertEquals(
      typeof body?.error?.message,
      "string",
      "403 body must include a human-readable error.message",
    );
  },
});
