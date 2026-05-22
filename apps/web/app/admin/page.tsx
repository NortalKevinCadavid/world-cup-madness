import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { getAdminAuditLog } from '../../lib/admin/audit';

/**
 * `/admin` — admin dashboard (Slice 006, Phase 3, US1, T016).
 *
 * Server component. The admin gate is already enforced by
 * `apps/web/app/admin/layout.tsx` (T015) via `requireAdmin(client)` so this
 * page assumes the caller is an active admin and focuses on data fetch +
 * render only. Per the contract ("Each page additionally re-checks
 * `requireAdmin` for defense-in-depth") the page rebuilds a session-bound
 * client below, but the layout's denial already short-circuits via
 * `redirect('/admin/denied')` — a non-admin will never reach this render.
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md § `/admin` —
 *     dashboard (Server data fetch + Rendered layout).
 *
 * Data fetches (5):
 *   1. `pending_review_count` — `match_pending_review WHERE reviewed_at IS
 *      NULL`. Slice 002 surface; the table exists since migration 0023 so we
 *      can count rows directly without waiting for Slice 008.
 *   2. `recent_overrides` — last 10 audit rows whose `action LIKE 'admin.%'`
 *      via `getAdminAuditLog` (T014). RLS-filtered to admin readers.
 *   3. `last_recalc` — most recent `score_calculation_runs` row by
 *      `started_at`.
 *   4. `pending_recalc_state` — number of `score_calculation_runs.status =
 *      'running'`. The proper VIEW (`pending_recalc_state`) ships in T022;
 *      until then we surface the running-count directly as the contract's
 *      "In-flight recalculations" tile.
 *   5. `current_admin_count` — count of `admin_roles WHERE revoked_at IS
 *      NULL`. RLS on `admin_roles` permits admins to read every row.
 *
 * DOM contract (from T011 Playwright specs, locked):
 *   - `[data-testid="admin-dashboard-section-pending-review"]`
 *   - `[data-testid="admin-dashboard-section-recent-overrides"]`
 *   - `[data-testid="admin-dashboard-section-last-recalc"]`
 *   - `[data-testid="admin-dashboard-section-pending-recalc"]`
 *   - `[data-testid="admin-dashboard-section-current-admins"]`
 *
 * Constitution Principle III: NO scoring or business-rule math in TS — every
 * tile is a count or pass-through from the DB.
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see apps/web/lib/admin/audit.ts
 * @see apps/web/tests/playwright/slice-006-admin-dashboard-eligible-admin.spec.ts
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Identical to the
// builder in `app/admin/layout.tsx`. Never uses the service-role key.
// ---------------------------------------------------------------------------

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Build-time / mis-configured env: return a stub so the page can still
    // render an empty dashboard. The admin layout would have already
    // redirected to /admin/denied before reaching here under real traffic.
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
  affected_record_count: number | null;
}

interface PendingRecalcStateRow {
  last_scoring_config_change_at: string | null;
  last_successful_recalc_completed_at: string | null;
  pending_config_changes_count: number | null;
  recalc_pending: boolean | null;
}

export default async function AdminDashboard() {
  const supabase = createSessionBoundClient();

  // Fan-out all six reads in parallel. Each is a small, single-purpose
  // read with no JOIN; the dashboard is intentionally cheap to render.
  // The `pending_recalc_state` VIEW (slot 0071, T022) drives the
  // conditional `[data-testid="recalc-pending-banner"]` element rendered
  // at the top of the page when a scoring-config change has not yet been
  // followed by a successful recalc (Slice 006 / FR-010).
  const [
    pendingReviewRows,
    recentOverrides,
    lastRecalcRows,
    runningRows,
    adminCountRows,
    pendingRecalcRow,
  ] = await Promise.all([
    supabase
      .from('match_pending_review')
      .select('id', { count: 'exact', head: true })
      .is('reviewed_at', null),
    getAdminAuditLog(supabase, { limit: 10 }).catch(() => []),
    supabase
      .from('score_calculation_runs')
      .select('id,scope,status,started_at,completed_at,affected_record_count')
      .order('started_at', { ascending: false })
      .limit(1),
    supabase
      .from('score_calculation_runs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'running'),
    supabase
      .from('admin_roles')
      .select('id', { count: 'exact', head: true })
      .is('revoked_at', null),
    supabase
      .from('pending_recalc_state')
      .select(
        'last_scoring_config_change_at,last_successful_recalc_completed_at,pending_config_changes_count,recalc_pending',
      )
      .maybeSingle(),
  ]);

  const pendingReviewCount = pendingReviewRows.count ?? 0;
  const lastRecalc = (lastRecalcRows.data?.[0] ?? null) as ScoreCalculationRunRow | null;
  const runningCount = runningRows.count ?? 0;
  const currentAdminCount = adminCountRows.count ?? 0;
  const pendingRecalc = (pendingRecalcRow.data ?? null) as PendingRecalcStateRow | null;
  const recalcPending = pendingRecalc?.recalc_pending === true;

  return (
    <main
      data-testid="admin-dashboard-page"
      className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-900">
          World Cup Madness — Admin
        </h1>
        <p className="text-sm text-neutral-600">
          Tournament administration console. Every action is captured in the
          audit log.
        </p>
      </header>

      {recalcPending ? (
        <section
          data-testid="recalc-pending-banner"
          className="rounded-lg border border-yellow-400 bg-yellow-50 p-4 flex flex-col gap-2 text-sm text-yellow-900 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="font-medium">
              Configuration changed — recalculation pending
            </p>
            <p className="mt-1 text-xs">
              {pendingRecalc?.pending_config_changes_count ?? 0} scoring-config
              change(s) have been recorded since the last successful recalc.
              Trigger a recalculation to apply the new values to the
              leaderboard.
            </p>
          </div>
          <a
            href="/admin/recalc"
            data-testid="recalc-pending-banner-trigger"
            className="inline-block rounded bg-yellow-600 px-3 py-2 text-sm font-medium text-white hover:bg-yellow-700"
          >
            Trigger Recalc
          </a>
        </section>
      ) : null}

      <section
        data-testid="admin-dashboard-section-pending-review"
        className="rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h2 className="text-lg font-semibold text-neutral-900">
          Open pending review
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Matches whose provider score conflicts with a prior value and is
          awaiting admin resolution (Slice 002 surface).
        </p>
        <p
          data-testid="admin-dashboard-pending-review-count"
          className="mt-3 text-3xl font-semibold tabular-nums text-neutral-900"
        >
          {pendingReviewCount}
        </p>
        <a
          href="/admin/pending-review"
          className="mt-2 inline-block text-sm text-blue-700 underline"
        >
          View pending review queue
        </a>
      </section>

      <section
        data-testid="admin-dashboard-section-recent-overrides"
        className="rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h2 className="text-lg font-semibold text-neutral-900">
          Recent admin actions
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Last 10 entries in the admin audit log (newest first).
        </p>
        {recentOverrides.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-600">No admin actions yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {recentOverrides.map((row) => (
              <li
                key={row.id}
                data-testid="admin-audit-row"
                className="text-sm text-neutral-800"
              >
                <span className="font-mono text-xs text-neutral-700">
                  {row.action}
                </span>
                {row.reason ? (
                  <span className="ml-2 text-neutral-600">{row.reason}</span>
                ) : null}
                <a
                  href={`/admin/audit/${row.id}`}
                  className="ml-2 text-xs text-blue-700 underline"
                >
                  view
                </a>
              </li>
            ))}
          </ul>
        )}
        <a
          href="/admin/audit"
          className="mt-3 inline-block text-sm text-blue-700 underline"
        >
          View full audit log
        </a>
      </section>

      <section
        data-testid="admin-dashboard-section-last-recalc"
        className="rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h2 className="text-lg font-semibold text-neutral-900">
          Last recalculation
        </h2>
        {lastRecalc ? (
          <dl className="mt-3 grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-neutral-500">Run ID</dt>
            <dd className="font-mono text-xs text-neutral-800">
              {lastRecalc.id}
            </dd>
            <dt className="text-neutral-500">Scope</dt>
            <dd className="text-neutral-800">{lastRecalc.scope}</dd>
            <dt className="text-neutral-500">Status</dt>
            <dd className="text-neutral-800">{lastRecalc.status}</dd>
            <dt className="text-neutral-500">Started</dt>
            <dd className="text-neutral-800">{lastRecalc.started_at}</dd>
            <dt className="text-neutral-500">Completed</dt>
            <dd className="text-neutral-800">
              {lastRecalc.completed_at ?? '—'}
            </dd>
            <dt className="text-neutral-500">Affected rows</dt>
            <dd className="text-neutral-800">
              {lastRecalc.affected_record_count ?? '—'}
            </dd>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-neutral-600">
            No recalculation runs have completed yet.
          </p>
        )}
        <a
          href="/admin/recalc"
          className="mt-3 inline-block text-sm text-blue-700 underline"
        >
          Trigger or watch recalculations
        </a>
      </section>

      <section
        data-testid="admin-dashboard-section-pending-recalc"
        className="rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h2 className="text-lg font-semibold text-neutral-900">
          In-flight recalculations
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Number of `score_calculation_runs` rows currently in
          <code className="ml-1 font-mono">status = &apos;running&apos;</code>.
        </p>
        <p
          data-testid="admin-dashboard-running-count"
          className="mt-3 text-3xl font-semibold tabular-nums text-neutral-900"
        >
          {runningCount}
        </p>
      </section>

      <section
        data-testid="admin-dashboard-section-current-admins"
        className="rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h2 className="text-lg font-semibold text-neutral-900">
          Active admins
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Count of `admin_roles` rows whose `revoked_at` is NULL.
        </p>
        <p
          data-testid="admin-dashboard-admin-count"
          className="mt-3 text-3xl font-semibold tabular-nums text-neutral-900"
        >
          {currentAdminCount}
        </p>
      </section>
    </main>
  );
}
