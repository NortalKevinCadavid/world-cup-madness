import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
  requireEligible,
} from '../../../../lib/auth/requireEligible';
import { readOwnBracket } from '../../../../lib/bracket/server-read';

/**
 * `POST /api/bracket/pick` — set one matchup's winner, then cascade-clear
 * downstream picks made impossible (FR-006).
 *
 * Slice 010 (US2, T021). Source of truth:
 *   specs/010-bracket-team-selection/contracts/bracket.pick.write.md
 *
 * Server-side gates (Principle II/III/VI):
 *   - requireEligible (401/403)
 *   - lock from tournament_config.first_kickoff_utc via DB time → 409 BRACKET_LOCKED
 *   - matchup competitors resolved (else 409 MATCHUP_NOT_READY)
 *   - winner is a resolved competitor (else 422 INVALID_WINNER)
 * Then upsert + call bracket_clear_invalid_picks, return cleared ids + status.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_CONTROL = 'no-store';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ErrorPayload { code: string; message: string; reason?: string }

function errorResponse(status: number, payload: ErrorPayload): NextResponse {
  return NextResponse.json(
    { error: payload },
    { status, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Auth + eligibility.
  let participantId: string;
  try {
    const participant = await requireEligible();
    participantId = participant.id;
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

  // 2. Body.
  let matchupId: string;
  let winnerTeamId: string;
  try {
    const body = (await request.json()) as { matchup_id?: unknown; winner_team_id?: unknown };
    if (typeof body.matchup_id !== 'string' || !UUID_RE.test(body.matchup_id)
      || typeof body.winner_team_id !== 'string' || !UUID_RE.test(body.winner_team_id)) {
      return errorResponse(400, { code: 'BAD_REQUEST', message: 'matchup_id and winner_team_id must be UUIDs.' });
    }
    matchupId = body.matchup_id;
    winnerTeamId = body.winner_team_id;
  } catch {
    return errorResponse(400, { code: 'BAD_REQUEST', message: 'Invalid JSON body.' });
  }

  const supabase = createSessionBoundClient();

  // 3. Lock check (server/DB time — client clock is never authoritative).
  const { data: cfg } = await supabase
    .from('tournament_config')
    .select('value')
    .eq('key', 'first_kickoff_utc')
    .maybeSingle();
  const lockIso = cfg?.value ? String(cfg.value).replace(/^"|"$/g, '') : null;
  if (lockIso && Date.now() >= Date.parse(lockIso)) {
    return errorResponse(409, { code: 'BRACKET_LOCKED', message: 'Submissions are closed.', reason: 'lock_window_passed' });
  }

  // 4. Resolve the matchup's current competitors (caller-scoped via bracket_v).
  const { data: vrow, error: vErr } = await supabase
    .from('bracket_v')
    .select('matchup_id, team_a_id, team_b_id')
    .eq('matchup_id', matchupId)
    .maybeSingle();
  if (vErr) return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });
  if (!vrow) return errorResponse(404, { code: 'MATCHUP_NOT_FOUND', message: 'Unknown matchup.' });
  if (!vrow.team_a_id || !vrow.team_b_id) {
    return errorResponse(409, { code: 'MATCHUP_NOT_READY', message: 'This matchup has no competitors yet.' });
  }
  if (winnerTeamId !== vrow.team_a_id && winnerTeamId !== vrow.team_b_id) {
    return errorResponse(422, { code: 'INVALID_WINNER', message: 'Winner is not a competitor in this matchup.' });
  }

  // 5. Upsert the pick (self-RLS scopes to caller).
  const { error: upErr } = await supabase
    .from('bracket_picks')
    .upsert(
      { participant_id: participantId, matchup_id: matchupId, winner_team_id: winnerTeamId, updated_at: new Date().toISOString() },
      { onConflict: 'participant_id,matchup_id' },
    );
  if (upErr) return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });

  // 6. Authoritative cascade — clear now-impossible downstream picks.
  const { data: clearedData, error: clrErr } = await supabase.rpc(
    'bracket_clear_invalid_picks',
    { p_participant_id: participantId },
  );
  if (clrErr) return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });
  const cleared = (clearedData ?? []) as string[];

  // 7. Re-read status (single source of truth).
  let status;
  try {
    status = (await readOwnBracket(supabase, participantId)).status;
  } catch {
    return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });
  }

  return NextResponse.json(
    { pick: { matchup_id: matchupId, winner_team_id: winnerTeamId }, cleared_matchup_ids: cleared, status },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
