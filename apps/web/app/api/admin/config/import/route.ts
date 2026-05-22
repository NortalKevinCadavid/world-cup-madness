import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../lib/auth/requireAdmin';

/**
 * `POST /api/admin/config/import` — Companion route for the import/export page
 * (Slice 008, Phase 8a, T056, US5).
 *
 * Thin wrapper around `admin_config_import(p_envelope jsonb, p_reason text)`
 * (slot 0077 § T053 — SHIPPED, lines 2041–2254). Accepts a multipart form
 * payload (file + reason), parses the file body as JSON, gates via
 * `requireAdmin`, calls the RPC, and surfaces ERRCODE mappings + the RPC's
 * structured success body unchanged.
 *
 * Why multipart (not JSON body):
 *   The UI uses a real `<input type="file">` so the admin can pick a saved
 *   envelope from disk. Streaming the file body through the browser fetch as
 *   multipart keeps the binary path simple and matches the same idiom the
 *   slice 007 audit-import surface uses. The route reads the file synchronously
 *   via `await file.text()` — envelopes are bounded to a handful of KB even
 *   for years of history, so no streaming is needed.
 *
 * Wire format (request):
 *   `Content-Type: multipart/form-data; boundary=...`
 *   - field `file`  (File / Blob, application/json) — the signed export
 *                    envelope produced by `admin_config_export()`.
 *   - field `reason` (text, non-empty, <=2000 chars) — surfaced into both the
 *                    `audit_log.reason` and `tournament_config_versions.reason`
 *                    columns for the bulk-import audit trail.
 *
 * Success response (200): `{ imported_keys: number, version_ids: string[],
 * skipped_keys: string[] }`. `version_ids` are returned as decimal strings
 * because they are postgres `bigint[]` and may exceed Number.MAX_SAFE_INTEGER.
 *
 * ERRCODE → HTTP mapping (per task T056):
 *   - WCG02 → 400 (reason missing/empty — defensive against client bypass)
 *   - WCG07 → 403 (caller is not admin; or RPC denial)
 *   - WCG08 → 422 with `{ code: 'WCG08', error: 'import_failed',
 *                          detail: <pg error message>,
 *                          validation_errors?: [{key,value,reason}...] }`
 *                    The SP raises WCG08 for: missing/invalid schema_version,
 *                    missing/invalid signature, missing signing-secret GUC,
 *                    AND aggregate per-key validation failure. For the
 *                    aggregate case the SP encodes the failure list as JSON
 *                    text inside the SQLERRM message — we parse it out so the
 *                    UI can render per-key rows; on parse failure we surface
 *                    the raw message in `detail`.
 *   - any other / INTERNAL → 500
 *
 * @see specs/008-configuration/tasks.md § T056
 * @see specs/008-configuration/contracts/config-import.write.md
 * @see supabase/migrations/0077_configuration.sql (lines 2041..2254: T053 body)
 * @see apps/web/app/admin/config/import-export/page.tsx (T054 page)
 * @see apps/web/app/api/admin/config/export/route.ts (T055 sibling route)
 * @see apps/web/lib/auth/requireAdmin.ts
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_CONTROL = 'no-store';
const MAX_REASON_LENGTH = 2000;
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024; // 8 MB defensive cap.

interface ValidationError {
  key: string;
  value: unknown;
  reason: string;
}

interface ErrorPayload {
  code: string;
  message?: string;
  reason?: string;
  error?: string;
  field?: string;
  detail?: string;
  validation_errors?: ValidationError[];
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

// Per T056: WCG02→400, WCG07→403, WCG08→422, others→500.
const CONFIG_ERRCODE_HTTP_MAP: Record<string, number> = {
  WCG02: 400,
  WCG07: 403,
  WCG08: 422,
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

// ---------------------------------------------------------------------------
// WCG08 validation-error extraction.
//
// The SP raises WCG08 with a message like:
//   `Import validation failed for 3 keys: [{"key":"...","value":...,"reason":"..."}, ...]`
// where the jsonb array is the SP's `v_validation_errors`, cast to text via
// `jsonb::text` (slot 0077 line 2181). We attempt to extract the first `[...]`
// substring and JSON.parse it; failures fall back to a single-message detail.
// ---------------------------------------------------------------------------

function extractValidationErrors(
  message: string,
): { detail: string; validation_errors?: ValidationError[] } {
  const detail = message;
  const start = message.indexOf('[');
  const end = message.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) {
    return { detail };
  }
  const candidate = message.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!Array.isArray(parsed)) return { detail };
    const errors: ValidationError[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { key?: unknown; value?: unknown; reason?: unknown };
      if (typeof row.key !== 'string' || typeof row.reason !== 'string') continue;
      errors.push({
        key: row.key,
        value: row.value ?? null,
        reason: row.reason,
      });
    }
    if (errors.length === 0) return { detail };
    return { detail, validation_errors: errors };
  } catch {
    return { detail };
  }
}

// ---------------------------------------------------------------------------
// Normalisers for the RPC's success return body.
// ---------------------------------------------------------------------------

function coerceBigintArrayToStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'bigint') return v.toString();
    return String(v);
  });
}

function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST handler.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Parse multipart body BEFORE the admin gate. `request.formData()` will
  //    throw if the Content-Type isn't multipart — surface as 400.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Expected multipart/form-data body.',
    });
  }

  // 2. Extract + validate fields.
  //    `FormData.get` returns `FormDataEntryValue` which is `Blob | string`.
  //    A real file upload arrives as a Blob (or File, which extends Blob);
  //    a plain text field arrives as a string. We coerce to Blob via the
  //    "not a string + has .arrayBuffer" runtime check rather than `instanceof
  //    File` because the `File` global isn't always present in the server
  //    runtime's TS lib (Blob is, via dom lib).
  const fileField = form.get('file');
  const reasonField = form.get('reason');

  if (
    fileField === null ||
    typeof fileField === 'string' ||
    !(fileField instanceof Blob)
  ) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Field `file` is required and must be a file upload.',
      field: 'file',
    });
  }
  const file: Blob = fileField;

  if (file.size > MAX_ENVELOPE_BYTES) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: `Envelope exceeds ${MAX_ENVELOPE_BYTES}-byte cap.`,
      field: 'file',
    });
  }

  if (typeof reasonField !== 'string') {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Field `reason` is required.',
      field: 'reason',
    });
  }
  const reason = reasonField.trim();
  if (reason.length === 0) {
    return errorResponse(400, {
      code: 'WCG02',
      message: 'Reason is required for configuration imports.',
      field: 'reason',
    });
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: `Reason exceeds ${MAX_REASON_LENGTH} characters.`,
      field: 'reason',
    });
  }

  // 3. Read + parse the envelope. Envelopes are bounded (MAX_ENVELOPE_BYTES)
  //    so synchronous read is fine.
  let envelopeText: string;
  try {
    envelopeText = await file.text();
  } catch {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Failed to read uploaded file.',
      field: 'file',
    });
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      error: 'invalid_json',
      message: 'Uploaded file is not valid JSON.',
      field: 'file',
    });
  }

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      error: 'invalid_envelope',
      message: 'Uploaded JSON must be an object.',
      field: 'file',
    });
  }

  // 4. Build a session-bound (user-JWT) Supabase client.
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  // 5. Admin gate (defence in depth; the RPC body also enforces is_admin and
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

  // 6. Invoke admin_config_import. The RPC verifies signature + schema
  //    version, aggregates per-key validation errors, and on success writes
  //    a single bulk-import audit row + one version row per imported key.
  const { data, error } = await supabase.rpc('admin_config_import', {
    p_envelope: envelope as never,
    p_reason: reason,
  });

  if (error) {
    const code = error.code;
    if (code === 'WCG08') {
      const { detail, validation_errors } = extractValidationErrors(error.message);
      return errorResponse(422, {
        code: 'WCG08',
        error: 'import_failed',
        detail,
        ...(validation_errors ? { validation_errors } : {}),
      });
    }
    const status = mapConfigErrcodeToHttp(code);
    return errorResponse(status, {
      code: code ?? 'INTERNAL',
      message: error.message,
    });
  }

  // 7. Coerce the success body. The SP returns jsonb:
  //      `{ imported_keys: int, version_ids: bigint[], skipped_keys: jsonb }`
  //    `version_ids` are normalised to decimal strings (bigint precision);
  //    `skipped_keys` is a jsonb array of key strings.
  const body = (data ?? {}) as Record<string, unknown>;
  const result = {
    imported_keys:
      typeof body.imported_keys === 'number' ? body.imported_keys : 0,
    version_ids: coerceBigintArrayToStrings(body.version_ids),
    skipped_keys: coerceStringArray(body.skipped_keys),
  };

  return NextResponse.json(result, {
    status: 200,
    headers: { 'Cache-Control': CACHE_CONTROL },
  });
}
