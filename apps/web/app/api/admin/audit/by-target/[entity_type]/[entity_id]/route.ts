import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../../../lib/auth/requireAdmin';
import { getAuditByTarget } from '../../../../../../../lib/admin/audit';

/**
 * `GET /api/admin/audit/by-target/[entity_type]/[entity_id]` — Full audit
 * history for a specific (entity_type, entity_id) pair.
 *
 * Slice 006 (Phase 7, T039). Source of truth:
 *   - `specs/006-admin-overrides/contracts/admin-audit.read.md` §
 *     `GET /api/admin/audit/by-target/[entity_type]/[entity_id]`.
 *
 * Response 200 (locked shape):
 *   {
 *     target: { entity_type, entity_id },
 *     audit_log: [ ...all audit_log rows for this target, time-ordered ],
 *     current_state: null | { ... }
 *   }
 *
 * For entity_type='match' the contract specifies including non-admin lifecycle
 * rows (sync coordinator `match.created`/`match.updated`); the
 * `getAuditByTarget` helper already returns ALL rows targeting the entity
 * regardless of action prefix, so the response naturally satisfies that.
 *
 * `current_state` is best-effort: for known entity_types (match, prediction,
 * tournament_award) we fetch the live row; for unknown types we return null.
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
    default:
      return errorResponse(500, INTERNAL_BODY);
  }
}

async function fetchCurrentState(
  supabase: ReturnType<typeof createSessionBoundClient>,
  entity_type: string,
  entity_id: string,
): Promise<unknown> {
  try {
    if (entity_type === 'match') {
      const { data } = await supabase
        .from('matches')
        .select('*')
        .eq('id', entity_id)
        .maybeSingle();
      return data ?? null;
    }
    if (entity_type === 'match_result') {
      const { data } = await supabase
        .from('match_results')
        .select('*')
        .eq('match_id', entity_id)
        .maybeSingle();
      return data ?? null;
    }
    if (entity_type === 'prediction') {
      const { data } = await supabase
        .from('predictions')
        .select('*')
        .eq('id', entity_id)
        .maybeSingle();
      return data ?? null;
    }
    if (entity_type === 'tournament_award') {
      const { data } = await supabase
        .from('tournament_award')
        .select('*')
        .eq('tournament_id', entity_id)
        .maybeSingle();
      return data ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function GET(
  _request: NextRequest,
  context: { params: { entity_type: string; entity_id: string } },
): Promise<NextResponse> {
  const { entity_type, entity_id } = context.params;

  // Entity type must be a short, well-formed identifier. UUID required for id.
  const typeCheck = z.string().min(1).max(64).safeParse(entity_type);
  const idCheck = z.string().uuid().safeParse(entity_id);
  if (!typeCheck.success) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Invalid entity_type.',
      field: 'entity_type',
    });
  }
  if (!idCheck.success) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Invalid entity_id.',
      field: 'entity_id',
    });
  }

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

  const rows = await getAuditByTarget(supabase, entity_type, entity_id).catch(
    () => [],
  );
  const current_state = await fetchCurrentState(
    supabase,
    entity_type,
    entity_id,
  );

  return NextResponse.json(
    {
      target: { entity_type, entity_id },
      audit_log: rows,
      current_state,
    },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
