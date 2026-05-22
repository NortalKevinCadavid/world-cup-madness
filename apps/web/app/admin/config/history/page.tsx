import 'server-only';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import HistoryView, {
  type HistoryEntry,
} from './HistoryView';

/**
 * `/admin/config/history` — Version history + rollback (Slice 008, Phase 7,
 * T048, US5).
 *
 * Server component. Mirrors the T033 (`/scoring`), T041 (`/phases`) admin-page
 * pattern:
 *   1. Build a session-bound (anon-key + caller cookies) Supabase client.
 *   2. Pull the current user; redirect unauthenticated callers to `/`.
 *   3. Re-check `is_admin(p_user_id)` via RPC (defence in depth — the
 *      `app/admin/layout.tsx` gate already runs, but pages must not assume
 *      it has). On denial, write a best-effort `admin.access_denied` audit
 *      row (slot 0073 narrow INSERT policy) tagged
 *      `entity_type='admin_config_history_page'`, then `notFound()` so the
 *      surface leaks no detail about admin membership.
 *   4. Call `config_version_history(p_key, p_limit, p_offset)` (slot 0077
 *      § T047 — SHIPPED) with `p_key = searchParams.key ?? null` so the
 *      query is filtered server-side if a `?key=<key>` query parameter is
 *      present, or returns the global timeline otherwise. We page with
 *      `p_limit=100, p_offset=0` — enough for the typical config volume
 *      (the contract caps `p_limit` at 500 and quotes ≤10k total rows in
 *      production).
 *   5. Hand off to the client-side `<HistoryView>`, which renders the
 *      timeline, owns the filter input (router.push to update the `?key`
 *      search param), and runs the rollback confirmation modal +
 *      `POST /api/admin/config/rollback` round trip (T048's sibling route
 *      handler in this same slot).
 *
 * The page-level filter is "all keys" (NULL) when no `?key=` is set, so a
 * fresh visit shows the most recent 100 rows across every key. Typing into
 * the filter input populates the URL with `?key=<value>` (the page is
 * `force-dynamic`, so the re-render re-runs the RPC with the new filter).
 *
 * Why a client companion (`HistoryView.tsx`):
 *   T048 demands an interactive filter input, a rollback confirmation modal,
 *   and a `router.refresh()` on success so the new admin_rollback entry
 *   shows up at the top without a hard navigation. The server page itself
 *   just gates + fetches the timeline rows.
 *
 * RPC error handling:
 *   `config_version_history` raises `WCG07` for non-admin callers, but we
 *   already gate via `is_admin` above — the RPC error path is defensive.
 *   `WCG02` is impossible here (p_limit=100, p_offset=0 both inside [1,500]
 *   and >=0). Any unexpected error renders a banner instead of failing the
 *   route, matching the scoring/phases sibling pattern.
 *
 * DOM contract (T051 will assert):
 *   - `[data-testid="admin-config-history-page"]` on main
 *   - `[data-testid="history-filter-input"]`, `[data-testid="history-filter-clear"]`
 *   - `[data-testid="history-timeline"]` container
 *   - Per entry: `[data-testid="history-entry"][data-version-id="N"]`
 *     with attributes `data-key`, `data-change-kind`
 *   - Per entry: `[data-testid="history-entry-rollback"]` button
 *   - Per entry: `[data-testid="history-entry-change-kind"]` badge
 *   - Rollback modal: `[data-testid="rollback-modal"]`,
 *     `[data-testid="rollback-reason"]`,
 *     `[data-testid="rollback-source-citation"]`,
 *     `[data-testid="rollback-confirm"]`, `[data-testid="rollback-cancel"]`
 *   - Toast: `[data-testid="history-toast"]`
 *   - Error banner: `[data-testid="history-error"]`
 *
 * @see specs/008-configuration/tasks.md § T048
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin_config_rollback
 * @see specs/008-configuration/contracts/config-version-history.read.md § config_version_history
 * @see supabase/migrations/0077_configuration.sql (lines 1681..1893: T046+T047 bodies)
 * @see apps/web/app/admin/config/VersionTimeline.tsx (T022 sibling component — pure-display, this view extends with rollback wiring)
 * @see apps/web/app/admin/config/scoring/page.tsx (T033 sibling page pattern)
 * @see apps/web/app/admin/config/phases/page.tsx (T041 sibling page pattern)
 * @see apps/web/app/api/admin/config/rollback/route.ts (T048 sibling route handler)
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Page-tunable knobs. The RPC's caps are `p_limit ∈ [1, 500]` (slot 0077
// lines 1867–1870); 100 is large enough that even the busiest single-key
// timeline shows several months of audit-able history without paging.
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 100;
const HISTORY_OFFSET = 0;

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Mirrors the
// helper in T033/T041 sibling pages.
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
 * policy). Tagged with `entity_type='admin_config_history_page'` per T048.
 *
 * Errors are swallowed (logged once) so a transient audit failure cannot
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
      entity_type: 'admin_config_history_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/config/history',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[admin-config-history-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[admin-config-history-page] admin.access_denied insert threw: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Row coercion. `config_version_history` returns timestamptz / bigint / uuid
// columns that postgrest can serialise as either string or number depending
// on driver version + jsonb shape. We normalise into a single safe shape so
// the client component never has to deal with the union.
// ---------------------------------------------------------------------------

interface RawHistoryRow {
  version_id: unknown;
  key: unknown;
  previous_value: unknown;
  new_value: unknown;
  change_kind: unknown;
  actor: unknown;
  reason: unknown;
  source_citation: unknown;
  audit_log_id: unknown;
  parent_version_id: unknown;
  acknowledge_token_used: unknown;
  created_at: unknown;
}

function coerceBigintString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'bigint') return raw.toString();
  return '0';
}

function coerceNullableBigintString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return coerceBigintString(raw);
}

function coerceString(raw: unknown, fallback = ''): string {
  return typeof raw === 'string' ? raw : fallback;
}

function coerceNullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === 'string' ? raw : null;
}

function normaliseRow(row: RawHistoryRow): HistoryEntry {
  return {
    version_id: coerceBigintString(row.version_id),
    key: coerceString(row.key, '(unknown)'),
    previous_value: row.previous_value ?? null,
    new_value: row.new_value ?? null,
    change_kind: coerceString(row.change_kind, 'admin_upsert'),
    actor: coerceNullableString(row.actor),
    reason: coerceString(row.reason, ''),
    source_citation: coerceNullableString(row.source_citation),
    audit_log_id: coerceNullableString(row.audit_log_id),
    parent_version_id: coerceNullableBigintString(row.parent_version_id),
    acknowledge_token_used: coerceNullableString(row.acknowledge_token_used),
    created_at: coerceString(row.created_at, ''),
  };
}

// ---------------------------------------------------------------------------
// Search-param shape.
//
// Next 14 App Router server components receive a sync-or-async record; we
// stick with the sync shape here since `dynamic = 'force-dynamic'` already
// opts us out of caching.
// ---------------------------------------------------------------------------

interface ConfigHistoryPageProps {
  searchParams?: { key?: string | string[] };
}

function firstString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === 'string') return value;
  return null;
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function ConfigHistoryPage({
  searchParams,
}: ConfigHistoryPageProps) {
  const supabase = createSessionBoundClient();

  // Step 1: auth check.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/');
  }

  // Step 2: admin check (defence in depth).
  const { data: isAdminResult, error: rpcError } = await supabase.rpc('is_admin', {
    p_user_id: user.id,
  });
  if (rpcError || isAdminResult !== true) {
    await writeAccessDeniedAudit(supabase, user.id);
    notFound();
  }

  // Step 3: resolve optional `?key=` filter.
  const rawKey = firstString(searchParams?.key)?.trim();
  const filterKey = rawKey && rawKey.length > 0 ? rawKey : null;

  // Step 4: invoke the history RPC. The RPC enforces is_admin itself (WCG07)
  // but we've already gated above; treat any RPC error as a soft render
  // failure rather than crashing the route.
  const { data: rawRows, error: historyError } = await supabase.rpc(
    'config_version_history',
    {
      p_key: filterKey,
      p_limit: HISTORY_LIMIT,
      p_offset: HISTORY_OFFSET,
    },
  );

  if (historyError) {
    return (
      <main
        data-testid="admin-config-history-page"
        className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-4"
      >
        <h1 className="text-2xl font-semibold text-neutral-900">
          Configuration history
        </h1>
        <div
          data-testid="history-error"
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load configuration version history: {historyError.message}
        </div>
      </main>
    );
  }

  const entries: HistoryEntry[] = Array.isArray(rawRows)
    ? (rawRows as RawHistoryRow[]).map(normaliseRow)
    : [];

  return (
    <main
      data-testid="admin-config-history-page"
      className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Configuration history
        </h1>
        <p className="text-xs font-mono text-neutral-500">
          /admin/config/history
        </p>
        <p className="text-sm text-neutral-600">
          Every write to <code>tournament_config</code> appears here. Roll back
          to any prior version — the rollback is appended as a new entry; the
          target row remains in history.
        </p>
      </header>

      <HistoryView
        initialEntries={entries}
        initialFilterKey={filterKey}
        limit={HISTORY_LIMIT}
      />
    </main>
  );
}
