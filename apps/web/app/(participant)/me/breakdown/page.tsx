import 'server-only';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { EligibilityError } from '../../../../lib/auth/requireEligible';
import { getCurrentParticipant } from '../../../../lib/auth/getCurrentParticipant';
import {
  getPersonalBreakdown,
  type BreakdownRow,
} from '../../../../lib/scoring/breakdown';

/**
 * Participant personal-breakdown page — Slice 005 (T036), US4.
 *
 * Server component. Pattern mirrors T031's `/leaderboard` page:
 *   1. Build a cookie-bound (anon-key) Supabase client. RLS on
 *      `personal_breakdown_v` (security_invoker=true) flows through the
 *      user's JWT so a participant only ever sees their own rows. The view
 *      also self-filters on `participants.auth_user_id = auth.uid()` as
 *      defense-in-depth. NEVER service-role.
 *   2. Call `getCurrentParticipant()` (Slice 001) for eligibility. On any
 *      `EligibilityError` redirect to `/auth/denied`. The participant-area
 *      layout already runs the same gate so this is defence in depth.
 *   3. Call `getPersonalBreakdown(client)` (T036 lib) which reads
 *      `personal_breakdown_v` and returns
 *      `{ breakdown, calculation_version, total_points }`. The view owns:
 *        - Decomposition into one row per (caller × finished match) + one
 *          row per scored final-prediction item (§7.2, §7.3).
 *        - `official_display = NULL` for `final_pending` rows so we render
 *          a "scoring pending" indicator rather than implying 0.
 *        - calculation_version filtering (R-003 reader pointer).
 *      Constitution Principle III: NO scoring or rank math in TypeScript —
 *      we render view values directly.
 *   4. Sort the rows into a "Matches" section and a "Final tournament picks"
 *      section. The contract orders by `target_kind ASC` (match first) then
 *      `target_label ASC`; we re-partition client-side for the two-table
 *      layout. Each row carries the `data-testid="breakdown-row"` +
 *      `data-target-kind` + `data-participant-id` contract that Playwright
 *      (T034) asserts against, and each cell carries a
 *      `data-field="<column>"` attribute matching the contract columns
 *      (`target_label`, `predicted_display`, `official_display`, `points`,
 *      `reason_code`).
 *   5. The `final_pending` row renders with a `[data-testid=
 *      "final-pending-indicator"]` element carrying the
 *      "Scoring pending — FIFA announcement awaited" tooltip text so the
 *      empty `official_display` cell does not mislead the participant.
 *   6. Render a footer total (`[data-testid="breakdown-footer-sum"]`) that
 *      MUST equal the per-row points sum AND the participant's leaderboard
 *      `total_points` cell (SC-002 cross-check, asserted by T034 Test 3).
 *
 * @see specs/005-scoring-leaderboard/spec.md § US4
 * @see specs/005-scoring-leaderboard/contracts/personal-breakdown.read.md
 * @see apps/web/tests/playwright/slice-005-breakdown.spec.ts (T034)
 */

// Force dynamic — cookies + per-user data make this non-cacheable, and
// without this Next's static-render pass would call `cookies()` outside a
// request context and crash.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Mirror of T031's session-bound client builder. The breakdown read flows
 * through this anon-key + cookie-bound `SupabaseClient` so RLS on
 * `personal_breakdown_v` is enforced by the user's JWT. We tolerate missing
 * env so the Next.js build phase (which calls server components with no
 * request context) doesn't throw before the layout's eligibility gate has a
 * chance to redirect.
 */
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

/**
 * Human-readable label for the breakdown's `reason_code` enum. Pure UI
 * presentation — the canonical enum lives in `score_records.reason_code`
 * (slot 0049) and is surfaced verbatim via `personal_breakdown_v`. The
 * switch is exhaustive so adding a new enum value forces a `tsc` failure.
 */
function formatReason(code: BreakdownRow['reason_code']): string {
  switch (code) {
    case 'exact':
      return 'Exact';
    case 'outcome':
      return 'Correct outcome';
    case 'incorrect':
      return 'Incorrect';
    case 'none':
      return 'No prediction';
    case 'final_correct':
      return 'Correct';
    case 'final_incorrect':
      return 'Incorrect';
    case 'final_pending':
      return 'Pending';
  }
}

export default async function BreakdownPage() {
  // ----- 1. Eligibility gate ------------------------------------------------
  try {
    await getCurrentParticipant();
  } catch (err) {
    if (err instanceof EligibilityError) {
      redirect('/auth/denied');
    }
    throw err;
  }

  // ----- 2. Session-bound Supabase client + breakdown read ------------------
  const supabase = createSessionBoundClient();
  const { breakdown, calculation_version, total_points } =
    await getPersonalBreakdown(supabase);

  // The view's default ORDER BY is (target_kind ASC, target_label ASC) which
  // already places match rows before final rows; we re-partition for the
  // two-table layout. Filtering preserves order within each partition.
  const matchRows = breakdown.filter((row) => row.target_kind === 'match');
  const finalRows = breakdown.filter((row) => row.target_kind === 'final');

  return (
    <main
      data-testid="breakdown-page"
      className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          My Breakdown
        </h1>
        <p className="text-sm text-muted-foreground">
          One row per finished match and per scored final-tournament pick.
          The sum below matches your leaderboard total.
        </p>
        <p
          data-testid="breakdown-calc-version"
          className="text-xs text-muted-foreground"
        >
          Calculation v{calculation_version}
        </p>
      </header>

      {breakdown.length === 0 ? (
        <div
          data-testid="breakdown-empty"
          role="status"
          className="rounded border border-border bg-muted/30 p-4 text-sm text-muted-foreground"
        >
          No rows yet — your breakdown will appear once matches finish.
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold text-foreground">Matches</h2>
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2">
                      Match
                    </th>
                    <th scope="col" className="px-4 py-2">
                      Your pick
                    </th>
                    <th scope="col" className="px-4 py-2">
                      Official
                    </th>
                    <th scope="col" className="px-4 py-2 text-right">
                      Points
                    </th>
                    <th scope="col" className="px-4 py-2">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {matchRows.map((row) => (
                    <tr
                      key={`${row.target_kind}-${row.target_id}`}
                      data-testid="breakdown-row"
                      data-target-kind={row.target_kind}
                      data-participant-id={row.participant_id}
                      className="hover:bg-muted/30"
                    >
                      <td
                        data-field="target_label"
                        className="px-4 py-2 text-foreground"
                      >
                        {row.target_label}
                      </td>
                      <td
                        data-field="predicted_display"
                        className="px-4 py-2 tabular-nums text-muted-foreground"
                      >
                        {row.predicted_display === ''
                          ? '—'
                          : row.predicted_display}
                      </td>
                      <td
                        data-field="official_display"
                        className="px-4 py-2 tabular-nums text-muted-foreground"
                      >
                        {row.official_display ?? '—'}
                      </td>
                      <td
                        data-field="points"
                        className="px-4 py-2 text-right tabular-nums font-medium text-foreground"
                      >
                        {row.points}
                      </td>
                      <td
                        data-field="reason_code"
                        className="px-4 py-2 text-muted-foreground"
                        title={formatReason(row.reason_code)}
                      >
                        {row.reason_code}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold text-foreground">
              Final tournament picks
            </h2>
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2">
                      Award
                    </th>
                    <th scope="col" className="px-4 py-2">
                      Your pick
                    </th>
                    <th scope="col" className="px-4 py-2">
                      Official
                    </th>
                    <th scope="col" className="px-4 py-2 text-right">
                      Points
                    </th>
                    <th scope="col" className="px-4 py-2">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {finalRows.map((row) => (
                    <tr
                      key={`${row.target_kind}-${row.target_id}`}
                      data-testid="breakdown-row"
                      data-target-kind={row.target_kind}
                      data-participant-id={row.participant_id}
                      className="hover:bg-muted/30"
                    >
                      <td
                        data-field="target_label"
                        className="px-4 py-2 text-foreground"
                      >
                        {row.target_label}
                      </td>
                      <td
                        data-field="predicted_display"
                        className="px-4 py-2 text-muted-foreground"
                      >
                        {row.predicted_display === ''
                          ? '—'
                          : row.predicted_display}
                      </td>
                      <td
                        data-field="official_display"
                        className="px-4 py-2 text-muted-foreground"
                      >
                        {row.official_display === null ? (
                          <span
                            data-testid="final-pending-indicator"
                            title="Scoring pending — FIFA announcement awaited"
                            className="text-muted-foreground"
                          >
                            —
                          </span>
                        ) : (
                          row.official_display
                        )}
                      </td>
                      <td
                        data-field="points"
                        className="px-4 py-2 text-right tabular-nums font-medium text-foreground"
                      >
                        {row.points}
                      </td>
                      <td
                        data-field="reason_code"
                        className="px-4 py-2 text-muted-foreground"
                        title={formatReason(row.reason_code)}
                      >
                        {row.reason_code}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <footer className="flex items-center justify-between border-t border-border pt-4">
            <p
              data-testid="breakdown-footer-sum"
              className="text-sm font-semibold text-foreground"
            >
              {total_points}
            </p>
            <a
              href="/leaderboard"
              className="text-sm text-primary hover:underline"
            >
              See leaderboard →
            </a>
          </footer>
        </>
      )}
    </main>
  );
}
