import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { RecalcStatusLive } from './components/RecalcStatusLive';

/**
 * `/admin/recalc` — recalculation trigger + live status (Slice 006, Phase 4,
 * US2, T025).
 *
 * Server component. The admin gate is already enforced by
 * `apps/web/app/admin/layout.tsx` (T015) via `requireAdmin(client)` so this
 * page assumes the caller is an active admin and focuses on data fetch +
 * render only.
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md § `/admin/recalc`
 *
 * Data fetches (2):
 *   1. `recent_runs` — last 10 `score_calculation_runs` rows ORDER BY
 *      started_at DESC.
 *   2. `pending` — single row from the `pending_recalc_state` VIEW (T022,
 *      migration slot 0071). The view surfaces `recalc_pending`,
 *      `last_scoring_config_change_at`, `last_successful_recalc_completed_at`,
 *      and `pending_config_changes_count` (data-model § Pending Recalc State).
 *
 * The trigger form + live status are owned by the `RecalcStatusLive` client
 * component (it must run in the browser to open a Supabase Realtime channel
 * on the just-triggered run_id).
 *
 * Constitution Principle III: NO scoring math in TS — every value rendered
 * here is a pass-through from the DB.
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see apps/web/app/admin/recalc/components/RecalcStatusLive.tsx
 * @see apps/web/tests/playwright/slice-006-admin-recalc-full-happy.spec.ts
 * @see apps/web/tests/playwright/slice-006-admin-recalc-concurrent-blocked.spec.ts
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Identical to
// the helper in `app/admin/layout.tsx` and `app/admin/page.tsx`. Never uses
// the service-role key.
// ---------------------------------------------------------------------------

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Build-time / mis-configured env: return a stub so the page can still
    // render. The admin layout would have already redirected to
    // /admin/denied before reaching here under real traffic.
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
        /* read-only: middleware refreshes cookies */
      },
    },
  });
}

interface ScoreCalculationRunRow {
  id: string;
  scope: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  trigger: string | null;
  affected_record_count: number | null;
  reason: string | null;
}

interface PendingRecalcStateRow {
  last_scoring_config_change_at: string | null;
  last_successful_recalc_completed_at: string | null;
  pending_config_changes_count: number | null;
  recalc_pending: boolean | null;
}

export default async function RecalcPage() {
  const supabase = createSessionBoundClient();

  // Fan-out reads in parallel.
  const [runsResult, pendingResult] = await Promise.all([
    supabase
      .from('score_calculation_runs')
      .select(
        'id,scope,status,started_at,completed_at,trigger,affected_record_count,reason',
      )
      .order('started_at', { ascending: false })
      .limit(10),
    supabase
      .from('pending_recalc_state')
      .select(
        'last_scoring_config_change_at,last_successful_recalc_completed_at,pending_config_changes_count,recalc_pending',
      )
      .maybeSingle(),
  ]);

  const runs = (runsResult.data ?? []) as ScoreCalculationRunRow[];
  const pending = (pendingResult.data ?? null) as PendingRecalcStateRow | null;

  return (
    <main
      data-testid="recalc-page"
      className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Recalculation
        </h1>
        <p className="text-sm text-neutral-600">
          Trigger a manual rescore and watch its status via Supabase Realtime.
          Every trigger writes an audit row.
        </p>
      </header>

      {pending?.recalc_pending ? (
        <section
          data-testid="recalc-pending-info"
          className="rounded-lg border border-yellow-400 bg-yellow-50 p-4 text-sm text-yellow-900"
        >
          <p className="font-medium">Scoring configuration changed.</p>
          <p className="mt-1">
            {pending.pending_config_changes_count ?? 0} change(s) pending
            since the last successful recalc
            {pending.last_scoring_config_change_at ? (
              <>
                {' '}— most recent change at{' '}
                <span className="font-mono">
                  {pending.last_scoring_config_change_at}
                </span>
              </>
            ) : null}
            . Trigger a recalculation to apply the new configuration.
          </p>
        </section>
      ) : null}

      <RecalcStatusLive />

      <section className="rounded-lg border border-neutral-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-neutral-900">Recent runs</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Last 10 entries in `score_calculation_runs` (newest first).
        </p>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-600">
            No recalculation runs have been recorded yet.
          </p>
        ) : (
          <ul
            data-testid="recalc-recent-runs"
            className="mt-3 flex flex-col gap-2"
          >
            {runs.map((r) => (
              <li
                key={r.id}
                data-testid="recalc-recent-run"
                className="rounded border border-neutral-200 bg-neutral-50 p-3 text-sm"
              >
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="font-mono text-xs text-neutral-700">
                    {r.id}
                  </span>
                  <span className="text-neutral-700">scope={r.scope}</span>
                  <span className="text-neutral-700">status={r.status}</span>
                  <span className="text-neutral-700">
                    started={r.started_at}
                  </span>
                  {r.completed_at ? (
                    <span className="text-neutral-700">
                      completed={r.completed_at}
                    </span>
                  ) : null}
                  {r.trigger ? (
                    <span className="text-neutral-700">
                      trigger={r.trigger}
                    </span>
                  ) : null}
                  {typeof r.affected_record_count === 'number' ? (
                    <span className="text-neutral-700">
                      affected={r.affected_record_count}
                    </span>
                  ) : null}
                </div>
                {r.reason ? (
                  <p className="mt-1 text-xs text-neutral-600">{r.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
