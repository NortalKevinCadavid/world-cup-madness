import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
  requireEligible,
} from '../../../../lib/auth/requireEligible';

/**
 * `GET /api/me/final-predictions` — Current participant's active final
 * predictions plus the tournament-wide lock state and `first_kickoff_utc`.
 *
 * Slice 004 (Phase 3, US1, T018). Source of truth:
 *   `specs/004-final-predictions/contracts/final-predictions.read.md`
 *
 * Behaviour summary:
 *   - `requireEligible()` (Slice 001) gates auth + eligibility; writes the
 *     `access.denied` audit row for the 403 path.
 *   - The SELECT runs through the user-JWT-bound Supabase client so
 *     `final_predictions_self_read` RLS (slot 0042) applies. The explicit
 *     `participant_id = <self>` predicate matches the contract's SQL for
 *     plan stability — RLS is the security backstop.
 *   - Returns ONLY active rows (`superseded_at IS NULL`). The response
 *     OMITS `superseded_at` per the read contract; history is out of scope
 *     (Slice 005 owns the personal-breakdown surface).
 *   - `lock_state` is server-computed via
 *     `public.is_final_prediction_locked()` (slot 0041). The predicate is
 *     authoritative — the UI may render a countdown using
 *     `first_kickoff_utc` but MUST NOT re-implement the lock decision
 *     (Constitution Principle III).
 *   - `first_kickoff_utc` is sourced from
 *     `tournament_config.first_kickoff_utc` as ISO-8601 UTC; `null` when
 *     the row is unset (the predicate will then fail-CLOSED and surface
 *     `lock_state='locked'`).
 *   - `Cache-Control: no-store` — final predictions are mutable
 *     participant state and the lock_state field flips at first kickoff.
 *   - NEVER uses the service-role key.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — `no-store` for the same reason /api/predictions uses it:
// final-prediction rows are mutable state AND the lock_state field flips at
// first kickoff, so any client cache window would be visibly stale.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = 'no-store';

// ---------------------------------------------------------------------------
// Error helpers — mirror /api/me/predictions envelope.
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
// Session-bound Supabase client — anon key + caller cookies; never service
// role. Mirrors the helper in /api/predictions and /api/me/predictions.
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
  // 2. Build the session-bound (user-JWT) Supabase client; remaining work
  //    runs under RLS.
  // -------------------------------------------------------------------------
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 3. SELECT active rows (RLS-bound). The explicit `participant_id` filter
  //    matches the contract SQL for query-plan stability; RLS is the
  //    security backstop.
  //
  //    Sort: ORDER BY item_kind — gives a stable, picker-friendly order
  //    (champion / runner_up / top_scorer / best_player alphabetical) that
  //    keeps the response deterministic for the read tests.
  // -------------------------------------------------------------------------
  const { data: rows, error: selectErr } = await supabase
    .from('final_predictions')
    .select(
      'id, item_kind, target_team_id, target_player_id, submitted_at, source',
    )
    .eq('participant_id', participantId)
    .is('superseded_at', null)
    .order('item_kind', { ascending: true });

  if (selectErr) {
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 4. Lock state — server-computed via the slot-0041 predicate. The
  //    predicate is the single source of truth (Constitution Principle III);
  //    UI never re-derives lock semantics in the client.
  //
  //    Fail-closed: if the RPC fails (transient infra), surface 'locked'.
  //    That matches the predicate's own fail-CLOSED semantics on missing
  //    config (`first_kickoff_utc IS NULL → TRUE`).
  // -------------------------------------------------------------------------
  let lockState: 'editable' | 'locked' = 'locked';
  {
    const { data: lockResult, error: lockErr } = await supabase.rpc(
      'is_final_prediction_locked',
    );
    if (!lockErr && typeof lockResult === 'boolean') {
      lockState = lockResult ? 'locked' : 'editable';
    }
    // Else: keep 'locked' (fail-closed). No 500 here — the rest of the
    // response (the rows + first_kickoff_utc) is still useful client-side,
    // and clients already treat 'locked' as the read-only branch.
  }

  // -------------------------------------------------------------------------
  // 5. first_kickoff_utc — pulled from tournament_config so the UI can
  //    render a countdown (display-only; the API's lock_state is
  //    authoritative). The value is JSONB; the seed stores it as a JSON
  //    string e.g. `"2026-06-16T20:00:00Z"`. PostgREST returns it as the
  //    parsed JSON, so we coerce to string defensively.
  // -------------------------------------------------------------------------
  let firstKickoffUtc: string | null = null;
  {
    const { data: cfgRow, error: cfgErr } = await supabase
      .from('tournament_config')
      .select('value')
      .eq('key', 'first_kickoff_utc')
      .maybeSingle<{ value: unknown }>();
    if (!cfgErr && cfgRow && cfgRow.value !== null) {
      const raw = cfgRow.value;
      if (typeof raw === 'string') {
        firstKickoffUtc = raw;
      } else {
        // Defensive — jsonb may surface as an object or number; we only
        // accept strings. Anything else is treated as unset.
        const asString = JSON.stringify(raw);
        // JSON.stringify of a string returns `"...".` — strip the quotes
        // when the underlying value is actually a string literal.
        firstKickoffUtc =
          asString.startsWith('"') && asString.endsWith('"')
            ? asString.slice(1, -1)
            : null;
      }
    }
  }

  return NextResponse.json(
    {
      final_predictions: rows ?? [],
      lock_state: lockState,
      first_kickoff_utc: firstKickoffUtc,
    },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
