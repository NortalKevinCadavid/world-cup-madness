import 'server-only';

import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

/**
 * `/admin/config` — tabbed landing page for the tournament configuration
 * surface (Slice 008, Phase 2d, T023).
 *
 * Server component. The admin gate runs in `app/admin/layout.tsx`
 * (Slice 006 T015), but this page re-checks `is_admin(auth.uid())` for
 * defense-in-depth per the slice 006 contract ("Each page additionally
 * re-checks `requireAdmin`"). On denial it writes a narrow
 * `admin.access_denied` audit row (`entity_type='admin_config_page'`,
 * slot 0073 narrow INSERT policy) and returns `notFound()` so the surface
 * leaks no detail about admin membership.
 *
 * Layout:
 *   - Vertical sidebar with 9 links to per-key sub-pages.
 *   - Main content area renders a dashboard summary:
 *       1. Count of `tournament_config_versions` created in the last 7 days
 *          (RLS policy `tournament_config_versions_admin_read` permits this
 *          for the session-bound admin client).
 *       2. Count of pending acknowledge tokens in `_admin_acknowledge_tokens`
 *          where `expires_at > now()` (table created in T012 migration
 *          0077). Authenticated/service_role have been REVOKEd direct
 *          access; we attempt the SELECT and surface a "—" placeholder if
 *          it fails (privilege gate is intentional — the count is a
 *          best-effort hint, not load-bearing).
 *       3. Link to the latest export — placeholder until the Slice 007
 *          audit export surface is finalised.
 *
 * DOM contract:
 *   - `[data-testid="admin-config-page"]`
 *   - `[data-testid="config-nav-sidebar"]`
 *   - `[data-testid="config-nav-link"]` (one per link, with `data-target`)
 *
 * @see specs/008-configuration/tasks.md § T023
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see supabase/migrations/0077_configuration.sql
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Sidebar link catalog. The first 4 (domains, locking, scoring, providers) are
// children of `/admin/config`; the remaining 5 surface other configuration
// sub-surfaces planned by Slice 008 (admin-roles, phases, retention, history,
// import-export). Keep `target` paths stable — playwright specs rely on
// `data-target` selectors.
// ---------------------------------------------------------------------------

type ConfigNavLink = { label: string; target: string };

const CONFIG_NAV_LINKS: ReadonlyArray<ConfigNavLink> = [
  { label: 'Eligibility — Domains', target: '/admin/config/domains' },
  { label: 'Locking window', target: '/admin/config/locking' },
  { label: 'Scoring', target: '/admin/config/scoring' },
  { label: 'Providers', target: '/admin/config/providers' },
  { label: 'Admin roles', target: '/admin/config/admin-roles' },
  { label: 'Phases', target: '/admin/config/phases' },
  { label: 'Retention', target: '/admin/config/retention' },
  { label: 'Version history', target: '/admin/config/history' },
  { label: 'Import / Export', target: '/admin/config/import-export' },
];

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Mirrors the
// helper in slice 007's `/admin/audit/search/page.tsx`.
// ---------------------------------------------------------------------------

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

/**
 * Best-effort `admin.access_denied` audit insert (slot 0073 narrow INSERT
 * policy). Tagged with `entity_type='admin_config_page'` per T023 step 2.
 *
 * Errors are swallowed (logged once) so a transient audit failure cannot
 * block the `notFound()` denial response. Mirrors the pattern in
 * `app/admin/audit/search/page.tsx`.
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
      entity_type: 'admin_config_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/config',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[admin-config-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[admin-config-page] admin.access_denied insert threw: ${message}`);
  }
}

/**
 * Dashboard summary counters. Each query is wrapped in a defensive try/catch
 * — the landing page must still render even if one of the counters cannot be
 * computed (e.g. `_admin_acknowledge_tokens` privilege gate).
 */
type DashboardSummary = {
  recentVersionsCount: number | null;
  pendingAckTokensCount: number | null;
  latestExportHref: string | null;
};

async function loadDashboardSummary(
  supabase: ReturnType<typeof createSessionBoundClient>,
): Promise<DashboardSummary> {
  // 1) Recent versions (last 7 days). Per RLS policy
  // `tournament_config_versions_admin_read`, admins can SELECT these rows.
  // We use the JS query builder's `gte` filter with a server-computed
  // boundary rather than hand-rolling SQL — keeps the path RLS-safe and
  // avoids introducing a new RPC just for a count.
  let recentVersionsCount: number | null = null;
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from('tournament_config_versions')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo);
    if (error) {
      console.warn(
        `[admin-config-page] recent-versions count failed: ${error.message}`,
      );
    } else {
      recentVersionsCount = count ?? 0;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[admin-config-page] recent-versions count threw: ${message}`);
  }

  // 2) Pending acknowledge tokens. The `_admin_acknowledge_tokens` table is
  // REVOKEd from authenticated/anon/service_role (migration 0077), so this
  // SELECT will fail under the session-bound anon-key client. We surface
  // null in that case rather than failing the page render — a future task
  // can wrap this in an admin-only SECURITY DEFINER RPC.
  let pendingAckTokensCount: number | null = null;
  try {
    const nowIso = new Date().toISOString();
    const { count, error } = await supabase
      .from('_admin_acknowledge_tokens')
      .select('*', { count: 'exact', head: true })
      .gt('expires_at', nowIso);
    if (error) {
      console.warn(
        `[admin-config-page] pending-ack-tokens count failed: ${error.message}`,
      );
    } else {
      pendingAckTokensCount = count ?? 0;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[admin-config-page] pending-ack-tokens count threw: ${message}`);
  }

  // 3) Latest export link — placeholder. The slice 007 audit export surface
  // is `/api/admin/audit/export` (used by `app/admin/audit/search/page.tsx`)
  // but a per-key "latest export" concept is not yet finalised for
  // configuration. Surface the slice 007 entry point as a holding link.
  const latestExportHref = '/admin/audit/search';

  return { recentVersionsCount, pendingAckTokensCount, latestExportHref };
}

function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

export default async function AdminConfigLandingPage() {
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

  // Step 3: load dashboard summary counters.
  const summary = await loadDashboardSummary(supabase);

  return (
    <main
      data-testid="admin-config-page"
      className="max-w-6xl mx-auto px-6 py-8 flex flex-row gap-8"
    >
      <nav
        data-testid="config-nav-sidebar"
        aria-label="Configuration navigation"
        className="w-60 shrink-0 flex flex-col gap-1 border-r border-neutral-200 pr-4"
      >
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
          Configuration
        </h2>
        <ul className="flex flex-col gap-1">
          {CONFIG_NAV_LINKS.map((link) => (
            <li key={link.target}>
              <Link
                href={link.target}
                data-testid="config-nav-link"
                data-target={link.target}
                className="block rounded px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section className="flex-1 flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-neutral-900">
            Tournament configuration
          </h1>
          <p className="text-xs font-mono text-neutral-500">/admin/config</p>
          <p className="text-sm text-neutral-600">
            Pick a configuration namespace from the sidebar, or review the
            summary below.
          </p>
        </header>

        <div
          data-testid="admin-config-dashboard"
          className="grid grid-cols-1 sm:grid-cols-3 gap-4"
        >
          <div
            data-testid="admin-config-summary-recent-versions"
            className="rounded border border-neutral-200 bg-white p-4 flex flex-col gap-1"
          >
            <p className="text-xs uppercase tracking-wide text-neutral-500">
              Recent versions (last 7 days)
            </p>
            <p className="text-3xl font-semibold text-neutral-900">
              {formatCount(summary.recentVersionsCount)}
            </p>
            <p className="text-xs text-neutral-500">
              <code>tournament_config_versions</code>
            </p>
          </div>

          <div
            data-testid="admin-config-summary-pending-ack-tokens"
            className="rounded border border-neutral-200 bg-white p-4 flex flex-col gap-1"
          >
            <p className="text-xs uppercase tracking-wide text-neutral-500">
              Pending acknowledge tokens
            </p>
            <p className="text-3xl font-semibold text-neutral-900">
              {formatCount(summary.pendingAckTokensCount)}
            </p>
            <p className="text-xs text-neutral-500">
              5-minute TTL; consumed on confirm.
            </p>
          </div>

          <div
            data-testid="admin-config-summary-latest-export"
            className="rounded border border-neutral-200 bg-white p-4 flex flex-col gap-1"
          >
            <p className="text-xs uppercase tracking-wide text-neutral-500">
              Latest export
            </p>
            {summary.latestExportHref ? (
              <Link
                href={summary.latestExportHref}
                data-testid="admin-config-latest-export-link"
                className="text-sm text-blue-600 underline"
              >
                Open audit export surface
              </Link>
            ) : (
              <p className="text-sm text-neutral-500">—</p>
            )}
            <p className="text-xs text-neutral-500">
              Placeholder until Slice 008 export is finalised.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
