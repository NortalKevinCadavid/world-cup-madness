/**
 * Match — cross-slice TypeScript shapes for the FIFA World Cup 2026 match
 * catalog (slice 002), mirroring the 200-OK body of `GET /api/matches`.
 *
 * @see specs/002-match-catalog/contracts/match-catalog.read.md
 * @see specs/002-match-catalog/data-model.md
 *
 * This is a **cross-slice contract** (Constitution Principle XI):
 * - Additive fields (e.g. a new optional `Match` field) are allowed.
 * - Renames or removals require a coordinated change set across slices
 *   003 (prediction display), 004 (final-prediction validation), and
 *   005 (leaderboard breakdown), which all import from this module.
 */

/**
 * Tournament stage of a match. Mirrors the `match_stage` enum defined in
 * the slice 002 migration. Knockout stages flow `r16` → `qf` → `sf` →
 * `final` / `third_place`.
 */
export type MatchStage =
  | 'group'
  | 'r16'
  | 'qf'
  | 'sf'
  | 'final'
  | 'third_place';

/**
 * Lifecycle status of a match. `scheduled` until first whistle,
 * `in_progress` during play, `finished` once the official result is
 * recorded, or `postponed` / `cancelled` exceptionally. `match_result`
 * is populated only when `status = 'finished'`.
 */
export type MatchStatus =
  | 'scheduled'
  | 'in_progress'
  | 'finished'
  | 'postponed'
  | 'cancelled';

/**
 * How a match was decided. For `regulation` and `extra_time`, the
 * `_official` and `_for_scoring` score pairs are equal — the official
 * scoreboard IS the scoring score. For `penalties_shootout`, the
 * `_official` pair carries the final scoreboard (regulation + ET +
 * shootout) while `_for_scoring` carries the pre-shootout level score
 * (consumed by slice 005 leaderboard reconciliation).
 */
export type ResultStatus =
  | 'regulation'
  | 'extra_time'
  | 'penalties_shootout';

/**
 * A row of `public.teams`, embedded in `Match.home_team` / `Match.away_team`.
 * RLS exposes these fields uniformly to every eligible participant.
 */
export interface Team {
  /** `teams.id` — UUID primary key. */
  id: string;
  /** Full team display name (e.g. "Argentina"). */
  name: string;
  /** Three-letter FIFA code (e.g. "ARG"). */
  short_code: string;
  /** Public URL of the team flag asset, or NULL if not yet provided. */
  flag_url: string | null;
}

/**
 * A row of `public.match_results`, embedded as `Match.match_result` when
 * the match has finished. `null` for any non-`finished` match status.
 *
 * The dual score representation is deliberate (see `ResultStatus`):
 * - `_official` is the displayed scoreboard, including any shootout goals.
 * - `_for_scoring` is the score used for prediction reconciliation in
 *   slice 005's leaderboard breakdown. For non-shootout outcomes the
 *   two pairs are identical.
 */
export interface MatchResult {
  /** Final scoreboard, home side — includes shootout penalties when applicable. */
  home_score_official: number;
  /** Final scoreboard, away side — includes shootout penalties when applicable. */
  away_score_official: number;
  /** Slice-005 scoring input, home side (regulation + ET only). */
  home_score_for_scoring: number;
  /** Slice-005 scoring input, away side (regulation + ET only). */
  away_score_for_scoring: number;
  /** How the match was decided. */
  result_status: ResultStatus;
  /** Optional admin approval timestamp; ISO-8601 UTC. */
  approved_at?: string | null;
}

/**
 * Per-match lock state derived server-side from `public.is_prediction_locked()`.
 *
 * Slice 003 / T032 — additive extension over the slice 002 contract.
 * See `specs/003-match-predictions/contracts/predictions.read.md` § Additive
 * extension. UI uses this field for display gating only — the actual lock
 * decision lives in the SP `submit_prediction` server-side. The union is
 * locked at `'editable' | 'locked'`; adding a third value is a coordinated
 * contract change (Principle XI).
 */
export type LockState = 'editable' | 'locked';

/**
 * A row of `public.matches` joined with its two teams (and `match_result`
 * when finished), as returned by `GET /api/matches`. UI never queries the
 * underlying tables directly — every read flows through the route handler
 * so that RLS-aware filtering remains a single server-side surface.
 */
export interface Match {
  /** `matches.id` — UUID primary key. */
  id: string;
  /** Embedded home team (joined from `public.teams`). */
  home_team: Team;
  /** Embedded away team (joined from `public.teams`). */
  away_team: Team;
  /** Tournament stage. */
  stage: MatchStage;
  /** Group letter (`A`..`L`) for group-stage matches; NULL for knockouts. */
  group_id: string | null;
  /** Kickoff time as ISO-8601 UTC. UI localizes via `Intl.DateTimeFormat`. */
  kickoff_utc: string;
  /** Stadium name; NULL if not yet assigned. */
  venue: string | null;
  /** Lifecycle status. */
  status: MatchStatus;
  /** Result row when `status='finished'`; NULL otherwise. */
  match_result: MatchResult | null;
  /**
   * Slice 003 / additive extension — per-match lock state derived from
   * `public.is_prediction_locked()`. See `specs/003-match-predictions/
   * contracts/predictions.read.md` § Additive extension. Optional so existing
   * slice 002 consumers continue compiling; the route handler always
   * populates it after T031 ships.
   */
  lock_state?: LockState;
}

/**
 * Sort ordering accepted by `GET /api/matches`. Limited deliberately —
 * see contract § Query parameters for the rationale.
 */
export type MatchSort = 'kickoff_asc' | 'kickoff_desc';

/**
 * Client-side filter set passed to `getMatches`. Mirrors the query string
 * accepted by `GET /api/matches`. All fields are optional; multi-valued
 * filters (`stage`, `status`) accept either a single value or an array.
 *
 * @see specs/002-match-catalog/contracts/match-catalog.read.md § Query parameters
 */
export interface MatchFilters {
  /** Restrict to one or more tournament stages. */
  stage?: MatchStage | MatchStage[];
  /** Restrict to a single group letter (`A`..`L`). */
  group?: string;
  /** Restrict to one or more lifecycle statuses. */
  status?: MatchStatus | MatchStatus[];
  /** Restrict to matches involving the supplied team (home OR away). */
  team_id?: string;
  /** Lower bound on `kickoff_utc`, inclusive. ISO-8601 UTC. */
  from?: string;
  /** Upper bound on `kickoff_utc`, exclusive. ISO-8601 UTC. */
  to?: string;
  /** 1-indexed page number. */
  page?: number;
  /** Rows per page. Server clamps to `[1, 200]`. */
  page_size?: number;
  /** Sort key; defaults to `kickoff_asc`. */
  sort?: MatchSort;
}

/**
 * Paginated response envelope returned by `GET /api/matches`.
 *
 * @see specs/002-match-catalog/contracts/match-catalog.read.md § 200 OK
 */
export interface MatchesPage {
  /** Matches on the current page, ordered by `sort` (default kickoff asc). */
  matches: Match[];
  /** 1-indexed current page number, echoed from the request. */
  page: number;
  /** Page size actually applied (after server-side clamping). */
  page_size: number;
  /** Total matching rows across all pages. */
  total: number;
}
