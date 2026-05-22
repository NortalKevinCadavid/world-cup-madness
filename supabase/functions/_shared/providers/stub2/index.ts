/**
 * Slice 002 / T025 — stub2 adapter.
 *
 * Purpose: a SECOND contract-compliant adapter used ONLY by
 * `supabase/functions/sync-catalog/tests/provider_swap.test.ts` to prove
 * SC-005: swapping `tournament_config.providers.active` from `'stub'` to
 * `'stub2'` produces byte-identical `matches` rows with no source change
 * outside this directory.
 *
 * This adapter is DELIBERATELY written in a DIFFERENT internal style than
 * the canonical stub (T030):
 *   - class-based instance instead of a plain object literal
 *   - nested fixture JSON (`{ teams: [...], matches: [...] }`) keyed by
 *     team ref id, joined at normalization time, vs the stub's flat
 *     self-contained match-row shape
 *   - explicit field-by-field copy in a private helper (`#normalizeOne`)
 *     vs the stub's generic mapper
 *   - eager full-fixture read in the constructor (lazy-cached) instead of
 *     a fresh read per call
 *
 * The point of the divergence is to prove the contract is the surface area
 * — internal style does not leak into the catalog rows the coordinator
 * UPSERTs.
 *
 * Contract source of truth: ../types.ts (T011, LOCKED).
 * Spec: specs/002-match-catalog/spec.md § SC-005.
 *
 * NOT used in production. The static adapter registry inside the sync
 * coordinator (T032) wires `name === 'stub2'` to this module ONLY for the
 * swap test; flipping `tournament_config.providers.active` to `'stub2'`
 * outside that test is unsupported.
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
// Provider-shape types (this adapter's INTERNAL JSON layout — nested)
// ============================================================================

interface ProviderTeam {
  providerTeamId: string;
  name: string;
  shortCode: string;
  flagUrl: string | null;
}

interface ProviderMatchRef {
  providerMatchId: string;
  homeTeamRef: string;
  awayTeamRef: string;
  stage: NormalizedFixture["stage"];
  groupId: string | null;
  kickoffUtc: string;
  venue: string | null;
  status: NormalizedFixture["status"];
}

interface ProviderSnapshot {
  teams: ProviderTeam[];
  matches: ProviderMatchRef[];
}

// ============================================================================
// Adapter implementation (class form — deliberately different from stub)
// ============================================================================

class Stub2Adapter implements MatchDataProviderAdapter {
  readonly name = "stub2";

  #snapshotCache: ProviderSnapshot | null = null;
  #teamIndexCache: Map<string, ProviderTeam> | null = null;

  // -------------------------------------------------------------------------
  // Public contract methods
  // -------------------------------------------------------------------------

  async fetchFixtures(window: SyncWindow): Promise<NormalizedFixture[]> {
    const snapshot = await this.#loadSnapshot();
    const all = snapshot.matches.map((m) => this.#normalizeOne(m));
    return this.#applyWindow(all, window);
  }

  async fetchResults(_window: SyncWindow): Promise<NormalizedResult[]> {
    // Stub2 fixture set has no finished matches (all 'scheduled'), so the
    // contract's filter (only return rows whose status indicates a final
    // score) yields the empty set. This mirrors the stub's behavior and
    // keeps the swap-test focused on the matches table.
    return [];
  }

  async fetchTeams(): Promise<NormalizedTeam[]> {
    const snapshot = await this.#loadSnapshot();
    // Explicit field-by-field copy (vs a generic pick) — same reason as
    // #normalizeOne below: makes the contract surface explicit at the
    // boundary even when it is the trivial identity.
    return snapshot.teams.map((t) => ({
      providerTeamId: t.providerTeamId,
      name: t.name,
      shortCode: t.shortCode,
      flagUrl: t.flagUrl,
    }));
  }

  // fetchPlayers is the optional Slice 004 method; deliberately not
  // implemented here. The interface's `?` marker means TypeScript treats
  // the absence as contract-compliant.

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  async #loadSnapshot(): Promise<ProviderSnapshot> {
    if (this.#snapshotCache !== null) return this.#snapshotCache;

    const url = new URL("./fixtures/wc2026-snapshot.json", import.meta.url);
    const raw = await Deno.readTextFile(url);
    const parsed = JSON.parse(raw) as ProviderSnapshot;

    this.#snapshotCache = parsed;
    this.#teamIndexCache = new Map(
      parsed.teams.map((t) => [t.providerTeamId, t] as const),
    );
    return parsed;
  }

  #lookupTeam(ref: string): ProviderTeam {
    const idx = this.#teamIndexCache;
    if (idx === null) {
      throw new Error(
        "stub2: team index not initialized — loadSnapshot must run first",
      );
    }
    const t = idx.get(ref);
    if (t === undefined) {
      throw new Error(`stub2: unknown team ref '${ref}' in fixture`);
    }
    return t;
  }

  /**
   * Field-by-field normalization. Deliberately spelled out (vs a generic
   * pick) so the contract surface is explicit at the boundary. The join
   * from team ref → full NormalizedTeam happens here.
   */
  #normalizeOne(m: ProviderMatchRef): NormalizedFixture {
    const home = this.#lookupTeam(m.homeTeamRef);
    const away = this.#lookupTeam(m.awayTeamRef);
    return {
      providerMatchId: m.providerMatchId,
      homeTeam: {
        providerTeamId: home.providerTeamId,
        name: home.name,
        shortCode: home.shortCode,
        flagUrl: home.flagUrl,
      },
      awayTeam: {
        providerTeamId: away.providerTeamId,
        name: away.name,
        shortCode: away.shortCode,
        flagUrl: away.flagUrl,
      },
      stage: m.stage,
      groupId: m.groupId,
      kickoffUtc: m.kickoffUtc,
      venue: m.venue,
      status: m.status,
    };
  }

  #applyWindow(
    fixtures: NormalizedFixture[],
    window: SyncWindow,
  ): NormalizedFixture[] {
    if (window.fromUtc === null && window.toUtc === null) return fixtures;
    return fixtures.filter((f) => {
      if (window.fromUtc !== null && f.kickoffUtc < window.fromUtc) return false;
      if (window.toUtc !== null && f.kickoffUtc > window.toUtc) return false;
      return true;
    });
  }
}

// Default export — the static adapter registry in
// `supabase/functions/sync-catalog/` resolves `providers.active = 'stub2'`
// by importing this module and reading its default export.
const stub2Adapter: MatchDataProviderAdapter = new Stub2Adapter();
export default stub2Adapter;

// Also export the class so the swap test can construct a fresh instance
// (e.g., to clear the snapshot cache between runs) if needed.
export { Stub2Adapter };

// Suppress unused-import lints for type-only imports the test surface may
// reach for via this barrel.
export type { NormalizedFixture, NormalizedPlayer, NormalizedResult, NormalizedTeam };
