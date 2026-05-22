/**
 * Slice 002 / T030 — stub adapter (local-dev / canonical).
 *
 * Purpose: the production-shaped, local-only `MatchDataProviderAdapter`
 * driving every Slice 002 sync test. Reads a static JSON fixture
 * (`./fixtures/wc2026-snapshot.json`) describing the same 8 matches the
 * SQL seed `supabase/seed/slice-002-fixture.sql` UPSERTs, so a sync run
 * against this adapter is idempotent against the seeded catalog rows.
 *
 * This adapter is DELIBERATELY written in a DIFFERENT internal style than
 * the swap-test sibling `../stub2/index.ts`:
 *   - plain object literal export (no class, no instance state)
 *   - module-level pure helper functions (`normalizeFixture`,
 *     `normalizeTeam`, `normalizeResult`, `inWindow`)
 *   - flat denormalized fixture JSON — each match row carries its home /
 *     away team inline (vs stub2's nested `{teams, matches}` shape with
 *     refs joined at normalization time)
 *   - fresh `Deno.readTextFile` per call (no snapshot cache); the JSON is
 *     tiny and re-reading per call mirrors a stateless real-provider
 *     HTTP fetch
 *
 * The point of the divergence (per T025 + T030) is to prove SC-005:
 * swapping the active provider from `'stub'` to `'stub2'` produces
 * byte-identical `matches` / `match_results` rows. Internal style does
 * not leak across the contract surface.
 *
 * Contract source of truth: ../types.ts (T011, LOCKED).
 * Spec: specs/002-match-catalog/spec.md § SC-005, FR-006.
 *
 * Local-only. No API token. No network. No module-level credentials.
 * The `sync-catalog` coordinator (T032) wires `name === 'stub'` to this
 * module's default export via its static adapter registry.
 */

import type {
  MatchDataProviderAdapter,
  NormalizedFixture,
  NormalizedPlayer,
  NormalizedResult,
  NormalizedTeam,
  SyncWindow,
} from "../types.ts";

// ============================================================================
// Provider-shape types (this adapter's INTERNAL JSON layout — flat)
// ============================================================================

interface RawTeam {
  id: string;
  name: string;
  shortCode: string;
  flagUrl: string | null;
}

interface RawResult {
  homeScoreOfficial: number;
  awayScoreOfficial: number;
  homeScoreForScoring: number;
  awayScoreForScoring: number;
  resultStatus: NormalizedResult["resultStatus"];
}

interface RawFixture {
  id: string;
  homeTeam: RawTeam;
  awayTeam: RawTeam;
  stage: NormalizedFixture["stage"];
  groupId: string | null;
  kickoffUtc: string;
  venue: string | null;
  status: NormalizedFixture["status"];
  /** Present only when `status` indicates the score is final. */
  result: RawResult | null;
}

// ============================================================================
// Slice 004 / T031 / contracts/players-ingest.md — players raw shape
// ============================================================================
// Sibling-file fixture (NOT folded into wc2026-snapshot.json) so the locked
// slice-002 top-level-array shape of the matches snapshot stays untouched —
// every slice-002 test that mutates the matches fixture asserts
// Array.isArray(payload) on read (see undersized_payload_rejected.test.ts +
// empty_payload_rejected.test.ts). Folding `players` in would have required
// a `{ matches: [...], players: [...] }` envelope and broken those asserts.
// D-020 (spec deviation): sibling file instead of folded envelope.

interface RawPlayer {
  /** Provider's native player id (text). Mirrors the stub team `id` shape. */
  external_id: string;
  full_name: string;
  display_name: string | null;
  team_external_id: string | null;
  country_code: string | null;
  position: string | null;
}

// ============================================================================
// Module-level helpers (pure — no I/O beyond the snapshot read)
// ============================================================================

const SNAPSHOT_URL = new URL("./fixtures/wc2026-snapshot.json", import.meta.url);
const PLAYERS_URL = new URL("./fixtures/wc2026-players.json", import.meta.url);

async function readSnapshot(): Promise<RawFixture[]> {
  const text = await Deno.readTextFile(SNAPSHOT_URL);
  return JSON.parse(text) as RawFixture[];
}

async function readPlayers(): Promise<RawPlayer[]> {
  const text = await Deno.readTextFile(PLAYERS_URL);
  return JSON.parse(text) as RawPlayer[];
}

function normalizePlayer(raw: RawPlayer): NormalizedPlayer {
  return {
    providerPlayerId: raw.external_id,
    fullName: raw.full_name,
    teamProviderId: raw.team_external_id,
    // The locked NormalizedPlayer shape carries `aliases: string[]` (see
    // types.ts § Reserved for Slice 004). The stub provider has no alias
    // data, so we ship an empty array — additive-safe per Principle XI.
    aliases: [],
  };
}

function normalizeTeam(raw: RawTeam): NormalizedTeam {
  return {
    providerTeamId: raw.id,
    name: raw.name,
    shortCode: raw.shortCode,
    flagUrl: raw.flagUrl,
  };
}

function normalizeFixture(raw: RawFixture): NormalizedFixture {
  return {
    providerMatchId: raw.id,
    homeTeam: normalizeTeam(raw.homeTeam),
    awayTeam: normalizeTeam(raw.awayTeam),
    stage: raw.stage,
    groupId: raw.groupId,
    kickoffUtc: raw.kickoffUtc,
    venue: raw.venue,
    status: raw.status,
  };
}

function normalizeResult(
  raw: RawResult,
  providerMatchId: string,
): NormalizedResult {
  return {
    providerMatchId,
    homeScoreOfficial: raw.homeScoreOfficial,
    awayScoreOfficial: raw.awayScoreOfficial,
    homeScoreForScoring: raw.homeScoreForScoring,
    awayScoreForScoring: raw.awayScoreForScoring,
    resultStatus: raw.resultStatus,
  };
}

function inWindow(iso: string, window: SyncWindow): boolean {
  if (window.fromUtc !== null && iso < window.fromUtc) return false;
  if (window.toUtc !== null && iso > window.toUtc) return false;
  return true;
}

// ============================================================================
// Adapter — plain object literal (deliberately different from stub2's class)
// ============================================================================

export const stubAdapter: MatchDataProviderAdapter = {
  name: "stub",

  async fetchFixtures(window: SyncWindow): Promise<NormalizedFixture[]> {
    const raws = await readSnapshot();
    return raws
      .filter((r) => inWindow(r.kickoffUtc, window))
      .map(normalizeFixture);
  },

  async fetchResults(window: SyncWindow): Promise<NormalizedResult[]> {
    const raws = await readSnapshot();
    // Per contract: only emit rows whose status indicates the score is
    // final. The coordinator additionally cross-checks against
    // matches.status to reject score-before-finished anomalies (R-005).
    return raws
      .filter(
        (r) =>
          (r.status === "finished" ||
            r.status === ("penalties_shootout" as NormalizedFixture["status"])) &&
          r.result !== null &&
          inWindow(r.kickoffUtc, window),
      )
      .map((r) => normalizeResult(r.result as RawResult, r.id));
  },

  async fetchTeams(): Promise<NormalizedTeam[]> {
    const raws = await readSnapshot();
    // De-duplicate by providerTeamId — the flat fixture shape mentions each
    // team once per match it plays. Insertion order is preserved by Map.
    const seen = new Map<string, NormalizedTeam>();
    for (const r of raws) {
      if (!seen.has(r.homeTeam.id)) seen.set(r.homeTeam.id, normalizeTeam(r.homeTeam));
      if (!seen.has(r.awayTeam.id)) seen.set(r.awayTeam.id, normalizeTeam(r.awayTeam));
    }
    return Array.from(seen.values());
  },

  // Slice 004 / T031 / contracts/players-ingest.md § Producer.
  // Slice 002 reserved fetchPlayers? as optional on the locked
  // MatchDataProviderAdapter interface; this slice activates it. The stub
  // reads ./fixtures/wc2026-players.json (a sibling-file 16-row roster
  // mirroring the slice-004 fixture UUIDs / team affiliations) and
  // normalizes to NormalizedPlayer per types.ts § Reserved for Slice 004.
  // Local-only — no network, no module-level cache (fresh read per call
  // mirrors stub's stateless matches-fetch style).
  async fetchPlayers(): Promise<NormalizedPlayer[]> {
    const raws = await readPlayers();
    return raws.map(normalizePlayer);
  },
};

// Default export — the static adapter registry in
// `supabase/functions/sync-catalog/` resolves `providers.active = 'stub'`
// by importing this module and reading its default export.
export default stubAdapter;
