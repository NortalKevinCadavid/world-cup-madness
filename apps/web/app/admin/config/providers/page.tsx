import 'server-only';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { ProvidersEditor, type ProvidersInitialState } from './ProvidersEditor';
import { PROVIDER_NUMERIC_SEGMENTS } from './segments';

/**
 * `/admin/config/providers` — Sync-provider editor (Slice 008, Phase 6, T039,
 * US4).
 *
 * Server component. Mirrors the T027 (`/domains`), T030 (`/locking`), and
 * T033 (`/scoring`) admin-page pattern:
 *   1. Build a session-bound (anon-key + caller cookies) Supabase client.
 *   2. Pull the current user; redirect unauthenticated callers to `/`.
 *   3. Re-check `is_admin(p_user_id)` via RPC (defence in depth — the
 *      `app/admin/layout.tsx` gate already runs, but pages must not assume
 *      it has). On denial, write a best-effort `admin.access_denied` audit
 *      row (slot 0073 narrow INSERT policy) tagged
 *      `entity_type='admin_config_providers_page'`, then `notFound()` so the
 *      surface leaks no detail about admin membership.
 *   4. Load every `providers.*` row from `tournament_config` in a single
 *      `SELECT ... WHERE key LIKE 'providers.%'`. RLS policy
 *      `tournament_config_read_all` (slot 0077) permits authenticated reads
 *      of NON-secret rows; the secret credential row's `value` column is
 *      gated by `tournament_config_secret_read` (admin-only). We're admin
 *      so the SELECT returns the row, but we deliberately DROP the raw
 *      `value` server-side for any `key_is_secret`-matching key — the only
 *      sanctioned reveal path is the `admin_config_get_secret` RPC, which
 *      writes its own forensic `admin.config_secret_accessed` audit row.
 *      Never pass a credential cleartext from the server page to the client.
 *   5. Discover registered provider ids dynamically from the rows whose key
 *      matches `providers.<id>.*` (excluding the registry index keys
 *      `providers.active` and `providers.registered.<id>`).
 *   6. Render the client-side `<ProvidersEditor>` with the active-provider
 *      value + version_id, each provider's non-secret per-key state, and a
 *      flag set marking credential keys as "secret — reveal-only" (no value
 *      passed). All interactivity (active dropdown + per-key save +
 *      credential reveal modal) lives in the client component, which POSTs
 *      to `/api/admin/config/preview`, `/api/admin/config/upsert` (T027
 *      routes — REUSED here), and the new `/api/admin/config/get-secret`
 *      route created alongside this page.
 *
 * Catalog drift note (D-T039-A):
 *   The T039 task body cited `providers.<id>.retry.backoff_seconds` and
 *   `providers.<id>.alert.failure_threshold`. The authoritative seed
 *   (`supabase/migrations/0077_configuration.sql` ~ line 354) and validator
 *   catalog (`apps/web/lib/config-validators.ts` § providers) ship
 *   `retry.backoff_seconds_base` and `alert.threshold_consecutive_failures`
 *   instead. We follow the seed/validator (single source of truth for the
 *   key namespace). DOM testids carry both the per-key hyphenated alias and
 *   the full key string via `data-config-key`, so T043 can address keys by
 *   either form.
 *
 * DOM contract (T043 will assert):
 *   - `[data-testid="admin-config-providers-page"]`
 *   - `[data-testid="active-provider-select"]`
 *   - `[data-testid="active-provider-save"]`
 *   - `[data-testid="active-provider-confirm"]` (in-page confirm dialog)
 *   - Per provider id `<id>`:
 *       - `[data-testid="provider-section"][data-provider-id="<id>"]`
 *       - `[data-testid="provider-${id}-retry-max-attempts-input"]` / `-save` / `-error` / `-toast`
 *       - `[data-testid="provider-${id}-retry-backoff-seconds-input"]` / `-save`
 *       - `[data-testid="provider-${id}-alert-failure-threshold-input"]` / `-save`
 *       - `[data-testid="provider-${id}-reveal-credential"]` button
 *       - `[data-testid="provider-${id}-credential-modal"]` modal container
 *       - `[data-testid="provider-${id}-credential-value"]` readonly input
 *       - `[data-testid="provider-${id}-credential-copy"]` copy button
 *       - `[data-testid="provider-${id}-credential-close"]` close button
 *   - Shared (from <PreviewWarning>):
 *       - `[data-testid="config-preview-warning"]`
 *
 * @see specs/008-configuration/tasks.md § T039
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin_config_get_secret
 * @see specs/008-configuration/contracts/tournament-config.schema.md § providers namespace
 * @see apps/web/app/admin/config/scoring/page.tsx (T033 sibling pattern)
 * @see apps/web/app/admin/config/locking/page.tsx (T030 sibling pattern)
 * @see apps/web/app/api/admin/config/get-secret/route.ts (this slice)
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Key-prefix constants. These mirror the seed in 0077 — the per-key segments
// below are the suffixes the editor edits for each registered provider id.
// ---------------------------------------------------------------------------

const PROVIDERS_PREFIX = 'providers.';
const ACTIVE_KEY = 'providers.active';
const REGISTERED_PREFIX = 'providers.registered.';

/** Credential segment — never pre-fetched; revealed only via the RPC. */
const CREDENTIAL_SEGMENT = 'credentials.api_key';

// ---------------------------------------------------------------------------
// Session-bound Supabase client — mirrors sibling pages.
// ---------------------------------------------------------------------------

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
        /* read-only — cookie refresh is owned by middleware. */
      },
    },
  });
}

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
      entity_type: 'admin_config_providers_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/config/providers',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[admin-config-providers-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[admin-config-providers-page] admin.access_denied insert threw: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Value coercion helpers (defensive — jsonb shapes drift on dev DBs).
// ---------------------------------------------------------------------------

function coerceInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  return fallback;
}

function coerceVersionId(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  return '0';
}

function coerceString(raw: unknown, fallback: string): string {
  if (typeof raw === 'string') return raw;
  return fallback;
}

/**
 * Extract provider id from a key like `providers.<id>.<segment...>`.
 * Returns null for `providers.active` and `providers.registered.*` (those
 * are registry index keys, not per-provider rows).
 */
function extractProviderId(key: string): string | null {
  if (!key.startsWith(PROVIDERS_PREFIX)) return null;
  if (key === ACTIVE_KEY) return null;
  if (key.startsWith(REGISTERED_PREFIX)) return null;
  const rest = key.slice(PROVIDERS_PREFIX.length);
  const firstDot = rest.indexOf('.');
  if (firstDot < 0) return null;
  return rest.slice(0, firstDot);
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function ConfigProvidersPage() {
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

  // Step 3: load every providers.* row in one round-trip.
  const { data: rows, error: readError } = await supabase
    .from('tournament_config')
    .select('key, value, version_id, value_type')
    .like('key', `${PROVIDERS_PREFIX}%`);

  if (readError) {
    return (
      <main
        data-testid="admin-config-providers-page"
        className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-4"
      >
        <h1 className="text-2xl font-semibold text-neutral-900">
          Sync providers
        </h1>
        <div
          data-testid="config-error"
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load providers configuration: {readError.message}
        </div>
      </main>
    );
  }

  // Index rows by key for O(1) lookup.
  const byKey = new Map<
    string,
    { value: unknown; version_id: unknown }
  >();
  for (const row of rows ?? []) {
    byKey.set(row.key as string, {
      value: (row as { value: unknown }).value,
      version_id: (row as { version_id: unknown }).version_id,
    });
  }

  // Discover provider ids dynamically. Prefer registered.* rows when present
  // (they're the canonical registry); fall back to scanning per-key rows so a
  // partially-seeded DB still renders something useful.
  const providerIds: Record<string, true> = {};
  Array.from(byKey.keys()).forEach((key) => {
    if (key.startsWith(REGISTERED_PREFIX)) {
      const id = key.slice(REGISTERED_PREFIX.length);
      if (id) providerIds[id] = true;
      return;
    }
    const id = extractProviderId(key);
    if (id) providerIds[id] = true;
  });

  // Sort for stable render order (deterministic test fixtures).
  const sortedProviderIds = Object.keys(providerIds).sort();

  // Active provider state.
  const activeRow = byKey.get(ACTIVE_KEY);
  const active: ProvidersInitialState['active'] = {
    value: coerceString(activeRow?.value, sortedProviderIds[0] ?? ''),
    versionId: coerceVersionId(activeRow?.version_id),
  };

  // Per-provider state. Numeric rows carry value + version_id; credential
  // rows carry only `present` + version_id (NEVER the cleartext).
  const providers: ProvidersInitialState['providers'] = sortedProviderIds.map(
    (id) => {
      const numeric: ProvidersInitialState['providers'][number]['numeric'] = {
        'retry.max_attempts': null,
        'retry.backoff_seconds_base': null,
        'alert.threshold_consecutive_failures': null,
      };
      for (const segment of PROVIDER_NUMERIC_SEGMENTS) {
        const key = `${PROVIDERS_PREFIX}${id}.${segment}`;
        const row = byKey.get(key);
        if (!row) continue;
        numeric[segment] = {
          value: coerceInt(row.value, 0),
          versionId: coerceVersionId(row.version_id),
        };
      }
      const credentialKey = `${PROVIDERS_PREFIX}${id}.${CREDENTIAL_SEGMENT}`;
      const credentialRow = byKey.get(credentialKey);
      // `present` is true even when the secret envelope's inner value is
      // null — the row exists; whether it carries a populated cleartext is
      // disclosed only via the reveal RPC.
      const credential: ProvidersInitialState['providers'][number]['credential'] = {
        key: credentialKey,
        present: Boolean(credentialRow),
      };
      return { id, numeric, credential };
    },
  );

  const empty = providers.length === 0;

  return (
    <main
      data-testid="admin-config-providers-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Sync providers
        </h1>
        <p className="text-sm text-neutral-600">
          Pick the active provider, tune the per-provider retry/backoff/alert
          knobs, and reveal credentials only when needed. Each section saves
          independently. Switching the active provider does not retroactively
          affect existing fetched results — it takes effect on the next
          scheduled sync.
        </p>
      </header>

      {empty ? (
        <div
          data-testid="config-empty"
          role="status"
          className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          No providers configured. Bootstrap a provider via SQL or import
          config to populate the <code className="font-mono text-xs">providers.*</code>{' '}
          namespace.
        </div>
      ) : (
        <ProvidersEditor
          initialState={{ active, providers, allProviderIds: sortedProviderIds }}
        />
      )}
    </main>
  );
}
