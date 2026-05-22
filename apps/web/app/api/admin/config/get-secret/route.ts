import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../lib/auth/requireAdmin';
import { configGetSecret, ConfigClientError } from '../../../../../lib/config-client';

/**
 * `POST /api/admin/config/get-secret` — Companion route for the providers
 * editor (Slice 008, Phase 6, T039, US4).
 *
 * Thin wrapper around `admin_config_get_secret(p_key text)` (slot 0077,
 * shipped by T037). Validates wire shape via zod, gates via `requireAdmin`,
 * delegates the RPC to T017's `configGetSecret` typed wrapper, and maps any
 * ERRCODE the RPC raises to a JSON error envelope.
 *
 * Why a separate route (not folded into upsert/preview): the RPC writes a
 * forensic `admin.config_secret_accessed` audit row on every successful call.
 * Routing it through its own endpoint keeps the "every reveal = one audit
 * row" invariant explicit, and prevents accidental coupling to the
 * preview/upsert cache-invalidation hooks (a credential reveal should NOT
 * dirty the `tournament_config_changed` cache).
 *
 * Request body (locked):
 *   { key: string (non-empty, <= 200 chars) }
 *
 * Success response (200): `{ value: <jsonb-as-returned-by-RPC> }` — the raw
 * `{secret: true, value: "..."}` jsonb from `tournament_config.value`. The
 * client wrapper {@link configGetSecret} unwraps `.value` to the inner
 * cleartext; this route returns the un-unwrapped object so the calling page
 * can decide how to surface it (we keep it close to the wire shape so the
 * test harness can assert on the envelope).
 *
 * ERRCODE → HTTP mapping (per task T039):
 *   - WCG07 → 403 (caller is not admin; or RPC denial)
 *   - WCG03 → 404 (key is not a secret-namespace key, or the row is absent)
 *   - any other / INTERNAL → 500
 *
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin_config_get_secret
 * @see apps/web/lib/config-client.ts § configGetSecret
 * @see supabase/migrations/0077_configuration.sql § T037
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

// Per T039: WCG07→403, WCG03→404, others→500.
const CONFIG_ERRCODE_HTTP_MAP: Record<string, number> = {
  WCG03: 404,
  WCG07: 403,
};

function mapConfigErrcodeToHttp(code: string | undefined): number {
  if (code && Object.prototype.hasOwnProperty.call(CONFIG_ERRCODE_HTTP_MAP, code)) {
    return CONFIG_ERRCODE_HTTP_MAP[code]!;
  }
  return 500;
}

const BODY_SCHEMA = z.object({
  key: z.string().min(1).max(200),
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

  // 2. Build a session-bound (user-JWT) Supabase client.
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // 3. Admin gate (defence in depth; the RPC body also enforces is_admin and
  //    writes its own audit row, but failing fast here saves a round-trip
  //    and centralises the 401-vs-403 distinction for unauthenticated callers).
  try {
    await requireAdmin(supabase);
  } catch (err) {
    if (err instanceof AdminAccessDeniedError) {
      return adminDenialResponse(err);
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // 4. Invoke admin_config_get_secret via the typed wrapper.
  //    The wrapper unwraps `{secret:true,value:"<plain>"}` to the inner string
  //    on success; we re-wrap it so the wire envelope matches the RPC's
  //    documented `jsonb` return type, which is what T043 will assert.
  try {
    const plain = await configGetSecret(supabase, { key: body.key });
    return NextResponse.json(
      { value: { secret: true, value: plain } },
      { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
    );
  } catch (e) {
    if (e instanceof ConfigClientError) {
      const status = mapConfigErrcodeToHttp(e.code);
      return errorResponse(status, {
        code: e.code,
        message: e.message,
      });
    }
    return errorResponse(500, INTERNAL_BODY);
  }
}
