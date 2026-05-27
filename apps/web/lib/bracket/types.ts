// Slice 010 / T013 — shared transport/display types for the bracket UI.
// These mirror the contract shapes in
// specs/010-bracket-team-selection/contracts/*. They are display/transport
// types only and are NOT the completeness authority (the server's
// bracket_status is the source of truth — Constitution III / FR-014).

export type BracketRound = "r32" | "r16" | "qf" | "sf" | "final";

export type BracketSubmissionStatus =
  | "draft"
  | "complete"
  | "submitted"
  | "locked";

export interface BracketTeam {
  id: string;
  name: string;
  short_code: string;
  flag_url: string | null;
}

export interface BracketMatchup {
  id: string;
  round: BracketRound;
  position: number;
  /** null when the competitor is not yet resolved (pending) — FR-007. */
  team_a: BracketTeam | null;
  team_b: BracketTeam | null;
  /** the caller's picked winner for this matchup; null if unpicked. */
  winner_team_id: string | null;
  next_matchup_id: string | null;
  next_slot: "A" | "B" | null;
}

export interface BracketStatus {
  total_required: number;
  completed: number;
  is_complete: boolean;
  missing_matchup_ids: string[];
  submission_status: BracketSubmissionStatus;
}

export interface BracketResponse {
  matchups: BracketMatchup[];
  status: BracketStatus;
}

/** Round display order + labels (i18n keys resolved in the components). */
export const ROUND_ORDER: BracketRound[] = ["r32", "r16", "qf", "sf", "final"];

/** Maps each round to its `Bracket.*` i18n message key (single source). */
export const ROUND_LABEL_KEY: Record<BracketRound, string> = {
  r32: "roundR32",
  r16: "roundR16",
  qf: "roundQf",
  sf: "roundSf",
  final: "roundFinal",
};
