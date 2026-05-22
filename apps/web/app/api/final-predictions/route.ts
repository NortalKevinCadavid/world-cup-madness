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
 * `POST /api/final-predictions` — Submit (create) a participant's final
 * prediction for one of the four tournament-wide items (champion,
 * runner_up, top_scorer, best_player).
 *
 * Slice 004 (Phase 3, US1, T018). Source of truth:
 *   `specs/004-final-predictions/contracts/final-predictions.write.md`
 *
 * Behaviour summary:
 *   - Body is parsed + validated (zod) BEFORE the eligibility check (per
 *     contract § Server behavior step 2 — avoids timing leak between
 *     "eligible but bad input" and "not eligible"). The zod schema enforces
 *     the kind/target XOR rule (champion / runner_up ↔ target_team_id;
 *     top_scorer / best_player ↔ target_player_id).
 *   - `requireEligible()` (Slice 001) gates auth + eligibility; it also
 *     writes the `access.denied` audit row for the 403 path.
 *   - The SP RPC + post-insert row fetch run through the user-JWT-bound
 *     Supabase client so RLS applies. The SP itself is SECURITY DEFINER
 *     (slot 0044) and enforces lock, eligibility, identical-pair, and
 *     target-existence checks.
 *   - SP ERRCODE values (locked cross-slice) map to HTTP status:
 *       WFP01 → 409 FINAL_PREDICTIONS_LOCKED (reason: lock_window_passed)
 *       WFP03 → 400 BAD_REQUEST
 *       WFP04 → 404 INVALID_TARGET (reason disambiguated per body)
 *       WFP05 → 403 INELIGIBLE
 *       WFP06 → 409 IDENTICAL_CHAMPION_RUNNER_UP
 *       23505 → 409 ALREADY_SUBMITTED (provisional; T029 swaps for supersede)
 *   - All responses carry `Cache-Control: no-store` (predictions are
 *     mutable participant state).
 *   - NEVER uses the service-role key.
 *   - The handler MUST NOT honor a `participant_id` body param to write on
 *     behalf of another participant; `p_participant_id` is set by the
 *     handler from `requireEligible()`'s return value.
 *
 * Audit-log note: per RLS migration 0010, the `authenticated` role can
 * INSERT into `public.audit_log` ONLY when (action='access.denied',
 * source='api_guard'). Rejection-path audit rows for final_predictions are
 * therefore NOT written from this handler — the SP's RAISE path rolls back
 * its own transaction anyway, and Slice 007 will own a service-side
 * rejection audit (per slot 0044 header comment). Happy-path audit rows
 * are emitted automatically by the slot-0043 AFTER INSERT trigger. This
 * mirrors Slice 003's `/api/predictions` route — D-018 records the
 * deviation from the T018 prompt.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — every response, including errors.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = 'no-store';

// ---------------------------------------------------------------------------
// Error helpers — envelope shape mirrors /api/predictions (Slice 003) which
// in turn mirrors /api/me (Slice 001).
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
// Request schema — enforces kind/target XOR per contract § Request body.
//
//   champion / runner_up        → target_team_id required, target_player_id absent/null
//   top_scorer / best_player    → target_player_id required, target_team_id absent/null
//
// The SP re-checks the same rule with ERRCODE='WFP03' as defence in depth;
// this layer surfaces the same shape violation as 400 BAD_REQUEST.
// ---------------------------------------------------------------------------

const ITEM_KIND_VALUES = [
  'champion',
  'runner_up',
  'top_scorer',
  'best_player',
] as const;
type ItemKindLiteral = (typeof ITEM_KIND_VALUES)[number];

const SUBMIT_SCHEMA = z
  .object({
    item_kind: z.enum(ITEM_KIND_VALUES),
    target_team_id: z.string().uuid().nullish(),
    target_player_id: z.string().uuid().nullish(),
  })
  .superRefine((body, ctx) => {
    const isTeamKind =
      body.item_kind === 'champion' || body.item_kind === 'runner_up';
    const isPlayerKind =
      body.item_kind === 'top_scorer' || body.item_kind === 'best_player';
    const teamPresent =
      body.target_team_id !== undefined && body.target_team_id !== null;
    const playerPresent =
      body.target_player_id !== undefined && body.target_player_id !== null;

    if (isTeamKind && !teamPresent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${body.item_kind} picks require target_team_id`,
        path: ['target_team_id'],
      });
    }
    if (isTeamKind && playerPresent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${body.item_kind} picks must not include target_player_id`,
        path: ['target_player_id'],
      });
    }
    if (isPlayerKind && !playerPresent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${body.item_kind} picks require target_player_id`,
        path: ['target_player_id'],
      });
    }
    if (isPlayerKind && teamPresent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${body.item_kind} picks must not include target_team_id`,
        path: ['target_team_id'],
      });
    }
  });

// ---------------------------------------------------------------------------
// Session-bound Supabase client — same pattern as /api/predictions.
// Anon key + caller cookies; NEVER service-role.
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

type SessionBoundClient = ReturnType<typeof createSessionBoundClient>;

// ---------------------------------------------------------------------------
// 404 reason disambiguation for WFP04 (INVALID_TARGET).
//
// The SP raises WFP04 with `MESSAGE='team <uuid> not found'` for team kinds
// and `MESSAGE='player <uuid> not found or removed'` for player kinds, but
// from the wire we can't tell `player_not_found` vs `player_removed` apart
// without a second lookup. The contract § Security invariants requires the
// distinction so the picker UI surfaces actionable feedback.
// ---------------------------------------------------------------------------

async function disambiguateInvalidTarget(
  supabase: SessionBoundClient,
  itemKind: ItemKindLiteral,
  targetPlayerId: string | null,
): Promise<'team_not_found' | 'player_not_found' | 'player_removed'> {
  if (itemKind === 'champion' || itemKind === 'runner_up') {
    return 'team_not_found';
  }
  // Player kind: check whether a row exists at all and what its
  // removed_at column looks like. We use the user-JWT-bound client so
  // RLS still applies (players_eligible_read covers any eligible caller).
  if (targetPlayerId !== null) {
    const { data, error } = await supabase
      .from('players')
      .select('removed_at')
      .eq('id', targetPlayerId)
      .maybeSingle<{ removed_at: string | null }>();
    if (!error && data && data.removed_at !== null) {
      return 'player_removed';
    }
  }
  return 'player_not_found';
}

// ---------------------------------------------------------------------------
// SP error code → HTTP response mapping. Async because the WFP04 branch may
// run a follow-up SELECT to distinguish player_not_found vs player_removed.
// ---------------------------------------------------------------------------

interface SpErrorLike {
  code?: string | null;
  message?: string | null;
}

async function mapSpError(
  rpcErr: SpErrorLike,
  supabase: SessionBoundClient,
  itemKind: ItemKindLiteral,
  targetPlayerId: string | null,
): Promise<NextResponse> {
  const errcode = (rpcErr.code ?? '').toUpperCase();
  const message = rpcErr.message ?? 'submit_final_prediction failed';

  switch (errcode) {
    case 'WFP01':
      return errorResponse(409, {
        code: 'FINAL_PREDICTIONS_LOCKED',
        message,
        reason: 'lock_window_passed',
      });
    case 'WFP03':
      return errorResponse(400, {
        code: 'BAD_REQUEST',
        message,
      });
    case 'WFP04': {
      const reason = await disambiguateInvalidTarget(
        supabase,
        itemKind,
        targetPlayerId,
      );
      // Use a contract-friendly user-facing message that does NOT leak the
      // attempted target UUID (§ Security invariants — defence against
      // enumeration).
      const userMessage =
        reason === 'team_not_found'
          ? 'Target team not found in the tournament roster.'
          : reason === 'player_removed'
            ? 'Target player is no longer on the tournament roster.'
            : 'Target player not found in the tournament roster.';
      return errorResponse(404, {
        code: 'INVALID_TARGET',
        message: userMessage,
        reason,
      });
    }
    case 'WFP05':
      return errorResponse(403, {
        code: 'INELIGIBLE',
        message,
      });
    case 'WFP06':
      return errorResponse(409, {
        code: 'IDENTICAL_CHAMPION_RUNNER_UP',
        message,
        reason: 'identical_champion_runner_up',
      });
    case '23505':
      // Provisional per D-014: US1 ships create-only. T029 (US3) replaces
      // this branch with the SP's supersede UPDATE+INSERT pattern. Until
      // then a second create for the same (participant, item_kind) collides
      // with the partial unique index `final_predictions_active_uk` and
      // surfaces here as 409.
      return errorResponse(409, {
        code: 'ALREADY_SUBMITTED',
        message:
          'A final prediction for this item already exists. Update support ships in a follow-up.',
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
  //    Per contract § Server behavior step 2 — avoids timing leak between
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
  const { item_kind } = parsed.data;
  const target_team_id = parsed.data.target_team_id ?? null;
  const target_player_id = parsed.data.target_player_id ?? null;

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
  let supabase: SessionBoundClient;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 4. Invoke the SP. `p_participant_id` is the caller's resolved
  //    participants.id — NEVER a value from the request body.
  //
  //    Target-existence is deliberately delegated to the SP (which performs
  //    the SELECT 1 + RAISE ERRCODE='WFP04' atomically). The route surfaces
  //    that as 404 INVALID_TARGET with the disambiguated reason field.
  // -------------------------------------------------------------------------
  const { data: newId, error: rpcErr } = await supabase.rpc(
    'submit_final_prediction',
    {
      p_participant_id: participantId,
      p_item_kind: item_kind,
      p_target_team_id: target_team_id,
      p_target_player_id: target_player_id,
      p_source: 'ui',
    },
  );

  if (rpcErr) {
    return mapSpError(rpcErr, supabase, item_kind, target_player_id);
  }

  if (typeof newId !== 'string' || newId.length === 0) {
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 5. Fetch the newly-inserted row (RLS-bound; the caller owns it).
  //    The write contract's 200 body includes `superseded_at` (null for the
  //    active row) — the read contract omits it.
  // -------------------------------------------------------------------------
  const { data: row, error: selectErr } = await supabase
    .from('final_predictions')
    .select(
      'id, item_kind, target_team_id, target_player_id, submitted_at, source, superseded_at',
    )
    .eq('id', newId)
    .single();

  if (selectErr || !row) {
    return errorResponse(500, INTERNAL_BODY);
  }

  return NextResponse.json(
    { final_prediction: row },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
