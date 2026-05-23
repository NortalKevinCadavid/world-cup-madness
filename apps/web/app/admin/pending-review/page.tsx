import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { PendingReviewActions } from './components/PendingReviewActions';

/**
 * `/admin/pending-review` — Slice 002 quarantine resolution queue (Slice 006,
 * Phase 7, T039).
 *
 * Server component. The admin gate runs in `app/admin/layout.tsx` (T015);
 * RLS provides defence-in-depth.
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
 *     `/admin/pending-review`.
 *
 * Server-side data fetches:
 *   - `match_pending_review WHERE reviewed_at IS NULL ORDER BY observed_at
 *     DESC` with JOIN to `matches` for context. If the table is unavailable
 *     (e.g. seed not applied) we surface an empty list — the admin UI is
 *     still reachable.
 *
 * Per-row actions are owned by `PendingReviewActions` (client component) and
 * POST to `/api/admin/pending-review/[id]`.
 *
 * DOM contract:
 *   - `[data-testid="admin-pending-review-page"]`
 *   - `[data-testid="admin-pending-review-row"]` (per row)
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
        /* read-only */
      },
    },
  });
}

interface PendingReviewRow {
  id: string;
  match_id: string;
  observed_at: string | null;
  provider_observation: unknown;
  current_value: unknown;
  reason: string | null;
  reviewed_at: string | null;
  resolution: string | null;
}

export default async function AdminPendingReviewPage() {
  const supabase = createSessionBoundClient();

  const reviewsRes = await supabase
    .from('match_pending_review')
    .select(
      'id,match_id,observed_at,provider_observation,current_value,reason,reviewed_at,resolution',
    )
    .is('reviewed_at', null)
    .order('observed_at', { ascending: false });

  const rows = (reviewsRes.data as PendingReviewRow[] | null) ?? [];

  return (
    <main
      data-testid="admin-pending-review-page"
      className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Pending review queue
        </h1>
        <p className="text-xs font-mono text-muted-foreground">
          /admin/pending-review
        </p>
        <p className="text-sm text-muted-foreground">
          Slice 002 match observations that conflict with a prior value and are
          awaiting admin resolution. Resolutions are captured in the audit log.
        </p>
      </header>

      {rows.length === 0 ? (
        <section className="rounded-lg border border-border bg-card p-6">
          <p
            data-testid="admin-pending-review-empty"
            className="text-sm text-muted-foreground"
          >
            No pending review rows.
          </p>
        </section>
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid="admin-pending-review-row"
              className="rounded-lg border border-border bg-card p-6"
            >
              <div className="flex flex-col gap-1 text-sm">
                <p className="text-foreground font-medium">
                  Review {row.id.slice(0, 8)}… for match {row.match_id.slice(0, 8)}…
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  observed_at = {row.observed_at ?? '—'}
                </p>
                <p className="text-xs text-muted-foreground">
                  reason: {row.reason ?? '—'}
                </p>
                <details className="mt-1 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    Provider observation vs current value
                  </summary>
                  <pre className="mt-2 overflow-auto rounded bg-muted/30 p-2 text-[11px]">
                    {JSON.stringify(
                      {
                        provider_observation: row.provider_observation,
                        current_value: row.current_value,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <a
                  href={`/admin/matches/${row.match_id}`}
                  className="mt-1 text-xs text-primary underline"
                >
                  Open match detail
                </a>
              </div>
              <PendingReviewActions reviewId={row.id} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
