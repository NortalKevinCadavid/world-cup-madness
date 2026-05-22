import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

import {
  auditSearch,
  AUDIT_SOURCE_VALUES,
  AuditSearchError,
  type AuditSearchParams,
  type AuditRow,
} from '../../../../../lib/audit-search';
import { AUDIT_CSV_COLUMNS, toCsvLine } from '../../../../../lib/csv';

/**
 * `GET /api/admin/audit/export` — CSV streaming export of `audit_log` rows.
 *
 * Slice 007 / T021. Source of truth:
 *   - `specs/007-audit-trail/contracts/audit-export.stream.md` (LOCKED).
 *
 * Lifecycle (six steps; order matters):
 *   1. AUTH check       — `auth.getUser()`; 401 plain text on no session.
 *   2. ADMIN check      — `is_admin(p_user_id)` RPC. On non-admin: write best-
 *                         effort `admin.access_denied` audit row pinned to the
 *                         narrow INSERT policy at slot 0073 (admits exactly
 *                         action='admin.access_denied' AND source='api_guard'
 *                         with actor=caller's own participants.id), then 403
 *                         plain text.
 *   3. VALIDATE         — zod parses query params, then enforces the "at least
 *                         one filter" guard (mirrors WAT03's spirit — refuses
 *                         unbounded exports). 422 JSON `{ error: '<reason>' }`.
 *   4. STREAM           — `ReadableStream` pages `audit_search` with
 *                         `p_limit=500` (the LOCKED cap in 0076 / wrapper),
 *                         enqueueing rows as RFC 4180 CSV lines. Stops at
 *                         `max_rows` (truncated=true) or short page.
 *   5. POST-WRITE       — After stream close, write `admin.audit_export`
 *                         audit row with `new_value: { filters, rows_exported,
 *                         truncated }` via SERVICE-ROLE client. The session
 *                         (authenticated) client cannot write this row: slot
 *                         0073's narrow INSERT policy admits only
 *                         action='admin.access_denied'; an admin.audit_export
 *                         INSERT from authenticated would fail RLS. Service
 *                         role bypasses RLS and retains INSERT privilege per
 *                         slot 0076 (only UPDATE/DELETE were REVOKEd).
 *   6. RESPONSE HEADERS — `text/csv; charset=utf-8`,
 *                         `content-disposition: attachment; filename=…`,
 *                         `cache-control: no-store`.
 *
 * Runtime: Node.js (Edge's memory constraints make large streaming exports
 * brittle).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_CONTROL = 'no-store';

// Page size for `audit_search` RPC. The 0076 function (and the
// `AuditSearchParamsSchema` wrapper) cap `p_limit` at 500 with ERRCODE WAT02.
// The audit-export.stream.md pseudo-code references 1000 but is superseded by
// the LOCKED 0076 implementation; we use 500 here so the wrapper does not
// reject and the RPC does not raise WAT02.
const PAGE_SIZE = 500;

const QUERY_SCHEMA = z.object({
  actor: z.string().uuid().optional(),
  entity_type: z.string().min(1).optional(),
  entity_id: z.string().uuid().optional(),
  action_pattern: z.string().max(200).optional(),
  source: z.enum(AUDIT_SOURCE_VALUES).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  max_rows: z.coerce.number().int().min(1).max(1_000_000).default(100_000),
});

type ParsedQuery = z.infer<typeof QUERY_SCHEMA>;

// At least ONE of these must be present per the contract — refuses unbounded
// exports (mirrors WAT03 on `count_audit_search`).
const REQUIRED_ONE_OF = [
  'from',
  'to',
  'actor',
  'entity_id',
  'action_pattern',
] as const;

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

/**
 * Builds a service-role Supabase client used ONLY for the post-export
 * `admin.audit_export` insert. Required because slot 0073's narrow INSERT
 * policy on `audit_log` admits only `action='admin.access_denied'` rows for
 * the authenticated role — an `admin.audit_export` row would fail WITH CHECK.
 * Service role bypasses RLS (only UPDATE / DELETE were REVOKEd at 0076 T005;
 * INSERT remains permitted).
 *
 * Throws if the service-role key is not configured at runtime.
 */
function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured — required for admin.audit_export audit write.',
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function buildFilename(): string {
  // ISO 8601 with separators stripped to keep the filename portable
  // (no `:` or `.`).
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `audit-export-${iso}.csv`;
}

export async function GET(req: NextRequest): Promise<Response> {
  // ---------------------------------------------------------------------------
  // Step 1: AUTH check.
  // ---------------------------------------------------------------------------
  let sessionClient: ReturnType<typeof createSessionBoundClient>;
  try {
    sessionClient = createSessionBoundClient();
  } catch {
    return new Response('Internal error', {
      status: 500,
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
  }

  const {
    data: { user },
  } = await sessionClient.auth.getUser();
  if (!user) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
  }

  // ---------------------------------------------------------------------------
  // Step 2: ADMIN check via slot 0062's `is_admin(p_user_id)` RPC.
  // ---------------------------------------------------------------------------
  const { data: isAdmin, error: adminError } = await sessionClient.rpc(
    'is_admin',
    { p_user_id: user.id },
  );
  if (adminError) {
    return new Response('Internal error', {
      status: 500,
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
  }
  if (isAdmin !== true) {
    // Best-effort `admin.access_denied` audit write through slot 0073's
    // narrow INSERT policy. The policy requires actor = caller's own
    // participants.id (resolved from auth.uid()), action = 'admin.access_denied',
    // source = 'api_guard'. We use `entity_type='audit_export'` per the
    // contract (slot 0073 does not constrain entity_type).
    try {
      const { data: participantRow } = await sessionClient
        .from('participants')
        .select('id')
        .eq('auth_user_id', user.id)
        .maybeSingle();
      if (participantRow?.id) {
        await sessionClient.from('audit_log').insert({
          actor: participantRow.id,
          action: 'admin.access_denied',
          entity_type: 'audit_export',
          entity_id: null,
          previous_value: null,
          new_value: null,
          reason: 'non-admin attempted /api/admin/audit/export',
          source: 'api_guard',
          source_citation: null,
        });
      }
    } catch {
      /* best-effort; do not block the denial response */
    }
    return new Response('Forbidden', {
      status: 403,
      headers: { 'Cache-Control': CACHE_CONTROL },
    });
  }

  // ---------------------------------------------------------------------------
  // Step 3: VALIDATE query params (zod + "at least one filter" guard).
  //
  // 422 responses do NOT write an audit row (per contract § Audit posture —
  // validation failures are pre-auth-check noise and should not pollute the
  // audit log). The admin already passed the auth + admin gates above; only
  // the filter shape is incorrect.
  // ---------------------------------------------------------------------------
  const url = new URL(req.url);
  const rawParams: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    rawParams[key] = value;
  });

  const parsed = QUERY_SCHEMA.safeParse(rawParams);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const reason = firstIssue?.message ?? 'invalid query parameters';
    return NextResponse.json(
      { error: reason },
      { status: 422, headers: { 'Cache-Control': CACHE_CONTROL } },
    );
  }
  const query: ParsedQuery = parsed.data;

  const hasRequiredFilter = REQUIRED_ONE_OF.some(
    (k) => query[k] !== undefined && query[k] !== null && query[k] !== '',
  );
  if (!hasRequiredFilter) {
    return NextResponse.json(
      {
        error:
          'At least one filter is required: from, to, actor, entity_id, or action_pattern',
      },
      { status: 422, headers: { 'Cache-Control': CACHE_CONTROL } },
    );
  }

  const maxRows = query.max_rows;
  // Filters that survive the stream (used for both paging and the post-export
  // audit row's `new_value.filters`). Paging-specific fields (limit/offset)
  // are stamped into a fresh object per page below.
  const exportFilters: Omit<AuditSearchParams, 'limit' | 'offset'> = {
    actor: query.actor ?? null,
    entity_type: query.entity_type ?? null,
    entity_id: query.entity_id ?? null,
    action_pattern: query.action_pattern ?? null,
    source: query.source ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
  };

  // ---------------------------------------------------------------------------
  // Step 4: STREAM via `ReadableStream` — header + paged rows + post-write.
  // ---------------------------------------------------------------------------
  const encoder = new TextEncoder();
  let rowsExported = 0;
  let truncated = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Header line (RFC 4180 + LOCKED column order from `lib/csv.ts`).
        controller.enqueue(
          encoder.encode(AUDIT_CSV_COLUMNS.join(',') + '\r\n'),
        );

        let offset = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // Cap this page so we don't over-fetch past `max_rows`.
          const remaining = maxRows - rowsExported;
          if (remaining <= 0) break;
          const pageLimit = Math.min(PAGE_SIZE, remaining);

          const pageParams: AuditSearchParams = {
            ...exportFilters,
            limit: pageLimit,
            offset,
          };

          let page: AuditRow[];
          try {
            page = await auditSearch(sessionClient, pageParams);
          } catch (err) {
            // Surface as inline CSV comment so the partial export remains
            // useful to operators and close the stream cleanly.
            const message =
              err instanceof AuditSearchError
                ? `${err.code}: ${err.message}`
                : String(err);
            controller.enqueue(
              encoder.encode(`# error: ${message.replace(/\r?\n/g, ' ')}\r\n`),
            );
            break;
          }

          for (const row of page) {
            if (rowsExported >= maxRows) {
              truncated = true;
              break;
            }
            controller.enqueue(
              encoder.encode(
                toCsvLine(row as Record<string, unknown>, AUDIT_CSV_COLUMNS) +
                  '\r\n',
              ),
            );
            rowsExported++;
          }

          if (rowsExported >= maxRows) {
            // We capped exactly at `max_rows` — flag truncated only if the
            // page returned a full batch (which suggests there were more
            // rows to fetch).
            if (page.length === pageLimit) {
              truncated = true;
            }
            break;
          }

          // Short page → no more data.
          if (page.length < pageLimit) break;

          offset += page.length;
        }

        if (truncated) {
          controller.enqueue(
            encoder.encode(`# truncated at ${maxRows} rows\r\n`),
          );
        }
      } catch (err) {
        // Defence-in-depth: anything that bubbles past the inner try.
        const message = err instanceof Error ? err.message : String(err);
        try {
          controller.enqueue(
            encoder.encode(
              `# error: ${message.replace(/\r?\n/g, ' ')}\r\n`,
            ),
          );
        } catch {
          /* controller already closed */
        }
      } finally {
        controller.close();

        // -----------------------------------------------------------------
        // Step 5: POST-WRITE `admin.audit_export` audit row (best-effort).
        // Uses SERVICE-ROLE client because slot 0073's narrow INSERT policy
        // admits only `admin.access_denied`. Service role bypasses RLS and
        // retains INSERT privilege per 0076 T005.
        // -----------------------------------------------------------------
        try {
          const serviceClient = createServiceRoleClient();
          const { data: participantRow } = await serviceClient
            .from('participants')
            .select('id')
            .eq('auth_user_id', user.id)
            .maybeSingle();
          if (participantRow?.id) {
            await serviceClient.from('audit_log').insert({
              actor: participantRow.id,
              action: 'admin.audit_export',
              entity_type: 'audit_export',
              entity_id: null,
              previous_value: null,
              new_value: {
                filters: exportFilters,
                rows_exported: rowsExported,
                truncated,
              },
              reason: 'CSV export of audit_log',
              source: 'admin_rpc',
              source_citation: null,
            });
          }
        } catch {
          /* best-effort — the export bytes have already been sent. */
        }
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Step 6: RESPONSE headers.
  // ---------------------------------------------------------------------------
  const filename = buildFilename();
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': CACHE_CONTROL,
    },
  });
}
