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
 * `GET /api/peer-final-pick/[participant_id]` — Final-tournament-pick peer
 * visibility (one peer's full set of four picks).
 *
 * Slice 005 (Phase 5, US3, T032). Source of truth:
 *   `specs/005-scoring-leaderboard/contracts/peer-pick.read.md` § Surface 2
 *
 * Behaviour summary:
 *   - Thin pass-through over `public.peer_final_pick_v` (slot 0054). The
 *     view enforces (a) BR-LOCK-005 first-kickoff gate (now() >=
 *     tournament_config.first_kickoff_utc, strict-inclusive), and (b)
 *     self-exclusion via participants.auth_user_id = auth.uid(). This
 *     handler MUST NOT re-implement either check (Constitution Principle III
 *     — gate in SQL).
 *   - `requireEligible()` (Slice 001) gates auth + eligibility; it also
 *     writes the `access.denied` audit row on the 403 path.
 *   - SELECT runs through the user-JWT-bound Supabase client so RLS applies
 *     end-to-end. NEVER uses the service-role key.
 *   - `maybeSingle()` returns either the peer's pivoted final-pick row OR
 *     null. Null is the documented `{ "pick": null }` response for ANY of:
 *     (a) before first kickoff — view filters globally;
 *     (b) caller asked about themselves — self-exclusion;
 *     (c) no such participant or peer never submitted finals.
 *     The client cannot distinguish these per the contract.
 *   - `Cache-Control: no-store` — peer rows flip in/out at the first-kickoff
 *     boundary and any cache window would be visibly stale.
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
// Path-params schema — `participant_id` MUST be a UUID. Malformed input
// returns 400 BAD_REQUEST without hitting the database.
// ---------------------------------------------------------------------------

const PARAMS_SCHEMA = z.object({
  participant_id: z.string().uuid({ message: 'invalid_participant_id' }),
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
  context: { params: { participant_id: string } },
): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 1. Validate path param BEFORE auth — malformed UUID is a structural
  //    400, distinguishable from auth failures upstream.
  // -------------------------------------------------------------------------
  const paramsParse = PARAMS_SCHEMA.safeParse(context.params);
  if (!paramsParse.success) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: paramsParse.error.issues[0]?.message ?? 'invalid_participant_id',
      reason: 'invalid_participant_id',
    });
  }
  const { participant_id } = paramsParse.data;

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
  // 4. SELECT from peer_final_pick_v. The view's predicate enforces:
  //      (a) BR-LOCK-005 first-kickoff gate (zero rows globally pre-kickoff);
  //      (b) self-exclusion via participants.auth_user_id = auth.uid().
  //    `maybeSingle()` returns `data = null, error = null` when no row is
  //    visible (any of: pre-first-kickoff, caller asked about themselves,
  //    no such participant, peer never submitted) — the contract specifies
  //    that all of these surface as `{ "pick": null }` indistinguishably.
  // -------------------------------------------------------------------------
  const { data, error } = await supabase
    .from('peer_final_pick_v')
    .select(
      'participant_id, display_name, champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id, submitted_at',
    )
    .eq('participant_id', participant_id)
    .maybeSingle();

  if (error) {
    // maybeSingle() does NOT surface PGRST116 ("no rows") as an error — it
    // returns data=null, error=null. Any error here is a genuine DB failure.
    return errorResponse(500, INTERNAL_BODY);
  }

  return NextResponse.json(
    { pick: data ?? null },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
