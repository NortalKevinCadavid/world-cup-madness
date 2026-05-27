import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
  requireEligible,
} from '../../../../lib/auth/requireEligible';
import { readOwnBracket } from '../../../../lib/bracket/server-read';

/**
 * `POST /api/bracket/submit` — submit the completed bracket (US3, T028).
 * Source of truth: specs/010-bracket-team-selection/contracts/bracket.submit.write.md
 *
 * Thin wrapper over the `submit_bracket(run_token)` SECURITY DEFINER RPC, which
 * is server-authoritative on completeness, lock state, idempotency, and audit
 * (migration 0090). The route maps the RPC's typed ERRCODEs to HTTP:
 *   WCB03 → 409 BRACKET_LOCKED   WCB04 → 422 BRACKET_INCOMPLETE (missing_count)
 *   WCB05 → 403   WCB02 → 400
 * Then re-reads the single-source status shape for the response.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_CONTROL = 'no-store';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ErrorPayload { code: string; message: string; reason?: string; missing_count?: number }

function errorResponse(status: number, payload: ErrorPayload): NextResponse {
  return NextResponse.json(
    { error: payload },
    { status, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase env not configured');
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_c: { name: string; value: string; options: CookieOptions }[]) {},
    },
  });
}

interface SpErrorLike { code?: string | null; message?: string | null; details?: string | null }

function mapSpError(err: SpErrorLike): NextResponse {
  const code = (err.code ?? '').toUpperCase();
  const message = err.message ?? 'submit_bracket failed';
  switch (code) {
    case 'WCB03':
      return errorResponse(409, { code: 'BRACKET_LOCKED', message: 'Submissions are closed.', reason: 'lock_window_passed' });
    case 'WCB04': {
      const missing = Number.parseInt(err.details ?? '', 10);
      return errorResponse(422, {
        code: 'BRACKET_INCOMPLETE',
        message: 'Complete all picks before submitting.',
        missing_count: Number.isFinite(missing) ? missing : undefined,
      });
    }
    case 'WCB05':
      return errorResponse(403, { code: 'DOMAIN_NOT_APPROVED', message: 'This application is restricted to approved Nortal corporate identities.' });
    case 'WCB02':
      return errorResponse(400, { code: 'BAD_REQUEST', message });
    default:
      return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Auth + eligibility.
  let participantId: string;
  try {
    const participant = await requireEligible();
    participantId = participant.id;
  } catch (err) {
    if (err instanceof EligibilityError) {
      if (err.reason === 'no_session') {
        return errorResponse(401, { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' });
      }
      if (err.reason === 'not_eligible' || err.reason === 'participant_not_provisioned') {
        return errorResponse(403, { code: 'DOMAIN_NOT_APPROVED', message: 'This application is restricted to approved Nortal corporate identities.' });
      }
    }
    return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });
  }

  // 2. Body — run_token (idempotency).
  let runToken: string;
  try {
    const body = (await request.json()) as { run_token?: unknown };
    if (typeof body.run_token !== 'string' || !UUID_RE.test(body.run_token)) {
      return errorResponse(400, { code: 'BAD_REQUEST', message: 'run_token must be a UUID.' });
    }
    runToken = body.run_token;
  } catch {
    return errorResponse(400, { code: 'BAD_REQUEST', message: 'Invalid JSON body.' });
  }

  const supabase = createSessionBoundClient();

  // 3. Submit (server-authoritative).
  const { data, error: rpcErr } = await supabase.rpc('submit_bracket', { p_run_token: runToken });
  if (rpcErr) return mapSpError(rpcErr);
  const result = (Array.isArray(data) ? data[0] : data) as
    { submission_status: string; submitted_at: string | null; version: number } | null;
  if (!result) return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });

  // 4. Re-read the single-source status shape.
  let status;
  try {
    status = (await readOwnBracket(supabase, participantId)).status;
  } catch {
    return errorResponse(500, { code: 'INTERNAL', message: 'Internal server error.' });
  }

  return NextResponse.json(
    {
      submission_status: result.submission_status,
      submitted_at: result.submitted_at,
      version: result.version,
      status,
    },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
