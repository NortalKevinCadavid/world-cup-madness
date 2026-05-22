import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
  requireEligible,
} from '../../../lib/auth/requireEligible';

/**
 * `GET /api/teams` — RLS-gated team catalog for the final-prediction
 * picker UI.
 *
 * Slice 004 (Phase 3, US1, T018). Source of truth:
 *   `specs/004-final-predictions/contracts/final-predictions.read.md`
 *   § Endpoint GET /api/teams.
 *
 * Behaviour summary:
 *   - `requireEligible()` (Slice 001) gates auth + eligibility; writes the
 *     `access.denied` audit row for the 403 path.
 *   - SELECT all teams via the user-JWT-bound client so Slice 002's
 *     `teams_eligible_read` RLS applies. No pagination — the tournament
 *     team set is bounded.
 *   - Response shape: `{ teams: [{ id, name, short_code, flag_url }] }`
 *     matching the cross-slice `Team` contract (lib/types/match).
 *   - `Cache-Control: private, max-age=300` — the team catalog is stable
 *     during the tournament window and a brief per-user cache reduces
 *     picker chatter without risking stale data.
 *   - NEVER uses the service-role key.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — 5-minute private cache. Roster is stable; brief client
// cache is safe per contract § Cache-Control headers.
// ---------------------------------------------------------------------------

const CACHE_CONTROL_OK = 'private, max-age=300';
const CACHE_CONTROL_DENIAL = 'private, max-age=0, must-revalidate';

// ---------------------------------------------------------------------------
// Error helpers — mirror /api/matches envelope.
// ---------------------------------------------------------------------------

interface ErrorPayload {
  code: string;
  message: string;
}

function errorResponse(status: number, payload: ErrorPayload): NextResponse {
  return NextResponse.json(
    { error: payload },
    {
      status,
      headers: { 'Cache-Control': CACHE_CONTROL_DENIAL },
    },
  );
}

const UNAUTHENTICATED_BODY: ErrorPayload = {
  code: 'UNAUTHENTICATED',
  message: 'Sign in to continue.',
};

const DOMAIN_NOT_APPROVED_BODY: ErrorPayload = {
  code: 'DOMAIN_NOT_APPROVED',
  message:
    'This application is restricted to approved Nortal corporate identities.',
};

const INTERNAL_BODY: ErrorPayload = {
  code: 'INTERNAL',
  message: 'Internal server error.',
};

// ---------------------------------------------------------------------------
// Session-bound Supabase client.
// ---------------------------------------------------------------------------

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const cookieStore = cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // Read-only: cookie refresh is owned by middleware.
      },
    },
  });
}

// ---------------------------------------------------------------------------
// GET handler.
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 1. Auth + eligibility gate.
  // -------------------------------------------------------------------------
  try {
    await requireEligible();
  } catch (err) {
    if (err instanceof EligibilityError) {
      switch (err.reason) {
        case 'no_session':
          return errorResponse(401, UNAUTHENTICATED_BODY);
        case 'not_eligible':
        case 'participant_not_provisioned':
          return errorResponse(403, DOMAIN_NOT_APPROVED_BODY);
        case 'internal':
          return errorResponse(500, INTERNAL_BODY);
      }
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 2. Build the session-bound client + SELECT all teams. RLS applies.
  //    Sort by short_code for picker-friendly deterministic ordering.
  // -------------------------------------------------------------------------
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  const { data, error } = await supabase
    .from('teams')
    .select('id, name, short_code, flag_url')
    .order('short_code', { ascending: true });

  if (error) {
    return errorResponse(500, INTERNAL_BODY);
  }

  return NextResponse.json(
    { teams: data ?? [] },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL_OK },
    },
  );
}
