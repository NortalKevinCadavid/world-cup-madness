import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../lib/auth/requireAdmin';
import { ERRCODE_HTTP_MAP, recordMatchResult } from '../../../../lib/admin/rpcs';

/**
 * `POST /api/admin/match-results` — Admin override path for recording or
 * correcting a match result.
 *
 * Slice 006 (Phase 3, US1, T015). Source of truth:
 *   - `specs/006-admin-overrides/contracts/admin-ui.surface.md` §
 *     `/admin/matches/[id]` — "Correct Score" form posts here.
 *   - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` §
 *     `admin_record_match_result` + § ERRCODE → HTTP mapping.
 *
 * Behaviour summary (locked, per-spec):
 *   1. Parse + zod-validate the JSON body BEFORE the admin gate (slice
 *      003/004 pattern — avoids leaking "valid input but not admin" vs
 *      "admin but bad input"). Empty `reason` / `source_citation` are
 *      surfaced as field-level 400 errors here, matching what slot 0064's
 *      pre-flight would have raised (WAR02/WAR03).
 *   2. Build a session-bound (user-JWT) Supabase client.
 *   3. `await requireAdmin(client)` — composes slice 001's `requireEligible()`
 *      with the slot 0062 `is_admin()` RPC.
 *      - `AdminAccessDeniedError('no_session')`   → 401 UNAUTHENTICATED
 *      - `AdminAccessDeniedError('not_eligible')` → 403 FORBIDDEN
 *        (reason='not_eligible'; audit row already written by slice 001)
 *      - `AdminAccessDeniedError('not_admin')`    → 403 FORBIDDEN
 *        (reason='admin_required'; audit row written by `requireAdmin`)
 *   4. Call `admin_record_match_result` via the typed wrapper in
 *      `lib/admin/rpcs.ts`. The SP enforces:
 *        - WAR01 admin role (defence in depth — should never fire here)
 *        - WAR02 reason non-empty (defence in depth)
 *        - WAR03 source_citation non-empty (defence in depth)
 *        - WAR05 propagated invariant violation (e.g. score_for_scoring >
 *          score_official; match not found; match.status != 'finished')
 *      Map ERRCODE → HTTP per `ERRCODE_HTTP_MAP`.
 *   5. On success, the SP returns the affected `match_id` (uuid). Echo it
 *      back as `{ match_id }`. Slice 005's `match_results_recorded` LISTEN
 *      channel handles auto-recalc — no explicit recalc call here.
 *
 * Body shape (locked — drives the test wire format):
 *   {
 *     match_id:                uuid,
 *     home_score:              int ≥ 0,
 *     away_score:              int ≥ 0,
 *     home_score_for_scoring:  int ≥ 0,
 *     away_score_for_scoring:  int ≥ 0,
 *     result_status:           'regulation' | 'extra_time' | 'penalties_shootout',
 *     reason:                  non-empty string,
 *     source_citation:         non-empty string,
 *   }
 *
 * The `home_score` / `away_score` body keys map to the SP's
 * `p_home_score_official` / `p_away_score_official` parameters — slice
 * 002's column naming uses `home_score` / `away_score` as the "official"
 * columns (see slice-006-admin-match-correct-score-happy.spec.ts comment
 * § MatchResultsRow).
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
 * @see supabase/migrations/0064_admin_record_match_result.sql
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — every response, including errors.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = 'no-store';

// ---------------------------------------------------------------------------
// Error helpers — envelope shape mirrors slice 003/004 / admin-rpcs.write.md
// ERRCODE → HTTP mapping. `field` carries the zod path for 400 validation
// errors so the UI can surface inline messages
// (slice-006-admin-match-correct-score-missing-reason.spec.ts asserts
// `body.error.field === 'reason'`).
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
// `result_status` enum matches the contract values (NOT the DB column values):
// slot 0024's slice-002 SP maps 'penalties_shootout' (contract) →
// 'penalty_shootout' (DB column). We accept the contract names verbatim and
// pass through to the SP.
//
// Scores are bounded [0, 99] at this layer — the SP / slice 002 invariants
// re-check `for_scoring <= official` and the shootout level-check (WAR05).
// ---------------------------------------------------------------------------

const RESULT_STATUS_VALUES = [
  'regulation',
  'extra_time',
  'penalties_shootout',
] as const;

const BODY_SCHEMA = z.object({
  match_id: z.string().uuid(),
  home_score: z.number().int().min(0).max(99),
  away_score: z.number().int().min(0).max(99),
  home_score_for_scoring: z.number().int().min(0).max(99),
  away_score_for_scoring: z.number().int().min(0).max(99),
  result_status: z.enum(RESULT_STATUS_VALUES),
  reason: z.string().min(1, 'reason is required'),
  source_citation: z.string().min(1, 'source_citation is required'),
});

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Same pattern
// as slice 003's /api/predictions and slice 004's /api/me/finals routes.
// Never uses the service-role key.
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
// Map an AdminAccessDeniedError to its HTTP envelope. Locked per
// admin-ui.surface.md § Cross-slice contract summary (WAR01 → 403; no_session
// is a slice-001 inheritance → 401).
// ---------------------------------------------------------------------------

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 1. Parse + validate body FIRST (before auth gate). This matches the
  //    slice 003/004 pattern — avoids leaking "valid input but not admin"
  //    vs "admin but bad input". An empty `reason` therefore surfaces as
  //    400 + field='reason' regardless of admin status, which is exactly
  //    what slice-006-admin-match-correct-score-missing-reason.spec.ts
  //    asserts.
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
  //    the `not_admin` branch (slot 0073 RLS policy).
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
  // 4. Invoke the SP via the typed wrapper. The wrapper preserves the
  //    Postgres ERRCODE (WAR01-06) in the returned envelope; unknown
  //    SQLSTATE values collapse to 'INTERNAL'.
  // -------------------------------------------------------------------------
  const result = await recordMatchResult(supabase, {
    match_id: body.match_id,
    home_score_official: body.home_score,
    away_score_official: body.away_score,
    home_score_for_scoring: body.home_score_for_scoring,
    away_score_for_scoring: body.away_score_for_scoring,
    result_status: body.result_status,
    reason: body.reason,
    source_citation: body.source_citation,
  });

  if (!result.ok) {
    const code = result.error?.code ?? 'INTERNAL';
    if (code === 'INTERNAL') {
      return errorResponse(500, INTERNAL_BODY);
    }
    // Non-admin envelope codes ('BAD_REQUEST' | 'UNAUTHENTICATED' |
    // 'FORBIDDEN') are not produced by the SP wrapper (only WAR01-06), so
    // we can safely look up in ERRCODE_HTTP_MAP for the WAR* family.
    const status =
      code in ERRCODE_HTTP_MAP
        ? ERRCODE_HTTP_MAP[code as keyof typeof ERRCODE_HTTP_MAP]
        : 500;
    // For WAR02 / WAR03 (reason / source_citation missing): the route's
    // own zod layer should have already returned 400 with `field=...`.
    // The SP's own raise is the defence-in-depth fallback — surface the
    // same field-level shape here so behaviour stays consistent.
    let field: string | undefined;
    if (code === 'WAR02') {
      field = 'reason';
    } else if (code === 'WAR03') {
      field = 'source_citation';
    }
    return errorResponse(status, {
      code,
      message: result.error?.message,
      field,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Success — return the affected match_id. Slice 005's score-trigger
  //    LISTEN already fired from slice 002's `record_match_result` SP
  //    (slot 0024 step 9), so no explicit recalc invocation is needed.
  // -------------------------------------------------------------------------
  return NextResponse.json(
    { match_id: result.data!.match_id },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
