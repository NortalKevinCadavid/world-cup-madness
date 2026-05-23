import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { getAuditByTarget } from '../../../../../../lib/admin/audit';

/**
 * `/admin/audit/by-target/[entity_type]/[entity_id]` — full audit history for
 * a specific target (Slice 006, Phase 7, T039).
 *
 * Server component. The admin gate runs in `app/admin/layout.tsx`.
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-audit.read.md
 *     § `GET /api/admin/audit/by-target/[entity_type]/[entity_id]`.
 *
 * DOM contract:
 *   - `[data-testid="admin-audit-by-target-page"]`
 *   - `[data-testid="admin-audit-by-target-row"]` (per row)
 *
 * The list is ordered by `occurred_at` newest-first (per `getAuditByTarget`
 * helper). The contract example renders ascending; both orderings are
 * acceptable since rows are tagged with their `occurred_at`.
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

export default async function AdminAuditByTargetPage({
  params,
}: {
  params: { entity_type: string; entity_id: string };
}) {
  const supabase = createSessionBoundClient();
  const { entity_type, entity_id } = params;

  const rows = await getAuditByTarget(supabase, entity_type, entity_id).catch(
    () => [],
  );

  return (
    <main
      data-testid="admin-audit-by-target-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Audit history by target
        </h1>
        <p className="text-xs font-mono text-muted-foreground">
          /admin/audit/by-target/{entity_type}/{entity_id}
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card p-6">
        <dl className="grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">entity_type</dt>
          <dd className="font-mono text-xs text-foreground">{entity_type}</dd>
          <dt className="text-muted-foreground">entity_id</dt>
          <dd className="font-mono text-xs text-foreground">{entity_id}</dd>
          <dt className="text-muted-foreground">rows</dt>
          <dd className="text-foreground tabular-nums">{rows.length}</dd>
        </dl>
      </section>

      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">History</h2>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No audit rows targeting this entity.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                data-testid="admin-audit-by-target-row"
                className="text-sm text-foreground"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {row.occurred_at}
                </span>
                <span className="ml-2 font-mono text-xs">{row.action}</span>
                {row.reason ? (
                  <span className="ml-2 text-muted-foreground">— {row.reason}</span>
                ) : null}
                <a
                  href={`/admin/audit/${row.id}`}
                  className="ml-2 text-xs text-primary underline"
                >
                  view detail
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
