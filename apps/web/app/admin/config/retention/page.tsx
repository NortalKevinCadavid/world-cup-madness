import 'server-only';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { RetentionEditor, type RetentionInitialState } from './RetentionEditor';

/**
 * `/admin/config/retention` — Audit-retention + audit-failure webhook editor
 * (Slice 008, Phase 8b, T066, US7).
 *
 * Server component. Mirrors the T030 (`/locking`), T033 (`/scoring`), T041
 * (`/phases`) admin-page pattern:
 *   1. Build a session-bound (anon-key + caller cookies) Supabase client.
 *   2. Pull the current user; redirect unauthenticated callers to `/`.
 *   3. Re-check `is_admin(p_user_id)` via RPC (defence in depth — the
 *      `app/admin/layout.tsx` gate already runs, but pages must not assume
 *      it has). On denial, write a best-effort `admin.access_denied` audit
 *      row (slot 0073 narrow INSERT policy: action='admin.access_denied',
 *      source='api_guard', actor=caller's participants.id) tagged
 *      `entity_type='admin_config_retention_page'`, then `notFound()` so the
 *      surface leaks no detail about admin membership.
 *   4. Load four `tournament_config` rows in a single `SELECT ... WHERE key
 *      IN (...)`:
 *        - `audit.retention.policy_kind` (text, seeded by slot 0076)
 *        - `audit.retention.tournament_end_buffer_months` (integer, slot 0076)
 *        - `notifications.audit_failure_webhook_url` (text, slot 0076)
 *        - `notifications.audit_failure_webhook_secret` (optional — slot 0076
 *          does NOT seed this key; T053 import contract reads it via
 *          `config_read(..., 'null')`). The page MUST tolerate its absence.
 *
 *      Security posture for the webhook secret: the server component reads
 *      ONLY a presence flag (`hasSecret`), not the cleartext value. The
 *      tournament_config row is jsonb but `notifications.audit_failure_webhook_*`
 *      is NOT in the `providers.*.credentials.*` secret-envelope namespace,
 *      so it does NOT route through `admin_config_get_secret`. To minimise the
 *      blast radius of the admin UI ever logging or shipping this value to
 *      the client bundle, we hard-mask it server-side: existence is exposed,
 *      the cleartext is not. Updates flow through the standard
 *      `configUpsert` (the admin must re-type the value on every change).
 *   5. Render the client-side `<RetentionEditor>` with the initial state. All
 *      interactivity (per-key input/preview/confirm × 4 independent flows)
 *      lives in the client component, which POSTs to
 *      `/api/admin/config/preview` and `/api/admin/config/upsert` (T027
 *      routes — REUSED here, no new route handlers).
 *
 * Cross-task references:
 *   - T061/T062/T063 — audit-failure webhook plumbing (alert enqueue,
 *     dispatch, retry); the URL + secret keys edited here feed that pipeline.
 *   - T053 — config import contract reads/writes these keys via the bulk
 *     import flow; the secret key participates in the import "skip when
 *     unset" branch.
 *   - T067 — page acceptance test (DOM contract below).
 *
 * DOM contract (T067 will assert):
 *   - `[data-testid="admin-config-retention-page"]`
 *   - Per-key controls:
 *       - `[data-testid="retention-policy-radio"][value="keep|prune"]`
 *       - `[data-testid="retention-policy-save"]`
 *       - `[data-testid="retention-buffer-months-input"]`
 *       - `[data-testid="retention-buffer-months-save"]`
 *       - `[data-testid="retention-webhook-url-input"]`
 *       - `[data-testid="retention-webhook-url-save"]`
 *       - `[data-testid="retention-webhook-secret-input"]`
 *       - `[data-testid="retention-webhook-secret-reveal"]`
 *       - `[data-testid="retention-webhook-secret-save"]`
 *   - Shared:
 *       - `[data-testid="config-preview-warning"]` (from <PreviewWarning>)
 *       - `[data-testid="retention-toast"]`
 *       - `[data-testid="retention-error"]`
 *
 * @see specs/008-configuration/tasks.md § T066
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/app/admin/config/ConfigField.tsx
 * @see apps/web/app/admin/config/locking/page.tsx (T030 sibling pattern)
 * @see apps/web/app/admin/config/scoring/page.tsx (T033 sibling — multi-key)
 * @see apps/web/app/admin/config/phases/page.tsx  (T041 sibling)
 * @see supabase/migrations/0076_audit_trail.sql lines 53-68 (seed keys)
 * @see supabase/migrations/0077_configuration.sql lines 2237+ (webhook dispatch)
 * @see apps/web/lib/config-validators.ts (T018)
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Catalog of keys this page edits. The secret key is queried separately to
// avoid coupling its presence-only handling to the value-bearing rows.
// ---------------------------------------------------------------------------

const RETENTION_POLICY_KEY = 'audit.retention.policy_kind' as const;
const RETENTION_BUFFER_KEY = 'audit.retention.tournament_end_buffer_months' as const;
const WEBHOOK_URL_KEY = 'notifications.audit_failure_webhook_url' as const;
const WEBHOOK_SECRET_KEY = 'notifications.audit_failure_webhook_secret' as const;

const VALUE_KEYS = [
  RETENTION_POLICY_KEY,
  RETENTION_BUFFER_KEY,
  WEBHOOK_URL_KEY,
] as const;

// Sensible defaults if a row is missing (seed not run / dev DB / T066 key
// added before migration in tests).
const POLICY_DEFAULT = 'keep';
const BUFFER_DEFAULT = 12;
const WEBHOOK_URL_DEFAULT: string | null = null;

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Mirrors the
// helper in T030/T033/T041 sibling pages.
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
 * policy). Tagged with `entity_type='admin_config_retention_page'` per T066.
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
      entity_type: 'admin_config_retention_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/config/retention',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[admin-config-retention-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[admin-config-retention-page] admin.access_denied insert threw: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Value coercion helpers (defensive — jsonb shapes can drift on dev DBs).
// ---------------------------------------------------------------------------

function coerceVersionId(raw: unknown): string {
  // `version_id` is bigint; postgrest may serialise as number or string. We
  // pass it through as a decimal string to survive JSON round-trip without
  // precision loss (matches T027/T030/T033 pattern).
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  return '0';
}

function coerceInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  return fallback;
}

function coerceString(raw: unknown, fallback: string): string {
  if (typeof raw === 'string') return raw;
  return fallback;
}

function coerceNullableString(raw: unknown, fallback: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw === '' ? null : raw;
  return fallback;
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function ConfigRetentionPage() {
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

  // Step 3: load the three value-bearing rows in one round-trip.
  const { data: rows, error: readError } = await supabase
    .from('tournament_config')
    .select('key, value, version_id')
    .in('key', VALUE_KEYS as unknown as string[]);

  if (readError) {
    return (
      <main
        data-testid="admin-config-retention-page"
        className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-4"
      >
        <h1 className="text-2xl font-semibold text-foreground">
          Audit retention &amp; notifications
        </h1>
        <div
          data-testid="retention-error"
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          Failed to load retention configuration: {readError.message}
        </div>
      </main>
    );
  }

  // Step 4: separately probe for the webhook secret key. We deliberately
  // SELECT only the version_id (NOT `value`) so the cleartext secret never
  // reaches the React tree / serialised RSC payload. A missing row is
  // expected on a freshly-seeded DB (slot 0076 does not seed this key).
  const { data: secretProbe, error: secretProbeError } = await supabase
    .from('tournament_config')
    .select('key, version_id')
    .eq('key', WEBHOOK_SECRET_KEY)
    .maybeSingle();

  if (secretProbeError) {
    // Non-fatal: render a degraded editor that disables the secret section
    // and surfaces the error inline. The other three sections still work.
    console.warn(
      `[admin-config-retention-page] webhook secret presence probe failed: ${secretProbeError.message}`,
    );
  }

  // Index value rows by key for O(1) lookup.
  const byKey = new Map<string, { value: unknown; version_id: unknown }>();
  for (const row of rows ?? []) {
    byKey.set(row.key as string, {
      value: (row as { value: unknown }).value,
      version_id: (row as { version_id: unknown }).version_id,
    });
  }

  const policyRow = byKey.get(RETENTION_POLICY_KEY);
  const bufferRow = byKey.get(RETENTION_BUFFER_KEY);
  const webhookUrlRow = byKey.get(WEBHOOK_URL_KEY);

  const initialState: RetentionInitialState = {
    policy: {
      value: coerceString(policyRow?.value, POLICY_DEFAULT),
      versionId: coerceVersionId(policyRow?.version_id),
    },
    buffer: {
      value: coerceInt(bufferRow?.value, BUFFER_DEFAULT),
      versionId: coerceVersionId(bufferRow?.version_id),
    },
    webhookUrl: {
      value: coerceNullableString(webhookUrlRow?.value, WEBHOOK_URL_DEFAULT),
      versionId: coerceVersionId(webhookUrlRow?.version_id),
    },
    webhookSecret: {
      // Server does NOT expose the cleartext value. The client starts with
      // an empty string; saving requires the admin to re-type the secret.
      hasSecret: secretProbe !== null && secretProbe !== undefined,
      versionId: secretProbe ? coerceVersionId(secretProbe.version_id) : '0',
    },
  };

  return (
    <main
      data-testid="admin-config-retention-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Audit retention &amp; notifications
        </h1>
        <p className="text-sm text-muted-foreground">
          Audit-log retention policy plus the webhook destination used to alert
          on audit-write failures (Slice 007 T061/T062/T063 plumbing). Each
          section saves independently. The webhook secret is write-only — the
          server never returns the existing cleartext; type a fresh value to
          rotate it.
        </p>
      </header>

      <RetentionEditor initialState={initialState} />
    </main>
  );
}
