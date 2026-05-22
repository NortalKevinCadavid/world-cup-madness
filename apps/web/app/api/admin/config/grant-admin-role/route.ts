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
 * `POST /api/admin/config/grant-admin-role` — Companion route for the
 * admin-roles editor (Slice 008, Phase 6, T040, US4).
 *
 * Thin wrapper around `admin_config_grant_admin_role(p_participant_id uuid,
 * p_reason text, p_source_citation text)` (slot 0077, shipped by T038).
 *
 * Why a separate route (not folded into upsert): the RPC has a different
 * parameter signature, writes to a different table (`admin_roles`), produces
 * a chained audit trail (`admin.role_granted` from the slice 006 trigger +
 * `tournament_config_versions` row from the RPC body), and surfaces a
 * different ERRCODE set. Keeping it isolated keeps each route surface
 * small and auditable.
 *
 * Contract parameter names (LOCKED — do NOT rename):
 *   - `p_participant_id` (uuid)
 *   - `p_reason`         (text, non-empty)
 *   - `p_source_citation` (text, non-empty for security-sensitive keys)
 *
 * Request body:
 *   { participantId: string (uuid), reason: string, sourceCitation: string }
 *
 * Success response (200): `{ participant_id: <uuid> }` — echoes the RPC return
 * value so the caller can confirm which participant was promoted.
 *
 * ERRCODE → HTTP mapping (per task T040):
 *   - WCG07 → 403 (admin gate)
 *   - WCG02 → 400 (reason / source_citation required)
 *   - any other / INTERNAL → 500
 *
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin role wrappers
 * @see supabase/migrations/0077_configuration.sql § T038
 * @see apps/web/app/admin/config/admin-roles/page.tsx (T040 page surface)
 * @see apps/web/app/admin/config/admin-roles/AdminRolesEditor.tsx (T040 client)
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

// Per T040: WCG07→403, WCG02→400, others→500.
const CONFIG_ERRCODE_HTTP_MAP: Record<string, number> = {
  WCG02: 400,
  WCG07: 403,
};

function mapConfigErrcodeToHttp(code: string | undefined): number {
  if (code && Object.prototype.hasOwnProperty.call(CONFIG_ERRCODE_HTTP_MAP, code)) {
    return CONFIG_ERRCODE_HTTP_MAP[code]!;
  }
  return 500;
}

const BODY_SCHEMA = z.object({
  participantId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  sourceCitation: z.string().min(1).max(1000),
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Parse + validate body BEFORE the admin gate.
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
    const field = firstIssue?.path.join('.') || undefined;
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: firstIssue?.message ?? 'validation failed',
      field,
    });
  }
  const body = parsed.data;

  // 2. Build session-bound client.
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // 3. Admin gate (defence in depth; the RPC also enforces is_admin and
  //    writes its own audit row on denial).
  try {
    await requireAdmin(supabase);
  } catch (err) {
    if (err instanceof AdminAccessDeniedError) {
      return adminDenialResponse(err);
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // 4. Invoke admin_config_grant_admin_role. Parameter names are LOCKED —
  //    pass through verbatim.
  const { data, error } = await supabase.rpc('admin_config_grant_admin_role', {
    p_participant_id: body.participantId,
    p_reason: body.reason.trim(),
    p_source_citation: body.sourceCitation.trim(),
  });

  if (error) {
    const status = mapConfigErrcodeToHttp(error.code ?? undefined);
    return errorResponse(status, {
      code: error.code ?? 'INTERNAL',
      message: error.message,
    });
  }

  // RPC returns uuid (the participant_id, echoed). Defensive: surface a
  // string regardless of how postgrest serialised it.
  const participantId = typeof data === 'string' ? data : String(data ?? body.participantId);

  return NextResponse.json(
    { participant_id: participantId },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
