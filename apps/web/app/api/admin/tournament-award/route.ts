import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../lib/auth/requireAdmin';
import { ERRCODE_HTTP_MAP } from '../../../../lib/admin/rpcs';
import type { AdminERRCODE } from '../../../../lib/admin/types';

/**
 * `POST /api/admin/tournament-award` — Admin override path for correcting
 * one of the four `tournament_award` items (champion, runner_up, top_scorer,
 * best_player).
 *
 * Slice 006 (Phase 5, US3, T031). Source of truth:
 *   - `specs/006-admin-overrides/contracts/admin-ui.surface.md` §
 *     `/admin/finals` — per-item form posts here.
 *   - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` §
 *     `admin_update_tournament_award` + § ERRCODE → HTTP mapping.
 *   - `supabase/migrations/0068_admin_update_tournament_award.sql` (T030) —
 *     SP signature:
 *       `admin_update_tournament_award(p_item_kind, p_new_team_id,
 *                                      p_new_player_id, p_new_status,
 *                                      p_reason, p_source_citation)`
 *
 * Behaviour summary (locked, per-spec):
 *   1. Parse + zod-validate the JSON body BEFORE the admin gate (slice
 *      003/004/T015 pattern — avoids leaking "valid input but not admin" vs
 *      "admin but bad input"). Empty `reason` / `source_citation` surface
 *      as field-level 400 errors here, matching what the SP's WAR02/WAR03
 *      pre-flight would have raised.
 *   2. Build a session-bound (user-JWT) Supabase client.
 *   3. `await requireAdmin(client)` — composes slice 001's `requireEligible()`
 *      with the slot 0062 `is_admin()` RPC.
 *        - `AdminAccessDeniedError('no_session')`   → 401 UNAUTHENTICATED
 *        - `AdminAccessDeniedError('not_eligible')` → 403 FORBIDDEN
 *        - `AdminAccessDeniedError('not_admin')`    → 403 FORBIDDEN
 *   4. Dispatch `target_id` to either `p_new_team_id` (champion / runner_up)
 *      or `p_new_player_id` (top_scorer / best_player). The SP's Step 4
 *      shape-validation is the source of truth; this route only routes the
 *      single `target_id` body field to the correct SP parameter.
 *   5. Call `admin_update_tournament_award` via `client.rpc(...)`. ERRCODE
 *      → HTTP per the locked table:
 *        - WAR01 → 403 FORBIDDEN
 *        - WAR02 → 400 BAD_REQUEST (reason)
 *        - WAR03 → 400 BAD_REQUEST (source_citation)
 *        - WAR04 → 400 BAD_REQUEST when the MESSAGE carries shape-validation
 *          substrings (invalid item_kind/status, kind/target shape mismatch,
 *          confirmed-without-id); otherwise 404 NOT_FOUND (no tournament_award
 *          row exists).
 *        - WAR07 → 409 NO_OP
 *      Any other ERRCODE → 500 INTERNAL.
 *   6. On success the SP returns void; echo `{ ok: true }`. Slice 005's
 *      `award_confirmed_trigger` (slot 0059) fires `pg_net.http_post` to the
 *      score-trigger Edge Function with `scope='finals'` automatically — no
 *      client-side recalc dispatch.
 *
 * Body shape (locked — drives the test wire format and AwardCorrectionForm):
 *   {
 *     item_kind:        'champion' | 'runner_up' | 'top_scorer' | 'best_player',
 *     target_id?:       uuid (optional/nullable; required by SP when
 *                       status='confirmed'),
 *     status:           'pending' | 'confirmed',
 *     reason:           non-empty string,
 *     source_citation:  non-empty string,
 *   }
 *
 * Cache-Control: `no-store` on every response (admin writes are never
 * cacheable; the response is audit-emitting state mutation).
 *
 * NEVER uses the service-role key.
 *
 * @see specs/006-admin-overrides/contracts/admin-rpcs.write.md
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see apps/web/lib/auth/requireAdmin.ts
 * @see apps/web/lib/admin/rpcs.ts
 * @see supabase/migrations/0068_admin_update_tournament_award.sql
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — every response, including errors.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = 'no-store';

// ---------------------------------------------------------------------------
// Error helpers — envelope shape mirrors slice 006's other route handlers
// (match-results, matches/[id], recalc). `field` carries the zod path for
// 400 validation errors so the UI can surface inline messages.
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
// `target_id` is optional + nullable: the SP allows a status flip
// (confirmed -> pending) without changing the id; only 'confirmed' requires
// a non-NULL id and the SP enforces that as WAR04 (defence in depth — the
// client is expected to surface this validation pre-submit).
// ---------------------------------------------------------------------------

const ITEM_KIND_VALUES = [
  'champion',
  'runner_up',
  'top_scorer',
  'best_player',
] as const;

const STATUS_VALUES = ['pending', 'confirmed'] as const;

const BODY_SCHEMA = z.object({
  item_kind: z.enum(ITEM_KIND_VALUES),
  target_id: z.string().uuid().optional().nullable(),
  status: z.enum(STATUS_VALUES),
  reason: z.string().min(1, 'reason is required'),
  source_citation: z.string().min(1, 'source_citation is required'),
});

type Body = z.infer<typeof BODY_SCHEMA>;

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Never uses the
// service-role key. Mirrors slice 003/004 route handlers and slice 006's
// other admin routes.
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

/**
 * Dispatch the single body `target_id` to either the team or player SP
 * parameter based on `item_kind`. The SP's Step 4 shape-validation is the
 * source of truth; here we only route the value, never invent it.
 */
function dispatchTargetIds(body: Body): {
  p_new_team_id: string | null;
  p_new_player_id: string | null;
} {
  const target = body.target_id ?? null;
  if (body.item_kind === 'champion' || body.item_kind === 'runner_up') {
    return { p_new_team_id: target, p_new_player_id: null };
  }
  // top_scorer / best_player
  return { p_new_team_id: null, p_new_player_id: target };
}

/**
 * WAR04 is dual-purposed by the SP:
 *   * shape/enum validation failures (invalid item_kind, invalid status,
 *     kind/target shape mismatch, confirmed-without-id) — these are
 *     client-input bugs and map cleanly to 400.
 *   * "no tournament_award row exists" — a genuine 404.
 *
 * We sniff the SP's MESSAGE for the shape-validation substrings emitted by
 * slot 0068 (`invalid item_kind`, `invalid status`, `requires`, `confirmed`).
 * Anything else falls back to the ERRCODE_HTTP_MAP default (404).
 */
function refineWar04Status(message: string | undefined): number {
  if (!message) return ERRCODE_HTTP_MAP.WAR04;
  const m = message.toLowerCase();
  if (
    m.includes('invalid item_kind') ||
    m.includes('invalid status') ||
    m.includes('requires') ||
    m.includes('confirmed')
  ) {
    return 400;
  }
  return ERRCODE_HTTP_MAP.WAR04;
}

// ---------------------------------------------------------------------------
// POST handler.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 1. Parse + validate body FIRST (before auth gate).
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
  // 3. Admin gate. `requireAdmin` composes slice 001's `requireEligible()`
  //    with the slot 0062 `is_admin()` RPC, and writes the audit row on
  //    the `not_admin` branch.
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
  // 4. Invoke the SP via direct rpc(...) — the SP returns void on success
  //    and raises WAR01-04/07 on failure. We use direct rpc rather than a
  //    typed wrapper because the surface is single-call and the error path
  //    needs fine-grained MESSAGE introspection (WAR04 dual-purpose).
  // -------------------------------------------------------------------------
  const { p_new_team_id, p_new_player_id } = dispatchTargetIds(body);
  const { error } = await supabase.rpc('admin_update_tournament_award', {
    p_item_kind: body.item_kind,
    p_new_team_id,
    p_new_player_id,
    p_new_status: body.status,
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
      const status =
        code === 'WAR04'
          ? refineWar04Status(error.message)
          : ERRCODE_HTTP_MAP[code];
      let field: string | undefined;
      if (code === 'WAR02') field = 'reason';
      else if (code === 'WAR03') field = 'source_citation';
      else if (code === 'WAR04') {
        const m = (error.message ?? '').toLowerCase();
        if (m.includes('invalid item_kind')) field = 'item_kind';
        else if (m.includes('invalid status')) field = 'status';
        else if (m.includes('requires') || m.includes('confirmed'))
          field = 'target_id';
      }
      return errorResponse(status, {
        code,
        message: error.message,
        field,
      });
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 5. Success — Slice 005's award_confirmed_trigger fires the score-trigger
  //    Edge Function via pg_net AFTER the SP's UPDATE returns; no explicit
  //    recalc call needed here.
  // -------------------------------------------------------------------------
  return NextResponse.json(
    { ok: true },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
