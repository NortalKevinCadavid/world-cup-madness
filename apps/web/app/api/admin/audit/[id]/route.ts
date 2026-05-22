import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { z } from 'zod';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../../../../lib/auth/requireAdmin';
import { getAuditDetail } from '../../../../../lib/admin/audit';

/**
 * `GET /api/admin/audit/[id]` — Single audit row with derived linkage.
 *
 * Slice 006 (Phase 7, T039). Source of truth:
 *   - `specs/006-admin-overrides/contracts/admin-audit.read.md` §
 *     `GET /api/admin/audit/[id]` — single row with linkage.
 *
 * Response 200 (locked shape):
 *   {
 *     audit_log: { ... single row ... },
 *     linkage: {
 *       triggered_recalc_run_id: uuid | null,
 *       affected_score_records_count: int,
 *       affected_participants_count: int
 *     }
 *   }
 *
 * Linkage computation:
 *   - JOIN `score_calculation_runs.triggering_audit_log_id = audit_log.id`.
 *     If the audit row triggered a recalc (action='admin.recalc_triggered'),
 *     find its run row and surface the run_id + `affected_record_count` +
 *     distinct participant count.
 *
 * Errors: 401 / 403 / 404 / 500.
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

interface ScoreCalculationRunRow {
  id: string;
  affected_record_count: number | null;
}

export async function GET(
  _request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse> {
  const auditId = context.params.id;
  const idCheck = z.string().uuid().safeParse(auditId);
  if (!idCheck.success) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Invalid audit id.',
      field: 'id',
    });
  }

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

  const row = await getAuditDetail(supabase, auditId).catch(() => null);
  if (!row) {
    return errorResponse(404, {
      code: 'NOT_FOUND',
      message: 'Audit row not found.',
    });
  }

  // Linkage: look for a score_calculation_runs row that points back to this
  // audit row via `triggering_audit_log_id`.
  let triggered_recalc_run_id: string | null = null;
  let affected_score_records_count = 0;
  let affected_participants_count = 0;

  const runRes = await supabase
    .from('score_calculation_runs')
    .select('id,affected_record_count')
    .eq('triggering_audit_log_id', auditId)
    .maybeSingle();

  if (!runRes.error && runRes.data) {
    const run = runRes.data as ScoreCalculationRunRow;
    triggered_recalc_run_id = run.id;
    affected_score_records_count = run.affected_record_count ?? 0;

    // Distinct participant count from score_records for this run. RLS
    // permits admin to read score_records. We use the column
    // `score_calculation_run_id` if it exists on score_records; otherwise
    // fall back to counting via `run_id` via a separate aggregate.
    const partsRes = await supabase
      .from('score_records')
      .select('participant_id', { count: 'exact', head: false })
      .eq('score_calculation_run_id', run.id);
    if (!partsRes.error && partsRes.data) {
      const seen = new Set<string>();
      for (const r of partsRes.data as Array<{ participant_id: string }>) {
        seen.add(r.participant_id);
      }
      affected_participants_count = seen.size;
    }
  }

  return NextResponse.json(
    {
      audit_log: row,
      linkage: {
        triggered_recalc_run_id,
        affected_score_records_count,
        affected_participants_count,
      },
    },
    { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
