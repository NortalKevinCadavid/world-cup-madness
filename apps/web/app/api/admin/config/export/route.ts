import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../lib/auth/requireAdmin';

/**
 * `GET /api/admin/config/export` — Companion route for the import/export page
 * (Slice 008, Phase 8a, T055, US5).
 *
 * Thin wrapper around `admin_config_export()` (slot 0077 § T052 — SHIPPED,
 * lines 1918–2022). Gates via `requireAdmin`, calls the RPC directly (the
 * envelope shape is wide and pass-through — no extra typed wrapper buys
 * anything here that a fetch call doesn't), and returns the signed JSON
 * envelope as a downloadable attachment.
 *
 * Why a dedicated route (not folded into an RPC proxy):
 *   The response must carry a `Content-Disposition: attachment` header so the
 *   browser triggers a file download instead of rendering the JSON inline. A
 *   generic JSON proxy would not set that header. The route also derives the
 *   filename (env + ISO timestamp) so the file name is consistent across
 *   admins / environments.
 *
 * Filename format:
 *   `world-cup-madness-config-<env>-<timestamp>.json`
 *   - `<env>` is taken from the envelope's `environment` field
 *     (`app.environment_label` GUC at export time; `'unknown'` if unset).
 *   - `<timestamp>` is the current ISO-8601 instant with `:` replaced by `-`
 *     and `.` replaced by `-` so the filename is filesystem-safe on Windows.
 *     (Colons and dots in stems are legal on POSIX but problematic on NTFS;
 *     we normalise unconditionally rather than branch on user-agent.)
 *
 * Success response (200): the full signed envelope as `application/json` with
 * a `Content-Disposition: attachment; filename="..."` header. Body is the
 * unmodified jsonb returned by `admin_config_export()` (see the SP body for
 * the locked schema: schema_version, exported_at, exported_by, environment,
 * current_config, version_history, signature).
 *
 * ERRCODE → HTTP mapping (per task T055):
 *   - WCG07 → 403 (caller is not admin; should not surface — requireAdmin
 *                   gates first — but the SP also enforces it)
 *   - WCG08 → 409 (signing secret GUC not configured; the SP refuses to
 *                   export an unsigned envelope, so we surface as Conflict
 *                   with a stable `export_secret_not_configured` code so
 *                   the UI can render a friendly banner)
 *   - any other / INTERNAL → 500
 *
 * @see specs/008-configuration/tasks.md § T055
 * @see specs/008-configuration/contracts/config-version-history.read.md § admin_config_export
 * @see supabase/migrations/0077_configuration.sql (lines 1918..2022: T052 body)
 * @see apps/web/app/admin/config/import-export/page.tsx (T054 page)
 * @see apps/web/app/api/admin/config/import/route.ts (T056 sibling route)
 * @see apps/web/lib/auth/requireAdmin.ts
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_CONTROL = 'no-store';

interface ErrorPayload {
  code: string;
  message?: string;
  reason?: string;
  error?: string;
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

// Per T055: WCG07→403, WCG08→409 (export-secret-not-configured), others→500.
const CONFIG_ERRCODE_HTTP_MAP: Record<string, number> = {
  WCG07: 403,
  WCG08: 409,
};

function mapConfigErrcodeToHttp(code: string | undefined): number {
  if (code && Object.prototype.hasOwnProperty.call(CONFIG_ERRCODE_HTTP_MAP, code)) {
    return CONFIG_ERRCODE_HTTP_MAP[code]!;
  }
  return 500;
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

/**
 * Derive a filesystem-safe timestamp segment for the export filename.
 * `2026-05-21T14:32:07.541Z` → `2026-05-21T14-32-07-541Z`. Colons and dots
 * are normalised because NTFS rejects both in filename stems.
 */
function safeTimestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

/**
 * Coerce the envelope's `environment` field to a filesystem-safe slug.
 * The export RPC returns the value of `app.environment_label` (or
 * `'unknown'`); production usage will be `'dev'`/`'staging'`/`'prod'` but
 * any other value is sanitised here defensively so the Content-Disposition
 * filename never contains characters that break the header.
 */
function safeEnvSlug(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  const slug = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return slug.length > 0 ? slug : 'unknown';
}

// ---------------------------------------------------------------------------
// GET handler.
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  // 1. Build a session-bound (user-JWT) Supabase client.
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // 2. Admin gate. The RPC also enforces is_admin (WCG07) but failing fast
  //    here centralises the 401-vs-403 distinction for unauthenticated callers.
  try {
    await requireAdmin(supabase);
  } catch (err) {
    if (err instanceof AdminAccessDeniedError) {
      return adminDenialResponse(err);
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // 3. Invoke admin_config_export. The RPC returns the full signed envelope
  //    as jsonb — we pass it through unmodified so the import side can
  //    re-verify the signature byte-for-byte.
  const { data, error } = await supabase.rpc('admin_config_export');

  if (error) {
    const code = error.code;
    if (code === 'WCG08') {
      // Stable client-side error code so the UI can render the "configure the
      // signing secret" runbook link.
      return errorResponse(409, {
        code: 'WCG08',
        error: 'export_secret_not_configured',
        message: error.message,
      });
    }
    const status = mapConfigErrcodeToHttp(code);
    return errorResponse(status, {
      code: code ?? 'INTERNAL',
      message: error.message,
    });
  }

  // Defensive: the RPC contract guarantees a jsonb object; if postgrest hands
  // us a string (unlikely but possible across driver versions), parse it.
  let envelope: Record<string, unknown>;
  if (typeof data === 'string') {
    try {
      envelope = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return errorResponse(500, INTERNAL_BODY);
    }
  } else if (data && typeof data === 'object') {
    envelope = data as Record<string, unknown>;
  } else {
    return errorResponse(500, INTERNAL_BODY);
  }

  const env = safeEnvSlug(envelope.environment);
  const timestamp = safeTimestamp();
  const filename = `world-cup-madness-config-${env}-${timestamp}.json`;

  // Pretty-print the envelope on the wire. The signature is computed over the
  // Postgres `::text` cast (deterministic, keys-sorted, minimal whitespace),
  // so adding whitespace HERE does not affect signature verification — the
  // import side strips `signature` from the envelope and recomputes the hash
  // against `(envelope - 'signature')::text`, which is the Postgres
  // canonical form, not whatever the route handler chose to emit.
  return new NextResponse(JSON.stringify(envelope, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': CACHE_CONTROL,
    },
  });
}
