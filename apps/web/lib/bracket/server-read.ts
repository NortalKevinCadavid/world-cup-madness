import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BracketResponse, BracketStatus, BracketTeam } from './types';

// Slice 010 — shared server-side bracket read used by both
// `GET /api/bracket` (T015) and the `/bracket` page (T016). Assembles the
// contract shape from `bracket_v` (matchups, self-RLS-scoped) +
// `bracket_status` (single source of truth) + a `teams` lookup.

interface BracketVRow {
  matchup_id: string;
  round: BracketResponse['matchups'][number]['round'];
  position: number;
  team_a_id: string | null;
  team_b_id: string | null;
  winner_team_id: string | null;
  next_matchup_id: string | null;
  next_slot: 'A' | 'B' | null;
}

export async function readOwnBracket(
  supabase: SupabaseClient,
  participantId: string,
): Promise<BracketResponse> {
  const { data: rows, error: rowsErr } = await supabase
    .from('bracket_v')
    .select(
      'matchup_id, round, position, team_a_id, team_b_id, winner_team_id, next_matchup_id, next_slot',
    )
    .order('round', { ascending: true })
    .order('position', { ascending: true });
  if (rowsErr) throw new Error(`bracket_v read failed: ${rowsErr.message}`);

  const { data: statusData, error: statusErr } = await supabase.rpc(
    'bracket_status',
    { p_participant_id: participantId },
  );
  if (statusErr) throw new Error(`bracket_status failed: ${statusErr.message}`);
  const status = (Array.isArray(statusData) ? statusData[0] : statusData) as
    BracketResponse['status'];

  const { data: teamRows, error: teamsErr } = await supabase
    .from('teams')
    .select('id, name, short_code, flag_url');
  if (teamsErr) throw new Error(`teams read failed: ${teamsErr.message}`);

  const teamById = new Map<string, BracketTeam>(
    (teamRows ?? []).map((t) => [t.id as string, t as BracketTeam]),
  );
  const team = (id: string | null) => (id ? teamById.get(id) ?? null : null);

  const matchups = ((rows ?? []) as BracketVRow[]).map((m) => ({
    id: m.matchup_id,
    round: m.round,
    position: m.position,
    team_a: team(m.team_a_id),
    team_b: team(m.team_b_id),
    winner_team_id: m.winner_team_id,
    next_matchup_id: m.next_matchup_id,
    next_slot: m.next_slot,
  }));

  return { matchups, status };
}

export interface PeerBracket {
  participant: { id: string; display_name: string };
  matchups: BracketResponse['matchups'];
  status: BracketStatus;
}

interface PeerVRow {
  participant_id: string;
  display_name: string;
  matchup_id: string;
  round: BracketResponse['matchups'][number]['round'];
  position: number;
  team_a_id: string | null;
  team_b_id: string | null;
  winner_team_id: string | null;
  next_matchup_id: string | null;
  next_slot: 'A' | 'B' | null;
  submission_status: BracketStatus['submission_status'];
}

// Reads another participant's bracket via `bracket_peer_v`. The view owns the
// visibility gate (DEFINER + lock + self-exclusion, migration 0091): pre-lock,
// self, unknown, or hidden all yield zero rows → this returns null (non-leak).
export async function readPeerBracket(
  supabase: SupabaseClient,
  participantId: string,
): Promise<PeerBracket | null> {
  const { data: rows, error } = await supabase
    .from('bracket_peer_v')
    .select(
      'participant_id, display_name, matchup_id, round, position, team_a_id, team_b_id, winner_team_id, next_matchup_id, next_slot, submission_status',
    )
    .eq('participant_id', participantId)
    .order('round', { ascending: true })
    .order('position', { ascending: true });
  if (error) throw new Error(`bracket_peer_v read failed: ${error.message}`);

  const peerRows = (rows ?? []) as PeerVRow[];
  if (peerRows.length === 0) return null;

  const { data: teamRows, error: teamsErr } = await supabase
    .from('teams')
    .select('id, name, short_code, flag_url');
  if (teamsErr) throw new Error(`teams read failed: ${teamsErr.message}`);
  const teamById = new Map<string, BracketTeam>(
    (teamRows ?? []).map((t) => [t.id as string, t as BracketTeam]),
  );
  const team = (id: string | null) => (id ? teamById.get(id) ?? null : null);

  const matchups = peerRows.map((m) => ({
    id: m.matchup_id,
    round: m.round,
    position: m.position,
    team_a: team(m.team_a_id),
    team_b: team(m.team_b_id),
    winner_team_id: m.winner_team_id,
    next_matchup_id: m.next_matchup_id,
    next_slot: m.next_slot,
  }));

  const completed = peerRows.filter((m) => m.winner_team_id !== null).length;
  return {
    participant: { id: peerRows[0].participant_id, display_name: peerRows[0].display_name },
    matchups,
    status: {
      total_required: peerRows.length,
      completed,
      is_complete: completed === peerRows.length,
      missing_matchup_ids: peerRows.filter((m) => m.winner_team_id === null).map((m) => m.matchup_id),
      submission_status: peerRows[0].submission_status,
    },
  };
}
