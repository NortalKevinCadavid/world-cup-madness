/**
 * football-data.org provider adapter (Slice 002 / T031).
 *
 * Implements MatchDataProviderAdapter against football-data.org API v4.
 * See:
 *   - specs/002-match-catalog/contracts/provider-adapter.contract.md
 *   - docs/architecture/high-level-architecture.md § 18.2
 *
 * Contract responsibilities:
 *   - Map HTTP responses to the error taxonomy (no other error types escape).
 *   - Return Normalized* payloads — no Postgres reads/writes.
 *   - No retries (the coordinator owns retry policy per R-007).
 *   - No module-level credential caching (Deno.env.get on each call).
 *
 * Slice deviation (documented):
 *   The task body asks for `base_url` to be read from
 *   `tournament_config.provider.footballdata.base_url`. Reading it from the DB
 *   inside the adapter would (a) require a DB client in a layer that the
 *   contract forbids from touching Postgres and (b) impose a query per call.
 *   We compromise by reading the base URL from FOOTBALLDATA_BASE_URL env (set
 *   at function deploy time from tournament_config). This preserves the
 *   "no DB in adapter" invariant while still keeping the URL admin-controlled.
 *   Defaults to the public v4 endpoint when the env var is absent.
 *
 * Slice 004 owns fetchPlayers — intentionally not implemented here.
 */

import type {
  MatchDataProviderAdapter,
  NormalizedFixture,
  NormalizedResult,
  NormalizedTeam,
  SyncWindow,
} from '../types.ts';
import {
  ProviderClientError,
  ProviderRateLimitedError,
  ProviderTransientError,
} from '../types.ts';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_BASE_URL = 'https://api.football-data.org/v4';

/**
 * Resolve the base URL on every call (no module-level cache). Set
 * FOOTBALLDATA_BASE_URL at function deploy time from
 * tournament_config.provider.footballdata.base_url.
 */
function getBaseUrl(): string {
  return Deno.env.get('FOOTBALLDATA_BASE_URL') ?? DEFAULT_BASE_URL;
}

/**
 * Resolve the API token on every call (no module-level cache, per
 * task constraint).
 */
function getApiToken(): string {
  const t = Deno.env.get('FOOTBALLDATA_API_TOKEN');
  if (!t) throw new ProviderClientError('FOOTBALLDATA_API_TOKEN env missing');
  return t;
}

// ============================================================================
// HTTP — single chokepoint that enforces the error taxonomy
// ============================================================================

/**
 * Issue a GET against football-data.org and map HTTP status to the
 * provider error taxonomy:
 *   - 429              → ProviderRateLimitedError (honors Retry-After)
 *   - 5xx              → ProviderTransientError (retryable)
 *   - 4xx (not 429)    → ProviderClientError    (non-retryable)
 *   - 2xx              → parsed JSON
 */
async function call(path: string): Promise<unknown> {
  const r = await fetch(`${getBaseUrl()}${path}`, {
    headers: {
      'X-Auth-Token': getApiToken(),
      Accept: 'application/json',
    },
  });

  if (r.status === 429) {
    const retryAfter = parseInt(r.headers.get('Retry-After') ?? '0', 10);
    throw new ProviderRateLimitedError(
      `football-data rate-limited (${r.status})`,
      retryAfter > 0 ? retryAfter * 1000 : null,
    );
  }
  if (r.status >= 500) {
    throw new ProviderTransientError(`football-data 5xx: ${r.status}`);
  }
  if (r.status >= 400) {
    throw new ProviderClientError(`football-data 4xx: ${r.status}`);
  }

  return r.json();
}

// ============================================================================
// Provider response shapes
// ============================================================================

interface FootballDataTeamRef {
  id: number;
  name: string;
  tla: string;
  crest?: string | null;
}

interface FootballDataScore {
  fullTime: { home: number | null; away: number | null };
  halfTime?: { home: number | null; away: number | null };
  regularTime?: { home: number | null; away: number | null };
  extraTime?: { home: number | null; away: number | null };
  penalties?: { home: number | null; away: number | null };
  winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
  duration?: 'REGULAR' | 'EXTRA_TIME' | 'PENALTY_SHOOTOUT';
}

interface FootballDataMatch {
  id: number;
  homeTeam: FootballDataTeamRef;
  awayTeam: FootballDataTeamRef;
  utcDate: string;
  status:
    | 'TIMED'
    | 'SCHEDULED'
    | 'LIVE'
    | 'IN_PLAY'
    | 'PAUSED'
    | 'FINISHED'
    | 'POSTPONED'
    | 'SUSPENDED'
    | 'CANCELED';
  stage: string;
  group?: string | null;
  venue?: string | null;
  score?: FootballDataScore;
}

// ============================================================================
// Mapping helpers
// ============================================================================

function mapStatus(s: FootballDataMatch['status']): NormalizedFixture['status'] {
  switch (s) {
    case 'TIMED':
    case 'SCHEDULED':
      return 'scheduled';
    case 'LIVE':
    case 'IN_PLAY':
    case 'PAUSED':
      return 'in_progress';
    case 'FINISHED':
      return 'finished';
    case 'POSTPONED':
    case 'SUSPENDED':
      return 'postponed';
    case 'CANCELED':
      return 'cancelled';
  }
}

function mapStage(s: string): NormalizedFixture['stage'] {
  const u = s.toUpperCase();
  if (u.includes('GROUP')) return 'group';
  if (u.includes('ROUND_OF_16') || u.includes('LAST_16')) return 'r16';
  if (u.includes('QUARTER')) return 'qf';
  if (u.includes('SEMI')) return 'sf';
  if (u.includes('THIRD')) return 'third_place';
  if (u.includes('FINAL')) return 'final';
  return 'group'; // safe default for unknown stages
}

function mapResultStatus(
  score: FootballDataScore,
): NormalizedResult['resultStatus'] {
  if (score.duration === 'PENALTY_SHOOTOUT') return 'penalties_shootout';
  if (score.duration === 'EXTRA_TIME') return 'extra_time';
  return 'regulation';
}

function normalizeTeam(t: FootballDataTeamRef): NormalizedTeam {
  return {
    providerTeamId: String(t.id),
    name: t.name,
    shortCode: t.tla,
    flagUrl: t.crest ?? null,
  };
}

function normalizeFixture(m: FootballDataMatch): NormalizedFixture {
  return {
    providerMatchId: String(m.id),
    homeTeam: normalizeTeam(m.homeTeam),
    awayTeam: normalizeTeam(m.awayTeam),
    stage: mapStage(m.stage),
    groupId: m.group ?? null,
    kickoffUtc: m.utcDate,
    venue: m.venue ?? null,
    status: mapStatus(m.status),
  };
}

/**
 * Build a NormalizedResult for a finished match. Returns null when the
 * match has not finished or no score block is present — callers filter
 * these out.
 *
 * For-scoring split (contract § NormalizedResult):
 *   - regulation / extra_time → for-scoring == official.
 *   - penalties_shootout      → for-scoring = official - shootout goals,
 *                               i.e. the level score before penalties.
 *     Penalties decide the winner but do NOT count as goals scored.
 */
function normalizeResult(m: FootballDataMatch): NormalizedResult | null {
  if (m.status !== 'FINISHED' || !m.score) return null;

  const official_home = m.score.fullTime.home ?? 0;
  const official_away = m.score.fullTime.away ?? 0;
  const resultStatus = mapResultStatus(m.score);

  let for_scoring_home = official_home;
  let for_scoring_away = official_away;
  if (resultStatus === 'penalties_shootout') {
    const pen = m.score.penalties;
    if (pen) {
      for_scoring_home = official_home - (pen.home ?? 0);
      for_scoring_away = official_away - (pen.away ?? 0);
    }
  }

  return {
    providerMatchId: String(m.id),
    homeScoreOfficial: official_home,
    awayScoreOfficial: official_away,
    homeScoreForScoring: for_scoring_home,
    awayScoreForScoring: for_scoring_away,
    resultStatus,
  };
}

/**
 * Adapters whose upstream does not honor window filters fall back to
 * client-side filtering. football-data.org's v4 /matches endpoint
 * accepts `dateFrom`/`dateTo`, but we filter post-hoc as well to keep
 * the contract invariant: returned rows are always within the window.
 */
function inWindow(iso: string, window: SyncWindow): boolean {
  if (window.fromUtc && iso < window.fromUtc) return false;
  if (window.toUtc && iso > window.toUtc) return false;
  return true;
}

// ============================================================================
// Adapter
// ============================================================================

export const footballDataAdapter: MatchDataProviderAdapter = {
  name: 'footballdata',

  async fetchFixtures(window: SyncWindow): Promise<NormalizedFixture[]> {
    const data = (await call('/competitions/WC/matches')) as {
      matches: FootballDataMatch[];
    };
    return data.matches
      .filter((m) => inWindow(m.utcDate, window))
      .map(normalizeFixture);
  },

  async fetchResults(window: SyncWindow): Promise<NormalizedResult[]> {
    const data = (await call(
      '/competitions/WC/matches?status=FINISHED',
    )) as { matches: FootballDataMatch[] };
    return data.matches
      .filter((m) => inWindow(m.utcDate, window))
      .map(normalizeResult)
      .filter((r): r is NormalizedResult => r != null);
  },

  async fetchTeams(): Promise<NormalizedTeam[]> {
    const data = (await call('/competitions/WC/teams')) as {
      teams: FootballDataTeamRef[];
    };
    return data.teams.map(normalizeTeam);
  },

  // fetchPlayers intentionally undefined — Slice 004 owns players.
};

export default footballDataAdapter;
