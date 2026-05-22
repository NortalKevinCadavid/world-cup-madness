import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../lib/auth/requireAdmin';
import { configRollback, ConfigClientError } from '../../../../../lib/config-client';

/**
 * `POST /api/admin/config/rollback` — Companion route for the version-history
 * page (Slice 008, Phase 7, T048, US5).
 *
 * Thin wrapper around `admin_config_rollback(p_target_version_id, p_reason,
 * p_source_citation)` (slot 0077 § T046 — SHIPPED). Validates wire shape via
 * zod, gates via `requireAdmin`, delegates the RPC to T017's `configRollback`
 * typed wrapper, and maps any ERRCODE the RPC raises to a JSON error envelope
 * per the locked table below.
 *
 * Why a separate route (not folded into upsert): rollback writes a single
 * audit row prefixed with "Rollback to version N:" and emits a versions row
 * with `change_kind='admin_rollback'` + `parent_version_id=target`. It does
 * NOT consume an acknowledge_token and the wire body is materially different
 * (no `value`, no `expected_version_id`). Keeping it isolated also gives the
 * history page a single failure surface to handle.
 *
 * Request body (locked):
 *   {
 *     targetVersionId:  number | string  // bigint; passed-through as a
 *                                         // decimal string to survive JSON
 *                                         // precision when version_id
 *                                         // exceeds Number.MAX_SAFE_INTEGER.
 *     reason:           string           // non-empty, <= 2000 chars.
 *                                         // RPC also re-checks (WCG02).
 *     sourceCitation:   string | null    // optional, <= 1000 chars. The
 *                                         // RPC default is NULL.
 *   }
 *
 * Success response (200): `{ new_version_id: string }` — the new rollback
 * row's `version_id`, serialised as a decimal string so callers never lose
 * precision on bigint values.
 *
 * ERRCODE → HTTP mapping (per task T048):
 *   - WCG02 → 400 (validation — reason missing/empty, etc.)
 *   - WCG03 → 404 (target version doesn't exist OR the key vanished
 *                   between target capture and the UPDATE)
 *   - WCG04 → 410 (target older than retention horizon — "Gone")
 *   - WCG07 → 403 (caller is not admin; should not surface — requireAdmin
 *                   gates first — but the SP also enforces it)
 *   - any other / INTERNAL → 500
 *
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin_config_rollback
 * @see apps/web/lib/config-client.ts § configRollback
 * @see apps/web/app/admin/config/history/page.tsx (T048 page)
 * @see supabase/migrations/0077_configuration.sql (lines 1681..1811: T046 body)
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

// Per T048: WCG02→400, WCG03→404, WCG04→410 (Gone), WCG07→403, others→500.
const CONFIG_ERRCODE_HTTP_MAP: Record<string, number> = {
  WCG02: 400,
  WCG03: 404,
  WCG04: 410,
  WCG07: 403,
};

function mapConfigErrcodeToHttp(code: string | undefined): number {
  if (code && Object.prototype.hasOwnProperty.call(CONFIG_ERRCODE_HTTP_MAP, code)) {
    return CONFIG_ERRCODE_HTTP_MAP[code]!;
  }
  return 500;
}

// ---------------------------------------------------------------------------
// Body schema. `targetVersionId` accepts number OR string to tolerate bigint
// values that exceed Number.MAX_SAFE_INTEGER in the JSON payload (matches
// the convention in upsert/route.ts).
// ---------------------------------------------------------------------------

const BODY_SCHEMA = z.object({
  targetVersionId: z.union([z.number().int(), z.string().min(1)]),
  reason: z.string().min(1).max(2000),
  sourceCitation: z.string().min(1).max(1000).nullable().optional(),
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
  // 1. Parse + validate body BEFORE the admin gate. Cheap validation up front
  //    avoids leaking timing information about admin membership to junk
  //    payloads and matches the upsert/get-secret pattern.
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

  // Defence in depth: explicit reason-required check mirroring the SP's
  // WCG02 backstop (slot 0077 lines 1722–1726). Surfaces a friendlier error
  // than the raw RPC roundtrip and lines up with the locked HTTP mapping.
  if (body.reason.trim().length === 0) {
    return errorResponse(400, {
      code: 'WCG02',
      message: 'Reason is required for configuration rollbacks',
      field: 'reason',
    });
  }

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

  // 4. Invoke admin_config_rollback via the typed wrapper.
  //    `targetVersionId` may arrive as number OR string per the BODY_SCHEMA
  //    union; the typed wrapper's transform expects a string post-parse, so
  //    we normalise here. Bigint-safe: stringify large numbers before the
  //    wrapper re-validates.
  const targetVersionIdStr =
    typeof body.targetVersionId === 'number'
      ? String(body.targetVersionId)
      : body.targetVersionId;

  try {
    const newVersionId = await configRollback(supabase, {
      target_version_id: targetVersionIdStr,
      reason: body.reason,
      source_citation: body.sourceCitation ?? null,
    });
    // Return as a decimal string so bigint precision survives JSON; the page
    // displays it as text + uses it as an opaque identifier, so string is fine.
    return NextResponse.json(
      { new_version_id: String(newVersionId) },
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
