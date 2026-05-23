import 'server-only';

import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  AuditFiltersForm,
  type AuditSearchFilters,
} from './AuditFiltersForm';
import { AuditResultsTable } from './AuditResultsTable';
import {
  auditSearch,
  AuditSearchError,
  type AuditRow,
  type AuditSearchParams,
  AUDIT_SOURCE_VALUES,
  type AuditSource,
} from '../../../../lib/audit-search';

/**
 * `/admin/audit/search` — typed RPC-backed audit search surface (Slice 007,
 * Phase 5, T020).
 *
 * Server component. The admin gate runs in `app/admin/layout.tsx`, but this
 * page re-checks `is_admin(auth.uid())` for defense-in-depth per the slice
 * 006 contract ("Each page additionally re-checks `requireAdmin`"). On a
 * denial it writes a narrow `admin.access_denied` audit row
 * (`entity_type='audit_search_page'`, slot 0073 narrow INSERT policy) and
 * returns `notFound()` so the surface leaks no detail about admin
 * membership.
 *
 * Query params (server-side, mirrors `AuditSearchFilters`):
 *   - `actor`           — uuid
 *   - `entity_type`     — text
 *   - `entity_id`       — uuid
 *   - `action_pattern`  — SQL LIKE (e.g. `admin.%`)
 *   - `source`          — one of `AUDIT_SOURCE_VALUES`
 *   - `from`, `to`      — ISO timestamps (datetime-local also accepted)
 *
 * If at least one filter is set, the page invokes `auditSearch` from T016;
 * otherwise it renders an empty results table (so the surface is reachable
 * without paying for an unconstrained query).
 *
 * DOM contract:
 *   - `[data-testid="audit-search-page"]`
 *   - `[data-testid="audit-filters-form"]`
 *   - `[data-testid="audit-results-table"]` (when rows > 0)
 *   - `[data-testid="audit-results-empty"]` (when rows === 0)
 *   - `[data-testid="audit-export-link"]`
 *
 * @see specs/007-audit-trail/tasks.md § T020
 * @see apps/web/lib/audit-search.ts
 * @see apps/web/app/admin/audit/search/AuditFiltersForm.tsx
 * @see apps/web/app/admin/audit/search/AuditResultsTable.tsx
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RawSearchParams {
  actor?: string | string[];
  entity_type?: string | string[];
  entity_id?: string | string[];
  action_pattern?: string | string[];
  source?: string | string[];
  from?: string | string[];
  to?: string | string[];
}

interface NormalizedSearchParams {
  actor?: string;
  entity_type?: string;
  entity_id?: string;
  action_pattern?: string;
  source?: string;
  from?: string;
  to?: string;
}

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Misconfiguration: build a placeholder so the page can still render the
    // denial path consistently. Will fail the auth check below.
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
        /* read-only — cookie refresh is owned by middleware. */
      },
    },
  });
}

function pickString(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string' && v[0].length > 0) {
    return v[0];
  }
  return undefined;
}

function normalizeSearchParams(raw: RawSearchParams): NormalizedSearchParams {
  return {
    actor: pickString(raw.actor),
    entity_type: pickString(raw.entity_type),
    entity_id: pickString(raw.entity_id),
    action_pattern: pickString(raw.action_pattern),
    source: pickString(raw.source),
    from: pickString(raw.from),
    to: pickString(raw.to),
  };
}

function isAnyFilterSet(p: NormalizedSearchParams): boolean {
  return Boolean(
    p.actor ||
      p.entity_type ||
      p.entity_id ||
      p.action_pattern ||
      p.source ||
      p.from ||
      p.to,
  );
}

/**
 * Convert a possibly-empty `datetime-local` / ISO-8601 string into a strict
 * RFC 3339 timestamp the audit RPC accepts, or `null` for "no bound".
 *
 * Returns `undefined` (not `null`) if the input is unparseable, so the
 * caller can short-circuit with a 422-shaped error rather than passing
 * garbage to the RPC and waiting for a `WAT02`.
 */
function toIso(input: string | undefined): string | null | undefined {
  if (!input) return null;
  const t = Date.parse(input);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

function isAuditSource(v: string | undefined): v is AuditSource {
  return typeof v === 'string' && (AUDIT_SOURCE_VALUES as readonly string[]).includes(v);
}

function toRpcParams(
  p: NormalizedSearchParams,
): { ok: true; params: AuditSearchParams } | { ok: false; error: string } {
  const from = toIso(p.from);
  if (from === undefined) {
    return { ok: false, error: `"From" is not a valid timestamp: ${p.from}` };
  }
  const to = toIso(p.to);
  if (to === undefined) {
    return { ok: false, error: `"To" is not a valid timestamp: ${p.to}` };
  }
  if (p.source && !isAuditSource(p.source)) {
    return { ok: false, error: `Unknown source: ${p.source}` };
  }
  return {
    ok: true,
    params: {
      actor: p.actor ?? null,
      entity_type: p.entity_type ?? null,
      entity_id: p.entity_id ?? null,
      action_pattern: p.action_pattern ?? null,
      source: p.source ? (p.source as AuditSource) : null,
      from,
      to,
      limit: 100,
      offset: 0,
    },
  };
}

function buildExportHref(p: NormalizedSearchParams): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === 'string' && value.length > 0) qs.set(key, value);
  }
  return `/api/admin/audit/export?${qs.toString()}`;
}

function toFormInitial(p: NormalizedSearchParams): Partial<AuditSearchFilters> {
  return {
    actor: p.actor ?? '',
    entity_type: p.entity_type ?? '',
    entity_id: p.entity_id ?? '',
    action_pattern: p.action_pattern ?? '',
    source: p.source ?? '',
    from: p.from ?? '',
    to: p.to ?? '',
  };
}

/**
 * Best-effort `admin.access_denied` audit insert (slot 0073 narrow INSERT
 * policy). Tagged with `entity_type='audit_search_page'` per T020 step 2.
 *
 * Mirrors `apps/web/lib/auth/requireAdmin.ts#writeAdminAccessDeniedAudit`:
 * errors are swallowed (logged once) so a transient audit failure cannot
 * block the `notFound()` denial response.
 */
async function writeAccessDeniedAudit(
  supabase: ReturnType<typeof createSessionBoundClient>,
  authUserId: string,
): Promise<void> {
  try {
    const { data: pid } = await supabase
      .from('participants')
      .select('id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (!pid?.id) return;
    const { error } = await supabase.from('audit_log').insert({
      actor: pid.id,
      action: 'admin.access_denied',
      entity_type: 'audit_search_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/audit/search',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[audit-search-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[audit-search-page] admin.access_denied insert threw: ${message}`);
  }
}

export default async function AuditSearchPage({
  searchParams,
}: {
  searchParams?: RawSearchParams;
}) {
  const supabase = createSessionBoundClient();

  // Step 1: auth check — unauthenticated callers go home.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/');
  }

  // Step 2: admin check (defense in depth — the layout already gates, but
  // pages must not assume the layout ran). Slice 006 contract.
  const { data: isAdminResult, error: rpcError } = await supabase.rpc('is_admin', {
    p_user_id: user.id,
  });
  if (rpcError || isAdminResult !== true) {
    await writeAccessDeniedAudit(supabase, user.id);
    notFound();
  }

  // Step 3: read filter params from `searchParams`.
  const params = normalizeSearchParams(searchParams ?? {});
  const hasFilters = isAnyFilterSet(params);

  // Step 4: call auditSearch if at least one filter is set.
  let rows: AuditRow[] = [];
  let queryError: string | null = null;
  if (hasFilters) {
    const built = toRpcParams(params);
    if (!built.ok) {
      queryError = built.error;
    } else {
      try {
        rows = await auditSearch(supabase, built.params);
      } catch (e) {
        if (e instanceof AuditSearchError) {
          queryError = `[${e.code}] ${e.message}`;
        } else {
          queryError = e instanceof Error ? e.message : String(e);
        }
      }
    }
  }

  const exportHref = buildExportHref(params);

  return (
    <main
      data-testid="audit-search-page"
      className="max-w-6xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Audit search</h1>
        <p className="text-xs font-mono text-muted-foreground">/admin/audit/search</p>
      </header>

      <AuditFiltersForm initial={toFormInitial(params)} />

      {queryError ? (
        <div
          data-testid="audit-search-error"
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          Search failed: {queryError}
        </div>
      ) : null}

      {hasFilters && !queryError ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground" data-testid="audit-results-count">
            {rows.length} result(s)
          </p>
          <Link
            href={exportHref}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="audit-export-link"
            className="text-sm text-primary underline"
          >
            Export CSV
          </Link>
        </div>
      ) : null}

      {hasFilters && !queryError ? (
        <AuditResultsTable rows={rows} />
      ) : !hasFilters ? (
        <p className="text-sm text-muted-foreground">
          Set at least one filter and submit to search the audit log.
        </p>
      ) : null}
    </main>
  );
}
