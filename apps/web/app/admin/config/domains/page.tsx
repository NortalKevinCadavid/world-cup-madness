import 'server-only';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { DomainsEditor } from './DomainsEditor';

/**
 * `/admin/config/domains` — Approved corporate domains editor (Slice 008,
 * Phase 3, T027, US1).
 *
 * Server component. Mirrors the slice 006 / 007 admin-page pattern:
 *   1. Build a session-bound (anon-key + caller cookies) Supabase client.
 *   2. Pull the current user; redirect unauthenticated callers to `/`.
 *   3. Re-check `is_admin(p_user_id)` via RPC (defence in depth — the
 *      `app/admin/layout.tsx` gate already runs, but pages must not assume
 *      it has). On denial, write a best-effort `admin.access_denied` audit
 *      row (slot 0073 narrow INSERT policy: action='admin.access_denied',
 *      source='api_guard', actor=caller's participants.id) tagged
 *      `entity_type='admin_config_domains_page'`, then `notFound()` so the
 *      surface leaks no detail about admin membership.
 *   4. Load the current `eligibility.allowed_domains` row from
 *      `tournament_config` (value + version_id). RLS policy
 *      `tournament_config_read_all` (slot 0077) allows authenticated reads.
 *   5. Render the client-side `<DomainsEditor>` with the initial state. All
 *      interactivity (add/remove/preview/confirm) lives in the client
 *      component, which POSTs to `/api/admin/config/preview` and
 *      `/api/admin/config/upsert` (also created in T027).
 *
 * DOM contract (T028 will assert):
 *   - `[data-testid="admin-config-domains-page"]`
 *   - `[data-testid="domains-editor"]`
 *   - `[data-testid="domains-list"]`
 *   - `[data-testid="domain-row"]`
 *   - `[data-testid="domain-remove-button"]` (one per domain, with `data-domain`)
 *   - `[data-testid="domain-add-input"]`
 *   - `[data-testid="domain-add-button"]`
 *   - `[data-testid="domain-reason"]`
 *   - `[data-testid="domain-source-citation"]`
 *   - `[data-testid="config-preview-warning"]` (from <PreviewWarning>)
 *   - `[data-testid="config-toast"]`
 *   - `[data-testid="config-error"]`
 *
 * @see specs/008-configuration/tasks.md § T027
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/lib/config-client.ts
 * @see apps/web/lib/config-validators.ts
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Mirrors the
// helper in `apps/web/app/admin/config/page.tsx` and slice 007's
// `apps/web/app/admin/audit/search/page.tsx`.
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
 * policy). Tagged with `entity_type='admin_config_domains_page'` per T027.
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
      entity_type: 'admin_config_domains_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/config/domains',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[admin-config-domains-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[admin-config-domains-page] admin.access_denied insert threw: ${message}`,
    );
  }
}

export default async function ConfigDomainsPage() {
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

  // Step 3: load current value + version_id.
  const { data: row, error: readError } = await supabase
    .from('tournament_config')
    .select('value, version_id')
    .eq('key', 'eligibility.allowed_domains')
    .maybeSingle();

  if (readError) {
    return (
      <main
        data-testid="admin-config-domains-page"
        className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-4"
      >
        <h1 className="text-2xl font-semibold text-neutral-900">
          Approved corporate domains
        </h1>
        <div
          data-testid="config-error"
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load eligibility configuration: {readError.message}
        </div>
      </main>
    );
  }

  if (!row) {
    return (
      <main
        data-testid="admin-config-domains-page"
        className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-4"
      >
        <h1 className="text-2xl font-semibold text-neutral-900">
          Approved corporate domains
        </h1>
        <div
          data-testid="config-error"
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700"
        >
          No `eligibility.allowed_domains` row found in `tournament_config`.
          The slice 008 seed migration may not have run.
        </div>
      </main>
    );
  }

  // `value` is `jsonb`; the seed shape is a string[] of hostnames per
  // `eligibility.allowed_domains` in config-validators.ts. Be defensive.
  const initialDomains: string[] = Array.isArray(row.value)
    ? (row.value as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  // `version_id` is a Postgres bigint; postgrest may serialise as number or
  // string. We pass the raw value through and let the upsert API normalise.
  const initialVersionId: string =
    typeof row.version_id === 'string'
      ? row.version_id
      : String(row.version_id);

  return (
    <main
      data-testid="admin-config-domains-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Approved corporate domains
        </h1>
        <p className="text-xs font-mono text-neutral-500">
          eligibility.allowed_domains
        </p>
        <p className="text-sm text-neutral-600">
          Manage the list of email domains allowed to sign in. Changes
          propagate within 60 seconds.
        </p>
      </header>

      <DomainsEditor
        initialDomains={initialDomains}
        initialVersionId={initialVersionId}
      />
    </main>
  );
}
