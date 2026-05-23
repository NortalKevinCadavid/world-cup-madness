import 'server-only';

import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { getAuditDetail } from '../../../../lib/admin/audit';

/**
 * `/admin/audit/[id]` — single audit row with derived linkage (Slice 006,
 * Phase 7, T039).
 *
 * Server component. The admin gate runs in `app/admin/layout.tsx`.
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-audit.read.md
 *     § `GET /api/admin/audit/[id]` — single row with linkage.
 *
 * Linkage (computed server-side, same logic as the API route):
 *   - `score_calculation_runs.triggering_audit_log_id = audit_log.id` →
 *     run row + affected_record_count + distinct participant count.
 *
 * DOM contract:
 *   - `[data-testid="admin-audit-detail-page"]`
 *   - `[data-testid="admin-audit-detail-row"]`
 *   - `[data-testid="admin-audit-detail-linkage"]`
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

interface ScoreCalculationRunRow {
  id: string;
  affected_record_count: number | null;
  scope: string;
  trigger: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
}

export default async function AdminAuditDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createSessionBoundClient();
  const id = params.id;

  const row = await getAuditDetail(supabase, id).catch(() => null);
  if (!row) {
    notFound();
  }

  // Derive linkage.
  let run: ScoreCalculationRunRow | null = null;
  let affectedParticipants = 0;
  const runRes = await supabase
    .from('score_calculation_runs')
    .select(
      'id,affected_record_count,scope,trigger,status,started_at,completed_at',
    )
    .eq('triggering_audit_log_id', id)
    .maybeSingle();
  if (!runRes.error && runRes.data) {
    run = runRes.data as ScoreCalculationRunRow;
    const partsRes = await supabase
      .from('score_records')
      .select('participant_id')
      .eq('score_calculation_run_id', run.id);
    if (!partsRes.error && partsRes.data) {
      const seen = new Set<string>();
      for (const r of partsRes.data as Array<{ participant_id: string }>) {
        seen.add(r.participant_id);
      }
      affectedParticipants = seen.size;
    }
  }

  return (
    <main
      data-testid="admin-audit-detail-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Audit row detail
        </h1>
        <p className="text-xs font-mono text-muted-foreground">/admin/audit/{id}</p>
      </header>

      <section
        data-testid="admin-audit-detail-row"
        className="rounded-lg border border-border bg-card p-6"
      >
        <h2 className="text-lg font-semibold text-foreground">Row</h2>
        <dl className="mt-3 grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">id</dt>
          <dd className="font-mono text-xs text-foreground">{row.id}</dd>
          <dt className="text-muted-foreground">occurred_at</dt>
          <dd className="text-foreground">{row.occurred_at}</dd>
          <dt className="text-muted-foreground">action</dt>
          <dd className="font-mono text-xs text-foreground">{row.action}</dd>
          <dt className="text-muted-foreground">actor</dt>
          <dd className="font-mono text-xs text-foreground">
            {row.actor ?? '—'}
          </dd>
          <dt className="text-muted-foreground">entity_type</dt>
          <dd className="font-mono text-xs text-foreground">
            {row.entity_type ?? '—'}
          </dd>
          <dt className="text-muted-foreground">entity_id</dt>
          <dd className="font-mono text-xs text-foreground">
            {row.entity_id ?? '—'}
          </dd>
          <dt className="text-muted-foreground">source</dt>
          <dd className="text-foreground">{row.source}</dd>
          <dt className="text-muted-foreground">source_citation</dt>
          <dd className="text-foreground">{row.source_citation ?? '—'}</dd>
          <dt className="text-muted-foreground">reason</dt>
          <dd className="text-foreground">{row.reason ?? '—'}</dd>
        </dl>
        {row.entity_type && row.entity_id ? (
          <p className="mt-3 text-xs">
            <a
              href={`/admin/audit/by-target/${row.entity_type}/${row.entity_id}`}
              className="text-primary underline"
              data-testid="admin-audit-detail-by-target-link"
            >
              View full history for this target
            </a>
          </p>
        ) : null}
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            previous_value / new_value (jsonb)
          </summary>
          <pre className="mt-2 overflow-auto rounded bg-muted/30 p-2 text-[11px]">
            {JSON.stringify(
              {
                previous_value: row.previous_value,
                new_value: row.new_value,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </section>

      <section
        data-testid="admin-audit-detail-linkage"
        className="rounded-lg border border-border bg-card p-6"
      >
        <h2 className="text-lg font-semibold text-foreground">Linkage</h2>
        {run ? (
          <dl className="mt-3 grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">triggered_recalc_run_id</dt>
            <dd
              data-testid="admin-audit-detail-triggered-run-id"
              className="font-mono text-xs text-foreground"
            >
              {run.id}
            </dd>
            <dt className="text-muted-foreground">scope</dt>
            <dd className="text-foreground">{run.scope}</dd>
            <dt className="text-muted-foreground">trigger</dt>
            <dd className="text-foreground">{run.trigger ?? '—'}</dd>
            <dt className="text-muted-foreground">status</dt>
            <dd className="text-foreground">{run.status}</dd>
            <dt className="text-muted-foreground">started_at</dt>
            <dd className="text-foreground">{run.started_at}</dd>
            <dt className="text-muted-foreground">completed_at</dt>
            <dd className="text-foreground">{run.completed_at ?? '—'}</dd>
            <dt className="text-muted-foreground">affected_score_records_count</dt>
            <dd
              data-testid="admin-audit-detail-affected-records-count"
              className="text-foreground tabular-nums"
            >
              {run.affected_record_count ?? 0}
            </dd>
            <dt className="text-muted-foreground">affected_participants_count</dt>
            <dd
              data-testid="admin-audit-detail-affected-participants-count"
              className="text-foreground tabular-nums"
            >
              {affectedParticipants}
            </dd>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No recalc run was triggered by this audit row.
          </p>
        )}
      </section>
    </main>
  );
}
