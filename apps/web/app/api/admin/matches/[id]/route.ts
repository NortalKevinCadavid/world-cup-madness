import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../lib/auth/requireAdmin';
import { ERRCODE_HTTP_MAP } from '../../../../../lib/admin/rpcs';
import type { AdminERRCODE } from '../../../../../lib/admin/types';

/**
 * `POST /api/admin/matches/[id]` — Admin override path for updating
 * `matches.status` and/or `matches.kickoff_utc`.
 *
 * Slice 006 (Phase 5, US3, T031 — replaces the T015 stub with the full
 * implementation now that T030 has shipped `admin_update_match` at
 * migration slot 0065).
 *
 * Source of truth:
 *   - `specs/006-admin-overrides/contracts/admin-ui.surface.md` §
 *     `/admin/matches/[id]` — "Update Status / Kickoff" form posts here.
 *   - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` §
 *     `admin_update_match`.
 *   - `supabase/migrations/0065_admin_update_match.sql` — SP signature:
 *       `admin_update_match(p_match_id, p_new_status, p_new_kickoff_utc,
 *                           p_reason, p_source_citation)` returns void.
 *
 * Behaviour summary (locked, per-spec):
 *   1. Parse + zod-validate the JSON body BEFORE the admin gate (slice
 *      003/004 pattern — avoids leaking "valid input but not admin" vs
 *      "admin but bad input"). Empty `reason` / `source_citation` surface
 *      as field-level 400 errors here, matching what slot 0065's pre-flight
 *      would have raised (WAR02/WAR03).
 *   2. Build a session-bound (user-JWT) Supabase client.
 *   3. `await requireAdmin(client)` — composes slice 001's `requireEligible()`
 *      with the slot 0062 `is_admin()` RPC.
 *        - `AdminAccessDeniedError('no_session')`   → 401 UNAUTHENTICATED
 *        - `AdminAccessDeniedError('not_eligible')` → 403 FORBIDDEN
 *        - `AdminAccessDeniedError('not_admin')`    → 403 FORBIDDEN
 *   4. Call `admin_update_match(p_match_id, p_new_status, p_new_kickoff_utc,
 *      p_reason, p_source_citation)` via `client.rpc(...)`. The SP returns
 *      void on success and raises:
 *        - WAR01 admin role (defence in depth — should never fire here)
 *        - WAR02 reason missing
 *        - WAR03 source_citation missing
 *        - WAR04 match not found
 *        - WAR07 no-op (both args NULL or unchanged vs current)
 *   5. ERRCODE → HTTP per the locked table:
 *        - WAR01 → 403
 *        - WAR02 → 400 (field='reason')
 *        - WAR03 → 400 (field='source_citation')
 *        - WAR04 → 404
 *        - WAR07 → 409 (NO_OP)
 *   6. On success: 200 with `{ ok: true }`. Slice 003's slot 0036
 *      kickoff-correction fan-out trigger and slice 004's slot 0046
 *      first_kickoff_correction trigger fire automatically from the SP's
 *      UPDATE — no client-side fan-out call.
 *
 * Body shape (locked — drives the test wire format and MatchUpdateForm):
 *   {
 *     status?:          'scheduled' | 'in_progress' | 'finished' |
 *                       'postponed' | 'cancelled' (nullable; omitted = no
 *                       change to status),
 *     kickoff_utc?:     ISO-8601 timestamp string (optional/nullable;
 *                       omitted = no change),
 *     reason:           non-empty string,
 *     source_citation:  non-empty string,
 *   }
 *
 * Cache-Control: `no-store` on every response.
 * NEVER uses the service-role key.
 *
 * @see specs/006-admin-overrides/contracts/admin-rpcs.write.md
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see apps/web/lib/auth/requireAdmin.ts
 * @see supabase/migrations/0065_admin_update_match.sql
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — every response, including errors.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = 'no-store';

// ---------------------------------------------------------------------------
// Error helpers — envelope shape mirrors /api/admin/match-results +
// /api/admin/tournament-award.
// ---------------------------------------------------------------------------

interface ErrorPayload {
  code: string;
  message?: string;
  reason?: string;
  field?: string;
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

const INTERNAL_BODY: ErrorPayload = {
  code: 'INTERNAL',
  message: 'Internal server error.',
};

// ---------------------------------------------------------------------------
// Request schema.
//
// `match_status` values mirror the slot 0020 enum:
//   'scheduled' | 'in_progress' | 'finished' | 'postponed' | 'cancelled'
//
// Both `status` and `kickoff_utc` are optional/nullable — the SP supports
// partial updates and uses COALESCE to preserve the existing value when NULL
// is passed. The SP raises WAR07 if both args are NULL or equal to current.
// ---------------------------------------------------------------------------

const MATCH_STATUS_VALUES = [
  'scheduled',
  'in_progress',
  'finished',
  'postponed',
  'cancelled',
] as const;

const BODY_SCHEMA = z.object({
  status: z.enum(MATCH_STATUS_VALUES).optional().nullable(),
  // We accept any ISO-8601 string — the SP performs the timestamptz coercion
  // and Postgres surfaces invalid timestamps as 22007 natively. Empty strings
  // are coerced to null below so a blank datetime-local input doesn't trip
  // the SP's WAR07 no-op check incorrectly.
  kickoff_utc: z.string().min(1).optional().nullable(),
  reason: z.string().min(1, 'reason is required'),
  source_citation: z.string().min(1, 'source_citation is required'),
});

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Never uses the
// service-role key.
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

function adminDenialResponse(err: AdminAccessDeniedError): NextResponse {
  switch (err.reason) {
    case 'no_session':
      return errorResponse(401, {
        code: 'UNAUTHENTICATED',
        message: 'Sign in to continue.',
        reason: 'no_session',
      });
    case 'not_eligible':
      return errorResponse(403, {
        code: 'FORBIDDEN',
        message:
          'This application is restricted to approved Nortal corporate identities.',
        reason: 'not_eligible',
      });
    case 'not_admin':
      return errorResponse(403, {
        code: 'FORBIDDEN',
        message: 'Admin role required.',
        reason: 'admin_required',
      });
  }
}

// ---------------------------------------------------------------------------
// POST handler.
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 0. Validate the path parameter — match_id MUST be a uuid before we even
  //    consider the body or the admin gate.
  // -------------------------------------------------------------------------
  const matchId = context.params.id;
  const idCheck = z.string().uuid().safeParse(matchId);
  if (!idCheck.success) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Invalid match id.',
      field: 'match_id',
    });
  }

  // -------------------------------------------------------------------------
  // 1. Parse + validate body FIRST (before auth gate). Empty reason /
  //    source_citation surface as 400 + field=... regardless of admin status.
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

  const parsed = BODY_SCHEMA.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue?.path.join('.') ?? undefined;
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: firstIssue?.message ?? 'validation failed',
      field,
    });
  }
  const body = parsed.data;

  // Coerce empty strings to null defensively (Next.js JSON bodies should
  // already normalize but be explicit).
  const newStatus = body.status ?? null;
  const newKickoff =
    typeof body.kickoff_utc === 'string' && body.kickoff_utc.length > 0
      ? body.kickoff_utc
      : null;

  // -------------------------------------------------------------------------
  // 2. Build a session-bound (user-JWT) Supabase client.
  // -------------------------------------------------------------------------
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 3. Admin gate. Defence in depth — the SP's WAR01 pre-flight is the
  //    source of truth but the route gate writes a richer audit row and
  //    keeps the 501-stub leakage path closed permanently.
  // -------------------------------------------------------------------------
  try {
    await requireAdmin(supabase);
  } catch (err) {
    if (err instanceof AdminAccessDeniedError) {
      return adminDenialResponse(err);
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 4. Invoke `admin_update_match`. SP returns void; success is signalled
  //    by `error === null`.
  // -------------------------------------------------------------------------
  const { error } = await supabase.rpc('admin_update_match', {
    p_match_id: matchId,
    p_new_status: newStatus,
    p_new_kickoff_utc: newKickoff,
    p_reason: body.reason,
    p_source_citation: body.source_citation,
  });

  if (error) {
    const code = error.code as AdminERRCODE | string | undefined;
    if (
      code === 'WAR01' ||
      code === 'WAR02' ||
      code === 'WAR03' ||
      code === 'WAR04' ||
      code === 'WAR05' ||
      code === 'WAR06' ||
      code === 'WAR07'
    ) {
      let field: string | undefined;
      if (code === 'WAR02') field = 'reason';
      else if (code === 'WAR03') field = 'source_citation';
      return errorResponse(ERRCODE_HTTP_MAP[code], {
        code,
        message: error.message,
        field,
      });
    }
    // Native Postgres errors (e.g. 22P02 invalid_text_representation on the
    // enum cast for a malformed status value) surface as 500 / INTERNAL
    // here — the route's zod layer already gates the enum, so this is
    // defence-in-depth only.
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 5. Success — slice 003 / slice 004's AFTER UPDATE triggers fired
  //    automatically from the SP's UPDATE statement.
  // -------------------------------------------------------------------------
  return NextResponse.json(
    { ok: true },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
