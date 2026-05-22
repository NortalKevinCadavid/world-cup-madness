// Slice 004 / T031 / contracts/players-ingest.md
//
// Tests deferred to T034 — Deno not installed locally + Docker daemon down.
// This file ships RED until the local toolchain is provisioned.
//
// Coverage: the sync-catalog Edge Function's `case 'players'` branch
// (sync-catalog/index.ts § 7d). When the stub adapter is invoked, it
// exposes the optional `fetchPlayers?()` method (slice 002 reserved the
// signature; slice 004 / T031 activates it). The coordinator MUST:
//
//   1. Detect `typeof adapter.fetchPlayers === 'function'` and dispatch.
//   2. Invoke `upsertPlayers` with the returned NormalizedPlayer[] +
//      runId + provider name.
//   3. Surface the count on the 200 response as
//      `counts.players_upserted` (and `counts.players_soft_deleted`).
//   4. NOT regress matches outcome — the matches branch + sub-tests from
//      slice 002 (single_sync_happy, undersized_payload_rejected, etc.)
//      remain GREEN.
//
// What this test proves at runtime:
//   - HTTP 200 + outcome='success' (happy path).
//   - response body has counts.players_upserted == 16 (the stub fixture's
//     wc2026-players.json size — matches the slice-004 seed roster).
//   - public.players holds at least 16 active rows after the sync.
//   - public.player_provider_external_ids holds at least 16 rows for
//     provider='stub'.
//   - audit_log carries N rows with action='player.created' or
//     'player.updated' for this run.
//
// Skip policy: mirrors slice-002 sibling tests — self-skip unless
// RUN_SYNC_CATALOG_TESTS=1 AND the supabase + secret env vars are present.
// Docker + supabase CLI are NOT required on every contributor's box.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ============================================================================
// Environment + harness
// ============================================================================

const RUN = Deno.env.get("RUN_SYNC_CATALOG_TESTS") === "1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SYNC_TRIGGER_SECRET = Deno.env.get("SYNC_TRIGGER_SECRET") ?? "";
const SYNC_FUNCTION_URL = Deno.env.get("SYNC_FUNCTION_URL")
  ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/sync-catalog` : "");

const HAS_ENV =
  RUN &&
  SUPABASE_URL.length > 0 &&
  SERVICE_ROLE_KEY.length > 0 &&
  SYNC_TRIGGER_SECRET.length > 0 &&
  SYNC_FUNCTION_URL.length > 0;

const PROVIDER = "stub";

// Expected player count from the stub adapter fixture
// (supabase/functions/_shared/providers/stub/fixtures/wc2026-players.json).
// 16 = the slice-004 fixture's roster size (2 per team × 8 teams).
const EXPECTED_STUB_PLAYERS = 16;

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ============================================================================
// Test
// ============================================================================

Deno.test({
  name:
    "players_branch: POST sync-catalog with stub provider invokes adapter.fetchPlayers, UPSERTs 16 players, surfaces counts.players_upserted on the 200 response",
  ignore: !HAS_ENV,
  async fn() {
    const supabase = serviceClient();
    const runId = crypto.randomUUID();

    // ----- Pre-state snapshot -------------------------------------------
    const { count: beforeAuditCount, error: beforeAuditErr } = await supabase
      .from("audit_log")
      .select("*", { count: "exact", head: true })
      .in("action", ["player.created", "player.updated"]);
    if (beforeAuditErr) {
      throw new Error(`pre-state audit count failed: ${beforeAuditErr.message}`);
    }

    // ----- Invoke the coordinator ---------------------------------------
    const response = await fetch(SYNC_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth": SYNC_TRIGGER_SECRET,
      },
      body: JSON.stringify({
        provider: PROVIDER,
        trigger: "manual_internal",
        run_id: runId,
      }),
    });

    assertEquals(
      response.status,
      200,
      "happy-path sync (matches + players branches) must return 200",
    );

    const body = await response.json();

    assertEquals(body?.run_id, runId, "response body echoes run_id");
    assertEquals(body?.provider, PROVIDER, "response body echoes provider");
    assert(
      body?.outcome === "success" || body?.outcome === "success_no_changes",
      `expected a healthy terminal outcome, got ${body?.outcome}`,
    );

    // ----- Players counts on the wire ------------------------------------
    // The coordinator's upsertPlayers result is surfaced as
    // counts.players_upserted (+ counts.players_soft_deleted on subsequent
    // syncs that drop roster members). On the first sync against a clean
    // DB, the helper INSERTs all 16 stub players + writes 16 mappings;
    // on a re-sync against a seeded DB (slice-004 fixture already has the
    // 16 stub-provider rows), the helper takes the UPDATE path for each
    // (full_name diff against current; the stub's full_name matches the
    // fixture so the UPDATE may be a no-op — but the upserted count still
    // increments because the helper counts every row it processed).
    assert(
      typeof body?.counts?.players_upserted === "number",
      "counts.players_upserted must be present (the stub adapter implements fetchPlayers)",
    );
    assertEquals(
      body?.counts?.players_upserted,
      EXPECTED_STUB_PLAYERS,
      `counts.players_upserted must equal ${EXPECTED_STUB_PLAYERS} (the stub fixture's roster size)`,
    );

    // ----- DB-side invariants -------------------------------------------
    // The slice-004 fixture pre-seeds 16 stub-provider mappings, so after
    // the sync we still see exactly 16 (no duplicates created — the UNIQUE
    // (provider_name, provider_player_id) idempotency anchor works).
    const { count: stubMappingCount, error: mapErr } = await supabase
      .from("player_provider_external_ids")
      .select("*", { count: "exact", head: true })
      .eq("provider_name", "stub");
    if (mapErr) {
      throw new Error(`mapping count failed: ${mapErr.message}`);
    }
    assertEquals(
      stubMappingCount,
      EXPECTED_STUB_PLAYERS,
      `player_provider_external_ids must hold exactly ${EXPECTED_STUB_PLAYERS} rows for provider=stub`,
    );

    // Active players for the stub provider (via the mapping table). All 16
    // must be active after a happy-path sync (no soft-deletes when the
    // incoming roster matches the seeded roster).
    const { data: activePlayers, error: activeErr } = await supabase
      .from("player_provider_external_ids")
      .select("player_id, players:players!inner(id, removed_at)")
      .eq("provider_name", "stub");
    if (activeErr) {
      throw new Error(`active players read failed: ${activeErr.message}`);
    }
    const activeCount = (activePlayers ?? []).filter((m) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = Array.isArray((m as any).players)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (m as any).players[0]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : (m as any).players;
      return row && row.removed_at === null;
    }).length;
    assertEquals(
      activeCount,
      EXPECTED_STUB_PLAYERS,
      `all ${EXPECTED_STUB_PLAYERS} stub-provider players must be active (removed_at IS NULL) after a happy sync`,
    );

    // ----- Audit fan-out -------------------------------------------------
    // The upsertPlayers helper writes one audit row per player processed
    // (action='player.created' on first INSERT, 'player.updated' otherwise).
    // Against the slice-004 seed, the helper takes the UPDATE branch for
    // each of the 16 rows, so 16 'player.updated' rows are added per sync.
    const { count: afterAuditCount, error: afterAuditErr } = await supabase
      .from("audit_log")
      .select("*", { count: "exact", head: true })
      .in("action", ["player.created", "player.updated"]);
    if (afterAuditErr) {
      throw new Error(`post-state audit count failed: ${afterAuditErr.message}`);
    }
    const auditDelta = (afterAuditCount ?? 0) - (beforeAuditCount ?? 0);
    assert(
      auditDelta >= EXPECTED_STUB_PLAYERS,
      `expected at least ${EXPECTED_STUB_PLAYERS} new player.created|updated audit rows, got ${auditDelta}`,
    );

    // ----- Ledger row ----------------------------------------------------
    // The matches branch wrote the provider_sync_runs row; we just verify
    // it terminated healthy (the players branch is best-effort and does
    // NOT mutate the matches outcome).
    const { data: ledgerRow, error: ledgerErr } = await supabase
      .from("provider_sync_runs")
      .select("provider, outcome")
      .eq("correlation_id", runId)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ledgerErr) {
      throw new Error(`ledger lookup failed: ${ledgerErr.message}`);
    }
    assert(ledgerRow, "provider_sync_runs row must exist for the correlation_id");
    assertEquals(
      ledgerRow.provider,
      PROVIDER,
      "ledger row.provider matches the request",
    );
    assert(
      ledgerRow.outcome === "success" ||
        ledgerRow.outcome === "partial" ||
        ledgerRow.outcome === "conflict_quarantined",
      `ledger outcome must be a terminal happy / partial value, got ${ledgerRow.outcome}`,
    );
  },
});
