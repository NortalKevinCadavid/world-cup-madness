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
 * `POST /api/admin/predictions` — Admin submits a match prediction on behalf
 * of a participant.
 *
 * Slice 006 (Phase 7, T039). Source of truth:
 *   - `specs/006-admin-overrides/contracts/admin-ui.surface.md` §
 *     `/admin/predictions/[participant]` — "Submit Prediction on Behalf" form
 *     posts here.
 *   - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` §
 *     `admin_submit_prediction(p_participant_id, p_match_id, p_home, p_away,
 *      p_reason, p_source_citation)`.
 *
 * Behaviour summary (locked, per-spec):
 *   1. Parse + zod-validate body BEFORE the admin gate (slice 003/004
 *      pattern). Empty `reason` / `source_citation` surface as field-level
 *      400 errors here matching what the SP's WAR02/WAR03 pre-flight would
 *      have raised.
 *   2. Build a session-bound (user-JWT) Supabase client.
 *   3. `await requireAdmin(client)`.
 *   4. Call `admin_submit_prediction` via `client.rpc(...)`. The SP routes
 *      internally between Slice 003's regular `submit_prediction` (when not
 *      locked) and the sibling `admin_submit_prediction_bypass_lock` (when
 *      locked) — the admin RPC owns the lock-bypass decision.
 *   5. ERRCODE → HTTP per the locked table (WAR01-07 → ERRCODE_HTTP_MAP).
 *   6. On success the SP returns the affected `predictions.id` (uuid). Echo
 *      it back as `{ prediction_id }`.
 *
 * Body shape (locked):
 *   {
 *     participant_id:   uuid,
 *     match_id:         uuid,
 *     home_score:       int >= 0,
 *     away_score:       int >= 0,
 *     reason:           non-empty string,
 *     source_citation:  non-empty string,
 *   }
 *
 * Cache-Control: `no-store`.
 * NEVER uses the service-role key.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_CONTROL = 'no-store';

interface ErrorPayload {
  code: string;
  message?: string;
  reason?: string;
  field?: string;
}

function errorResponse(status: number, payload: ErrorPayload): NextResponse {
  return NextResponse.json(
    { error: payload },
    { status, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}

const INTERNAL_BODY: ErrorPayload = {
  code: 'INTERNAL',
  message: 'Internal server error.',
};

const BODY_SCHEMA = z.object({
  participant_id: z.string().uuid(),
  match_id: z.string().uuid(),
  home_score: z.number().int().min(0).max(99),
  away_score: z.number().int().min(0).max(99),
  reason: z.string().min(1, 'reason is required'),
  source_citation: z.string().min(1, 'source_citation is required'),
});

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
        /* read-only: middleware refreshes cookies */
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

export async function POST(request: NextRequest): Promise<NextResponse> {
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
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: firstIssue?.message ?? 'validation failed',
      field: firstIssue?.path.join('.') ?? undefined,
    });
  }
  const body = parsed.data;

  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  try {
    await requireAdmin(supabase);
  } catch (err) {
    if (err instanceof AdminAccessDeniedError) {
      return adminDenialResponse(err);
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  const { data, error } = await supabase.rpc('admin_submit_prediction', {
    p_participant_id: body.participant_id,
    p_match_id: body.match_id,
    p_home: body.home_score,
    p_away: body.away_score,
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
    return errorResponse(500, INTERNAL_BODY);
  }

  return NextResponse.json(
    { prediction_id: data as string },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
