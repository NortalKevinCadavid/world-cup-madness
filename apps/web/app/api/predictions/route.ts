import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  EligibilityError,
  requireEligible,
} from '../../../lib/auth/requireEligible';

/**
 * `POST /api/predictions` — Submit (or replace) a prediction for a match.
 *
 * Slice 003 (Phase 3, US1, T015). Source of truth:
 *   `specs/003-match-predictions/contracts/predictions.write.md`
 *
 * Behaviour summary:
 *   - Body is parsed + validated (zod) BEFORE the eligibility check (per
 *     contract § Server behavior step 2 — avoids timing leak between
 *     "eligible but bad input" and "not eligible").
 *   - `requireEligible()` (Slice 001) gates auth + eligibility; it also
 *     writes the `access.denied` audit row for the 403 path.
 *   - The match-visibility check + SP RPC run through the user-JWT-bound
 *     Supabase client so RLS applies. The SP itself is SECURITY DEFINER
 *     (slot 0034) and enforces lock, eligibility, and score checks.
 *   - SP ERRCODE values (locked cross-slice) map to HTTP status:
 *       WCM01 → 409 PREDICTION_LOCKED (reason: lock_window_passed)
 *       WCM02 → 409 PREDICTION_LOCKED (reason: match_status_locked)
 *       WCM03 → 422 INVALID_SCORE
 *       WCM04 → 404 MATCH_NOT_FOUND
 *       WCM05 → 403 INELIGIBLE
 *       WCM06 → 409 DUPLICATE_ACTIVE (provisional per D-013; T021 removes)
 *   - All responses carry `Cache-Control: no-store` (predictions are
 *     mutable participant state).
 *   - NEVER uses the service-role key.
 *   - The handler MUST NOT honor a `participant_id` body param to write on
 *     behalf of another participant; `p_participant_id` is set by the
 *     handler from `requireEligible()`'s return value.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — every response, including errors.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = 'no-store';

// ---------------------------------------------------------------------------
// Error helpers — envelope shape mirrors /api/me (Slice 001).
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
// Request schema — score upper bound `20` is the structural ceiling enforced
// at the route layer; the SP re-checks against the configured
// `tournament_config.score_upper_bound` value as defence-in-depth. A score in
// [0, 20] that exceeds a *lower* configured upper bound surfaces here as a
// 422 INVALID_SCORE (SP WCM03), not a 400 — which is precisely what
// `slice-003-submit-invalid-score.spec.ts` asserts (home=21 → 422).
// ---------------------------------------------------------------------------

const SUBMIT_SCHEMA = z.object({
  match_id: z.string().uuid(),
  home: z.number().int().min(0).max(20),
  away: z.number().int().min(0).max(20),
});

// ---------------------------------------------------------------------------
// Session-bound Supabase client — mirrors `apps/web/app/api/matches/route.ts`.
// Slice 001 intentionally keeps its helper private; we re-create the same
// pattern here so the route uses the caller's JWT (anon key + session
// cookies), never the service-role key.
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
// SP error code → HTTP response mapping.
// ---------------------------------------------------------------------------

interface SpErrorLike {
  code?: string | null;
  message?: string | null;
}

function mapSpError(rpcErr: SpErrorLike): NextResponse {
  const errcode = (rpcErr.code ?? '').toUpperCase();
  const message = rpcErr.message ?? 'submit_prediction failed';

  switch (errcode) {
    case 'WCM01':
      return errorResponse(409, {
        code: 'PREDICTION_LOCKED',
        message,
        reason: 'lock_window_passed',
      });
    case 'WCM02':
      return errorResponse(409, {
        code: 'PREDICTION_LOCKED',
        message,
        reason: 'match_status_locked',
      });
    case 'WCM03':
      return errorResponse(422, {
        code: 'INVALID_SCORE',
        message,
      });
    case 'WCM04':
      return errorResponse(404, {
        code: 'MATCH_NOT_FOUND',
        message: 'Match not found.',
      });
    case 'WCM05':
      return errorResponse(403, {
        code: 'INELIGIBLE',
        message,
      });
    case 'WCM06':
      // Provisional per D-013; T021 removes this branch when the supersede
      // path lands.
      return errorResponse(409, {
        code: 'DUPLICATE_ACTIVE',
        message,
      });
    default:
      return errorResponse(500, INTERNAL_BODY);
  }
}

// ---------------------------------------------------------------------------
// POST handler.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 1. Parse + validate body FIRST (before auth/eligibility check).
  //    Per contract § Server behavior — avoids timing leak between
  //    "eligible-but-bad-input" and "not eligible".
  // -------------------------------------------------------------------------
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Invalid JSON body.',
    });
  }

  const parsed = SUBMIT_SCHEMA.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: parsed.error.issues[0]?.message ?? 'validation failed',
    });
  }
  const { match_id, home, away } = parsed.data;

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
          return errorResponse(500, INTERNAL_BODY);
      }
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 3. Build a session-bound (user-JWT) Supabase client; remaining work
  //    runs under RLS.
  // -------------------------------------------------------------------------
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 4. Match-existence visibility check (RLS-bound). Zero rows → 404.
  //    Per contract step 4 — short-circuits before invoking the SP for the
  //    common "unknown match" case.
  // -------------------------------------------------------------------------
  const { data: matchRow, error: matchErr } = await supabase
    .from('matches')
    .select('id')
    .eq('id', match_id)
    .maybeSingle();

  if (matchErr) {
    return errorResponse(500, INTERNAL_BODY);
  }
  if (!matchRow) {
    return errorResponse(404, {
      code: 'MATCH_NOT_FOUND',
      message: 'Match not found.',
    });
  }

  // -------------------------------------------------------------------------
  // 5. Invoke the SP. `p_participant_id` is the caller's resolved
  //    participants.id — NEVER a value from the request body.
  // -------------------------------------------------------------------------
  const { data: newId, error: rpcErr } = await supabase.rpc(
    'submit_prediction',
    {
      p_participant_id: participantId,
      p_match_id: match_id,
      p_home: home,
      p_away: away,
      p_source: 'ui',
    },
  );

  if (rpcErr) {
    return mapSpError(rpcErr);
  }

  if (typeof newId !== 'string' || newId.length === 0) {
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 6. Fetch the newly-inserted row (RLS-bound; the caller owns it).
  //    The write contract's 200 body includes `superseded_at` (null for
  //    the active row) — distinct from the read contract which omits it.
  // -------------------------------------------------------------------------
  const { data: pred, error: selectErr } = await supabase
    .from('predictions')
    .select(
      'id, match_id, predicted_home, predicted_away, submitted_at, source, superseded_at',
    )
    .eq('id', newId)
    .single();

  if (selectErr || !pred) {
    return errorResponse(500, INTERNAL_BODY);
  }

  return NextResponse.json(
    { prediction: pred },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
