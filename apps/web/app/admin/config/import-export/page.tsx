import 'server-only';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import ImportExportPanel from './ImportExportPanel';

/**
 * `/admin/config/import-export` — signed-envelope export + import surface
 * (Slice 008, Phase 8a, T054, US5).
 *
 * Server component. Mirrors the T048 (`/history`), T041 (`/phases`) admin-page
 * pattern:
 *   1. Build a session-bound (anon-key + caller cookies) Supabase client.
 *   2. Pull the current user; redirect unauthenticated callers to `/`.
 *   3. Re-check `is_admin(p_user_id)` via RPC (defence in depth — the
 *      `app/admin/layout.tsx` gate already runs, but pages must not assume
 *      it has). On denial, write a best-effort `admin.access_denied` audit
 *      row (slot 0073 narrow INSERT policy) tagged
 *      `entity_type='admin_config_import_export_page'`, then `notFound()` so
 *      the surface leaks no detail about admin membership.
 *   4. Hand off to the client-side `<ImportExportPanel>`, which owns the
 *      export download trigger + the import multipart upload flow.
 *
 * Why a client companion (`ImportExportPanel.tsx`):
 *   T054 demands an interactive export-download trigger (must consume the
 *   route response as a Blob and synthesise an `<a download>` click) and an
 *   import multipart upload + per-key validation-error renderer. The server
 *   page does no data fetching beyond the admin gate — no initial state is
 *   needed because the export/import flows are user-initiated.
 *
 * DOM contract (T060 will assert):
 *   - `[data-testid="admin-config-import-export-page"]` on main
 *   - `[data-testid="export-button"]`
 *   - `[data-testid="import-file-input"]`
 *   - `[data-testid="import-reason"]`
 *   - `[data-testid="import-submit"]`
 *   - `[data-testid="import-toast"]` (success)
 *   - `[data-testid="import-error"]` (server error)
 *   - `[data-testid="import-validation-error"]` per row in WCG08 aggregate
 *      failures (with `data-failed-key="<key>"`)
 *
 * @see specs/008-configuration/tasks.md § T054
 * @see specs/008-configuration/contracts/config-version-history.read.md § admin_config_export
 * @see specs/008-configuration/contracts/config-import.write.md
 * @see apps/web/app/admin/config/history/page.tsx (T048 sibling page pattern)
 * @see apps/web/app/admin/config/phases/page.tsx (T041 sibling page pattern)
 * @see apps/web/app/api/admin/config/export/route.ts (T055 sibling route)
 * @see apps/web/app/api/admin/config/import/route.ts (T056 sibling route)
 * @see supabase/migrations/0077_configuration.sql (lines 1918..2254: T052+T053 bodies)
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Mirrors the
// helper in T048/T041 sibling pages.
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
 * policy). Tagged with `entity_type='admin_config_import_export_page'` per
 * T054.
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
      entity_type: 'admin_config_import_export_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/config/import-export',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[admin-config-import-export-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[admin-config-import-export-page] admin.access_denied insert threw: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function ConfigImportExportPage() {
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

  return (
    <main
      data-testid="admin-config-import-export-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Configuration import / export
        </h1>
        <p className="text-xs font-mono text-muted-foreground">
          /admin/config/import-export
        </p>
        <p className="text-sm text-muted-foreground">
          Download the current configuration as a signed JSON envelope, or
          import a previously-signed envelope to restore a configuration
          snapshot. Every import is appended to <code>audit_log</code> and
          produces one row per imported key in{' '}
          <code>tournament_config_versions</code>.
        </p>
      </header>

      <ImportExportPanel />
    </main>
  );
}
