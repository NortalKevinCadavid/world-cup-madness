// Slice 010 / T020 — client-side cascade mirror (R-005 / FR-006).
//
// Pure, I/O-free. Given the matchup tree + the caller's current picks (a
// matchupId → winnerTeamId map), returns the set of matchup ids whose pick is
// now IMPOSSIBLE (winner no longer a resolved competitor), iterating to a
// fixpoint. This is for INSTANT optimistic UX only — the server
// (bracket_clear_invalid_picks) is the authority; the client reconciles with
// the server's returned cleared_matchup_ids.

import type { BracketMatchup } from "./types";

type PickMap = Record<string, string | undefined>; // matchupId -> winnerTeamId

/** Resolve a matchup's two competitors from seeds + upstream winner picks. */
function resolveCompetitors(
  matchup: BracketMatchup,
  matchups: BracketMatchup[],
  picks: PickMap,
): [string | null, string | null] {
  // R32 (and any matchup with stored competitors) use the seed directly.
  let a: string | null = matchup.team_a?.id ?? null;
  let b: string | null = matchup.team_b?.id ?? null;
  if (a !== null && b !== null) return [a, b];

  for (const u of matchups) {
    if (u.next_matchup_id === matchup.id) {
      const w = picks[u.id] ?? null;
      if (u.next_slot === "A") a = a ?? w;
      else if (u.next_slot === "B") b = b ?? w;
    }
  }
  return [a, b];
}

/**
 * Compute the matchup ids whose pick is invalid given `picks`, to fixpoint.
 * `picks` should already include the just-applied change.
 */
export function computeClearedMatchups(
  matchups: BracketMatchup[],
  picks: PickMap,
): string[] {
  const working: PickMap = { ...picks };
  const cleared = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const m of matchups) {
      const winner = working[m.id];
      if (!winner) continue;
      const [a, b] = resolveCompetitors(m, matchups, working);
      if (winner !== a && winner !== b) {
        delete working[m.id];
        cleared.add(m.id);
        changed = true;
      }
    }
  }
  return Array.from(cleared);
}
