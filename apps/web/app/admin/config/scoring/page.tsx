import 'server-only';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { ScoringEditor, type ScoringInitialState } from './ScoringEditor';

/**
 * `/admin/config/scoring` — Scoring + tie-breaker editor (Slice 008,
 * Phase 5, T033, US3).
 *
 * Server component. Mirrors the T027 (`/domains`) and T030 (`/locking`)
 * admin-page pattern:
 *   1. Build a session-bound (anon-key + caller cookies) Supabase client.
 *   2. Pull the current user; redirect unauthenticated callers to `/`.
 *   3. Re-check `is_admin(p_user_id)` via RPC (defence in depth — the
 *      `app/admin/layout.tsx` gate already runs, but pages must not assume
 *      it has). On denial, write a best-effort `admin.access_denied` audit
 *      row (slot 0073 narrow INSERT policy) tagged
 *      `entity_type='admin_config_scoring_page'`, then `notFound()` so the
 *      surface leaks no detail about admin membership.
 *   4. Load all six scoring keys from `tournament_config` in a single
 *      `SELECT ... WHERE key IN (...)` (RLS policy
 *      `tournament_config_read_all` from slot 0077 permits authenticated
 *      reads).
 *   5. Compute the "re-score pending" flag by comparing the most recent
 *      `tournament_config_versions.created_at` for any `scoring.*` key
 *      written via `admin_upsert`/`admin_rollback` against the most recent
 *      `audit_log.occurred_at` for `action = 'admin.recalc_triggered'`.
 *      If the scoring write is more recent (or no recalc has ever run), the
 *      `<ScoringEditor>` renders an in-page banner mirroring what
 *      `/leaderboard` (Slice 005) shows to participants.
 *   6. Render the client-side `<ScoringEditor>` with the six initial values,
 *      their version_ids, and the rescore_pending flag. All interactivity
 *      (input/preview/confirm × 6 independent flows) lives in the client
 *      component, which POSTs to `/api/admin/config/preview` and
 *      `/api/admin/config/upsert` (T027 routes — REUSED here, no new
 *      route handlers).
 *
 * Validation contract (per T018 zod schemas):
 *   - `scoring.match_points.exact`          → int, 0..1000
 *   - `scoring.match_points.correct_outcome` → int, 0..1000
 *   - `scoring.match_points.incorrect`       → int, 0..1000
 *   - `scoring.final_pick_points`            → int, 0..1000
 *   - `scoring.score_upper_bound`            → int, 0..999
 *   - `scoring.tie_breaker_order`            → string[] of enum values
 *     (`points_total`, `exact_match_count`, `final_pick_correct`,
 *     `earliest_submission`), .min(1)
 *
 * DOM contract (T034 will assert):
 *   - `[data-testid="admin-config-scoring-page"]`
 *   - `[data-testid="scoring-editor"]`
 *   - `[data-testid="scoring-rescore-pending-banner"]` (when rescore_pending)
 *   - Per numeric key (`match-points-exact`, `match-points-correct-outcome`,
 *     `match-points-incorrect`, `final-pick-points`, `score-upper-bound`):
 *       - `[data-testid="scoring-${key}-input"]`
 *       - `[data-testid="scoring-${key}-save"]`
 *       - `[data-testid="scoring-${key}-error"]`
 *       - `[data-testid="scoring-${key}-toast"]`
 *   - Tie-breaker:
 *       - `[data-testid="tie-breaker-list"]`
 *       - `[data-testid="tie-breaker-item"]` (with `data-rank`)
 *       - `[data-testid="tie-breaker-move-up"][data-key="..."]`
 *       - `[data-testid="tie-breaker-move-down"][data-key="..."]`
 *       - `[data-testid="tie-breaker-save"]`
 *   - Shared:
 *       - `[data-testid="config-preview-warning"]` (from <PreviewWarning>)
 *       - `[data-testid="config-error"]` (fatal/load failure only)
 *
 * @see specs/008-configuration/tasks.md § T033
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/app/admin/config/locking/page.tsx (T030 sibling pattern)
 * @see apps/web/app/admin/config/domains/page.tsx (T027 sibling pattern)
 * @see apps/web/lib/config-validators.ts (T018)
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Catalog of scoring keys this page edits. Order matters: the editor renders
// sections top-to-bottom in this order. Tie-breaker is handled separately
// (its value is an array, not a scalar).
// ---------------------------------------------------------------------------

const SCORING_NUMERIC_KEYS = [
  'scoring.match_points.exact',
  'scoring.match_points.correct_outcome',
  'scoring.match_points.incorrect',
  'scoring.final_pick_points',
  'scoring.score_upper_bound',
] as const;

const TIE_BREAKER_KEY = 'scoring.tie_breaker_order' as const;

const ALL_SCORING_KEYS = [...SCORING_NUMERIC_KEYS, TIE_BREAKER_KEY] as const;

// Defaults if a row is missing for a given key (seed not run / dev DB).
const NUMERIC_DEFAULTS: Record<(typeof SCORING_NUMERIC_KEYS)[number], number> = {
  'scoring.match_points.exact': 10,
  'scoring.match_points.correct_outcome': 5,
  'scoring.match_points.incorrect': 0,
  'scoring.final_pick_points': 25,
  'scoring.score_upper_bound': 20,
};

const TIE_BREAKER_DEFAULT: readonly string[] = [
  'points_total',
  'exact_match_count',
  'final_pick_correct',
  'earliest_submission',
];

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Mirrors the
// helper in T027/T030 sibling pages.
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
 * policy). Tagged with `entity_type='admin_config_scoring_page'` per T033.
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
      entity_type: 'admin_config_scoring_page',
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: 'non-admin visited /admin/config/scoring',
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[admin-config-scoring-page] admin.access_denied insert failed: ${error.message}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[admin-config-scoring-page] admin.access_denied insert threw: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Re-score pending computation.
//
// Returns true when at least one `scoring.*` row has been written to
// `tournament_config_versions` via an `admin_upsert` or `admin_rollback`
// since the last `admin.recalc_triggered` audit event. If there has never
// been a recalc, any `admin_upsert`/`admin_rollback` on a scoring key makes
// this true.
//
// Errors are swallowed — the banner is best-effort UX, not a security
// boundary; if the query fails we simply render with `rescore_pending=false`
// and log a console warning.
// ---------------------------------------------------------------------------

async function computeRescorePending(
  supabase: ReturnType<typeof createSessionBoundClient>,
): Promise<boolean> {
  try {
    // Most recent admin-attributed scoring version (initial_seed excluded —
    // a freshly-seeded DB should not show "re-score pending").
    const { data: versionRow, error: versionError } = await supabase
      .from('tournament_config_versions')
      .select('created_at')
      .like('key', 'scoring.%')
      .in('change_kind', ['admin_upsert', 'admin_rollback'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (versionError) {
      console.warn(
        `[admin-config-scoring-page] rescore-pending version query failed: ${versionError.message}`,
      );
      return false;
    }
    if (!versionRow?.created_at) {
      // No admin scoring writes ever → nothing pending.
      return false;
    }

    // Most recent recalc trigger.
    const { data: recalcRow, error: recalcError } = await supabase
      .from('audit_log')
      .select('occurred_at')
      .eq('action', 'admin.recalc_triggered')
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recalcError) {
      console.warn(
        `[admin-config-scoring-page] rescore-pending recalc query failed: ${recalcError.message}`,
      );
      return false;
    }

    if (!recalcRow?.occurred_at) {
      // We have a scoring write but no recalc has ever run → pending.
      return true;
    }

    const scoringWrittenAt = new Date(versionRow.created_at as string).getTime();
    const lastRecalcAt = new Date(recalcRow.occurred_at as string).getTime();
    return scoringWrittenAt > lastRecalcAt;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[admin-config-scoring-page] rescore-pending threw: ${message}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Value coercion helpers (defensive — jsonb shapes can drift on dev DBs).
// ---------------------------------------------------------------------------

function coerceInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  return fallback;
}

function coerceStringArray(raw: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(raw)) {
    const filtered = (raw as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    );
    if (filtered.length > 0) return filtered;
  }
  return [...fallback];
}

function coerceVersionId(raw: unknown): string {
  // `version_id` is bigint; postgrest may serialise as number or string. We
  // pass it through as a decimal string to survive JSON round-trip without
  // precision loss (matches T027/T030 pattern).
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  return '0';
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function ConfigScoringPage() {
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

  // Step 3: load all six scoring rows in one round-trip.
  const { data: rows, error: readError } = await supabase
    .from('tournament_config')
    .select('key, value, version_id')
    .in('key', ALL_SCORING_KEYS as unknown as string[]);

  if (readError) {
    return (
      <main
        data-testid="admin-config-scoring-page"
        className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-4"
      >
        <h1 className="text-2xl font-semibold text-neutral-900">
          Scoring &amp; tie-breakers
        </h1>
        <div
          data-testid="config-error"
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load scoring configuration: {readError.message}
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

  // Build the initial state for the editor.
  const numeric: ScoringInitialState['numeric'] = Object.fromEntries(
    SCORING_NUMERIC_KEYS.map((k) => {
      const row = byKey.get(k);
      return [
        k,
        {
          value: coerceInt(row?.value, NUMERIC_DEFAULTS[k]),
          versionId: coerceVersionId(row?.version_id),
        },
      ];
    }),
  ) as ScoringInitialState['numeric'];

  const tieBreakerRow = byKey.get(TIE_BREAKER_KEY);
  const tieBreaker: ScoringInitialState['tieBreaker'] = {
    value: coerceStringArray(tieBreakerRow?.value, TIE_BREAKER_DEFAULT),
    versionId: coerceVersionId(tieBreakerRow?.version_id),
  };

  // Step 4: compute re-score pending flag.
  const rescorePending = await computeRescorePending(supabase);

  return (
    <main
      data-testid="admin-config-scoring-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Scoring &amp; tie-breakers
        </h1>
        <p className="text-sm text-neutral-600">
          Per-match point values, the final-pick reward, the score upper bound,
          and the leaderboard tie-breaker order. Each section saves
          independently. Changes do <em>not</em> retroactively recompute
          existing scores — use the recalc surface in{' '}
          <code className="font-mono text-xs">/admin/recalc</code> after
          editing.
        </p>
      </header>

      <ScoringEditor
        initialState={{ numeric, tieBreaker }}
        rescorePending={rescorePending}
      />
    </main>
  );
}
