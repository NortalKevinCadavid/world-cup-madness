import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Slice 005 / T036 / FR-014 / contracts/personal-breakdown.read.md.
 *
 * Thin TypeScript wrapper around the `public.personal_breakdown_v` view
 * shipped in migration 0054b (T035). Server components and API routes call
 * `getPersonalBreakdown` instead of building Supabase queries by hand so the
 * column projection and ordering stay in one place — analogous to T030's
 * `getLeaderboard` wrapper for the leaderboard view.
 *
 * READ-ONLY. No business logic — the view owns:
 *   - Decomposition into one row per (caller × finished match) + one row per
 *     scored final-prediction item (§7.2, §7.3, data-model.md § Entity 5).
 *   - Self-only filtering via security_invoker = true + a defense-in-depth
 *     caller CTE (RLS predicate mirrored at the view layer).
 *   - `official_display = NULL` for `final_pending` rows so the UI can render
 *     "scoring pending" rather than implying 0.
 *   - calculation_version filtering (R-003 reader pointer).
 *
 * The caller passes their JWT-bound Supabase client (Slice 001
 * `createServerClient` flavor). `personal_breakdown_v` is
 * `security_invoker = true`, so RLS on the underlying `score_records` /
 * `participants` tables flows through and a participant only ever sees their
 * own rows.
 *
 * SECURITY: this helper MUST NOT receive or forward the service-role key.
 *
 * @see specs/005-scoring-leaderboard/contracts/personal-breakdown.read.md
 * @see supabase/migrations/0078_personal_breakdown_view.sql
 */

export type ReasonCode =
  | 'exact'
  | 'outcome'
  | 'incorrect'
  | 'none'
  | 'final_correct'
  | 'final_incorrect'
  | 'final_pending';

export type FinalItemKind =
  | 'champion'
  | 'runner_up'
  | 'top_scorer'
  | 'best_player'
  | null;

export type TargetKind = 'match' | 'final';

export interface BreakdownRow {
  participant_id: string;
  target_kind: TargetKind;
  target_id: string;
  final_item_kind: FinalItemKind;
  target_label: string;
  /** Empty string `''` when no valid prediction was submitted. */
  predicted_display: string;
  /** `null` when `reason_code === 'final_pending'`. */
  official_display: string | null;
  points: number;
  reason_code: ReasonCode;
  calculation_version: number;
}

export interface BreakdownResponse {
  breakdown: BreakdownRow[];
  /**
   * Surfaced at the envelope level for convenience. Identical to every row's
   * `calculation_version`; zero when the view returns no rows.
   */
  calculation_version: number;
  /**
   * SUM(points) across every row. Exposed for the SC-002 cross-check
   * ("sum of breakdown rows equals leaderboard total") that US4 page-level
   * tests assert on directly via the rendered cells.
   */
  total_points: number;
}

/**
 * Fetch the caller's personal breakdown ordered by `target_kind` ASC (match
 * before final) then by `target_label` ASC. RLS (security_invoker view)
 * restricts results to the caller's own rows.
 *
 * @throws Error when the Supabase request fails (the route handler / page
 *   surface translates this into the appropriate 401 / 403 / 503 response per
 *   the contract).
 */
export async function getPersonalBreakdown(
  client: SupabaseClient,
): Promise<BreakdownResponse> {
  const { data, error } = await client
    .from('personal_breakdown_v')
    .select(
      'participant_id, target_kind, target_id, final_item_kind, target_label, predicted_display, official_display, points, reason_code, calculation_version',
    )
    .order('target_kind', { ascending: true })
    .order('target_label', { ascending: true });

  if (error) {
    throw new Error(`getPersonalBreakdown failed: ${error.message}`);
  }

  const rows = (data ?? []) as BreakdownRow[];
  const calculation_version =
    rows.length > 0 ? rows[0].calculation_version : 0;
  const total_points = rows.reduce((sum, row) => sum + row.points, 0);

  return { breakdown: rows, calculation_version, total_points };
}
