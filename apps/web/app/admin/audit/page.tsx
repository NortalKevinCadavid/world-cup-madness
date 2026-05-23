import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

/**
 * `/admin/audit` — paginated search of the admin audit log (Slice 006,
 * Phase 7, T039).
 *
 * Server component. The admin gate runs in `app/admin/layout.tsx`.
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md § `/admin/audit`
 *   - specs/006-admin-overrides/contracts/admin-audit.read.md
 *     § `GET /api/admin/audit` (mirrored here for SSR).
 *
 * Query params honoured (server-side, equivalent to the API):
 *   - `action`, `actor`, `entity_type`, `entity_id`, `from`, `to`, `q`,
 *     `page` (default 1), `page_size` (default 50, max 200).
 *
 * The filter form is a plain `<form method="get">` (no client JS required)
 * which submits back to the same path; this keeps the page robust to
 * bookmarking and shareable URLs.
 *
 * DOM contract:
 *   - `[data-testid="admin-audit-page"]`
 *   - `[data-testid="admin-audit-filter-form"]`
 *   - `[data-testid="admin-audit-row"]` (per row)
 *   - `[data-testid="admin-audit-pagination"]`
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return createServerClient('http://localhost', 'placeholder', {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {
          /* noop */
        },
      },
    });
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

interface AuditRow {
  id: string;
  actor: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  reason: string | null;
  source: string;
  source_citation: string | null;
  occurred_at: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asPositiveInt(v: unknown, fallback: number, max?: number): number {
  if (typeof v !== 'string') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  if (typeof max === 'number' && n > max) return max;
  return n;
}

export default async function AdminAuditSearchPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const sp = searchParams ?? {};
  const action = asString(sp.action);
  const actor = asString(sp.actor);
  const entityType = asString(sp.entity_type);
  const entityId = asString(sp.entity_id);
  const from = asString(sp.from);
  const to = asString(sp.to);
  const q = asString(sp.q);
  const page = asPositiveInt(sp.page, 1);
  const pageSize = asPositiveInt(sp.page_size, 50, 200);

  const supabase = createSessionBoundClient();

  let query = supabase
    .from('audit_log')
    .select(
      'id,actor,action,entity_type,entity_id,reason,source,source_citation,occurred_at',
      { count: 'exact' },
    );

  if (action) {
    if (action.includes('%')) {
      query = query.like('action', action);
    } else {
      query = query.eq('action', action);
    }
  } else {
    query = query.like('action', 'admin.%');
  }
  if (actor) query = query.eq('actor', actor);
  if (entityType) query = query.eq('entity_type', entityType);
  if (entityId) query = query.eq('entity_id', entityId);
  if (from) query = query.gte('occurred_at', from);
  if (to) query = query.lte('occurred_at', to);
  if (q) {
    const term = q.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.or(
      `reason.ilike.%${term}%,source_citation.ilike.%${term}%`,
    );
  }

  const offset = (page - 1) * pageSize;
  query = query
    .order('occurred_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  const { data, count } = await query;
  const rows = (data as AuditRow[] | null) ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Build the next/prev href preserving query state.
  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (actor) params.set('actor', actor);
    if (entityType) params.set('entity_type', entityType);
    if (entityId) params.set('entity_id', entityId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (q) params.set('q', q);
    params.set('page', String(targetPage));
    params.set('page_size', String(pageSize));
    return `/admin/audit?${params.toString()}`;
  }

  return (
    <main
      data-testid="admin-audit-page"
      className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Audit log</h1>
        <p className="text-xs font-mono text-muted-foreground">/admin/audit</p>
      </header>

      <form
        data-testid="admin-audit-filter-form"
        method="get"
        className="rounded-lg border border-border bg-card p-6 grid grid-cols-1 sm:grid-cols-2 gap-3"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Action</span>
          <input
            name="action"
            type="text"
            defaultValue={action ?? ''}
            placeholder="admin.match_result_corrected"
            className="rounded border border-border px-2 py-1.5 text-sm font-mono focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Actor (uuid)</span>
          <input
            name="actor"
            type="text"
            defaultValue={actor ?? ''}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="rounded border border-border px-2 py-1.5 text-sm font-mono focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Entity type</span>
          <input
            name="entity_type"
            type="text"
            defaultValue={entityType ?? ''}
            placeholder="match | prediction | ..."
            className="rounded border border-border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Entity id</span>
          <input
            name="entity_id"
            type="text"
            defaultValue={entityId ?? ''}
            placeholder="uuid"
            className="rounded border border-border px-2 py-1.5 text-sm font-mono focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">From (ISO-8601)</span>
          <input
            name="from"
            type="text"
            defaultValue={from ?? ''}
            placeholder="2026-06-01T00:00:00Z"
            className="rounded border border-border px-2 py-1.5 text-sm font-mono focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">To (ISO-8601)</span>
          <input
            name="to"
            type="text"
            defaultValue={to ?? ''}
            placeholder="2026-06-30T23:59:59Z"
            className="rounded border border-border px-2 py-1.5 text-sm font-mono focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="font-medium text-foreground">
            Free-text (reason + source_citation)
          </span>
          <input
            name="q"
            type="text"
            defaultValue={q ?? ''}
            placeholder="search reason or source citation"
            className="rounded border border-border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Page size</span>
          <input
            name="page_size"
            type="number"
            min={1}
            max={200}
            defaultValue={pageSize}
            className="rounded border border-border px-2 py-1.5 text-sm tabular-nums focus:border-blue-500 focus:outline-none"
          />
        </label>
        <div className="sm:col-span-2 flex items-end justify-end">
          <button
            type="submit"
            data-testid="admin-audit-filter-submit"
            className="rounded border border-blue-700 bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary"
          >
            Search
          </button>
        </div>
      </form>

      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">Results</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {total} matching row(s) — showing page {page} of {totalPages}.
        </p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No matching rows.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                data-testid="admin-audit-row"
                className="text-sm text-foreground"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {row.occurred_at}
                </span>
                <span className="ml-2 font-mono text-xs">{row.action}</span>
                {row.reason ? (
                  <span className="ml-2 text-muted-foreground">— {row.reason}</span>
                ) : null}
                <a
                  href={`/admin/audit/${row.id}`}
                  className="ml-2 text-xs text-primary underline"
                  data-testid="admin-audit-row-detail-link"
                >
                  view detail
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav
        data-testid="admin-audit-pagination"
        className="flex items-center justify-between text-sm"
      >
        {page > 1 ? (
          <a
            href={buildHref(page - 1)}
            data-testid="admin-audit-prev-page"
            className="rounded border border-border bg-card px-3 py-1.5 text-foreground hover:bg-muted/30"
          >
            Previous
          </a>
        ) : (
          <span />
        )}
        <span className="text-xs text-muted-foreground">
          Page {page} / {totalPages} ({total} total)
        </span>
        {page < totalPages ? (
          <a
            href={buildHref(page + 1)}
            data-testid="admin-audit-next-page"
            className="rounded border border-border bg-card px-3 py-1.5 text-foreground hover:bg-muted/30"
          >
            Next
          </a>
        ) : (
          <span />
        )}
      </nav>
    </main>
  );
}
