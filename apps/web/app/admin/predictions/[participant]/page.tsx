import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { getAuditByTarget } from '../../../../lib/admin/audit';

import { AdminSubmitPredictionForm } from './components/AdminSubmitPredictionForm';
import { AdminSubmitFinalPredictionForm } from './components/AdminSubmitFinalPredictionForm';

/**
 * `/admin/predictions/[participant]` — participant predictions view + admin
 * submit on-behalf-of (Slice 006, Phase 7, T039).
 *
 * Server component. The admin gate is enforced by `app/admin/layout.tsx`
 * (T015) and re-checked by the route handlers behind every form. RLS
 * provides defence-in-depth for the read paths.
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
 *     `/admin/predictions/[participant]` — Server data fetch + Actions.
 *
 * Server-side data fetches (4 parallel reads):
 *   1. Participant profile (id, display_name, email).
 *   2. Active match predictions for this participant.
 *   3. Active final predictions for this participant.
 *   4. Audit history for this participant as a target (entity_type =
 *      'participant', entity_id = participant_id).
 *
 * The two forms (client components) POST to:
 *   - `/api/admin/predictions`        — `admin_submit_prediction`
 *   - `/api/admin/final-predictions`  — `admin_submit_final_prediction`
 * Lock-bypass is decided server-side by the admin RPC itself.
 *
 * DOM contract:
 *   - `[data-testid="admin-predictions-page"]`
 *   - `[data-testid="admin-predictions-participant"]`
 *   - `[data-testid="admin-predictions-match-list"]`
 *   - `[data-testid="admin-predictions-final-list"]`
 *   - `[data-testid="admin-predictions-history"]`
 *
 * Constitution Principle III: NO scoring math in TS.
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

interface ParticipantRow {
  id: string;
  display_name: string | null;
  email: string | null;
}

interface PredictionRow {
  id: string;
  match_id: string;
  home_score: number | null;
  away_score: number | null;
  source: string | null;
  submitted_at: string | null;
  superseded_at: string | null;
}

interface FinalPredictionRow {
  id: string;
  item_kind: string;
  target_team_id: string | null;
  target_player_id: string | null;
  source: string | null;
  submitted_at: string | null;
  superseded_at: string | null;
}

export default async function AdminPredictionsForParticipantPage({
  params,
}: {
  params: { participant: string };
}) {
  const supabase = createSessionBoundClient();
  const participantId = params.participant;

  const [participantRes, predictionsRes, finalsRes, auditRows] =
    await Promise.all([
      supabase
        .from('participants')
        .select('id,display_name,email')
        .eq('id', participantId)
        .maybeSingle(),
      supabase
        .from('predictions')
        .select('id,match_id,home_score,away_score,source,submitted_at,superseded_at')
        .eq('participant_id', participantId)
        .order('submitted_at', { ascending: false }),
      supabase
        .from('final_predictions')
        .select(
          'id,item_kind,target_team_id,target_player_id,source,submitted_at,superseded_at',
        )
        .eq('participant_id', participantId)
        .order('submitted_at', { ascending: false }),
      getAuditByTarget(supabase, 'participant', participantId).catch(() => []),
    ]);

  const participant = (participantRes.data as ParticipantRow | null) ?? null;
  const predictions = (predictionsRes.data as PredictionRow[] | null) ?? [];
  const finals = (finalsRes.data as FinalPredictionRow[] | null) ?? [];

  return (
    <main
      data-testid="admin-predictions-page"
      className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Participant predictions
        </h1>
        <p className="text-xs font-mono text-muted-foreground">
          /admin/predictions/{participantId}
        </p>
      </header>

      <section
        data-testid="admin-predictions-participant"
        className="rounded-lg border border-border bg-card p-6"
      >
        <h2 className="text-lg font-semibold text-foreground">Profile</h2>
        {participant ? (
          <dl className="mt-3 grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Participant id</dt>
            <dd className="font-mono text-xs text-foreground">
              {participant.id}
            </dd>
            <dt className="text-muted-foreground">Display name</dt>
            <dd className="text-foreground">
              {participant.display_name ?? '—'}
            </dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="text-foreground">{participant.email ?? '—'}</dd>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No participant row found (or RLS-filtered).
          </p>
        )}
      </section>

      <section
        data-testid="admin-predictions-match-list"
        className="rounded-lg border border-border bg-card p-6"
      >
        <h2 className="text-lg font-semibold text-foreground">
          Match predictions
        </h2>
        {predictions.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No match predictions recorded.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {predictions.map((row) => (
              <li
                key={row.id}
                data-testid="admin-predictions-match-row"
                className="text-sm text-foreground"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {row.match_id}
                </span>
                <span className="ml-2 tabular-nums">
                  {row.home_score ?? '—'} - {row.away_score ?? '—'}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  source={row.source ?? '—'}
                </span>
                {row.superseded_at ? (
                  <span className="ml-2 text-xs text-muted-foreground/60">
                    superseded
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        data-testid="admin-predictions-final-list"
        className="rounded-lg border border-border bg-card p-6"
      >
        <h2 className="text-lg font-semibold text-foreground">
          Final predictions
        </h2>
        {finals.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No final predictions recorded.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {finals.map((row) => (
              <li
                key={row.id}
                data-testid="admin-predictions-final-row"
                className="text-sm text-foreground"
              >
                <span className="font-mono text-xs">{row.item_kind}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {row.target_team_id ?? row.target_player_id ?? '—'}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  source={row.source ?? '—'}
                </span>
                {row.superseded_at ? (
                  <span className="ml-2 text-xs text-muted-foreground/60">
                    superseded
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AdminSubmitPredictionForm participantId={participantId} />
      <AdminSubmitFinalPredictionForm participantId={participantId} />

      <section
        data-testid="admin-predictions-history"
        className="rounded-lg border border-border bg-card p-6"
      >
        <h2 className="text-lg font-semibold text-foreground">
          Admin actions history
        </h2>
        {auditRows.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No admin actions against this participant.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {auditRows.map((row) => (
              <li
                key={row.id}
                data-testid="admin-predictions-audit-row"
                className="text-sm text-foreground"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {row.occurred_at}
                </span>
                <span className="ml-2 font-mono text-xs">{row.action}</span>
                {row.reason ? (
                  <span className="ml-2 text-muted-foreground">— {row.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
