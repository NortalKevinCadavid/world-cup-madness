import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
  requireEligible,
} from '../../../lib/auth/requireEligible';
import { readOwnBracket } from '../../../lib/bracket/server-read';

/**
 * `GET /api/bracket` — the caller's own knockout bracket + status.
 *
 * Slice 010 (US1, T015). Source of truth:
 *   specs/010-bracket-team-selection/contracts/bracket.read.md
 *
 * - `requireEligible()` (slice 001) gates auth + eligibility (401/403).
 * - Reads `bracket_v` (security_invoker, self-RLS) for matchups with
 *   competitors resolved from the caller's upstream winner picks, and
 *   `bracket_status(participant_id)` for the single status shape (FR-014).
 * - Joins `teams` for display (name / short_code / flag).
 * - Session-bound anon-key client + caller cookies; NEVER service role.
 * - `Cache-Control: no-store` (status flips at the lock boundary).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_CONTROL = 'no-store';

interface ErrorPayload {
  code: string;
  message: string;
}

function errorResponse(status: number, payload: ErrorPayload): NextResponse {
  return NextResponse.json(
    { error: payload },
    { status, headers: { 'Cache-Control': CACHE_CONTROL } },
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
      setAll(_c: { name: string; value: string; options: CookieOptions }[]) {
        // Read-only: cookie refresh is owned by middleware.
      },
    },
  });
}

export async function GET(): Promise<NextResponse> {
  let participantId: string;
  try {
    const participant = await requireEligible();
    participantId = participant.id;
  } catch (err) {
    if (err instanceof EligibilityError) {
      switch (err.reason) {
        case 'no_session':
          return errorResponse(401, UNAUTHENTICATED_BODY);
        case 'not_eligible':
        case 'participant_not_provisioned':
          return errorResponse(403, DOMAIN_NOT_APPROVED_BODY);
        default:
          return errorResponse(500, INTERNAL_BODY);
      }
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  try {
    const supabase = createSessionBoundClient();
    const body = await readOwnBracket(supabase, participantId);
    return NextResponse.json(body, {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }
}
