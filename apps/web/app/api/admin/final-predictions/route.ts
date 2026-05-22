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
 * `POST /api/admin/final-predictions` — Admin submits a final prediction on
 * behalf of a participant.
 *
 * Slice 006 (Phase 7, T039). Source of truth:
 *   - `specs/006-admin-overrides/contracts/admin-ui.surface.md` §
 *     `/admin/predictions/[participant]` — "Submit Final Prediction on Behalf"
 *     form posts here.
 *   - `specs/006-admin-overrides/contracts/admin-rpcs.write.md` §
 *     `admin_submit_final_prediction(p_participant_id, p_item_kind,
 *      p_target_team_id, p_target_player_id, p_reason, p_source_citation)`.
 *
 * Behaviour:
 *   1. Parse + zod-validate body BEFORE the admin gate.
 *   2. Build a session-bound (user-JWT) Supabase client.
 *   3. `await requireAdmin(client)`.
 *   4. Dispatch `target_id` to either `p_target_team_id`
 *      (champion / runner_up) or `p_target_player_id`
 *      (top_scorer / best_player). Mirrors the same dispatch logic used by
 *      `/api/admin/tournament-award`.
 *   5. Call `admin_submit_final_prediction` via `client.rpc(...)`. ERRCODE
 *      → HTTP per the locked table.
 *   6. On success the SP returns the affected `final_predictions.id`.
 *
 * Body shape (locked):
 *   {
 *     participant_id:   uuid,
 *     item_kind:        'champion' | 'runner_up' | 'top_scorer' | 'best_player',
 *     target_id:        uuid,
 *     reason:           non-empty string,
 *     source_citation:  non-empty string,
 *   }
 *
 * Cache-Control: `no-store`. NEVER uses the service-role key.
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

const ITEM_KIND_VALUES = [
  'champion',
  'runner_up',
  'top_scorer',
  'best_player',
] as const;

const BODY_SCHEMA = z.object({
  participant_id: z.string().uuid(),
  item_kind: z.enum(ITEM_KIND_VALUES),
  target_id: z.string().uuid(),
  reason: z.string().min(1, 'reason is required'),
  source_citation: z.string().min(1, 'source_citation is required'),
});

type Body = z.infer<typeof BODY_SCHEMA>;

function dispatchTargetIds(body: Body): {
  p_target_team_id: string | null;
  p_target_player_id: string | null;
} {
  if (body.item_kind === 'champion' || body.item_kind === 'runner_up') {
    return { p_target_team_id: body.target_id, p_target_player_id: null };
  }
  return { p_target_team_id: null, p_target_player_id: body.target_id };
}

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
        /* read-only */
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

  const { p_target_team_id, p_target_player_id } = dispatchTargetIds(body);
  const { data, error } = await supabase.rpc('admin_submit_final_prediction', {
    p_participant_id: body.participant_id,
    p_item_kind: body.item_kind,
    p_target_team_id,
    p_target_player_id,
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
    { final_prediction_id: data as string },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
