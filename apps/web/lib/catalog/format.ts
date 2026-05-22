/**
 * Browser- and server-safe formatting helpers for the slice 002 match
 * catalog. Deliberately free of `server-only` so React Server Components,
 * client components, and `node:test` unit tests can all consume the same
 * implementation.
 *
 * @see specs/002-match-catalog/contracts/match-catalog.read.md
 * @see specs/002-match-catalog/research.md (R-009 Intl.DateTimeFormat)
 *
 * Constitution: III (UI is presentation only — formatting never mutates
 * the underlying UTC payload), VI (locale only on display).
 */

import type { MatchResult } from '../types/match';

/**
 * Render an ISO-8601 UTC kickoff timestamp in the supplied BCP-47 locale.
 *
 * The output is intentionally produced from a UTC source with
 * `timeZone: 'UTC'` so that:
 * - Test assertions are deterministic across CI hosts (R-009).
 * - The participant sees the same kickoff regardless of their device
 *   clock skew. (Slice 005's per-user timezone preference will layer on
 *   top of this helper via a different formatter — out of scope here.)
 *
 * @param utcIso  ISO-8601 timestamp in UTC (e.g. `"2026-06-11T20:00:00Z"`).
 * @param locale  BCP-47 locale tag (e.g. `"en-US"`, `"es-ES"`, `"ja-JP"`).
 * @returns Localized medium-date short-time string.
 */
export function formatKickoff(utcIso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(utcIso));
}

/**
 * Render a `MatchResult` as a compact display string.
 *
 * - `regulation` / `extra_time` → `"H-A"` using the `_official` scores
 *   (which equal the `_for_scoring` scores by definition for these
 *   statuses).
 * - `penalties_shootout` → `"H-A (levelH-levelA on penalties)"`, where
 *   `H-A` is the official scoreboard (includes the shootout goals) and
 *   `levelH-levelA` is the pre-shootout level score from `_for_scoring`.
 *
 * @param r  Finished-match result row.
 * @returns Display string suitable for catalog rendering.
 */
export function formatScore(r: MatchResult): string {
  const official = `${r.home_score_official}-${r.away_score_official}`;
  if (r.result_status === 'penalties_shootout') {
    const level = `${r.home_score_for_scoring}-${r.away_score_for_scoring}`;
    return `${official} (${level} on penalties)`;
  }
  return official;
}
