import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  EligibilityError,
  requireEligible,
} from '../../../../lib/auth/requireEligible';
import type { BracketRound, BracketTeam } from '../../../../lib/bracket/types';

/**
 * `GET /api/bracket-peer/[participant_id]` — post-lock peer-bracket read (US4,
 * T035). Source of truth: contracts/bracket-peer.read.md.
 *
 * Thin pass-through over `public.bracket_peer_v` (migration 0091). The view
 * OWNS the visibility gate (DEFINER + lock predicate + self-exclusion, R-002);
 * this handler never re-implements it. Pre-lock the view returns zero rows for
 * ANY target → the route returns `{ bracket: null }` (non-leaking: existence,
 * owner, and contents are all indistinguishable from "hidden"). Never uses the
 * service-role key.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_CONTROL = 'no-store';

interface ErrorPayload { code: string; message: string; reason?: string }

function errorResponse(status: number, payload: ErrorPayload): NextResponse {
  return NextResponse.json(
    { error: payload },
    { status, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}

const PARAMS_SCHEMA = z.object({
  participant_id: z.string().uuid({ message: 'invalid_participant_id' }),
});

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase env not configured');
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_c: { name: string; value: string; options: CookieOptions }[]) {},
    },
  });
}

interface PeerVRow {
  participant_id: string;
  display_name: string;
  matchup_id: string;
  round: BracketRound;
  position: number;
  team_a_id: string | null;
  team_b_id: string | null;
  winner_team_id: string | null;
  next_matchup_id: string | null;
  next_slot: 'A' | 'B' | null;
  submission_status: string;
}

export async function GET(
  _request: NextRequest,
  context: { params: { participant_id: string } },
): Promise<NextResponse> {
  const paramsParse = PARAMS_SCHEMA.safeParse(context.params);
  if (!paramsParse.success) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: paramsParse.error.issues[0]?.message ?? 'invalid_participant_id',
      reason: 'invalid_participant_id',
    });
  }
  const { participant_id } = paramsParse.data;

  try {
    await requireEligible();
  } catch (err) {
    if (err instanceof EligibilityError) {
      if (err.reason === 'no_session') {
        return errorResponse(401, { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' });
      }
      if (err.reason === 'not_eligible' || err.reason === 'participant_not_provisioned') {
        return errorResponse(403, { code: 'DOMAIN_NOT_APPROVED', message: 'This application is restricted to approved Nortal corporate identities.' });
      }
    }
    return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });
  }

  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });
  }

  // The view's lock + self-exclusion predicates gate visibility. Pre-lock (or
  // self / unknown / hidden) → zero rows → { bracket: null }.
  const { data: rows, error } = await supabase
    .from('bracket_peer_v')
    .select(
      'participant_id, display_name, matchup_id, round, position, team_a_id, team_b_id, winner_team_id, next_matchup_id, next_slot, submission_status',
    )
    .eq('participant_id', participant_id)
    .order('round', { ascending: true })
    .order('position', { ascending: true });
  if (error) return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });

  const peerRows = (rows ?? []) as PeerVRow[];
  if (peerRows.length === 0) {
    return NextResponse.json({ bracket: null }, { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } });
  }

  const { data: teamRows, error: teamsErr } = await supabase
    .from('teams')
    .select('id, name, short_code, flag_url');
  if (teamsErr) return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });
  const teamById = new Map<string, BracketTeam>((teamRows ?? []).map((t) => [t.id as string, t as BracketTeam]));
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
  const total = peerRows.length;

  return NextResponse.json(
    {
      participant: { id: peerRows[0].participant_id, display_name: peerRows[0].display_name },
      matchups,
      status: {
        total_required: total,
        completed,
        is_complete: completed === total,
        missing_matchup_ids: peerRows.filter((m) => m.winner_team_id === null).map((m) => m.matchup_id),
        submission_status: peerRows[0].submission_status,
      },
    },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
