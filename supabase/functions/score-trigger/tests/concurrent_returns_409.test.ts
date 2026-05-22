/**
 * Slice 005 / T015 — concurrent_returns_409.test.ts (RED).
 *
 * Contract: contracts/scoring-trigger.edge-fn.md
 *   § Behavior step 1 (per-tournament advisory lock)
 *   § Error responses (409 Conflict + error.code='SCORING_IN_FLIGHT')
 * Research: research.md § R-011 (advisory lock).
 *
 * What this test proves at runtime:
 *   While a side-channel Postgres session holds
 *   `pg_advisory_lock(hashtext('scoring'), hashtext(TOURNAMENT_ID))`, a POST
 *   to the Edge Function with scope='match' returns 409 with
 *   `error.code='SCORING_IN_FLIGHT'`. The side connection releases the lock
 *   in the test's `finally` so no state is leaked.
 *
 * Lock-acquisition strategy: a Deno postgres driver connection. PostgREST
 * does not expose pg_advisory_lock built-ins by default; rather than ship a
 * test-only SECURITY DEFINER wrapper we use a direct session against the
 * Supabase DB URL — same pattern as slice 002's advisory_lock_returns_409.
 *
 * D-T015-A NOTE: If the Edge Function's pg_try_advisory_lock RPC is
 * unavailable (the function degrades to "no lock" per index.ts § step 3),
 * this test will RED with a 200 instead of 409 — that signals the missing
 * helper migration, not a behavioral bug. T016 / a follow-up migration
 * (a SECURITY DEFINER `public.try_lock_scoring(uuid)` helper) closes that
 * gap.
 *
 * Skip policy: mirrors slice 002's advisory_lock_returns_409.test.ts.
 * Requires SUPABASE_DB_URL in addition to the standard set so the side
 * connection can be established.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Client as PgClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const RUN = Deno.env.get("RUN_EDGE_FN_TESTS") === "1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const INTERNAL_SECRET =
  Deno.env.get("SCORE_TRIGGER_INTERNAL_AUTH_SECRET") ?? "";
const SUPABASE_DB_URL = Deno.env.get("SUPABASE_DB_URL") ?? "";
const FUNCTION_URL = Deno.env.get("SCORE_TRIGGER_FUNCTION_URL")
  ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/score-trigger` : "");

const HAS_ENV =
  RUN &&
  SUPABASE_URL.length > 0 &&
  INTERNAL_SECRET.length > 0 &&
  SUPABASE_DB_URL.length > 0 &&
  FUNCTION_URL.length > 0;

const M1 = "eeee0050-0000-0000-0000-000000000001";
const R = "eeee0099-0003-4003-8003-000000000003";
const TOURNAMENT_ID = "00000000-0000-0000-0000-000000000001";

Deno.test({
  name:
    "concurrent_returns_409: held pg_advisory_lock('scoring', tournament_id) causes score-trigger to return 409 SCORING_IN_FLIGHT",
  ignore: !HAS_ENV,
  async fn() {
    // Side connection holds the lock for the duration of the HTTP call.
    const side = new PgClient(SUPABASE_DB_URL);
    await side.connect();

    try {
      const acquired = await side.queryObject<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked`,
        ["scoring", TOURNAMENT_ID],
      );
      assertEquals(
        acquired.rows[0].locked,
        true,
        "side connection must hold the scoring advisory lock before POSTing",
      );

      const response = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth": INTERNAL_SECRET,
        },
        body: JSON.stringify({
          scope: "match",
          target_id: M1,
          reason: "T015 concurrent_returns_409 test",
          run_id: R,
        }),
      });

      assertEquals(
        response.status,
        409,
        `coordinator must reject concurrent scoring with 409. Body: ${await response.clone().text()}`,
      );

      const body = await response.json();
      assertEquals(
        body?.error?.code,
        "SCORING_IN_FLIGHT",
        "409 body must carry error.code='SCORING_IN_FLIGHT' per contracts/scoring-trigger.edge-fn.md § Error responses",
      );
      assertEquals(
        typeof body?.error?.message,
        "string",
        "409 body must include a human-readable error.message",
      );
    } finally {
      // Always release the lock, even on assertion failure.
      try {
        await side.queryObject(
          `SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`,
          ["scoring", TOURNAMENT_ID],
        );
      } finally {
        await side.end();
      }
    }
  },
});
