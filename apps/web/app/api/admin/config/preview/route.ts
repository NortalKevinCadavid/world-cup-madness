import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../lib/auth/requireAdmin';
import { configPreview, ConfigClientError } from '../../../../../lib/config-client';

/**
 * `POST /api/admin/config/preview` — Companion route for the configuration
 * editor surfaces (Slice 008, Phase 3, T027, US1).
 *
 * Thin wrapper around `admin_config_preview(p_key, p_value)` (slot 0077).
 * Validates wire shape via zod, gates via `requireAdmin`, delegates the RPC
 * to T017's `configPreview` typed wrapper, and maps any ERRCODE the RPC
 * raises (WCG01..WCG07) to a JSON error envelope with HTTP status per the
 * locked table below.
 *
 * Request body (locked):
 *   {
 *     key:   string (non-empty, <= 200 chars),
 *     value: unknown (validated server-side by the SP body)
 *   }
 *
 * Success response (200): `{ affecting, summary, sample, acknowledge_token }`
 *   — pass-through of the SP body's jsonb result.
 *
 * Error envelope:
 *   {
 *     error: { code: string, message?: string, field?: string }
 *   }
 *
 * ERRCODE → HTTP mapping (locked per data-model.md + research.md):
 *   - WCG01 → 409 (version conflict — should not surface on preview, but
 *                   mapped for completeness)
 *   - WCG02 → 400 (validation failure)
 *   - WCG03 → 400 (unknown configuration key)
 *   - WCG04 → 403 (admin required — should not surface; requireAdmin gates)
 *   - WCG05 → 409 (affecting-data preview requires acknowledge — not raised
 *                   by preview itself, but mapped for completeness)
 *   - WCG06 → 410 (acknowledge token expired/consumed — not raised by
 *                   preview)
 *   - WCG07 → 403 (secret key may not be read via preview)
 *   - any other / INTERNAL → 500
 *
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md
 * @see apps/web/lib/config-client.ts § configPreview
 * @see apps/web/lib/auth/requireAdmin.ts
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_CONTROL = 'no-store';

// ---------------------------------------------------------------------------
// Error helpers — shared envelope shape across admin routes.
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
    { status, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}

const INTERNAL_BODY: ErrorPayload = {
  code: 'INTERNAL',
  message: 'Internal server error.',
};

// ---------------------------------------------------------------------------
// Locked ERRCODE → HTTP map for the configuration RPC family (Slice 008).
// ---------------------------------------------------------------------------

const CONFIG_ERRCODE_HTTP_MAP: Record<string, number> = {
  WCG01: 409,
  WCG02: 400,
  WCG03: 400,
  WCG04: 403,
  WCG05: 409,
  WCG06: 410,
  WCG07: 403,
};

function mapConfigErrcodeToHttp(code: string | undefined): number {
  if (code && Object.prototype.hasOwnProperty.call(CONFIG_ERRCODE_HTTP_MAP, code)) {
    return CONFIG_ERRCODE_HTTP_MAP[code]!;
  }
  return 500;
}

// ---------------------------------------------------------------------------
// Request schema. `value` is `unknown` — per-key zod schemas in T018 live in
// `apps/web/lib/config-validators.ts` and are run client-side. The SP body
// re-validates with `value_type`-aware checks server-side (WCG02).
// ---------------------------------------------------------------------------

const BODY_SCHEMA = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
});

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies.
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

// ---------------------------------------------------------------------------
// POST handler.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Parse + validate body BEFORE the admin gate (prevents leaking
  //    "valid input but not admin" vs "admin but bad input").
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

  // 3. Admin gate.
  try {
    await requireAdmin(supabase);
  } catch (err) {
    if (err instanceof AdminAccessDeniedError) {
      return adminDenialResponse(err);
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // 4. Invoke admin_config_preview via the typed wrapper.
  try {
    const result = await configPreview(supabase, {
      key: body.key,
      value: body.value,
    });
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
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
