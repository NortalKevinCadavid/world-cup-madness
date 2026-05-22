import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Slice 005 / T030 / FR-013 / contracts/leaderboard.read.md.
 *
 * Thin TypeScript wrapper around the `public.leaderboard_v` view shipped in
 * migration 0054 (T029). Server components and API routes call `getLeaderboard`
 * instead of building Supabase queries by hand so the column projection and
 * ordering stay in one place.
 *
 * READ-ONLY. No business logic — the view owns:
 *   - Tier ordering (§7.4: total -> exact -> outcome -> final).
 *   - RANK() shared-rank pattern (R-004 "1, 2, 2, 4").
 *   - calculation_version filtering (R-003 reader pointer).
 *   - display_name masking per FR-014 / tournament_config.leaderboard_visibility.
 *
 * The caller passes their JWT-bound Supabase client (Slice 001
 * `createServerClient` flavor). `leaderboard_v` is `security_invoker = true`,
 * so RLS on the underlying `participants` / `score_records` tables flows
 * through and non-Nortal-domain identities see zero rows.
 *
 * SECURITY: this helper MUST NOT receive or forward the service-role key.
 *
 * @see specs/005-scoring-leaderboard/contracts/leaderboard.read.md
 * @see supabase/migrations/0054_leaderboard_views.sql
 */

export interface LeaderboardRow {
  participant_id: string;
  display_name: string;
  total_points: number;
  exact_count: number;
  outcome_count: number;
  final_points: number;
  last_valid_prediction_at: string | null;
  rank: number;
  calculation_version: number;
}

export interface LeaderboardResponse {
  leaderboard: LeaderboardRow[];
  /**
   * Surfaced at the envelope level for convenience (clients commonly need it
   * for the Realtime `postgres_changes` subscription on
   * `tournament_config.current_calculation_version`). Identical to every row's
   * `calculation_version`; zero when the view returns no rows.
   */
  calculation_version: number;
}

/**
 * Fetch the global leaderboard ordered by `rank ASC, display_name ASC`.
 *
 * The view itself encodes the §7.4 tier sequence inside `RANK() OVER (...)`,
 * so this wrapper only needs to surface the default presentational order
 * (rank ascending, display_name as a secondary stable tiebreak when rank ties).
 *
 * @throws Error when the Supabase request fails (the route handler / page
 *   surface translates this into the appropriate 401 / 403 / 503 response per
 *   the contract).
 */
export async function getLeaderboard(
  client: SupabaseClient,
): Promise<LeaderboardResponse> {
  const { data, error } = await client
    .from('leaderboard_v')
    .select(
      'participant_id, display_name, total_points, exact_count, outcome_count, final_points, last_valid_prediction_at, rank, calculation_version',
    )
    .order('rank', { ascending: true })
    .order('display_name', { ascending: true });

  if (error) {
    throw new Error(`getLeaderboard failed: ${error.message}`);
  }

  const rows = (data ?? []) as LeaderboardRow[];
  const calculation_version =
    rows.length > 0 ? rows[0].calculation_version : 0;

  return { leaderboard: rows, calculation_version };
}
