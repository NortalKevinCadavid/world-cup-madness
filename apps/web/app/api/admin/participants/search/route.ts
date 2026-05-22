import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../lib/auth/requireAdmin';

/**
 * `GET /api/admin/participants/search` — Companion route for the admin-roles
 * editor (Slice 008, Phase 6, T040, US4).
 *
 * Autocomplete-style search over `public.participants` used by the
 * `/admin/config/admin-roles` page's "Grant admin role" form. The page lets an
 * admin grant the role by email (or display name); this endpoint returns up
 * to 10 matching active participants for a given query string.
 *
 * Why a dedicated endpoint (not folded into the existing `/api/admin/*` set):
 *   The admin-roles editor (T040) needs a lightweight participant lookup that
 *   does not exist elsewhere. Putting it under `/api/admin/participants/*`
 *   keeps the URL stable so future admin surfaces (audit search, deactivate
 *   participant, etc.) can extend the namespace without churn.
 *
 * Request:
 *   GET /api/admin/participants/search?q=<string>&limit=<n>
 *     - `q`     : required, min length 2 chars (whitespace-trimmed). 400 if absent or shorter.
 *     - `limit` : optional, integer 1..10 (default 5; capped at 10).
 *
 * Success response (200): `{ results: Array<{ id, email, display_name }> }`
 *
 * ERRCODE → HTTP mapping (per task T040):
 *   - 401 — UNAUTHENTICATED (no session)
 *   - 403 — FORBIDDEN      (not eligible / not admin)
 *   - 400 — BAD_REQUEST    (missing / too-short q, or otherwise invalid params)
 *   - 500 — INTERNAL       (Supabase env missing, query failure, etc.)
 *
 * Implementation notes:
 *   - Session-bound (anon key + caller cookies) Supabase client mirrors the
 *     /api/admin/config/* route handlers in this slice.
 *   - The SELECT uses two ILIKE filters (`email`, `display_name`) joined by
 *     PostgREST's `.or(...)` filter, plus `status='active'`. The
 *     `tournament_config_read_all`-style policy is NOT involved here — slice
 *     001's participants RLS exposes the row to its owner by default; admin
 *     callers MUST be able to read all rows for this search to work, which is
 *     handled by the admin-targeted RLS policy on `participants` (slot 0001
 *     ships `participants_admin_read`).
 *   - Wildcard escaping: `%` and `_` are stripped from `q` so user-typed
 *     wildcards do not accidentally widen the search. (We never trust user
 *     input as a PostgREST `like` operator literal.)
 *
 * @see specs/008-configuration/tasks.md § T040
 * @see apps/web/app/admin/config/admin-roles/page.tsx (T040 page surface)
 * @see apps/web/app/admin/config/admin-roles/AdminRolesEditor.tsx (T040 client)
 * @see apps/web/lib/auth/requireAdmin.ts
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
  q: z.string().trim().min(2).max(200),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null || v === '') return 5;
      const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
      if (!Number.isFinite(n) || Number.isNaN(n)) return 5;
      return Math.min(Math.max(Math.trunc(n), 1), 10);
    }),
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
        /* read-only — cookie refresh is owned by middleware. */
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

/** Strip postgrest `like`/`ilike` wildcards so user input cannot widen the
 *  search. We add our OWN `%` wildcards in the filter expression below. */
function sanitizeQuery(raw: string): string {
  return raw.replace(/[%_]/g, '');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Parse + validate query params.
  const url = new URL(request.url);
  const parsed = QUERY_SCHEMA.safeParse({
    q: url.searchParams.get('q') ?? '',
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue?.path.join('.') || undefined;
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: firstIssue?.message ?? 'validation failed',
      field,
    });
  }
  const { q, limit } = parsed.data;
  const sanitized = sanitizeQuery(q);
  if (sanitized.length < 2) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Query too short after sanitization (min 2 chars).',
      field: 'q',
    });
  }

  // 2. Build session-bound client.
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // 3. Admin gate.
  try {
    await requireAdmin(supabase);
  } catch (err) {
    if (err instanceof AdminAccessDeniedError) {
      return adminDenialResponse(err);
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // 4. Search participants.
  //    `or(email.ilike.%q%,display_name.ilike.%q%)` returns rows matching
  //    EITHER field. `status='active'` filters out deactivated rows.
  const pattern = `%${sanitized}%`;
  const { data, error } = await supabase
    .from('participants')
    .select('id, email, display_name')
    .or(`email.ilike.${pattern},display_name.ilike.${pattern}`)
    .eq('status', 'active')
    .order('email', { ascending: true })
    .limit(limit);

  if (error) {
    return errorResponse(500, {
      code: 'INTERNAL',
      message: `participants search failed: ${error.message}`,
    });
  }

  return NextResponse.json(
    {
      results: (data ?? []).map((row) => ({
        id: row.id as string,
        email: row.email as string,
        display_name: row.display_name as string,
      })),
    },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
