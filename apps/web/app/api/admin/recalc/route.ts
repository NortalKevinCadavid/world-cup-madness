import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../lib/auth/requireAdmin';

/**
 * `POST /api/admin/recalc` — Admin trigger for a manual recalculation.
 *
 * Slice 006 (Phase 4, US2, T025). Source of truth:
 *   - `specs/006-admin-overrides/contracts/admin-ui.surface.md` §
 *     `/admin/recalc` — "Trigger Full Recalc" button posts here.
 *   - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` §
 *     `admin_trigger_recalc` + § ERRCODE → HTTP mapping.
 *   - `supabase/migrations/0070_admin_trigger_recalc.sql` (T021).
 *
 * Behaviour summary (locked, per-spec):
 *   1. Parse + zod-validate the JSON body BEFORE the admin gate (slice
 *      003/004 pattern — avoids leaking "valid input but not admin" vs
 *      "admin but bad input"). An empty `reason` therefore surfaces as
 *      400 + field='reason' regardless of admin status.
 *   2. Build a session-bound (user-JWT) Supabase client.
 *   3. `await requireAdmin(client)` — composes slice 001's `requireEligible()`
 *      with the slot 0062 `is_admin()` RPC.
 *        - `AdminAccessDeniedError('no_session')`   → 401 UNAUTHENTICATED
 *        - `AdminAccessDeniedError('not_eligible')` → 403 FORBIDDEN
 *          (reason='not_eligible')
 *        - `AdminAccessDeniedError('not_admin')`    → 403 FORBIDDEN
 *          (reason='admin_required'; audit row written by `requireAdmin`)
 *   4. Call `admin_trigger_recalc(p_scope, p_target_id, p_reason,
 *      p_source_citation)` via `client.rpc(...)`. The SP enforces:
 *        - WAR01 admin role (defence in depth — should never fire here)
 *        - WAR02 reason non-empty / invalid scope
 *        - WAR06 concurrent recalc-in-flight (advisory lock contention)
 *      Map ERRCODE → HTTP per the locked table:
 *        - WAR01 → 403 FORBIDDEN (reason='admin_required')
 *        - WAR02 → 400 BAD_REQUEST
 *        - WAR06 → 409 CONCURRENT_RUN_IN_FLIGHT
 *      Any other ERRCODE → 500 INTERNAL.
 *   5. On success the SP returns the freshly-inserted
 *      `score_calculation_runs.id` (uuid). Echo it back as `{ run_id }`.
 *      The client component then subscribes to Supabase Realtime
 *      `postgres_changes` on the row's id for live status transitions.
 *
 * Body shape (locked — drives the test wire format):
 *   {
 *     scope:            'all' | 'match' | 'finals',
 *     target_id?:       uuid (required when scope='match'),
 *     reason:           non-empty string,
 *     source_citation?: optional string,
 *   }
 *
 * Cache-Control: `no-store` on every response. Admin writes are never
 * cacheable; the response is audit-emitting state mutation.
 *
 * NEVER uses the service-role key.
 *
 * @see specs/006-admin-overrides/contracts/admin-rpcs.write.md
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see apps/web/lib/auth/requireAdmin.ts
 * @see supabase/migrations/0070_admin_trigger_recalc.sql
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — every response, including errors.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = 'no-store';

// ---------------------------------------------------------------------------
// Error envelope helpers.
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
// ---------------------------------------------------------------------------

const SCOPE_VALUES = ['all', 'match', 'finals'] as const;

const BODY_SCHEMA = z.object({
  scope: z.enum(SCOPE_VALUES),
  target_id: z.string().uuid().optional().nullable(),
  reason: z.string().min(1, 'reason is required'),
  source_citation: z.string().optional().nullable(),
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
  //    with the slot 0062 `is_admin()` RPC, and writes the audit row on the
  //    `not_admin` branch (slot 0073 RLS policy).
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
  // 4. Invoke the SP. The SP raises Postgres SQLSTATEs WAR01/WAR02/WAR06 on
  //    its known failure paths; we map each to its locked HTTP status. Any
  //    other SQLSTATE collapses to 500 INTERNAL.
  // -------------------------------------------------------------------------
  const { data, error } = await supabase.rpc('admin_trigger_recalc', {
    p_scope: body.scope,
    p_target_id: body.target_id ?? null,
    p_reason: body.reason,
    p_source_citation: body.source_citation ?? null,
  });

  if (error) {
    const code = error.code;
    if (code === 'WAR01') {
      return errorResponse(403, {
        code: 'FORBIDDEN',
        reason: 'admin_required',
        message: error.message,
      });
    }
    if (code === 'WAR02') {
      return errorResponse(400, {
        code: 'BAD_REQUEST',
        message: error.message,
        field: 'reason',
      });
    }
    if (code === 'WAR06') {
      // Locked UI contract: text MUST match /concurrent|in flight|already.*running/i
      // (slice-006-admin-recalc-concurrent-blocked.spec.ts).
      return errorResponse(409, {
        code: 'CONCURRENT_RUN_IN_FLIGHT',
        reason: 'concurrent',
        message:
          'A recalculation is already in flight. Wait for it to complete before triggering another.',
      });
    }
    return errorResponse(500, {
      code: 'INTERNAL',
      message: error.message,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Success — return the freshly-inserted run_id.
  // -------------------------------------------------------------------------
  return NextResponse.json(
    { run_id: data as string },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    },
  );
}
