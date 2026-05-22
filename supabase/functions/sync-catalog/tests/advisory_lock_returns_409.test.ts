/**
 * T024 — Concurrency contract test (RED).
 *
 * Contract: contracts/sync-runner.scheduled.md § Coordinator behavior step 2,
 * § Response (409 Conflict).
 * Research: research.md § R-006 (per-provider advisory lock).
 *
 * Asserts that a second sync attempt is rejected with HTTP 409 +
 * `{ error: { code: 'SYNC_IN_FLIGHT' } }` while another session holds
 * `pg_advisory_lock(hashtext('sync_catalog'), hashtext('stub'))`.
 *
 * --- Lock-acquisition strategy ---
 * The task description preferred `supabase.rpc('pg_advisory_lock', ...)` over
 * a separate Postgres connection. PostgREST does not, however, expose
 * Postgres built-ins by default — `.rpc('pg_advisory_lock')` would fail with
 * "function not found" unless the slice ships a SECURITY DEFINER wrapper.
 * No such wrapper exists yet (and Slice 002 should not invent one only for
 * tests). The straightforward, well-supported alternative is a side
 * Postgres connection via Deno's official `postgres` driver, which:
 *   1. Keeps the lock session-scoped exactly as production would have it.
 *   2. Auto-releases on connection close — no leakage if the test crashes.
 *   3. Avoids polluting the public schema with a test-only RPC.
 * If a future migration adds `public.try_acquire_sync_lock(provider text)`,
 * this test can flip to `.rpc()`; for now we use the driver directly.
 *
 * --- Self-skip pattern (mirrors T023) ---
 * The test is `ignored` unless `RUN_SYNC_CATALOG_TESTS=1` is set AND the
 * required Supabase/Edge env vars are present. This lets `deno test` run
 * cleanly on dev machines without a live local stack (Docker + Supabase
 * CLI not installed in CI for some contributors) while still being a
 * RED-first contract gate when run with the stack up.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Client as PgClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const RUN = Deno.env.get("RUN_SYNC_CATALOG_TESTS") === "1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SYNC_TRIGGER_SECRET = Deno.env.get("SYNC_TRIGGER_SECRET") ?? "";
const SUPABASE_DB_URL = Deno.env.get("SUPABASE_DB_URL") ?? "";

const HAS_ENV =
  RUN &&
  SUPABASE_URL.length > 0 &&
  SYNC_TRIGGER_SECRET.length > 0 &&
  SUPABASE_DB_URL.length > 0;

const PROVIDER = "stub";
const RUN_ID = "00000000-0000-0000-0000-0000000004A1";

Deno.test({
  name:
    "advisory_lock_returns_409: held pg_advisory_lock causes coordinator to return 409 SYNC_IN_FLIGHT",
  ignore: !HAS_ENV,
  async fn() {
    // Side connection holds the lock for the duration of the HTTP call.
    const side = new PgClient(SUPABASE_DB_URL);
    await side.connect();

    try {
      const acquired = await side.queryObject<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked`,
        ["sync_catalog", PROVIDER],
      );
      assertEquals(
        acquired.rows[0].locked,
        true,
        "side connection must hold the per-provider advisory lock before POSTing",
      );

      const response = await fetch(`${SUPABASE_URL}/functions/v1/sync-catalog`, {
        method: "POST",
        headers: {
          "X-Internal-Auth": SYNC_TRIGGER_SECRET,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: PROVIDER,
          trigger: "cron",
          run_id: RUN_ID,
        }),
      });

      assertEquals(
        response.status,
        409,
        "coordinator must reject concurrent same-provider sync with 409",
      );

      const body = await response.json();
      assertEquals(
        body?.error?.code,
        "SYNC_IN_FLIGHT",
        "409 body must carry error.code='SYNC_IN_FLIGHT' per contracts/sync-runner.scheduled.md",
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
          ["sync_catalog", PROVIDER],
        );
      } finally {
        await side.end();
      }
    }
  },
});
