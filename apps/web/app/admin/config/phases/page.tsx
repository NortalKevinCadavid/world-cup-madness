import 'server-only';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { PhasesEditor } from './PhasesEditor';

/**
 * `/admin/config/phases` — Tournament-phase editor (Slice 008, Phase 6, T041,
 * US4).
 *
 * Server component. Mirrors the T030 (`/locking`), T033 (`/scoring`), T039
 * (`/providers`) and T040 (`/admin-roles`) admin-page pattern:
 *   1. Build a session-bound (anon-key + caller cookies) Supabase client.
 *   2. Pull the current user; redirect unauthenticated callers to `/`.
 *   3. Re-check `is_admin(p_user_id)` via RPC (defence in depth — the
 *      `app/admin/layout.tsx` gate already runs, but pages must not assume
 *      it has). On denial, write a best-effort `admin.access_denied` audit
 *      row (slot 0073 narrow INSERT policy: action='admin.access_denied',
 *      source='api_guard', actor=caller's participants.id) tagged
 *      `entity_type='admin_config_phases_page'`, then `notFound()` so the
 *      surface leaks no detail about admin membership.
 *   4. Load the current `tournament.phase.current` row from `tournament_config`
 *      (value + version_id). RLS policy `tournament_config_read_all`
 *      (slot 0077) allows authenticated reads.
 *   5. Render the client-side `<PhasesEditor>` with the initial state. All
 *      interactivity (radio + reason + source-citation + preview + confirm)
 *      lives in the client component, which POSTs to
 *      `/api/admin/config/preview` and `/api/admin/config/upsert` (T027
 *      routes — REUSED here, no new route handlers).
 *
 * Validation contract:
 *   - Client: T018 `validateConfigValue('tournament.phase.current', value)`
 *     → `z.enum(['pre_tournament','group_stage','knockout','completed'])`.
 *   - Server: `admin_config_upsert` body backstop (slot 0077 lines 538–543)
 *     enforces the same enum and raises WCG02 on violation.
 *
 * Backward-transition warning:
 *   Phases have an implicit rank order pre_tournament < group_stage <
 *   knockout < completed. The spec edge case (specs/008-configuration/
 *   contracts/admin-config-rpcs.write.md) allows reverting to an earlier
 *   phase (e.g. `completed` → `knockout`) but the UI flags it with a
 *   distinct confirmation prompt so it isn't done accidentally. The action
 *   is still logged through the standard audit path.
 *
 * DOM contract (T045 will assert):
 *   - `[data-testid="admin-config-phases-page"]`
 *   - `[data-testid="phase-radio"][value="<phase>"]` × 4
 *   - `[data-testid="phase-reason"]`
 *   - `[data-testid="phase-source-citation"]`
 *   - `[data-testid="phase-save"]`
 *   - `[data-testid="phase-backward-warning"]` (only when reverting)
 *   - `[data-testid="phase-backward-confirm"]`
 *   - `[data-testid="phase-backward-cancel"]`
 *   - `[data-testid="config-preview-warning"]` (from <PreviewWarning>)
 *   - `[data-testid="phase-toast"]` (success)
 *   - `[data-testid="phase-error"]` (server error)
 *
 * @see specs/008-configuration/tasks.md § T041
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md
 * @see supabase/migrations/0077_configuration.sql (lines 538–543: enum backstop)
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/app/admin/config/locking/page.tsx (T030 sibling pattern)
 * @see apps/web/app/admin/config/scoring/page.tsx (T033 sibling pattern)
 * @see apps/web/app/admin/config/providers/page.tsx (T039 sibling)
 * @see apps/web/app/admin/config/admin-roles/page.tsx (T040 sibling)
 * @see apps/web/lib/config-validators.ts (T018)
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Phase enum + canonical default. Mirrors slot 0077 lines 538–543 and the
// T018 zod schema in `apps/web/lib/config-validators.ts`.
// ---------------------------------------------------------------------------

const PHASE_VALUES = [
  'pre_tournament',
  'group_stage',
  'knockout',
  'completed',
] as const;

type PhaseValue = (typeof PHASE_VALUES)[number];

const PHASE_DEFAULT: PhaseValue = 'pre_tournament';

function isPhaseValue(v: unknown): v is PhaseValue {
  return (
    typeof v === 'string' &&
    (PHASE_VALUES as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Mirrors the
// helper in T030/T033 sibling pages.
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
 * policy). Tagged with `entity_type='admin_config_phases_page'` per T041.
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
      entity_type: 'admin_config_phases_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/config/phases',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[admin-config-phases-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[admin-config-phases-page] admin.access_denied insert threw: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Value coercion helpers (defensive — jsonb shapes can drift on dev DBs).
// Mirrors the `coerceVersionId` pattern from scoring/page.tsx (T033).
// ---------------------------------------------------------------------------

function coerceVersionId(raw: unknown): string {
  // `version_id` is bigint; postgrest may serialise as number or string. We
  // pass it through as a decimal string to survive JSON round-trip without
  // precision loss (matches T027/T030/T033 pattern).
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  return '0';
}

function coercePhase(raw: unknown): PhaseValue {
  // jsonb stores the value as a quoted JSON string ("group_stage"); postgrest
  // unwraps that into a JS string. Defensive: also accept a plain wrapper
  // shape and fall through to the default on parse failure.
  if (isPhaseValue(raw)) return raw;
  return PHASE_DEFAULT;
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function ConfigPhasesPage() {
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
    .eq('key', 'tournament.phase.current')
    .maybeSingle();

  if (readError) {
    return (
      <main
        data-testid="admin-config-phases-page"
        className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-4"
      >
        <h1 className="text-2xl font-semibold text-foreground">
          Tournament phase
        </h1>
        <div
          data-testid="phase-error"
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          Failed to load phase configuration: {readError.message}
        </div>
      </main>
    );
  }

  if (!row) {
    return (
      <main
        data-testid="admin-config-phases-page"
        className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-4"
      >
        <h1 className="text-2xl font-semibold text-foreground">
          Tournament phase
        </h1>
        <div
          data-testid="phase-error"
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          No `tournament.phase.current` row found in `tournament_config`. The
          slice 008 seed migration may not have run.
        </div>
      </main>
    );
  }

  const initialValue: PhaseValue = coercePhase(row.value);
  const initialVersionId: string = coerceVersionId(row.version_id);

  return (
    <main
      data-testid="admin-config-phases-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Tournament phase
        </h1>
        <p className="text-xs font-mono text-muted-foreground">
          tournament.phase.current
        </p>
        <p className="text-sm text-muted-foreground">
          Drives phase-conditioned UI (group standings, bracket, final pick
          deadline copy). Allowed transitions are typically forward; a backward
          revert is permitted but flagged and audit-logged.
        </p>
      </header>

      <PhasesEditor
        initialValue={initialValue}
        initialVersionId={initialVersionId}
      />
    </main>
  );
}
