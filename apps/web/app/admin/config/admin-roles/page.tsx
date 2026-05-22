import 'server-only';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { AdminRolesEditor, type ActiveAdmin } from './AdminRolesEditor';

/**
 * `/admin/config/admin-roles` — Admin-role grant/revoke editor (Slice 008,
 * Phase 6, T040, US4).
 *
 * Server component. Mirrors the T027 (`/domains`), T030 (`/locking`), T033
 * (`/scoring`), and T039 (`/providers`) admin-page pattern:
 *   1. Build a session-bound (anon-key + caller cookies) Supabase client.
 *   2. Pull the current user; redirect unauthenticated callers to `/`.
 *   3. Re-check `is_admin(p_user_id)` via RPC (defence in depth — the
 *      `app/admin/layout.tsx` gate already runs, but pages must not assume
 *      it has). On denial, write a best-effort `admin.access_denied` audit
 *      row (slot 0073 narrow INSERT policy) tagged
 *      `entity_type='admin_config_admin_roles_page'`, then `notFound()`.
 *   4. Two parallel reads:
 *      a) Active admins: `admin_roles` LEFT JOIN `participants` filtered by
 *         `admin_roles.revoked_at IS NULL`, ordered by `granted_at ASC`.
 *         Postgrest's resource embedding handles the LEFT JOIN via the
 *         `participants(...)` selector — the FK in slot 0060 makes this
 *         unambiguous.
 *      b) The current user's `participants.id` so the client can render the
 *         self-revoke warning when the operator opens their OWN row's modal.
 *   5. Render the client-side `<AdminRolesEditor>` with the active admins
 *      list + current participant id. All interactivity (revoke modal +
 *      grant form + autocomplete) lives in the client component, which POSTs
 *      to `/api/admin/config/grant-admin-role` (T040),
 *      `/api/admin/config/revoke-admin-role` (T040), and
 *      `/api/admin/participants/search` (T040 autocomplete).
 *
 * Contract:
 *   - Grant RPC (LOCKED, T038):
 *       admin_config_grant_admin_role(p_participant_id uuid, p_reason text,
 *                                     p_source_citation text) RETURNS uuid
 *   - Revoke RPC (LOCKED, T038):
 *       admin_config_revoke_admin_role(p_participant_id uuid, p_reason text,
 *                                      p_source_citation text) RETURNS void
 *   - Both require non-empty reason AND source_citation (WCG02 on miss).
 *   - Both require admin caller (WCG07 on miss; the RPC body writes an
 *     `admin.access_denied` audit row before raising).
 *
 * DOM contract (T044 will assert):
 *   - `[data-testid="admin-config-admin-roles-page"]` on the <main>
 *   - `[data-testid="admin-roles-table"]` + per-row
 *     `[data-testid="admin-row"][data-participant-id="<uuid>"]` +
 *     `[data-testid="admin-revoke-button"]`
 *   - Revoke modal: `[data-testid="revoke-modal"]`,
 *     `[data-testid="revoke-reason"]`,
 *     `[data-testid="revoke-source-citation"]`,
 *     `[data-testid="revoke-confirm"]`, `[data-testid="revoke-cancel"]`,
 *     `[data-testid="revoke-self-warning"]` (only when own role).
 *   - Grant form: `[data-testid="grant-form"]`,
 *     `[data-testid="grant-search-input"]`,
 *     `[data-testid="grant-search-results"]`,
 *     `[data-testid="grant-search-result"][data-participant-id="<uuid>"]`,
 *     `[data-testid="grant-reason"]`,
 *     `[data-testid="grant-source-citation"]`,
 *     `[data-testid="grant-submit"]`.
 *   - Shared: `[data-testid="admin-roles-toast"]`,
 *             `[data-testid="admin-roles-error"]`.
 *
 * @see specs/008-configuration/tasks.md § T040
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin role wrappers
 * @see supabase/migrations/0060_admin_roles.sql (admin_roles table shape)
 * @see supabase/migrations/0077_configuration.sql § T038 (RPC bodies)
 * @see apps/web/app/admin/config/providers/page.tsx (T039 sibling pattern)
 * @see apps/web/app/admin/config/scoring/page.tsx (T033 sibling pattern)
 * @see apps/web/app/api/admin/config/grant-admin-role/route.ts
 * @see apps/web/app/api/admin/config/revoke-admin-role/route.ts
 * @see apps/web/app/api/admin/participants/search/route.ts
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Session-bound Supabase client — mirrors sibling pages.
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
 * policy). Tagged `entity_type='admin_config_admin_roles_page'`.
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
      entity_type: 'admin_config_admin_roles_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/config/admin-roles',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[admin-config-admin-roles-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[admin-config-admin-roles-page] admin.access_denied insert threw: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Row coercion helpers (defensive — postgrest serialises types loosely).
// ---------------------------------------------------------------------------

/**
 * Postgrest's nested-resource embedding may serialise the joined participant
 * as either an object or null (when the LEFT JOIN misses). It can also
 * arrive as an array if postgrest decides the FK is to-many (it isn't, but
 * we tolerate both shapes).
 */
function extractParticipantFields(
  raw: unknown,
): { email: string | null; display_name: string | null } {
  if (raw === null || raw === undefined) return { email: null, display_name: null };
  const node = Array.isArray(raw) ? raw[0] : raw;
  if (node === null || node === undefined || typeof node !== 'object') {
    return { email: null, display_name: null };
  }
  const obj = node as { email?: unknown; display_name?: unknown };
  return {
    email: typeof obj.email === 'string' ? obj.email : null,
    display_name: typeof obj.display_name === 'string' ? obj.display_name : null,
  };
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function ConfigAdminRolesPage() {
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

  // Step 3a: load active admins with LEFT JOIN to participants. Postgrest
  // embeds the joined row under `participants` when the FK is unambiguous.
  // Order by granted_at ASC so the longest-tenured admin appears first.
  const { data: adminRows, error: adminsError } = await supabase
    .from('admin_roles')
    .select(
      'id, participant_id, granted_at, granted_by, participants(email, display_name)',
    )
    .is('revoked_at', null)
    .order('granted_at', { ascending: true });

  if (adminsError) {
    return (
      <main
        data-testid="admin-config-admin-roles-page"
        className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-4"
      >
        <h1 className="text-2xl font-semibold text-neutral-900">
          Admin roles
        </h1>
        <div
          data-testid="admin-roles-error"
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load admin roles: {adminsError.message}
        </div>
      </main>
    );
  }

  const activeAdmins: ActiveAdmin[] = (adminRows ?? []).map((row) => {
    const r = row as {
      id: unknown;
      participant_id: unknown;
      granted_at: unknown;
      granted_by: unknown;
      participants?: unknown;
    };
    const { email, display_name } = extractParticipantFields(r.participants);
    return {
      id: String(r.id),
      participantId: String(r.participant_id),
      grantedAt:
        typeof r.granted_at === 'string'
          ? r.granted_at
          : String(r.granted_at ?? ''),
      grantedBy:
        typeof r.granted_by === 'string'
          ? r.granted_by
          : r.granted_by === null || r.granted_by === undefined
            ? null
            : String(r.granted_by),
      email,
      displayName: display_name,
    };
  });

  // Step 3b: look up the current user's participant id so the client can
  // render the self-revoke warning. Best-effort — if this fails the warning
  // simply never appears (no security implication; the DB also allows it).
  let currentParticipantId: string | null = null;
  {
    const { data: meRow, error: meError } = await supabase
      .from('participants')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (meError) {
      console.warn(
        `[admin-config-admin-roles-page] could not resolve current participant id: ${meError.message}`,
      );
    } else if (meRow?.id) {
      currentParticipantId = String(meRow.id);
    }
  }

  return (
    <main
      data-testid="admin-config-admin-roles-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-900">Admin roles</h1>
        <p className="text-sm text-neutral-600">
          Grant or revoke the <code className="font-mono text-xs">admin</code> role.
          Each grant/revoke records BOTH an{' '}
          <code className="font-mono text-xs">audit_log</code> row (via the slice-006
          trigger) and a linked{' '}
          <code className="font-mono text-xs">tournament_config_versions</code>{' '}
          row that captures the supplied reason + source citation. Bootstrapping
          the first admin must be done via SQL/seed (no UI grant path exists
          while there are zero active admins).
        </p>
      </header>

      <AdminRolesEditor
        activeAdmins={activeAdmins}
        currentParticipantId={currentParticipantId}
      />
    </main>
  );
}
