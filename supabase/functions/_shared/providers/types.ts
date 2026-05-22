/**
 * MatchDataProviderAdapter — LOCKED cross-slice contract (Slice 002 / T011).
 *
 * Source of truth: specs/002-match-catalog/contracts/provider-adapter.contract.md
 *
 * Every concrete adapter under supabase/functions/_shared/providers/<name>/
 * implements this interface. Adding a provider is a one-file change: a new
 * module under that directory that default-exports an instance satisfying
 * MatchDataProviderAdapter.
 *
 * Adapters MUST NOT touch Postgres. They convert provider responses into
 * the Normalized* types and return them. The sync coordinator
 * (supabase/functions/sync-catalog/) owns transactions, audit, idempotency.
 *
 * Body / additive changes (new optional methods, new optional fields) are
 * non-breaking. Removing or renaming a method/field is a contract break
 * per Constitution Principle XI — coordinated across every adapter.
 */

// ============================================================================
// Interface
// ============================================================================

export interface MatchDataProviderAdapter {
  /**
   * Stable identifier for this adapter, e.g. "footballdata". Used as
   * provider_sync_runs.provider and match_provider_external_ids.provider.
   */
  readonly name: string;

  /**
   * Fetch fixtures for a given window. Adapters that cannot filter
   * server-side MAY ignore the window and return the full set; the
   * coordinator filters post-hoc.
   *
   * @throws ProviderTransientError on 5xx / network failures (retryable)
   * @throws ProviderRateLimitedError on 429 (honor retryAfterMs)
   * @throws ProviderClientError on 4xx other than 429 (non-retryable)
   */
  fetchFixtures(window: SyncWindow): Promise<NormalizedFixture[]>;

  /**
   * Fetch confirmed results. Only returns rows for matches whose status
   * indicates the score is final (finished / penalties_shootout). Adapters
   * filter out half-finished matches; the coordinator additionally
   * cross-checks against matches.status to reject score-before-finished
   * anomalies (R-005).
   */
  fetchResults(window: SyncWindow): Promise<NormalizedResult[]>;

  /**
   * Fetch team metadata. Called rarely (team set is largely fixed before
   * the tournament). The coordinator may skip calling this if team rows
   * are already populated and the provider has no incremental team feed.
   */
  fetchTeams(): Promise<NormalizedTeam[]>;

  /**
   * Optional. Adapters that can resolve player metadata implement this.
   * Slice 002 does NOT call it; Slice 004 (Final Predictions) does. The
   * signature is reserved here so adapters can ship the capability before
   * Slice 004 begins.
   */
  fetchPlayers?(): Promise<NormalizedPlayer[]>;
}

// ============================================================================
// Window
// ============================================================================

/**
 * Time window for fixture/result fetches. Adapters MAY treat null bounds
 * as "no limit" — the coordinator passes the relevant window per the
 * three-tier cadence (Clarifications 2026-05-15 Q1).
 */
export interface SyncWindow {
  /** ISO-8601 UTC. Inclusive lower bound. null = no lower limit. */
  fromUtc: string | null;
  /** ISO-8601 UTC. Inclusive upper bound. null = no upper limit. */
  toUtc: string | null;
}

// ============================================================================
// Normalized payloads
// ============================================================================

/**
 * Normalized fixture — what the coordinator UPSERTs into matches.
 * Stage + status values are the canonical short codes per data-model.md
 * § Entity 2.
 */
export interface NormalizedFixture {
  /** Adapter's native ID; mapped via match_provider_external_ids. */
  providerMatchId: string;
  /** Full team payload; coordinator UPSERTs teams first. */
  homeTeam: NormalizedTeam;
  awayTeam: NormalizedTeam;
  stage: 'group' | 'r16' | 'qf' | 'sf' | 'final' | 'third_place';
  /** 'A'..'L' for group-stage; null for knockout. */
  groupId: string | null;
  /** ISO-8601 UTC. */
  kickoffUtc: string;
  venue: string | null;
  status: 'scheduled' | 'in_progress' | 'finished' | 'postponed' | 'cancelled';
}

/**
 * Normalized result — what the coordinator INSERTs into match_results.
 *
 * The coordinator enforces the contract invariants
 *   homeScoreForScoring <= homeScoreOfficial
 *   awayScoreForScoring <= awayScoreOfficial
 * before INSERT. If a provider does not distinguish official vs for-scoring
 * (e.g., shootout encoding varies), the adapter MUST compute the split:
 * for 'regulation' / 'extra_time' results, for-scoring equals official; for
 * 'penalties_shootout', for-scoring equals the level score before the
 * shootout (penalties decide the winner but do not count as goals scored).
 */
export interface NormalizedResult {
  providerMatchId: string;
  /** Official goal count (regulation + extra time + shootout if applicable). */
  homeScoreOfficial: number;
  awayScoreOfficial: number;
  /** Goals counted for scoring (regulation + extra time only). */
  homeScoreForScoring: number;
  awayScoreForScoring: number;
  resultStatus: 'regulation' | 'extra_time' | 'penalties_shootout';
}

/**
 * Normalized team payload. shortCode is the 3-letter FIFA code (/^[A-Z]{3}$/).
 */
export interface NormalizedTeam {
  providerTeamId: string;
  name: string;
  shortCode: string;
  flagUrl: string | null;
}

/**
 * Reserved for Slice 004 (Final Predictions). Defined here so adapters can
 * ship the capability before Slice 004 begins; this slice never calls
 * fetchPlayers().
 */
export interface NormalizedPlayer {
  providerPlayerId: string;
  fullName: string;
  /** Links via the team-side mapping table. null if unattached. */
  teamProviderId: string | null;
  /** Aliases for manual disambiguation. */
  aliases: string[];
}

// ============================================================================
// Error taxonomy
// ============================================================================

/**
 * Provider error classes. Adapters MUST map provider HTTP responses to
 * one of these; the coordinator branches retry behavior off the
 * `retryable` discriminator (R-007).
 */

export class ProviderTransientError extends Error {
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTransientError';
  }
}

export class ProviderRateLimitedError extends Error {
  readonly retryable = true as const;
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'ProviderRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderClientError extends Error {
  readonly retryable = false as const;
  constructor(message: string) {
    super(message);
    this.name = 'ProviderClientError';
  }
}
