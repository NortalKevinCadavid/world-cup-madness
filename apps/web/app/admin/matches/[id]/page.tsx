import 'server-only';

import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { getAuditByTarget } from '../../../../lib/admin/audit';

import { MatchCorrectionForm } from './components/MatchCorrectionForm';
import { MatchUpdateForm } from './components/MatchUpdateForm';

/**
 * `/admin/matches/[id]` — admin match detail + correction form
 * (Slice 006, Phase 3, US1, T016).
 *
 * Server component. The admin gate runs in `app/admin/layout.tsx` (T015).
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
 *     `/admin/matches/[id]` — match detail + actions.
 *
 * Server-side data fetches (3 parallel reads):
 *   1. `matches` row for context (status, kickoff, teams).
 *   2. `match_results` row (single PK, may be null if no result recorded yet).
 *   3. `audit_log` rows targeting this match — `entity_type = 'match'` so we
 *      surface every admin action against the same target id. (The slot 0064
 *      SP writes audit rows with `entity_type='match'` and `entity_id=match_id`,
 *      consistent with admin-rpcs.write.md § Audit emission pattern.)
 *
 * The correction form (client component) POSTs to `/api/admin/match-results`
 * (T015 route handler). The route handler validates + delegates to slot 0064
 * `admin_record_match_result`; Slice 005's recalc fires automatically via
 * the `match_results_recorded` LISTEN channel — no client-side recalc call.
 *
 * Match-results column naming reminder (slice 002): `home_score`/`away_score`
 * ARE the "official" columns. There is NO `home_score_official` /
 * `away_score_official` column. We display `home_score` / `away_score` and
 * `home_score_for_scoring` / `away_score_for_scoring`.
 *
 * Constitution Principle III: NO scoring math in TS.
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see apps/web/lib/admin/audit.ts
 * @see apps/web/tests/playwright/slice-006-admin-match-correct-score-happy.spec.ts
 * @see apps/web/tests/playwright/slice-006-admin-match-correct-score-missing-reason.spec.ts
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies.
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
        /* read-only: middleware refreshes cookies */
      },
    },
  });
}

interface MatchRow {
  id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_utc: string;
  status: string;
}

export interface MatchResultsInitial {
  match_id: string;
  home_score: number;
  away_score: number;
  home_score_for_scoring: number;
  away_score_for_scoring: number;
  result_status: string;
}

export default async function AdminMatchDetail({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createSessionBoundClient();

  const [matchRes, mrRes, auditRows] = await Promise.all([
    supabase
      .from('matches')
      .select('id,home_team_id,away_team_id,kickoff_utc,status')
      .eq('id', params.id)
      .maybeSingle(),
    supabase
      .from('match_results')
      .select(
        'match_id,home_score,away_score,home_score_for_scoring,away_score_for_scoring,result_status',
      )
      .eq('match_id', params.id)
      .maybeSingle(),
    getAuditByTarget(supabase, 'match', params.id).catch(() => []),
  ]);

  // No match (or RLS-hidden / bad id): surface as 404. The page MUST still
  // return 200 for happy-path tests where the match exists — but for an
  // unknown id we want Next.js's `not-found` boundary, not a redirect to
  // /admin (a redirect would confuse a deep-link.).
  if (matchRes.error || !matchRes.data) {
    notFound();
  }

  const match = matchRes.data as MatchRow;
  const currentResult = (mrRes.data as MatchResultsInitial | null) ?? null;

  return (
    <main
      data-testid="admin-match-detail-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Match {params.id}
        </h1>
        <p className="text-xs font-mono text-neutral-500">
          /admin/matches/{params.id}
        </p>
      </header>

      <section
        data-testid="admin-match-detail-current-state"
        className="rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h2 className="text-lg font-semibold text-neutral-900">
          Current state
        </h2>
        <dl className="mt-3 grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-neutral-500">Status</dt>
          <dd data-field="match-status" className="text-neutral-800">
            {match.status}
          </dd>
          <dt className="text-neutral-500">Kickoff</dt>
          <dd className="text-neutral-800">{match.kickoff_utc}</dd>
          <dt className="text-neutral-500">Home team</dt>
          <dd className="font-mono text-xs text-neutral-700">
            {match.home_team_id}
          </dd>
          <dt className="text-neutral-500">Away team</dt>
          <dd className="font-mono text-xs text-neutral-700">
            {match.away_team_id}
          </dd>
          {currentResult ? (
            <>
              <dt className="text-neutral-500">Home score (official)</dt>
              <dd data-field="home-score" className="text-neutral-800">
                {currentResult.home_score}
              </dd>
              <dt className="text-neutral-500">Away score (official)</dt>
              <dd data-field="away-score" className="text-neutral-800">
                {currentResult.away_score}
              </dd>
              <dt className="text-neutral-500">Home score (for scoring)</dt>
              <dd className="text-neutral-800">
                {currentResult.home_score_for_scoring}
              </dd>
              <dt className="text-neutral-500">Away score (for scoring)</dt>
              <dd className="text-neutral-800">
                {currentResult.away_score_for_scoring}
              </dd>
              <dt className="text-neutral-500">Result status</dt>
              <dd className="text-neutral-800">{currentResult.result_status}</dd>
            </>
          ) : null}
        </dl>
      </section>

      <MatchCorrectionForm matchId={params.id} initial={currentResult} />

      <MatchUpdateForm
        matchId={params.id}
        initial={{
          status: match.status,
          kickoff_utc: match.kickoff_utc,
        }}
      />

      <section
        data-testid="admin-match-detail-history"
        className="rounded-lg border border-neutral-200 bg-white p-6"
      >
        <h2 className="text-lg font-semibold text-neutral-900">
          Admin actions history
        </h2>
        {auditRows.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600">
            No prior admin actions against this match.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {auditRows.map((row) => (
              <li
                key={row.id}
                data-testid="admin-match-audit-row"
                className="text-sm text-neutral-800"
              >
                <span className="font-mono text-xs text-neutral-600">
                  {row.occurred_at}
                </span>
                <span className="ml-2 font-mono text-xs">{row.action}</span>
                {row.reason ? (
                  <span className="ml-2 text-neutral-700">— {row.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-sm">
        <a
          href={`/admin/predictions?match_id=${params.id}`}
          className="text-blue-700 underline"
        >
          View predictions for this match
        </a>
      </p>
    </main>
  );
}
