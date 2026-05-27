import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
  requireEligible,
} from '../../../../lib/auth/requireEligible';

/**
 * `GET /api/me/predictions` — Current participant's active predictions.
 *
 * Slice 003 (Phase 3, US1, T015). Source of truth:
 *   `specs/003-match-predictions/contracts/predictions.read.md`
 *
 * Behaviour summary:
 *   - Optional `?match_id=<uuid>` filters to a single match. Invalid UUID
 *     → 400. Validation runs BEFORE the eligibility check (mirrors
 *     /api/matches: avoids timing leak on "eligible but bad input" vs
 *     "not eligible").
 *   - `requireEligible()` (Slice 001) gates auth + eligibility; writes
 *     the `access.denied` audit row for the 403 path.
 *   - The SELECT runs through the user-JWT-bound Supabase client so
 *     `predictions_self_read` RLS applies. The explicit
 *     `participant_id = <self>` predicate matches the contract's SQL for
 *     plan stability — RLS is the security backstop.
 *   - Returns ONLY active rows (`superseded_at IS NULL`); history is out
 *     of scope (Slice 005 owns it). The response shape OMITS
 *     `superseded_at` per the read contract.
 *   - `Cache-Control: private, max-age=0, must-revalidate` — predictions
 *     are mutable per-participant state.
 *   - NEVER uses the service-role key. NEVER honors a `participant_id`
 *     query parameter.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — read contract is per-user mutable state.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = 'private, max-age=0, must-revalidate';

// ---------------------------------------------------------------------------
// Error helpers — mirror /api/me's envelope.
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
// UUID regex (lightweight; the DB is the authoritative validator).
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Session-bound Supabase client — same pattern as
// `apps/web/app/api/matches/route.ts` and the POST handler in
// `app/api/predictions/route.ts`. Anon key + caller cookies; never service
// role.
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 1. Validate optional `match_id` query param BEFORE the eligibility
  //    check (contract § Server behavior step 2; timing-leak avoidance).
  // -------------------------------------------------------------------------
  const url = new URL(request.url);
  const matchIdParam = url.searchParams.get('match_id');
  if (matchIdParam !== null && !UUID_RE.test(matchIdParam)) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'match_id must be a valid UUID',
    });
  }

  // -------------------------------------------------------------------------
  // 2. Auth + eligibility gate.
  // -------------------------------------------------------------------------
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
        case 'internal':
          console.error('[me/predictions] eligibility internal error:', err.message);
          return errorResponse(500, INTERNAL_BODY);
      }
    }
    console.error('[me/predictions] unexpected error during requireEligible:', err);
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 3. RLS-bound query. The explicit `participant_id = <self>` predicate
  //    matches the contract's SQL for plan stability; `predictions_self_read`
  //    RLS (slot 0032) is the security backstop.
  // -------------------------------------------------------------------------
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  let query = supabase
    .from('predictions')
    .select(
      'id, match_id, predicted_home, predicted_away, submitted_at, source',
    )
    .eq('participant_id', participantId)
    .is('superseded_at', null)
    .order('submitted_at', { ascending: false });

  if (matchIdParam !== null) {
    query = query.eq('match_id', matchIdParam);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[me/predictions] predictions query error:', error.message, error);
    return errorResponse(500, INTERNAL_BODY);
  }

  return NextResponse.json(
    { predictions: data ?? [] },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
