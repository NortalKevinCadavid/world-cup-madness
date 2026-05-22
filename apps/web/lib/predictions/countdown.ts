/**
 * Display-only countdown helper for the prediction-entry UI.
 *
 * This function does NOT make any lock decisions — it formats the time
 * remaining for the participant. The authoritative editable/locked check
 * lives in Postgres via `public.is_prediction_locked()` and is surfaced
 * to the client through `Match.lock_state` (see Slice 003 § R-005).
 *
 * Pure function: callers pass `now` explicitly so tests are
 * deterministic and SSR + client renders agree. Browser-safe — no `node:`
 * imports, no Next.js imports, no `server-only`.
 *
 * @see specs/003-match-predictions/research.md § R-005
 *
 * @param kickoffUtc        ISO-8601 UTC timestamp of kickoff.
 * @param lockWindowMinutes Minutes-before-kickoff threshold from
 *                          `public.tournament_config.lock_window_minutes`
 *                          (read once, passed in by the caller).
 * @param now               Current time. Inject for testability.
 * @returns A short display string:
 *            - `"locked"` when `now >= kickoff - lockWindow`
 *            - `"locks in N min"` when remaining < 60 minutes
 *            - `"locks in Hh Mm"` (or `"locks in Hh"`) otherwise.
 */
export function formatRemainingUntilLock(
  kickoffUtc: string,
  lockWindowMinutes: number,
  now: Date,
): string {
  const kickoffMs = new Date(kickoffUtc).getTime();
  const lockBoundaryMs = kickoffMs - lockWindowMinutes * 60_000;
  const remainingMs = lockBoundaryMs - now.getTime();

  // Boundary is inclusive on the locked side (BR-LOCK-003): exactly AT the
  // lock boundary the match is already locked, mirroring
  // `public.is_prediction_locked()` semantics.
  if (remainingMs <= 0) return 'locked';

  // Round UP so "30 seconds left" still says "locks in 1 min" rather than
  // misleadingly hitting zero a beat early.
  const remainingMin = Math.ceil(remainingMs / 60_000);

  if (remainingMin < 60) return `locks in ${remainingMin} min`;

  const hours = Math.floor(remainingMin / 60);
  const mins = remainingMin % 60;
  if (mins === 0) return `locks in ${hours}h`;
  return `locks in ${hours}h ${mins}m`;
}
