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
 * `GET /api/admin/audit` — Paginated search of the admin audit log.
 *
 * Slice 006 (Phase 7, T039). Source of truth:
 *   - `specs/006-admin-overrides/contracts/admin-audit.read.md` §
 *     `GET /api/admin/audit` — paginated search.
 *
 * Query parameters (all optional, locked by contract):
 *   - `action`       string  (LIKE pattern supported: 'admin.%')
 *   - `actor`        uuid    (filter by admin participant id)
 *   - `entity_type`  string  (e.g. 'match' / 'prediction')
 *   - `entity_id`    uuid    (filter by target entity)
 *   - `from`, `to`   ISO-8601 UTC (occurred_at window)
 *   - `q`            string  (free-text on `reason` + `source_citation`)
 *   - `page`         int >= 1 (default 1)
 *   - `page_size`    int 1..200 (default 50)
 *
 * Response 200 (locked shape):
 *   {
 *     audit_log: [...rows],
 *     page: number,
 *     page_size: number,
 *     total: number
 *   }
 *
 * Errors: 401 / 403 / 500 standard shapes (see other admin routes).
 *
 * RLS provides defence-in-depth — `audit_log` is admin-readable; non-admins
 * receive empty arrays even if they somehow reached the route handler. We
 * gate with `requireAdmin` first so the 403 path emits the canonical audit
 * row and bypasses the DB read entirely.
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

const QUERY_SCHEMA = z.object({
  action: z.string().min(1).optional(),
  actor: z.string().uuid().optional(),
  entity_type: z.string().min(1).optional(),
  entity_id: z.string().uuid().optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });

  const parsed = QUERY_SCHEMA.safeParse(params);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: firstIssue?.message ?? 'validation failed',
      field: firstIssue?.path.join('.') ?? undefined,
    });
  }
  const q = parsed.data;

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

  // Build the filtered query. Default scope = admin actions only (LIKE
  // 'admin.%') per the contract; an explicit `action` overrides that.
  let query = supabase
    .from('audit_log')
    .select('*', { count: 'exact' });

  if (q.action) {
    // Allow LIKE patterns ('admin.%') if the caller passed a '%' character;
    // exact-match otherwise.
    if (q.action.includes('%')) {
      query = query.like('action', q.action);
    } else {
      query = query.eq('action', q.action);
    }
  } else {
    query = query.like('action', 'admin.%');
  }
  if (q.actor) query = query.eq('actor', q.actor);
  if (q.entity_type) query = query.eq('entity_type', q.entity_type);
  if (q.entity_id) query = query.eq('entity_id', q.entity_id);
  if (q.from) query = query.gte('occurred_at', q.from);
  if (q.to) query = query.lte('occurred_at', q.to);
  if (q.q) {
    // Case-insensitive substring on reason OR source_citation.
    const term = q.q.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.or(
      `reason.ilike.%${term}%,source_citation.ilike.%${term}%`,
    );
  }

  const offset = (q.page - 1) * q.page_size;
  query = query
    .order('occurred_at', { ascending: false })
    .range(offset, offset + q.page_size - 1);

  const { data, error, count } = await query;
  if (error) {
    return errorResponse(500, {
      code: 'INTERNAL',
      message: error.message,
    });
  }

  return NextResponse.json(
    {
      audit_log: data ?? [],
      page: q.page,
      page_size: q.page_size,
      total: count ?? 0,
    },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
