import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../lib/auth/requireAdmin';
import { configUpsert, ConfigClientError } from '../../../../../lib/config-client';

/**
 * `POST /api/admin/config/upsert` — Companion route for the configuration
 * editor surfaces (Slice 008, Phase 3, T027, US1).
 *
 * Thin wrapper around `admin_config_upsert(p_key, p_value,
 * p_expected_version_id, p_reason, p_source_citation, p_acknowledge_token)`
 * (slot 0077). Validates wire shape via zod, gates via `requireAdmin`,
 * delegates the RPC to T017's `configUpsert` typed wrapper, and maps any
 * ERRCODE the RPC raises (WCG01..WCG07) to a JSON error envelope with HTTP
 * status per the locked table below.
 *
 * Request body (locked):
 *   {
 *     key:                 string (non-empty, <= 200 chars),
 *     value:               unknown (per-key schema enforced by T018 / SP),
 *     expected_version_id: number | string (bigint, optimistic concurrency
 *                          token returned by the previous read or upsert),
 *     reason:              string (non-empty, <= 2000 chars),
 *     source_citation:     string | null (optional, <= 1000 chars),
 *     acknowledge_token:   uuid | null (required when preview reported
 *                          `affecting=true`; consumed in a single
 *                          transaction)
 *   }
 *
 * Success response (200): `{ version_id: number }` — the new version id
 * returned by the RPC (a fresh row in `tournament_config_versions`).
 *
 * ERRCODE → HTTP mapping (locked):
 *   - WCG01 → 409 (optimistic version conflict — expected_version_id mismatch)
 *   - WCG02 → 400 (validation failure — value, reason, etc.)
 *   - WCG03 → 400 (unknown configuration key)
 *   - WCG04 → 403 (admin required — should not surface; requireAdmin gates)
 *   - WCG05 → 409 (affecting-data change requires acknowledge_token)
 *   - WCG06 → 410 (acknowledge_token expired/consumed)
 *   - WCG07 → 403 (secret key may not be set via this RPC; use
 *                   admin_config_set_secret in T040+)
 *   - any other / INTERNAL → 500
 *
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md
 * @see apps/web/lib/config-client.ts § configUpsert
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
// Body schema. `expected_version_id` accepts number OR string to tolerate
// bigint values that exceed Number.MAX_SAFE_INTEGER in the JSON payload.
// `value` is unknown (per-key validation lives in T018 client-side; the SP
// re-validates with value_type-aware checks server-side → WCG02).
// ---------------------------------------------------------------------------

const BODY_SCHEMA = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
  expected_version_id: z.union([z.number().int(), z.string().min(1)]),
  reason: z.string().min(1).max(2000),
  source_citation: z.string().min(1).max(1000).nullable().optional(),
  acknowledge_token: z.string().uuid().nullable().optional(),
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

// ---------------------------------------------------------------------------
// POST handler.
// ---------------------------------------------------------------------------

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

  // 3. Admin gate.
  try {
    await requireAdmin(supabase);
  } catch (err) {
    if (err instanceof AdminAccessDeniedError) {
      return adminDenialResponse(err);
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // 4. Invoke admin_config_upsert via the typed wrapper.
  // `expected_version_id` may arrive as number OR string per the BODY_SCHEMA
  // union; the typed wrapper's transform expects a string post-parse, so we
  // normalise here. Bigint-safe: stringify large numbers before the wrapper
  // re-validates.
  const expectedVersionIdStr =
    typeof body.expected_version_id === 'number'
      ? String(body.expected_version_id)
      : body.expected_version_id;
  try {
    const newVersionId = await configUpsert(supabase, {
      key: body.key,
      value: body.value,
      expected_version_id: expectedVersionIdStr,
      reason: body.reason,
      source_citation: body.source_citation ?? null,
      acknowledge_token: body.acknowledge_token ?? null,
    });
    return NextResponse.json(
      { version_id: newVersionId },
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
