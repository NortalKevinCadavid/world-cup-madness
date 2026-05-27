// Slice 010 / T038 (US5) — client-side mirror of the bracket_status shape for
// INSTANT in-progress display between server reads. Display-only: the server's
// bracket_status (read/submit endpoints) is the submission authority (Principle
// III / FR-014). Every client surface (header, mobile footer, badge, submit
// button, review) derives counts from THIS one function so they never disagree.

import type { BracketMatchup } from "./types";

export interface DerivedBracketCounts {
  total_required: number;
  completed: number;
  is_complete: boolean;
  missing_matchup_ids: string[];
}

export function deriveBracketCounts(matchups: BracketMatchup[]): DerivedBracketCounts {
  const total = matchups.length;
  const missing = matchups.filter((m) => m.winner_team_id === null).map((m) => m.id);
  const completed = total - missing.length;
  return {
    total_required: total,
    completed,
    is_complete: total > 0 && completed === total,
    missing_matchup_ids: missing,
  };
}
