/**
 * Display-only countdown helper for the final-predictions picker UI.
 *
 * This function does NOT make any lock decisions — it formats the time
 * remaining for the participant. The authoritative editable/locked check
 * lives in Postgres via `public.is_final_prediction_locked()` and is
 * surfaced to the client through `MeFinalPredictionsResponse.lock_state`
 * (see `final-predictions.read.md` § Response).
 *
 * Pure function: callers pass `now` explicitly so tests are deterministic
 * and SSR + client renders agree. Browser-safe — no `node:` imports, no
 * Next.js imports, no `server-only`.
 *
 * Unlike Slice 003's match-level countdown, the final-predictions lock
 * boundary is *strictly* `first_kickoff_utc` itself (BR-LOCK-005) — there
 * is no separate "lock window" offset. When the tournament has not yet
 * scheduled match #1, `first_kickoff_utc` is null and the UI renders an
 * indeterminate `'unscheduled'` indicator rather than a numeric count.
 *
 * @see specs/004-final-predictions/contracts/final-predictions.read.md
 *
 * @param firstKickoffUtc ISO-8601 UTC kickoff of match #1, or `null` when
 *                        the tournament config has not yet set it.
 * @param now             Current time. Inject for testability.
 * @returns A short display string:
 *            - `"unscheduled"` when `firstKickoffUtc === null`.
 *            - `"locked"` when `now >= firstKickoffUtc`.
 *            - `"locks in N min"` when remaining < 60 minutes.
 *            - `"locks in Dd Hh"` when at least one full day remains.
 *            - `"locks in Hh"` otherwise.
 */
export function formatRemainingUntilFirstKickoff(
  firstKickoffUtc: string | null,
  now: Date,
): string {
  if (firstKickoffUtc === null) return 'unscheduled';

  const target = new Date(firstKickoffUtc).getTime();
  const remainingMs = target - now.getTime();

  // BR-LOCK-005: the boundary is inclusive on the locked side — exactly
  // AT `first_kickoff_utc` the picker is already locked, mirroring
  // `public.is_final_prediction_locked()` semantics.
  if (remainingMs <= 0) return 'locked';

  // Round UP so "30 seconds left" still says "locks in 1 min" rather than
  // misleadingly hitting zero a beat early.
  const totalMinutes = Math.ceil(remainingMs / 60_000);

  if (totalMinutes < 60) return `locks in ${totalMinutes} min`;

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);

  if (days > 0) return `locks in ${days}d ${hours}h`;
  return `locks in ${hours}h`;
}
