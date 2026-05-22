/**
 * T024 — Auth contract test (RED).
 *
 * Contract: contracts/sync-runner.scheduled.md § Auth, § Invocation Path 1,
 * § Coordinator behavior step 1.
 *
 * Two sub-tests on the internal-auth (`X-Internal-Auth`) path:
 *
 *   1. valid secret + no JWT  → 200 OK (sync runs against the `stub` provider).
 *   2. wrong secret  + no JWT → 401 UNAUTHENTICATED.
 *
 * The valid-secret sub-test only asserts on the HTTP status and the high-
 * level body shape — it does NOT assert specific count values. The detailed
 * happy-path catalog-mutation assertions belong to T023's
 * `single_sync_happy.test.ts`. Here we are gating ONLY the auth path.
 *
 * Self-skip mirrors T023.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RUN = Deno.env.get("RUN_SYNC_CATALOG_TESTS") === "1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SYNC_TRIGGER_SECRET = Deno.env.get("SYNC_TRIGGER_SECRET") ?? "";

const HAS_ENV =
  RUN && SUPABASE_URL.length > 0 && SYNC_TRIGGER_SECRET.length > 0;

const PROVIDER = "stub";

Deno.test({
  name:
    "internal_auth_path: valid X-Internal-Auth secret without JWT is accepted (200)",
  ignore: !HAS_ENV,
  async fn() {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/sync-catalog`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": SYNC_TRIGGER_SECRET,
        "Content-Type": "application/json",
        // No Authorization header — this path must authenticate via the header alone.
      },
      body: JSON.stringify({
        provider: PROVIDER,
        trigger: "cron",
        run_id: "00000000-0000-0000-0000-0000000004B1",
      }),
    });

    assertEquals(
      response.status,
      200,
      "valid internal-auth header must be accepted with no JWT",
    );

    const body = await response.json();
    assertEquals(
      body?.provider,
      PROVIDER,
      "200 body must echo the requested provider",
    );
    assertEquals(
      typeof body?.run_id,
      "string",
      "200 body must include the run_id (uuid)",
    );
    assertEquals(
      typeof body?.outcome,
      "string",
      "200 body must include an outcome string per contracts § Outcome enum",
    );
  },
});

Deno.test({
  name:
    "internal_auth_path: wrong X-Internal-Auth value without JWT returns 401 UNAUTHENTICATED",
  ignore: !HAS_ENV,
  async fn() {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/sync-catalog`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": "bogus",
        "Content-Type": "application/json",
        // No Authorization header.
      },
      body: JSON.stringify({
        provider: PROVIDER,
        trigger: "cron",
        run_id: "00000000-0000-0000-0000-0000000004B2",
      }),
    });

    assertEquals(
      response.status,
      401,
      "invalid internal-auth header without JWT must be rejected with 401",
    );

    const body = await response.json();
    assertEquals(
      body?.error?.code,
      "UNAUTHENTICATED",
      "401 body must carry error.code='UNAUTHENTICATED' per contracts/sync-runner.scheduled.md § Auth",
    );
    assertEquals(
      typeof body?.error?.message,
      "string",
      "401 body must include a human-readable error.message",
    );
  },
});
