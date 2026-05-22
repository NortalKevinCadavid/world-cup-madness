import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  EligibilityError,
  requireEligible,
} from '../../../../lib/auth/requireEligible';

/**
 * `GET /api/peer-pick/[match_id]` — Match-pick peer visibility.
 *
 * Slice 005 (Phase 5, US3, T032). Source of truth:
 *   `specs/005-scoring-leaderboard/contracts/peer-pick.read.md` § Surface 1
 *
 * Behaviour summary:
 *   - Thin pass-through over `public.peer_pick_v` (slot 0054). The view's
 *     SECURITY_INVOKER predicate enforces the kickoff/lock-window gate
 *     (BR-LOCK-002 / BR-LOCK-003 strict-inclusive boundary) AND the
 *     self-exclusion (`participants.auth_user_id = auth.uid()`); this
 *     handler MUST NOT re-implement either check (Constitution Principle III
 *     — gate in SQL).
 *   - `requireEligible()` (Slice 001) gates auth + eligibility; it also
 *     writes the `access.denied` audit row on the 403 path.
 *   - SELECT runs through the user-JWT-bound Supabase client so RLS applies
 *     end-to-end. NEVER uses the service-role key.
 *   - Empty array is the documented `{ "picks": [] }` response for ANY of:
 *     (a) pre-lock — view filters globally;
 *     (b) self-exclusion — caller's own pick is omitted by view;
 *     (c) genuine "no peers submitted" — same shape per contract.
 *     The client cannot distinguish these and reads lock-state separately.
 *   - `Cache-Control: no-store` — peer rows flip in/out at the lock boundary
 *     and any cache window would be visibly stale.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — every response, including errors.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = 'no-store';

// ---------------------------------------------------------------------------
// Error helpers — envelope shape mirrors Slice 003 / 004 routes.
// ---------------------------------------------------------------------------

interface ErrorPayload {
  code: string;
  message: string;
  reason?: string;
}

function errorResponse(status: number, payload: ErrorPayload): NextResponse {
  return NextResponse.json(
    { error: payload },
    {
      status,
      headers: { 'Cache-Control': CACHE_CONTROL },
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
// Path-params schema — `match_id` MUST be a UUID. Malformed input returns
// 400 BAD_REQUEST without hitting the database.
// ---------------------------------------------------------------------------

const PARAMS_SCHEMA = z.object({
  match_id: z.string().uuid({ message: 'invalid_match_id' }),
});

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies; never service
// role. Mirrors the helper in Slice 003 / 004 routes.
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

export async function GET(
  _request: NextRequest,
  context: { params: { match_id: string } },
): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 1. Validate path param BEFORE auth — malformed UUID is a structural
  //    400, distinguishable from auth failures upstream.
  // -------------------------------------------------------------------------
  const paramsParse = PARAMS_SCHEMA.safeParse(context.params);
  if (!paramsParse.success) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: paramsParse.error.issues[0]?.message ?? 'invalid_match_id',
      reason: 'invalid_match_id',
    });
  }
  const { match_id } = paramsParse.data;

  // -------------------------------------------------------------------------
  // 2. Auth + eligibility gate. requireEligible() throws on every failure
  //    path; we translate to HTTP status per the contract.
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
  // 3. Build the session-bound (user-JWT) Supabase client. The view's RLS
  //    runs under this caller identity — service role would bypass the gate.
  // -------------------------------------------------------------------------
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 4. SELECT from peer_pick_v. The view's predicate enforces:
  //      (a) BR-LOCK-002/003 lock-window gate;
  //      (b) self-exclusion via participants.auth_user_id = auth.uid().
  //    Empty `data` is the documented response for any of:
  //      - pre-lock (view returns 0 rows globally for this match);
  //      - the caller's own pick (excluded by view);
  //      - no peer submitted a prediction (genuine empty set).
  //    The client cannot distinguish these per the contract, and we do NOT
  //    surface a different status for any of them.
  //
  //    `ORDER BY participant_id ASC` keeps the response deterministic for
  //    Playwright + pgTAP read tests.
  // -------------------------------------------------------------------------
  const { data, error } = await supabase
    .from('peer_pick_v')
    .select(
      'prediction_id, match_id, participant_id, display_name, predicted_home, predicted_away, submitted_at, kickoff_utc',
    )
    .eq('match_id', match_id)
    .order('participant_id', { ascending: true });

  if (error) {
    return errorResponse(500, INTERNAL_BODY);
  }

  return NextResponse.json(
    { picks: data ?? [] },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
