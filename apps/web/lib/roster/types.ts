/**
 * Roster — TypeScript shapes backing the team + player picker surfaces
 * introduced by Slice 004 (final predictions). Mirrors the JSON envelopes
 * documented in `specs/004-final-predictions/contracts/final-predictions.read.md`:
 *
 *   - `GET /api/teams`   → `TeamsResponse`
 *   - `GET /api/players` → `PlayersResponse`
 *
 * This module is **type-only** — no runtime side effects — and is safe to
 * import from server components, route handlers, and browser bundles.
 *
 * Cross-slice contract (Constitution Principle XI):
 *   - `Team` is re-exported from `../types/match` (Slice 002's source of
 *     truth) so the picker UI and the match catalog cannot drift. Adding
 *     a new `Team` field is additive; renames/removals are a coordinated
 *     cross-slice change.
 *   - `Player` is new in Slice 004 and locked at the field set below.
 *     Additive fields (e.g. `caps`, `birthdate`) are allowed; renames/
 *     removals require coordinating with Slices 005 (peer breakdown) and
 *     006 (admin override).
 */

import type { Team } from '../types/match';

// Re-export so callers can import everything roster-related from one
// module without reaching across to `lib/types/match`. The contract for
// `Team` itself remains owned by Slice 002.
export type { Team };

/**
 * Playing position. NULL when the upstream roster source has not yet
 * provided one (e.g. squad announced before role assignments are public).
 */
export type PlayerPosition = 'GK' | 'DF' | 'MF' | 'FW';

/**
 * A row of `public.players` joined with the player's team `short_code`,
 * as returned by `GET /api/players`. Only active players
 * (`removed_at IS NULL`) are exposed — removed players are filtered server
 * side so `target_player_id` picks always reference an in-tournament
 * roster.
 *
 * `team_id` and `team_short_code` can both be NULL when a player has not
 * yet been assigned to a tournament squad (the LEFT JOIN preserves the
 * player row). The picker UI surfaces "Unassigned" in that case.
 */
export interface Player {
  /** `players.id` — UUID primary key. */
  id: string;
  /** Full legal / FIFA registration name. */
  full_name: string;
  /** Short display name (e.g. "Messi") — NULL if not yet curated. */
  display_name: string | null;
  /** FK → `teams.id`; NULL if the player has not been assigned a squad. */
  team_id: string | null;
  /** Three-letter team code, LEFT JOIN'd by the route handler for display. */
  team_short_code: string | null;
  /** ISO 3166-1 alpha-2 country code for the player; NULL if not set. */
  country_code: string | null;
  /** Playing position; NULL when the roster source has not provided one. */
  position: PlayerPosition | null;
}

/**
 * 200-OK envelope of `GET /api/players`. `total_matching` is the count
 * BEFORE the `limit` clamp so a typeahead can render "and N more..." when
 * there are additional matches beyond the displayed slice.
 *
 * Locked field — see contract § Cross-slice contract summary.
 */
export interface PlayersResponse {
  /** Active players matching the filter, sorted by `full_name` ASC. */
  players: Player[];
  /** Total matches across the full result set, ignoring `limit`. */
  total_matching: number;
}

/**
 * 200-OK envelope of `GET /api/teams`. No pagination — the tournament
 * roster is bounded to ~32 teams.
 */
export interface TeamsResponse {
  /** All teams visible under RLS to the calling participant. */
  teams: Team[];
}
